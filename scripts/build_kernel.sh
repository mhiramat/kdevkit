#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

if [ ! -f "${BUILD_DIR}/.config" ]; then
  echo "Error: ${BUILD_DIR}/.config not found." >&2
  echo "Hint: Run ./scripts/configure.sh first." >&2
  exit 1
fi

EXTRA_MAKE_ARGS=()
if [ -n "${LLVM:-}" ]; then
  EXTRA_MAKE_ARGS+=("LLVM=${LLVM}")
fi
if [ -n "${MAKE_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_MAKE_ARGS+=(${MAKE_ARGS})
fi

echo "==> [1/2] Building kernel (bzImage) and modules in ${BUILD_DIR}"
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" "${EXTRA_MAKE_ARGS[@]}" -j"$(nproc)" bzImage modules

echo "==> [2/2] Generating compile_commands.json for clangd"
python3 "${KERNEL_DIR}/scripts/clang-tools/gen_compile_commands.py" \
  -d "${BUILD_DIR}" \
  -o "${BUILD_DIR}/compile_commands.json"

echo "==> Build complete."
echo "    bzImage:               ${BUILD_DIR}/arch/x86/boot/bzImage"
echo "    vmlinux:               ${BUILD_DIR}/vmlinux"
echo "    compile_commands.json: ${BUILD_DIR}/compile_commands.json"
