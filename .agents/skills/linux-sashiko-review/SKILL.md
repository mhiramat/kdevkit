---
name: linux-sashiko-review
description: >-
  Review a Linux kernel patch series, branch, or commit range under linux/ using
  Sashiko (https://github.com/sashiko-dev/sashiko). Defaults to a token-efficient
  subagent prompt-based review using sashiko/projects/linux/prompts/ when no
  explicit Sashiko API/provider is configured, and runs Sashiko's multi-stage
  CLI (sashiko review --agent via scripts/run_sashiko.sh) when the user has
  configured an API key or provider (--sashiko-provider / .kdev/sashiko.toml).
  Use whenever asked to review kernel patches, run Sashiko on a patch series,
  audit commits in linux/ before submission, or triage Sashiko findings.
---

# Linux Kernel Patch Series Review with Sashiko (`linux-sashiko-review`)

## Overview

This skill reviews Linux kernel patches developed inside the `kdevkit` Parent Workspace (`linux/`) using [Sashiko](https://github.com/sashiko-dev/sashiko), keeping `linux/` 100% clean.

It supports **two execution modes**:

- **Mode B — Subagent Prompt-Based Review (Default when no Sashiko API is explicitly configured)**:
  Delegates review to a read-only `research` subagent guided by Sashiko's three-layer Linux prompt architecture (`sashiko/projects/linux/prompts/` — review guides, `maintainers/*.md`, and `notes/`). Requires no separate API key or Rust build, keeps the parent conversation context clean, and keeps token usage low.
- **Mode A — Sashiko CLI (`sashiko review --agent`) (Active when an API key / provider is explicitly configured)**:
  Executes Sashiko's native Rust multi-stage pipeline via [`scripts/run_sashiko.sh`](../../../scripts/run_sashiko.sh) with `--agent`, producing structured JSON (`findings`, `concerns`, `design_assessment`) with full `<code_notes>` matching, verification, and parallel post-verification.

### Core Invariants

1. **Zero `linux/` Tree Pollution**: Never write config, cache, JSON output, or report files inside `linux/`. Store review outputs under `.kdev/sashiko-reviews/` or `/tmp/`.
2. **Default to Subagent Unless API Is Explicitly Configured**: Never silently burn external API keys or third-party CLI quotas if the user has not explicitly configured Sashiko (via `--sashiko-provider`, `.kdev/sashiko.toml`, `~/.config/sashiko.toml`, or API env vars).
3. **Verify Every Finding Against Real Kernel Source**: Cross-check all candidate bugs (from Mode A or Mode B) against the actual code in `linux/` (callers, locks, error paths, config guards). Never fabricate defects, and never dismiss a real bug without concrete code proof ("anti-charity" principle).
4. **Report Before Editing**: Present the triaged review report first. Do not modify commits or source files in `linux/` unless the user asks to fix the findings.
5. **Upstream Linux Kernel Hygiene**: Follow `linux/AGENTS.md` and `linux/Documentation/process/coding-assistants.rst` when assisting with fixes (`Signed-off-by`, proper `Fixes:` trailers, no AI attribution trailers).

---

## Workflow

### Step 1: Identify the Target Patch Series in `linux/`

1. **Resolve commit range**:
   - If the user specified a commit, range, or branch (e.g., `HEAD~3..HEAD`, `v6.18..HEAD`, `origin/master..my-branch`, or a single SHA), use it directly.
   - Otherwise, auto-detect the current branch's patch series via pure Git:
     ```bash
     BRANCH="$(git -C linux symbolic-ref --short HEAD 2>/dev/null || echo HEAD)"
     BASE_REF="$(git -C linux config --get "branch.${BRANCH}.kdev-base" \
       || git -C linux rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null \
       || echo origin/master)"
     BASE_SHA="$(git -C linux merge-base "${BASE_REF}" HEAD)"
     RANGE="${BASE_SHA}..HEAD"
     ```
2. **Inspect the series and working tree**:
   ```bash
   git -C linux status --short
   git -C linux log --reverse --oneline "${RANGE}"
   git -C linux diff --stat "${RANGE}"
   ```
   - If `git -C linux status --short` shows uncommitted changes, warn the user that Sashiko reviews committed git ranges (and confirm whether to review committed patches only or include uncommitted diffs in Mode B).
   - If the range is empty (0 commits), stop and ask the user for the intended commit range or base ref.

---

### Step 2: Select Execution Mode (`scripts/run_sashiko.sh --check`)

Run the workspace readiness probe:

```bash
./scripts/run_sashiko.sh --check
```

Interpret the output:

- **`MODE=missing` (exit code 2)**:
  - `sashiko/` is not cloned yet. Tell the user to run `./setup.sh --with-sashiko` (or `./setup.sh --with-sashiko --sashiko-no-build` for fast prompts-only setup), or offer to run it for them before proceeding.
- **`MODE=subagent`** *(default when no explicit Sashiko API/provider is configured, or binary is not built)*:
  - Inform the user that Mode B (subagent prompt-based review using `sashiko/projects/linux/prompts/`) will be used (and briefly mention that `--sashiko-provider` / `LLM_API_KEY` enables native Sashiko CLI mode if desired).
  - Proceed to **Step 3B**.
- **`MODE=cli`** *(binary built AND explicit API/provider configured)*:
  - Unless the user explicitly asked for subagent/prompt-only review, proceed to **Step 3A**.

---

### Step 3A: Mode A — Execute Sashiko CLI (`sashiko review --agent`)

1. **Choose flags for token efficiency vs thoroughness**:
   - **Iterative development / CLI agent providers (`claude-cli`, `copilot-cli`, `codex-cli`)**: Recommend adding `--cheap` (combines exploratory analysis stages into a single pass, cutting token usage and CLI subprocess count by ~3–5× while preserving `verification`, `post-verification`, and `<code_notes>`).
   - **Pre-submission / final review**: Run full multi-stage review (omit `--cheap`). Optionally add `--design` for series-level design assessment or `--report-related-preexisting` to surface closely related pre-existing bugs.
   - **Interrupted runs**: Pass `--resume` to replay cached responses from `$XDG_DATA_HOME/sashiko/`.
2. **Run Sashiko via `scripts/run_sashiko.sh` and capture JSON**:
   ```bash
   mkdir -p .kdev/sashiko-reviews
   STAMP="$(date +%Y%m%d-%H%M%S)"
   OUT_JSON=".kdev/sashiko-reviews/${STAMP}-review.json"
   ERR_LOG=".kdev/sashiko-reviews/${STAMP}-stderr.log"

   # Sashiko exits non-zero when High/Critical findings exist, so capture rc cleanly.
   set +e
   ./scripts/run_sashiko.sh --agent "${EXTRA_FLAGS[@]}" "${RANGE}" \
     >"${OUT_JSON}" 2>"${ERR_LOG}"
   RC=$?
   set -e
   ```
   - Useful optional `EXTRA_FLAGS`:
     - `--cheap` (token-saving single-pass exploration)
     - `--design` (experimental series-level design assessment)
     - `--baseline <ref>` (explicit baseline override)
     - `--resume` (continue interrupted review)
     - `--report-related-preexisting` / `--report-preexisting`
     - `--effort <low|mid|high|dynamic>` / `--ai-provider <provider>` / `-m <model>`
     - `--custom-prompt "<extra guidance>"`
3. **Parse `${OUT_JSON}`**:
   - Check top-level fields produced by `sashiko review --agent`:
     - `status`: `"clean"` | `"issues_found"` | `"incomplete"` | `"error"`
     - `baseline`: baseline commit SHA
     - `patches[]`: commit index, status, subject
     - `findings[]`: confirmed defects (`severity`, `problem`, `locations[]` with `file`/`line`/`function_or_symbol`/`code_snippet`/`why_this_location_matters`, `severity_explanation`, `reasoning`)
     - `concerns[]`: lower-confidence or unconfirmed concerns
     - `related_preexisting[]`: closely related pre-existing bugs (when requested)
     - `design_assessment`: `verdict`, `verdict_reason`, `concerns[]` (when `--design` passed)
     - `tokens_in`, `tokens_out`, `tokens_cached`
   - **Error / Incomplete Handling**:
     - If `${OUT_JSON}` is empty/invalid JSON or `status` is `"error"` / `"incomplete"`, inspect `${ERR_LOG}`, explain the cause (e.g., quota/timeout/auth), suggest `--resume` for partial runs, or offer to fall back to **Step 3B (Mode B)**.
4. Proceed to **Step 4** to verify every finding against `linux/` source code and present the report.

---

### Step 3B: Mode B — Subagent Prompt-Based Review (Default / Fallback)

Use `invoke_subagent` with `TypeName: "research"` so the subagent reads the patches, Sashiko prompts, and kernel context in its own isolated context window without bloating the parent conversation.

#### 1. Collect Series Context & Matched Maintainer Notes (in Parent)

Before launching the subagent, gather the touched files and commit list so the subagent prompt is focused and token-efficient:

```bash
git -C linux log --reverse --format='%h %s' "${RANGE}"
git -C linux diff --name-only "${RANGE}"
```

Deterministically match subsystem maintainer notes under `sashiko/projects/linux/prompts/maintainers/`:
- Always include `sashiko/projects/linux/prompts/maintainers/general.md`.
- Match touched file paths (and key changed symbols) against the `paths` and `symbols` keys in the `+++ ... +++` TOML front matter of `sashiko/projects/linux/prompts/maintainers/*.md`.

#### 2. Choose Subagent Fan-Out Strategy (Token Control)

- **Default (Token-Efficient)**:
  - **1–5 patches**: Launch **1 `research` subagent** to review the entire series in commit order (and series-wide interactions) in a single pass plus self-verification.
  - **6+ patches**: Split into chronological batches of ~3–5 related patches (each receiving the series overview + its assigned patch range) so no single subagent overflows context, then synthesize in the parent.
- **Thorough Mode (only when the user explicitly requests a deep / multi-perspective / thorough review)**:
  - Launch **2–3 parallel `research` subagents** partitioned by Sashiko's domain clusters:
    1. `goal` + `implementation` + `execution-flow` (`callstack.md`)
    2. `resources` + `locking` + `security` (`locking.md`)
    3. `performance` + `hardware` (`performance.md`, when relevant to touched code)
  - Consolidate and cross-verify their findings in the parent.

#### 3. Subagent Prompt Requirements

Instruct each `research` subagent to:
1. **Read Sashiko's universal review guides** from `sashiko/projects/linux/prompts/`:
   - `severity.md` (strict Critical / High / Medium / Low calibration + kernel threat model)
   - `false-positive-guide.md` (mandatory false-positive filters)
   - Relevant domain guides: `callstack.md`, `locking.md`, `performance.md`
2. **Read all matched Maintainer Notes** (`maintainers/general.md` plus every matched `maintainers/<subsystem>.md`) as authoritative subsystem policy.
3. **Check Code Notes (`sashiko/projects/linux/prompts/notes/`)** if notes exist for the touched subsystem (treating them as reference hints only—the actual `linux/` source tree at `HEAD` and baseline is always authoritative).
4. **Inspect every commit (`git -C linux show <sha>`) and surrounding kernel code in `linux/`**:
   - Evaluate across Sashiko's dimensions: `goal`, `implementation`, `execution-flow`, `resources`, `locking`, `security`, `performance`, `hardware`, and cross-patch series consistency (including whether an earlier patch's issue is fixed or introduced by a later patch, breaking `git bisect`).
5. **Apply Sashiko's Anti-Charity & Verification Rules**:
   - Verify every candidate bug by reading actual callers, callees, struct definitions, lock hierarchies, error paths, and `CONFIG_*` guards in `linux/`.
   - Never assume callers protect against a bug without citing concrete code proof.
   - Return structured results separated into:
     - **Verified Findings** (with calibrated severity, commit SHA/index, `file:line`, symbol, code snippet, root-cause reasoning, trigger path, and suggested fix)
     - **Design / Maintainer-Policy Concerns** (citing the matched maintainer note or subsystem convention)
     - **Dismissed Concerns** (candidates checked and disproved with concrete `file:line` evidence so the parent does not re-investigate them)

---

### Step 4: Cross-Verify & Present the Review Report

For both Mode A and Mode B:

1. **Spot-check / verify findings in `linux/`**:
   - Open the cited `linux/<path>` lines to confirm line numbers, symbol names, and control/locking paths still match the exact commit range.
   - Reclassify any disproved item from Mode A as **Likely False Positive** with concrete code evidence (do not hide it silently; show why it was ruled out).
2. **Present a concise, actionable report**:
   - **Summary header**: Mode used (`Mode A: sashiko review --agent [--cheap]` or `Mode B: Subagent prompt-based`), branch & commit range, patch count, overall status (`clean` / `issues_found`), and metadata (token counts for Mode A; matched maintainer notes for Mode B).
   - **Verified Findings** grouped by patch and ordered `Critical` → `High` → `Medium` → `Low`, with clickable `file://` links to `linux/<path>#L<line>`, concise root cause, and concrete fix recommendation.
   - **Concerns / Design Assessment** (if any).
   - **Dismissed / False Positives** (brief list with code evidence).

---

### Step 5: Optional Fix & Re-Review Loop

If the user asks to fix reported findings:

1. Apply fixes cleanly to the relevant patch(es) in `linux/` (keeping commits atomic, bisect-safe, and adhering to `linux/Documentation/process/coding-style.rst` and `coding-assistants.rst`).
2. Verify compilation and tests out-of-tree using the `kdev-build-and-boot` skill (`./scripts/build_kernel.sh`, selftests/QEMU if relevant).
3. Re-run `linux-sashiko-review` on the updated range until no valid findings remain.

---

## Common Mistakes

1. **Running `sashiko review` from the `kdevkit` root instead of `linux/`**: Always invoke via `./scripts/run_sashiko.sh`, which `cd`s into `${KERNEL_DIR}` and passes absolute paths for `--settings` and `--prompts`.
2. **Writing files into `linux/`**: Keep all JSON outputs, logs, and configs in `.kdev/` or `/tmp/`.
3. **Treating non-zero exit from `sashiko review --agent` as a crash**: Sashiko returns a non-zero exit code when High/Critical findings are reported. Always inspect stdout JSON (`status` field) first.
4. **Burning CLI subscription rate limits in Mode A**: When using `claude-cli`, `copilot-cli`, or `codex-cli` as Sashiko's provider, pass `--cheap` for iterative runs and keep `[review] concurrency` modest.
5. **Skipping source verification**: Always verify cited callers, locks, and error paths directly in `linux/` before recommending a code change.
