#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

if [ ! -d "${KERNEL_DIR}" ] || [ ! -f "${KERNEL_DIR}/Makefile" ]; then
  echo "Error: Linux kernel source tree not found at ${KERNEL_DIR}" >&2
  echo "Hint: Run ./setup.sh or clone/link a kernel tree into ${KERNEL_DIR}" >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}" "${SHARED_DIR}"

PASSED_CONFIGS=()
EXPLICIT_LAYER_LIST="${KCONFIG_EXPLICIT_LAYERS:-0}"
for arg in "$@"; do
  if [ -n "${arg}" ]; then
    if [[ "${arg}" = /* ]]; then
      CFG_PATH="${arg}"
    else
      CFG_PATH="${WS_ROOT}/${arg}"
    fi
    if [ ! -f "${CFG_PATH}" ]; then
      echo "Error: Config fragment not found: ${CFG_PATH}" >&2
      exit 1
    fi
    if [[ "${CFG_PATH}" == */configs/qemu.config ]] || \
       [[ "${CFG_PATH}" == */configs/trace.config ]] || \
       [[ "${CFG_PATH}" == */configs/solver_overlay.config ]]; then
      EXPLICIT_LAYER_LIST=1
    fi
    PASSED_CONFIGS+=("${CFG_PATH}")
  fi
done

if [ "${EXPLICIT_LAYER_LIST}" -eq 1 ]; then
  MERGE_FRAGMENTS=("${PASSED_CONFIGS[@]}")
elif [ ${#PASSED_CONFIGS[@]} -gt 0 ]; then
  MERGE_FRAGMENTS=(
    "${WS_ROOT}/configs/qemu.config"
    "${WS_ROOT}/configs/trace.config"
    "${PASSED_CONFIGS[@]}"
  )
elif [ -f "${WS_ROOT}/configs/layers.json" ] && command -v python3 >/dev/null 2>&1; then
  if [ -z "${BASE_CONFIG_OVERRIDDEN:-}" ]; then
    LAYERS_BASE="$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print(data.get("base_target") or data.get("baseTarget") or "defconfig")
' "${WS_ROOT}/configs/layers.json" 2>/dev/null || echo "${BASE_CONFIG}")"
    BASE_CONFIG="${LAYERS_BASE}"
  fi
  mapfile -t MERGE_FRAGMENTS < <(python3 -c '
import json, os, sys
ws = sys.argv[1]
data = json.load(open(sys.argv[2], encoding="utf-8"))
for layer in data.get("layers", []):
    if layer.get("enabled", True):
        p = layer["path"]
        full = p if os.path.isabs(p) else os.path.join(ws, p)
        if os.path.isfile(full):
            print(full)
' "${WS_ROOT}" "${WS_ROOT}/configs/layers.json")
  if [ -f "${WS_ROOT}/configs/user.config" ]; then
    MERGE_FRAGMENTS+=("${WS_ROOT}/configs/user.config")
  fi
else
  MERGE_FRAGMENTS=(
    "${WS_ROOT}/configs/qemu.config"
    "${WS_ROOT}/configs/trace.config"
  )
  if [ -f "${WS_ROOT}/configs/user.config" ]; then
    MERGE_FRAGMENTS+=("${WS_ROOT}/configs/user.config")
  fi
  if [ -f "${WS_ROOT}/configs/solver_overlay.config" ]; then
    MERGE_FRAGMENTS+=("${WS_ROOT}/configs/solver_overlay.config")
  fi
fi

EXTRA_MAKE_ARGS=()
if [ -n "${LLVM:-}" ]; then
  EXTRA_MAKE_ARGS+=("LLVM=${LLVM}")
fi
if [ -n "${MAKE_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_MAKE_ARGS+=(${MAKE_ARGS})
fi

echo "==> [1/4] Generating base config (${BASE_CONFIG}) in ${BUILD_DIR}"
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" "${EXTRA_MAKE_ARGS[@]}" "${BASE_CONFIG}"

echo "==> [2/4] Merging layered Kconfig fragments"
(
  cd "${KERNEL_DIR}"
  ./scripts/kconfig/merge_config.sh -m -O "${BUILD_DIR}" \
    "${BUILD_DIR}/.config" \
    "${MERGE_FRAGMENTS[@]}"
)

echo "==> [3/4] Running olddefconfig and syncconfig (updating autoconf.h)"
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" "${EXTRA_MAKE_ARGS[@]}" olddefconfig
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" "${EXTRA_MAKE_ARGS[@]}" syncconfig

echo "==> [4/4] Generating ${WS_ROOT}/.clangd from scripts/clangd.template"
sed \
  -e "s|@BUILD_DIR@|${BUILD_DIR}|g" \
  -e "s|@KERNEL_DIR@|${KERNEL_DIR}|g" \
  -e "s|@WS_ROOT@|${WS_ROOT}|g" \
  "${WS_ROOT}/scripts/clangd.template" > "${WS_ROOT}/.clangd"

echo "==> Configuration complete."
echo "    .config:    ${BUILD_DIR}/.config"
echo "    autoconf.h: ${BUILD_DIR}/include/generated/autoconf.h"
echo "    .clangd:    ${WS_ROOT}/.clangd"
echo "    Tip: Run 'clangd: Restart language server' in VSCode to refresh #ifdef regions."
