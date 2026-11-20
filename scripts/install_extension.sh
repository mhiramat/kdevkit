#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

EXT_DIR="${WS_ROOT}/extension"
PKG_JSON="${EXT_DIR}/package.json"

BUILD_FIRST=0
UNINSTALL=0
TARGET_DIRS=()

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install (or overwrite) the VSCode / Antigravity extension symlink so it points
to the current workspace's extension/ directory (${EXT_DIR}).
Useful both on initial setup and after renaming or moving the workspace directory.

Options:
  --build              Build the extension bundle (npm run build) before linking.
  --target-dir <DIR>   Explicitly install into <DIR> (can be specified multiple times).
                       By default, installs into existing editor extension directories
                       (~/.vscode/extensions, ~/.antigravity/extensions, ~/.antigravity-ide/extensions).
  --uninstall          Remove the extension symlink(s) from editor extension directories.
  -h, --help           Show this help message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --build)
      BUILD_FIRST=1
      shift
      ;;
    --target-dir)
      if [ -z "${2:-}" ]; then
        echo "Error: --target-dir requires a directory path." >&2
        exit 1
      fi
      TARGET_DIRS+=("$2")
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
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

if [ ! -f "${PKG_JSON}" ]; then
  echo "Error: Extension package.json not found at ${PKG_JSON}" >&2
  exit 1
fi

EXT_ID="$(node -p 'const p = require(process.argv[1]); `${p.publisher}.${p.name}-${p.version}`' "${PKG_JSON}")"

if [ ${#TARGET_DIRS[@]} -eq 0 ]; then
  for cand in \
    "${HOME}/.vscode/extensions" \
    "${HOME}/.antigravity/extensions" \
    "${HOME}/.antigravity-ide/extensions"; do
    if [ -d "${cand}" ] || [ -d "$(dirname "${cand}")" ]; then
      TARGET_DIRS+=("${cand}")
    fi
  done
  if [ ${#TARGET_DIRS[@]} -eq 0 ]; then
    TARGET_DIRS+=("${HOME}/.vscode/extensions")
  fi
fi

if [ "${UNINSTALL}" -eq 1 ]; then
  for dir in "${TARGET_DIRS[@]}"; do
    link_path="${dir}/${EXT_ID}"
    if [ -L "${link_path}" ] || [ -e "${link_path}" ]; then
      rm -rf "${link_path}"
      echo "    [REMOVED] ${link_path}"
    fi
  done
  exit 0
fi

if [ "${BUILD_FIRST}" -eq 1 ] || [ ! -f "${EXT_DIR}/dist/extension.js" ]; then
  echo "==> Building extension bundle in ${EXT_DIR}"
  if [ ! -d "${EXT_DIR}/node_modules" ]; then
    (cd "${EXT_DIR}" && npm install)
  fi
  (cd "${EXT_DIR}" && npm run build)
fi

echo "==> Linking ${EXT_ID} -> ${EXT_DIR}"
for dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "${dir}"
  # Remove any stale symlinks or older versions of this extension
  for old in "${dir}/${EXT_ID%-*}"-*; do
    if [ -L "${old}" ] && [ "${old}" != "${dir}/${EXT_ID}" ]; then
      rm -f "${old}"
    fi
  done
  link_path="${dir}/${EXT_ID}"
  if [ -d "${link_path}" ] && [ ! -L "${link_path}" ]; then
    rm -rf "${link_path}"
  fi
  ln -sfn "${EXT_DIR}" "${link_path}"
  echo "    [OK] ${link_path} -> $(readlink "${link_path}")"
done

echo "==> Extension link updated. Run 'Developer: Reload Window' in VSCode / Antigravity to apply."
