"""Unit tests for LayerManager fragment parsing, solver overlay writing, and post-verification."""

from __future__ import annotations

from pathlib import Path

from kconfig_server.layer_manager import LayerManager, parse_config_fragment


def test_parse_and_write_overlay_and_verify(tmp_path: Path) -> None:
    ws_root = tmp_path / "ws"
    configs_dir = ws_root / "configs"
    build_dir = ws_root / "build" / "current"
    configs_dir.mkdir(parents=True)
    build_dir.mkdir(parents=True)

    (configs_dir / "qemu.config").write_text(
        "CONFIG_VIRTIO=y\n# CONFIG_DEBUG_INFO_REDUCED is not set\n",
        encoding="utf-8",
    )
    (configs_dir / "trace.config").write_text(
        "CONFIG_KPROBES=y\n",
        encoding="utf-8",
    )
    (configs_dir / "solver_overlay.config").write_text(
        "# Auto-generated\n",
        encoding="utf-8",
    )

    mgr = LayerManager(workspace_root=ws_root, build_dir=build_dir)
    assert mgr.pinned_map["VIRTIO"].value == "y"
    assert mgr.pinned_map["DEBUG_INFO_REDUCED"].value == "n"
    assert mgr.pinned_map["KPROBES"].value == "y"

    overlay_path = mgr.write_solver_overlay([("CONFIG_NET_SCH_FQ", "y"), ("FOO_BAR", "n")])
    parsed_overlay = parse_config_fragment(overlay_path)
    assert parsed_overlay == {"NET_SCH_FQ": "y", "FOO_BAR": "n"}

    # Write a matching final .config and verify
    (build_dir / ".config").write_text(
        "\n".join(
            [
                "CONFIG_VIRTIO=y",
                "# CONFIG_DEBUG_INFO_REDUCED is not set",
                "CONFIG_KPROBES=y",
                "CONFIG_NET_SCH_FQ=y",
                "# CONFIG_FOO_BAR is not set",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    verified, mismatches = mgr.verify_final_config({"NET_SCH_FQ": "y", "FOO_BAR": "n"})
    assert verified is True
    assert mismatches == []

    # Introduce a mismatch in .config
    (build_dir / ".config").write_text(
        "CONFIG_VIRTIO=y\n# CONFIG_KPROBES is not set\n",
        encoding="utf-8",
    )
    verified2, mismatches2 = mgr.verify_final_config({"NET_SCH_FQ": "y"})
    assert verified2 is False
    mismatch_syms = {m["symbol"] for m in mismatches2}
    assert "KPROBES" in mismatch_syms
    assert "NET_SCH_FQ" in mismatch_syms
