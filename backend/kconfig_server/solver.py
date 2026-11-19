"""Weighted MaxSAT (RC2) dependency solver, provenance tracker, and UNSAT core analyzer."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import logging
import time

from pysat.examples.rc2 import RC2
from pysat.formula import WCNF
from pysat.solvers import Solver

from .models import (
    ConflictItem,
    KconfigIR,
    SolveResult,
    SymType,
    SymbolChange,
    TriVal,
    eval_expr_trival,
    expr_referenced_symbols,
    expr_to_str,
    normalize_sym_name,
)
from .sat_encoder import SATEncoder

logger = logging.getLogger(__name__)


def _detect_solver_name() -> str:
    for candidate in ("cadical195", "cadical153", "glucose4", "glucose3", "m22"):
        try:
            with Solver(name=candidate) as s:
                s.add_clause([1])
                if s.solve():
                    return candidate
        except Exception:
            continue
    return "glucose4"


SOLVER_NAME = _detect_solver_name()


@dataclass(frozen=True, slots=True)
class PinnedSymbolInfo:
    symbol: str
    value: str
    layer_id: str
    layer_path: str


class KconfigSolver:
    """Solves Kconfig symbol requests using Weighted Partial MaxSAT (RC2) and UNSAT cores."""

    def __init__(self, ir: KconfigIR, encoder: SATEncoder) -> None:
        self.ir = ir
        self.encoder = encoder

    def solve(
        self,
        requests: list[tuple[str, str]],
        current_values: dict[str, str],
        pinned_map: dict[str, PinnedSymbolInfo] | None = None,
        user_injected_map: dict[str, str] | None = None,
        ignore_pins: bool = False,
    ) -> SolveResult:
        t0 = time.perf_counter()
        pinned_map = pinned_map or {}
        user_injected_map = user_injected_map or {}

        normalized_requests: list[tuple[str, TriVal]] = []
        requested_syms: dict[str, TriVal] = {}

        for raw_sym, raw_val in requests:
            sym_name = normalize_sym_name(raw_sym)
            if sym_name not in self.ir.symbols:
                raise ValueError(f"Unknown Kconfig symbol: {raw_sym}")
            sym_ir = self.ir.symbols[sym_name]
            if not sym_ir.sym_type.is_bool_or_tristate:
                raise ValueError(
                    f"Symbol {sym_name} has type {sym_ir.sym_type.value}; "
                    "only bool and tristate symbols are supported by the SAT solver"
                )
            tri_val = TriVal.from_str(raw_val)
            if sym_ir.sym_type == SymType.BOOL and tri_val == TriVal.M:
                raise ValueError(f"BOOL symbol {sym_name} cannot be set to 'm'")
            normalized_requests.append((sym_name, tri_val))
            requested_syms[sym_name] = tri_val

        # Fast check with assumption-based SAT solver first to detect conflicts immediately
        sat_ok, conflicts, diagnostics = self._check_sat_and_extract_core(
            normalized_requests,
            current_values,
            pinned_map,
            ignore_pins=ignore_pins,
        )
        if not sat_ok:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            return SolveResult(
                status="conflict",
                solve_time_ms=elapsed_ms,
                conflicts=tuple(conflicts),
                diagnostics=tuple(diagnostics),
            )

        # Build WCNF for Weighted Partial MaxSAT optimization
        wcnf = WCNF()
        for clause in self.encoder.base_hard_clauses:
            wcnf.append(clause)

        for sym_name, tri_val in normalized_requests:
            self._append_unit_hard_constraint(wcnf, sym_name, tri_val)

        active_pins: set[str] = set()
        if not ignore_pins:
            for sym_name, pin_info in pinned_map.items():
                if (
                    sym_name in self.ir.symbols
                    and self.ir.symbols[sym_name].sym_type.is_bool_or_tristate
                ):
                    try:
                        pin_tri = TriVal.from_str(pin_info.value)
                    except ValueError:
                        continue
                    self._append_unit_hard_constraint(wcnf, sym_name, pin_tri)
                    active_pins.add(sym_name)

        # Soft clauses (tiered weights)
        # Pre-allocate any needed is_m helper clauses before copying or right now
        for sym_name, sym_ir in self.ir.symbols.items():
            if not sym_ir.sym_type.is_bool_or_tristate:
                continue
            if sym_name in requested_syms or sym_name in active_pins:
                continue

            # Tier 1 (Weight 100): Non-pinned user_injected fragment values
            if sym_name in user_injected_map:
                try:
                    inj_tri = TriVal.from_str(user_injected_map[sym_name])
                    lit = self._get_val_lit_with_clauses(wcnf, sym_name, inj_tri)
                    wcnf.append([lit], weight=100)
                    continue
                except ValueError:
                    pass

            cur_str = current_values.get(sym_name, "n")
            try:
                cur_tri = TriVal.from_str(cur_str)
            except ValueError:
                cur_tri = TriVal.N

            if cur_tri in (TriVal.Y, TriVal.M):
                # Tier 2 (Weight 10): Preserve currently enabled (y/m) symbols
                lit = self._get_val_lit_with_clauses(wcnf, sym_name, cur_tri)
                wcnf.append([lit], weight=10)
            else:
                # Tier 3 (Weight 1): Keep currently disabled (n) symbols as n
                wcnf.append([-self.encoder.ge_m(sym_name)], weight=1)

        with RC2(wcnf, solver=SOLVER_NAME) as rc2:
            model = rc2.compute()

        if model is None:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            return SolveResult(
                status="conflict",
                solve_time_ms=elapsed_ms,
                conflicts=tuple(conflicts),
                diagnostics=tuple(diagnostics),
            )

        pos_lits = {lit for lit in model if lit > 0}
        new_values: dict[str, TriVal] = {}
        changed_syms: dict[str, tuple[str, str]] = {}

        for sym_name, sym_ir in self.ir.symbols.items():
            if not sym_ir.sym_type.is_bool_or_tristate:
                continue
            iy = self.encoder.is_y(sym_name)
            gm = self.encoder.ge_m(sym_name)
            if iy in pos_lits:
                new_tri = TriVal.Y
            elif gm in pos_lits:
                new_tri = TriVal.M
            else:
                new_tri = TriVal.N
            new_values[sym_name] = new_tri

            old_str = current_values.get(sym_name, "n")
            if old_str not in ("y", "m", "n"):
                old_str = "n"
            new_str = new_tri.to_str()
            if new_str != old_str or sym_name in requested_syms:
                if new_str != old_str:
                    changed_syms[sym_name] = (old_str, new_str)

        reasons = self._compute_reasons(
            requested_syms=requested_syms,
            changed_syms=changed_syms,
            new_values=new_values,
        )

        # Order changes: user requests first, then dependency closure alphabetically
        ordered_changes: list[SymbolChange] = []
        req_order = [s for s, _ in normalized_requests]
        for sym_name in req_order:
            if sym_name in changed_syms:
                old_v, new_v = changed_syms[sym_name]
                ordered_changes.append(
                    SymbolChange(
                        symbol=sym_name,
                        old_value=old_v,
                        new_value=new_v,
                        reason=reasons.get(sym_name, "user_request"),
                    )
                )
        for sym_name in sorted(changed_syms.keys()):
            if sym_name in requested_syms:
                continue
            old_v, new_v = changed_syms[sym_name]
            ordered_changes.append(
                SymbolChange(
                    symbol=sym_name,
                    old_value=old_v,
                    new_value=new_v,
                    reason=reasons.get(sym_name, "dependency_closure"),
                )
            )

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return SolveResult(
            status="ok",
            solve_time_ms=elapsed_ms,
            changes=tuple(ordered_changes),
        )

    def _append_unit_hard_constraint(
        self, wcnf: WCNF, sym_name: str, tri_val: TriVal
    ) -> None:
        if tri_val == TriVal.Y:
            wcnf.append([self.encoder.is_y(sym_name)])
        elif tri_val == TriVal.M:
            wcnf.append([self.encoder.ge_m(sym_name)])
            wcnf.append([-self.encoder.is_y(sym_name)])
        else:
            wcnf.append([-self.encoder.ge_m(sym_name)])

    def _get_val_lit_with_clauses(
        self, wcnf: WCNF, sym_name: str, tri_val: TriVal
    ) -> int:
        prev_len = len(self.encoder.base_hard_clauses)
        lit = self.encoder.val_lit(sym_name, tri_val)
        if len(self.encoder.base_hard_clauses) > prev_len:
            for cl in self.encoder.base_hard_clauses[prev_len:]:
                wcnf.append(cl)
        return lit

    def _check_sat_and_extract_core(
        self,
        requests: list[tuple[str, TriVal]],
        current_values: dict[str, str],
        pinned_map: dict[str, PinnedSymbolInfo],
        ignore_pins: bool,
    ) -> tuple[bool, list[ConflictItem], list[str]]:
        with Solver(
            name=SOLVER_NAME, bootstrap_with=self.encoder.base_hard_clauses
        ) as solver:
            next_var = self.encoder.pool.top + 1
            assumptions: list[int] = []
            assumption_map: dict[int, ConflictItem] = {}

            for sym_name, tri_val in requests:
                avar = next_var
                next_var += 1
                self._add_guarded_constraint(solver, avar, sym_name, tri_val)
                assumptions.append(avar)
                assumption_map[avar] = ConflictItem(
                    kind="user_request",
                    symbol=sym_name,
                    value=tri_val.to_str(),
                )

            if not ignore_pins:
                for sym_name, pin_info in pinned_map.items():
                    if (
                        sym_name not in self.ir.symbols
                        or not self.ir.symbols[sym_name].sym_type.is_bool_or_tristate
                    ):
                        continue
                    try:
                        pin_tri = TriVal.from_str(pin_info.value)
                    except ValueError:
                        continue
                    pvar = next_var
                    next_var += 1
                    self._add_guarded_constraint(solver, pvar, sym_name, pin_tri)
                    assumptions.append(pvar)
                    assumption_map[pvar] = ConflictItem(
                        kind="pinned_layer",
                        symbol=sym_name,
                        value=pin_info.value,
                        layer_id=pin_info.layer_id,
                        layer_path=pin_info.layer_path,
                    )

            sat = solver.solve(assumptions=assumptions)
            if sat:
                return True, [], []

            raw_core = solver.get_core() or []
            conflicts: list[ConflictItem] = []
            for lit in raw_core:
                item = assumption_map.get(lit)
                if item is not None:
                    conflicts.append(item)

            diagnostics = self._build_conflict_diagnostics(
                conflicts, current_values
            )
            return False, conflicts, diagnostics

    def _add_guarded_constraint(
        self, solver: Solver, guard_var: int, sym_name: str, tri_val: TriVal
    ) -> None:
        if tri_val == TriVal.Y:
            solver.add_clause([-guard_var, self.encoder.is_y(sym_name)])
        elif tri_val == TriVal.M:
            solver.add_clause([-guard_var, self.encoder.ge_m(sym_name)])
            solver.add_clause([-guard_var, -self.encoder.is_y(sym_name)])
        else:
            solver.add_clause([-guard_var, -self.encoder.ge_m(sym_name)])

    def _build_conflict_diagnostics(
        self,
        conflicts: list[ConflictItem],
        current_values: dict[str, str],
    ) -> list[str]:
        diagnostics: list[str] = []
        pin_conflicts = [c for c in conflicts if c.kind == "pinned_layer"]
        req_conflicts = [c for c in conflicts if c.kind == "user_request"]

        if pin_conflicts and req_conflicts:
            req_desc = ", ".join(f"{c.symbol}={c.value}" for c in req_conflicts)
            pin_desc = ", ".join(
                f"{c.symbol}={c.value} (pinned in {c.layer_id}: {c.layer_path})"
                for c in pin_conflicts
            )
            diagnostics.append(
                f"Request [{req_desc}] conflicts with pinned layer constraint(s): {pin_desc}"
            )

        for req in req_conflicts:
            sym_ir = self.ir.symbols.get(req.symbol)
            if sym_ir is None:
                continue
            dep_str = expr_to_str(sym_ir.direct_dep)
            vis_str = expr_to_str(sym_ir.visibility)
            if not sym_ir.has_prompt and req.symbol not in self.ir.reverse_selects:
                diagnostics.append(
                    f"Symbol {req.symbol} has no prompt and no selectors; it cannot be enabled directly."
                )
            elif dep_str != "y":
                diagnostics.append(
                    f"Symbol {req.symbol} depends on: {dep_str} (visibility: {vis_str})"
                )
            for ref in sorted(expr_referenced_symbols(sym_ir.direct_dep)):
                if ref in self.encoder.folded_nonbool_syms:
                    val = current_values.get(ref, "<unset>")
                    diagnostics.append(
                        f"Referenced non-boolean/external symbol {ref} currently has value {val!r}."
                    )

        return diagnostics

    def _compute_reasons(
        self,
        requested_syms: dict[str, TriVal],
        changed_syms: dict[str, tuple[str, str]],
        new_values: dict[str, TriVal],
    ) -> dict[str, str]:
        reasons: dict[str, str] = {}
        queue: deque[str] = deque()

        for sym_name in requested_syms:
            reasons[sym_name] = "user_request"
            queue.append(sym_name)

        # Precompute choice winners (members changed to y)
        choice_winners: dict[str, str] = {}
        for cid, choice in self.ir.choices.items():
            for m in choice.members:
                if m in changed_syms and changed_syms[m][1] == "y":
                    if m in requested_syms or cid not in choice_winners:
                        choice_winners[cid] = m

        for cid, winner in choice_winners.items():
            choice = self.ir.choices[cid]
            for m in choice.members:
                if (
                    m != winner
                    and m in changed_syms
                    and changed_syms[m][1] == "n"
                    and m not in reasons
                ):
                    reasons[m] = f"choice_replaced_by:{winner}"
                    queue.append(m)

        while queue:
            parent = queue.popleft()
            parent_ir = self.ir.symbols.get(parent)
            if parent_ir is None:
                continue

            # 1. Symbols in direct_dep or visibility of parent
            dep_refs = expr_referenced_symbols(parent_ir.direct_dep) | expr_referenced_symbols(
                parent_ir.visibility
            )
            for dep_sym in sorted(dep_refs):
                if dep_sym in changed_syms and dep_sym not in reasons:
                    reasons[dep_sym] = f"required_by:{parent}"
                    queue.append(dep_sym)

            # 2. If parent is promptless (or was enabled via a selector), check its active selectors
            if new_values.get(parent, TriVal.N) != TriVal.N:
                for selector_name, _ in self.ir.reverse_selects.get(parent, ()):
                    if (
                        selector_name in changed_syms
                        and selector_name not in reasons
                        and new_values.get(selector_name, TriVal.N) != TriVal.N
                    ):
                        reasons[selector_name] = f"required_by:{parent}"
                        queue.append(selector_name)

            # 3. Symbols selected by parent
            if new_values.get(parent, TriVal.N) != TriVal.N:
                for target_sym, _ in parent_ir.selects:
                    if (
                        target_sym in changed_syms
                        and target_sym not in reasons
                        and new_values.get(target_sym, TriVal.N) != TriVal.N
                    ):
                        reasons[target_sym] = f"selected_by:{parent}"
                        queue.append(target_sym)

            # 4. If parent is a choice winner, mark any remaining siblings turned off
            if parent_ir.choice_id and new_values.get(parent, TriVal.N) == TriVal.Y:
                choice = self.ir.choices.get(parent_ir.choice_id)
                if choice:
                    for m in choice.members:
                        if (
                            m != parent
                            and m in changed_syms
                            and changed_syms[m][1] == "n"
                            and m not in reasons
                        ):
                            reasons[m] = f"choice_replaced_by:{parent}"
                            queue.append(m)

        for sym_name in changed_syms:
            if sym_name not in reasons:
                reasons[sym_name] = "dependency_closure"

        return reasons
