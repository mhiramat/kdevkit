# Design & Implementation Specification: Phase 4 — StGit-Free Patch Stack, Series & Maintainer Workflow (`DESIGN_PHASE4_PATCHSTACK.md`)

## 1. Overview & Objectives

This document specifies the design, TypeScript architecture, and test plan for **Phase 4** of **kdevkit**: a pure-Git, StGit-free patch-stack manager, topic series manager, review/maintainer branch workflow, and UndineD MCP integration built directly into the unified `kdevkit/extension/` VSCode extension (`kdev.*` namespace).

To avoid duplicated VSCode extension features between `kdevkit` and `undined`, **all Git repository UI and patch-stack workflows are consolidated into `kdevkit/extension/`**, while **UndineD** serves strictly as the email, Patchwork, and `b4` workstation (accessed programmatically via MCP over STDIO and interactively via the UndineD Web UI).

### Core Objectives
* **StGit-Free Pure Git Patch Stack:** Provide StGit-equivalent commit-stack operations (`refresh` arbitrary commits with automatic rebase of dependent commits, `reorder`, `drop`, `reword`, `split`, `pop`/`push`, and 1-click `undo`/`redo`) using standard Git (`>= 2.38`) only—retaining 100% compatibility with standard Git CLI and VSCode Source Control.
* **Zero Kernel Tree Pollution:** Preserve `kdevkit`'s Parent Workspace rule: never write cover letters, series metadata, or temporary staging files inside `kdevkit/linux/`. Durable series state lives outside `linux/` and outside ephemeral kernel `build/` artifacts.
* **Role-Based Branch Management:** Manage three distinct branch workflows cleanly:
  1. `topic/*` — Contributor patch series with cover letter, version tracking, `range-diff`, and preflight checks.
  2. `review/*` — Incoming patch review branches imported by Message-ID via `b4` or UndineD MCP (shared seamlessly with AI skills).
  3. **Customizable Maintainer Branches** (user-configured via `kdev.git.maintainerPrefixes`, e.g., `probes/*`, `bootconfig/*`) — Common kernel maintainer cadence awareness (`fixes` weekly PR cadence vs. `for-next`/`core` merge-window cadence), automatic lore/trailer ingestion, published-commit protection, and on-demand cross-branch patch transplanting.
* **Strict Human-in-the-Loop Mail Delivery:** `kdevkit` **never invokes `git send-email` and never triggers SMTP transmission via MCP**. Outgoing patch series are staged into UndineD `Drafts` via UndineD MCP (`stage_patch_series`), where the human developer reviews, edits if necessary, and explicitly sends them through the UndineD Web UI (specified in companion document `DESIGN_UNDINED_SERIES_DRAFT.md`).
* **Pull Request Skill Reuse:** Reuse the developer's existing Pull Request creation skill rather than reimplementing PR text generation inside `kdevkit`. Provide clean context-export helpers and configurable skill hooks, with UndineD MCP's `create_mail_draft` acting as the shared draft destination.

### Non-Goals
* Direct SMTP transmission or `git send-email` execution from VSCode or MCP.
* Duplicating UndineD's mail reader, side-by-side email diff reviewer, or Patchwork inbox UI inside VSCode.
* Replacing the developer's existing Pull Request skill logic.
* Hardcoding subsystem-specific maintainer branch names inside the extension.

---

## 2. System Architecture & Responsibility Boundaries

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ kdevkit/extension/ (Unified VSCode Extension — kdev.* namespace)          │
│                                                                            │
│  ├── Patch Stack Views (TreeViews + QuickPicks + Cover Letter Editor)      │
│  │     ├── Branches View  : topic/* | review/* | <maintainer-prefixes>/*   │
│  │     └── Stack View     : Base..HEAD commits, Lock badges, Undo/Rebase   │
│  ├── Pure Git Engine (src/patchstack/gitStackEngine.ts — vscode-free)      │
│  │     ├── fixup + autosquash refresh, scripted interactive rebase         │
│  │     ├── refs/kdev/undo/* snapshots & optional refs/kdev/stack-top/*     │
│  │     └── Published-commit guard & transactional cross-branch move        │
│  ├── Series & Preflight Manager (src/patchstack/seriesStore.ts)            │
│  │     ├── .kdev/series/<slug>/ (cover.md, series.json — outside linux/)   │
│  │     ├── refs/kdev/staged/<slug>/vN snapshots & git range-diff           │
│  │     └── get_maintainer.pl + checkpatch.pl + git format-patch            │
│  ├── Import & Skill Bridges (importEngine.ts, prSkillBridge.ts)            │
│  │     ├── b4 am / UndineD mbox import for review/* & maintainer branches  │
│  │     └── Reusable context provider + trigger for existing PR Skill       │
│  └── MCP STDIO Client (src/mcp/mcpClient.ts — vscode-free JSON-RPC 2.0)    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ MCP over STDIO (undined --mcp-stdio)
                                │ [STRICTLY DRAFT-ONLY / NO SMTP SEND]
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ UndineD Daemon & Web UI (companion repo: mhiramat/undined)                 │
│  ├── MCP Tools (Draft / Read / Patchwork ONLY):                            │
│  │     ├── stage_patch_series   -> Saves threaded series in Maildir Drafts │
│  │     ├── create_mail_draft    -> Saves standalone PR / mail draft        │
│  │     ├── export_thread_mbox   -> Exports git-am-ready mbox from Maildir  │
│  │     └── import_patch_series_b4 / update_patchwork_patch (existing)      │
│  └── Web UI (Human Accountability Boundary):                               │
│        └── Review/Edit Staged Series or PR Draft -> Human Clicks Send      │
└────────────────────────────────────────────────────────────────────────────┘
```

### Workspace Layout Additions (Zero `linux/` Pollution)

Durable series data (cover letters, recipient selections, staging logs) **must not** reside in `build/` because developers frequently delete `build/` to force a clean kernel build. Instead, store durable patch-stack metadata under `kdevkit/.kdev/series/` (gitignored in `kdevkit/.gitignore`, completely outside `linux/`).

```text
kdevkit/
├── .gitignore                              # Add `.kdev/` (durable local workspace state)
├── .kdev/                                  # Durable non-kernel workspace state (outside build/ & linux/)
│   └── series/
│       └── <sanitized-branch-name>/
│           ├── series.json                 # Version, base ref, To/Cc, staged history, In-Reply-To
│           ├── cover.md                    # Editable cover letter body (opened in VSCode editor)
│           └── staging/                    # Ephemeral format-patch output before MCP staging
├── docs/
│   ├── DESIGN_PHASE4_PATCHSTACK.md         # This document
│   └── DESIGN_UNDINED_SERIES_DRAFT.md      # Companion UndineD specification
├── extension/
│   └── src/
│       ├── extension.ts                    # Registers PatchStackController alongside Kconfig & Kprobes
│       ├── mcp/
│       │   ├── mcpClient.ts                # [vscode-free] Generic MCP JSON-RPC 2.0 STDIO client
│       │   └── undinedClient.ts            # [vscode-free] Typed wrapper for UndineD MCP tools
│       └── patchstack/
│           ├── types.ts                    # BranchRole, StackCommit, SeriesMetadata, PreflightResult
│           ├── gitRunner.ts                # [vscode-free] Safe execFile/spawn wrapper for `git -C linux`
│           ├── gitStackEngine.ts           # [vscode-free] Pure-Git StGit-equivalent stack engine
│           ├── seriesStore.ts              # [vscode-free] .kdev/series/* persistence & range-diff
│           ├── preflight.ts                # [vscode-free] get_maintainer.pl, checkpatch.pl, format-patch
│           ├── importEngine.ts             # [vscode-free] b4 am / UndineD mbox -> git am -3
│           ├── prSkillBridge.ts            # Context generator & launcher for existing PR skill
│           ├── patchstackController.ts     # VSCode commands, QuickPicks, status bar, rebase watcher
│           └── treeViews.ts                # Branches & Patch Stack TreeDataProviders
└── linux/                                  # Upstream Linux Git repository (100% untouched)
```

---

## 3. Branch Taxonomy & Metadata Contract

### 3.1 Role Classification Rules
Branches in `linux/` are classified automatically by configurable prefix/pattern rules (`kdev.git.*`), with optional per-branch override via `git config branch.<name>.kdev-role`:

| Branch Pattern | Role | Typical Cadence / Purpose | Allowed Operations |
| :--- | :--- | :--- | :--- |
| `topic/*` (configurable via `kdev.git.topicPrefix`) | `topic` | Authoring own patch series | Full stack editing, cover letter, versioning, `range-diff`, stage series to UndineD Drafts |
| `review/*` (configurable via `kdev.git.reviewPrefix`) | `review` | Reviewing / testing incoming patches | Import by Message-ID (`b4` or UndineD MCP), build/boot/test with `kdevkit`, quick discard/cleanup |
| User-configured `kdev.git.maintainerPrefixes` (e.g., `probes/*`, `bootconfig/*`, or flat names like `for-next`) | `maintainer` | Subsystem maintainer queues (`fixes`: ~weekly PR; `for-next`/`core`: merge-window PR) | `b4 am -l -s` ingestion, Patchwork state update, unpublished stack editing, on-demand cross-branch move, Pull Request skill handoff |
| All other branches | `other` | Upstream tracking (`master`, `linux-next`, etc.) | Read-only base selection (never rewritten by stack commands) |

#### Maintainer Branch Customization
* `kdev.git.maintainerPrefixes` defaults to `[]` so contributor-only setups are never tied to any specific subsystem naming convention.
* Each entry in `kdev.git.maintainerPrefixes` matches either a prefix ending in `/` (e.g., `"probes/"` matches `probes/fixes`, `probes/for-next`, `probes/core`) or an exact/glob pattern (e.g., `"for-next"`, `"fixes"` for single-subsystem repos that do not use a slash prefix).
* Developers may also explicitly tag any branch as a maintainer branch via `kdev.git.setBranchRole` (persisted in `branch.<name>.kdev-role = maintainer`).

### 3.2 Maintainer Sub-Cadence Detection (Common Kernel Convention)
Across Linux kernel subsystems, maintainer queues share a common two-track PR cadence regardless of the subsystem prefix. `kdevkit` detects the sub-cadence by matching the trailing branch segment (configurable via `kdev.git.fixesSuffixes` and `kdev.git.nextSuffixes`):

* **`fixes` cadence** (default suffixes: `["fixes", "urgent"]`, e.g., `probes/fixes`, `bootconfig/fixes`, `fixes`): Weekly PR cycle during `-rc` releases; defaults base comparison to `torvalds/master` (or latest `vX.Y-rcN` tag).
* **`for-next` cadence** (default suffixes: `["for-next", "next", "core"]`, e.g., `probes/for-next`, `probes/core`, `bootconfig/for-next`, `for-next`): Merge-window PR cycle for new features and cleanups; defaults base comparison to the branch's configured `kdev-base` or latest release tag (`vX.Y`).
* **`custom` cadence** (any other maintainer branch name): Uses the branch's explicit `kdev-base` without assuming a weekly or merge-window schedule.

### 3.3 Git Config & Private Namespace Refs
All Git-side tracking uses standard `git config` keys and private `refs/kdev/*` refs (which are never pushed by default `git push`):

* **Per-branch Git Config (`linux/.git/config`):**
  * `branch.<name>.kdev-role` = `topic` | `review` | `maintainer`
  * `branch.<name>.kdev-base` = `<base-ref-or-sha>` (e.g., `torvalds/master`, `v6.14-rc1`, or explicit commit SHA)
  * `branch.<name>.kdev-upstream-ref` = `<remote>/<branch>` (used to lock published commits on maintainer branches)
  * `branch.<name>.kdev-version` = integer (`1`, `2`, ...) for `topic/*`
  * `branch.<name>.kdev-source-msgid` = `<msgid>` for `review/*`
* **Private Local Refs:**
  * `refs/kdev/undo/<sanitized-branch>/<seq>` — Pre-operation `HEAD` snapshot for 1-click Undo (`maxUndoHistory = 20`, pruned automatically).
  * `refs/kdev/staged/<sanitized-branch>/v<N>` — Exact commit SHA staged as version `vN` (paired with `baseSha` in `series.json` for `git range-diff`).
  * `refs/kdev/stack-top/<sanitized-branch>` — Optional top-of-stack commit SHA when upper commits are temporarily popped.

---

## 4. Pure-Git Patch Stack Engine (`gitStackEngine.ts`)

`gitStackEngine.ts` must have **zero `vscode` imports** so every history-rewriting operation can be deterministically verified against real ephemeral Git repositories in Vitest.

### 4.1 Stack Inspection
* Resolve `baseSha` via `git merge-base <configured-base> HEAD` (falling back to explicit SHA if `kdev-base` is a commit hash).
* List commits bottom-to-top using `git rev-list --reverse --format=... <baseSha>..HEAD`.
* Detect active Git state: `.git/rebase-merge`, `.git/rebase-apply`, `.git/CHERRY_PICK_HEAD`, and working tree cleanliness (`git status --porcelain`).
* For maintainer branches with `kdev-upstream-ref`, compute the set of already-published commits using `git rev-list <baseSha>..<upstream-ref>` and mark each matching `StackCommit.published = true`.

### 4.2 Arbitrary Commit Update & Dependent Rebase (`stg refresh` Equivalent)
When the developer modifies files in `linux/` and selects **Refresh into Commit `<target>`**:
1. **Safety Checks:**
   * If `target.published === true`, abort unless the user explicitly confirmed the Published Commit Override dialog.
   * Ensure there are staged changes (or prompt to stage all tracked modifications, matching `git add -u`).
   * Verify no rebase is currently in progress.
2. **Undo Snapshot:** Record current `HEAD` to `refs/kdev/undo/<branch>/<nextSeq>` with metadata `{ op: 'refresh', targetSha, timestamp }`.
3. **Execute Fixup + Autosquash:**
   * If `targetSha === HEAD`: simply run `git commit --amend --no-edit` (fast path, zero rebase needed).
   * If `targetSha !== HEAD`:
     1. Run `git commit --fixup=<targetSha>`.
     2. Run `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --autostash <baseSha>`.
4. **Conflict Handling:**
   * If rebase exits non-zero with conflict state (`.git/rebase-merge` exists), return `{ status: 'conflict', conflictingFiles }`.
   * The VSCode UI transitions the Stack View header to **`Rebase in Progress (Conflicts)`** with inline buttons: **Open Merge Editor**, **Continue Rebase** (`GIT_EDITOR=true git rebase --continue`), **Skip**, and **Abort** (`git rebase --abort`).

### 4.3 Non-Interactive Stack Mutations (`reorder`, `drop`, `reword`, `squash`, `split`)
To mutate commit order or drop/squash commits without opening a terminal editor:
* Generate a tiny Node.js helper script path passed via `GIT_SEQUENCE_EDITOR` and an environment variable `KDEV_REBASE_TODO_FILE` pointing to the exact rewritten `git-rebase-todo` sequence.
* Run `git rebase -i --autostash <baseSha>`.
* For `reword`, pass `GIT_EDITOR` pointing to a script that writes the user-edited commit message file (edited cleanly inside a VSCode text buffer).
* Every mutation creates a `refs/kdev/undo/<branch>/<seq>` snapshot immediately before execution.

### 4.4 Undo / Redo Stack (`stg undo` Equivalent)
* **`undo()`:** Requires a clean working tree (or offers automatic `git stash push`). Reads the latest `refs/kdev/undo/<branch>/<seq>`, saves current `HEAD` into an in-memory/ref redo slot, executes `git reset --hard <undoSha>`, and deletes the consumed undo ref.
* **`pop(count)` / `push(count)` (Optional Stack Navigation):**
  * `pop(k)`: Saves current tip in `refs/kdev/stack-top/<branch>` (if not already set) and resets `HEAD` to `HEAD~k`.
  * `push(k)`: Cherry-picks the next `k` commits from `HEAD..refs/kdev/stack-top/<branch>` onto `HEAD`, updating or clearing `stack-top` when the full stack is re-applied.

### 4.5 On-Demand Cross-Branch Patch Move (`kdev.git.movePatchesToBranch`)
Because moving patches between maintainer branches (for example, `probes/for-next` → `probes/fixes`) is occasional rather than daily, it is exposed as an on-demand context-menu action on unpublished commits rather than primary toolbar clutter.

**Transactional Algorithm (Zero Data Loss Guarantee):**
1. Validate that all selected commits are unpublished on the source branch (`!published`), the working tree is clean, and the target branch exists.
2. Create Undo snapshots on **both** `sourceBranch` and `targetBranch`.
3. Record exact commit SHAs `[c1, ..., ck]` in chronological order.
4. Checkout `targetBranch` and run `git cherry-pick c1 ... ck`.
   * If cherry-pick fails with conflicts: immediately run `git cherry-pick --abort`, switch back to `sourceBranch`, and report the conflict cleanly (**source branch remains 100% untouched**).
5. On clean cherry-pick success: checkout `sourceBranch` and drop `[c1, ..., ck]` via scripted `git rebase -i <sourceBase>`, automatically rebasing remaining commits above them.
6. If step 5 hits a conflict on dependent commits in `sourceBranch`, pause in standard VSCode rebase-conflict mode (with a clear notice that `targetBranch` already received the commits and Undo is available on both branches).

---

## 5. Topic Series Management & UndineD Draft Staging

### 5.1 Series Metadata Schema (`.kdev/series/<sanitized-branch>/series.json`)
```json
{
  "schemaVersion": 1,
  "branch": "topic/fprobe-cleanup",
  "version": 2,
  "subjectPrefix": "PATCH",
  "baseRef": "torvalds/master",
  "recipients": {
    "to": ["Steven Rostedt <rostedt@goodmis.org>"],
    "cc": ["linux-kernel@vger.kernel.org", "linux-trace-kernel@vger.kernel.org"]
  },
  "inReplyTo": null,
  "stagedHistory": [
    {
      "version": 1,
      "stagedAt": "2026-11-18T09:15:00Z",
      "baseSha": "a1b2c3d4...",
      "headSha": "e5f60718...",
      "gitRef": "refs/kdev/staged/topic__fprobe-cleanup/v1",
      "undinedSeriesId": "ser_01J...",
      "coverMessageId": "<20261118091500.12345-1-mhiramat@kernel.org>"
    }
  ]
}
```

### 5.2 Cover Letter Editor & Automatic `range-diff`
* Command `kdev.git.editCoverLetter` opens `.kdev/series/<slug>/cover.md` directly in VSCode.
* Default template includes:
  * Subject line (`Subject: ...` first line or structured header block).
  * Series overview prose.
  * `Changes in vN:` section.
* Command `kdev.git.bumpSeriesVersion`:
  1. Increments `version` (`vN` → `vN+1`).
  2. Looks up the previous staged snapshot (`refs/kdev/staged/<slug>/vN` and its `baseSha`).
  3. Runs `git range-diff <prevBase>..<prevHead> <currBase>..HEAD`.
  4. Offers to append the formatted `range-diff` output into `cover.md` under `Changes in vN+1:`.

### 5.3 Preflight Checks (`preflight.ts`)
Before staging drafts into UndineD, `kdevkit` runs an automated preflight panel / quick-summary:
1. **Recipients (`get_maintainer.pl`):**
   * Runs `linux/scripts/get_maintainer.pl --no-rolestats` against generated patches (or `git diff <base>..HEAD`).
   * Merges discovered addresses with saved `series.json` recipients and presents a multi-select QuickPick (or Webview checklist) to confirm `To` vs. `Cc`.
2. **Code Style & Trailers (`checkpatch.pl`):**
   * Runs `linux/scripts/checkpatch.pl --strict --git <base>..HEAD` (configurable flags).
   * Verifies every commit contains a `Signed-off-by:` trailer.
   * Surfaces warnings/errors in VSCode's Problems/Output panel without hard-blocking RFC drafts.

### 5.4 Staging Patch Series into UndineD Drafts (No SMTP Send)
Command `kdev.git.stageSeriesToUndineD`:
1. Runs `git format-patch --base=<baseSha> --subject-prefix="<prefix>" -v <N> --cover-letter -o <stagingDir> <baseSha>..HEAD` (omitting `-v 1` when `version === 1`; omitting `--cover-letter` for single-patch series unless user enabled `forceCoverLetter`).
2. Merges the subject and body from `.kdev/series/<slug>/cover.md` into `0000-cover-letter.patch` while preserving the auto-generated shortlog, diffstat, and `base-commit:` trailer.
3. Parses each formatted `.patch` file into `{ index, subject, body, commitSha }` with **exact UTF-8 and raw `\t` tab preservation** (zero line re-wrapping).
4. Invokes UndineD MCP tool **`stage_patch_series`** via `UndineDMcpClient`.
5. Records snapshot ref `refs/kdev/staged/<slug>/v<N>` and appends an entry to `series.json`.
6. Shows a VSCode notification:
   > *"Staged v2 (5 patches + cover letter) to UndineD Drafts. Review and send in UndineD Web UI."*
   with an **"Open in UndineD"** button launching the returned `web_url` in the browser.

---

## 6. Review Import, Maintainer Ingestion & PR Skill Reuse

### 6.1 `review/*` Branch Import (`importEngine.ts`)
Command `kdev.git.importReviewBranch` (also callable via CLI helper for AI skills):
1. Prompts for a **Message-ID** or **lore.kernel.org URL** (auto-detecting clipboard if it looks like a Message-ID or lore URL).
2. Fetches mbox via configurable source (`kdev.git.importSource`: `"undined-mcp"` | `"b4"`):
   * **`undined-mcp` (preferred when UndineD is configured):** Calls `import_patch_series_b4` (if not already cached) followed by `export_thread_mbox` so UndineD's local Maildir archive and review context stay synchronized.
   * **`b4` (standalone fallback):** Runs `b4 am -o <tmp.mbx> <msgid>`.
3. Inspects mbox for `base-commit: <sha>` trailer (falling back to `b4 am --guess-base` or prompting the user to pick a base branch/tag).
4. Creates `review/<sanitized-subject-or-slug>` at `baseCommit`, stores `kdev-role=review` and `kdev-source-msgid=<msgid>`, and applies via `git am -3 <tmp.mbx>`.
5. On `git am` conflict, leaves the repository in standard `am` conflict state and displays **Continue / Skip / Abort** controls in the Stack View.

> **Skill Integration:** A lightweight workspace skill (e.g., `.agents/skills/kdev-review-import/`) can orchestrate reading UndineD thread feedback, calling the exact same `importEngine` CLI/command, and chaining directly into the existing `.agents/skills/kdev-build-and-boot` skill for automated QEMU selftest verification.

### 6.2 Maintainer Branch Ingestion (Configured Maintainer Branches)
Command `kdev.git.applyToMaintainerBranch`:
1. Target branch defaults to the active branch if it is classified as `maintainer` (via `kdev.git.maintainerPrefixes` or explicit `kdev-role=maintainer`); otherwise prompts to pick among configured maintainer branches (e.g., `probes/fixes`, `probes/for-next`, `bootconfig/fixes`, `bootconfig/for-next`).
2. Fetches patch/series using `b4 am -l -s -o <tmp.mbx> <msgid>` so:
   * `Link: https://lore.kernel.org/all/<msgid>` is automatically attached.
   * `Reviewed-by:`, `Acked-by:`, and `Tested-by:` trailers from the thread are collected.
   * Maintainer's `Signed-off-by:` is appended automatically.
3. Saves an Undo snapshot (`refs/kdev/undo/<branch>/<seq>`) and runs `git am -3 <tmp.mbx>`.
4. Shows a post-apply summary of applied commits and, when UndineD MCP is active, offers a 1-click button to invoke `update_patchwork_patch` (setting Patchwork state to `accepted` or `under-review`).

### 6.3 Reusing the Existing Pull Request Skill (`prSkillBridge.ts`)
Because the developer already maintains a dedicated Pull Request creation skill, `kdevkit` avoids hardcoding a competing PR text generator and instead integrates cleanly with the existing skill:

1. **Structured PR Context Generator (`kdev.git.preparePullRequestContext`):**
   * Given any configured maintainer branch (e.g., `probes/fixes` or `probes/for-next`), collects and validates:
     * `branch`, `subsystem` (derived from matched prefix, e.g., `probes` / `bootconfig`, or empty for flat branches), `cadence` (`fixes` / `for-next` / `custom`),
     * `baseRef`, `baseSha`, `headSha`, `commitCount`,
     * `existingSignedTags` pointing at `HEAD`,
     * `remotePushStatus` (checks `git ls-remote <publicRemote>` to flag if the branch or signed tag is not yet pushed),
     * `shortlog` and `diffstat` preview.
   * Writes this JSON context to `.kdev/pr-context.json` (and copies/passes it cleanly to the skill).
2. **Configurable PR Skill Launcher (`kdev.git.runPullRequestSkill`):**
   * Configured via `kdev.git.prSkillCommand` (e.g., invoking the user's agent CLI with the existing PR skill name, or opening an integrated VSCode terminal / agent prompt pre-filled with the branch & context path).
   * Example default template:
     ```json
     "kdev.git.prSkillCommand": ""
     ```
     When empty, `kdev.git.runPullRequestSkill` copies the prepared prompt + `.kdev/pr-context.json` path and prompts the user to configure their preferred skill runner command.
3. **Shared UndineD MCP Draft Target:**
   * The existing PR skill (running inside the user's AI agent with UndineD MCP attached) calls UndineD MCP's new **`create_mail_draft`** tool to place the generated Linus Pull Request email into UndineD's `Drafts` folder (strict plain-text, zero automatic SMTP sending).
   * The human developer then inspects the PR draft in UndineD Web UI and sends it manually.

---

## 7. Extension Manifest, Settings & UI Design

### 7.1 Configuration (`kdev.git.*` & `kdev.undined.*`)
Add to `kdevkit/extension/package.json`:

| Setting Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `kdev.git.topicPrefix` | `string` | `"topic/"` | Prefix identifying developer topic series branches |
| `kdev.git.reviewPrefix` | `string` | `"review/"` | Prefix identifying incoming review branches |
| `kdev.git.maintainerPrefixes` | `string[]` | `[]` | User-defined branch prefixes or names for maintainer queues (e.g., `["probes/", "bootconfig/"]`). Empty by default for contributor-only setups. |
| `kdev.git.fixesSuffixes` | `string[]` | `["fixes", "urgent"]` | Branch suffixes classified under the weekly `fixes` PR cadence |
| `kdev.git.nextSuffixes` | `string[]` | `["for-next", "next", "core"]` | Branch suffixes classified under the merge-window `for-next` PR cadence |
| `kdev.git.stateDir` | `string` | `".kdev/series"` | Durable metadata directory (relative to workspace root, outside `linux/` and `build/`) |
| `kdev.git.b4Bin` | `string` | `"b4"` | Path to `b4` executable |
| `kdev.git.importSource` | `string` | `"undined-mcp"` | Default mbox source (`"undined-mcp"` or `"b4"`) |
| `kdev.git.prSkillCommand` | `string` | `""` | Command template to invoke the user's existing Pull Request skill (`{branch}`, `{contextFile}`, `{kernelDir}`) |
| `kdev.undined.bin` | `string` | `"undined"` | Path to `undined` binary for MCP STDIO (`--mcp-stdio`) |
| `kdev.undined.configPath` | `string` | `""` | Optional `--config` path passed to `undined` |
| `kdev.undined.webBaseUrl` | `string` | `"http://127.0.0.1:8080"` | UndineD Web UI URL for "Open Draft in UndineD" links |

#### Sample Workspace Settings (`.vscode/settings.json`)
Below is an illustrative example for a maintainer managing `probes/*` and `bootconfig/*` branches:
```json
{
  "kdev.git.topicPrefix": "topic/",
  "kdev.git.reviewPrefix": "review/",
  "kdev.git.maintainerPrefixes": ["probes/", "bootconfig/"],
  "kdev.git.fixesSuffixes": ["fixes", "urgent"],
  "kdev.git.nextSuffixes": ["for-next", "next", "core"]
}
```

### 7.2 Activity Bar Views (`kdevExplorer`)
Add two focused TreeViews inside the existing `kdevExplorer` container:
1. **`Kernel Branches` (`kdev.git.branchesView`):**
   * Grouped into collapsible categories: **Topics (`topic/*`)**, **Reviews (`review/*`)**, and **Maintainer** (populated from `kdev.git.maintainerPrefixes` and explicitly tagged `kdev-role=maintainer` branches; shows a quick "Configure Maintainer Branches..." action when empty).
   * Shows active branch indicator, patch count (`+5`), version badge (`v2`), cadence badge (`fixes` / `for-next`), and context actions (`New Topic Branch`, `Import Review Branch`, `Checkout`, `Set Branch Role`, `Run PR Skill`).
2. **`Patch Stack` (`kdev.git.stackView`):**
   * Displays commits from `base..HEAD` for the active branch (top-of-stack at top, matching StGit/patch-queue intuition, or configurable order).
   * Per-commit icons:
     * `$(lock)` — Published on upstream remote (maintainer guard active).
     * `$(git-commit)` — Editable local stack commit.
     * `$(warning)` — Missing `Signed-off-by:` or checkpatch error.
   * Inline / context actions: **Refresh Changes into Commit**, **Edit Message**, **Move Up / Down**, **Drop Commit**, **Move to Another Branch...**, **Undo Stack Operation**.
   * Title bar actions (role-adaptive): **Edit Cover Letter**, **Bump Version (`range-diff`)**, **Run Preflight**, **Stage Series to UndineD Drafts** (on `topic/*`); **Apply Patch (`b4 -l -s`)**, **Run PR Skill** (on maintainer branches).

---

## 8. Phased Implementation Plan & Verification Strategy

### Implementation Milestones
1. **Milestone 4A — Pure-Git Patch Stack Core (`kdevkit/extension`)**
   * Implement `gitRunner.ts`, `gitStackEngine.ts`, `treeViews.ts`, and `patchstackController.ts`.
   * Support customizable branch categorization (`topic/*`, `review/*`, user-defined `kdev.git.maintainerPrefixes` with common `fixes`/`for-next` cadence detection), arbitrary commit refresh (`--fixup` + `--autosquash`), reorder/drop/reword, conflict continue/abort, Undo snapshots, published-commit lock, and on-demand cross-branch move.
2. **Milestone 4B — Series Store, Preflight & Import (`kdevkit/extension`)**
   * Implement `seriesStore.ts`, `preflight.ts` (`get_maintainer.pl`, `checkpatch.pl`, `format-patch`), `importEngine.ts` (`b4 am`), and `prSkillBridge.ts` (context export + existing PR skill hook).
3. **Milestone 4C — UndineD MCP Client Integration (`kdevkit/extension` + `undined`)**
   * Implement `mcpClient.ts` and `undinedClient.ts` connecting to `undined --mcp-stdio` once the companion UndineD MCP tools (`stage_patch_series`, `create_mail_draft`, `export_thread_mbox`) are available.
   * Wire `Stage Series to UndineD Drafts`, `export_thread_mbox` review import, and optional post-apply Patchwork status update.

### Automated Test Plan (Vitest)

| Test Layer | Location | Coverage |
| :--- | :--- | :--- |
| **Layer 1: Pure-Git Engine Integration** | `extension/test/integration/gitStackEngine.test.ts` | Runs against ephemeral `mkdtemp` local Git repos (including a bare `origin` remote): verify customizable `maintainerPrefixes` classification (both prefix-style like `probes/*` and flat names like `for-next`) plus `fixes`/`for-next` cadence detection; create `topic/*`, commit 3 patches, refresh patch #1 and assert #2/#3 auto-rebase cleanly; force conflict on refresh and verify `conflict -> resolve -> continue` and `conflict -> abort`; verify Undo restores exact prior SHA; verify published-commit guard blocks mutation on a pushed maintainer commit (e.g., `probes/fixes`); verify transactional cross-branch move succeeds cleanly AND leaves source untouched on cherry-pick conflict. |
| **Layer 2: Series & Preflight Unit Tests** | `extension/test/unit/seriesStore.test.ts`, `preflight.test.ts` | Cover letter merge preserving raw `\t` tabs; `v1 -> v2` snapshot ref creation and `git range-diff` output; `get_maintainer.pl` and `checkpatch.pl` output parsing; `.kdev/series/` path sanitization. |
| **Layer 3: MCP STDIO Client & Draft-Only Contract** | `extension/test/unit/mcpClient.test.ts`, `extension/test/integration/undinedMcp.test.ts` | Chunked NDJSON framing, request correlation, timeout, crash recovery; real `undined --mcp-stdio` round-trip confirming `stage_patch_series` writes drafts into Maildir `Drafts` and **never** attempts SMTP delivery. |
| **Layer 4: Workspace Hygiene Acceptance** | CI / Smoke check | After full workflow (topic creation, refresh, format-patch, staging, review import, maintainer apply), assert `git -C linux status --porcelain` is empty and no `.kdev/` or staging files exist inside `linux/`. |