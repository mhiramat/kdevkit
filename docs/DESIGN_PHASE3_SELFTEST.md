# Design & Implementation Specification: Phase 3A — kselftest Integration & QEMU Test Runner (`DESIGN_PHASE3_SELFTEST.md`)

## 1. Overview & Objectives

This document specifies the design, script/TypeScript implementation guide, and verification plan for **Phase 3A** of **`kdevkit`**: integrating Linux kernel `kselftest` discovery, configuration synchronization, build/staging, and automated QEMU execution into the VSCode Testing API (`TestController`).

Phase 3A builds directly on Phase 1 (`scripts/run_qemu.sh`, `build/current/shared/`), the Kconfig SAT solver backend (`build/current/layers.json`, `build/current/user_injected/`), and Phase 2 Kprobes (`shared/setup_kprobes.sh`, `shared/trace.log`), connecting all three layers into a single test-and-trace loop without modifying a single file inside `kdevkit/linux/`.

### Core Objectives
* **Maintainer-Focused Target Filtering:** Because `linux/tools/testing/selftests/` contains 100+ subsystem directories, discovery is driven by an explicit target filter (`kdev.selftest.targets`) plus a QuickPick target manager so developers only see and build the subsystems they maintain.
* **Automatic `config` Detection & Kconfig Solver Integration:** Automatically detect `linux/tools/testing/selftests/<target>/config` (and architecture-specific `config.<arch>`), diff it against `build/current/.config`, symlink it into `build/current/user_injected/`, register it in `build/current/layers.json`, and invoke the Kconfig MaxSAT solver so prerequisites are resolved with minimal user effort.
* **Minimal BusyBox Compatibility for C Test Binaries:**
  * **Default Mode (`auto-libs` — Option A):** Inspect built ELF test binaries with `ldd`, automatically collect required shared libraries (`.so`) and the dynamic linker into `build/current/shared/kselftest-libs/`, and wire them at guest runtime without requiring root privileges or repacking `initramfs.cpio.gz`.
  * **Optional Mode (`static` — Option B):** Allow workspace-wide or per-target static linking (`LDFLAGS=-static`) for self-contained C test binaries where supported.
  * **Future Extension (`external-rootfs` — Option C, TODO):** Reserve clean script and TypeScript interfaces for booting external rootfs images or extended 9p userspaces when introducing heavier external test suites in the future.
* **Native VSCode Test Explorer & Streaming KTAP:** Present targets and test cases in VSCode's Test Explorer, stream QEMU serial logs live to the Test Results output, parse **KTAP (Kernel Test Anything Protocol)** output in real time, and support timeouts and cancellation.
* **Joint Execution with Phase 2 Kprobes:** Provide dedicated Test Run Profiles (`Run in QEMU` and `Run in QEMU with Active Kprobes`) so developers can execute a selftest while capturing Kprobe trace events into `trace.log` in one click.

---

## 2. Parent Workspace Integration & Directory Layout

All new runtime artifacts live under `build/current/` and all code lives under `scripts/` and `extension/src/`, keeping `kdevkit/linux/` 100% clean.

```text
kdevkit/
├── docs/
│   ├── DESIGN_PHASE1.md
│   ├── DESIGN_KCONFIG_BACKEND.md
│   ├── DESIGN_KCONFIG_FRONTEND.md
│   ├── DESIGN_PHASE2_KPROBES.md
│   ├── DESIGN_PHASE3_SELFTEST.md        # This document
│   └── DESIGN_PHASE3_TRACE_PLOT.md      # Companion Phase 3B document
├── scripts/
│   ├── env.sh                           # Shared env vars (extended with SELFTEST_* defaults)
│   ├── build_initramfs.sh               # Ensures writable /lib & /lib64 mount/symlink targets
│   ├── build_selftest.sh                # Standalone CLI builder: kselftest install + Option A/B libs
│   └── run_qemu.sh                      # Phase 1 launcher (future TODO hook for ROOTFS_IMAGE)
├── build/current/
│   ├── .config                          # Active kernel config (checked against selftest config)
│   ├── layers.json                      # Kconfig layer manifest (receives selftest-<target> layers)
│   ├── user_injected/
│   │   └── selftest-<target>.config     # Symlink -> ../../../linux/tools/testing/selftests/<target>/config
│   └── shared/                          # 9p VirtIO hostshare (Guest /mnt/host)
│       ├── kselftest/                   # Installed kselftest target tree & kselftest-list.txt
│       ├── kselftest-libs/              # [Option A] Auto-collected dynamic linker & .so files
│       ├── setup_kprobes.sh             # [Phase 2] Applied before run_target.sh when Kprobes enabled
│       ├── run_target.sh                # [Phase 3A] Generated guest runner script for selected tests
│       ├── exit_code                    # [Phase 1] Captured exit status of run_target.sh
│       └── trace.log                    # [Phase 1/2] Captured Tracefs output on guest exit
├── extension/
│   ├── src/
│   │   ├── extension.ts                 # Registers SelftestController & QemuRunner
│   │   ├── qemu/
│   │   │   └── qemuRunner.ts            # [vscode-free] Managed QEMU child process, streaming, timeout, cancel
│   │   └── selftest/
│   │       ├── types.ts                 # TargetSpec, SelftestItem, KtapEvent, ConfigCheckResult
│   │       ├── discovery.ts             # [vscode-free] Target scanner, Makefile/list parser, config detector
│   │       ├── ktapParser.ts            # [vscode-free] Streaming KTAP v1 parser (nested subtests, SKIP/XFAIL)
│   │       ├── configBridge.ts          # Symlinks target config -> user_injected/ & invokes Kconfig solver
│   │       ├── scriptGenerator.ts       # [vscode-free] Generates shared/run_target.sh with sentinel markers
│   │       └── selftestController.ts    # VSCode TestController, RunProfiles, UI actions
│   └── test/
│       ├── unit/
│       │   ├── discovery.test.ts        # Target filtering, Makefile parsing, config diffing
│       │   ├── ktapParser.test.ts       # Streaming chunked KTAP, nested subtests, SKIP/XFAIL/FAIL
│       │   └── scriptGenerator.test.ts  # run_target.sh generation, LD_LIBRARY_PATH, Kprobe toggle
│       └── integration/
│           └── selftestQemu.test.ts     # End-to-end build_selftest.sh + QEMU run (e.g., bootconfig/ftrace)
└── linux/                               # Upstream Linux Git repository (untouched)
```

---

## 3. C Binary Runtime Strategy (Option A Default, Option B Optional, Option C TODO)

Phase 1 boots a minimal rootless `initramfs.cpio.gz` containing only a statically linked BusyBox binary and compiled kernel modules. Many `kselftest` suites compile C test binaries that dynamically link against `libc`, `libpthread`, `librt`, `libm`, or `libcap`.

### 3.1 Option A (Default): Automatic Shared Library Staging (`auto-libs`)

Implemented in `scripts/build_selftest.sh` so it works identically from VSCode, terminal CLI, and agent skills.

#### Host Staging Steps (`scripts/build_selftest.sh`)
1. **Build & Install Out-of-Tree:**
   Compile and install only the requested `TARGETS` into `build/current/shared/kselftest/` with intermediate build objects placed in `build/current/kselftest-obj/` (keeping `linux/` completely clean):
   ```bash
   make -C "${KERNEL_DIR}/tools/testing/selftests" \
     O="${BUILD_DIR}/kselftest-obj" \
     ARCH="${ARCH}" \
     TARGETS="${TARGETS}" \
     INSTALL_PATH="${SHARED_DIR}/kselftest" \
     install
   ```
   *(Pass `KHDR_INCLUDES="-I${BUILD_DIR}/usr/include"` after running `make -C "${KERNEL_DIR}" O="${BUILD_DIR}" headers_install` if kernel UAPI headers are not yet staged in `BUILD_DIR/usr/include`.)*
2. **ELF Discovery:**
   Scan `${SHARED_DIR}/kselftest/` for regular executable files whose first 4 bytes match the ELF magic `\x7fELF`.
3. **Shared Library & Interpreter Collection (`ldd`):**
   For each dynamically linked ELF binary:
   * Run `ldd "<binary>"` (ignoring `linux-vdso.so.*`).
   * Extract every resolved absolute library path (`=> /path/to/lib.so` and the dynamic interpreter such as `/lib64/ld-linux-x86-64.so.2`).
   * Copy (dereferencing symlinks via `cp -L` while preserving the expected SONAME path) into `${SHARED_DIR}/kselftest-libs/` mirroring the root-relative directory layout (e.g., `kselftest-libs/lib64/ld-linux-x86-64.so.2`, `kselftest-libs/lib/x86_64-linux-gnu/libc.so.6`).
   * Record a compact manifest `${SHARED_DIR}/kselftest-libs/manifest.txt` listing the interpreter path and all library directories for `run_target.sh`.

#### Guest Runtime Wiring (Zero `initramfs` Rebuild Required)
Instead of repacking `initramfs.cpio.gz` every time a selftest is rebuilt, `run_target.sh` wires the staged 9p libraries directly before executing tests:
1. Ensure Phase 1's `scripts/build_initramfs.sh` creates `/lib64` (and `/lib`, `/usr/lib`) in the `initramfs` tmpfs root so the guest can create symlinks without read-only errors.
2. At the top of `shared/run_target.sh`:
   ```sh
   # Wire dynamic linker and collected shared libraries from 9p share
   if [ -d /mnt/host/kselftest-libs ]; then
     for dir in lib lib64 usr/lib usr/lib64; do
       if [ -d "/mnt/host/kselftest-libs/$dir" ]; then
         mkdir -p "/$dir"
         for item in "/mnt/host/kselftest-libs/$dir"/*; do
           [ -e "$item" ] || continue
           base="$(basename "$item")"
           [ -e "/$dir/$base" ] || ln -s "$item" "/$dir/$base"
         done
       fi
     done
     export LD_LIBRARY_PATH="/mnt/host/kselftest-libs/lib:/mnt/host/kselftest-libs/lib64:/mnt/host/kselftest-libs/lib/x86_64-linux-gnu:/mnt/host/kselftest-libs/usr/lib:/mnt/host/kselftest-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
   fi
   ```
   *(Because `initramfs` runs in RAM tmpfs, symlinking the ELF interpreter path `/lib64/ld-linux-x86-64.so.2 -> /mnt/host/kselftest-libs/lib64/ld-linux-x86-64.so.2` satisfies the kernel's `PT_INTERP` lookup immediately and cleanly.)*
3. **Environment Normalization for Shell-Based Selftests:**
   Mount `debugfs` (`/sys/kernel/debug`) if supported and not already mounted, ensure `/sys/kernel/tracing` is mounted, export `TMPDIR=/tmp`, and prepend `/bin:/sbin:/usr/bin:/usr/sbin` to `PATH`.

### 3.2 Option B (Optional): Static Linking Mode (`static`)

Controlled via `kdev.selftest.linkMode` (`"auto-libs"` | `"static"`) and per-target overrides (`kdev.selftest.targetOptions`), passed to `scripts/build_selftest.sh` as `SELFTEST_LINK_MODE=static`:
* Passes `LDFLAGS="-static"` (or target-compatible `EXTRA_LDFLAGS="-static"`) to `make`.
* After build, `build_selftest.sh` still checks binaries with `ldd`: if a specific test Makefile ignores `LDFLAGS` and emits a dynamically linked binary, `build_selftest.sh` logs a warning and falls back to Option A collection for that binary rather than failing silently in QEMU.

### 3.3 Option C (Future Extension — Tracked TODO): Pluggable External RootFS & External Test Harnesses

> **TODO (Future Milestone — External RootFS / Userspace Harness Support):**
> Some subsystem selftests (e.g., `net`, `bpf`, `mm` Python helpers) and third-party external test tools require full GNU coreutils, `bash`, `python3`, `iproute2`, or custom packages beyond BusyBox + `.so` staging.
>
> **Reserved Design Hooks (to be implemented later without breaking Phase 3A):**
> 1. **`scripts/env.sh` & `scripts/run_qemu.sh`:** Add optional `ROOTFS_MODE="initramfs" | "ext4-image" | "virtiofs-root"` and `ROOTFS_IMAGE="<path>"` variables. When `ROOTFS_MODE=ext4-image`, boot via `-drive file="${ROOTFS_IMAGE}",format=raw,if=virtio` with `-append "root=/dev/vda rw ..."` while keeping the identical `-virtfs hostshare` mount (`/mnt/host`) and `/mnt/host/run_target.sh` + `setup_kprobes.sh` + `trace.log` contract.
> 2. **Extension Interface (`src/selftest/types.ts`):** Define a `GuestRuntimeProfile` interface (`kind: 'busybox-initramfs' | 'external-rootfs'`) so `QemuRunner` and `SelftestController` can select per-target runtime profiles (and host external non-kselftest tools) in a future phase without refactoring the `TestController` or KTAP pipeline.

---

## 4. Target Discovery, Filtering & Kconfig Solver Bridge

### 4.1 Discovery & Filtering (`src/selftest/discovery.ts`)

1. **Workspace Target Filter (`kdev.selftest.targets`):**
   * Default: `[]` (no targets auto-expanded until the developer picks targets, keeping startup instantaneous and uncluttered).
   * Provide a prominent view action / command **`kdev.selftest.selectTargets` ("Select Selftest Targets...")**: scans `linux/tools/testing/selftests/` for subdirectories containing a `Makefile`, presents a multi-select `QuickPick` (highlighting directories that contain a `config` file), and persists the chosen list into workspace settings (`kdev.selftest.targets`).
2. **Two-Tier Test Item Discovery (Fast Static + Accurate Post-Build):**
   * **Tier 1 (Before Build — Static Scan):** For each enabled target directory, inspect `Makefile` for `TEST_PROGS`, `TEST_GEN_PROGS`, `TEST_PROGS_EXTENDED`, and `TEST_FILES` declarations (handling `+=` and `\` line continuations) to populate child `TestItem`s immediately without invoking `make`.
   * **Tier 2 (After Build — Authoritative `kselftest-list.txt`):** Whenever `build/current/shared/kselftest/kselftest-list.txt` exists for a target, reconcile the target's child `TestItem`s with the exact `<target>:<executable>` entries emitted by Kbuild's `install` target.
   * **Special Case — Sub-Suite Drivers (e.g., `ftrace/ftracetest`):** Support optional sub-test discovery when a target contains a known test directory (such as `ftrace/test.d/**/*.tc`) so maintainers can run either the whole `ftrace` suite or an individual `.tc` test case via `ftracetest <testcase>`.

### 4.2 Automatic `config` Detection & Kconfig Solver Integration (`src/selftest/configBridge.ts`)

Eliminating manual `.config` hunting is a primary usability requirement.

#### Config Detection Rules
For any target `<target>` under `linux/tools/testing/selftests/<target>/`:
1. Check for `config` (and optional `config.${ARCH}`, e.g., `config.x86_64`).
2. Parse fragment lines (`CONFIG_FOO=y`, `CONFIG_FOO=m`, `# CONFIG_FOO is not set`) using the same canonical syntax as `DESIGN_KCONFIG_BACKEND.md`.
3. Compare against `build/current/.config` to compute `ConfigCheckResult`:
   * `status: 'satisfied' | 'missing' | 'no-config-file'`
   * `missing: Array<{ symbol: string; required: string; current: string }>`
   * `configPaths: string[]`

#### Visual Indicator & One-Click Solver Flow
* **In Test Explorer:** Targets with unmet requirements display a clear description badge on the parent `TestItem` (e.g., `ftrace (⚠ 3 config options missing)`).
* **Command `kdev.selftest.syncTargetConfig` (and Pre-Run Guard):**
  When triggered directly from the target item or via the pre-run prompt (`kdev.selftest.checkConfigBeforeRun: "prompt"`):
  1. **Symlink into `build/current/user_injected/`** (zero pollution in `linux/`):
     ```text
     build/current/user_injected/selftest-<target>.config
       -> <abs-or-relative-path-to>/linux/tools/testing/selftests/<target>/config
     ```
  2. **Register in `build/current/layers.json`:**
     Insert layer `{ id: "selftest-<target>", path: "build/current/user_injected/selftest-<target>.config", enabled: true, pinned: false }` immediately before `solver_overlay.config` (if not already present) via `KconfigRpcClient` (`kconfig/layers/set`).
  3. **Auto-Solve Prerequisites via Kconfig Backend:**
     Send `kconfig/solve` with `requests = missing.map(m => ({ symbol: m.symbol, value: m.required }))`.
     * Open the **Kconfig Editor Panel** pre-populated with the `SolveModal` diff preview (showing the selftest's required symbols, all MaxSAT auto-resolved dependencies, and any UNSAT Core conflicts against pinned `qemu.config` / `trace.config`).
     * When the user clicks **Apply**, the existing Kconfig flow writes `build/current/solver_overlay.config`, runs `scripts/configure.sh` (`syncconfig` + `.clangd`), and restarts `clangd`.
     * Prompt the user with a one-click notification: **"Selftest config applied. Rebuild Kernel & Modules now?"** (invoking `scripts/build_kernel.sh` and `scripts/build_initramfs.sh`).

---

## 5. QEMU Runner, Guest Execution Script & Streaming KTAP Parser

### 5.1 Managed QEMU Runner (`src/qemu/qemuRunner.ts`)

Must have **zero `vscode` imports** so it can be unit-tested and reused across Selftest runs, Kprobe runs, and future automation.

* **Process Execution:** Spawns `scripts/run_qemu.sh` in a dedicated process group (`detached: true` on Linux) so cancellation can cleanly terminate the entire process group (`process.kill(-pid, 'SIGTERM')`, escalating to `SIGKILL` after 3 seconds).
* **Real-Time Line Streaming:** Pipes `stdout` and `stderr` via `readline` callbacks (`onLine(line, stream)`) so the VSCode Test Results terminal displays live kernel boot and test progress in real time.
* **Watchdog Timeout:** Configurable `kdev.selftest.timeoutSec` (default `300` seconds). Supports both overall run timeout and optional boot-hang detection (if the `=== KDEV_SELFTEST_BEGIN ===` sentinel does not appear within `bootTimeoutSec`, default `60` seconds).
* **Mutual Exclusion:** Enforce a single active QEMU run lock (`QemuBusyError` / queued run notification) because `build/current/shared/run_target.sh`, `exit_code`, and `trace.log` are single-slot profile artifacts.

### 5.2 Guest Execution Script (`src/selftest/scriptGenerator.ts`)

Generates `build/current/shared/run_target.sh` (`mode: 0o755`) tailored to the selected `TestItem`s:

```sh
#!/bin/sh
set -u

# 1. Wire Phase 3A Option A shared libraries (no initramfs rebuild needed)
if [ -d /mnt/host/kselftest-libs ]; then
  for dir in lib lib64 usr/lib usr/lib64; do
    if [ -d "/mnt/host/kselftest-libs/$dir" ]; then
      mkdir -p "/$dir"
      for item in "/mnt/host/kselftest-libs/$dir"/*; do
        [ -e "$item" ] || continue
        base="$(basename "$item")"
        [ -e "/$dir/$base" ] || ln -s "$item" "/$dir/$base"
      done
    fi
  done
  export LD_LIBRARY_PATH="/mnt/host/kselftest-libs/lib:/mnt/host/kselftest-libs/lib64:/mnt/host/kselftest-libs/lib/x86_64-linux-gnu:/mnt/host/kselftest-libs/usr/lib:/mnt/host/kselftest-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi

# 2. Ensure debugfs/tracefs and temp paths exist
mkdir -p /sys/kernel/debug /tmp
mount -t debugfs nodev /sys/kernel/debug 2>/dev/null || true
export TMPDIR=/tmp
export kselftest_override_timeout=120

echo "=== KDEV_SELFTEST_BEGIN ==="
cd /mnt/host/kselftest || exit 127

# 3. Run selected target/tests via kselftest's own run_kselftest.sh (or direct invocation)
./run_kselftest.sh -t "bootconfig:test-bootconfig.sh"
RC=$?

echo "=== KDEV_SELFTEST_END rc=$RC ==="
exit "$RC"
```

* **Cleanup Guarantee:** After QEMU exits (or is cancelled), `SelftestController` removes the execute bit or deletes `shared/run_target.sh` (unless `kdev.selftest.keepRunScript` is enabled for debugging) so subsequent manual runs of `kdev: Run QEMU` return to interactive BusyBox shell mode cleanly.

### 5.3 Streaming KTAP v1 Parser (`src/selftest/ktapParser.ts`)

Must have **zero `vscode` imports**. Parses lines strictly between `=== KDEV_SELFTEST_BEGIN ===` and `=== KDEV_SELFTEST_END ===` (ignoring kernel boot `dmesg` noise, while capturing kernel `BUG:` / `Oops:` / `Call Trace:` lines as crash diagnostics).

#### Parsed Grammar Rules
| KTAP Line Pattern | Emitted Event | VSCode TestRun Mapping |
| :--- | :--- | :--- |
| `# selftests: <target>: <test>` | `suiteStart` | `run.started(item)` |
| `ok <n> <desc>` | `testResult('pass')` | `run.passed(item, durationMs)` |
| `ok <n> <desc> # SKIP <reason>` | `testResult('skip')` | `run.skipped(item)` |
| `ok <n> <desc> # XFAIL <reason>` | `testResult('xfail')` | `run.passed(item)` (annotated as XFAIL) |
| `not ok <n> <desc>` | `testResult('fail')` | `run.failed(item, new TestMessage(details))` |
| `not ok <n> <desc> # TIMEOUT ...` | `testResult('timeout')` | `run.failed(item, new TestMessage('Timeout'))` |
| Indented `ok` / `not ok` (`    ...`) | `subtestResult` | Dynamically attaches/updates child `TestItem` or appends diagnostic log to parent |
| `BUG:` / `Kernel panic` / `Call Trace:` | `kernelCrash` | Marks in-flight test `errored` with captured oops excerpt |

---

## 6. VSCode Extension Integration & Manifest Additions

### Settings (`extension/package.json` under `kdev.selftest.*`)
| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `kdev.selftest.targets` | `string[]` | `[]` | Whitelist of `tools/testing/selftests/` targets shown in Test Explorer. |
| `kdev.selftest.linkMode` | `"auto-libs" \| "static"` | `"auto-libs"` | Default C test binary strategy (Option A vs Option B). |
| `kdev.selftest.targetOptions` | `object` | `{}` | Per-target overrides, e.g. `{ "kprobes": { "linkMode": "static", "timeoutSec": 600 } }`. |
| `kdev.selftest.checkConfigBeforeRun` | `"prompt" \| "off"` | `"prompt"` | Warn and offer Kconfig solver sync if target `config` requirements are missing from `.config`. |
| `kdev.selftest.timeoutSec` | `number` | `300` | Overall QEMU selftest execution timeout in seconds. |
| `kdev.selftest.bootTimeoutSec` | `number` | `60` | Maximum wait time for guest kernel boot to reach `run_target.sh`. |
| `kdev.selftest.autoBuildBeforeRun` | `boolean` | `true` | Automatically run `scripts/build_selftest.sh` before booting QEMU. |

### Commands & Test Run Profiles
* **Commands:**
  * `kdev.selftest.selectTargets` — `kdev: Select Selftest Targets...`
  * `kdev.selftest.syncTargetConfig` — `kdev: Inject & Solve Selftest Kconfig`
  * `kdev.selftest.buildSelected` — `kdev: Build Selected Selftests`
* **Test Run Profiles (`vscode.TestRunProfileKind.Run`):**
  1. **`Run in QEMU` (Default):** Temporarily disables `setup_kprobes.sh` (or runs without enabling probes) for clean pass/fail regression testing without tracing overhead.
  2. **`Run in QEMU with Active Kprobes`:** Ensures Phase 2's `setup_kprobes.sh` is exported and executable before booting QEMU, executes the selected selftest(s), waits for `shared/trace.log` flush, refreshes `ProbeStore`, and optionally reveals the Phase 3B Trace Plotter panel.

---

## 7. Verification & Test Plan

### Layer 1: Pure Unit Tests (`extension/test/unit/`, Vitest — `< 2s`)
| Test Suite | Coverage |
| :--- | :--- |
| **`discovery.test.ts`** | Filter enforcement (`kdev.selftest.targets`); `Makefile` parsing (`TEST_PROGS`, `TEST_GEN_PROGS`, line continuations); `kselftest-list.txt` reconciliation; `config` & `config.x86_64` diffing against `.config` (`y`/`m`/`n`). |
| **`ktapParser.test.ts`** | Chunked/split stdout delivery; `ok`/`not ok`/`SKIP`/`XFAIL`/`TIMEOUT`; 4-space nested subtests (as emitted by `ftracetest` and `kselftest_harness.h`); sentinel isolation from kernel boot logs; kernel oops/panic detection. |
| **`scriptGenerator.test.ts`** | Generated `run_target.sh` POSIX syntax (`sh -n`), Option A `kselftest-libs` symlink block, selective `-t` test filtering, safe shell quoting. |

### Layer 2: Script & Shared-Library Staging Tests (`scripts/build_selftest.sh`)
1. **Option A (`auto-libs`) Smoke Test:** Build a C-based selftest target (e.g., `breakpoints` or `timens` or `size`), verify ELF binaries exist in `build/current/shared/kselftest/`, verify `kselftest-libs/` contains the dynamic linker and required `.so` files, and verify `git -C linux status --porcelain` remains empty.
2. **Option B (`static`) Smoke Test:** Run `SELFTEST_LINK_MODE=static scripts/build_selftest.sh <target>`, verify static linkage via `ldd` (or clean fallback warning when a Makefile ignores `LDFLAGS`).

### Layer 3: End-to-End QEMU + Kconfig + Kprobes Acceptance Criteria
1. Run `kdev: Select Selftest Targets...` and choose `bootconfig` and `ftrace`.
2. Confirm Test Explorer flags any missing `CONFIG_*` items from `linux/tools/testing/selftests/ftrace/config`.
3. Click **Inject & Solve Selftest Kconfig** → confirm `build/current/user_injected/selftest-ftrace.config` symlink is created, `build/current/layers.json` is updated, Kconfig Editor opens with auto-resolved dependencies, and applying updates `autoconf.h` + restarts `clangd`.
4. Run a test using **`Run in QEMU`** → verify live serial output in Test Results, accurate KTAP Pass/Fail/Skip status per case, clean QEMU poweroff, and automatic cleanup of `shared/run_target.sh`.
5. Place a Phase 2 Kprobe on a function exercised by the test, run **`Run in QEMU with Active Kprobes`**, and verify both KTAP test results and captured Kprobe events in `Trace Events` / Trace Plotter populate automatically.
6. Confirm `git -C linux status --porcelain` remains completely empty.