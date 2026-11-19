---
name: kdev-build-and-boot
description: >-
  Configure, build, package initramfs, and boot the Linux kernel in QEMU using
  the workspace's out-of-tree automation scripts (setup.sh, scripts/configure.sh,
  scripts/build_kernel.sh, scripts/build_initramfs.sh, scripts/run_qemu.sh).
  Use this skill whenever asked to configure Kconfig fragments, compile the kernel
  or modules, generate the BusyBox initrd/initramfs image, run workloads or
  Kprobe/Tracefs tests in QEMU, or verify kernel changes in this workspace.
---

# Linux Kernel Build, Initramfs & QEMU Boot Workflow (`kdev-build-and-boot`)

This skill defines the standard operating procedures for configuring, building, packaging an `initramfs` image, and booting the Linux kernel under QEMU in the Parent Workspace (`ikedev`).

## Core Rules

1. **Never Pollute `linux/`**: Always execute builds out-of-tree via the workspace scripts in [`scripts/`](../../../scripts/). Never create `.config`, build artifacts, or temporary files directly inside `linux/`.
2. **Use Shared Environment Contract**: All scripts source [`scripts/env.sh`](../../../scripts/env.sh), which defaults to:
   - `KERNEL_DIR`: `${WS_ROOT}/linux`
   - `BUILD_DIR`: `${WS_ROOT}/build/${PROFILE:-current}`
   - `SHARED_DIR`: `${BUILD_DIR}/shared` (mounted in guest at `/mnt/host` via 9p VirtIO)
3. **Prefer Batch Hook Mode for Automated Agent Runs in QEMU**: When launching QEMU from an automated agent tool call (`run_command`), always create an executable `${SHARED_DIR}/run_target.sh` script first so the guest runs the target commands, records `${SHARED_DIR}/exit_code`, collects `${SHARED_DIR}/trace.log`, and powers off automatically instead of waiting indefinitely at an interactive shell prompt.

---

## Step-by-Step Procedures

### 1. Pre-Flight & Environment Check

Before running builds on a fresh setup, verify host prerequisites (`gcc`/`clang`, `clangd`, static `busybox`, `qemu-system-x86_64`, `/dev/kvm`) and workspace directories using [`setup.sh`](../../../setup.sh):

```bash
./setup.sh --check-only
```

* If `busybox` is missing or dynamically linked, or other build packages are missing on Debian/Ubuntu, install them with `./setup.sh --install-deps`.
* If `linux/` is not yet populated, link or worktree a local repository or clone upstream:
  ```bash
  ./setup.sh --kernel-src /path/to/linux --configure
  ```

---

### 2. Configure Kernel & Sync `#ifdef` (`scripts/configure.sh`)

Run [`scripts/configure.sh`](../../../scripts/configure.sh) to compose `${BUILD_DIR}/.config` from `BASE_CONFIG` (`defconfig`), [`configs/qemu.config`](../../../configs/qemu.config), [`configs/trace.config`](../../../configs/trace.config), and optional user config fragments:

```bash
# Standard configuration (automatically includes configs/user.config if present)
./scripts/configure.sh

# Or pass one or more custom Kconfig fragment files explicitly
./scripts/configure.sh configs/user.config
```

**What this does:**
1. Generates the base config (`defconfig` by default, override via `BASE_CONFIG=allnoconfig`, etc.).
2. Merges `configs/qemu.config` (VirtIO, 9pfs, serial console, initrd, modules), `configs/trace.config` (full DWARF, Kprobes, Ftrace/Tracefs), and user fragments via `merge_config.sh`.
3. Runs `olddefconfig` and `syncconfig` to materialize `${BUILD_DIR}/include/generated/autoconf.h` in `<1s`.
4. Generates [`${WS_ROOT}/.clangd`](../../../.clangd) from [`scripts/clangd.template`](../../../scripts/clangd.template).

**Verification:**
* Check that `build/current/.config`, `build/current/include/generated/autoconf.h`, and `.clangd` exist.
* Inspect `configure.sh` output for any `Value requested for CONFIG_* not in final .config` warnings.

---

### 3. Build Kernel, Modules & `compile_commands.json` (`scripts/build_kernel.sh`)

Run [`scripts/build_kernel.sh`](../../../scripts/build_kernel.sh) to compile `bzImage`, loadable kernel modules, DWARF-enabled `vmlinux`, and `compile_commands.json`:

```bash
./scripts/build_kernel.sh
```

* To build with Clang/LLVM or pass extra make arguments:
  ```bash
  LLVM=1 MAKE_ARGS="KCFLAGS=-Wno-error" ./scripts/build_kernel.sh
  ```

**Verification:**
* Confirm `build/current/arch/x86/boot/bzImage` exists.
* Confirm `build/current/vmlinux` contains DWARF debug sections:
  ```bash
  readelf -S build/current/vmlinux | grep debug_info
  ```
* Confirm `build/current/compile_commands.json` was generated.

---

### 4. Generate BusyBox `initramfs` (`scripts/build_initramfs.sh`)

Run [`scripts/build_initramfs.sh`](../../../scripts/build_initramfs.sh) to package a minimal rootless `initramfs.cpio.gz` containing the static `busybox` binary, installed kernel modules (`lib/modules/...`), and the deterministic `/init` script:

```bash
./scripts/build_initramfs.sh
```

**Verification:**
* Confirm `build/current/initramfs.cpio.gz` exists and is non-empty.
* Re-run `scripts/build_initramfs.sh` whenever kernel modules are rebuilt so `/lib/modules` inside the initramfs stays in sync with `bzImage`.

---

### 5. Launch System Using QEMU (`scripts/run_qemu.sh`)

[`scripts/run_qemu.sh`](../../../scripts/run_qemu.sh) boots `${BUILD_DIR}/arch/x86/boot/bzImage` with `${BUILD_DIR}/initramfs.cpio.gz`, auto-detects `/dev/kvm`, attaches serial console (`console=ttyS0 nokaslr quiet loglevel=4`), and exports `${BUILD_DIR}/shared` to the guest at `/mnt/host` via VirtIO 9p (`hostshare`).

#### Mode A: Automated Batch / Test Execution (Recommended for Agent Tasks)

When verifying kernel behavior, running a reproducer/kselftest, or testing Kprobes/Tracefs non-interactively:

1. **(Optional) Configure Kprobes Hook (`build/current/shared/setup_kprobes.sh`)**:
   ```bash
   cat << 'EOF' > build/current/shared/setup_kprobes.sh
   #!/bin/sh
   set -e
   echo 'p:probe/test_open do_sys_openat2' > /sys/kernel/tracing/kprobe_events
   echo 1 > /sys/kernel/tracing/events/probe/test_open/enable
   echo 1 > /sys/kernel/tracing/tracing_on
   EOF
   chmod +x build/current/shared/setup_kprobes.sh
   ```

2. **Create Workload / Test Hook (`build/current/shared/run_target.sh`)**:
   ```bash
   cat << 'EOF' > build/current/shared/run_target.sh
   #!/bin/sh
   uname -a
   ls / >/dev/null
   EOF
   chmod +x build/current/shared/run_target.sh
   ```

3. **Run QEMU**:
   ```bash
   rm -f build/current/shared/exit_code build/current/shared/trace.log
   ./scripts/run_qemu.sh
   ```

4. **Verify Results on Host**:
   * Check workload exit status: `cat build/current/shared/exit_code` (expected `0`).
   * Inspect collected Ftrace/Kprobe buffer: `cat build/current/shared/trace.log`.

#### Mode B: Interactive Shell Session

For interactive debugging in a terminal:

1. Ensure `build/current/shared/run_target.sh` is either removed or non-executable:
   ```bash
   rm -f build/current/shared/run_target.sh
   ```
2. Launch QEMU:
   ```bash
   ./scripts/run_qemu.sh
   ```
3. Inside the guest BusyBox shell, `/mnt/host` is mounted over 9p and `/sys/kernel/tracing` is mounted over tracefs.
4. Type `exit` in the guest shell to trigger `/init` teardown, which stops tracing, copies `/sys/kernel/tracing/trace` to `/mnt/host/trace.log`, syncs, and powers off QEMU cleanly.

---

## Environment Overrides Quick Reference

You can override any variable from [`scripts/env.sh`](../../../scripts/env.sh) inline when invoking the scripts:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROFILE` | `current` | Switch out-of-tree build profile directory (`build/${PROFILE}`). |
| `KERNEL_DIR` | `${WS_ROOT}/linux` | Target an alternate kernel worktree (e.g. `KERNEL_DIR=$PWD/linux-next`). |
| `BASE_CONFIG` | `defconfig` | Change base Kconfig target (`defconfig`, `allnoconfig`, `tinyconfig`). |
| `BUSYBOX_BIN` | `$(command -v busybox)` | Point to a specific statically linked BusyBox binary. |
| `QEMU_MEM` / `QEMU_SMP` | `2G` / `2` | Adjust guest RAM and vCPU count. |
| `QEMU_EXTRA_ARGS` | *(empty)* | Pass extra flags to QEMU (e.g. `QEMU_EXTRA_ARGS="-s -S"` for GDB stub on `:1234`). |
