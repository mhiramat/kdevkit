# Linux Kernel Dev Suite (`kdevkit` VSCode Extension)

Unified VSCode extension for the `kdevkit` parent workspace. It provides:

1. **Kconfig SAT-Solver Editor**: Interactive dependency resolution, pinned layer protection, and automatic `clangd` `#ifdef CONFIG_*` refresh.
2. **Editor-Driven Kprobes & Tracefs Visualization**: Offline host-side `perf probe` DWARF analysis, automatic QEMU Tracefs script generation, and watchpoint-style trace inspection directly inside C kernel sources.

---

## Prerequisites

* **Parent Workspace**: Open the `kdevkit/` root directory (not `linux/` directly) in VSCode.
* **Built Kernel with DWARF & Tracing**: `build/current/vmlinux` built with `CONFIG_DEBUG_INFO_REDUCED=n`, `CONFIG_KPROBES=y`, `CONFIG_KPROBE_EVENTS=y`, and `CONFIG_FTRACE=y` (configured automatically by `./setup.sh --configure` + `./scripts/build_kernel.sh`).
* **Host `perf` Binary**: `perf` compiled with DWARF (`libdw`/`libelf`) support. If `/usr/bin/perf` is a kernel-version-locked wrapper, set `kdev.perfBin` to `/usr/lib/linux-tools-<ver>/perf` or a locally built `tools/perf/perf`.

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

---

## Running Extension Tests

```bash
cd extension
npm run typecheck
npm run build
npm run test:unit
npx vitest run test/integration/perfVmlinux.test.ts
```
