#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

CHECK_ONLY=0
FORWARD_ARGS=()
HAS_SETTINGS_FLAG=0
HAS_PROMPTS_FLAG=0
HAS_PROJECT_FLAG=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--check] [SASHIKO REVIEW OPTIONS...] [COMMIT_OR_RANGE]

Parent-workspace wrapper around 'sashiko review' that executes inside
${KERNEL_DIR} without polluting the Linux kernel tree.

Wrapper Options:
  --check       Inspect Sashiko readiness and print the active review mode:
                  MODE=cli       Sashiko CLI binary + explicit API/provider ready
                  MODE=subagent  Prompts ready; use subagent prompt-based review
                Exits non-zero if Sashiko is not cloned yet.
  -h, --help    Show this help message (use '-- --help' for sashiko review help).

Examples:
  # Check which review mode is active (cli vs subagent)
  ./scripts/run_sashiko.sh --check

  # Dry-run patch extraction and config validation without LLM calls
  ./scripts/run_sashiko.sh --no-ai --agent HEAD~1..HEAD

  # Fast iterative agent review of the last 3 commits in linux/
  ./scripts/run_sashiko.sh --agent --cheap HEAD~3..HEAD

  # Full pre-submission review with experimental series design assessment
  ./scripts/run_sashiko.sh --agent --design origin/master..HEAD
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        FORWARD_ARGS+=("$1")
        shift
      done
      ;;
    --settings)
      HAS_SETTINGS_FLAG=1
      FORWARD_ARGS+=("$1")
      if [ $# -ge 2 ]; then
        FORWARD_ARGS+=("$2")
        shift 2
      else
        shift
      fi
      ;;
    --settings=*)
      HAS_SETTINGS_FLAG=1
      FORWARD_ARGS+=("$1")
      shift
      ;;
    --prompts)
      HAS_PROMPTS_FLAG=1
      FORWARD_ARGS+=("$1")
      if [ $# -ge 2 ]; then
        FORWARD_ARGS+=("$2")
        shift 2
      else
        shift
      fi
      ;;
    --prompts=*)
      HAS_PROMPTS_FLAG=1
      FORWARD_ARGS+=("$1")
      shift
      ;;
    --project)
      HAS_PROJECT_FLAG=1
      FORWARD_ARGS+=("$1")
      if [ $# -ge 2 ]; then
        FORWARD_ARGS+=("$2")
        shift 2
      else
        shift
      fi
      ;;
    --project=*)
      HAS_PROJECT_FLAG=1
      FORWARD_ARGS+=("$1")
      shift
      ;;
    *)
      FORWARD_ARGS+=("$1")
      shift
      ;;
  esac
done

PROMPTS_DIR="${SASHIKO_DIR}/projects/linux/prompts"

resolve_config_file() {
  if [ -f "${SASHIKO_CONFIG}" ]; then
    echo "${SASHIKO_CONFIG}"
    return 0
  fi
  local xdg_cfg="${XDG_CONFIG_HOME:-${HOME}/.config}/sashiko.toml"
  if [ -f "${xdg_cfg}" ]; then
    echo "${xdg_cfg}"
    return 0
  fi
  return 1
}

config_provider_ready() {
  local cfg="$1"
  local prov
  prov="$(awk -F= '/^[[:space:]]*provider[[:space:]]*=/{gsub(/["[:space:]]/, "", $2); print $2; exit}' "${cfg}" || true)"
  case "${prov}" in
    ""|gemini)
      if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${LLM_API_KEY:-}" ] || \
         [ -n "${GEMINI_PROXY_COMMAND:-}" ] || [ -n "${GEMINI_AUTH_TOKEN:-}" ] || \
         [ -n "${GEMINI_AUTH_TOKEN_COMMAND:-}" ] || [ -n "${GOOGLE_GEMINI_BASE_URL:-}" ] || \
         [ -n "${GEMINI_BASE_URL:-}" ]; then
        return 0
      fi
      if grep -Eq '^[[:space:]]*(proxy_command|base_url|auth_token_command)[[:space:]]*=' "${cfg}"; then
        return 0
      fi
      return 1
      ;;
    claude)
      if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${LLM_API_KEY:-}" ] || \
         grep -Eq '^[[:space:]]*base_url[[:space:]]*=' "${cfg}"; then
        return 0
      fi
      return 1
      ;;
    claude-cli)
      command -v claude >/dev/null 2>&1
      ;;
    copilot-cli)
      command -v copilot >/dev/null 2>&1
      ;;
    codex-cli)
      command -v codex >/dev/null 2>&1
      ;;
    kiro-cli)
      command -v kiro-cli >/dev/null 2>&1
      ;;
    goose)
      command -v goose >/dev/null 2>&1
      ;;
    devin-cli)
      command -v devin >/dev/null 2>&1
      ;;
    *)
      # Explicit user-configured provider (vertex, bedrock, ollama, vllm, openai, etc.)
      return 0
      ;;
  esac
}

if [ "${CHECK_ONLY}" -eq 1 ]; then
  if [ ! -d "${PROMPTS_DIR}" ]; then
    echo "MODE=missing"
    echo "REASON=Sashiko repository is not cloned at ${SASHIKO_DIR}. Run './setup.sh --with-sashiko'."
    exit 2
  fi

  if [ ! -x "${SASHIKO_BIN}" ]; then
    echo "MODE=subagent"
    echo "PROMPTS=${PROMPTS_DIR}"
    echo "REASON=Sashiko binary is not built at ${SASHIKO_BIN}; using subagent prompt-based review."
    exit 0
  fi

  ACTIVE_CFG=""
  if ACTIVE_CFG="$(resolve_config_file)"; then
    if config_provider_ready "${ACTIVE_CFG}"; then
      echo "MODE=cli"
      echo "BIN=${SASHIKO_BIN}"
      echo "CONFIG=${ACTIVE_CFG}"
      echo "PROMPTS=${PROMPTS_DIR}"
      exit 0
    else
      echo "MODE=subagent"
      echo "BIN=${SASHIKO_BIN}"
      echo "CONFIG=${ACTIVE_CFG}"
      echo "PROMPTS=${PROMPTS_DIR}"
      echo "REASON=Config ${ACTIVE_CFG} exists but provider credentials/CLI are not ready; using subagent prompt-based review."
      exit 0
    fi
  fi

  if [ -n "${LLM_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ] || \
     [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ] || \
     [ -n "${SASHIKO__AI__PROVIDER:-}" ] || [ -n "${GEMINI_PROXY_COMMAND:-}" ]; then
    echo "MODE=cli"
    echo "BIN=${SASHIKO_BIN}"
    echo "CONFIG=(env)"
    echo "PROMPTS=${PROMPTS_DIR}"
    exit 0
  fi

  echo "MODE=subagent"
  echo "BIN=${SASHIKO_BIN}"
  echo "PROMPTS=${PROMPTS_DIR}"
  echo "REASON=No explicit Sashiko API/provider configured; defaulting to subagent prompt-based review."
  exit 0
fi

if [ ! -x "${SASHIKO_BIN}" ]; then
  echo "Error: Sashiko binary not found at ${SASHIKO_BIN}." >&2
  echo "Hint: Run './setup.sh --with-sashiko' to clone and build Sashiko." >&2
  exit 1
fi

if [ ! -d "${KERNEL_DIR}" ]; then
  echo "Error: Linux kernel tree not found at ${KERNEL_DIR}." >&2
  exit 1
fi

GLOBAL_FLAGS=()
if [ "${HAS_PROJECT_FLAG}" -eq 0 ]; then
  GLOBAL_FLAGS+=("--project" "linux")
fi

REVIEW_FLAGS=()
if [ "${HAS_SETTINGS_FLAG}" -eq 0 ]; then
  if ACTIVE_CFG="$(resolve_config_file)"; then
    REVIEW_FLAGS+=("--settings" "${ACTIVE_CFG}")
  else
    # env.sh defaults SASHIKO_CONFIG to .kdev/sashiko.toml even before it exists;
    # fall back to Sashiko's minimal example config for --no-ai dry-runs or
    # env-var-only configurations (LLM_API_KEY / SASHIKO__AI__*).
    unset SASHIKO_CONFIG
    if [ -f "${SASHIKO_DIR}/docs/examples/Settings.example.toml" ]; then
      REVIEW_FLAGS+=("--settings" "${SASHIKO_DIR}/docs/examples/Settings.example.toml")
    fi
  fi
fi
if [ "${HAS_PROMPTS_FLAG}" -eq 0 ] && [ -d "${PROMPTS_DIR}" ]; then
  REVIEW_FLAGS+=("--prompts" "${PROMPTS_DIR}")
fi

# Note: In --agent mode, sashiko exits non-zero when High/Critical findings exist.
# Forward the exact exit code so callers can inspect both stdout JSON and status.
cd "${KERNEL_DIR}"
exec "${SASHIKO_BIN}" "${GLOBAL_FLAGS[@]}" review "${REVIEW_FLAGS[@]}" "${FORWARD_ARGS[@]}"
