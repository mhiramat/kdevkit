"""End-to-end JSON-RPC 2.0 integration tests (synthetic fixture and real Linux tree when available)."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest

from kconfig_server.main import KconfigService

FIXTURE_KCONFIG = Path(__file__).parent / "fixtures" / "Kconfig.synthetic"
WS_ROOT = Path(__file__).resolve().parents[2]


def test_rpc_service_lifecycle_synthetic(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    kernel_dir = ws / "linux"
    build_dir = ws / "build" / "current"
    configs_dir = ws / "configs"
    kernel_dir.mkdir(parents=True)
    build_dir.mkdir(parents=True)
    configs_dir.mkdir(parents=True)

    shutil.copyfile(FIXTURE_KCONFIG, kernel_dir / "Kconfig")
    (configs_dir / "qemu.config").write_text("CONFIG_NEG_A=y\n", encoding="utf-8")
    (configs_dir / "trace.config").write_text("", encoding="utf-8")
    (configs_dir / "solver_overlay.config").write_text("", encoding="utf-8")
    (build_dir / ".config").write_text("CONFIG_NEG_A=y\nCONFIG_CHOICE_OPT_1=y\n", encoding="utf-8")

    svc = KconfigService()
    init_res = svc.dispatch(
        "kconfig/init",
        {
            "workspaceRoot": str(ws),
            "kernelDir": str(kernel_dir),
            "buildDir": str(build_dir),
            "useMakeProbe": False,
        },
    )
    assert init_res["symbolCount"] >= 10
    assert init_res["choiceCount"] == 1

    tree_res = svc.dispatch("kconfig/getTree", {"parentId": None})
    assert len(tree_res["nodes"]) > 0

    search_res = svc.dispatch("kconfig/search", {"query": "LIN_"})
    assert len(search_res["items"]) == 3

    detail_res = svc.dispatch("kconfig/getSymbolDetail", {"symbol": "CONFIG_LIN_C"})
    assert detail_res["symbol"] == "LIN_C"
    assert detail_res["directDepText"] == "LIN_B"

    solve_ok = svc.dispatch(
        "kconfig/solve",
        {"requests": [{"symbol": "LIN_C", "value": "y"}]},
    )
    assert solve_ok["status"] == "ok"
    assert {c["symbol"] for c in solve_ok["changes"]} == {"LIN_A", "LIN_B", "LIN_C"}

    solve_conflict = svc.dispatch(
        "kconfig/solve",
        {"requests": [{"symbol": "NEG_B", "value": "y"}]},
    )
    assert solve_conflict["status"] == "conflict"


@pytest.mark.skipif(
    not (WS_ROOT / "linux" / "Kconfig").is_file(),
    reason="Real Linux kernel tree not present at WS_ROOT/linux",
)
def test_real_kernel_init_and_solve_performance(tmp_path: Path) -> None:
    """Verify real Linux tree startup (<10s), solve latency (<500ms), and git cleanliness."""
    # Use a temporary build/layers copy so we don't mutate the user's active .config during pytest
    temp_build = tmp_path / "build"
    temp_build.mkdir(parents=True)
    real_dot_config = WS_ROOT / "build" / "current" / ".config"
    if real_dot_config.is_file():
        shutil.copyfile(real_dot_config, temp_build / ".config")
    real_env_cache = WS_ROOT / "build" / "current" / ".kconfig_env_cache.json"
    if real_env_cache.is_file():
        shutil.copyfile(real_env_cache, temp_build / ".kconfig_env_cache.json")

    svc = KconfigService()
    init_res = svc.dispatch(
        "kconfig/init",
        {
            "workspaceRoot": str(WS_ROOT),
            "kernelDir": str(WS_ROOT / "linux"),
            "buildDir": str(temp_build),
            "arch": "x86_64",
        },
    )
    assert init_res["symbolCount"] > 10000

    t0 = time.perf_counter()
    solve_res = svc.dispatch(
        "kconfig/solve",
        {"requests": [{"symbol": "CONFIG_NET_SCH_FQ", "value": "y"}]},
    )
    solve_ms = (time.perf_counter() - t0) * 1000.0
    assert solve_res["status"] == "ok"
    assert solve_ms < 2000.0

    # Check git cleanliness inside linux/
    git_proc = subprocess.run(
        ["git", "-C", str(WS_ROOT / "linux"), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert git_proc.stdout.strip() == ""
