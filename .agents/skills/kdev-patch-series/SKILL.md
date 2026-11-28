---
name: kdev-patch-series
description: >-
  Prepare, verify, stage, and iterate Linux kernel patch series (PATCH or RFC
  PATCH, v1 -> v2 -> vN) from linux/ into UndineD Maildir Drafts via UndineD
  MCP (stage_patch_series) without ever sending email over SMTP. Handles
  worktree/StGit hygiene, pre-submission quality gates (local Sashiko review,
  non-ASCII diff scanning, checkpatch.pl, out-of-tree build & QEMU tests),
  fetching upstream Sashiko or LKML review feedback, atomic commit-stack
  updates, and injecting per-patch 'Changes in vN:' notes after '---'. Use when
  asked to post or draft a patch series, prepare an RFC series, address
  sashiko.dev or LKML review comments, or update a series to v2/vN.
---

# Linux Kernel Patch Series Submission & Iteration (`kdev-patch-series`)

## Overview

This skill standardizes the end-to-end lifecycle of submitting a Linux kernel patch series from the `kdevkit` Parent Workspace (`linux/`) and iterating across versions (`v1` -> `v2` -> `vN`) in response to review feedback (from `sashiko.dev` or LKML reviewers).

### Core Safety Invariants

1. **Zero SMTP Transmission**: Never run `git send-email` or send email directly. Always stage drafts into UndineD Maildir `Drafts` via `stage_patch_series` so the human developer reviews and sends manually in the UndineD Web UI.
2. **Zero `linux/` Tree Pollution**: Keep all cover letters, `format-patch` files, notes JSONs, and review reports outside `linux/` under `.kdev/series/<slug>/` or `/tmp/`.
3. **Zero Stray Non-ASCII Characters**: Never stage patches or cover letters containing stray typographic Unicode (such as `U+2014` em-dash, `U+2013` en-dash, smart quotes, or `U+00A0` NBSP), which violates ASCII-only kernel style and disables SideDiff in UndineD.
4. **Fix Valid Local Sashiko Findings Before LKML Posting**: Public `sashiko.dev` automatically reviews LKML submissions. Always run local `linux-sashiko-review` before staging and fix every verified defect so upstream Sashiko stays clean.
5. **DCO & AI Coding Assistant Rules (`linux/Documentation/process/coding-assistants.rst`)**: Never add AI `Signed-off-by:` or `Assisted-by:` trailers. When amending a human author's commits, preserve their author/date/`Signed-off-by:` metadata and ask them to review the updated diff before sending.

---

## Dependencies

This skill orchestrates the following workspace/installed skills rather than reimplementing them:

- **`linux-sashiko-review`**: Local pre-submission and post-revision Sashiko patch review (Mode B subagent default or Mode A CLI).
- **`kdev-build-and-boot`**: Out-of-tree kernel compilation (`build/current/`) and QEMU verification.
- **`undine-mcp-review`**: UndineD MCP API reference (`stage_patch_series`, `get_email`, `search_emails`, `get_thread_context`, `list_recent_emails`).

---

## Quick Start

```bash
HELPER=".agents/skills/kdev-patch-series/scripts/series_helper.py"

# 1. Scan commits and cover letter for stray non-ASCII characters
"$HELPER" check-ascii --repo linux --range BASE..HEAD --cover .kdev/series/<slug>/cover.md

# 2. Fetch upstream sashiko.dev findings for a posted series
"$HELPER" fetch-sashiko "https://sashiko.dev/#/patchset/<msg-id>" \
  --output .kdev/series/<slug>/sashiko-v1.json

# 3. Stage v2 RFC series with cover letter and per-patch 'Changes in v2:' into UndineD Drafts
"$HELPER" stage \
  --repo linux --base BASE --head HEAD \
  --version 2 --subject-prefix "RFC PATCH" \
  --cover .kdev/series/<slug>/cover-v2.md \
  --notes-json .kdev/series/<slug>/v2-notes.json \
  --to "Reviewer <reviewer@example.com>" \
  --to "linux-trace-kernel@vger.kernel.org" \
  --cc "linux-kernel@vger.kernel.org" \
  --staging-dir .kdev/series/<slug>/staged-v2 \
  --output .kdev/series/<slug>/stage-v2-result.json \
  --replace-existing
```

---

## Utility Script (`scripts/series_helper.py`)

All programmatic, byte-sensitive work is handled by [`scripts/series_helper.py`](./scripts/series_helper.py) (pure Python 3 stdlib, zero external dependencies, file-based output):

| Subcommand | Purpose | Key Options |
| :--- | :--- | :--- |
| `check-ascii` | Scans `git log -p` and optional cover file for non-ASCII characters (exempting author/trailer headers and `Documentation/translations/` unless `--strict`). Exits `1` if hits found. | `--repo`, `--range`, `--cover`, `--strict`, `--output` |
| `fetch-sashiko` | Fetches public review results from `https://sashiko.dev/api/patch?id=<msg-id>` with cross-process file-lock rate limiting (1 req/s) and exponential backoff on 429/5xx. | `<url-or-msgid>`, `--output` |
| `stage` | Runs `git format-patch --base=...`, merges `--cover`, injects per-patch `Changes in vN:` right after `---`, enforces non-ASCII hygiene, and calls `undined --mcp-stdio` `stage_patch_series` byte-for-byte (preserving raw `\t` tabs). | `--base`, `--version`, `--subject-prefix`, `--cover`, `--notes-json`, `--to`, `--cc`, `--staging-dir`, `--output`, `--replace-existing`, `--dry-run` |

---

## 4-Phase Workflow

### Phase 1: Pre-Flight — Branch, Worktree & StGit Hygiene

Before modifying commits or generating patches, verify the Git state in `linux/`:

```bash
git -C linux worktree list
git -C linux status -sb
git -C linux log --reverse --oneline "${BASE}..HEAD"
```

1. **Detect shared-worktree index drift**:
   - If the same branch is checked out in both `/home/mhiramat/ksrc/linux` and `kdevkit/linux`, moving the branch in one worktree leaves the other with a stale index (appearing as thousands of staged changes).
   - **Never run `git reset --hard` blindly.** First verify `git -C linux diff --stat` is empty AND `git -C linux diff --cached --stat <reflog-old-sha>` is empty to confirm zero local edits would be lost.
2. **Recovering from broken StGit metadata** (when a branch originally created with StGit 0.19 was modified with pure Git):
   - Preserve the verified tip via `git -C linux checkout --detach <TIP>`.
   - Delete the old branch (`git -C linux branch -D <branch>`) and purge ALL stale StGit locations:
     - Refs: `refs/heads/<branch>.stgit`, `refs/patches/<branch>/*`, `refs/stacks/<branch>`
     - Config: `git -C linux config --remove-section "branch.<branch>.stgit"`
     - Metadata directories in **both** `$(git -C linux rev-parse --git-common-dir)/patches/<branch>` **and** `$(git -C linux rev-parse --git-dir)/patches/<branch>`
   - Recreate a clean pure-Git branch: `git -C linux checkout -b <branch> <TIP>`.
   - Verify `cd linux && stg branch -l | grep <branch>` exits cleanly without exceptions.

---

### Phase 2: Pre-Submission Quality Gates

Run **all** gates before staging `v1` and again before staging every `v2..vN`:

1. **Local Sashiko Review (`linux-sashiko-review`)**:
   - Invoke the `linux-sashiko-review` skill on `${BASE}..HEAD`.
   - Cross-verify every finding against `linux/` source code.
   - **Fix every verified valid finding** (even `Low` findings such as missing `SKIP:` reasons in kselftests, `kernel-parameters.txt` patch-split policy, or stale docs) before posting to LKML so upstream `sashiko.dev` reports clean.
2. **Non-ASCII Character Scan**:
   ```bash
   .agents/skills/kdev-patch-series/scripts/series_helper.py check-ascii \
     --repo linux --range "${BASE}..HEAD" --cover "${COVER_FILE}" \
     --output ".kdev/series/${SLUG}/ascii-check.json"
   ```
   - Fix any stray `U+2014` (`—`), `U+2013` (`–`), smart quotes, or `U+00A0` NBSP immediately.
3. **Style Check (`checkpatch.pl`)**:
   ```bash
   (cd linux && ./scripts/checkpatch.pl --git "${BASE}..HEAD")
   ```
   - Resolve all errors and style/line-length warnings (100-column limit, indentation, missing `Signed-off-by`).
4. **Out-of-Tree Build & Tests (`kdev-build-and-boot`)**:
   - For userspace tools (e.g., `tools/bootconfig`), build and test out-of-tree (`OUTPUT=/tmp/tool-test/`) so `linux/` stays clean, then remove `/tmp/tool-test/`.
   - Build the kernel out-of-tree (`make -C linux O="${PWD}/build/current" -j"$(nproc)" bzImage`) and run relevant QEMU selftests.
   - Confirm `git -C linux status --porcelain` is empty.

---

### Phase 3: Cover Letter, Recipients & UndineD MCP Staging (`v1` / `RFC`)

1. **Discover Recipients (`get_maintainer.pl`)**:
   Use `--nogit --nogit-fallback` for fast, deterministic MAINTAINERS lookup (avoiding slow git-history scans across dozens of files):
   ```bash
   (cd linux && git format-patch --stdout "${BASE}..HEAD" | \
     ./scripts/get_maintainer.pl --nogit --nogit-fallback)
   ```
   - **`To:`**: Primary subsystem maintainer(s), primary subsystem list (e.g., `linux-trace-kernel@vger.kernel.org`), and any key discussion partner addressed directly by an RFC cover letter (e.g., an LPC collaborator).
   - **`Cc:`**: Secondary subsystem maintainers/reviewers (x86, docs, lib, selftests) and relevant open lists (`linux-kernel@vger.kernel.org`, `linux-doc@vger.kernel.org`, `linux-kselftest@vger.kernel.org`). Exclude the patch author.
2. **Draft Cover Letter (`.kdev/series/<slug>/cover.md`)**:
   - Line 1: Full cover subject (`[PATCH 0/N] ...` or `[RFC PATCH 0/N] ...`), followed by a blank line, then hard-wrapped (<= 72 chars) ASCII prose:
     - Motivation and context (for RFCs: explicitly state it is an RFC, cite relevant discussions such as LPC, and list concrete specification points seeking feedback).
     - Concise design summary & patch overview.
     - For `v2+`: include a `Changes in v<N>:` summary right after the intro paragraph.
3. **Stage via `scripts/series_helper.py stage`**:
   - Pass `--subject-prefix "RFC PATCH"` for RFCs or `"PATCH"` for regular series.
   - Always pass `--replace-existing` when updating an unsent draft queue for the same `series_key` so stale duplicate drafts are cleanly replaced.
   - Never hand-transcribe large patch diffs into LLM JSON arguments; `series_helper.py stage` reads the `git format-patch` files directly from disk and calls `undined --mcp-stdio` byte-for-byte.
4. **Verify Staged Drafts via UndineD MCP**:
   - Call `undine` MCP `get_email` on the staged cover letter and at least one updated patch to confirm `to_addr`, `cc_addr`, `subject`, `in_reply_to`, raw `\t` indentation, and `Changes in vN:` placement.
   - Report the `series_id`, `draft_id` table, and `http://127.0.0.1:8080/#series/<series_id>` URL so the user can review and send manually in the UndineD Web UI.

---

### Phase 4: Review Feedback Triage & Version Iteration (`v2..vN`)

1. **Fetch Feedback**:
   - From `sashiko.dev`: run `series_helper.py fetch-sashiko "<url-or-msgid>" --output .kdev/series/<slug>/sashiko-v<N-1>.json` and read the saved JSON.
   - From LKML replies in UndineD: use `undine` MCP `search_emails` and `get_thread_context`.
2. **Verify Every Finding Against `linux/`**:
   - Read the exact functions, callers, and Kconfig guards in `linux/`.
   - Separate genuine defects from architectural constraints (e.g., early `setup_arch()` paths running before initrd unpacking) or false positives, and explain clearly what needs a code fix vs. a clarifying code comment vs. a reply.
3. **Rebuild the Patch Stack Atomically (Detached HEAD)**:
   - Checkout detached at the earliest commit requiring edits (`git -C linux checkout --detach <sha>`).
   - Apply targeted fixes directly to the responsible patch and amend (`git -C linux commit --amend --no-edit`), preserving original author, date, and human `Signed-off-by:`.
   - Replay subsequent commits in order via `git -C linux cherry-pick <sha>`, applying fixes to each affected patch as you go.
   - Add regression tests when appropriate (e.g., `tools/bootconfig/test-bootconfig.sh` or kselftests).
   - Update the branch only after rebuilding cleanly: `git -C linux checkout -B <branch>`.
4. **Re-Run All Phase 2 Gates**:
   - Re-run `check-ascii`, `checkpatch.pl`, build/unit/QEMU tests, AND **re-run `linux-sashiko-review`** on the updated series. Fix any newly surfaced valid findings before staging!
5. **Prepare Per-Patch `Changes in v<N>:` Notes (`.kdev/series/<slug>/v<N>-notes.json`)**:
   - Keep Git commit messages clean (do **not** embed `---\nChanges in vN:` inside Git commit messages).
   - Create a JSON map keyed by 1-based patch index containing concise bullets only for patches modified in `v<N>`:
     ```json
     {
       "1": " - Track each open brace's source position in open_brace_pos[]...",
       "2": " - Fall back to index 0 in setup_boot_config() under CONFIG_BOOT_CONFIG_FORCE=y..."
     }
     ```
   - `series_helper.py stage --version <N> --notes-json ...` automatically injects `Changes in v<N>:` right after `---` (between `Signed-off-by:` and the diffstat), so `git am` strips it cleanly while LKML reviewers and Sashiko see exact per-patch deltas.
6. **Stage `v<N>` as a Fresh Top-Level Thread**:
   - Per LKML convention, post `v2+` as a new top-level thread (omit `--in-reply-to`) with `--version <N>` and `series_key "<branch>:v<N>"`.

---

## Rate Limiting

`scripts/series_helper.py fetch-sashiko` enforces a cross-process **1 request/second** rate limit on `sashiko.dev` via `fcntl.flock` (`/tmp/kdev-sashiko-api.lock`) and `time.monotonic()`, with exponential backoff on HTTP 429 and 5xx responses. Local `undined --mcp-stdio` calls run over local STDIO and require no network rate limiting.

---

## Common Mistakes

1. **Hand-copying patch diffs into MCP tool JSON arguments**: Large diffs risk tab corruption or output truncation. Always use `scripts/series_helper.py stage` so `git format-patch` bytes flow directly to `undined --mcp-stdio`.
2. **Skipping `check-ascii` before staging**: A single em-dash (`U+2014`) in `.rst` documentation disables UndineD SideDiff and requires amending & restaging.
3. **Leaving stale StGit metadata in worktree `git-dir`**: StGit 0.19 stores state in *both* `<git-common-dir>/patches/<branch>` and `<git-dir>/patches/<branch>` plus `[branch "<branch>.stgit"]` config. Clean all of them when retiring a broken StGit branch.
4. **Running `get_maintainer.pl` without `--nogit --nogit-fallback` on large series**: Scanning full kernel git history across 20+ files can stall for minutes; pass `--nogit --nogit-fallback` for fast MAINTAINERS resolution.
5. **Embedding `---` / `Changes in vN:` inside Git commit messages**: Inject per-patch changelogs after `---` at `format-patch` staging time via `--notes-json` instead so the Git commits themselves remain clean.
6. **Ignoring `Low` local Sashiko findings**: Public `sashiko.dev` reviews every LKML post automatically; fixing valid local findings upfront avoids avoidable v2/v3 churn.
