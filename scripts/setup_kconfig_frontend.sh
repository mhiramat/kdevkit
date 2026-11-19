#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

EXT_DIR="${WS_ROOT}/extension"
RUN_TESTS=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Setup script for the VSCode Kconfig Editor Frontend (extension/).

Options:
  --test        Run typecheck, build, unit tests, and Python IPC integration tests.
  -h, --help    Show this help message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --test)
      RUN_TESTS=1
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

echo "==> [1/3] Checking Node.js and npm prerequisites"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Error: Node.js and npm are required to build the VSCode extension." >&2
  exit 1
fi
echo "    [OK] Node $(node -v), npm $(npm -v)"

echo "==> [2/3] Installing npm dependencies in ${EXT_DIR}"
(
  cd "${EXT_DIR}"
  npm install
)

echo "==> [3/3] Typechecking and building extension & webview bundles"
(
  cd "${EXT_DIR}"
  npm run typecheck
  npm run build
)

if [ "${RUN_TESTS}" -eq 1 ]; then
  echo "==> Running frontend unit & Python IPC integration tests..."
  (
    cd "${EXT_DIR}"
    npm run test:unit
    npm run test:ipc
  )
fi

echo "==> Kconfig frontend setup complete!"
