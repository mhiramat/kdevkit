# Linux Kernel VSCode Development Foundation

A clean, reproducible **Parent Workspace** environment for Linux kernel development in VSCode. It keeps your upstream `linux/` repository 100% untouched while providing layered Kconfig management, sub-second `#ifdef CONFIG_*` dimming via `clangd` + `syncconfig`, out-of-tree kernel/module builds, a rootless static-BusyBox `initramfs` builder, and 9p-enabled QEMU execution with hooks for automated Kprobes and kselftest runs.

For architectural details and Phase 2/3 interface contracts, see [docs/DESIGN_PHASE1.md](./docs/DESIGN_PHASE1.md), [docs/DESIGN_KCONFIG_BACKEND.md](./docs/DESIGN_KCONFIG_BACKEND.md), [docs/DESIGN_KCONFIG_FRONTEND.md](./docs/DESIGN_KCONFIG_FRONTEND.md), [docs/DESIGN_PHASE2_KPROBES.md](./docs/DESIGN_PHASE2_KPROBES.md), [docs/DESIGN_PHASE3_SELFTEST.md](./docs/DESIGN_PHASE3_SELFTEST.md), and [docs/DESIGN_PHASE3_TRACE_PLOT.md](./docs/DESIGN_PHASE3_TRACE_PLOT.md).

---

## 1. Host Prerequisites

Target host: `x86_64` Linux.

| Category | Required Tools / Packages | Notes |
| --- | --- | --- |
| **Kernel Build** | `gcc` (or `clang`), `make`, `bc`, `bison`, `flex`, `libelf-dev`, `libssl-dev`, `python3`, `cpio`, `gzip` | Standard kernel build dependencies + `gen_compile_commands.py` runtime. |
| **IDE & LSP** | VSCode, `clangd` (v16+ recommended), extension `llvm-vs-code-extensions.vscode-clangd` | Optional: `luveti.kconfig`. Microsoft `C_Cpp` IntelliSense is disabled in workspace settings. |
| **Guest RootFS** | Statically linked `busybox` (`busybox-static`) | Verified via `ldd` by `setup.sh` and `scripts/build_initramfs.sh`. |
| **Emulation** | `qemu-system-x86_64` (`qemu-system-x86`) | `/dev/kvm` access recommended for hardware acceleration; falls back to TCG automatically. |
| **Patch Review (Optional)** | `git` (always), Rust 1.90+ via `rustup` (for Sashiko CLI binary), LLM API key or local agent CLI (`claude`, `copilot`, `codex`, etc.) | Required only when using `./setup.sh --with-sashiko` in CLI mode. Subagent prompt-based review works with `git` alone (`--sashiko-no-build`). |

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

To also shallow-clone and set up [Sashiko](https://github.com/sashiko-dev/sashiko) for agent-assisted Linux kernel patch review:

```bash
# Default: shallow-clone Sashiko (and build binary if Rust 1.90+ is available);
# subagent prompt-based review is used by default until an API/provider is configured
./setup.sh --with-sashiko

# Or explicitly configure a Sashiko CLI provider (auto, gemini, gemini-proxy, claude-cli, copilot-cli, codex-cli, ...)
./setup.sh --with-sashiko --sashiko-provider auto

# Fast prompts-only setup (skip Rust build; subagent prompt-based review only)
./setup.sh --with-sashiko --sashiko-no-build
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

Run the dedicated installer script to create (or overwrite) the extension symlink in your local VSCode / Antigravity extensions directory. If you ever rename or move this workspace directory, simply re-run this script to update the symlink target:

```bash
./scripts/install_extension.sh
```

After running the script, open the Command Palette (`Ctrl+Shift+P`) and run **`Developer: Reload Window`**.

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
├── docs/                           # Architecture & design specifications
│   ├── DESIGN_PHASE1.md            # Phase 1 Architecture & Design Specification
│   ├── DESIGN_KCONFIG_BACKEND.md   # Kconfig SAT solver backend specification
│   └── DESIGN_KCONFIG_FRONTEND.md  # Kconfig VSCode frontend specification
├── README.md                       # Setup & usage guide
├── setup.sh                        # Prerequisite checker & workspace bootstrap script
├── .gitignore                      # Ignores linux/, build/, generated .clangd, .vscode/settings.json, user.config
├── .clangd                         # Generated from scripts/clangd.template (scoped to linux/)
├── .vscode/
│   ├── extensions.json             # Recommended workspace extensions
│   ├── settings.json               # Generated from scripts/settings.json.template (gitignored, user-customizable)
│   └── tasks.json                  # One-click VSCode tasks wrapping scripts/*.sh
├── configs/                        # Layered Kconfig fragments
│   ├── qemu.config                 # VirtIO, 9pfs, serial console, initrd, modules
│   ├── trace.config                # Full DWARF, Kprobes, Kprobe events, Ftrace/Tracefs
│   └── user.config.example         # Template for user-injected config fragments
├── scripts/                        # Standalone, CLI-runnable automation scripts
│   ├── env.sh                      # Shared path & default environment variables
│   ├── clangd.template             # Template for generating workspace-root .clangd
│   ├── settings.json.template      # Template for generating .vscode/settings.json
│   ├── configure.sh                # merge_config.sh + olddefconfig + syncconfig + .clangd gen
│   ├── build_kernel.sh             # Out-of-tree bzImage + modules + compile_commands.json
│   ├── build_initramfs.sh          # Rootless static BusyBox + modules + /init cpio.gz builder
│   ├── build_selftest.sh           # Out-of-tree kselftest builder with auto-libs/static staging
│   ├── run_qemu.sh                 # QEMU launcher with 9p hostshare & KVM auto-detection
│   ├── setup_sashiko.sh            # Shallow-clones, builds, and configures Sashiko
│   ├── run_sashiko.sh              # Parent-workspace wrapper for 'sashiko review' on linux/
│   └── install_extension.sh        # Symlinks extension/ into local VSCode/Antigravity extensions dir
├── .agents/skills/                 # AI coding agent skills
│   ├── kdev-build-and-boot/        # Kernel configure, build, initramfs & QEMU workflow
│   ├── kdev-patch-series/          # Patch series preflight, UndineD staging & v2+ iteration
│   ├── kdev-patch-triage/          # UndineD TODO folder patch triage & $cl_1-$cl_3/$cl_5 tagging
│   ├── kdev-pull-request/          # Maintainer pull request draft generator
│   └── linux-sashiko-review/       # Sashiko-powered Linux patch series review skill
├── build/
│   └── current/                    # Active out-of-tree build directory (O=)
│       ├── layers.json             # Per-profile declarative Kconfig layer manifest
│       ├── solver_overlay.config   # Auto-generated Kconfig solver diff overlay
│       ├── user_injected/          # Symlinked user/selftest Kconfig fragments
│       └── shared/                 # 9p VirtIO shared directory (Host <-> Guest /mnt/host)
├── sashiko/                        # Optional shallow-cloned Sashiko repository (gitignored)
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

### 5.5 Running Linux Kernel Selftests (`kselftest`) in QEMU

`kdevkit` integrates `linux/tools/testing/selftests/` with VSCode's native **Testing** (Test Explorer) view, the Kconfig SAT solver, and QEMU execution while keeping `linux/` 100% clean.

#### In VSCode (Test Explorer UI)
1. **Select Selftest Targets:** Open the **Testing** view in the Activity Bar and click the **Select Selftest Targets...** (`$(checklist)`) icon in the view title bar — or run **`kdev: Select Selftest Targets...`** (`kdev.selftest.selectTargets`) from the Command Palette. Pick the subsystem directories you want to work on (e.g., `breakpoints`, `ftrace`); targets containing a `config` file are highlighted. The selection is saved to `kdev.selftest.targets`.
2. **Sync Missing Kconfig Requirements:** Targets whose `config` / `config.<arch>` requirements are missing from `build/current/.config` show a warning badge in Test Explorer. Click the wrench icon (**Inject & Solve Selftest Kconfig**) on the target item (or right-click → **`kdev: Inject & Solve Selftest Kconfig`**) to symlink the fragment into `build/current/user_injected/`, register it in `layers.json`, and open the Kconfig Editor with auto-resolved dependencies.
3. **Run Tests in QEMU:** Click the Run button on any target, test program, or individual `ftrace` `.tc` subtest using either Test Run Profile:
   * **`Run in QEMU`** *(default)*: Temporarily mutes `setup_kprobes.sh`, builds the selected selftest(s) if `kdev.selftest.autoBuildBeforeRun` is enabled, boots QEMU, streams live serial & **KTAP** pass/fail/skip results to Test Results, and removes `shared/run_target.sh` on exit.
   * **`Run in QEMU with Active Kprobes`**: Exports active Phase 2 Kprobes to `setup_kprobes.sh`, executes the selftest in QEMU, automatically reloads `build/current/shared/trace.log`, and optionally opens the **Trace Plotter** (`kdev.tracePlot.autoOpenOnSelftestTrace`).

#### From the CLI (`scripts/build_selftest.sh`)
You can also build and stage selftest targets directly from a terminal into `build/current/shared/kselftest/` (with build objects in `build/current/kselftest-obj/`):

```bash
# Default Option A (auto-libs): automatically stages required .so files and dynamic linker into shared/kselftest-libs/
./scripts/build_selftest.sh breakpoints ftrace

# Optional Option B (static): links C test binaries statically (falls back to auto-libs with a warning if a Makefile ignores LDFLAGS)
./scripts/build_selftest.sh --link-mode static breakpoints
```

Key VSCode settings under `kdev.selftest.*`: `targets`, `linkMode` (`"auto-libs"` | `"static"`), `targetOptions` (per-target overrides), `checkConfigBeforeRun` (`"prompt"` | `"off"`), `timeoutSec`, `bootTimeoutSec`, and `autoBuildBeforeRun`.

### 5.6 Patch Series Review with Sashiko (`linux-sashiko-review`)

`kdevkit` integrates [Sashiko](https://github.com/sashiko-dev/sashiko) for automated, agent-assisted review of Linux kernel patch series under `linux/` without modifying or polluting the kernel tree.

#### Setup

```bash
# Shallow-clone Sashiko into ./sashiko and build the lightweight local-review binary
# (requires Rust 1.90+ via rustup; gracefully skips build if Rust is absent)
./setup.sh --with-sashiko

# Update an existing shallow checkout to the latest upstream revision
./setup.sh --with-sashiko --sashiko-update

# Explicitly configure a Sashiko CLI LLM provider in .kdev/sashiko.toml
# Supported: auto, gemini, gemini-proxy, claude, claude-cli, copilot-cli, codex-cli, kiro-cli, goose, prompt-only
./setup.sh --with-sashiko --sashiko-provider auto

# Prompts-only setup without building Rust (subagent prompt-based review only)
./setup.sh --with-sashiko --sashiko-no-build
```

#### Two Review Modes (Agent Skill: `linux-sashiko-review`)

Ask your AI coding agent to review your current branch or commit range in `linux/` (invoking the [`.agents/skills/linux-sashiko-review/SKILL.md`](./.agents/skills/linux-sashiko-review/SKILL.md) skill). The active mode can be checked anytime with `./scripts/run_sashiko.sh --check`:

1. **Subagent Prompt-Based Mode *(default when no Sashiko API/provider is explicitly configured)*:**
   * Delegates review to a read-only subagent using Sashiko's three-layer Linux prompt guides under `sashiko/projects/linux/prompts/` (universal rules, matched `maintainers/*.md`, and `notes/`).
   * Requires no separate API key, keeps parent conversation context clean, and avoids unintended external API/CLI quota usage.
2. **Sashiko CLI Mode (`sashiko review --agent`) *(when an API key or `--sashiko-provider` is explicitly configured)*:**
   * Runs Sashiko's full Rust multi-stage pipeline (`goal`, `implementation`, `execution-flow`, `resources`, `locking`, `security`, `performance`, `hardware` → `verification` → parallel `post-verification`) and parses its structured JSON output.
   * Use `--cheap` during iterative development (or with subscription-based CLI providers like `claude-cli` / `copilot-cli` / `codex-cli`) to combine exploratory stages into one pass and reduce token usage by ~3–5×; run full mode before upstream submission.

#### Running Directly from the CLI (`scripts/run_sashiko.sh`)

```bash
# Check active mode (cli vs subagent)
./scripts/run_sashiko.sh --check

# Dry-run commit extraction & config validation (no LLM calls)
./scripts/run_sashiko.sh --no-ai --agent HEAD~1..HEAD

# Fast iterative agent review of the last 3 commits in linux/
./scripts/run_sashiko.sh --agent --cheap HEAD~3..HEAD

# Full pre-submission review with series-level design assessment
./scripts/run_sashiko.sh --agent --design origin/master..HEAD

# Resume an interrupted review
./scripts/run_sashiko.sh --agent --resume origin/master..HEAD
```

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
| `SELFTEST_LINK_MODE` | `auto-libs` | Selftest C binary mode (`auto-libs` or `static`). |
| `SASHIKO_DIR` | `${WS_ROOT}/sashiko` | Path to shallow-cloned Sashiko repository. |
| `SASHIKO_REPO_URL` | `https://github.com/sashiko-dev/sashiko.git` | Git URL cloned by `scripts/setup_sashiko.sh`. |
| `SASHIKO_CONFIG` | `${WS_ROOT}/.kdev/sashiko.toml` | Local Sashiko TOML configuration file (mode `600`). |
| `SASHIKO_BIN` | `${SASHIKO_DIR}/target/release/sashiko` | Path to the built Sashiko CLI binary. |
| `LLVM` / `MAKE_ARGS` | *(unset)* | Optional flags forwarded to `make` (e.g. `LLVM=1`). |

---

## 7. License

This project is licensed under the **Apache License 2.0** — see the [LICENSE](./LICENSE) file for details.

