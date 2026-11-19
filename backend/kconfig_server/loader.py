"""Kconfiglib parser and immutable KconfigIR builder."""

from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from typing import Any, Iterator

import kconfiglib

from .layer_manager import parse_config_fragment
from .models import (
    CONST_M,
    CONST_N,
    CONST_Y,
    ChoiceIR,
    CmpExpr,
    CmpOp,
    ExprIR,
    KconfigIR,
    MenuNodeIR,
    SymRefExpr,
    SymType,
    SymbolIR,
    TriVal,
    make_and,
    make_not,
    make_or,
)

sys.setrecursionlimit(max(sys.getrecursionlimit(), 10000))

_KCONFIGLIB_TYPE_MAP: dict[int, SymType] = {
    kconfiglib.BOOL: SymType.BOOL,
    kconfiglib.TRISTATE: SymType.TRISTATE,
    kconfiglib.INT: SymType.INT,
    kconfiglib.HEX: SymType.HEX,
    kconfiglib.STRING: SymType.STRING,
    kconfiglib.UNKNOWN: SymType.UNKNOWN,
}

_KCONFIGLIB_CMP_MAP: dict[int, CmpOp] = {
    kconfiglib.EQUAL: "=",
    kconfiglib.UNEQUAL: "!=",
    kconfiglib.LESS: "<",
    kconfiglib.LESS_EQUAL: "<=",
    kconfiglib.GREATER: ">",
    kconfiglib.GREATER_EQUAL: ">=",
}


@contextmanager
def _temp_environ(overrides: dict[str, str]) -> Iterator[None]:
    old_env = os.environ.copy()
    try:
        os.environ.update(overrides)
        yield
    finally:
        os.environ.clear()
        os.environ.update(old_env)


def _translate_cmp_operand(item: Any) -> tuple[str | int, bool]:
    if isinstance(item, kconfiglib.Symbol):
        if item.is_constant:
            return item.name, False
        return item.name, True
    if isinstance(item, kconfiglib.Choice):
        return item.name or f"CHOICE_{id(item)}", True
    return str(item), False


def _translate_expr(kconf: kconfiglib.Kconfig, expr: Any) -> ExprIR:
    """Recursively translate a kconfiglib expression into an ExprIR."""
    if expr is None:
        return CONST_Y
    if expr is kconf.y:
        return CONST_Y
    if expr is kconf.m:
        return CONST_M
    if expr is kconf.n:
        return CONST_N

    if isinstance(expr, kconfiglib.Symbol):
        if expr.is_constant:
            n = expr.name.lower()
            if n == "y":
                return CONST_Y
            if n == "m":
                return CONST_M
            return CONST_N
        return SymRefExpr(expr.name)

    if isinstance(expr, kconfiglib.Choice):
        if expr.name:
            return SymRefExpr(expr.name)
        # Anonymous choice: visible if any prompt is visible
        vis: ExprIR = CONST_N
        for node in expr.nodes:
            if node.prompt is not None:
                vis = make_or(vis, _translate_expr(kconf, node.prompt[1]))
        return vis

    if isinstance(expr, tuple):
        op = expr[0]
        if op == kconfiglib.NOT:
            return make_not(_translate_expr(kconf, expr[1]))
        if op == kconfiglib.AND:
            return make_and(
                _translate_expr(kconf, expr[1]),
                _translate_expr(kconf, expr[2]),
            )
        if op == kconfiglib.OR:
            return make_or(
                _translate_expr(kconf, expr[1]),
                _translate_expr(kconf, expr[2]),
            )
        if op in _KCONFIGLIB_CMP_MAP:
            cmp_op = _KCONFIGLIB_CMP_MAP[op]
            left_val, left_is_sym = _translate_cmp_operand(expr[1])
            right_val, right_is_sym = _translate_cmp_operand(expr[2])
            if (
                cmp_op in ("=", "!=")
                and not left_is_sym
                and not right_is_sym
            ):
                eq = str(left_val) == str(right_val)
                if cmp_op == "!=":
                    eq = not eq
                return CONST_Y if eq else CONST_N
            return CmpExpr(
                op=cmp_op,
                left=left_val,
                right=right_val,
                left_is_sym=left_is_sym,
                right_is_sym=right_is_sym,
            )

    return CONST_N


def _compute_node_menu_path(node: kconfiglib.MenuNode) -> tuple[str, ...]:
    path: list[str] = []
    cur = node.parent
    while cur is not None:
        if cur.prompt is not None and cur.prompt[0]:
            path.append(cur.prompt[0])
        cur = cur.parent
    path.reverse()
    return tuple(path)


def load_kconfig(
    kernel_dir: Path,
    build_dir: Path,
    env_vars: dict[str, str],
    kconfig_filename: str = "Kconfig",
) -> tuple[KconfigIR, dict[str, str], list[str]]:
    """Parse Kconfig tree via kconfiglib and build an immutable KconfigIR."""
    kconfig_path = kernel_dir / kconfig_filename
    if not kconfig_path.is_file():
        raise FileNotFoundError(f"Kconfig file not found at {kconfig_path}")

    with _temp_environ(env_vars):
        kconf = kconfiglib.Kconfig(
            filename=str(kconfig_path),
            warn_to_stderr=False,
            suppress_traceback=True,
        )
        dot_config = build_dir / ".config"
        if dot_config.is_file():
            kconf.load_config(str(dot_config))

    warnings = list(kconf.warnings)

    choice_id_by_obj: dict[int, str] = {}
    choice_id_by_sym: dict[str, str] = {}
    choices_ir: dict[str, ChoiceIR] = {}

    for idx, choice in enumerate(kconf.unique_choices):
        cid = choice.name if choice.name else f"CHOICE_{idx}"
        if cid in choices_ir:
            cid = f"{cid}_{idx}"
        choice_id_by_obj[id(choice)] = cid

        c_type = _KCONFIGLIB_TYPE_MAP.get(choice.orig_type, SymType.BOOL)
        c_vis: ExprIR = CONST_N
        c_prompt = ""
        for node in choice.nodes:
            if node.prompt is not None:
                if not c_prompt:
                    c_prompt = node.prompt[0]
                p_cond = _translate_expr(kconf, node.prompt[1])
                n_dep = _translate_expr(kconf, node.dep)
                c_vis = make_or(c_vis, make_and(p_cond, n_dep))

        members: list[str] = []
        for m_sym in choice.syms:
            if m_sym.name:
                members.append(m_sym.name)
                choice_id_by_sym[m_sym.name] = cid

        c_defaults: list[tuple[str, ExprIR]] = []
        for def_sym, cond in choice.defaults:
            if isinstance(def_sym, kconfiglib.Symbol) and def_sym.name:
                c_defaults.append((def_sym.name, _translate_expr(kconf, cond)))

        choices_ir[cid] = ChoiceIR(
            id=cid,
            name=choice.name,
            sym_type=c_type,
            is_optional=bool(getattr(choice, "is_optional", False)),
            visibility=c_vis,
            members=tuple(members),
            prompt=c_prompt,
            direct_dep=_translate_expr(kconf, choice.direct_dep),
            defaults=tuple(c_defaults),
        )

    symbols_ir: dict[str, SymbolIR] = {}
    reverse_selects_map: dict[str, list[tuple[str, ExprIR]]] = defaultdict(list)
    current_values: dict[str, str] = {}

    for sym in kconf.unique_defined_syms:
        if not sym.name or sym.is_constant:
            continue

        s_type = _KCONFIGLIB_TYPE_MAP.get(sym.orig_type, SymType.UNKNOWN)
        prompts: list[tuple[str, ExprIR]] = []
        vis_expr: ExprIR = CONST_N
        help_chunks: list[str] = []
        menu_path: tuple[str, ...] = ()

        for node in sym.nodes:
            if not menu_path:
                menu_path = _compute_node_menu_path(node)
            if node.prompt is not None:
                p_text, p_cond_raw = node.prompt
                p_cond = make_and(
                    _translate_expr(kconf, p_cond_raw),
                    _translate_expr(kconf, node.dep),
                )
                prompts.append((p_text, p_cond))
                vis_expr = make_or(vis_expr, p_cond)
            if getattr(node, "help", None):
                help_chunks.append(node.help.strip())

        selects: list[tuple[str, ExprIR]] = []
        for target_sym, cond_raw in sym.selects:
            if isinstance(target_sym, kconfiglib.Symbol) and target_sym.name:
                cond_ir = _translate_expr(kconf, cond_raw)
                selects.append((target_sym.name, cond_ir))
                reverse_selects_map[target_sym.name].append((sym.name, cond_ir))

        implies: list[tuple[str, ExprIR]] = []
        for target_sym, cond_raw in sym.implies:
            if isinstance(target_sym, kconfiglib.Symbol) and target_sym.name:
                implies.append((target_sym.name, _translate_expr(kconf, cond_raw)))

        defaults: list[tuple[ExprIR | str, ExprIR]] = []
        for val_raw, cond_raw in sym.defaults:
            cond_ir = _translate_expr(kconf, cond_raw)
            if s_type.is_bool_or_tristate:
                val_ir: ExprIR | str = _translate_expr(kconf, val_raw)
            else:
                if isinstance(val_raw, kconfiglib.Symbol):
                    val_ir = val_raw.str_value if val_raw.is_constant else val_raw.name
                else:
                    val_ir = str(val_raw)
            defaults.append((val_ir, cond_ir))

        symbols_ir[sym.name] = SymbolIR(
            name=sym.name,
            sym_type=s_type,
            has_prompt=len(prompts) > 0,
            prompts=tuple(prompts),
            direct_dep=_translate_expr(kconf, sym.direct_dep),
            visibility=vis_expr,
            selects=tuple(selects),
            implies=tuple(implies),
            defaults=tuple(defaults),
            choice_id=choice_id_by_sym.get(sym.name),
            help_text="\n\n".join(help_chunks),
            menu_path=menu_path,
        )

        current_values[sym.name] = sym.str_value

    # Build menu tree for kconfig/getTree
    menu_nodes: dict[str, MenuNodeIR] = {}
    node_counter = 0

    def _walk_menu_nodes(
        first_node: kconfiglib.MenuNode | None, parent_id: str | None
    ) -> tuple[str, ...]:
        nonlocal node_counter
        child_ids: list[str] = []
        cur = first_node
        while cur is not None:
            item = cur.item
            prompt_str = cur.prompt[0] if cur.prompt is not None else ""
            vis_ir = (
                make_and(
                    _translate_expr(kconf, cur.prompt[1]),
                    _translate_expr(kconf, cur.dep),
                )
                if cur.prompt is not None
                else _translate_expr(kconf, cur.dep)
            )

            kind: Any = None
            name: str | None = None
            if isinstance(item, kconfiglib.Symbol):
                if item.name and item.name in symbols_ir:
                    kind = "symbol"
                    name = item.name
                    if not prompt_str:
                        prompt_str = item.name
            elif isinstance(item, kconfiglib.Choice):
                cid = choice_id_by_obj.get(id(item))
                if cid:
                    kind = "choice"
                    name = cid
                    if not prompt_str:
                        prompt_str = cid
            elif item == kconfiglib.MENU:
                kind = "menu"
            elif item == kconfiglib.COMMENT:
                kind = "comment"

            if kind is not None:
                node_counter += 1
                nid = f"node_{node_counter}"
                # Reserve nid before recursing
                sub_children = _walk_menu_nodes(cur.list, nid) if cur.list is not None else ()
                # Only include symbol nodes that have prompts or children, or menus/choices
                if kind != "symbol" or cur.prompt is not None or sub_children:
                    menu_nodes[nid] = MenuNodeIR(
                        id=nid,
                        parent_id=parent_id,
                        kind=kind,
                        name=name,
                        prompt=prompt_str,
                        visibility=vis_ir,
                        children=sub_children,
                    )
                    child_ids.append(nid)
            elif cur.list is not None:
                # Transparent 'if' container node: hoist children into current parent
                child_ids.extend(_walk_menu_nodes(cur.list, parent_id))

            cur = cur.next
        return tuple(child_ids)

    root_ids = _walk_menu_nodes(kconf.top_node.list, None)
    root_nodes = [menu_nodes[rid] for rid in root_ids if rid in menu_nodes]

    reverse_selects_frozen: dict[str, tuple[tuple[str, ExprIR], ...]] = {
        k: tuple(v) for k, v in reverse_selects_map.items()
    }

    ir = KconfigIR(
        symbols=symbols_ir,
        choices=choices_ir,
        reverse_selects=reverse_selects_frozen,
        menu_nodes=menu_nodes,
        root_node_ids=root_ids,
        menu_tree=root_nodes,
    )
    return ir, current_values, warnings


def reload_dot_config(
    ir: KconfigIR,
    config_path: Path,
    base_values: dict[str, str] | None = None,
) -> dict[str, str]:
    """Re-read a .config file from disk without re-parsing the Kconfig tree."""
    values: dict[str, str] = {}
    for sym_name, sym in ir.symbols.items():
        if sym.sym_type.is_bool_or_tristate:
            values[sym_name] = "n"
        elif base_values and sym_name in base_values:
            values[sym_name] = base_values[sym_name]
        else:
            values[sym_name] = ""

    if not config_path.is_file():
        return values

    parsed = parse_config_fragment(config_path)
    for sym_name, val in parsed.items():
        if sym_name in ir.symbols:
            sym = ir.symbols[sym_name]
            if sym.sym_type.is_bool_or_tristate:
                if val in ("y", "m", "n"):
                    values[sym_name] = val
            else:
                if val.startswith('"') and val.endswith('"') and len(val) >= 2:
                    val = val[1:-1]
                values[sym_name] = val
    return values
