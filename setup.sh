#!/usr/bin/env bash
set -euo pipefail

WS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${WS_ROOT}/scripts/env.sh"

CHECK_ONLY=0
INSTALL_DEPS=0
RUN_CONFIGURE=0
SETUP_BACKEND=0
SETUP_FRONTEND=0
KERNEL_SRC=""
USE_WORKTREE=0
WORKTREE_REF="HEAD"
CLONE_DEPTH=""
CLONE_BRANCH=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Setup script for the Linux Kernel VSCode Development Foundation (Parent Workspace).

Options:
  --check-only              Only verify host prerequisites and workspace directories.
  --install-deps            Install required packages via apt-get (Debian/Ubuntu).
  --kernel-src <PATH|URL>   Provision ${KERNEL_DIR} from a local path (symlink/worktree)
                            or clone from a remote Git URL.
  --worktree [REF]          When --kernel-src is a local Git repo, create a git worktree
                            at ${KERNEL_DIR} (default ref: HEAD) instead of a symlink.
  --branch <BRANCH>         Branch or tag to clone when --kernel-src is a remote URL.
  --depth <N>               Shallow clone depth when cloning from a remote URL.
  --configure               Run scripts/configure.sh after verifying kernel tree & tools.
  --setup-backend           Create backend/.venv and install the Kconfig Python backend.
  --setup-frontend          Install npm packages and build the VSCode extension frontend.
  -h, --help                Show this help message.

Examples:
  # Check host prerequisites and initialize build/shared directories
  ./setup.sh

  # Link an existing local Linux kernel repository into ./linux and configure it
  ./setup.sh --kernel-src ~/src/linux --configure

  # Create a git worktree at ./linux from an existing local repo
  ./setup.sh --kernel-src ~/src/linux --worktree v6.12 --configure

  # Shallow-clone mainline Linux and run initial configuration
  ./setup.sh --kernel-src https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git --depth 1 --configure
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --install-deps)
      INSTALL_DEPS=1
      shift
      ;;
    --configure)
      RUN_CONFIGURE=1
      shift
      ;;
    --setup-backend)
      SETUP_BACKEND=1
      shift
      ;;
    --setup-frontend)
      SETUP_FRONTEND=1
      shift
      ;;
    --kernel-src)
      KERNEL_SRC="${2:-}"
      if [ -z "${KERNEL_SRC}" ]; then
        echo "Error: --kernel-src requires a PATH or URL argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --worktree)
      USE_WORKTREE=1
      if [ $# -ge 2 ] && [[ "${2}" != --* ]]; then
        WORKTREE_REF="${2}"
        shift 2
      else
        shift
      fi
      ;;
    --branch)
      CLONE_BRANCH="${2:-}"
      shift 2
      ;;
    --depth)
      CLONE_DEPTH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "${INSTALL_DEPS}" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "==> Installing host prerequisites via apt-get..."
    sudo apt-get update
    sudo apt-get install -y \
      build-essential bc bison flex libelf-dev libssl-dev \
      python3 python3-venv python3-pip cpio gzip clangd busybox-static qemu-system-x86
  else
    echo "Error: --install-deps currently supports apt-get (Debian/Ubuntu)." >&2
    echo "Please install the required packages listed in README.md manually." >&2
    exit 1
  fi
fi

echo "==> [1/4] Checking Host Prerequisites"
MISSING_TOOLS=()
WARNINGS=()

for cmd in make bc bison flex python3 cpio gzip; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    MISSING_TOOLS+=("${cmd}")
  fi
done

if ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
  MISSING_TOOLS+=("gcc (or clang)")
fi

if [ ! -f /usr/include/gelf.h ] && [ ! -f /usr/include/libelf.h ]; then
  MISSING_TOOLS+=("libelf-dev")
fi

if [ ! -d /usr/include/openssl ]; then
  MISSING_TOOLS+=("libssl-dev")
fi

if ! command -v clangd >/dev/null 2>&1; then
  WARNINGS+=("clangd is not installed (recommended for VSCode LSP & #ifdef dimming).")
else
  CLANGD_VER="$(clangd --version 2>/dev/null | head -n1 || true)"
  echo "    [OK] clangd: ${CLANGD_VER}"
fi

# Re-resolve BUSYBOX_BIN in case it was just installed
BUSYBOX_BIN="${BUSYBOX_BIN:-$(command -v busybox 2>/dev/null || true)}"
if [ -z "${BUSYBOX_BIN}" ] || [ ! -x "${BUSYBOX_BIN}" ]; then
  MISSING_TOOLS+=("busybox-static")
else
  LDD_OUT="$(LC_ALL=C ldd "${BUSYBOX_BIN}" 2>&1 || true)"
  if [[ "${LDD_OUT}" != *"not a dynamic executable"* ]] && [[ "${LDD_OUT}" != *"statically linked"* ]]; then
    MISSING_TOOLS+=("busybox-static (${BUSYBOX_BIN} is dynamically linked)")
  else
    echo "    [OK] busybox (static): ${BUSYBOX_BIN}"
  fi
fi

if ! command -v "${QEMU_BIN}" >/dev/null 2>&1; then
  MISSING_TOOLS+=("${QEMU_BIN}")
else
  echo "    [OK] QEMU: $(command -v "${QEMU_BIN}")"
fi

if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  echo "    [OK] KVM acceleration: /dev/kvm is accessible"
else
  WARNINGS+=("/dev/kvm is not readable/writable; QEMU will fall back to TCG software emulation.")
fi

if [ ${#WARNINGS[@]} -gt 0 ]; then
  for w in "${WARNINGS[@]}"; do
    echo "    [WARN] ${w}"
  done
fi

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
  echo "    [ERROR] Missing required tools/libraries:" >&2
  for t in "${MISSING_TOOLS[@]}"; do
    echo "      - ${t}" >&2
  done
  echo "    Hint: Run './setup.sh --install-deps' on Debian/Ubuntu or install them with your package manager." >&2
  if [ "${CHECK_ONLY}" -eq 1 ]; then
    exit 1
  fi
else
  echo "    [OK] All required build, initramfs, and QEMU tools are available."
fi

echo "==> [2/4] Preparing Workspace Directories & Initial .clangd"
mkdir -p "${BUILD_DIR}" "${SHARED_DIR}" "${BUILD_DIR}/user_injected" "${WS_ROOT}/scripts" "${WS_ROOT}/.vscode"

if [ ! -f "${WS_ROOT}/.clangd" ]; then
  sed \
    -e "s|@BUILD_DIR@|${BUILD_DIR}|g" \
    -e "s|@KERNEL_DIR@|${KERNEL_DIR}|g" \
    -e "s|@WS_ROOT@|${WS_ROOT}|g" \
    "${WS_ROOT}/scripts/clangd.template" > "${WS_ROOT}/.clangd"
  echo "    [OK] Materialized initial ${WS_ROOT}/.clangd"
else
  echo "    [OK] ${WS_ROOT}/.clangd already exists"
fi

if [ "${CHECK_ONLY}" -eq 1 ]; then
  echo "==> Check completed."
  exit 0
fi

echo "==> [3/4] Checking Linux Kernel Source Tree (${KERNEL_DIR})"
if [ -n "${KERNEL_SRC}" ]; then
  if [ -e "${KERNEL_DIR}" ]; then
    echo "    [SKIP] ${KERNEL_DIR} already exists; skipping provisioning from ${KERNEL_SRC}."
  elif [ -d "${KERNEL_SRC}" ]; then
    SRC_ABS="$(cd "${KERNEL_SRC}" && pwd)"
    if [ "${USE_WORKTREE}" -eq 1 ]; then
      echo "    Creating git worktree at ${KERNEL_DIR} from ${SRC_ABS} (${WORKTREE_REF})..."
      git -C "${SRC_ABS}" worktree add --detach "${KERNEL_DIR}" "${WORKTREE_REF}"
    else
      echo "    Creating symlink ${KERNEL_DIR} -> ${SRC_ABS}..."
      ln -s "${SRC_ABS}" "${KERNEL_DIR}"
    fi
  else
    echo "    Cloning Linux kernel from ${KERNEL_SRC} into ${KERNEL_DIR}..."
    CLONE_ARGS=()
    if [ -n "${CLONE_BRANCH}" ]; then
      CLONE_ARGS+=("--branch" "${CLONE_BRANCH}")
    fi
    if [ -n "${CLONE_DEPTH}" ]; then
      CLONE_ARGS+=("--depth" "${CLONE_DEPTH}")
    fi
    git clone "${CLONE_ARGS[@]}" "${KERNEL_SRC}" "${KERNEL_DIR}"
  fi
fi

if [ -d "${KERNEL_DIR}" ] && [ -f "${KERNEL_DIR}/Makefile" ]; then
  echo "    [OK] Linux kernel source tree found at ${KERNEL_DIR}"
else
  echo "    [INFO] Linux kernel source tree is not yet present at ${KERNEL_DIR}."
  echo "           Provide one via:"
  echo "             - Symlink:  ./setup.sh --kernel-src /path/to/linux"
  echo "             - Worktree: ./setup.sh --kernel-src /path/to/linux --worktree"
  echo "             - Clone:    ./setup.sh --kernel-src https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git --depth 1"
fi

echo "==> [4/4] Initial Kernel Configuration"
if [ "${RUN_CONFIGURE}" -eq 1 ]; then
  if [ ! -f "${KERNEL_DIR}/Makefile" ]; then
    echo "Error: Cannot run --configure because ${KERNEL_DIR}/Makefile does not exist." >&2
    exit 1
  fi
  "${WS_ROOT}/scripts/configure.sh"
else
  echo "    [INFO] Skipping kernel configuration (pass --configure or run ./scripts/configure.sh when ready)."
fi

if [ "${SETUP_BACKEND}" -eq 1 ]; then
  echo "==> Setting up Kconfig Python Backend"
  "${WS_ROOT}/scripts/setup_kconfig_backend.sh"
fi

if [ "${SETUP_FRONTEND}" -eq 1 ]; then
  echo "==> Setting up Kconfig VSCode Extension Frontend"
  "${WS_ROOT}/scripts/setup_kconfig_frontend.sh"
fi

echo "==> Setup complete!"
