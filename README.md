# Linux Kernel VSCode Development Foundation

A clean, reproducible **Parent Workspace** environment for Linux kernel development in VSCode. It keeps your upstream `linux/` repository 100% untouched while providing layered Kconfig management, sub-second `#ifdef CONFIG_*` dimming via `clangd` + `syncconfig`, out-of-tree kernel/module builds, a rootless static-BusyBox `initramfs` builder, and 9p-enabled QEMU execution with hooks for automated Kprobes and kselftest runs.

For architectural details and Phase 2/3 interface contracts, see [DESIGN.md](./DESIGN.md).

---

## 1. Host Prerequisites

Target host: `x86_64` Linux.

| Category | Required Tools / Packages | Notes |
| --- | --- | --- |
| **Kernel Build** | `gcc` (or `clang`), `make`, `bc`, `bison`, `flex`, `libelf-dev`, `libssl-dev`, `python3`, `cpio`, `gzip` | Standard kernel build dependencies + `gen_compile_commands.py` runtime. |
| **IDE & LSP** | VSCode, `clangd` (v16+ recommended), extension `llvm-vs-code-extensions.vscode-clangd` | Optional: `luveti.kconfig`. Microsoft `C_Cpp` IntelliSense is disabled in workspace settings. |
| **Guest RootFS** | Statically linked `busybox` (`busybox-static`) | Verified via `ldd` by `setup.sh` and `scripts/build_initramfs.sh`. |
| **Emulation** | `qemu-system-x86_64` (`qemu-system-x86`) | `/dev/kvm` access recommended for hardware acceleration; falls back to TCG automatically. |

On Debian/Ubuntu, you can install all host dependencies with:

```bash
./setup.sh --install-deps
```

or manually:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential bc bison flex libelf-dev libssl-dev \
  python3 cpio gzip clangd busybox-static qemu-system-x86
```

---

## 2. Quick Start Setup

### Step 1: Run `setup.sh` and Provision `linux/`

You can link an existing local kernel clone, add a `git worktree`, or clone a fresh tree into `./linux`:

```bash
# Option A: Symlink an existing local Linux kernel repository and configure
./setup.sh --kernel-src /path/to/your/linux --configure

# Option B: Create an isolated git worktree at ./linux from an existing local repo
./setup.sh --kernel-src /path/to/your/linux --worktree v6.12 --configure

# Option C: Shallow-clone mainline Linux and configure
./setup.sh --kernel-src https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git --depth 1 --configure
```

If you only want to verify host prerequisites and initialize the directory layout (`build/current/shared/` and initial `.clangd`):

```bash
./setup.sh
```

### Step 2: Open the Parent Workspace in VSCode

Open **this parent directory** (not `linux/` directly) in VSCode:

```bash
code .
```

When prompted, install the recommended workspace extensions (`llvm-vs-code-extensions.vscode-clangd` and `luveti.kconfig`).

---

## 3. Kconfig Editor Backend & VSCode Extension Installation

First, build both the Python Kconfig SAT solver backend (`backend/.venv`) and the VSCode extension frontend (`extension/dist`):

```bash
./setup.sh --setup-backend --setup-frontend
```

Then install or launch the VSCode extension (`extension/`) using one of the following methods:

### Method A: Symlink into Your Local Extensions Folder (Recommended for Development)

Requires no `.vsix` packaging; after running `npm run build` in `extension/`, simply reload the window.

```bash
# For standard VSCode:
mkdir -p "$HOME/.vscode/extensions"
ln -sfn "$PWD/extension" "$HOME/.vscode/extensions/kdev.linux-kernel-dev-0.1.0"

# For Antigravity IDE:
mkdir -p "$HOME/.antigravity/extensions"
ln -sfn "$PWD/extension" "$HOME/.antigravity/extensions/kdev.linux-kernel-dev-0.1.0"
```

After creating the symlink, open the Command Palette (`Ctrl+Shift+P`) and run **`Developer: Reload Window`**.

### Method B: Package and Install as a `.vsix` File

```bash
(
  cd extension
  npm run build
  npx --yes @vscode/vsce package --allow-missing-repository
)
code --install-extension "$PWD/extension/linux-kernel-dev-0.1.0.vsix"
```

Alternatively, in the editor UI: open **Extensions** (`Ctrl+Shift+X`) → click the **`...`** menu at the top-right → select **Install from VSIX...** → choose `extension/linux-kernel-dev-0.1.0.vsix`.

### Method C: Launch in an Extension Development Host Window

To test without installing into `$HOME`:

```bash
code --extensionDevelopmentPath="$PWD/extension" "$PWD"
```

### Opening the Kconfig Editor

Once installed, open the Command Palette (`Ctrl+Shift+P`) and run:
* **`Kernel Dev: Open Kconfig Editor`** (`kdev.openKconfigEditor`)
* **`Kernel Dev: Restart Kconfig Backend`** (`kdev.restartKconfigBackend`)

---

## 4. Directory Layout

```text
.                                   # VSCode Workspace Root
├── DESIGN.md                       # Phase 1 Architecture & Design Specification
├── README.md                       # Setup & usage guide
├── setup.sh                        # Prerequisite checker & workspace bootstrap script
├── .gitignore                      # Ignores linux/, build/, generated .clangd, user.config
├── .clangd                         # Generated from scripts/clangd.template (scoped to linux/)
├── .vscode/
│   ├── extensions.json             # Recommended workspace extensions
│   ├── settings.json               # clangd config, inactive #ifdef styling, watcher tuning
│   └── tasks.json                  # One-click VSCode tasks wrapping scripts/*.sh
├── configs/                        # Layered Kconfig fragments
│   ├── qemu.config                 # VirtIO, 9pfs, serial console, initrd, modules
│   ├── trace.config                # Full DWARF, Kprobes, Kprobe events, Ftrace/Tracefs
│   └── user.config.example         # Template for user-injected config fragments
├── scripts/                        # Standalone, CLI-runnable automation scripts
│   ├── env.sh                      # Shared path & default environment variables
│   ├── clangd.template             # Template for generating workspace-root .clangd
│   ├── configure.sh                # merge_config.sh + olddefconfig + syncconfig + .clangd gen
│   ├── build_kernel.sh             # Out-of-tree bzImage + modules + compile_commands.json
│   ├── build_initramfs.sh          # Rootless static BusyBox + modules + /init cpio.gz builder
│   └── run_qemu.sh                 # QEMU launcher with 9p hostshare & KVM auto-detection
├── build/
│   └── current/                    # Active out-of-tree build directory (O=)
│       ├── layers.json             # Per-profile declarative Kconfig layer manifest
│       ├── solver_overlay.config   # Auto-generated Kconfig solver diff overlay
│       ├── user_injected/          # Symlinked user/selftest Kconfig fragments
│       └── shared/                 # 9p VirtIO shared directory (Host <-> Guest /mnt/host)
└── linux/                          # Upstream Linux kernel Git repository (untouched)
```

---

## 5. Workflows (VSCode Tasks & CLI)

Every workflow can be triggered from the VSCode Command Palette (**`Tasks: Run Task`**) or directly from a terminal.

### 5.1 Configure & Sync `#ifdef` Regions

Merges `BASE_CONFIG` (`defconfig`) + `configs/qemu.config` + `configs/trace.config` + optional user config fragments, runs `olddefconfig` and `syncconfig` to generate `include/generated/autoconf.h` in `<1s`, and updates `.clangd`:

```bash
# Default layers (+ configs/user.config if present)
./scripts/configure.sh

# Or pass one or more custom fragment files explicitly
./scripts/configure.sh configs/user.config
```

* **VSCode Task:** `kdev: Configure & Sync (#ifdef)`
* After running, execute **`clangd: Restart language server`** in VSCode to immediately refresh active/dimmed `#ifdef CONFIG_*` blocks across both built and unbuilt kernel source files.

### 5.2 Build Kernel, Modules & `compile_commands.json`

Builds `bzImage`, loadable modules, full-DWARF `vmlinux`, and generates `build/current/compile_commands.json`:

```bash
./scripts/build_kernel.sh
```

* **VSCode Task:** `kdev: Build Kernel & Modules` (Default Build Task: `Ctrl+Shift+B`)

### 5.3 Build Minimal Static BusyBox `initramfs`

Packages the static `busybox` binary, compiled kernel modules, and `/init` lifecycle script into `build/current/initramfs.cpio.gz` without root privileges:

```bash
./scripts/build_initramfs.sh
```

* **VSCode Task:** `kdev: Build BusyBox initramfs`

### 5.4 Boot in QEMU

Boots `bzImage` and `initramfs.cpio.gz` in QEMU with serial console attached to the terminal and `build/current/shared/` mounted at `/mnt/host` via VirtIO 9p:

```bash
./scripts/run_qemu.sh
```

* **VSCode Task:** `kdev: Run QEMU` (or `kdev: Build All & Boot QEMU` to build kernel, initramfs, and boot sequentially)
* **Interactive Mode:** If `build/current/shared/run_target.sh` is not present (or not executable), the guest drops into an interactive BusyBox shell. Type `exit` to flush `/sys/kernel/tracing/trace` to `build/current/shared/trace.log` and power off cleanly.
* **Batch / Automated Hook Mode:**
  * If `build/current/shared/setup_kprobes.sh` is executable (`chmod +x`), `/init` executes it automatically before running the target workload.
  * If `build/current/shared/run_target.sh` is executable (`chmod +x`), `/init` runs it non-interactively, records its exit status to `build/current/shared/exit_code`, dumps `trace.log`, and powers off automatically.

---

## 6. Environment Customization

All scripts source [`scripts/env.sh`](./scripts/env.sh) and respect environment variable overrides:

| Variable | Default | Description |
| --- | --- | --- |
| `KERNEL_DIR` | `${WS_ROOT}/linux` | Path to the Linux kernel source tree. |
| `PROFILE` | `current` | Build profile subdirectory under `build/`. |
| `BUILD_DIR` | `${WS_ROOT}/build/${PROFILE}` | Out-of-tree build directory (`O=`). |
| `SHARED_DIR` | `${BUILD_DIR}/shared` | Host directory shared with guest at `/mnt/host`. |
| `ARCH` | `x86_64` | Target architecture. |
| `BASE_CONFIG` | `defconfig` | Base Kconfig target (`defconfig`, `allnoconfig`, etc.). |
| `BUSYBOX_BIN` | `$(command -v busybox)` | Path to statically linked BusyBox binary. |
| `QEMU_BIN` | `qemu-system-x86_64` | QEMU system binary. |
| `QEMU_MEM` | `2G` | Guest RAM allocation. |
| `QEMU_SMP` | `2` | Guest vCPU count. |
| `LLVM` / `MAKE_ARGS` | *(unset)* | Optional flags forwarded to `make` (e.g. `LLVM=1`). |
