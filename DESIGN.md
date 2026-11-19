# Phase 1 Design Document: Linux Kernel VSCode Development Foundation (Parent Workspace Architecture)

## 1. Overview & Objectives

This document specifies the design for **Phase 1** of the VSCode-based Linux kernel development environment. Phase 1 establishes a clean, reproducible build, static analysis, and QEMU boot pipeline using existing VSCode extensions and kernel-native tooling, while laying down the exact directory and file-interface contracts required by **Phase 2** (Kprobes / Tracefs VSCode extension) and **Phase 3** (Kconfig dependency solver & trace visualization).

### Phase 1 Goals

* **Zero Kernel Tree Pollution:** Keep the upstream Linux kernel Git repository (`linux/`) completely untouched so `git status` remains clean and `git clean -fdx` inside `linux/` cannot destroy IDE settings, build artifacts, or helper scripts.
* **Layered Configuration & Injection:** Compose `.config` deterministically from a base config, QEMU boot fragment, debug/tracing fragment, and optional user-supplied fragments via `merge_config.sh`.
* **Immediate `#ifdef CONFIG_*` Visibility:** Dim (hatch out) inactive preprocessor branches by default and reflect active `CONFIG_*` selections across both built and unbuilt source files via `clangd` and `syncconfig`, without waiting for a full kernel build.
* **Out-of-Tree Build Pipeline:** Build the kernel image (`bzImage`), loadable modules, DWARF-enabled `vmlinux`, and `compile_commands.json` outside the source tree.
* **Minimal Rootless `initramfs` & QEMU Boot:** Package a pre-installed statically linked BusyBox binary and compiled modules into a minimal `initramfs.cpio.gz` and boot it under QEMU with 9p VirtIO host-guest sharing.
* **Phase 2/3 Readiness:** Expose deterministic guest `/init` hooks over the 9p share for automated Kprobe setup, kselftest execution, and Tracefs log collection.

### Non-Goals (Deferred to Phase 2 / Phase 3)

* Custom VSCode extension development (Kprobe gutter UI, `perf probe -V`/`-D` integration, trace TreeView, inline watchpoint decorations).
* Webview-based Kconfig dependency SAT solver and trace time-series plotting.
* VSCode Testing API (`TestController`) integration for `tools/testing/selftests/`.

---

## 2. Host Prerequisites

Phase 1 targets `x86_64` on a Linux host (environment variables are parameterized to allow future cross-compilation extensions).

| Category | Required Tools / Packages | Notes |
| --- | --- | --- |
| **Kernel Build** | `gcc` (or `clang`), `make`, `bc`, `bison`, `flex`, `libelf-dev`, `libssl-dev`, `python3`, `cpio`, `gzip` | Standard kernel build dependencies + `gen_compile_commands.py` runtime. |
| **IDE & LSP** | VSCode, `clangd` (v16+ recommended), VSCode extension `llvm-vs-code-extensions.vscode-clangd` | Optional: `luveti.kconfig` for Kconfig syntax highlighting. Disable Microsoft `C_Cpp` IntelliSense engine. |
| **Guest RootFS** | Statically linked `busybox` binary (e.g., `busybox-static`) | Verified at build time via `ldd`; dynamically linked binaries are rejected. |
| **Emulation** | `qemu-system-x86_64` | `/dev/kvm` access recommended for near-native boot speed; falls back to TCG if unavailable. |

---

## 3. Architecture: Parent Workspace Layout

Instead of opening the Linux kernel repository directly in VSCode, the kernel tree is nested one level below a **Parent Workspace (`kdev-workspace/`)**.

### Why Parent Workspace?

1. **`clangd` Upward Config Discovery:** When opening `linux/fs/open.c`, `clangd` walks upward (`linux/fs/` -> `linux/` -> `kdev-workspace/`) and automatically loads `kdev-workspace/.clangd`.
2. **Git Isolation:** No `.clangd`, `.vscode/`, scripts, or build outputs ever reside inside `linux/`. VSCode's built-in Git integration automatically discovers `linux/.git`, preserving full source-control UX.
3. **Multi-Tree / `git worktree` Extensibility:** Additional kernel trees (e.g., `linux-next/`) can be placed alongside `linux/` and switched via a single `KERNEL_DIR` variable.

### Directory Tree

```text
kdev-workspace/                     # VSCode Workspace Root
├── DESIGN.md                       # This document
├── .gitignore                      # Ignores linux/, build/, and generated .clangd
├── .clangd                         # Generated from scripts/clangd.template (scoped to linux/)
├── .vscode/
│   ├── extensions.json             # Recommended workspace extensions
│   ├── settings.json               # clangd config, inactive region styling, search/watcher tuning
│   └── tasks.json                  # Thin wrappers invoking scripts/*.sh
├── configs/                        # Layered Kconfig fragments
│   ├── qemu.config                 # Mandatory VirtIO, 9pfs, serial console, initrd, modules
│   ├── trace.config                # Full DWARF, Kprobes, Kprobe events, Ftrace/Tracefs
│   └── user.config.example         # Template for user-injected config fragments
├── scripts/                        # Standalone, CLI-runnable automation scripts
│   ├── env.sh                      # Shared path & default environment variables
│   ├── clangd.template             # Template for generating workspace-root .clangd
│   ├── configure.sh                # Layered merge_config.sh + olddefconfig + syncconfig + .clangd gen
│   ├── build_kernel.sh             # Out-of-tree bzImage + modules + compile_commands.json
│   ├── build_initramfs.sh          # Rootless static BusyBox + modules + /init cpio.gz builder
│   └── run_qemu.sh                 # QEMU launcher with 9p hostshare & KVM auto-detection
├── build/
│   └── current/                    # Active out-of-tree build directory (O=)
│       ├── .config
│       ├── vmlinux                 # Uncompressed kernel with full DWARF (for Phase 2 perf probe)
│       ├── compile_commands.json   # Generated compilation database for clangd
│       ├── initramfs.cpio.gz       # Minimal bootable guest rootfs
│       ├── include/generated/
│       │   └── autoconf.h          # Generated by syncconfig (<1s) for immediate #ifdef evaluation
│       └── shared/                 # 9p VirtIO shared directory (Host <-> Guest /mnt/host)
│           ├── setup_kprobes.sh    # [Phase 2 Hook] Guest Tracefs Kprobe registration script
│           ├── probes.json         # [Phase 2 Hook] Event ID <-> source file:line mapping
│           ├── run_target.sh       # [Phase 2 Hook] Automated kselftest / workload runner
│           ├── exit_code           # [Phase 2 Hook] Exit status captured from run_target.sh
│           └── trace.log           # [Phase 2 Hook] Tracefs dump collected before guest poweroff
└── linux/                          # Pure upstream Linux kernel Git clone (untouched)

```

---

## 4. Component Design

### 4.1 Shared Environment Contract (`scripts/env.sh`)

All scripts source `scripts/env.sh` so they can be executed identically from VSCode tasks, terminal sessions, or future Phase 2/3 extension subprocesses.

| Variable | Default Value | Description |
| --- | --- | --- |
| `WS_ROOT` | Absolute path to `kdev-workspace/` | Derived dynamically from `scripts/env.sh` location. |
| `KERNEL_DIR` | `${WS_ROOT}/linux` | Path to the Linux kernel Git source tree. |
| `PROFILE` | `current` | Build profile subdirectory name under `build/`. |
| `BUILD_DIR` | `${WS_ROOT}/build/${PROFILE}` | Absolute out-of-tree build path passed to `O=`. |
| `SHARED_DIR` | `${BUILD_DIR}/shared` | Host directory exported to QEMU guest as `hostshare`. |
| `ARCH` | `x86_64` | Target kernel architecture. |
| `BASE_CONFIG` | `defconfig` | Base Kconfig make target (`defconfig`, `allnoconfig`, etc.). |
| `BUSYBOX_BIN` | `$(command -v busybox)` | Path to the statically linked BusyBox binary. |
| `QEMU_BIN` | `qemu-system-x86_64` | QEMU emulator binary. |
| `QEMU_MEM` | `2G` | Guest RAM size. |
| `QEMU_SMP` | `2` | Guest vCPU count. |

---

### 4.2 Layered Kconfig Fragments (`configs/`)

#### `configs/qemu.config`

Ensures the kernel can boot a minimal `initramfs` in QEMU with serial console output, loadable module support, and VirtIO 9p filesystem sharing:

```ini
CONFIG_64BIT=y
CONFIG_SMP=y
CONFIG_PCI=y
CONFIG_PRINTK=y
CONFIG_PROC_FS=y
CONFIG_SYSFS=y
CONFIG_TMPFS=y
CONFIG_TTY=y
CONFIG_BLK_DEV_INITRD=y
CONFIG_DEVTMPFS=y
CONFIG_DEVTMPFS_MOUNT=y
CONFIG_BINFMT_ELF=y
CONFIG_BINFMT_SCRIPT=y
CONFIG_SERIAL_8250=y
CONFIG_SERIAL_8250_CONSOLE=y
CONFIG_VIRTIO_PCI=y
CONFIG_NET=y
CONFIG_NET_9P=y
CONFIG_NET_9P_VIRTIO=y
CONFIG_9P_FS=y
CONFIG_9P_FS_POSIX_ACL=y
CONFIG_MODULES=y
CONFIG_MODULE_UNLOAD=y

```

#### `configs/trace.config`

Ensures complete DWARF debug metadata (required by `perf probe -V`/`-D` in Phase 2) and guest Tracefs Kprobe event support:

```ini
CONFIG_DEBUG_KERNEL=y
CONFIG_DEBUG_INFO=y
CONFIG_DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT=y
# CONFIG_DEBUG_INFO_REDUCED is not set
CONFIG_FRAME_POINTER=y
CONFIG_KALLSYMS=y
CONFIG_KALLSYMS_ALL=y
CONFIG_KPROBES=y
CONFIG_KPROBE_EVENTS=y
CONFIG_FTRACE=y
CONFIG_TRACING=y
CONFIG_DYNAMIC_FTRACE=y

```

> **Design Note (`CONFIG_DEBUG_INFO_REDUCED`):** Explicitly disabling `CONFIG_DEBUG_INFO_REDUCED` guarantees that full local variable type and location metadata is emitted into `vmlinux`, preventing `perf probe -V` from failing to resolve struct members or local variables in Phase 2.

---

### 4.3 Configuration & `#ifdef` Synchronization (`scripts/configure.sh` & `.clangd`)

#### Execution Flow

1. Create `${BUILD_DIR}` and `${SHARED_DIR}`.
2. Generate base configuration:
```bash
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" "${BASE_CONFIG}"

```


3. Merge layered fragments from inside `${KERNEL_DIR}` (ensuring `merge_config.sh` resolves internal kernel paths reliably across kernel versions):
```bash
(
  cd "${KERNEL_DIR}"
  ./scripts/kconfig/merge_config.sh -m -O "${BUILD_DIR}" \
    "${BUILD_DIR}/.config" \
    "${WS_ROOT}/configs/qemu.config" \
    "${WS_ROOT}/configs/trace.config" \
    "${USER_CONFIGS[@]}"
)

```


*Any `Value requested for CONFIG_* not in final .config` warnings printed by `merge_config.sh` are preserved on stdout/stderr for immediate visibility.*
4. Resolve defaults and regenerate `include/generated/autoconf.h` without compiling the kernel:
```bash
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" olddefconfig
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" syncconfig

```


5. Materialize `${WS_ROOT}/.clangd` from `scripts/clangd.template`, substituting workspace/kernel/build absolute paths.

#### `.clangd` Template (`scripts/clangd.template`)

`compile_commands.json` only contains translation units actually compiled under the current `.config`. When a developer opens an **unbuilt** `.c` file (or before running the first build), `clangd` falls back to `.clangd` and resolves relative paths in `Add:` relative to the opened source file's directory. Therefore, all include paths and `autoconf.h` **must be absolute paths** generated from this template:

```yaml
If:
  PathMatch: ^linux/.*

CompileFlags:
  CompilationDatabase: @BUILD_DIR@
  Add:
    - -D__KERNEL__
    - -include
    - @BUILD_DIR@/include/generated/autoconf.h
    - -I@KERNEL_DIR@/include
    - -I@KERNEL_DIR@/arch/x86/include
    - -I@KERNEL_DIR@/include/uapi
    - -I@KERNEL_DIR@/arch/x86/include/uapi
    - -I@BUILD_DIR@/include
    - -I@BUILD_DIR@/include/generated/uapi
    - -I@BUILD_DIR@/arch/x86/include/generated
    - -I@BUILD_DIR@/arch/x86/include/generated/uapi
  Remove:
    - -mabi=*
    - -fconserve-stack
    - -fno-allow-store-data-races
    - -mpreferred-stack-boundary=*
    - -mindirect-branch=*
    - -mfunction-return=*
    - -mrecord-mcount
    - -fmin-function-alignment=*
    - -mharden-sls=*

```

#### Inactive Region (`#ifdef`) Behavior

* Before running `configure.sh` (or when configured with `BASE_CONFIG=allnoconfig`), `autoconf.h` defines no feature macros, causing `#ifdef CONFIG_*` blocks to render dimmed (hatched out) across the editor.
* Running `configure.sh` updates `autoconf.h` in under one second; executing **`clangd: Restart language server`** immediately re-evaluates `#ifdef` blocks to highlight only the enabled configuration branches.

---

### 4.4 Out-of-Tree Kernel & Module Build (`scripts/build_kernel.sh`)

1. Verify `${BUILD_DIR}/.config` exists; fail with a clear hint to run `configure.sh` if missing.
2. Execute out-of-tree parallel build:
```bash
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" -j"$(nproc)" bzImage modules

```


*(Optional `LLVM=1` or extra `MAKE_ARGS` are passed through if set in the environment.)*
3. Generate the compilation database for accurate `clangd` cross-references and macro evaluation:
```bash
python3 "${KERNEL_DIR}/scripts/clang-tools/gen_compile_commands.py" \
  -d "${BUILD_DIR}" \
  -o "${BUILD_DIR}/compile_commands.json"

```



---

### 4.5 Minimal Static BusyBox `initramfs` Builder (`scripts/build_initramfs.sh`)

Building an `initramfs.cpio.gz` archive requires no `sudo` privileges, no loopback disk mounts, and rebuilds in 1–2 seconds.

#### Build Steps

1. **Static Binary Validation:** Verify `${BUSYBOX_BIN}` is statically linked (e.g., `ldd "${BUSYBOX_BIN}"` reports `"not a dynamic executable"` or `"statically linked"`). Abort immediately if dynamically linked.
2. **Staging RootFS:** Create an ephemeral temporary directory (`mktemp -d` with `trap 'rm -rf ...' EXIT`) containing `/bin`, `/sbin`, `/etc`, `/proc`, `/sys`, `/dev`, `/tmp`, `/usr/bin`, `/usr/sbin`, `/mnt/host`, `/lib/modules`.
3. **Install BusyBox & Modules:**
* Copy `${BUSYBOX_BIN}` to `rootfs/bin/busybox` (`chmod +x`).
* If `${BUILD_DIR}/modules.order` exists, install compiled modules via:
```bash
make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" \
  INSTALL_MOD_PATH="${ROOTFS_DIR}" modules_install

```




4. **Generate `/init`:** Write the deterministic boot script (see lifecycle below) and set executable permissions.
5. **Pack Archive:** Create `${BUILD_DIR}/initramfs.cpio.gz` using `find . -print0 | cpio --null -ov --format=newc | gzip -1` (level 1 prioritizes build-boot turnaround speed).

#### Guest `/init` Execution Lifecycle

```text
[Boot bzImage + initramfs.cpio.gz]
         │
         ▼
1. /bin/busybox --install -s
2. Mount /proc, /sys, /dev (devtmpfs), /sys/kernel/tracing (tracefs)
3. Mount 9p VirtIO hostshare -> /mnt/host
4. If /mnt/host/setup_kprobes.sh is executable:
      └── Run /mnt/host/setup_kprobes.sh  (Registers & enables Tracefs Kprobes)
5. Execution branch:
      ├── If /mnt/host/run_target.sh is executable (Batch / Selftest Mode):
      │     ├── Run /mnt/host/run_target.sh
      │     └── Save return code to /mnt/host/exit_code
      └── Else (Interactive Mode):
            └── Spawn interactive shell: setsid cttyhack /bin/sh
6. Teardown & Trace Collection (always runs after step 5 exits):
      ├── echo 0 > /sys/kernel/tracing/tracing_on
      ├── cp /sys/kernel/tracing/trace /mnt/host/trace.log
      ├── sync
      └── poweroff -f

```

---

### 4.6 QEMU Runtime Launcher (`scripts/run_qemu.sh`)

* **Pre-flight checks:** Ensure `${BUILD_DIR}/arch/x86/boot/bzImage` and `${BUILD_DIR}/initramfs.cpio.gz` exist, and `${SHARED_DIR}` is created.
* **KVM Auto-Detection:** Enable `-enable-kvm -cpu host` automatically when `/dev/kvm` is readable and writable; otherwise fall back to software emulation without failing.
* **Kernel Command Line:** `console=ttyS0 nokaslr quiet loglevel=4`
* `console=ttyS0`: Routes kernel logs and BusyBox shell directly to the VSCode integrated terminal.
* `nokaslr`: Disables kernel address space randomization to simplify address correlation and optional GDB attachment.


* **Launch Command:**
```bash
exec "${QEMU_BIN}" \
  ${KVM_FLAGS} \
  -m "${QEMU_MEM}" -smp "${QEMU_SMP}" \
  -kernel "${BUILD_DIR}/arch/x86/boot/bzImage" \
  -initrd "${BUILD_DIR}/initramfs.cpio.gz" \
  -append "console=ttyS0 nokaslr quiet loglevel=4" \
  -virtfs "local,path=${SHARED_DIR},mount_tag=hostshare,security_model=none,id=hostshare" \
  -nographic -no-reboot \
  ${QEMU_EXTRA_ARGS:-}

```



---

### 4.7 VSCode Workspace Configuration (`.vscode/`)

#### `.vscode/extensions.json`

```json
{
  "recommendations": [
    "llvm-vs-code-extensions.vscode-clangd",
    "luveti.kconfig"
  ]
}

```

#### `.vscode/settings.json`

* Disables `C_Cpp.intelliSenseEngine` to prevent conflicts with `clangd`.
* Configures `clangd` to read `${workspaceFolder}/build/current` with background indexing enabled.
* Styles inactive `#ifdef` regions with background tinting and reduced opacity.
* Excludes build artifacts from text search while **explicitly avoiding excluding `build/current/shared/` from `files.watcherExclude**` so Phase 2's `FileSystemWatcher` can detect `trace.log` updates automatically.

```json
{
  "C_Cpp.intelliSenseEngine": "disabled",
  "clangd.arguments": [
    "--compile-commands-dir=${workspaceFolder}/build/current",
    "--background-index",
    "--header-insertion=never",
    "--query-driver=/usr/bin/gcc*,/usr/bin/clang*"
  ],
  "clangd.inactiveRegions.useBackgroundHighlight": true,
  "workbench.colorCustomizations": {
    "clangd.inactiveRegions.background": "#3a2a2a55",
    "clangd.inactiveRegions.opacity": 0.55
  },
  "search.exclude": {
    "build/**": true
  },
  "files.watcherExclude": {
    "build/**/*.o": true,
    "build/**/*.o.d": true,
    "build/**/*.cmd": true,
    "build/**/*.a": true
  }
}

```

#### `.vscode/tasks.json`

Provides one-click access to all Phase 1 workflows:

| Task Label | Command Invoked | Purpose |
| --- | --- | --- |
| `kdev: Configure & Sync (#ifdef)` | `scripts/configure.sh ${input:userConfig}` | Merges config layers, runs `syncconfig`, updates `.clangd`. |
| `kdev: Build Kernel & Modules` *(default build)* | `scripts/build_kernel.sh` | Builds `bzImage` + modules + `compile_commands.json` (`$gcc` matcher). |
| `kdev: Build BusyBox initramfs` | `scripts/build_initramfs.sh` | Packages static BusyBox + modules + `/init`. |
| `kdev: Run QEMU` | `scripts/run_qemu.sh` | Launches QEMU with 9p hostshare in the integrated terminal. |
| `kdev: Build All & Boot QEMU` | Compound (`dependsOrder: sequence`) | Runs Build Kernel -> Build initramfs -> Run QEMU sequentially. |

---

## 5. Interface Contract for Phase 2 & Phase 3

Phase 1 fixes the following boundary in `${BUILD_DIR}/shared/` so Phase 2 (VSCode Extension) and Phase 3 (Kconfig Solver & Plotter) can be layered cleanly without rewriting Phase 1 scripts:

| Artifact Path | Producer | Consumer | Contract |
| --- | --- | --- | --- |
| `shared/setup_kprobes.sh` | Phase 2 Extension (`perf probe -D`) | Phase 1 Guest `/init` | POSIX `/bin/sh` executable script that writes Tracefs `kprobe_events` and enables `tracing_on`. |
| `shared/probes.json` | Phase 2 Extension | Phase 2 Extension | JSON array mapping `eventName` to `{ file, line, vars, definitions }`. Paths are relative to `KERNEL_DIR`. |
| `shared/run_target.sh` | Phase 2 Selftest Runner / User | Phase 1 Guest `/init` | Optional POSIX `/bin/sh` executable script. When present, guest runs non-interactively and powers off on completion. |
| `shared/exit_code` | Phase 1 Guest `/init` | Phase 2 Selftest Runner | Single integer line recording the exit status of `run_target.sh`. |
| `shared/trace.log` | Phase 1 Guest `/init` | Phase 2 Extension (`FileSystemWatcher`) | Raw copy of `/sys/kernel/tracing/trace` flushed and synced before guest poweroff. |

---

## 6. Verification & Acceptance Criteria

Phase 1 is considered complete and ready for Phase 2 when all 5 checks pass:

1. **Git Cleanliness Check**
* Run `git -C linux status --ignored`. Output must show zero untracked workspace files (`.clangd`, `.vscode`, `build/`, or helper scripts).


2. **Layered Config & Immediate `#ifdef` Dimming**
* Run `kdev: Configure & Sync (#ifdef)` with a test `configs/user.config` enabling a non-default feature (e.g., `CONFIG_SAMPLE_KPROBES=m` or a specific driver flag).
* Execute `clangd: Restart language server`.
* Confirm that `#ifdef CONFIG_*` blocks in both built and unbuilt files under `linux/` visually toggle between dimmed (inactive) and bright (active).


3. **Out-of-Tree Build & Debug Symbols**
* Run `kdev: Build Kernel & Modules`.
* Confirm `build/current/arch/x86/boot/bzImage`, `build/current/vmlinux`, and `build/current/compile_commands.json` exist.
* Verify DWARF debug info is present in `vmlinux`: `readelf -S build/current/vmlinux | grep debug_info`.


4. **Rootless `initramfs` & QEMU Interactive Boot**
* Run `kdev: Build BusyBox initramfs` followed by `kdev: Run QEMU`.
* Confirm the guest boots to a BusyBox shell, `/mnt/host` is mounted via 9p, and `/sys/kernel/tracing/kprobe_events` exists.
* Exit the shell (`exit`); confirm QEMU cleanly powers off and `build/current/shared/trace.log` appears on the host.


5. **Phase 2 Hook Smoke Test (Batch + Tracefs)**
* Place a minimal executable `build/current/shared/setup_kprobes.sh` registering a single kprobe (e.g., `p:probe/test_open do_sys_openat2`) and an executable `build/current/shared/run_target.sh` running `ls /`.
* Run `kdev: Run QEMU` and confirm the guest automatically executes `run_target.sh`, powers off without user input, writes `0` to `shared/exit_code`, and captures `test_open` events inside `shared/trace.log`.
