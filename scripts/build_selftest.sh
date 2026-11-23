#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

usage() {
  cat << 'EOF'
Usage: scripts/build_selftest.sh [--link-mode auto-libs|static] <target> [target...]

Builds and installs the specified Linux kselftest target(s) out-of-tree into:
  ${SHARED_DIR}/kselftest/
Intermediate objects are placed in:
  ${BUILD_DIR}/kselftest-obj/
so ${KERNEL_DIR} remains completely clean.

Environment overrides:
  SELFTEST_LINK_MODE   auto-libs (default) or static
  SELFTEST_TARGETS     Space-separated targets if none passed on CLI
  SELFTEST_MAKE_ARGS   Extra arguments passed to make
EOF
}

LINK_MODE="${SELFTEST_LINK_MODE:-auto-libs}"
CLI_TARGETS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --link-mode)
      if [ $# -lt 2 ]; then
        echo "Error: --link-mode requires an argument (auto-libs|static)." >&2
        exit 1
      fi
      LINK_MODE="$2"
      shift 2
      ;;
    --link-mode=*)
      LINK_MODE="${1#*=}"
      shift
      ;;
    *)
      CLI_TARGETS+=("$1")
      shift
      ;;
  esac
done

if [ "${#CLI_TARGETS[@]}" -eq 0 ] && [ -n "${SELFTEST_TARGETS:-}" ]; then
  # shellcheck disable=SC2206
  CLI_TARGETS=(${SELFTEST_TARGETS})
fi

if [ "${#CLI_TARGETS[@]}" -eq 0 ]; then
  echo "Error: No kselftest targets specified." >&2
  usage >&2
  exit 1
fi

if [ "${LINK_MODE}" != "auto-libs" ] && [ "${LINK_MODE}" != "static" ]; then
  echo "Error: Invalid SELFTEST_LINK_MODE='${LINK_MODE}' (expected 'auto-libs' or 'static')." >&2
  exit 1
fi

if [ ! -d "${KERNEL_DIR}/tools/testing/selftests" ]; then
  echo "Error: kselftest directory not found at ${KERNEL_DIR}/tools/testing/selftests" >&2
  exit 1
fi

TARGETS_STR="${CLI_TARGETS[*]}"
if [ "${LINK_MODE}" = "static" ]; then
  OBJ_DIR="${BUILD_DIR}/kselftest-obj-static"
else
  OBJ_DIR="${BUILD_DIR}/kselftest-obj"
fi
INSTALL_DIR="${SHARED_DIR}/kselftest"
LIBS_DIR="${SHARED_DIR}/kselftest-libs"
HEADERS_DIR="${BUILD_DIR}/usr/include"

mkdir -p "${OBJ_DIR}" "${INSTALL_DIR}"

if [ ! -d "${HEADERS_DIR}/linux" ]; then
  echo "==> [1/3] Installing kernel UAPI headers to ${BUILD_DIR}/usr"
  make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" headers_install
else
  echo "==> [1/3] Using existing kernel UAPI headers in ${HEADERS_DIR}"
fi

echo "==> [2/3] Building & installing kselftest targets: ${TARGETS_STR} (mode=${LINK_MODE})"
EXTRA_LINK_ARGS=()
if [ "${LINK_MODE}" = "static" ]; then
  EXTRA_LINK_ARGS+=("LDFLAGS=-static" "EXTRA_LDFLAGS=-static")
fi

# shellcheck disable=SC2086
make -C "${KERNEL_DIR}/tools/testing/selftests" \
  O="${OBJ_DIR}" \
  ARCH="${ARCH}" \
  TARGETS="${TARGETS_STR}" \
  INSTALL_PATH="${INSTALL_DIR}" \
  KHDR_INCLUDES="-I${HEADERS_DIR}" \
  "${EXTRA_LINK_ARGS[@]}" \
  ${SELFTEST_MAKE_ARGS:-} \
  install

echo "==> [3/3] Scanning installed ELF binaries for shared library dependencies"
rm -rf "${LIBS_DIR}"
mkdir -p "${LIBS_DIR}"

MANIFEST_FILE="${LIBS_DIR}/manifest.txt"
: > "${MANIFEST_FILE}"

is_elf_file() {
  local f="$1"
  local magic
  magic="$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  [ "${magic}" = "7f454c46" ]
}

declare -A COPIED_LIBS=()
declare -A LIB_DIRS=()
INTERP_PATHS=()
DYNAMIC_COUNT=0
STATIC_COUNT=0

copy_lib_entry() {
  local src="$1"
  if [ -z "${src}" ] || [ ! -e "${src}" ]; then
    return 0
  fi
  if [ -n "${COPIED_LIBS[${src}]:-}" ]; then
    return 0
  fi
  COPIED_LIBS["${src}"]=1

  local rel="${src#/}"
  local dest="${LIBS_DIR}/${rel}"
  mkdir -p "$(dirname "${dest}")"
  cp -L "${src}" "${dest}"
  chmod 0755 "${dest}" 2>/dev/null || true

  local dir_rel
  dir_rel="$(dirname "${rel}")"
  LIB_DIRS["${dir_rel}"]=1
}

while IFS= read -r -d '' bin_file; do
  if ! is_elf_file "${bin_file}"; then
    continue
  fi

  ldd_out="$(LC_ALL=C ldd "${bin_file}" 2>&1 || true)"
  if [[ "${ldd_out}" == *"not a dynamic executable"* ]] || [[ "${ldd_out}" == *"statically linked"* ]]; then
    STATIC_COUNT=$((STATIC_COUNT + 1))
    continue
  fi

  DYNAMIC_COUNT=$((DYNAMIC_COUNT + 1))
  if [ "${LINK_MODE}" = "static" ]; then
    echo "Warning: ${bin_file} remained dynamically linked despite static mode; falling back to auto-libs collection." >&2
  fi

  # Extract dynamic interpreter if present
  interp="$(readelf -l "${bin_file}" 2>/dev/null | sed -n 's/.*Requesting program interpreter: \(.*\)\]/\1/p' | head -n 1 || true)"
  if [ -n "${interp}" ] && [ -e "${interp}" ]; then
    copy_lib_entry "${interp}"
    INTERP_PATHS+=("${interp}")
  fi

  # Extract resolved shared libraries from ldd output
  while IFS= read -r line; do
    case "${line}" in
      *linux-vdso.so*|*"not found"*)
        continue
        ;;
    esac
    lib_path=""
    if [[ "${line}" == *"=>"* ]]; then
      lib_path="$(printf '%s\n' "${line}" | awk -F'=>' '{print $2}' | awk '{print $1}')"
    else
      lib_path="$(printf '%s\n' "${line}" | awk '{print $1}')"
    fi
    if [[ "${lib_path}" == /* ]] && [ -e "${lib_path}" ]; then
      copy_lib_entry "${lib_path}"
    fi
  done <<< "${ldd_out}"
done < <(find "${INSTALL_DIR}" -type f -perm /111 -print0)

{
  echo "# Generated by scripts/build_selftest.sh"
  echo "link_mode=${LINK_MODE}"
  echo "targets=${TARGETS_STR}"
  echo "static_elf_count=${STATIC_COUNT}"
  echo "dynamic_elf_count=${DYNAMIC_COUNT}"
  for interp in "${INTERP_PATHS[@]}"; do
    echo "interp=${interp}"
  done | sort -u
  for dir_rel in "${!LIB_DIRS[@]}"; do
    echo "libdir=/${dir_rel}"
  done | sort -u
} > "${MANIFEST_FILE}"

echo "==> kselftest staging complete:"
echo "    Install dir: ${INSTALL_DIR}"
echo "    Libs dir:    ${LIBS_DIR} (static=${STATIC_COUNT}, dynamic=${DYNAMIC_COUNT}, libs=${#COPIED_LIBS[@]})"
