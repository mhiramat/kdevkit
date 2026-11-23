# Design & Implementation Specification: Phase 3B — ECharts Trace Visualization Webview (`DESIGN_PHASE3_TRACE_PLOT.md`)

## 1. Overview & Objectives

This document specifies the design, TypeScript/React + **Apache ECharts** implementation architecture, and test plan for **Phase 3B** of **`kdevkit`**: an interactive trace visualization Webview panel integrated directly with Phase 2's `ProbeStore` and editor navigation.

Using **Apache ECharts** minimizes custom charting, zoom, tooltip, histogram, and dark/light theme boilerplate while delivering smooth Canvas rendering over thousands of kernel Kprobe events captured from QEMU (`build/current/shared/trace.log`).

### Core Objectives
* **Zero Duplicate Parsing (Single Source of Truth):** Subscribe directly to Phase 2's `ProbeStore` (`onDidChangeProbes`, `onDidChangeEvents`, `onDidSelectEvent`) so any `trace.log` reload (from manual QEMU runs or Phase 3A selftest runs) automatically updates open charts.
* **Three Purpose-Built Kernel Analysis Views:**
  1. **Event Timeline (Swimlane Scatter):** Visualize event bursts, ordering, and concurrency across Probe ID, CPU, or Task (PID) lanes.
  2. **Variable Value Time-Series (Line / Scatter):** Automatically detect numeric and hex fields in `TraceEvent.argsMap` (e.g., `dfd`, `flags`, `$retval`, byte counts, latencies) and plot their evolution over time.
  3. **Latency & Inter-Arrival Analysis (Time-Series + Histogram):** Compute function execution duration by pairing entry `kprobe` and exit `kretprobe` events per PID (LIFO stack), or inter-arrival deltas for single probes, with percentile statistics (`p50`/`p95`/`p99`) and distribution histograms.
* **Bidirectional Editor Synchronization:** Clicking any data point in ECharts immediately jumps the VSCode editor to `linux/<file>:<line>` and updates the Phase 2 inline watchpoint annotation; conversely, clicking an event in the `Trace Events` side pane highlights that exact point on the active chart.
* **Offline-First & Strict CSP Compliance:** Bundle tree-shaken `echarts/core` locally via `esbuild` so the Webview works 100% offline under strict VSCode Content Security Policy rules with native `--vscode-*` theme adaptation.

---

## 2. Extension Architecture & Directory Layout

Phase 3B adds a dedicated analytics engine (pure Node.js, Vitest-testable), a Webview controller under `extension/src/kprobe/`, and a second Webview bundle target in `extension/esbuild.mjs`.

```text
kdevkit/extension/
├── package.json                          # Adds "echarts" dependency, kdev.kprobe.openTracePlot command
├── esbuild.mjs                           # Builds dist/extension.js, dist/webview/kconfig.*, dist/webview/tracePlot.*
├── src/
│   ├── extension.ts                      # Registers TracePlotController alongside KprobeController
│   ├── shared/
│   │   └── tracePlotProtocol.ts          # Typed Host <-> Webview message union
│   └── kprobe/
│       ├── probeStore.ts                 # [Phase 2] Source of Truth (emits probes, events, selectedEvent)
│       ├── traceAnalytics.ts             # [vscode-free] Numeric/hex extraction, latency pairing, stats, binning
│       └── tracePlotController.ts        # Singleton WebviewPanel, CSP nonce, ProbeStore bridge, CSV/PNG save
├── webview-ui/
│   └── src/
│       └── trace-plot/
│           ├── main.tsx                  # React root + acquireVsCodeApi()
│           ├── echartsSetup.ts           # Tree-shaken ECharts module registration + VSCode theme builder
│           ├── optionBuilders.ts         # [DOM-free] Pure functions: data -> EChartsOption (unit-testable)
│           ├── TracePlotApp.tsx          # Toolbar (view tabs, filters, export) + ECharts canvas container
│           └── components/
│               ├── ChartCanvas.tsx       # Managed ECharts instance (resize observer, click sync, highlight)
│               ├── ControlBar.tsx        # View switcher, lane/field/pair selectors, timebase toggle
│               └── StatsStrip.tsx        # Count, min, p50, p95, p99, max summary badges
└── test/
    └── unit/
        ├── traceAnalytics.test.ts        # Hex/signed parsing, nested kprobe/kretprobe pairing, percentiles, bins
        └── optionBuilders.test.ts        # Verifies EChartsOption outputs for all 3 views & empty states
```

---

## 3. Data Analytics Engine (`src/kprobe/traceAnalytics.ts`)

Must have **zero `vscode` or DOM imports** so all kernel trace math is rigorously verified by Vitest.

### 3.1 Numeric & Hex Field Discovery (`extractNumericFields`)
Scan `events[].argsMap` grouped by `probeId`:
* Parse scalar values matching:
  * Hexadecimal: `/^-?0x[0-9a-fA-F]+$/` (parsed with `BigInt` first; converted to `Number` when within `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER`, flagging 64-bit pointers as `isPointerHex: true` so the UI offers hex formatting or offset-from-min normalization).
  * Signed/unsigned decimal & float: `/^-?\d+(\.\d+)?$/`.
* Ignore purely string fields (e.g., `name="/etc/passwd"`).
* Return `NumericFieldInfo[]`: `{ probeId, field, sampleCount, isHex, isPointer64, min, max }`.

### 3.2 Entry/Exit Latency Pairing (`computePairedLatency`)
Given an `entryProbeId` (`kprobe`) and `exitProbeId` (`kretprobe`):
1. Maintain a `Map<number, TraceEvent[]>` keyed by `pid` (acting as a LIFO call stack to handle nested or recursive kernel calls accurately).
2. Iterate `events` in chronological order:
   * On `entryProbeId`: push event onto `stack.get(ev.pid)`.
   * On `exitProbeId`: pop most recent entry for `ev.pid`. If stack is non-empty and `ev.timestamp >= entry.timestamp`, record:
     ```ts
     export interface LatencySample {
       entryEventIndex: number;
       exitEventIndex: number;
       pid: number;
       task: string;
       cpu: number;
       startTs: number;
       endTs: number;
       durationUs: number; // (endTs - startTs) * 1e6
       retval?: string;    // Extracted from exit argsMap (arg1 / retval) if present
     }
     ```
   * Count `unmatchedEntries` and `unmatchedExits` (common at trace buffer boundaries) and expose them in the UI summary so developers know if truncation occurred.
* **Auto-Pair Suggestions (`suggestLatencyPairs`):** Automatically propose `(entry, exit)` pairs when a `kprobe` and `kretprobe` share the same `funcName` or `file`, or when the user has exactly one `kprobe` and one `kretprobe`.

### 3.3 Inter-Arrival Delta (`computeInterArrival`)
For a single `probeId` with optional grouping (`'global' | 'per-pid' | 'per-cpu'`):
* Compute `deltaUs = (curr.timestamp - prev.timestamp) * 1e6` between consecutive hits, emitting `LatencySample[]` with the same structure so both modes reuse the exact same ECharts charts and statistics strip.

### 3.4 Summary Statistics & Histogram Binning (`computeStats`, `computeHistogram`)
* **Statistics:** `count`, `min`, `max`, `mean`, `p50`, `p95`, `p99` (computed via sorted linear interpolation).
* **Histogram Binning:** Support linear bins (Freedman–Diaconis or configurable bin count `10..60`, default `24`) and optional **log10 time buckets** (essential when kernel latencies span `1 us` fast paths to `10 ms` sleep paths). Each bin retains `sampleEventIndices: number[]` so clicking a histogram bar highlights or jumps to the first outlier in that bucket.

---

## 4. ECharts Visualization Design (`webview-ui/src/trace-plot/`)

### 4.1 Modular Tree-Shaken ECharts Bundle (`echartsSetup.ts`)
Import only the required ECharts components via `echarts/core` to keep `dist/webview/tracePlot.js` fast to load and bundle:

```ts
import * as echarts from 'echarts/core';
import { ScatterChart, LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkPointComponent,
  MarkLineComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  ScatterChart,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkPointComponent,
  MarkLineComponent,
  ToolboxComponent,
  CanvasRenderer,
]);
```

* **High-Volume Smoothness:** Enable `CanvasRenderer` (faster than SVG for >1,000 points), `animation: false` when `events.length > 2000`, and ECharts built-in `large: true`, `largeThreshold: 2000` on scatter/line series.

### 4.2 Visual Layout & Views

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ [Tabs] (● Timeline)  ( Values )  ( Latency )     [Relative t-t0 ☑] [Export]│
├────────────────────────────────────────────────────────────────────────────┤
│ [View Controls]                                                            │
│   Timeline : Lane: [Probe ID ▾] | Probes: [✓ p1] [✓ p2] | PID Filter: [  ] │
│   Values   : Series: [p1.dfd ✓] [p2.retval ✓] | Scale: [Linear ▾] [Hex ☐]  │
│   Latency  : Mode: [Entry→Exit ▾] [p1 ▾] → [p2 ▾] | Chart: [Scatter|Hist]  │
├────────────────────────────────────────────────────────────────────────────┤
│ [StatsStrip] Events: 1,248 | Range: 0.000s – 1.842s | p50: 4.2µs p99: 81µs │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│                        ECharts Canvas Container                            │
│        (Mouse-wheel inside zoom + bottom DataZoom slider + Tooltip)        │
│                                                                            │
│   • Click point -> Jumps VSCode editor to file:line & updates inline text  │
│   • Side-pane click -> Renders MarkPoint crosshair on selected event       │
└────────────────────────────────────────────────────────────────────────────┘
```

#### View 1: Event Timeline (`buildTimelineOption`)
* **Chart Type:** `ScatterChart`, one series per `probeId`.
* **X-Axis:** `type: 'value'` timestamp in seconds (relative `t - t0` by default for readability, toggleable to raw kernel monotonic clock).
* **Y-Axis:** `type: 'category'` selectable between:
  * `Probe ID` (`p1 (fs/open.c:1420)`)
  * `CPU` (`CPU 0`, `CPU 1`, ...)
  * `Task (PID)` (`sh-142`, `kworker/u4:1-42`, ...)
* **Data Point Payload:** `[xTs, laneIndex, event.index]` so ECharts click handlers (`chart.on('click', params)`) read `eventIndex = params.value[2]` in $O(1)$.
* **Interactive Zoom:** Dual `dataZoom` (`type: 'inside'` for mouse-wheel/drag pan + `type: 'slider'` along the X-axis).

#### View 2: Variable Value Time-Series (`buildValueSeriesOption`)
* **Chart Type:** `LineChart` (with `showSymbol: true`, `step: false`, toggleable to `ScatterChart` for discrete/non-continuous values like `flags` or `dfd`).
* **Multi-Series Support:** Users can overlay multiple `(probeId, field)` pairs simultaneously.
* **Hex & Pointer Formatting:** When `isHex` is toggled (default on for hex-captured fields), Y-axis ticks and tooltips format numbers via `'0x' + Math.trunc(val).toString(16)`. For 64-bit kernel addresses (`isPointer64`), offer an optional **"Offset from Min Address"** toggle so subtle pointer deltas remain readable instead of collapsing to precision limits.

#### View 3: Latency & Inter-Arrival (`buildLatencyScatterOption` / `buildLatencyHistogramOption`)
* **Sub-view A (Duration over Time):** `ScatterChart` (X = start timestamp, Y = `durationUs` in `µs` or `ms`, optional `type: 'log'` Y-axis) with horizontal `MarkLine` markers for `p50` and `p99`. Clicking a point jumps to the entry (or exit) event line.
* **Sub-view B (Distribution Histogram):** `BarChart` over computed buckets (linear or log10). Clicking a bar selects the slowest/first sample in that bucket and jumps the editor to its source line.

### 4.3 Native VSCode Theme Synchronization
Do not hardcode light/dark colors. In `echartsSetup.ts`, read computed styles from `document.documentElement` / `document.body`:
* Background: `transparent` (inherits `--vscode-editor-background`)
* Text / Axis labels: `--vscode-editor-foreground`
* Grid split lines: `--vscode-panel-border`
* Series palette: `--vscode-charts-blue`, `--vscode-charts-orange`, `--vscode-charts-green`, `--vscode-charts-purple`, `--vscode-charts-yellow`, `--vscode-charts-red` (with safe fallbacks).
* Attach a `MutationObserver` on `document.body` (`attributes: true, attributeFilter: ['class']`) so switching VSCode color themes re-applies the ECharts option palette automatically without losing zoom state.

---

## 5. Bidirectional Sync & Message Protocol (`src/shared/tracePlotProtocol.ts`)

```ts
// Webview -> Extension Host
export type TracePlotToHostMessage =
  | { type: 'ready' }
  | { type: 'selectEvent'; eventIndex: number }
  | { type: 'requestReloadTrace' }
  | { type: 'exportData'; format: 'csv' | 'png'; filenameHint: string; content: string };

// Extension Host -> Webview
export type HostToTracePlotMessage =
  | {
      type: 'traceSnapshot';
      probes: KprobeSpec[];
      events: TraceEvent[];
      truncated: boolean;
      totalMatched: number;
      selectedEventIndex: number | null;
    }
  | { type: 'highlightEvent'; eventIndex: number | null };
```

### Synchronization Flow
1. **Chart Click → Editor & Side Pane:**
   * User clicks a point in ECharts → Webview posts `{ type: 'selectEvent', eventIndex }`.
   * `TracePlotController` looks up the event in `ProbeStore`, calls `store.selectEvent(eventIndex)`, and executes `kdev.kprobe.jumpToEvent` (revealing `linux/<file>:<line>` in `ViewColumn.One` while keeping the Trace Plotter open in `ViewColumn.Beside`).
   * Phase 2's inline watchpoint decoration updates immediately to show `[SELECTED #<idx>]`.
2. **Side Pane Click → Chart Highlight:**
   * User clicks an item in `Trace Events` → `ProbeStore` emits `onDidSelectEvent(eventIndex)`.
   * `TracePlotController` posts `{ type: 'highlightEvent', eventIndex }` to the Webview.
   * `ChartCanvas` updates a lightweight `markPoint` / `markLine` indicator on the corresponding timestamp and series without resetting the user's current `dataZoom` window.
3. **Export Support (`exportData`):**
   * **PNG Export:** Webview calls `chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor })` and posts the base64 data URL to `TracePlotController`, which prompts `vscode.window.showSaveDialog` and writes the PNG file.
   * **CSV Export:** Exports currently filtered events or computed latency samples to `.csv` via `showSaveDialog` for external analysis or inclusion in kernel commit messages / cover letters.

---

## 6. Extension Host Controller & Manifest Additions

### `TracePlotController` (`src/kprobe/tracePlotController.ts`)
* **Singleton Panel:** `viewType: 'kdev.tracePlot'`, default `ViewColumn.Beside`, `enableScripts: true`, `retainContextWhenHidden: true`.
* **CSP Policy:**
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 img-src ${webview.cspSource} data:;
                 font-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';">
  ```
* **Lifecycle Safety:** Unsubscribe all `ProbeStore` listeners in `panel.onDidDispose` to prevent memory leaks across open/close cycles.

### Manifest Additions (`extension/package.json`)
* **Command:** `kdev.kprobe.openTracePlot` (`title: "kdev: Open Trace Plotter"`, `icon: "$(graph)"`).
* **View Title Button:** Place `kdev.kprobe.openTracePlot` in the `view/title` toolbar of `kdev.kprobe.eventsView` (`Trace Events`) for one-click access right beside `Load Trace Log`.
* **Settings:**
  * `kdev.tracePlot.defaultTimebase`: `"relative" | "absolute"` (default `"relative"`).
  * `kdev.tracePlot.autoOpenOnSelftestTrace`: `boolean` (default `false` — when `true`, automatically reveals the plotter after a Phase 3A `Run in QEMU with Active Kprobes` completes).

---

## 7. Verification & Test Plan

### Layer 1: Pure Analytics & Option Builder Unit Tests (Vitest — `< 2s`)
| Test Suite | Key Cases |
| :--- | :--- |
| **`traceAnalytics.test.ts`** | Parse signed/unsigned decimal, hex (`0x8000`, `-0x16`), and 64-bit pointer args while skipping quoted strings; pair simple and nested/recursive `kprobe`→`kretprobe` stacks per PID; count unmatched entry/exit boundaries cleanly; verify `p50`/`p95`/`p99` percentile accuracy; verify linear & log10 histogram bucket assignment and index preservation. |
| **`optionBuilders.test.ts`** | Verify `buildTimelineOption`, `buildValueSeriesOption`, `buildLatencyScatterOption`, and `buildLatencyHistogramOption` produce valid ECharts option structures for normal traces, empty traces, truncated traces, and `selectedEventIndex` markPoint overlays; verify `large: true` and `animation: false` engage automatically above 2,000 points. |

### Layer 2: Webview Build & Bundle Verification
1. Run `npm run typecheck && npm run build` inside `kdevkit/extension/`.
2. Confirm `dist/webview/tracePlot.js` builds cleanly with zero external CDN requests (tree-shaken `echarts/core` only) and obeys CSP without `unsafe-eval`.

### Layer 3: End-to-End Integration Acceptance Criteria
1. Capture a real `build/current/shared/trace.log` from QEMU with at least one `kprobe` (capturing numeric variables such as `dfd` and `flags`) and one paired `kretprobe` (capturing `$retval`) on `do_sys_openat2`.
2. Click the graph icon (`kdev: Open Trace Plotter`) in the **`Trace Events`** view title bar.
3. **Timeline View:** Verify events plot across Probe/CPU/PID lanes, mouse-wheel zoom works smoothly, and clicking any point jumps the editor in `ViewColumn.One` to `linux/fs/open.c:<line>` while updating the inline watchpoint value.
4. **Reverse Sync:** Click a different event in the **`Trace Events`** side pane and confirm the highlight marker moves on the ECharts canvas without resetting zoom.
5. **Values & Latency Views:** Switch to **Values** and plot `dfd` / `flags` (with Hex toggle); switch to **Latency**, pair the entry/exit probes, and verify both scatter latency over time and histogram distribution render with accurate `p50`/`p99` badges.
6. **Export & Theme Switch:** Export a PNG and CSV via the toolbar, and toggle VSCode between Dark and Light themes to confirm chart axes and palettes update cleanly.