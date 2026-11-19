# Design & Implementation Specification: Kconfig VSCode Frontend (`DESIGN_KCONFIG_FRONTEND.md`)

## 1. Overview & Objectives

This document specifies the design, TypeScript/React implementation guide, and **frontend-to-backend connection test plan** for the **VSCode Kconfig Editor Frontend**. It integrates directly with the Phase 1 Parent Workspace (`kdev-workspace/`) and the Python JSON-RPC 2.0 backend defined in `DESIGN_KCONFIG_BACKEND.md`, inside a unified VSCode extension (`extension/`) that will also host Phase 2 features (Kprobes, Tracefs viewer, Selftest runner).

### Core Objectives

* **Seamless Three-Layer Bridge:** Isolate the sandboxed React Webview from Node.js/OS concerns via a strongly typed Extension Host bridge (`KconfigPanelController`) and a resilient stdio JSON-RPC client (`KconfigRpcClient`).
* **Interactive Dependency Resolution UX:** Allow developers to toggle any symbol (including currently invisible or dependency-blocked symbols), preview the MaxSAT solver's minimal prerequisite diff with provenance reasons, inspect UNSAT Core conflicts against pinned layers, and apply changes in one click.
* **Declarative Config Injection UI:** Provide first-class management for `configs/layers.json`—importing user `.config` fragments via native VSCode file dialogs, toggling layers on/off, reordering precedence, and toggling Pinned (`🔒`) locks.
* **Automatic `#ifdef CONFIG_*` Refresh:** Automatically invoke `clangd.restart` immediately after `kconfig/apply` updates `autoconf.h` and `.clangd`, keeping editor inactive-region dimming synchronized with zero manual steps.
* **Testable End-to-End Connectivity:** Structure the transport, state reducer, and Webview bridge so that protocol framing, daemon crash recovery, real Python IPC, and VSCode Extension Host workflows can all be tested automatically in CI and local development.

---

## 2. Unified Extension Architecture & Directory Layout

The frontend lives under `kdev-workspace/extension/` so that `linux/` remains untouched and Kconfig (Phase 3) and Kprobes/Selftest (Phase 2) share a single extension manifest, build pipeline, and configuration namespace (`kdev.*`).

```text
kdev-workspace/
├── DESIGN.md
├── DESIGN_KCONFIG_BACKEND.md
├── DESIGN_KCONFIG_FRONTEND.md           # This document
├── backend/                             # Python Kconfig backend
├── extension/                           # Unified VSCode Extension
│   ├── package.json                     # Extension manifest, settings, commands, scripts
│   ├── tsconfig.json                    # Extension Host TypeScript config (Node.js)
│   ├── tsconfig.webview.json            # Webview UI TypeScript config (DOM / React)
│   ├── esbuild.mjs                      # Dual-target bundler (extension + webview)
│   ├── vitest.config.ts                 # Unit & IPC integration test runner config
│   ├── src/
│   │   ├── extension.ts                 # Entrypoint: activates Kconfig (+ future Kprobe) modules
│   │   ├── shared/
│   │   │   ├── workspacePaths.ts        # Resolves wsRoot, linux/, build/current, backend/.venv
│   │   │   └── protocol.ts              # Shared TypeScript types (RPC + Webview messages)
│   │   └── kconfig/
│   │       ├── rpcClient.ts             # Python daemon lifecycle & NDJSON JSON-RPC 2.0 client
│   │       ├── panelController.ts       # WebviewPanel manager, OpenDialog, clangd.restart hook
│   │       └── configWatcher.ts         # Watches build/current/.config & configs/layers.json
│   ├── webview-ui/
│   │   ├── src/
│   │   │   ├── main.tsx                 # React mount point + acquireVsCodeApi() wrapper
│   │   │   ├── vscodeApi.ts             # Typed postMessage / listener abstraction (mockable)
│   │   │   ├── state/
│   │   │   │   └── store.ts             # Reducer for tree cache, layers, solve modal, dirty state
│   │   │   ├── styles/
│   │   │   │   └── theme.css            # Built exclusively on --vscode-* CSS variables
│   │   │   ├── App.tsx                  # Top LayerBar + 3-pane layout + SolveModal
│   │   │   └── components/
│   │   │       ├── LayerBar.tsx         # Layer chips, inject button, pin/enable/reorder
│   │   │       ├── SearchBar.tsx        # Debounced search + "Modified Only" filter
│   │   │       ├── MenuTree.tsx         # Lazy-loaded Kconfig hierarchy tree
│   │   │       ├── SymbolList.tsx       # [N|M|Y] toggles, pin badges, visibility markers
│   │   │       ├── DetailPane.tsx       # Help text, depends on / select / selected by
│   │   │       └── SolveModal.tsx       # Diff preview table & UNSAT Core conflict resolver
│   └── test/
│       ├── unit/
│       │   ├── rpcClient.test.ts        # Framing, partial chunks, timeouts, crash restart
│       │   ├── store.test.ts            # Webview state transitions & conflict flows
│       │   └── components.test.tsx      # React component interaction tests
│       ├── integration/
│       │   ├── rpcBackend.test.ts       # Real Node KconfigRpcClient <-> Real Python daemon
│       │   └── fixtures/                # Synthetic Kconfig & stub configure.sh
│       └── e2e/
│           ├── runTest.ts               # @vscode/test-electron launcher
│           └── suite/kconfig.e2e.ts     # Real VSCode Webview + command + clangd hook tests
└── linux/                               # Upstream Linux Git repository (untouched)

```

---

## 3. Tooling, Bundling & Extension Manifest

### Dependencies & Build Stack

* **Bundler (`esbuild`):** Compiles both targets in `< 300ms`:
1. **Extension Host bundle:** `src/extension.ts` → `dist/extension.js` (`platform: "node"`, `format: "cjs"`, `external: ["vscode"]`).
2. **Webview UI bundle:** `webview-ui/src/main.tsx` → `dist/webview/kconfig.js` + `dist/webview/kconfig.css` (`platform: "browser"`, `format: "iife"`).


* **UI Framework:** `react` + `react-dom` (`^18.3`) and `@vscode/codicons` (copied into `dist/webview/codicons/` by `esbuild.mjs` so icons work completely offline under strict Webview CSP).
* **Testing Stack:** `vitest`, `@testing-library/react`, `jsdom`, and `@vscode/test-electron` (for real Extension Host E2E tests).

### `extension/package.json` Contributions

Expose workspace-configurable paths under the `kdev.*` namespace so Phase 1, Phase 2, and Phase 3 all read the same settings:

```json
{
  "name": "linux-kernel-dev",
  "displayName": "Linux Kernel Dev Suite",
  "version": "0.1.0",
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "activationEvents": [
    "onCommand:kdev.openKconfigEditor",
    "onView:kdev.overview"
  ],
  "contributes": {
    "configuration": {
      "title": "Linux Kernel Dev",
      "properties": {
        "kdev.kernelSrcDir": { "type": "string", "default": "linux" },
        "kdev.buildDir": { "type": "string", "default": "build/current" },
        "kdev.arch": { "type": "string", "default": "x86_64" },
        "kdev.layersFile": { "type": "string", "default": "configs/layers.json" },
        "kdev.pythonPath": { "type": "string", "default": "backend/.venv/bin/python" },
        "kdev.autoRestartClangd": { "type": "boolean", "default": true }
      }
    },
    "commands": [
      {
        "command": "kdev.openKconfigEditor",
        "title": "Kernel Dev: Open Kconfig Editor",
        "icon": "$(settings-gear)"
      },
      {
        "command": "kdev.restartKconfigBackend",
        "title": "Kernel Dev: Restart Kconfig Backend"
      }
    ]
  }
}

```

---

## 4. Shared Type Contract (`src/shared/protocol.ts`)

Both the Extension Host and Webview import from `src/shared/protocol.ts` so every message is compile-time type-checked.

### 4.1 Backend JSON-RPC Types (Mirroring `DESIGN_KCONFIG_BACKEND.md`)

```ts
export type TriVal = 'n' | 'm' | 'y';
export type SymType = 'bool' | 'tristate' | 'int' | 'hex' | 'string' | 'unknown';

export interface ConfigLayer {
  id: string;
  path: string;
  enabled: boolean;
  pinned: boolean;
  readonly?: boolean;
  symbolCount?: number;
}

export interface KconfigNode {
  id: string;
  kind: 'menu' | 'symbol' | 'choice';
  name: string;
  prompt: string;
  type?: SymType;
  value?: string;
  visible: boolean;
  pinnedBy?: string | null;
  hasChildren?: boolean;
}

export interface SolveChange {
  symbol: string;
  from: string;
  to: string;
  reason: string;
}

export interface SolveConflict {
  kind: 'user_request' | 'pinned_layer';
  symbol: string;
  requested?: string;
  pinnedValue?: string;
  layerId?: string;
  layerPath?: string;
}

export interface SolveResponse {
  status: 'ok' | 'conflict';
  solveTimeMs: number;
  changes: SolveChange[];
  conflicts: SolveConflict[];
  diagnostics: string[];
}

export interface ApplyResponse {
  verified: boolean;
  mismatches: Array<{ symbol: string; expected: string; actual: string }>;
  configureWarnings: string[];
}

```

### 4.2 Webview ↔ Extension Host Message Union

Use a discriminated union (`type` tag) with a correlation `reqId` for request/response pairs, plus fire-and-forget push events from the host:

```ts
// Webview -> Extension Host
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'getTree'; reqId: string; parentId: string | null }
  | { type: 'search'; reqId: string; query: string; limit?: number; onlyChanged?: boolean }
  | { type: 'getSymbolDetail'; reqId: string; symbol: string }
  | { type: 'solve'; reqId: string; requests: Array<{ symbol: string; value: string }>; ignorePins?: boolean }
  | { type: 'apply'; reqId: string; changes: Array<{ symbol: string; value: string }> }
  | { type: 'updateLayers'; reqId: string; baseTarget: string; layers: ConfigLayer[]; applyNow?: boolean }
  | { type: 'pickAndInjectLayer'; reqId: string; copyIntoWorkspace: boolean }
  | { type: 'reloadAll'; reqId: string };

// Extension Host -> Webview
export type HostToWebviewMessage =
  | { type: 'initState'; status: 'loading' | 'ready' | 'error'; error?: string; stats?: { symbolCount: number; initTimeMs: number; warnings: string[] }; baseTarget?: string; layers?: ConfigLayer[]; rootNodes?: KconfigNode[] }
  | { type: 'response'; reqId: string; ok: true; payload: unknown }
  | { type: 'response'; reqId: string; ok: false; error: { code: number; message: string; data?: unknown } }
  | { type: 'externalConfigChanged'; changedAt: number }
  | { type: 'backendStatus'; state: 'starting' | 'running' | 'restarting' | 'stopped'; message?: string };

```

---

## 5. Extension Host Component Design (`src/kconfig/`)

### 5.1 Resilient JSON-RPC 2.0 Client (`src/kconfig/rpcClient.ts`)

`KconfigRpcClient` must be implemented **without any direct `vscode` module dependency** (accepting an injected logger callback `(line: string) => void` instead of `vscode.OutputChannel`). This allows Vitest to execute full client-to-daemon IPC tests in plain Node.js without launching Electron.

#### Implementation Instructions

1. **Process Spawning:**
* Spawn `child_process.spawn(pythonPath, ['-m', 'kconfig_server.main', 'serve'], { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] })`.
* Enforce UTF-8 encoding on `stdin`, `stdout`, and `stderr`.


2. **NDJSON Framing & Line Buffering:**
* Do **not** assume one `data` chunk equals one JSON line. Pipe `proc.stdout` into `readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })`.
* On each line, parse JSON. Ignore blank lines. If JSON parsing fails, log raw output to `logger` and emit a protocol error without crashing the Extension Host.


3. **Request Correlation & Timeouts:**
* Maintain `nextId = 1` and `pending = new Map<number, PendingRequest>()` storing `{ resolve, reject, timer, method }`.
* Apply per-method timeouts:
* `kconfig/init`: `60_000 ms` (cold Kconfig parse + make env probe).
* `kconfig/apply`: `45_000 ms` (`merge_config.sh` + `olddefconfig` + `syncconfig`).
* Interactive calls (`getTree`, `search`, `getSymbolDetail`, `solve`): `10_000 ms`.


* On timeout, remove from `pending` and reject with a typed `RpcTimeoutError`.


4. **Stderr Routing:**
* Forward every line from `proc.stderr` to the injected `logger` (wired to `vscode.window.createOutputChannel('Kernel Dev: Kconfig')` in `extension.ts`).


5. **Crash Handling & Controlled Restart:**
* On unexpected `exit` event (when not intentionally disposing), reject all in-flight promises with `RpcProcessExitedError`, emit `backendStatus: 'stopped'`, and support explicit `restart()` (or automatic single retry with re-`init` on next request, capped at 2 consecutive restarts to prevent restart loops).


6. **Clean Shutdown (`dispose()`):**
* Close `stdin` first (signaling EOF to Python's `sys.stdin` loop), wait up to `2_000 ms` for graceful exit, then escalate to `SIGTERM` and finally `SIGKILL`.



---

### 5.2 Panel Controller & VSCode Integration (`src/kconfig/panelController.ts`)

1. **Singleton Panel with `retainContextWhenHidden`:**
* Create a single `vscode.WebviewPanel` (`viewType: 'kdev.kconfigEditor'`) with `{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [Uri.joinPath(extUri, 'dist', 'webview')] }`.
* Calling `kdev.openKconfigEditor` while already open simply calls `panel.reveal()`.


2. **Strict Content Security Policy (CSP):**
* Generate a fresh 32-byte cryptographic `nonce` per panel creation:
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'unsafe-inline';
               font-src ${webview.cspSource};
               script-src 'nonce-${nonce}';">

```


* Load `dist/webview/kconfig.js`, `dist/webview/kconfig.css`, and `dist/webview/codicons/codicon.css` via `webview.asWebviewUri(...)`.


3. **Initialization Sequence:**
* Wait for `{ type: 'ready' }` from Webview before sending `{ type: 'initState', ... }` (prevents race conditions where the host posts before React mounts its message listener).
* If the RPC daemon is not initialized yet, send `{ type: 'initState', status: 'loading' }`, invoke `kconfig/init` + `kconfig/layers/get` + `kconfig/getTree(null)`, and push `{ type: 'initState', status: 'ready', ... }`.


4. **Native User Config Injection (`pickAndInjectLayer`):**
* Call `vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Kernel Config': ['config', 'cfg', 'fragment'], 'All Files': ['*'] } })`.
* If `copyIntoWorkspace` is true, copy the file into `configs/user_injected/<filename>` and store the workspace-relative path in `layers.json`; otherwise store the normalized path directly.
* Insert the new layer **immediately before the `solver` layer** (so solver overrides remain highest precedence unless reordered by the user), persist via `kconfig/layers/set`, and return the updated layer list.


5. **Authoritative Apply & Automatic `clangd` Refresh (`apply`):**
* Forward `kconfig/apply` to the Python backend.
* Suppress self-triggered events in `configWatcher.ts` during the apply window.
* On success, if `kdev.autoRestartClangd` is `true`, execute:
```ts
const clangdExt = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
if (clangdExt?.isActive) {
  await vscode.commands.executeCommand('clangd.restart');
}

```


* If `ApplyResponse.verified === false`, surface a prominent VSCode warning notification listing mismatched symbols alongside the Webview alert banner.



---

### 5.3 External File Watcher (`src/kconfig/configWatcher.ts`)

* Watch `build/current/.config` and `configs/layers.json` using `vscode.workspace.createFileSystemWatcher`.
* Debounce change events by `500 ms` and ignore events fired while `panelController` holds an active `isApplying` lock.
* When an external edit occurs (e.g., user ran `scripts/configure.sh` from terminal), call `kconfig/reloadConfig` on the daemon and post `{ type: 'externalConfigChanged' }` to the Webview so displayed symbol values refresh cleanly.

---

## 6. Webview UI Design (`webview-ui/src/`)

### 6.1 Visual Layout & Theme Fidelity

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ [LayerBar] Base: [defconfig ▾]  [🔒 qemu.config] [🔒 trace.config]         │
│            [user.cfg ×] [solver_overlay (auto)]   [+ Inject Config] [↻]   │
├────────────────────────────────────────────────────────────────────────────┤
│ [SearchBar] 🔍 Search symbol / prompt / help...   [☐ Modified Only]       │
├──────────────────────┬──────────────────────────────────┬──────────────────┤
│ MenuTree (26%)       │ SymbolList (44%)                 │ DetailPane (30%) │
│                      │                                  │                  │
│ ▾ Networking support │ NET_SCHED         [N][M][Y]      │ CONFIG_NET_SCH_FQ│
│   ▸ Wireless         │   QoS and/or fair queueing       │ Type: tristate   │
│   ▾ Networking opts  │                                  │ Status: n        │
│     • QoS / Sched    │ NET_SCH_FQ (dim)  [N][M][Y]      │                  │
│ ▸ File systems       │   Fair Queue packet scheduler    │ Depends on:      │
│ ▸ Kernel hacking     │   ⚠ requires NET_SCHED           │  • NET (y ✓)     │
│                      │                                  │  • NET_SCHED(n ✗)│
│                      │ KPROBES 🔒qemu/trace [N][Y]      │                  │
│                      │   Kprobes (pinned by trace)      │ Help: ...        │
└──────────────────────┴──────────────────────────────────┴──────────────────┘

```

* Style strictly with VSCode CSS variables (`--vscode-editor-background`, `--vscode-sideBar-background`, `--vscode-panel-border`, `--vscode-button-background`, `--vscode-editorWarning-foreground`, `--vscode-errorForeground`) so dark, light, and high-contrast themes work natively.

### 6.2 Key UX Mechanics

1. **Lazy Menu Tree (`MenuTree.tsx`):**
* Cache children in a `Record<string, KconfigNode[]>` map inside `store.ts`.
* Clicking an unexpanded menu node requests `getTree(node.id)` once; invalidate cached values (or patch symbol values in place) after `apply` or `externalConfigChanged`.


2. **Always-Clickable Dependency-Blocked Symbols (`SymbolList.tsx`):**
* Unlike `menuconfig`, symbols where `visible === false` are rendered visually muted with an indicator (`auto-resolve`), **not disabled**.
* Clicking `[Y]` or `[M]` on any symbol dispatches `{ type: 'solve', requests: [{ symbol, value }] }` and opens `SolveModal` in a loading state (typically resolving in `< 300ms`).
* For `int`/`hex`/`string` symbols, render an inline input field with a Save button that routes directly to `apply` (since non-bool symbols are folded constants in the SAT model).


3. **Diff Preview & Conflict Resolution Modal (`SolveModal.tsx`):**
* **When `status === 'ok'`:**
* Group changes into **Requested Change** and **Auto-Resolved Dependencies (`N` symbols)**.
* Show a table: `Symbol | From -> To | Reason` (`user_request`, `required_by:X`, `selected_by:X`, `choice_replaced_by:X`).
* Footer actions: **Cancel** | **Apply & Sync `#ifdef**` (triggers `apply`, shows spinner while `configure.sh` + `syncconfig` runs, displays `verified` status and any `merge_config.sh` warnings).


* **When `status === 'conflict'`:**
* Highlight each item in `conflicts[]`, explicitly naming the conflicting pinned layer (e.g., `CONFIG_MODULES=y is pinned by configs/trace.config`).
* Display `diagnostics[]` for non-pin impossibilities (e.g., architecture mismatch or blocked `INT` constant).
* If pinned layers are involved, offer a clearly labeled secondary action: **"Re-solve Ignoring Pins (`ignorePins: true`)"** so the user can consciously inspect and override a pin if desired.




4. **Layer Management (`LayerBar.tsx`):**
* Support toggling `enabled`, toggling `pinned` (`🔒`), moving layers up/down (precedence order), removing user-injected layers, and clicking **`+ Inject Config`** to trigger the native VSCode file picker.
* Keep `solver_overlay.config` visually distinct as the backend-managed layer, with a **"Reset Solver Overlay"** action to revert manual overrides back to base + injected fragments.



---

## 7. Frontend–Backend Connection & Verification Test Plan

Because the frontend and backend communicate across two process boundaries (`Webview <-> Extension Host <-> Python Daemon`), testing is structured into **4 explicit layers** that verify every boundary deterministically.

### Layer 1: Protocol & Transport Unit Tests (`extension/test/unit/rpcClient.test.ts`)

Runs in Vitest (Node.js, `< 2s`) using a tiny stub Node/Python script over real stdio pipes to verify `KconfigRpcClient` edge cases without needing a kernel tree:

| Test Case | Mechanism | Assertion |
| --- | --- | --- |
| **Chunked / Split NDJSON** | Stub writes a single JSON response split across 3 `write()` calls with delays and two responses in 1 chunk. | Both promises resolve with exact payloads. |
| **Out-of-Order Responses** | Send req #1 and req #2; stub replies to #2 before #1. | Responses correlate to the correct caller by `id`. |
| **Stderr Isolation** | Stub prints warnings/tracebacks to `stderr` while returning valid JSON on `stdout`. | RPC succeeds; `stderr` lines arrive verbatim in injected logger. |
| **Request Timeout** | Stub sleeps past configured timeout. | Rejects with `RpcTimeoutError` and cleans up `pending` map. |
| **Daemon Crash & Recovery** | Kill child process mid-flight. | In-flight request rejects cleanly (`RpcProcessExitedError`), `backendStatus` emits `'stopped'`, and `restart()` restores connectivity. |
| **Graceful Dispose** | Call `client.dispose()`. | Closes `stdin`, process exits cleanly with zero orphan processes. |

### Layer 2: Real Frontend Client ↔ Real Python Backend Integration Tests (`extension/test/integration/rpcBackend.test.ts`)

Runs in Vitest by spawning the **actual Python `kconfig_server**` (`backend/.venv/bin/python -m kconfig_server.main serve`) from `KconfigRpcClient` against a temporary workspace copy containing the synthetic Kconfig fixtures from `backend/tests/fixtures/` (and an optional `REAL_KERNEL=1` test against `kdev-workspace/linux/`):

1. **Handshake & Tree Traversal:** Call `kconfig/init` → verify `symbolCount > 0` → call `kconfig/getTree(null)` → expand a submenu and verify child nodes match fixture definitions.
2. **Search & Detail Round-Trip:** Call `kconfig/search` and `kconfig/getSymbolDetail` → verify prompt, help text, and `depends on` fields serialize cleanly across Python ↔ TypeScript types.
3. **Auto-Solve & UNSAT Conflict Round-Trip:**
* Request a dependency-blocked symbol → assert `SolveResponse.status === 'ok'` and prerequisite symbols appear in `changes` with provenance reasons.
* Request a symbol contradicting a pinned layer → assert `SolveResponse.status === 'conflict'` and `conflicts` contains the exact `layerId`.
* Re-request with `ignorePins: true` → assert `status === 'ok'`.


4. **Apply & Post-Verification Round-Trip:**
* Call `kconfig/apply` (using a stub `scripts/configure.sh` in fixture mode, or the real Phase 1 `scripts/configure.sh` when `REAL_KERNEL=1`).
* Verify `configs/solver_overlay.config` is written, `ApplyResponse.verified === true`, and `kconfig/reloadConfig` reflects the new symbol state.



### Layer 3: Webview UI & State Reducer Tests (`extension/test/unit/store.test.ts`, `components.test.tsx`)

Runs in Vitest (`jsdom`) with a mocked `vscodeApi.ts`:

* Clicking `[Y]` on a dimmed symbol dispatches `{ type: 'solve', ... }` and opens `SolveModal` with returned diff rows.
* Receiving `status: 'conflict'` renders the pinned-layer warning and enables the **"Re-solve Ignoring Pins"** button, which re-dispatches `{ type: 'solve', ignorePins: true }`.
* Clicking **Apply** disables buttons while in flight, updates local symbol states on `{ ok: true }`, and surfaces mismatch warnings if `verified === false`.
* Receiving `{ type: 'externalConfigChanged' }` triggers a tree/symbol refresh without losing the user's expanded menu state.

### Layer 4: VSCode Extension Host E2E Tests (`extension/test/e2e/suite/kconfig.e2e.ts`)

Runs inside a headless VSCode instance via `@vscode/test-electron` pointed at `kdev-workspace/`:

1. Execute `vscode.commands.executeCommand('kdev.openKconfigEditor')` → verify extension activates and the Webview panel opens without uncaught errors.
2. Verify `kconfig/init` completes against the workspace and `OutputChannel` contains no fatal Python tracebacks.
3. Trigger a test `apply` flow via an internal test-only command hook (or exported controller API in test mode) → verify `build/current/include/generated/autoconf.h` mtime updates and `clangd.restart` invocation is recorded.
4. Modify `build/current/.config` externally on disk → verify `configWatcher` triggers `kconfig/reloadConfig` without crashing.
5. Verify `git -C linux status --porcelain` remains empty after the entire E2E suite completes.

### Unified Test Commands (`extension/package.json`)

```json
{
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.webview.json --noEmit",
    "test:unit": "vitest run test/unit",
    "test:ipc": "vitest run test/integration",
    "test:ipc:real": "REAL_KERNEL=1 vitest run test/integration",
    "test:e2e": "node ./dist/test/e2e/runTest.js",
    "test:all": "npm run typecheck && npm run build && npm run test:unit && npm run test:ipc"
  }
}

```
