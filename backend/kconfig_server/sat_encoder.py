"""Tristate order encoding and Tseitin CNF compiler for KconfigIR."""

from __future__ import annotations

import logging
import time
from typing import Callable

from pysat.card import CardEnc, EncType
from pysat.formula import IDPool

from .models import (
    CONST_M,
    CONST_N,
    CONST_Y,
    AndExpr,
    CmpExpr,
    ConstExpr,
    ExprIR,
    KconfigIR,
    NotExpr,
    OrExpr,
    SymRefExpr,
    SymType,
    TriVal,
    eval_expr_trival,
    expr_referenced_symbols,
    make_and,
    make_not,
    make_or,
)

logger = logging.getLogger(__name__)


class SATEncoder:
    """Compiles a KconfigIR into a reusable base CNF formula over tristate variables."""

    def __init__(self, ir: KconfigIR, current_values: dict[str, str]) -> None:
        self.ir = ir
        self.current_values = current_values
        self.pool = IDPool(start_from=1)

        self.true_var: int = self.pool.id("__TRUE__")
        self.false_var: int = -self.true_var

        self.base_hard_clauses: list[list[int]] = [[self.true_var]]
        self.folded_nonbool_syms: set[str] = set()

        self._ge_m_vars: dict[str, int] = {}
        self._is_y_vars: dict[str, int] = {}
        self._is_m_vars: dict[str, int] = {}

        self._expr_cache: dict[ExprIR, tuple[int, int]] = {}
        self._and_cache: dict[tuple[int, int], int] = {}
        self._or_cache: dict[tuple[int, int], int] = {}
        self._equiv_cache: dict[tuple[int, int], int] = {}

        self.encode_time_ms: float = 0.0
        self._compile_base_cnf()

    def ge_m(self, sym_name: str) -> int:
        return self._ge_m_vars[sym_name]

    def is_y(self, sym_name: str) -> int:
        return self._is_y_vars[sym_name]

    def is_m(self, sym_name: str) -> int:
        """Return a literal that is true iff sym_name == m."""
        if sym_name in self._is_m_vars:
            return self._is_m_vars[sym_name]
        sym = self.ir.symbols[sym_name]
        if sym.sym_type == SymType.BOOL:
            self._is_m_vars[sym_name] = self.false_var
            return self.false_var
        gm = self._ge_m_vars[sym_name]
        iy = self._is_y_vars[sym_name]
        m_var = self.tseitin_and(gm, -iy)
        self._is_m_vars[sym_name] = m_var
        return m_var

    def val_lit(self, sym_name: str, val: TriVal) -> int:
        """Return a single literal representing (sym_name == val)."""
        if val == TriVal.Y:
            return self.is_y(sym_name)
        if val == TriVal.N:
            return -self.ge_m(sym_name)
        return self.is_m(sym_name)

    def tseitin_and(self, a: int, b: int) -> int:
        if a == self.false_var or b == self.false_var:
            return self.false_var
        if a == self.true_var:
            return b
        if b == self.true_var:
            return a
        if a == b:
            return a
        if a == -b:
            return self.false_var

        key = (a, b) if a < b else (b, a)
        cached = self._and_cache.get(key)
        if cached is not None:
            return cached

        z = self.pool.id()
        self.base_hard_clauses.append([-z, a])
        self.base_hard_clauses.append([-z, b])
        self.base_hard_clauses.append([z, -a, -b])
        self._and_cache[key] = z
        return z

    def tseitin_or(self, a: int, b: int) -> int:
        if a == self.true_var or b == self.true_var:
            return self.true_var
        if a == self.false_var:
            return b
        if b == self.false_var:
            return a
        if a == b:
            return a
        if a == -b:
            return self.true_var

        key = (a, b) if a < b else (b, a)
        cached = self._or_cache.get(key)
        if cached is not None:
            return cached

        z = self.pool.id()
        self.base_hard_clauses.append([z, -a])
        self.base_hard_clauses.append([z, -b])
        self.base_hard_clauses.append([-z, a, b])
        self._or_cache[key] = z
        return z

    def tseitin_equiv(self, a: int, b: int) -> int:
        if a == b:
            return self.true_var
        if a == -b:
            return self.false_var
        if a == self.true_var:
            return b
        if a == self.false_var:
            return -b
        if b == self.true_var:
            return a
        if b == self.false_var:
            return -a

        key = (a, b) if a < b else (b, a)
        cached = self._equiv_cache.get(key)
        if cached is not None:
            return cached

        z = self.pool.id()
        self.base_hard_clauses.append([-z, -a, b])
        self.base_hard_clauses.append([-z, a, -b])
        self.base_hard_clauses.append([z, a, b])
        self.base_hard_clauses.append([z, -a, -b])
        self._equiv_cache[key] = z
        return z

    def _resolve_tristate_cmp_operand(
        self, operand: str | int, is_sym: bool
    ) -> tuple[int, int] | None:
        s = str(operand)
        if not is_sym:
            sl = s.lower()
            if sl == "y":
                return (self.true_var, self.true_var)
            if sl == "m":
                return (self.true_var, self.false_var)
            if sl == "n":
                return (self.false_var, self.false_var)
            return None

        if s in self._ge_m_vars:
            return (self._ge_m_vars[s], self._is_y_vars[s])
        sl = s.lower()
        if sl == "y":
            return (self.true_var, self.true_var)
        if sl == "m":
            return (self.true_var, self.false_var)
        if sl == "n":
            return (self.false_var, self.false_var)
        return None

    def encode_expr(self, expr: ExprIR) -> tuple[int, int]:
        """Encode an ExprIR into (lit_ge_m, lit_y) using Tseitin transformation."""
        cached = self._expr_cache.get(expr)
        if cached is not None:
            return cached

        match expr:
            case ConstExpr(val=v):
                if v == TriVal.N:
                    res = (self.false_var, self.false_var)
                elif v == TriVal.M:
                    res = (self.true_var, self.false_var)
                else:
                    res = (self.true_var, self.true_var)

            case SymRefExpr(name=name):
                if name in self._ge_m_vars:
                    res = (self._ge_m_vars[name], self._is_y_vars[name])
                else:
                    self.folded_nonbool_syms.add(name)
                    raw_val = self.current_values.get(name, "")
                    if raw_val not in ("", "n", "N"):
                        res = (self.true_var, self.true_var)
                    else:
                        res = (self.false_var, self.false_var)

            case NotExpr(operand=op):
                op_ge_m, op_y = self.encode_expr(op)
                res = (-op_y, -op_ge_m)

            case AndExpr(left=l, right=r):
                l_ge_m, l_y = self.encode_expr(l)
                r_ge_m, r_y = self.encode_expr(r)
                res = (
                    self.tseitin_and(l_ge_m, r_ge_m),
                    self.tseitin_and(l_y, r_y),
                )

            case OrExpr(left=l, right=r):
                l_ge_m, l_y = self.encode_expr(l)
                r_ge_m, r_y = self.encode_expr(r)
                res = (
                    self.tseitin_or(l_ge_m, r_ge_m),
                    self.tseitin_or(l_y, r_y),
                )

            case CmpExpr(op=op, left=l, right=r, left_is_sym=ls, right_is_sym=rs):
                l_tri = self._resolve_tristate_cmp_operand(l, ls) if op in ("=", "!=") else None
                r_tri = self._resolve_tristate_cmp_operand(r, rs) if op in ("=", "!=") else None
                if l_tri is not None and r_tri is not None:
                    eq_gm = self.tseitin_equiv(l_tri[0], r_tri[0])
                    eq_y = self.tseitin_equiv(l_tri[1], r_tri[1])
                    eq_both = self.tseitin_and(eq_gm, eq_y)
                    lit = eq_both if op == "=" else -eq_both
                    res = (lit, lit)
                else:
                    for ref_sym in expr_referenced_symbols(expr):
                        if ref_sym not in self._ge_m_vars:
                            self.folded_nonbool_syms.add(ref_sym)
                    tri = eval_expr_trival(expr, self.current_values, self.ir.symbols)
                    lit = self.true_var if tri == TriVal.Y else self.false_var
                    res = (lit, lit)

        self._expr_cache[expr] = res
        return res

    def _encode_defaults(
        self,
        defaults: tuple[tuple[ExprIR | str, ExprIR], ...],
        direct_dep: ExprIR,
    ) -> tuple[int, int]:
        """Encode cascaded defaults masked by direct_dep."""
        if not defaults:
            return (self.false_var, self.false_var)

        prev_unmatched_ge_m = self.true_var
        prev_unmatched_y = self.true_var
        acc_ge_m = self.false_var
        acc_y = self.false_var

        for val_item, cond_expr in defaults:
            if isinstance(val_item, str):
                continue
            val_ge_m, val_y = self.encode_expr(val_item)
            cond_ge_m, cond_y = self.encode_expr(cond_expr)

            active_ge_m = self.tseitin_and(cond_ge_m, prev_unmatched_ge_m)
            active_y = self.tseitin_and(cond_y, prev_unmatched_y)

            contrib_ge_m = self.tseitin_and(val_ge_m, active_ge_m)
            contrib_y = self.tseitin_and(val_y, active_y)

            acc_ge_m = self.tseitin_or(acc_ge_m, contrib_ge_m)
            acc_y = self.tseitin_or(acc_y, contrib_y)

            # Once a default condition holds at Y, subsequent defaults cannot trigger
            prev_unmatched_ge_m = self.tseitin_and(prev_unmatched_ge_m, -cond_y)
            prev_unmatched_y = self.tseitin_and(prev_unmatched_y, -cond_y)

        dep_ge_m, dep_y = self.encode_expr(direct_dep)
        return (
            self.tseitin_and(acc_ge_m, dep_ge_m),
            self.tseitin_and(acc_y, dep_y),
        )

    def _compile_base_cnf(self) -> None:
        t0 = time.perf_counter()

        # Pass 1: Allocate SAT variables for all BOOL and TRISTATE symbols
        for sym_name, sym in self.ir.symbols.items():
            if sym.sym_type.is_bool_or_tristate:
                self._ge_m_vars[sym_name] = self.pool.id(("ge_m", sym_name))
                self._is_y_vars[sym_name] = self.pool.id(("is_y", sym_name))

        modules_is_y: int | None = self._is_y_vars.get("MODULES")

        # Pass 2: Domain Invariants
        for sym_name, sym in self.ir.symbols.items():
            if not sym.sym_type.is_bool_or_tristate:
                continue
            gm = self._ge_m_vars[sym_name]
            iy = self._is_y_vars[sym_name]

            # S = y => S >= m
            self.base_hard_clauses.append([-iy, gm])

            if sym.sym_type == SymType.BOOL:
                # BOOL cannot be m: S >= m => S = y
                self.base_hard_clauses.append([-gm, iy])
            elif sym.sym_type == SymType.TRISTATE and modules_is_y is not None:
                # TRISTATE S = m => MODULES = y
                self.base_hard_clauses.append([-gm, iy, modules_is_y])

        # Pass 3: Select lower bounds, visibility, depends on, and promptless guards
        for sym_name, sym in self.ir.symbols.items():
            if not sym.sym_type.is_bool_or_tristate:
                continue
            gm = self._ge_m_vars[sym_name]
            iy = self._is_y_vars[sym_name]

            # Incoming select edges (reverse dependencies)
            rev_expr: ExprIR = CONST_N
            for selector_name, sel_cond in self.ir.reverse_selects.get(sym_name, ()):
                if selector_name not in self._ge_m_vars:
                    continue
                eff_expr = make_and(SymRefExpr(selector_name), sel_cond)
                e_ge_m, e_y = self.encode_expr(eff_expr)
                self.base_hard_clauses.append([-e_ge_m, gm])
                self.base_hard_clauses.append([-e_y, iy])
                rev_expr = make_or(rev_expr, eff_expr)

            vis_ge_m, vis_y = self.encode_expr(sym.visibility)
            rev_ge_m, rev_y = self.encode_expr(rev_expr)

            # For promptless symbols (or symbols with defaults when invisible), encode defaults
            def_ge_m, def_y = self._encode_defaults(sym.defaults, sym.direct_dep)

            # Upper Bound: symbol can only be enabled if visible, selected, or defaulted
            self._append_filtered_clause([-gm, vis_ge_m, rev_ge_m, def_ge_m])
            if sym.sym_type == SymType.BOOL:
                self._append_filtered_clause([-iy, vis_ge_m, rev_ge_m, def_ge_m])
            else:
                self._append_filtered_clause([-iy, vis_y, rev_y, def_y])

            # Promptless / Invisible Lower Bound: when not visible, must respect active defaults
            self._append_filtered_clause([vis_ge_m, -def_ge_m, gm])
            if sym.sym_type == SymType.BOOL:
                self._append_filtered_clause([vis_ge_m, -def_ge_m, iy])
            else:
                self._append_filtered_clause([vis_ge_m, -def_y, iy])

        # Pass 4: Choice groups
        for choice in self.ir.choices.values():
            valid_members = [
                m for m in choice.members if m in self._is_y_vars
            ]
            if not valid_members:
                continue

            c_vis_ge_m, c_vis_y = self.encode_expr(choice.visibility)
            y_lits = [self._is_y_vars[m] for m in valid_members]

            # Members cannot be active if the choice itself is not visible
            for m in valid_members:
                self._append_filtered_clause([-self._ge_m_vars[m], c_vis_ge_m])
                if choice.sym_type == SymType.BOOL:
                    self._append_filtered_clause([-self._is_y_vars[m], c_vis_ge_m])
                    # Members of a bool choice cannot be 'm'
                    self._append_filtered_clause([-self._ge_m_vars[m], self._is_y_vars[m]])

            # At-Most-One 'y' member
            if len(y_lits) > 1:
                amo = CardEnc.atmost(
                    lits=y_lits,
                    bound=1,
                    vpool=self.pool,
                    encoding=EncType.seqcounter,
                )
                self.base_hard_clauses.extend(amo.clauses)

            # At-Least-One 'y' member for mandatory BOOL choices when visible
            if choice.sym_type == SymType.BOOL and not choice.is_optional:
                # Ensure at least one member's condition is satisfiable when choice is visible
                self._append_filtered_clause([-c_vis_ge_m, *y_lits])

        self.encode_time_ms = (time.perf_counter() - t0) * 1000.0

    def _append_filtered_clause(self, lits: list[int]) -> None:
        """Simplify a clause with respect to true_var/false_var before appending."""
        filtered: list[int] = []
        seen: set[int] = set()
        for lit in lits:
            if lit == self.true_var:
                return  # Tautology
            if lit == self.false_var:
                continue
            if -lit in seen:
                return  # Tautology (x or !x)
            if lit not in seen:
                seen.add(lit)
                filtered.append(lit)
        self.base_hard_clauses.append(filtered)
