"""Unit tests for all 8 Kconfig SAT semantics specified in docs/DESIGN_KCONFIG_BACKEND.md Section 6.1."""

from __future__ import annotations

from pathlib import Path
import shutil

import pytest

from kconfig_server.loader import load_kconfig
from kconfig_server.sat_encoder import SATEncoder
from kconfig_server.solver import KconfigSolver, PinnedSymbolInfo

FIXTURE_KCONFIG = Path(__file__).parent / "fixtures" / "Kconfig.synthetic"


def _build_fixture_solver(
    tmp_path: Path, initial_config_lines: list[str] | None = None
) -> tuple[KconfigSolver, dict[str, str]]:
    kernel_dir = tmp_path / "kernel"
    build_dir = tmp_path / "build"
    kernel_dir.mkdir(parents=True, exist_ok=True)
    build_dir.mkdir(parents=True, exist_ok=True)

    shutil.copyfile(FIXTURE_KCONFIG, kernel_dir / "Kconfig")

    if initial_config_lines:
        (build_dir / ".config").write_text(
            "\n".join(initial_config_lines) + "\n", encoding="utf-8"
        )

    env = {
        "srctree": str(kernel_dir),
        "ARCH": "x86_64",
        "SRCARCH": "x86",
        "KCONFIG_CONFIG": str(build_dir / ".config"),
    }
    ir, current_values, _ = load_kconfig(kernel_dir, build_dir, env)
    encoder = SATEncoder(ir, current_values)
    solver = KconfigSolver(ir, encoder)
    return solver, current_values


def test_1_linear_dependency(tmp_path: Path) -> None:
    """1. Linear Dependency: C depends on B, B depends on A -> enables A=y, B=y, C=y."""
    solver, cur = _build_fixture_solver(tmp_path)
    res = solver.solve(requests=[("LIN_C", "y")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: (c.new_value, c.reason) for c in res.changes}
    assert change_map["LIN_C"] == ("y", "user_request")
    assert change_map["LIN_B"] == ("y", "required_by:LIN_C")
    assert change_map["LIN_A"] == ("y", "required_by:LIN_B")


def test_2_disjunction_cost_minimization(tmp_path: Path) -> None:
    """2. Disjunction Cost Minimization: C depends on A || (B1 && B2) -> chooses A=y (cost 1)."""
    solver, cur = _build_fixture_solver(tmp_path)
    res = solver.solve(requests=[("DISJ_C", "y")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: c.new_value for c in res.changes}
    assert change_map.get("DISJ_C") == "y"
    assert change_map.get("DISJ_A") == "y"
    assert "DISJ_B1" not in change_map
    assert "DISJ_B2" not in change_map


def test_3_negation_and_auto_disable(tmp_path: Path) -> None:
    """3. Negation & Auto-Disable: B depends on !A (A=y currently, unpinned) -> sets A=n, B=y."""
    solver, cur = _build_fixture_solver(tmp_path, ["CONFIG_NEG_A=y"])
    assert cur["NEG_A"] == "y"
    res = solver.solve(requests=[("NEG_B", "y")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: (c.new_value, c.reason) for c in res.changes}
    assert change_map["NEG_B"] == ("y", "user_request")
    assert change_map["NEG_A"] == ("n", "required_by:NEG_B")


def test_4_pinned_conflict_and_unsat_core(tmp_path: Path) -> None:
    """4. Pinned Conflict + UNSAT Core: B depends on !A with A=y pinned in qemu.config."""
    solver, cur = _build_fixture_solver(tmp_path, ["CONFIG_NEG_A=y"])
    pinned = {
        "NEG_A": PinnedSymbolInfo(
            symbol="NEG_A",
            value="y",
            layer_id="qemu",
            layer_path="configs/qemu.config",
        )
    }
    res = solver.solve(
        requests=[("NEG_B", "y")],
        current_values=cur,
        pinned_map=pinned,
        ignore_pins=False,
    )
    assert res.status == "conflict"
    conflict_syms = {(c.kind, c.symbol, c.layer_id) for c in res.conflicts}
    assert ("user_request", "NEG_B", None) in conflict_syms
    assert ("pinned_layer", "NEG_A", "qemu") in conflict_syms

    # Re-running with ignore_pins=True succeeds
    res_ignored = solver.solve(
        requests=[("NEG_B", "y")],
        current_values=cur,
        pinned_map=pinned,
        ignore_pins=True,
    )
    assert res_ignored.status == "ok"
    change_map = {c.symbol: c.new_value for c in res_ignored.changes}
    assert change_map["NEG_A"] == "n"
    assert change_map["NEG_B"] == "y"


def test_5_tristate_and_modules(tmp_path: Path) -> None:
    """5. Tristate & MODULES=n: Request TRISTATE_A=m automatically enables MODULES=y or conflicts if pinned."""
    solver, cur = _build_fixture_solver(tmp_path, ["# CONFIG_MODULES is not set"])
    assert cur["MODULES"] == "n"

    res = solver.solve(requests=[("TRISTATE_A", "m")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: c.new_value for c in res.changes}
    assert change_map["TRISTATE_A"] == "m"
    assert change_map["MODULES"] == "y"

    # If MODULES=n is pinned, requesting TRISTATE_A=m conflicts
    pinned = {
        "MODULES": PinnedSymbolInfo(
            symbol="MODULES",
            value="n",
            layer_id="qemu",
            layer_path="configs/qemu.config",
        )
    }
    res_conflict = solver.solve(
        requests=[("TRISTATE_A", "m")],
        current_values=cur,
        pinned_map=pinned,
    )
    assert res_conflict.status == "conflict"


def test_6_select_boolean_promotion(tmp_path: Path) -> None:
    """6. select Promotion: TRISTATE_A=m selects BOOL_SELECTED -> forces BOOL_SELECTED=y (not m)."""
    solver, cur = _build_fixture_solver(tmp_path, ["CONFIG_MODULES=y"])
    res = solver.solve(requests=[("TRISTATE_A", "m")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: (c.new_value, c.reason) for c in res.changes}
    assert change_map["TRISTATE_A"] == ("m", "user_request")
    assert change_map["BOOL_SELECTED"] == ("y", "selected_by:TRISTATE_A")


def test_7_exclusive_choice_switch(tmp_path: Path) -> None:
    """7. Exclusive choice Switch: Request CHOICE_OPT_2=y -> sets CHOICE_OPT_1=n, CHOICE_OPT_2=y."""
    solver, cur = _build_fixture_solver(
        tmp_path, ["CONFIG_CHOICE_OPT_1=y", "# CONFIG_CHOICE_OPT_2 is not set"]
    )
    assert cur["CHOICE_OPT_1"] == "y"
    assert cur["CHOICE_OPT_2"] == "n"

    res = solver.solve(requests=[("CHOICE_OPT_2", "y")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: (c.new_value, c.reason) for c in res.changes}
    assert change_map["CHOICE_OPT_2"] == ("y", "user_request")
    assert change_map["CHOICE_OPT_1"] == ("n", "choice_replaced_by:CHOICE_OPT_2")


def test_8_promptless_guard(tmp_path: Path) -> None:
    """8. Promptless Guard: Promptless INTERNAL_HELPER selected only by prompted DRIVER_X."""
    solver, cur = _build_fixture_solver(tmp_path)
    res = solver.solve(requests=[("INTERNAL_HELPER", "y")], current_values=cur)
    assert res.status == "ok"
    change_map = {c.symbol: (c.new_value, c.reason) for c in res.changes}
    assert change_map["INTERNAL_HELPER"] == ("y", "user_request")
    assert change_map["DRIVER_X"] == ("y", "required_by:INTERNAL_HELPER")
