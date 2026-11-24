# Linux Kernel Dev Suite (`kdevkit` VSCode Extension)

Unified VSCode extension for the `kdevkit` parent workspace. It provides:

1. **Kconfig SAT-Solver Editor**: Interactive dependency resolution, pinned layer protection, and automatic `clangd` `#ifdef CONFIG_*` refresh.
2. **Editor-Driven Kprobes & Tracefs Visualization**: Offline host-side `perf probe` DWARF analysis, automatic QEMU Tracefs script generation, and watchpoint-style trace inspection directly inside C kernel sources.
3. **StGit-Free Patch Stack, Series & Maintainer Workflow**: Pure-Git commit stack editing (`refresh`, `reorder`, `drop`, `reword`, `pop`/`push`, 1-click `undo`), role-based branch management (`topic/*`, `review/*`, customizable maintainer queues), preflight (`checkpatch.pl`, `get_maintainer.pl`), and draft-only UndineD MCP staging (`stage_patch_series`).

---

## Prerequisites

* **Parent Workspace**: Open the `kdevkit/` root directory (not `linux/` directly) in VSCode.
* **Built Kernel with DWARF & Tracing**: `build/current/vmlinux` built with `CONFIG_DEBUG_INFO_REDUCED=n`, `CONFIG_KPROBES=y`, `CONFIG_KPROBE_EVENTS=y`, and `CONFIG_FTRACE=y` (configured automatically by `./setup.sh --configure` + `./scripts/build_kernel.sh`).
* **Host `perf` Binary**: `perf` compiled with DWARF (`libdw`/`libelf`) support. If `/usr/bin/perf` is a kernel-version-locked wrapper, set `kdev.perfBin` to `/usr/lib/linux-tools-<ver>/perf` or a locally built `tools/perf/perf`.
* **Git >= 2.38, `b4`, and `undined` (Optional for Phase 4)**: Required for patch-stack operations, lore Message-ID imports (`b4 am`), and staging patch series drafts into UndineD via MCP STDIO (`undined --mcp-stdio`).

---

## Installation (Local Development)

From the `kdevkit/` workspace root:

```bash
./setup.sh --setup-backend --setup-frontend
./scripts/install_extension.sh
```

Then open the Command Palette (`Ctrl+Shift+P`) and run **`Developer: Reload Window`**.

---

## Using the Kprobes & Tracefs Features

### 1. Place a Line Kprobe or Function Return Probe (`kretprobe`)

1. Open any C source file under `linux/` (for example, `linux/fs/open.c`).
2. Move the cursor to a target statement or inside a function, right-click in the editor, and choose:
   * **`kdev: Add Kprobe at Cursor`** (`kdev.kprobe.addAtCursor`):
     1. Queries `perf probe -V` against `build/current/vmlinux` and lets you pick local variables in scope.
     2. Optionally enter space-separated custom expressions (e.g., `file->f_flags`).
     3. Resolves Tracefs definitions via `perf probe -D`. If compiler optimization eliminated the exact line, the extension runs `perf probe -L` and presents nearby probeable lines in a QuickPick.
   * **`kdev: Add Return Probe ($retval)`** (`kdev.kprobe.addReturnProbe`):
     1. Auto-detects the enclosing C function name (editable in the prompt).
     2. Captures `$retval` by default plus any optional custom expressions.
3. The extension updates:
   * `build/current/shared/probes.json` (persistent probe definitions)
   * `build/current/shared/setup_kprobes.sh` (executable POSIX Tracefs setup script)
   * Editor gutter icons and inline virtual text annotations.

### 2. Run QEMU & Collect Trace Events

Run the Phase 1 QEMU task (**`kdev: Run QEMU`** or `./scripts/run_qemu.sh`):

1. Guest `/init` mounts the 9p share at `/mnt/host` and automatically executes `/mnt/host/setup_kprobes.sh`.
2. Run your workload or interactive commands inside the guest, then `exit`.
3. Before poweroff, `/init` copies `/sys/kernel/tracing/trace` to `build/current/shared/trace.log`.

### 3. Inspect Trace Events in VSCode

When `kdev.kprobe.autoLoadTrace` is enabled (default), VSCode detects `build/current/shared/trace.log` automatically and refreshes the **kdevkit** Activity Bar (`$(pulse)` icon):

* **`Configured Kprobes` view**: Lists all probes with captured variables and hit counts.
  * Inline buttons: **Toggle Enabled** (`$(eye)`) and **Delete** (`$(trash)`).
  * Context menu: **Edit Kprobe Variables**.
  * Title bar actions: **Re-resolve All Kprobes**, **Export Tracefs Setup Script**, **Clear All Kprobes**.
* **`Trace Events` view**: Chronological list of parsed Tracefs events.
  * Click any event to jump to its `linux/<file>:<line>` and highlight its captured values inline on that line:
    `◀ [SELECTED #4/12 @ 12.345678s] sh-142 | dfd=0x3 flags=0x8000`
  * Use **`kdev: Filter Trace Events`** in the title bar to filter by probe ID or substring.
* **Editor Hover**: Hover over a probed line to see the Tracefs definition, the **most recent 10 hits** in a table, and quick links to **Re-resolve** or **Remove**.

### 4. Handling Kernel Rebuilds & Source Edits

* **Gutter Icon States**:
  * **Amber diamond**: Valid and enabled.
  * **Hollow gray circle**: Disabled (skipped when generating `setup_kprobes.sh`).
  * **Warning triangle**: Stale or error (line shifted by edits, or `build/current/vmlinux` was rebuilt).
* When `build/current/vmlinux` changes, VSCode marks affected probes as **STALE** and prompts with a **"Re-resolve Now"** button (`kdev.kprobe.reResolveAll`) to re-run `perf probe -D` and regenerate `setup_kprobes.sh`.

---

## Using the Kconfig Editor

Open the Command Palette (`Ctrl+Shift+P`) and run:

* **`Kernel Dev: Open Kconfig Editor`** (`kdev.openKconfigEditor`)
* **`Kernel Dev: Restart Kconfig Backend`** (`kdev.restartKconfigBackend`)

---

## Using the Patch Stack, Series & Maintainer Workflow

Open the **kdevkit** Activity Bar (`$(pulse)` icon) to access **`Kernel Branches`** (`kdev.git.branchesView`) and **`Patch Stack`** (`kdev.git.stackView`). All durable series metadata (`series.json`, `cover.md`) is stored under `.kdev/series/` outside `linux/` and `build/`.

### 1. Branch Roles & Maintainer Queues

* **Topics (`topic/*`)**: Create via **`kdev: New Topic Branch`** (`kdev.git.newTopicBranch`).
* **Reviews (`review/*`)**: Import incoming lore threads by Message-ID or URL via **`kdev: Import Review Branch by Message-ID`** (`kdev.git.importReviewBranch`) using UndineD MCP (`export_thread_mbox`) or `b4 am`.
* **Maintainer Branches**: Configure `kdev.git.maintainerPrefixes` (e.g., `["probes/", "bootconfig/"]` or flat names like `"for-next"`) via **`kdev: Configure Maintainer Branches...`** or tag individual branches via **`kdev: Set Branch Role`**. Suffixes matching `kdev.git.fixesSuffixes` / `kdev.git.nextSuffixes` automatically show `fixes` / `for-next` cadence badges.

### 2. Pure-Git Stack Editing (`StGit` Equivalent)

In **`Patch Stack`** (commits from `base..HEAD`, top-of-stack at top):

* **Refresh into arbitrary commit**: Edit files in `linux/`, then click **`Refresh Changes into Commit`** on any commit (`--amend` on HEAD, or `--fixup` + `git rebase -i --autosquash --autostash` on lower commits).
* **Reorder / Reword / Drop / Pop / Push**: Use inline or context-menu actions (`Move Up`, `Move Down`, `Edit Commit Message`, `Drop Commit`, `Pop`/`Push`).
* **1-Click Undo**: Every stack mutation saves a `refs/kdev/undo/<branch>/<seq>` snapshot; run **`kdev: Undo Stack Operation`** to restore the exact prior `HEAD`.
* **Conflict Controls**: When a rebase or `git am` hits a conflict, the Stack View displays **Continue**, **Skip**, and **Abort** actions.
* **Published-Commit Guard & Cross-Branch Move**: Commits reachable from `branch.<name>.kdev-upstream-ref` show a `$(lock)` badge and require explicit override confirmation before rewriting. Unpublished commits can be moved transactionally to another branch via **`kdev: Move Commit(s) to Another Branch...`**.

### 3. Topic Series Preflight & Draft Staging to UndineD

* **`kdev: Edit Series Cover Letter`**: Opens `.kdev/series/<slug>/cover.md` in VSCode.
* **`kdev: Bump Series Version (range-diff)`**: Increments `vN -> vN+1` and offers to append `git range-diff` against the previous staged snapshot (`refs/kdev/staged/<slug>/vN`).
* **`kdev: Run Series Preflight`**: Runs `scripts/get_maintainer.pl`, `scripts/checkpatch.pl --strict`, and `Signed-off-by:` checks (populating the Problems panel).
* **`kdev: Stage Patch Series to UndineD Drafts`**: Formats patches with `--base`, merges `cover.md`, confirms `To`/`Cc`, and calls UndineD MCP `stage_patch_series` (strictly **Draft-Only**; never invokes `git send-email` or SMTP). Review and send manually from the UndineD Web UI.

### 4. Maintainer Ingestion & Pull Request Skill Integration

* **`kdev: Apply Patch to Maintainer Branch (b4 -l -s)`**: Fetches via `b4 am -l -s`, creates an Undo snapshot, applies via `git am -3`, and offers 1-click Patchwork status update (`update_patchwork_patch`).
* **`kdev: Prepare Pull Request Context`** / **`kdev: Run Pull Request Skill`**: Exports `.kdev/pr-context.json` (cadence, base/head SHAs, signed tags, `git ls-remote` push status, shortlog, diffstat) and launches your configured `kdev.git.prSkillCommand` (or copies the prompt + context path to the clipboard).

---

## Configuration Reference

| Setting | Default | Description |
| --- | --- | --- |
| `kdev.kernelSrcDir` | `"linux"` | Kernel source directory relative to workspace root. |
| `kdev.buildDir` | `"build/current"` | Out-of-tree kernel build directory relative to workspace root. |
| `kdev.arch` | `"x86_64"` | Target kernel architecture. |
| `kdev.perfBin` | `"perf"` | Host `perf` binary path or command name. |
| `kdev.kprobe.traceGroup` | `"kdev"` | Tracefs event group prefix (`events/<group>/`). |
| `kdev.kprobe.maxTraceEvents` | `10000` | Max trace events retained per `trace.log` load. |
| `kdev.kprobe.autoLoadTrace` | `true` | Automatically reload `trace.log` when updated by QEMU. |
| `kdev.pythonPath` | `"backend/.venv/bin/python"` | Python interpreter for the Kconfig backend. |
| `kdev.autoRestartClangd` | `true` | Restart `clangd` automatically after applying Kconfig changes. |
| `kdev.git.topicPrefix` | `"topic/"` | Branch prefix for developer topic series. |
| `kdev.git.reviewPrefix` | `"review/"` | Branch prefix for incoming patch reviews. |
| `kdev.git.maintainerPrefixes` | `[]` | User-defined maintainer branch prefixes or names (e.g. `["probes/", "bootconfig/"]`). |
| `kdev.git.fixesSuffixes` | `["fixes", "urgent"]` | Branch suffixes classified under weekly `fixes` PR cadence. |
| `kdev.git.nextSuffixes` | `["for-next", "next", "core"]` | Branch suffixes classified under merge-window `for-next` PR cadence. |
| `kdev.git.stateDir` | `".kdev/series"` | Durable series metadata directory (relative to workspace root). |
| `kdev.git.b4Bin` | `"b4"` | Path or command name for `b4`. |
| `kdev.git.importSource` | `"undined-mcp"` | Default mbox source for review imports (`"undined-mcp"` or `"b4"`). |
| `kdev.git.prSkillCommand` | `""` | Command template to launch your existing PR skill (`{branch}`, `{contextFile}`, `{kernelDir}`). |
| `kdev.undined.bin` | `"undined"` | Path or command name for `undined` (`--mcp-stdio`). |
| `kdev.undined.configPath` | `""` | Optional `--config` path passed to `undined`. |
| `kdev.undined.webBaseUrl` | `"http://127.0.0.1:8080"` | UndineD Web UI base URL for "Open in UndineD" links. |

---

## Running Extension Tests

```bash
cd extension
npm run typecheck
npm run build
npm run test:unit
npx vitest run test/integration/perfVmlinux.test.ts
npx vitest run test/integration/gitStackEngine.test.ts test/integration/undinedMcp.test.ts
```
