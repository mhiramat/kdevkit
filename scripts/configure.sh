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

USER_CONFIGS=()
for arg in "$@"; do
  if [ -n "${arg}" ]; then
    if [[ "${arg}" = /* ]]; then
      CFG_PATH="${arg}"
    else
      CFG_PATH="${WS_ROOT}/${arg}"
    fi
    if [ ! -f "${CFG_PATH}" ]; then
      echo "Error: User config fragment not found: ${CFG_PATH}" >&2
      exit 1
    fi
    USER_CONFIGS+=("${CFG_PATH}")
  fi
done

if [ ${#USER_CONFIGS[@]} -eq 0 ] && [ -f "${WS_ROOT}/configs/user.config" ]; then
  USER_CONFIGS+=("${WS_ROOT}/configs/user.config")
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
    "${WS_ROOT}/configs/qemu.config" \
    "${WS_ROOT}/configs/trace.config" \
    "${USER_CONFIGS[@]}"
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
