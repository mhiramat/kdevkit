# Design & Implementation Specification: Phase 2 — Editor-Driven Kprobes & Tracefs Visualization (`DESIGN_PHASE2_KPROBES.md`)

## 1. Overview & Objectives

This document specifies the design, TypeScript implementation architecture, and test plan for **Phase 2** of **`kdevkit`**: editor-driven Kprobes configuration, offline `perf probe` DWARF analysis, automated QEMU Tracefs deployment, and trace event visualization inside VSCode.

Phase 2 is implemented as the first functional module inside the unified `kdevkit/extension/` VSCode extension package (`name: "kdevkit"`, configuration/command prefix `kdev.*`), designed to connect directly to the Phase 1 `build/current/shared/` interface contract while remaining cleanly extensible for Phase 3 (Kconfig frontend, Selftest Testing API, and Webview time-series plotting).

### Core Objectives

* **Editor-Native Kprobe & Kretprobe Placement:** Allow developers to register Kprobes on arbitrary C source lines (and Kretprobes on function returns) directly from the VSCode editor under `kdevkit/linux/`, without modifying any files inside the kernel Git tree.


* **Host-Side Offline DWARF Analysis (`perf probe`):** Resolve local variables (`perf probe -V`), probeable fallback lines (`perf probe -L`), and Tracefs event definitions (`perf probe -D`) exclusively on the host using `build/current/vmlinux`, keeping the QEMU guest minimal with zero `perf` binary or DWARF payload.
* **Seamless Phase 1 Tracefs Handoff:** Emit `build/current/shared/setup_kprobes.sh` and `probes.json` so Phase 1's guest `/init` automatically registers and enables probes in `/sys/kernel/tracing` before running an interactive shell or kselftest.
* **Automatic Trace Ingestion & Watchpoint-Style Inspection:** Watch `build/current/shared/trace.log` for updates after QEMU exits, parse events back to their originating source lines, list them in a dedicated side pane (`Trace Events`) with click-to-jump navigation, and render watchpoint-style inline values and hover hit histories directly in the code editor.
* **Rebuild Resilience:** Detect `vmlinux` rebuilds, flag potentially stale probe offsets, and support one-click batch re-resolution (`kdev.kprobe.reResolveAll`).

### Non-Goals (Deferred to Phase 3)

* Webview time-series / latency plotting (Phase 2 prepares structured `TraceEvent` data and `ProbeStore` subscriptions so the plotter plugs in without refactoring).
* VSCode Testing API (`TestController`) wrapper for `tools/testing/selftests/`.
* Kconfig dependency solver Webview UI (specified in `DESIGN_KCONFIG_FRONTEND.md`).

---

## 2. Host Prerequisites

| Requirement | Details / Verification |
| --- | --- |
| **Phase 1 Workspace** | `kdevkit/` with `build/current/vmlinux` (full DWARF, `CONFIG_DEBUG_INFO_REDUCED=n`, `CONFIG_KPROBES=y`, `CONFIG_KPROBE_EVENTS=y`, `CONFIG_FTRACE=y`) and `build/current/shared/` 9p mount verified. |
| **Host `perf` Tool** | `perf` compiled with DWARF (`libdw`/`libelf`) support, supporting `-k`, `-s`, `-V`, `-L`, and `-D` flags. Verify via `perf probe --help`. *(Note: On distributions where `/usr/bin/perf` is a kernel-version-locked wrapper, point `kdev.perfBin` directly to `/usr/lib/linux-tools-<ver>/perf` or a kernel-tree-built `tools/perf/perf`.)* |
| **Node.js & VSCode** | Node.js `>= 20`, VSCode `>= 1.90.0`. |

---

## 3. Unified Extension Architecture & Directory Layout

Phase 2 initializes `kdevkit/extension/` as the single extension host package for all `kdevkit` VSCode features. Pure Node.js domain logic (`perfProbe.ts`, `traceParser.ts`, `probeStore.ts`) is strictly decoupled from the `vscode` API so it can be unit- and integration-tested via Vitest without launching Electron.

```text
kdevkit/                              # Parent workspace root (Git repo for kdevkit)
├── DESIGN.md                         # Phase 1 design
├── DESIGN_PHASE2_KPROBES.md          # This document
├── build/current/
│   ├── vmlinux                       # [Input] DWARF symbol source for perf probe
│   └── shared/                       # [Phase 1 <-> Phase 2 9p Contract]
│       ├── setup_kprobes.sh          # [Output] Generated POSIX Tracefs script
│       ├── probes.json               # [State] Persisted Kprobe definitions & metadata
│       └── trace.log                 # [Input] Tracefs output dumped by guest /init
├── extension/                        # Unified VSCode extension (Phase 2 + future Phase 3)
│   ├── package.json                  # name: "kdevkit", commands/views/settings: kdev.*
│   ├── tsconfig.json
│   ├── esbuild.mjs                   # Fast CJS bundle for dist/extension.js
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── extension.ts              # Unified activation entrypoint
│   │   ├── shared/
│   │   │   └── workspacePaths.ts     # Resolves wsRoot, linux/, build/current, shared/, vmlinux
│   │   └── kprobe/
│   │       ├── types.ts              # KprobeSpec, TraceEvent, AvailableVar, ProbeableLine
│   │       ├── perfProbe.ts          # [vscode-free] perf probe -V/-L/-D & setup_kprobes.sh writer
│   │       ├── traceParser.ts        # [vscode-free] Tracefs log parser & source-line mapper
│   │       ├── probeStore.ts         # [vscode-free] probes.json persistence, state & EventEmitter
│   │       ├── kprobeController.ts   # VSCode commands, Gutter/Inline decorations, Hover, Watchers
│   │       └── treeViews.ts          # Configured Kprobes & Trace Events TreeDataProviders
│   └── test/
│       ├── unit/
│       │   ├── perfProbe.test.ts     # -V/-L/-D parsing, multi-line inline & shell escaping tests
│       │   ├── traceParser.test.ts   # kprobe/kretprobe parsing, suffix matching, cap limits
│       │   └── probeStore.test.ts    # Persistence, staleness detection & filtering
│       └── integration/
│           └── perfVmlinux.test.ts   # Live perf probe -V/-L/-D against build/current/vmlinux
└── linux/                            # Untouched upstream Linux kernel Git clone[cite: 1]

```

### Data Flow

```text
[Editor Cursor: linux/fs/open.c:1420]
        │  Right-click -> kdev.kprobe.addAtCursor
        ▼
[kprobeController.ts]
   ├── 1. perfProbe.queryAvailableVars()  -> `perf probe -k vmlinux -s linux -V fs/open.c:1420`
   ├── 2. QuickPick (select vars + optional custom expr like `file->f_flags`)
   ├── 3. perfProbe.generateDefinitions() -> `perf probe -k vmlinux -s linux -D 'kdev:p1=...'`
   │       (on optimization error -> fallback to `perf probe -L` line-suggestion QuickPick)
   └── 4. probeStore.add() -> writes `shared/probes.json` & `shared/setup_kprobes.sh`
        │
        ▼  (User runs Phase 1 task: `kdev: Run QEMU`)
[QEMU Guest /init]
   ├── Executes `/mnt/host/setup_kprobes.sh` -> registers `kdev/*` in Tracefs & enables tracing
   ├── Runs interactive shell or `/mnt/host/run_target.sh`
   └── Copies `/sys/kernel/tracing/trace` -> `/mnt/host/trace.log` & powers off
        │
        ▼  (FileSystemWatcher detects `build/current/shared/trace.log`)
[traceParser.ts -> probeStore.ts]
   ├── Updates `Trace Events` side pane (click -> jump to file:line & focus event)
   ├── Updates inline watchpoint virtual text at probed lines
   └── Populates Hover hit-history table (and notifies future Phase 3 Webview Plotter)

```

---

## 4. Extension Manifest Specification (`extension/package.json`)

All identifiers use the `kdev.*` namespace for consistency across Phase 1 tasks, Phase 2 Kprobes, and Phase 3 Kconfig/Selftest features.

### Settings (`contributes.configuration`)

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `kdev.kernelSrcDir` | `string` | `"linux"` | Kernel source directory relative to workspace root.

 |
| `kdev.buildDir` | `string` | `"build/current"` | Out-of-tree build directory relative to workspace root. |
| `kdev.perfBin` | `string` | `"perf"` | Path or command name for host `perf` binary. |
| `kdev.kprobe.traceGroup` | `string` | `"kdev"` | Tracefs event group prefix (isolates `kdevkit` probes under `events/kdev/`). |
| `kdev.kprobe.maxTraceEvents` | `number` | `10000` | Maximum events retained in memory per `trace.log` load to protect UI responsiveness. |
| `kdev.kprobe.autoLoadTrace` | `boolean` | `true` | Automatically reload `trace.log` when updated by QEMU. |

### Commands & Menus

| Command ID | Title | Entry Point |
| --- | --- | --- |
| `kdev.kprobe.addAtCursor` | `kdev: Add Kprobe at Cursor` | Editor context menu (`editorLangId == c`), Command Palette |
| `kdev.kprobe.addReturnProbe` | `kdev: Add Return Probe ($retval)` | Editor context menu (`editorLangId == c`), Command Palette |
| `kdev.kprobe.removeAtCursor` | `kdev: Remove Kprobe at Cursor` | Editor context menu (`editorLangId == c`) |
| `kdev.kprobe.toggleProbe` | `kdev: Toggle Kprobe Enabled` | `kdev.kprobe.probesView` item inline button |
| `kdev.kprobe.editProbeVars` | `kdev: Edit Kprobe Variables` | `kdev.kprobe.probesView` item context menu |
| `kdev.kprobe.deleteProbe` | `kdev: Delete Kprobe` | `kdev.kprobe.probesView` item inline button |
| `kdev.kprobe.reResolveAll` | `kdev: Re-resolve All Kprobes` | `kdev.kprobe.probesView` title bar, stale `vmlinux` prompt |
| `kdev.kprobe.exportSetupScript` | `kdev: Export Tracefs Setup Script` | `kdev.kprobe.probesView` title bar |
| `kdev.kprobe.loadTraceLog` | `kdev: Load Trace Log` | `kdev.kprobe.eventsView` title bar |
| `kdev.kprobe.filterEvents` | `kdev: Filter Trace Events` | `kdev.kprobe.eventsView` title bar |
| `kdev.kprobe.clearAll` | `kdev: Clear All Kprobes` | `kdev.kprobe.probesView` title bar |
| `kdev.kprobe.jumpToEvent` | `kdev: Jump to Probe/Event Line` | Internal command triggered on TreeItem click |

### Views (`contributes.viewsContainers` & `contributes.views`)

* **Activity Bar Container:** `id: "kdevExplorer"`, `title: "kdevkit"`, `icon: "$(pulse)"`.


* **Views inside `kdevExplorer`:**
1. `id: "kdev.kprobe.probesView"`, `name: "Configured Kprobes"`
2. `id: "kdev.kprobe.eventsView"`, `name: "Trace Events"`



---

## 5. Data Models & Persistence Schemas (`src/kprobe/types.ts`)

### 5.1 `KprobeSpec` & `probes.json` Schema

`build/current/shared/probes.json` is the persisted Source of Truth so configured probes survive VSCode reloads.

```ts
export type ProbeKind = 'kprobe' | 'kretprobe';
export type ProbeStatus = 'valid' | 'stale' | 'error';

export interface KprobeSpec {
  id: string;                 // Unique event name within group, e.g. "p1"
  group: string;              // Tracefs group, default "kdev"
  kind: ProbeKind;            // "kprobe" (line) or "kretprobe" (function return)
  enabled: boolean;           // Allows temporarily muting without deleting
  file: string;               // POSIX path relative to linux/, e.g. "fs/open.c"
  line: number;               // 1-based source line number
  funcName?: string;          // Populated for kretprobes (e.g. "do_sys_openat2")
  vars: string[];             // Selected local variables from perf probe -V
  customExprs: string[];      // Optional user expressions (e.g. "file->f_flags", "$retval")
  module?: string;            // Optional .ko path relative to buildDir (future module support)
  definitions: string[];      // Lines emitted by `perf probe -D` (may be >1 for inlined funcs)
  vmlinuxMtimeMs: number;     // vmlinux mtime at resolution time (for staleness checks)
  status: ProbeStatus;
  lastError?: string;
}

export interface ProbesFileSchema {
  version: 1;
  nextSeq: number;
  probes: KprobeSpec[];
}

```

### 5.2 `TraceEvent` Schema (Ready for Phase 3 Plotting)

```ts
export interface TraceEvent {
  index: number;                     // 1-based global sequence in trace.log
  task: string;                      // Process/thread name (e.g. "sh", "kworker/u4:1")
  pid: number;
  cpu: number;
  flags: string;                     // Tracefs irq/preempt flags (e.g. "d..2.")
  timestamp: number;                 // Seconds as float (e.g. 12.345678)
  eventName: string;                 // Raw event name in trace.log (e.g. "p1" or "p1_1")
  probeId?: string;                  // Resolved KprobeSpec.id
  symbol: string;                    // Symbol/offset or return callsite info
  argsText: string;                  // Raw trailing key=value string
  argsMap: Record<string, string>;   // Parsed key -> value pairs for hover & Phase 3 plotting
}

```

---

## 6. Module-by-Module Implementation Guide

### 6.1 Workspace Path Resolution (`src/shared/workspacePaths.ts`)

* Resolve `wsRoot`, `kernelDir`, `buildDir`, `sharedDir`, `vmlinuxPath`, `probesJsonPath`, `setupScriptPath`, and `traceLogPath` from `kdev.*` workspace configuration.
* Provide `toKernelRelativePath(absFsPath: string): string | null`: normalizes separators to `/` and returns `null` if the file is outside `kernelDir` (preventing accidental probes on host files or scripts).

### 6.2 Offline `perf probe` Wrapper (`src/kprobe/perfProbe.ts`)

Must have **zero `vscode` imports** and invoke `child_process.execFile` exclusively (never `shell: true`).

#### A. Variable Discovery (`queryAvailableVars`)

```bash
perf probe -k <vmlinux> -s <linux> [-m <mod.ko>] -V <fileRel>:<line>

```

* Parse output lines after `Available variables at ...`:
* Typical format: `        @<func+offset>` followed by lines like `                int     dfd` or `                struct file*    f`.
* Extract `{ name: string, type: string }` by splitting the last identifier token (stripping leading `*`) as `name` and the prefix as `type`.
* Deduplicate across multiple inlined locations; return an empty array if `perf probe -V` returns non-zero (e.g., line has no local variables in scope).



#### B. Probeable Line Fallback (`queryProbeableLines`)

When `perf probe -D` fails because compiler optimization eliminated or merged the exact cursor line:

```bash
perf probe -k <vmlinux> -s <linux> -L <fileRel>:<startLine>..<endLine>

```

*(Window: `Math.max(1, line - 5)` to `line + 5`.)*

* `perf probe -L` prefixes probeable lines with their line number (e.g., `     1420  	return do_sys_openat2(dfd, filename, &how);`) and omits line numbers on non-probeable lines.
* Parse lines matching `/^\s*(\d+)\s+(.*)$/` into `ProbeableLine[]` (`{ line, code }`).
* `kprobeController.ts` presents these nearby lines in a `QuickPick` so the user can accept the nearest probeable line in one click.

#### C. Tracefs Definition Generation (`generateDefinitions`)

* **Line Kprobe:**
```text
<group>:<id>=<fileRel>:<line> <vars...> <customExprs...>

```


Invoked as:
```bash
perf probe -k <vmlinux> -s <linux> [-m <mod.ko>] -D 'kdev:p1=fs/open.c:1420 dfd flags'

```


* **Function Return Probe (`kretprobe`):**
```text
<group>:<id>=<funcName>%return $retval <customExprs...>

```


*(Note: On return probes, local variables at arbitrary body lines are generally unavailable; default to `$retval` plus optional custom expressions.)*
* Collect all output lines matching `/^[pr]:[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+\s+/` (preserving multiple lines when a function is inlined into multiple call sites).
* **Input Sanitization:** Validate `id` (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) and reject shell control characters (`;`, `\n`, `\r`, ```, `$(`) in `customExprs` before invoking `perf` or writing scripts.

#### D. Tracefs Script Emission (`writeTracefsSetup`)

Write `build/current/shared/setup_kprobes.sh` (`mode: 0o755`) using isolated group teardown so only `kdevkit` events are touched:

```sh
#!/bin/sh
set -e
TRACING=/sys/kernel/tracing
GROUP="kdev"

echo 0 > "$TRACING/tracing_on"
if [ -d "$TRACING/events/$GROUP" ]; then
  echo 0 > "$TRACING/events/$GROUP/enable" 2>/dev/null || true
fi
echo > "$TRACING/kprobe_events"
echo > "$TRACING/trace"

# Active probes (enabled=true && status=valid)
echo 'p:kdev/p1 do_sys_openat2+0x14 dfd=%di:s32 flags=%si:s32' >> "$TRACING/kprobe_events"

if [ -d "$TRACING/events/$GROUP" ]; then
  echo 1 > "$TRACING/events/$GROUP/enable"
  echo 1 > "$TRACING/tracing_on"
fi

```

* If no active valid probes exist, still emit the cleanup header (without turning `tracing_on` on) so previously registered probes do not linger across QEMU runs.
* Escape every single quote in definitions via `def.replace(/'/g, "'\\''")`.

---

### 6.3 Tracefs Log Parser (`src/kprobe/traceParser.ts`)

Must have **zero `vscode` imports**.

* **Supported Line Formats:**
* Standard kprobe:
`          sh-142     [000] d..2.    12.345678: p1: (do_sys_openat2+0x14/0x100) dfd=0x3 flags=0x8000`
* Return kprobe (`kretprobe`):
`          sh-142     [000] d..2.    12.345701: p2: (do_sys_openat2+0x0/0x100 <- __x64_sys_openat+0x56/0xa0) arg1=0x3`
* Tasks containing spaces or hyphens (e.g., `kworker/u4:1-42`, `rcu_preempt-14`).


* **Regex:**
```ts
const TRACE_LINE_RE =
  /^\s*(.+?)-(\d+)\s+\[(\d+)\]\s+(\S+)\s+(\d+\.\d+):\s+([a-zA-Z0-9_]+):\s+\(([^)]+)\)\s*(.*)$/;

```


* **Probe Correlation:**
* Build a lookup map of `probe.id -> probe`.
* Match `eventName` directly first; if not found, strip trailing inline-instance suffixes (`eventName.replace(/_\d+$/, '')`) and retry.


* **Key=Value Argument Extraction (`parseArgsMap`):**
* Match `/([a-zA-Z_][a-zA-Z0-9_]*)=("(?:\\.|[^"])*"|\S+)/g` to handle both hex/decimal scalars (`dfd=0x3`) and quoted strings (`name="/etc/passwd"`).


* **High-Volume Protection:**
* Skip `#` header comment lines.
* Enforce `maxEvents` (from `kdev.kprobe.maxTraceEvents`, default `10,000`). Return `{ events, totalMatched, truncated: boolean }` so the UI can warn the user when a hot kernel function generated more hits than displayed.



---

### 6.4 State Store & Persistence (`src/kprobe/probeStore.ts`)

Central in-memory store with Node.js `EventEmitter` (or lightweight typed listener callbacks) so TreeViews, Decorations, Hover, and future Phase 3 Webview Plotter all react to a single source of truth:

* **State:**
* `probes: KprobeSpec[]`
* `events: TraceEvent[]`
* `selectedEventIndex: number | null`
* `eventFilter: { probeId?: string; text?: string }`
* `traceTruncated: boolean`, `totalTraceCount: number`


* **Staleness Detection (`checkStaleness(currentVmlinuxMtimeMs)`):**
* Whenever `vmlinux` mtime differs from `probe.vmlinuxMtimeMs`, mark `probe.status = 'stale'` (keeping existing definitions intact until the user runs `kdev.kprobe.reResolveAll`).


* **Editor Line-Shift Tracking (`adjustLinesForDocumentEdit`):**
* When lines are inserted or deleted above a probed line in an open C file, shift `probe.line` accordingly in memory and mark `probe.status = 'stale'` so the Gutter icon follows the source code accurately and reminds the developer to rebuild & re-resolve.


* **Subscriptions (Phase 3 Plotter Hook):**
* `onDidChangeProbes(listener)`
* `onDidChangeEvents(listener)`
* `onDidSelectEvent(listener)` — bidirectional sync: clicking a point in Phase 3's Webview plot will call `store.selectEvent(index)`, automatically jumping the editor and highlighting the inline watchpoint value.



---

### 6.5 VSCode Controller, Decorations & Watchers (`src/kprobe/kprobeController.ts`)

#### A. Gutter Icons (Non-Clashing with GDB Breakpoints)

Define three `TextEditorDecorationType` instances with inline SVG data URIs:

* **Valid & Enabled:** Amber/gold diamond or circle (`#e5a50a`) with overview ruler marker.
* **Disabled:** Hollow gray outline (`#888888`).
* **Stale / Error:** Warning orange triangle/ring (`#f14c4c` / `#cca700`) indicating rebuild re-resolution is needed.

#### B. Watchpoint-Style Inline Virtual Text

Render `after.contentText` at the end of every probed line:

* **If the user clicked a specific event in `Trace Events` belonging to this probe:**
`  ◀ [SELECTED #4/12 @ 12.345678s] sh-142 | dfd=0x3 flags=0x8000`
* **Else if the probe has recorded hits:**
`  ◀ [12 hits | last @ 12.349102s] dfd=0x4 flags=0x0`
* **Else if 0 hits (pre-run):**
`  ◀ [kdev:p1] vars: dfd, flags` (or `[kdev:p1 STALE — re-resolve]` if stale).

#### C. Hover Provider (`registerHoverProvider('c', ...)`)

Hovering over a probed line displays a Markdown card containing:

1. Probe ID, kind (`kprobe` / `kretprobe`), status, and Tracefs definition block.
2. Markdown table of the **most recent 10 hits** (`# | Timestamp | Task-PID | CPU | Captured Values`).
3. Action command links (`[Re-resolve](command:kdev.kprobe.reResolveAll)`, `[Remove](command:kdev.kprobe.removeAtCursor)`).

#### D. FileSystemWatchers

1. **`**/shared/trace.log`** (debounced `300 ms`): When `kdev.kprobe.autoLoadTrace` is `true`, automatically reads and parses `trace.log`, refreshes TreeViews and decorations, and updates the status bar (`kdev: 48 trace events loaded`).
2. **`**/vmlinux`** (debounced `1000 ms`): Checks `fs.statSync(vmlinuxPath).mtimeMs`, marks affected probes `stale`, refreshes decorations, and shows a non-blocking information message with a `"Re-resolve Now"` button bound to `kdev.kprobe.reResolveAll`.

---

### 6.6 Side-Pane TreeViews (`src/kprobe/treeViews.ts`)

1. **`Configured Kprobes` (`kdev.kprobe.probesView`):**
* Label: `${probe.id}  ${probe.file}:${probe.line}`
* Description: `${probe.kind === 'kretprobe' ? 'ret ' : ''}${vars.join(', ') || 'no vars'} · ${hitCount} hits`
* Context value (`kprobeEnabled` / `kprobeDisabled` / `kprobeStale`) enables inline action icons for toggle, edit vars, and delete.
* Click invokes `kdev.kprobe.jumpToEvent` to open `linux/<file>` centered on `line`.


2. **`Trace Events` (`kdev.kprobe.eventsView`):**
* Supports flat chronological view (default) and active filter indicator node at top when filtered or truncated.
* Label: `#${ev.index} [${ev.timestamp.toFixed(6)}s] ${ev.eventName}`
* Description: `${ev.argsText || ev.symbol}`
* Tooltip: Full task, PID, CPU, flags, symbol, and formatted `argsMap`.
* Click invokes `kdev.kprobe.jumpToEvent({ file, line, eventIndex })`: opens the corresponding source file at the exact line, sets `store.selectEvent(ev.index)`, and immediately updates the watchpoint-style inline virtual text on that line.



---

## 7. Verification & Test Plan

### Layer 1: Pure Unit Tests (`extension/test/unit/`, Vitest — `< 2s`)

| Test Suite | Key Cases |
| --- | --- |
| **`perfProbe.test.ts`** | Parse `-V` output with pointers/structs/duplicates; parse `-L` output with mixed probeable & non-probeable lines; parse single-line and multi-line (inlined) `-D` output; reject unsafe shell characters in `customExprs`; verify `setup_kprobes.sh` skips disabled/stale probes and escapes quotes cleanly. |
| **`traceParser.test.ts`** | Parse standard kprobe lines, `kretprobe` (`<- caller`) lines, hyphenated/spaced task names, quoted string args, `_1`/`_2` inline suffix mapping back to `KprobeSpec.id`, comment skipping, and `maxEvents` truncation behavior. |
| **`probeStore.test.ts`** | Save/load round-trip of `probes.json`; `vmlinux` mtime staleness transitions; line-shift adjustments on document edits; event filtering by `probeId` and free text. |

### Layer 2: Real `vmlinux` Integration Tests (`extension/test/integration/perfVmlinux.test.ts`)

Runs Vitest against the Phase 1 build output in `kdevkit/build/current/vmlinux`:

1. Execute `queryAvailableVars('fs/open.c', <targetLine>)` against `do_sys_openat2` and assert expected local variables (`dfd`, `filename`, etc.) are returned.
2. Execute `generateDefinitions` for both a line `kprobe` and a `kretprobe` (`do_sys_openat2%return $retval`) and assert valid `p:kdev/...` and `r:kdev/...` Tracefs strings are returned.
3. Execute `queryProbeableLines` on a known non-probeable line (e.g., blank line or closing brace inside `fs/open.c`) and verify nearby probeable lines are returned.
4. Write `setup_kprobes.sh` to a temp directory and validate POSIX shell syntax with `sh -n <script>`.

### Layer 3: End-to-End QEMU + VSCode Manual / Smoke Acceptance Criteria

1. Launch Extension Development Host (`F5`) opening `kdevkit/`.
2. Open `linux/fs/open.c`, right-click inside `do_sys_openat2`, run **`kdev: Add Kprobe at Cursor`**, pick `dfd` and `flags`. Confirm:
* Amber gutter icon and inline `[kdev:p1]` annotation appear.
* `build/current/shared/probes.json` and `build/current/shared/setup_kprobes.sh` are created.


3. Run Phase 1 task **`kdev: Run QEMU`**, execute `ls /` inside the BusyBox shell, and type `exit`.
4. Confirm QEMU powers off, `build/current/shared/trace.log` is created, and VSCode **automatically** populates the **`Trace Events`** side pane without manual refresh.
5. Click any event in **`Trace Events`** and confirm the editor jumps to `linux/fs/open.c:<line>`, updates the inline watchpoint text to the clicked event's values, and displays the 10-hit history table on hover.
6. Confirm `git -C linux status --porcelain` remains completely empty.

