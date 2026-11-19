"""Kbuild environment variable extraction and caching via GNU Make."""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ARCH_TO_SRCARCH: dict[str, str] = {
    "x86_64": "x86",
    "i386": "x86",
    "x86": "x86",
    "arm64": "arm64",
    "arm": "arm",
    "riscv": "riscv",
    "riscv64": "riscv",
    "powerpc": "powerpc",
    "ppc": "powerpc",
    "s390": "s390",
    "mips": "mips",
    "loongarch": "loongarch",
}

CACHE_FILENAME = ".kconfig_env_cache.json"


def map_arch_to_srcarch(arch: str) -> str:
    return ARCH_TO_SRCARCH.get(arch, arch)


def _get_git_head_sha(kernel_dir: Path) -> str:
    try:
        res = subprocess.run(
            ["git", "-C", str(kernel_dir), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return "no-git"


def _get_compiler_version(cc: str = "gcc") -> str:
    try:
        res = subprocess.run(
            [cc, "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if res.returncode == 0 and res.stdout:
            return res.stdout.splitlines()[0].strip()
    except Exception:
        pass
    return "unknown-cc"


def _default_fallback_env(kernel_dir: Path, build_dir: Path, arch: str) -> dict[str, str]:
    srcarch = map_arch_to_srcarch(arch)
    return {
        "srctree": str(kernel_dir),
        "objtree": str(build_dir),
        "ARCH": arch,
        "SRCARCH": srcarch,
        "KCONFIG_CONFIG": str(build_dir / ".config"),
        "KERNELVERSION": "6.0.0",
        "CC": "gcc",
        "LD": "ld",
        "AS": "as",
        "AR": "ar",
        "NM": "nm",
        "STRIP": "strip",
        "OBJCOPY": "objcopy",
        "OBJDUMP": "objdump",
        "HOSTCC": "gcc",
        "HOSTCXX": "g++",
        "SUBARCH": arch,
    }


def probe_kbuild_env(
    kernel_dir: Path,
    build_dir: Path,
    arch: str = "x86_64",
    use_make_probe: bool = True,
) -> dict[str, str]:
    """Extract Kbuild environment variables required by Linux Kconfig."""
    kernel_dir = kernel_dir.resolve()
    build_dir = build_dir.resolve()
    srcarch = map_arch_to_srcarch(arch)

    if not use_make_probe or not (kernel_dir / "Makefile").is_file():
        return _default_fallback_env(kernel_dir, build_dir, arch)

    cache_path = build_dir / CACHE_FILENAME
    cache_key = f"{_get_git_head_sha(kernel_dir)}::{arch}::{_get_compiler_version()}"

    if cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("cache_key") == cache_key and isinstance(cached.get("env"), dict):
                env_dict: dict[str, str] = {
                    str(k): str(v) for k, v in cached["env"].items()
                }
                env_dict["srctree"] = str(kernel_dir)
                env_dict["ARCH"] = arch
                env_dict["SRCARCH"] = srcarch
                env_dict["KCONFIG_CONFIG"] = str(build_dir / ".config")
                return env_dict
        except Exception as exc:
            logger.debug("Ignoring invalid Kconfig env cache: %s", exc)

    probe_makefile = (
        "include Makefile\n"
        "help-kconfig-env:\n"
        "\t@python3 -c 'import os, json; print(json.dumps(dict(os.environ)))'\n"
    )

    env_dict = _default_fallback_env(kernel_dir, build_dir, arch)
    try:
        proc = subprocess.run(
            [
                "make",
                "--no-print-directory",
                "-C",
                str(kernel_dir),
                f"ARCH={arch}",
                "-s",
                "-f",
                "-",
                "help-kconfig-env",
            ],
            input=probe_makefile,
            text=True,
            capture_output=True,
            check=True,
            timeout=30,
        )
        for line in reversed(proc.stdout.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    for k, v in parsed.items():
                        env_dict[str(k)] = str(v)
                    break
    except Exception as exc:
        logger.warning("Live make probe failed (%s); falling back to default env", exc)

    # Mandatory overrides
    env_dict["srctree"] = str(kernel_dir)
    env_dict["ARCH"] = arch
    env_dict["SRCARCH"] = srcarch
    env_dict["KCONFIG_CONFIG"] = str(build_dir / ".config")
    env_dict.setdefault("KERNELVERSION", "6.0.0")

    try:
        build_dir.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps({"cache_key": cache_key, "env": env_dict}, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.debug("Could not write Kconfig env cache: %s", exc)

    return env_dict
