"""Declarative config layer management, solver overlay writer, and Phase 1 configure.sh runner."""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import os
from pathlib import Path
import re
import subprocess
from typing import Any

from .models import normalize_sym_name
from .solver import PinnedSymbolInfo

logger = logging.getLogger(__name__)

_RE_CONFIG_SET = re.compile(r"^CONFIG_([A-Za-z0-9_]+)=(.+)$")
_RE_CONFIG_UNSET = re.compile(r"^#\s*CONFIG_([A-Za-z0-9_]+)\s+is not set\s*$")
_RE_MERGE_WARN = re.compile(
    r"(Value requested for CONFIG_[A-Za-z0-9_]+ not in final \.config.*|WARNING:.*)"
)


class ConfigureScriptError(RuntimeError):
    """Raised when Phase 1 scripts/configure.sh fails."""

    def __init__(
        self,
        message: str,
        returncode: int,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@dataclass(slots=True)
class LayerEntry:
    id: str
    path: str
    enabled: bool = True
    pinned: bool = False
    readonly: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "enabled": self.enabled,
            "pinned": self.pinned,
            "readonly": self.readonly,
        }


def parse_config_fragment(path: Path) -> dict[str, str]:
    """Parse a Kconfig fragment or .config file into {SYMBOL_NAME: value}."""
    result: dict[str, str] = {}
    if not path.is_file():
        return result

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m_set = _RE_CONFIG_SET.match(line)
        if m_set:
            sym, val = m_set.group(1), m_set.group(2).strip()
            result[sym] = val
            continue
        m_unset = _RE_CONFIG_UNSET.match(line)
        if m_unset:
            sym = m_unset.group(1)
            result[sym] = "n"
    return result


def format_config_line(symbol: str, value: str) -> str:
    """Format a single symbol assignment in canonical Kconfig .config syntax."""
    sym = normalize_sym_name(symbol)
    val = value.strip()
    if val == "n":
        return f"# CONFIG_{sym} is not set"
    return f"CONFIG_{sym}={val}"


class LayerManager:
    """Manages configs/layers.json, solver_overlay.config, and scripts/configure.sh invocation."""

    def __init__(
        self,
        workspace_root: Path,
        layers_json_path: Path | None = None,
        build_dir: Path | None = None,
        kernel_dir: Path | None = None,
        arch: str = "x86_64",
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.layers_json_path = (
            layers_json_path.resolve()
            if layers_json_path is not None
            else (self.workspace_root / "configs" / "layers.json")
        )
        self.build_dir = (
            build_dir.resolve()
            if build_dir is not None
            else (self.workspace_root / "build" / "current")
        )
        self.kernel_dir = (
            kernel_dir.resolve()
            if kernel_dir is not None
            else (self.workspace_root / "linux")
        )
        self.arch = arch

        self.version: int = 1
        self.base_target: str = "defconfig"
        self.layers: list[LayerEntry] = []

        self.pinned_map: dict[str, PinnedSymbolInfo] = {}
        self.user_injected_map: dict[str, str] = {}

        self.load_layers_json()

    def resolve_layer_path(self, raw_path: str) -> Path:
        p = Path(raw_path)
        if not p.is_absolute():
            p = self.workspace_root / p
        return p.resolve()

    def load_layers_json(self) -> None:
        if not self.layers_json_path.is_file():
            self.version = 1
            self.base_target = "defconfig"
            self.layers = [
                LayerEntry(
                    id="qemu",
                    path="configs/qemu.config",
                    enabled=True,
                    pinned=True,
                    readonly=False,
                ),
                LayerEntry(
                    id="trace",
                    path="configs/trace.config",
                    enabled=True,
                    pinned=True,
                    readonly=False,
                ),
                LayerEntry(
                    id="solver",
                    path="configs/solver_overlay.config",
                    enabled=True,
                    pinned=False,
                    readonly=True,
                ),
            ]
            self.save_layers_json()
        else:
            data = json.loads(self.layers_json_path.read_text(encoding="utf-8"))
            self.version = int(data.get("version", 1))
            self.base_target = str(
                data.get("base_target") or data.get("baseTarget") or "defconfig"
            )
            loaded_layers: list[LayerEntry] = []
            for item in data.get("layers", []):
                loaded_layers.append(
                    LayerEntry(
                        id=str(item["id"]),
                        path=str(item["path"]),
                        enabled=bool(item.get("enabled", True)),
                        pinned=bool(item.get("pinned", False)),
                        readonly=bool(item.get("readonly", False)),
                    )
                )
            self.layers = loaded_layers

        self.rebuild_constraint_maps()

    def save_layers_json(self) -> None:
        self.layers_json_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": self.version,
            "base_target": self.base_target,
            "layers": [layer.to_dict() for layer in self.layers],
        }
        self.layers_json_path.write_text(
            json.dumps(payload, indent=2) + "\n",
            encoding="utf-8",
        )

    def rebuild_constraint_maps(self) -> tuple[dict[str, PinnedSymbolInfo], dict[str, str]]:
        pinned: dict[str, PinnedSymbolInfo] = {}
        injected: dict[str, str] = {}

        for layer in self.layers:
            if not layer.enabled:
                continue
            fpath = self.resolve_layer_path(layer.path)
            parsed = parse_config_fragment(fpath)
            for sym, val in parsed.items():
                if layer.pinned:
                    pinned[sym] = PinnedSymbolInfo(
                        symbol=sym,
                        value=val,
                        layer_id=layer.id,
                        layer_path=layer.path,
                    )
                elif layer.id != "solver":
                    injected[sym] = val

        self.pinned_map = pinned
        self.user_injected_map = injected
        return pinned, injected

    def get_layers_info(self) -> dict[str, Any]:
        layers_out: list[dict[str, Any]] = []
        for layer in self.layers:
            fpath = self.resolve_layer_path(layer.path)
            parsed = parse_config_fragment(fpath)
            entry_dict = layer.to_dict()
            entry_dict["symbolCount"] = len(parsed)
            entry_dict["exists"] = fpath.is_file()
            layers_out.append(entry_dict)
        return {
            "version": self.version,
            "base_target": self.base_target,
            "baseTarget": self.base_target,
            "layers": layers_out,
        }

    def set_layers(
        self,
        base_target: str | None,
        new_layers: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if base_target:
            self.base_target = str(base_target)

        validated: list[LayerEntry] = []
        for item in new_layers:
            lid = str(item["id"])
            lpath = str(item["path"])
            resolved = self.resolve_layer_path(lpath)
            if lid == "solver" and not resolved.is_file():
                resolved.parent.mkdir(parents=True, exist_ok=True)
                resolved.write_text(
                    "# Auto-generated by kconfig-server (solver_overlay.config)\n",
                    encoding="utf-8",
                )
            elif not resolved.is_file():
                raise FileNotFoundError(
                    f"Layer '{lid}' path does not exist: {lpath} (resolved: {resolved})"
                )
            validated.append(
                LayerEntry(
                    id=lid,
                    path=lpath,
                    enabled=bool(item.get("enabled", True)),
                    pinned=bool(item.get("pinned", False)),
                    readonly=bool(item.get("readonly", False)),
                )
            )

        self.layers = validated
        self.save_layers_json()
        self.rebuild_constraint_maps()
        return self.get_layers_info()

    def get_solver_overlay_path(self) -> Path:
        for layer in self.layers:
            if layer.id == "solver":
                return self.resolve_layer_path(layer.path)
        return (self.workspace_root / "configs" / "solver_overlay.config").resolve()

    def write_solver_overlay(
        self,
        changes: list[tuple[str, str]] | dict[str, str],
        reset: bool = False,
    ) -> Path:
        """Merge newly resolved symbol changes into configs/solver_overlay.config."""
        overlay_path = self.get_solver_overlay_path()
        overlay_path.parent.mkdir(parents=True, exist_ok=True)

        merged: dict[str, str] = {}
        if not reset and overlay_path.is_file():
            merged.update(parse_config_fragment(overlay_path))

        items = changes.items() if isinstance(changes, dict) else changes
        for raw_sym, raw_val in items:
            sym = normalize_sym_name(raw_sym)
            merged[sym] = str(raw_val).strip()

        lines = ["# Auto-generated by kconfig-server (solver_overlay.config)"]
        for sym, val in merged.items():
            lines.append(format_config_line(sym, val))

        overlay_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return overlay_path

    def apply_layers(
        self,
        changes: list[tuple[str, str]] | dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Write solver overlay (if changes provided), run scripts/configure.sh, and verify .config."""
        applied_dict: dict[str, str] = {}
        if changes is not None:
            items = changes.items() if isinstance(changes, dict) else changes
            for raw_sym, raw_val in items:
                applied_dict[normalize_sym_name(raw_sym)] = str(raw_val).strip()
            self.write_solver_overlay(applied_dict)

        self.rebuild_constraint_maps()

        enabled_paths: list[str] = []
        for layer in self.layers:
            if not layer.enabled:
                continue
            fpath = self.resolve_layer_path(layer.path)
            if not fpath.is_file() and layer.id == "solver":
                self.write_solver_overlay({})
            if fpath.is_file():
                enabled_paths.append(str(fpath))

        configure_script = self.workspace_root / "scripts" / "configure.sh"
        if not configure_script.is_file():
            raise FileNotFoundError(
                f"Phase 1 configure.sh script not found at {configure_script}"
            )

        env = os.environ.copy()
        env["BASE_CONFIG"] = self.base_target
        env["KERNEL_DIR"] = str(self.kernel_dir)
        env["BUILD_DIR"] = str(self.build_dir)
        env["ARCH"] = self.arch
        env["KCONFIG_EXPLICIT_LAYERS"] = "1"

        cmd = [str(configure_script), *enabled_paths]
        proc = subprocess.run(
            cmd,
            cwd=str(self.workspace_root),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise ConfigureScriptError(
                f"scripts/configure.sh exited with code {proc.returncode}",
                returncode=proc.returncode,
                stdout=proc.stdout,
                stderr=proc.stderr,
            )

        combined_output = f"{proc.stdout}\n{proc.stderr}"
        configure_warnings: list[str] = []
        for line in combined_output.splitlines():
            line_s = line.strip()
            if _RE_MERGE_WARN.search(line_s):
                configure_warnings.append(line_s)

        verified, mismatches = self.verify_final_config(applied_dict)
        return {
            "verified": verified,
            "mismatches": mismatches,
            "configureWarnings": configure_warnings,
            "overlayPath": str(self.get_solver_overlay_path()),
        }

    def verify_final_config(
        self,
        applied_changes: dict[str, str] | None = None,
    ) -> tuple[bool, list[dict[str, str]]]:
        """Verify that build_dir/.config matches all pinned and newly applied symbols."""
        dot_config_path = self.build_dir / ".config"
        final_values = parse_config_fragment(dot_config_path)

        expected_map: dict[str, str] = {}
        for sym, pin_info in self.pinned_map.items():
            expected_map[sym] = pin_info.value
        if applied_changes:
            for sym, val in applied_changes.items():
                expected_map[normalize_sym_name(sym)] = val

        mismatches: list[dict[str, str]] = []
        for sym, expected_val in sorted(expected_map.items()):
            actual_val = final_values.get(sym, "n")
            if actual_val != expected_val:
                mismatches.append(
                    {
                        "symbol": sym,
                        "expected": expected_val,
                        "actual": actual_val,
                    }
                )

        return (len(mismatches) == 0, mismatches)
