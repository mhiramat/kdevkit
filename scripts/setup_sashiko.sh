#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

REPO_URL="${SASHIKO_REPO_URL}"
CLONE_BRANCH=""
PROVIDER=""
NO_BUILD=0
UPDATE_REPO=0
FORCE_CONFIG=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Shallow-clone and set up Sashiko (https://github.com/sashiko-dev/sashiko)
for agent-assisted Linux kernel patch review in kdevkit.

By default, if no API key or --provider is specified, Sashiko's prompts and
binary (when Rust 1.90+ is available) are prepared without creating an API
config, so the linux-sashiko-review skill defaults to subagent prompt-based
review. Pass --provider <PROVIDER> (or export LLM_API_KEY / GEMINI_API_KEY /
ANTHROPIC_API_KEY) to configure Sashiko CLI mode (sashiko review --agent).

Options:
  --repo-url <URL>       Git URL to shallow-clone (default: ${SASHIKO_REPO_URL}).
  --branch <BRANCH>      Branch or tag to clone.
  --provider <PROVIDER>  Configure ${SASHIKO_CONFIG} for Sashiko CLI mode:
                           auto          Auto-detect proxy, API key, or local agent CLI
                           gemini        Gemini API (LLM_API_KEY / GEMINI_API_KEY)
                           gemini-proxy  Local gemini-proxy-helper.sh (ambient auth)
                           claude        Anthropic Claude API (ANTHROPIC_API_KEY)
                           claude-cli    Local Claude Code CLI (claude)
                           copilot-cli   Local GitHub Copilot CLI (copilot)
                           codex-cli     Local OpenAI Codex CLI (codex)
                           kiro-cli      Local Kiro CLI (kiro-cli)
                           goose         Local goose ACP CLI (goose)
                           prompt-only   Skip Rust build and API config (subagent mode only)
  --no-build             Skip cargo build (prompts-only setup for subagent mode).
  --prompts-only         Alias for --no-build.
  --update               Fetch latest shallow commit if ${SASHIKO_DIR} already exists.
  --force-config         Overwrite existing ${SASHIKO_CONFIG} when configuring a provider.
  -h, --help             Show this help message.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-url)
      REPO_URL="${2:-}"
      if [ -z "${REPO_URL}" ]; then
        echo "Error: --repo-url requires a URL argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --branch)
      CLONE_BRANCH="${2:-}"
      if [ -z "${CLONE_BRANCH}" ]; then
        echo "Error: --branch requires a branch or tag name." >&2
        exit 1
      fi
      shift 2
      ;;
    --provider)
      PROVIDER="${2:-}"
      if [ -z "${PROVIDER}" ]; then
        echo "Error: --provider requires a provider name." >&2
        exit 1
      fi
      shift 2
      ;;
    --no-build|--prompts-only)
      NO_BUILD=1
      shift
      ;;
    --update)
      UPDATE_REPO=1
      shift
      ;;
    --force-config)
      FORCE_CONFIG=1
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

case "${PROVIDER}" in
  ""|auto|gemini|gemini-proxy|claude|claude-cli|copilot-cli|codex-cli|kiro-cli|goose|prompt-only)
    ;;
  *)
    echo "Error: Unsupported --provider '${PROVIDER}'." >&2
    usage >&2
    exit 1
    ;;
esac

if [ "${PROVIDER}" = "prompt-only" ]; then
  NO_BUILD=1
fi

echo "==> [1/4] Provisioning Sashiko Repository (${SASHIKO_DIR})"
if [ -d "${SASHIKO_DIR}/.git" ]; then
  if [ "${UPDATE_REPO}" -eq 1 ]; then
    echo "    Updating existing shallow checkout in ${SASHIKO_DIR}..."
    if [ -n "${CLONE_BRANCH}" ]; then
      git -C "${SASHIKO_DIR}" fetch --depth 1 origin "${CLONE_BRANCH}"
    else
      git -C "${SASHIKO_DIR}" fetch --depth 1 origin HEAD
    fi
    git -C "${SASHIKO_DIR}" checkout -q FETCH_HEAD
    echo "    [OK] Updated Sashiko to $(git -C "${SASHIKO_DIR}" rev-parse --short HEAD)"
  else
    echo "    [OK] Sashiko already cloned at ${SASHIKO_DIR} ($(git -C "${SASHIKO_DIR}" rev-parse --short HEAD))"
    echo "         Pass --update to fetch the latest shallow revision."
  fi
elif [ -e "${SASHIKO_DIR}" ]; then
  echo "Error: ${SASHIKO_DIR} exists but is not a Git repository." >&2
  exit 1
else
  echo "    Shallow-cloning ${REPO_URL} into ${SASHIKO_DIR}..."
  CLONE_ARGS=("--depth" "1")
  if [ -n "${CLONE_BRANCH}" ]; then
    CLONE_ARGS+=("--branch" "${CLONE_BRANCH}")
  fi
  git clone "${CLONE_ARGS[@]}" "${REPO_URL}" "${SASHIKO_DIR}"
  echo "    [OK] Cloned Sashiko ($(git -C "${SASHIKO_DIR}" rev-parse --short HEAD))"
fi

if [ ! -d "${SASHIKO_DIR}/projects/linux/prompts" ]; then
  echo "Error: Expected Linux prompts directory missing at ${SASHIKO_DIR}/projects/linux/prompts." >&2
  exit 1
fi
echo "    [OK] Linux review prompts available at ${SASHIKO_DIR}/projects/linux/prompts"

echo "==> [2/4] Building Sashiko Local-Review Binary"
BUILD_OK=0
if [ "${NO_BUILD}" -eq 1 ]; then
  echo "    [SKIP] Rust build skipped (--no-build / --provider prompt-only)."
  echo "           linux-sashiko-review will use subagent prompt-based review."
elif ! command -v cargo >/dev/null 2>&1; then
  echo "    [WARN] cargo not found on PATH; skipping Rust build."
  echo "           Install Rust 1.90+ via rustup to enable 'sashiko review --agent' CLI mode."
  echo "           Subagent prompt-based review (using ${SASHIKO_DIR}/projects/linux/prompts) works without building."
else
  NEED_TOOLCHAIN_WARN=0
  if ! command -v rustup >/dev/null 2>&1; then
    RUSTC_VER="$(rustc --version 2>/dev/null | awk '{print $2}' || echo "0.0.0")"
    RUSTC_MAJOR="$(echo "${RUSTC_VER}" | cut -d. -f1)"
    RUSTC_MINOR="$(echo "${RUSTC_VER}" | cut -d. -f2)"
    if [ "${RUSTC_MAJOR:-0}" -lt 1 ] || { [ "${RUSTC_MAJOR:-0}" -eq 1 ] && [ "${RUSTC_MINOR:-0}" -lt 90 ]; }; then
      echo "    [WARN] Found rustc ${RUSTC_VER} without rustup (Sashiko requires Rust 1.90+)."
      echo "           Skipping Rust build; subagent prompt-based review remains available."
      NEED_TOOLCHAIN_WARN=1
    fi
  fi

  if [ "${NEED_TOOLCHAIN_WARN}" -eq 0 ]; then
    echo "    Building sashiko (--release --no-default-features --features cache --bin sashiko)..."
    (
      cd "${SASHIKO_DIR}"
      cargo build --release --no-default-features --features cache --bin sashiko
    )
    if [ -x "${SASHIKO_BIN}" ]; then
      BUILD_OK=1
      echo "    [OK] Built $("${SASHIKO_BIN}" --version 2>/dev/null || echo "${SASHIKO_BIN}")"
    else
      echo "Error: Build succeeded but binary not found at ${SASHIKO_BIN}." >&2
      exit 1
    fi
  fi
fi

detect_available_providers() {
  local found=()
  if [ -x "${SASHIKO_DIR}/scripts/gemini-proxy-helper.sh" ] && \
     "${SASHIKO_DIR}/scripts/gemini-proxy-helper.sh" --check >/dev/null 2>&1; then
    found+=("gemini-proxy")
  fi
  if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${LLM_API_KEY:-}" ]; then
    found+=("gemini")
  fi
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    found+=("claude")
  fi
  if command -v claude >/dev/null 2>&1; then
    found+=("claude-cli")
  fi
  if command -v copilot >/dev/null 2>&1; then
    found+=("copilot-cli")
  fi
  if command -v codex >/dev/null 2>&1; then
    found+=("codex-cli")
  fi
  if command -v kiro-cli >/dev/null 2>&1; then
    found+=("kiro-cli")
  fi
  if command -v goose >/dev/null 2>&1; then
    found+=("goose")
  fi
  echo "${found[*]:-}"
}

write_provider_config() {
  local chosen="$1"
  local examples_dir="${SASHIKO_DIR}/docs/examples"
  mkdir -p "$(dirname "${SASHIKO_CONFIG}")"

  case "${chosen}" in
    gemini-proxy)
      cat > "${SASHIKO_CONFIG}" <<EOF
# Generated by kdevkit scripts/setup_sashiko.sh (provider: gemini-proxy)
# Uses ambient workstation credentials via Sashiko's gemini-proxy-helper.sh.

[ai]
provider = "gemini"
model = "gemini-4-argon"
max_input_tokens = 900000

[ai.gemini]
proxy_command = "${SASHIKO_DIR}/scripts/gemini-proxy-helper.sh --port-file {port_file}"

[review]
concurrency = 4
EOF
      ;;
    gemini)
      cp "${examples_dir}/Settings.example.toml" "${SASHIKO_CONFIG}"
      ;;
    claude)
      cp "${examples_dir}/Settings.claude.toml" "${SASHIKO_CONFIG}"
      ;;
    claude-cli)
      if ! command -v claude >/dev/null 2>&1; then
        echo "    [WARN] 'claude' CLI not found on PATH; install and sign in before running sashiko review."
      fi
      cp "${examples_dir}/Settings.claude-cli.toml" "${SASHIKO_CONFIG}"
      ;;
    copilot-cli)
      if ! command -v copilot >/dev/null 2>&1; then
        echo "    [WARN] 'copilot' CLI not found on PATH; install and sign in before running sashiko review."
      fi
      cp "${examples_dir}/Settings.copilot-cli.toml" "${SASHIKO_CONFIG}"
      ;;
    codex-cli)
      if ! command -v codex >/dev/null 2>&1; then
        echo "    [WARN] 'codex' CLI not found on PATH; install and sign in before running sashiko review."
      fi
      cp "${examples_dir}/Settings.codex-cli.toml" "${SASHIKO_CONFIG}"
      ;;
    kiro-cli)
      if ! command -v kiro-cli >/dev/null 2>&1; then
        echo "    [WARN] 'kiro-cli' not found on PATH; install and authenticate before running sashiko review."
      fi
      cp "${examples_dir}/Settings.kiro-cli.toml" "${SASHIKO_CONFIG}"
      ;;
    goose)
      if ! command -v goose >/dev/null 2>&1; then
        echo "    [WARN] 'goose' not found on PATH; install and configure goose before running sashiko review."
      fi
      cp "${examples_dir}/Settings.goose-cli.toml" "${SASHIKO_CONFIG}"
      ;;
    *)
      echo "Error: Internal error: unknown provider '${chosen}'." >&2
      exit 1
      ;;
  esac

  chmod 600 "${SASHIKO_CONFIG}"
  echo "    [OK] Wrote Sashiko config (${chosen}) to ${SASHIKO_CONFIG} (mode 600)"
}

echo "==> [3/4] Configuring Sashiko Provider (${SASHIKO_CONFIG})"
AVAILABLE_PROVIDERS="$(detect_available_providers)"
SELECTED_PROVIDER=""

if [ "${PROVIDER}" = "prompt-only" ]; then
  echo "    [SKIP] Skipping API config (--provider prompt-only)."
elif [ -n "${PROVIDER}" ]; then
  if [ "${PROVIDER}" = "auto" ]; then
    # Pick highest-priority detected provider
    SELECTED_PROVIDER="$(echo "${AVAILABLE_PROVIDERS}" | awk '{print $1}')"
    if [ -z "${SELECTED_PROVIDER}" ]; then
      echo "    [WARN] No API key, gemini-proxy, or local agent CLI detected for --provider auto."
      echo "           Leaving ${SASHIKO_CONFIG} unconfigured; linux-sashiko-review will use subagent mode."
    fi
  else
    SELECTED_PROVIDER="${PROVIDER}"
  fi

  if [ -n "${SELECTED_PROVIDER}" ]; then
    if [ -f "${SASHIKO_CONFIG}" ] && [ "${FORCE_CONFIG}" -eq 0 ]; then
      echo "    [OK] ${SASHIKO_CONFIG} already exists (pass --force-config to overwrite)."
    else
      write_provider_config "${SELECTED_PROVIDER}"
    fi
  fi
else
  # No explicit --provider passed: only materialize config automatically if an API key is explicitly exported
  if [ -f "${SASHIKO_CONFIG}" ]; then
    echo "    [OK] Existing Sashiko config found at ${SASHIKO_CONFIG}"
  elif [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${LLM_API_KEY:-}" ]; then
    SELECTED_PROVIDER="gemini"
    write_provider_config "${SELECTED_PROVIDER}"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    SELECTED_PROVIDER="claude"
    write_provider_config "${SELECTED_PROVIDER}"
  else
    echo "    [INFO] No explicit Sashiko API/provider configured."
    echo "           Defaulting linux-sashiko-review to subagent prompt-based review (no external API quota used)."
    if [ -n "${AVAILABLE_PROVIDERS}" ]; then
      echo "           Detected local provider candidates: ${AVAILABLE_PROVIDERS}"
      echo "           To enable Sashiko CLI (--agent) mode, run:"
      echo "             ./setup.sh --with-sashiko --sashiko-provider auto"
      echo "           or pick a specific provider (e.g. --sashiko-provider $(echo "${AVAILABLE_PROVIDERS}" | awk '{print $1}'))."
    else
      echo "           To enable Sashiko CLI (--agent) mode later, export LLM_API_KEY (or GEMINI_API_KEY)"
      echo "           or run: ./setup.sh --with-sashiko --sashiko-provider <provider>"
    fi
  fi
fi

echo "==> [4/4] Verification & Summary"
if [ "${BUILD_OK}" -eq 1 ]; then
  "${SASHIKO_BIN}" review --help >/dev/null
  echo "    [OK] Sashiko CLI verified: ${SASHIKO_BIN}"
fi
echo "    Prompts: ${SASHIKO_DIR}/projects/linux/prompts"
if [ -f "${SASHIKO_CONFIG}" ]; then
  echo "    Config:  ${SASHIKO_CONFIG}"
else
  echo "    Config:  (not set -> subagent prompt-based review default)"
fi
echo "    Check:   ./scripts/run_sashiko.sh --check"
echo "    CLI run: ./scripts/run_sashiko.sh --agent --cheap HEAD~1..HEAD"
echo "==> Sashiko setup complete!"
