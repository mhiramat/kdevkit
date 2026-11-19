"""Immutable Intermediate Representation (IR) and RPC data models for kconfig_server."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, IntEnum
from typing import Any, Literal


def normalize_sym_name(name: str) -> str:
    """Strip a leading 'CONFIG_' prefix if present."""
    name = name.strip()
    if name.startswith("CONFIG_"):
        return name[7:]
    return name


class SymType(Enum):
    BOOL = "bool"
    TRISTATE = "tristate"
    INT = "int"
    HEX = "hex"
    STRING = "string"
    UNKNOWN = "unknown"

    @property
    def is_bool_or_tristate(self) -> bool:
        return self in (SymType.BOOL, SymType.TRISTATE)


class TriVal(IntEnum):
    N = 0
    M = 1
    Y = 2

    @classmethod
    def from_str(cls, val: str) -> TriVal:
        v = val.strip().lower()
        if v == "y":
            return cls.Y
        if v == "m":
            return cls.M
        if v == "n":
            return cls.N
        raise ValueError(f"Invalid tristate value: {val!r} (expected 'y', 'm', or 'n')")

    def to_str(self) -> str:
        if self == TriVal.Y:
            return "y"
        if self == TriVal.M:
            return "m"
        return "n"


CmpOp = Literal["=", "!=", "<", "<=", ">", ">="]


@dataclass(frozen=True, slots=True)
class ConstExpr:
    val: TriVal


@dataclass(frozen=True, slots=True)
class SymRefExpr:
    name: str


@dataclass(frozen=True, slots=True)
class NotExpr:
    operand: ExprIR


@dataclass(frozen=True, slots=True)
class AndExpr:
    left: ExprIR
    right: ExprIR


@dataclass(frozen=True, slots=True)
class OrExpr:
    left: ExprIR
    right: ExprIR


@dataclass(frozen=True, slots=True)
class CmpExpr:
    op: CmpOp
    left: str | int
    right: str | int
    left_is_sym: bool
    right_is_sym: bool


ExprIR = ConstExpr | SymRefExpr | NotExpr | AndExpr | OrExpr | CmpExpr


CONST_N = ConstExpr(TriVal.N)
CONST_M = ConstExpr(TriVal.M)
CONST_Y = ConstExpr(TriVal.Y)


def make_and(left: ExprIR, right: ExprIR) -> ExprIR:
    """Construct a simplified AndExpr."""
    if left == CONST_N or right == CONST_N:
        return CONST_N
    if left == CONST_Y:
        return right
    if right == CONST_Y:
        return left
    if left == right:
        return left
    return AndExpr(left, right)


def make_or(left: ExprIR, right: ExprIR) -> ExprIR:
    """Construct a simplified OrExpr."""
    if left == CONST_Y or right == CONST_Y:
        return CONST_Y
    if left == CONST_N:
        return right
    if right == CONST_N:
        return left
    if left == right:
        return left
    return OrExpr(left, right)


def make_not(operand: ExprIR) -> ExprIR:
    """Construct a simplified NotExpr."""
    if isinstance(operand, ConstExpr):
        if operand.val == TriVal.Y:
            return CONST_N
        if operand.val == TriVal.N:
            return CONST_Y
        return CONST_M
    if isinstance(operand, NotExpr):
        return operand.operand
    return NotExpr(operand)


def expr_to_str(expr: ExprIR) -> str:
    """Format an ExprIR into human-readable Kconfig syntax."""
    match expr:
        case ConstExpr(val=v):
            return v.to_str()
        case SymRefExpr(name=n):
            return n
        case NotExpr(operand=op):
            if isinstance(op, (AndExpr, OrExpr, CmpExpr)):
                return f"!({expr_to_str(op)})"
            return f"!{expr_to_str(op)}"
        case AndExpr():
            parts: list[str] = []
            stack: list[ExprIR] = [expr]
            while stack:
                cur = stack.pop()
                if isinstance(cur, AndExpr):
                    stack.append(cur.right)
                    stack.append(cur.left)
                elif isinstance(cur, OrExpr):
                    parts.append(f"({expr_to_str(cur)})")
                else:
                    parts.append(expr_to_str(cur))
            return " && ".join(parts)
        case OrExpr():
            parts = []
            stack = [expr]
            while stack:
                cur = stack.pop()
                if isinstance(cur, OrExpr):
                    stack.append(cur.right)
                    stack.append(cur.left)
                else:
                    parts.append(expr_to_str(cur))
            return " || ".join(parts)
        case CmpExpr(op=op, left=l, right=r, left_is_sym=ls, right_is_sym=rs):
            l_str = str(l) if ls else f'"{l}"' if isinstance(l, str) else str(l)
            r_str = str(r) if rs else f'"{r}"' if isinstance(r, str) else str(r)
            return f"{l_str} {op} {r_str}"


def expr_referenced_symbols(expr: ExprIR) -> set[str]:
    """Return all symbol names referenced in an ExprIR using an iterative traversal."""
    result: set[str] = set()
    stack: list[ExprIR] = [expr]
    while stack:
        cur = stack.pop()
        match cur:
            case SymRefExpr(name=n):
                result.add(n)
            case NotExpr(operand=op):
                stack.append(op)
            case AndExpr(left=l, right=r) | OrExpr(left=l, right=r):
                stack.append(l)
                stack.append(r)
            case CmpExpr(left=l, right=r, left_is_sym=ls, right_is_sym=rs):
                if ls and isinstance(l, str) and l not in ("y", "m", "n"):
                    result.add(l)
                if rs and isinstance(r, str) and r not in ("y", "m", "n"):
                    result.add(r)
    return result


def eval_expr_trival(
    expr: ExprIR,
    values: dict[str, str],
    symbols: dict[str, SymbolIR] | None = None,
) -> TriVal:
    """Evaluate an ExprIR to a TriVal given a mapping of symbol values."""
    stack: list[tuple[ExprIR, bool]] = [(expr, False)]
    results: list[TriVal] = []

    def _get_sym_tri(name: str) -> TriVal:
        if name in ("y", "Y"):
            return TriVal.Y
        if name in ("m", "M"):
            return TriVal.M
        if name in ("n", "N"):
            return TriVal.N
        raw = values.get(name, "n")
        if symbols and name in symbols and not symbols[name].sym_type.is_bool_or_tristate:
            return TriVal.Y if raw not in ("", "n") else TriVal.N
        if raw in ("y", "Y"):
            return TriVal.Y
        if raw in ("m", "M"):
            return TriVal.M
        return TriVal.N

    def _get_cmp_operand(val: str | int, is_sym: bool) -> str:
        if not is_sym:
            return str(val)
        s = str(val)
        if s in ("y", "m", "n"):
            return s
        return values.get(s, "n")

    while stack:
        node, processed = stack.pop()
        match node:
            case ConstExpr(val=v):
                results.append(v)
            case SymRefExpr(name=n):
                results.append(_get_sym_tri(n))
            case NotExpr(operand=op):
                if not processed:
                    stack.append((node, True))
                    stack.append((op, False))
                else:
                    v = results.pop()
                    results.append(TriVal(2 - int(v)))
            case AndExpr(left=l, right=r):
                if not processed:
                    stack.append((node, True))
                    stack.append((r, False))
                    stack.append((l, False))
                else:
                    rv = results.pop()
                    lv = results.pop()
                    results.append(TriVal(min(int(lv), int(rv))))
            case OrExpr(left=l, right=r):
                if not processed:
                    stack.append((node, True))
                    stack.append((r, False))
                    stack.append((l, False))
                else:
                    rv = results.pop()
                    lv = results.pop()
                    results.append(TriVal(max(int(lv), int(rv))))
            case CmpExpr(op=op, left=l, right=r, left_is_sym=ls, right_is_sym=rs):
                lv_str = _get_cmp_operand(l, ls)
                rv_str = _get_cmp_operand(r, rs)
                matched = False
                if op in ("=", "!="):
                    matched = (lv_str == rv_str) if op == "=" else (lv_str != rv_str)
                else:
                    try:
                        li = int(lv_str, 0)
                        ri = int(rv_str, 0)
                        if op == "<":
                            matched = li < ri
                        elif op == "<=":
                            matched = li <= ri
                        elif op == ">":
                            matched = li > ri
                        elif op == ">=":
                            matched = li >= ri
                    except ValueError:
                        if op == "<":
                            matched = lv_str < rv_str
                        elif op == "<=":
                            matched = lv_str <= rv_str
                        elif op == ">":
                            matched = lv_str > rv_str
                        elif op == ">=":
                            matched = lv_str >= rv_str
                results.append(TriVal.Y if matched else TriVal.N)

    return results[-1] if results else TriVal.N


@dataclass(frozen=True, slots=True)
class SymbolIR:
    name: str
    sym_type: SymType
    has_prompt: bool
    prompts: tuple[tuple[str, ExprIR], ...]
    direct_dep: ExprIR
    visibility: ExprIR
    selects: tuple[tuple[str, ExprIR], ...]
    implies: tuple[tuple[str, ExprIR], ...]
    defaults: tuple[tuple[ExprIR | str, ExprIR], ...]
    choice_id: str | None
    help_text: str
    menu_path: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ChoiceIR:
    id: str
    name: str | None
    sym_type: SymType
    is_optional: bool
    visibility: ExprIR
    members: tuple[str, ...]
    prompt: str = ""
    direct_dep: ExprIR = CONST_Y
    defaults: tuple[tuple[str, ExprIR], ...] = ()


@dataclass(frozen=True, slots=True)
class MenuNodeIR:
    id: str
    parent_id: str | None
    kind: Literal["menu", "symbol", "choice", "comment"]
    name: str | None
    prompt: str
    visibility: ExprIR
    children: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class KconfigIR:
    symbols: dict[str, SymbolIR]
    choices: dict[str, ChoiceIR]
    reverse_selects: dict[str, tuple[tuple[str, ExprIR], ...]]
    menu_nodes: dict[str, MenuNodeIR] = field(default_factory=dict)
    root_node_ids: tuple[str, ...] = ()
    menu_tree: list[MenuNodeIR] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class SymbolChange:
    symbol: str
    old_value: str
    new_value: str
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "oldValue": self.old_value,
            "newValue": self.new_value,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class ConflictItem:
    kind: Literal["user_request", "pinned_layer"]
    symbol: str
    value: str
    layer_id: str | None = None
    layer_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        if self.kind == "user_request":
            return {
                "kind": "user_request",
                "symbol": self.symbol,
                "requested": self.value,
            }
        return {
            "kind": "pinned_layer",
            "symbol": self.symbol,
            "pinnedValue": self.value,
            "layerId": self.layer_id,
            "layerPath": self.layer_path,
        }


@dataclass(frozen=True, slots=True)
class SolveResult:
    status: Literal["ok", "conflict"]
    solve_time_ms: float
    changes: tuple[SymbolChange, ...] = ()
    conflicts: tuple[ConflictItem, ...] = ()
    diagnostics: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "solveTimeMs": round(self.solve_time_ms, 2),
            "changes": [c.to_dict() for c in self.changes],
            "conflicts": [c.to_dict() for c in self.conflicts],
            "diagnostics": list(self.diagnostics),
            "warnings": list(self.warnings),
        }
