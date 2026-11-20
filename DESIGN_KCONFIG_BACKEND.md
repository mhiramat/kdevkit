# Design & Python Implementation Specification: Kconfig Dependency Auto-Resolution Backend (`DESIGN_KCONFIG_BACKEND.md`)

## 1. Overview & Architecture

This document defines the design and **Python implementation specification** for the **Kconfig Dependency Auto-Resolution Backend**. It builds directly on top of the Phase 1 Parent Workspace (`kdev-workspace/`) and serves as the headless engine behind the Phase 3 VSCode Kconfig Webview Editor (while remaining fully usable from the CLI).

### Core Objectives

* **Automatic Dependency Resolution:** Given one or more target symbol changes (e.g., `CONFIG_NET_SCH_FQ=y`), automatically compute the minimal set of prerequisite `depends on`, `select`, and `choice` changes required to produce a valid `.config`.
* **Pinned Layer Protection & Conflict Explanation:** Enforce mandatory configuration layers (`configs/qemu.config`, `configs/trace.config`) as hard constraints, and return human-readable **UNSAT Core** conflict reports when a user request contradicts a pinned symbol.
* **Authoritative Kernel Finalization:** Never trust the solver blindly as the final `.config` writer; always apply changes through Phase 1's `scripts/configure.sh` (`merge_config.sh` → `olddefconfig` → `syncconfig` → `.clangd` update) and perform post-verification.
* **Sub-Second Interactive Latency:** Run as a long-lived Python daemon speaking **JSON-RPC 2.0 over stdio (NDJSON)** so the ~20,000-symbol Linux Kconfig tree and base CNF formula are parsed and compiled once per session.
* **Zero Kernel Tree Pollution:** All backend code, virtualenvs, caches, and config layers live outside `linux/`.

### System Architecture

```text
[VSCode Extension (Webview UI + Host)]  (or Developer CLI)
        │  JSON-RPC 2.0 (NDJSON over stdin/stdout; logs strictly to stderr)
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Python Kconfig Backend (kdev-workspace/backend/kconfig_server/)      │
│  ├── main.py           : JSON-RPC 2.0 stdio server & CLI entrypoint  │
│  ├── env_probe.py      : Extracts live Kbuild env vars via GNU Make  │
│  ├── loader.py         : Kconfiglib loader -> immutable IR graph     │
│  ├── sat_encoder.py    : Tristate order encoding & Tseitin CNF cache │
│  ├── solver.py         : Weighted MaxSAT (RC2) + UNSAT Core analyzer │
│  └── layer_manager.py  : layers.json, overlay writer & Phase 1 hook  │
└──────────────────────────────────────────────────────────────────────┘
        │  On `kconfig/apply`: writes configs/solver_overlay.config
        ▼
[Phase 1: scripts/configure.sh]
   ├── merge_config.sh (base + enabled layers) -> olddefconfig -> syncconfig
   └── Regenerates .clangd -> Extension invokes `clangd.restart`

```

---

## 2. Parent Workspace Integration & Directory Layout

Add the following paths under `kdev-workspace/` without modifying any files inside `linux/`:

```text
kdev-workspace/
├── DESIGN.md                           # Phase 1 design (existing)
├── DESIGN_KCONFIG_BACKEND.md           # This document
├── configs/
│   ├── qemu.config                     # [Pinned] Phase 1 QEMU boot fragment
│   └── trace.config                    # [Pinned] Phase 1 DWARF + Kprobes fragment
├── build/
│   └── current/
│       ├── layers.json                 # Declarative layer ordering & pin metadata (per profile)
│       ├── user_injected/              # Directory for user-imported .config fragments
│       └── solver_overlay.config       # Auto-generated diff managed by this backend
├── scripts/
│   └── configure.sh                    # Phase 1 script (accepts ordered fragment args)
├── backend/
│   ├── pyproject.toml                  # Python project & dependency manifest
│   ├── .venv/                          # Isolated Python virtual environment (gitignored)
│   ├── kconfig_server/
│   │   ├── __init__.py
│   │   ├── models.py                   # Immutable IR & RPC dataclasses
│   │   ├── env_probe.py                # Kbuild environment variable extractor & cache
│   │   ├── loader.py                   # Kconfiglib parser -> KconfigIR builder
│   │   ├── sat_encoder.py              # KconfigIR -> Base Hard CNF + variable pool
│   │   ├── solver.py                   # MaxSAT (RC2) solver, provenance & UNSAT core
│   │   ├── layer_manager.py            # layers.json I/O, overlay writer, configure.sh runner
│   │   └── main.py                     # JSON-RPC 2.0 loop + CLI subcommands
│   └── tests/
│       ├── fixtures/                   # Synthetic Kconfig trees for fast unit tests
│       ├── test_encoder_solver.py      # Unit tests for all Kconfig SAT semantics
│       ├── test_layer_manager.py       # Layer parsing, overlay & post-verification tests
│       └── test_rpc_integration.py     # End-to-end stdio JSON-RPC & real-tree smoke tests
└── linux/                              # Upstream Linux Git repository (untouched)

```

### Phase 1 `scripts/configure.sh` Contract

Ensure `scripts/configure.sh` supports taking the base target via `BASE_CONFIG` (default `defconfig`) and an arbitrary ordered list of fragment paths as positional arguments:

```bash
BASE_CONFIG=defconfig scripts/configure.sh \
  configs/qemu.config \
  configs/trace.config \
  configs/user_injected/custom.config \
  configs/solver_overlay.config

```

---

## 3. Python Environment & Packaging Instructions

### Runtime & Dependencies

* **Python Version:** `>= 3.10` (use native union syntax `X | Y`, `match/case`, and `@dataclass(slots=True)`).
* **Core Libraries:**
* **`kconfiglib`**: Use the actively maintained Zephyr fork (`zephyrproject-rtos/Kconfiglib`) rather than the archived upstream PyPI release when targeting Linux 6.x trees that rely on modern Kconfig macro syntax.
* **`python-sat[pblib,aiger]`** (`>= 1.8.dev13`): Provides `WCNF`, `RC2` (Weighted Partial MaxSAT), `CardEnc` (cardinality constraints for `choice`), and native C++ SAT backends (`cadical195`, `glucose4`).


* **Dev/Test Libraries:** `pytest`, `mypy`, `ruff`.

### `backend/pyproject.toml` Specification

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "kconfig-server"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "python-sat[pblib,aiger]>=1.8.dev13",
    "kconfiglib @ git+https://github.com/zephyrproject-rtos/Kconfiglib.git",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "mypy>=1.10",
    "ruff>=0.5",
]

[project.scripts]
kconfig-server = "kconfig_server.main:cli_main"

```

### Setup Commands

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install --upgrade pip
backend/.venv/bin/pip install -e "backend[dev]"

```

---

## 4. Detailed Module-by-Module Python Implementation Guide

### 4.1 Data Models (`kconfig_server/models.py`)

Decouple `kconfiglib` objects from the rest of the backend by defining strict, immutable intermediate representations (IR). If Linux later introduces Kconfig syntax unsupported by `kconfiglib`, only `loader.py` needs to be replaced.

Implement the following types using `enum.Enum` and `@dataclass(frozen=True, slots=True)`:

```python
class SymType(Enum):
    BOOL = "bool"
    TRISTATE = "tristate"
    INT = "int"
    HEX = "hex"
    STRING = "string"
    UNKNOWN = "unknown"

class TriVal(IntEnum):
    N = 0
    M = 1
    Y = 2

```

* **`ExprIR` (Algebraic Expression Union):**
* `ConstExpr(val: TriVal)`
* `SymRefExpr(name: str)`
* `NotExpr(operand: ExprIR)`
* `AndExpr(left: ExprIR, right: ExprIR)`
* `OrExpr(left: ExprIR, right: ExprIR)`
* `CmpExpr(op: Literal["=", "!=", "<", "<=", ">", ">="], left: str | int, right: str | int, left_is_sym: bool, right_is_sym: bool)`


* **`SymbolIR`:**
* `name: str`
* `sym_type: SymType`
* `has_prompt: bool`
* `prompts: tuple[tuple[str, ExprIR], ...]` (prompt text + condition)
* `direct_dep: ExprIR` (from `sym.direct_dep`)
* `visibility: ExprIR` (OR of `(prompt_cond & node.dep)` across prompt-bearing nodes; `ConstExpr(N)` if promptless)
* `selects: tuple[tuple[str, ExprIR], ...]` (`(target_sym_name, condition)`)
* `implies: tuple[tuple[str, ExprIR], ...]`
* `defaults: tuple[tuple[ExprIR | str, ExprIR], ...]` (`(default_val, condition)`)
* `choice_id: str | None`
* `help_text: str`
* `menu_path: tuple[str, ...]`


* **`ChoiceIR`:**
* `id: str`
* `name: str | None`
* `sym_type: SymType` (`BOOL` or `TRISTATE`)
* `is_optional: bool`
* `visibility: ExprIR`
* `members: tuple[str, ...]`


* **`KconfigIR`:**
* `symbols: dict[str, SymbolIR]`
* `choices: dict[str, ChoiceIR]`
* `reverse_selects: dict[str, tuple[tuple[str, ExprIR], ...]]` (precomputed `target -> list[(selector, cond)]`)
* `menu_tree: list[MenuNodeIR]` (for UI tree rendering)



---

### 4.2 Kbuild Environment Extraction (`kconfig_server/env_probe.py`)

Linux Kconfig evaluates toolchain macros (`$(cc-option,...)`, `$(as-option,...)`, `$(ld-option,...)`) and environment variables (`srctree`, `SRCARCH`, `ARCH`, `CC`, `LD`, `AS`, `KERNELVERSION`, `CC_IS_GCC`, `CLANG_VERSION`, etc.). Without these, `CONFIG_CC_HAS_*` symbols evaluate to `n` and corrupt dependency resolution.

#### Implementation Instructions

1. **Live Make Probe (Zero Mutation):**
Invoke GNU Make on `kernel_dir` with an inline makefile on `stdin` (without `O=`, avoiding Kbuild sub-make recursion):
```python
probe_makefile = (
    "include Makefile\n"
    "print-kconfig-env:\n"
    "\t@python3 -c 'import os, json; print(json.dumps(dict(os.environ)))'\n"
)

```


Execute:
```python
subprocess.run(
    ["make", "-C", str(kernel_dir), f"ARCH={arch}", "-s", "-f", "-", "print-kconfig-env"],
    input=probe_makefile,
    text=True,
    capture_output=True,
    check=True,
    timeout=30,
)

```


Extract the last JSON line from `stdout` (ignoring any benign toolchain probe output).
2. **Mandatory Overrides:**
Ensure `srctree = str(kernel_dir)`, `ARCH = arch`, `SRCARCH` (mapped from `arch`, e.g., `x86_64 -> x86`), and `KCONFIG_CONFIG = str(build_dir / ".config")` are explicitly set in the returned dict.
3. **Caching:**
Compute a cache key from `(git_head_sha, arch, compiler_version_string)` and persist the dict to `build_dir / ".kconfig_env_cache.json"`. On subsequent startups with a matching key, skip the `make` invocation.
4. **Unit-Test Bypass:**
Provide a parameter `use_make_probe: bool = True` so unit tests running against synthetic fixture Kconfigs can pass minimal mock env vars directly.

---

### 4.3 Kconfig Loader & IR Normalization (`kconfig_server/loader.py`)

#### Implementation Instructions

1. **Isolated Environment Context:**
Apply probed environment variables temporarily (using a context manager that restores `os.environ` on exit) before calling `kconfiglib.Kconfig(str(kernel_dir / "Kconfig"), warn_to_stderr=False)`.
2. **Capture Parse Warnings:**
Collect `kconf.warnings` and return them in `kconfig/init` rather than letting them print to `stdout`.
3. **Load Current `.config`:**
If `build_dir / ".config"` exists, call `kconf.load_config(str(build_dir / ".config"))` and record current symbol values (`dict[str, str]`) separately from the immutable `KconfigIR`.
4. **Expression Translation (`_translate_expr`):**
Recursively convert `kconfiglib` expression tuples into `ExprIR`:
* `kconf.n` → `ConstExpr(TriVal.N)`, `kconf.m` → `ConstExpr(TriVal.M)`, `kconf.y` → `ConstExpr(TriVal.Y)`
* `kconfiglib.Symbol`: if constant symbol (`sym.is_constant`), map `"n"/"m"/"y"` to `ConstExpr`; otherwise `SymRefExpr(sym.name)`
* `(kconfiglib.NOT, a)` → `NotExpr(...)`
* `(kconfiglib.AND, a, b)` → `AndExpr(...)`
* `(kconfiglib.OR, a, b)` → `OrExpr(...)`
* `(kconfiglib.EQUAL | UNEQUAL | LESS | LESS_EQUAL | GREATER | GREATER_EQUAL, a, b)` → `CmpExpr(...)`


5. **Effective Prompt Visibility:**
A symbol can be defined across multiple `MenuNode`s. Compute `visibility` as the logical OR of `node.prompt[1]` (ANDed with `node.dep` if not already included by `kconfiglib`) across all `node in sym.nodes` where `node.prompt is not None`.
6. **Reverse Select Map:**
Populate `reverse_selects[target]` for every `select` edge in the tree so `sat_encoder.py` can emit lower/upper bounds in a single pass.

---

### 4.4 Tristate Order Encoding & CNF Compilation (`kconfig_server/sat_encoder.py`)

#### Mathematical Encoding Rules

Use `pysat.formula.IDPool(start_from=1)` and allocate two fixed global constant variables (`TRUE_VAR` with unit clause `[TRUE_VAR]`, and `FALSE_VAR = -TRUE_VAR`).

For every `BOOL` or `TRISTATE` symbol $S$, allocate two SAT variables:

* `ge_m(S)`: true iff $S \in \{m, y\}$
* `is_y(S)`: true iff $S = y$

Encode the following **Hard Clauses** once during `kconfig/init`:

1. **Domain Invariants:**
* All bool/tristate $S$: `[-is_y(S), ge_m(S)]` ($S = y \Rightarrow S \ge m$).
* If $S$ is `BOOL`: `[-ge_m(S), is_y(S)]` (forbids $S = m$).
* If $S$ is `TRISTATE` and symbol `MODULES` exists: `[-ge_m(S), is_y(S), is_y(MODULES)]` ($S = m \Rightarrow \text{MODULES} = y$).


2. **Tseitin Expression Encoding (`encode_expr(expr) -> tuple[int, int]` returning `(lit_ge_m, lit_y)`):**
Memoize encoded `ExprIR` subtrees in a dict to prevent clause explosion.
* `ConstExpr(N)` → `(-TRUE_VAR, -TRUE_VAR)`
* `ConstExpr(M)` → `(TRUE_VAR, -TRUE_VAR)`
* `ConstExpr(Y)` → `(TRUE_VAR, TRUE_VAR)`
* `SymRefExpr(S)`:
* Bool/Tristate → `(ge_m(S), is_y(S))`
* Non-bool (`INT`/`HEX`/`STRING`) or undefined symbol → fold using current `.config` value; return `(TRUE_VAR, TRUE_VAR)` if non-empty/non-zero else `(-TRUE_VAR, -TRUE_VAR)` and record symbol in `folded_nonbool_syms`.


* `NotExpr(A)` → `(-a_y, -a_ge_m)`
* `AndExpr(A, B)` → `(tseitin_and(a_ge_m, b_ge_m), tseitin_and(a_y, b_y))`
* `OrExpr(A, B)` → `(tseitin_or(a_ge_m, b_ge_m), tseitin_or(a_y, b_y))`
* `CmpExpr(op, L, R)`:
* If either operand is `INT`/`HEX`/`STRING` or a numeric/string literal: evaluate against current `.config` values and return `(TRUE_VAR, TRUE_VAR)` or `(-TRUE_VAR, -TRUE_VAR)` (recording any referenced non-bool symbols in `folded_nonbool_syms`).
* If comparing bool/tristate values (e.g., `FOO = y`, `FOO != n`, `FOO = m`): encode exact boolean equivalence `eq_lit` and return `(eq_lit, eq_lit)` (Kconfig comparisons yield `y` or `n`, never `m`).




3. **`select` Lower Bounds (Reverse Dependencies):**
For each `(selector, cond)` in `reverse_selects[S]`:
* Encode `eff = AndExpr(SymRefExpr(selector), cond)` → `(e_ge_m, e_y)`.
* Emit `[-e_ge_m, ge_m(S)]`.
* Emit `[-e_y, is_y(S)]`.
* *(Note: Because `BOOL` symbols already have `[-ge_m(S), is_y(S)]`, selecting a `BOOL` with `m` automatically promotes it to `y`, matching Linux Kbuild semantics.)*


4. **Visibility, `depends on`, and Promptless Symbol Guard:**
For each bool/tristate symbol $S$:
* Encode `vis(S)` → `(vis_ge_m, vis_y)`.
* Encode `rev_dep(S)` (OR of all incoming `select` expressions) → `(rev_ge_m, rev_y)`.
* Encode `def_val(S)` (cascaded defaults for **promptless** symbols and `def_bool`/`def_tristate` symbols; for standard prompted symbols with no defaults, `(-TRUE_VAR, -TRUE_VAR)`):
* Walk `defaults` in order: maintain `prev_unmatched = TRUE_VAR`. For each `(val_expr, cond_expr)`:
`active = cond & prev_unmatched`, contribute `val & active` to `def_val`, then update `prev_unmatched = prev_unmatched & !cond`.
* Mask `def_val` by `direct_dep(S)`.


* **Upper Bound (forbids enabling invisible/promptless symbols directly):**
* `[-ge_m(S), vis_ge_m, rev_ge_m, def_ge_m]`
* For `is_y(S)`:
* If `S` is `BOOL`: `[-is_y(S), vis_ge_m, rev_ge_m, def_ge_m]`
* If `S` is `TRISTATE`: `[-is_y(S), vis_y, rev_y, def_y]`




* **Promptless Lower Bound (invisible symbols must take `max(rev_dep, def_val)`):**
* When `vis_ge_m` is False:
* `[vis_ge_m, -def_ge_m, ge_m(S)]`
* `[vis_ge_m, -def_y, is_y(S)]`






5. **`choice` Groups:**
For each `choice` in `ir.choices`:
* Encode `choice.visibility` → `(c_vis_ge_m, c_vis_y)`.
* Let `y_lits = [is_y(m) for m in choice.members]`.
* **At-Most-One `y`:** Generate `CardEnc.atmost(lits=y_lits, bound=1, vpool=pool, encoding=EncType.seqcounter)` and guard every clause with `-c_vis_ge_m` (or unconditionally, since two `y` members in a choice are never valid).
* **At-Least-One `y` (mandatory `BOOL` choice):** If `choice.sym_type == BOOL` and `not choice.is_optional`:
emit `[-c_vis_y, *y_lits]` (when the choice is visible, at least one member must be `y`).



#### Performance & Immutability Note

Compile `base_hard_clauses: list[list[int]]` **once** during `kconfig/init`. Store it as a read-only structure so every `kconfig/solve` call reuses it without re-traversing the 20,000-symbol AST.

---

### 4.5 MaxSAT Solver, Provenance & UNSAT Core (`kconfig_server/solver.py`)

#### Solving Algorithm (`solve(requests, current_values, pinned_map, user_injected_map, ignore_pins=False)`)

1. **Build `WCNF`:**
* Copy `base_hard_clauses` into `wcnf.hard`.
* **User Requests (Hard):** For each `(sym, target_val)` in `requests`, append unit hard clauses:
* `Y` → `[is_y(S)]`
* `M` → `[ge_m(S)]` and `[-is_y(S)]`
* `N` → `[-ge_m(S)]`


* **Pinned Layers (Hard unless `ignore_pins=True`):** For each `(sym, pinned_val, layer_id)` in `pinned_map`, append unit hard clauses. (If a user request explicitly targets a pinned symbol and `ignore_pins=False`, let it proceed to UNSAT core detection so the exact conflict is reported clearly.)
* **Soft Clauses (Tiered Weights):**
* **Weight `100`:** Non-pinned `user_injected` symbols preserving their fragment value.
* **Weight `10`:** Symbols currently `Y` or `M` in `.config` preserving their current value (minimizes collateral feature removals).
* **Weight `1`:** Symbols currently `N` in `.config` staying `N` (minimizes newly added prerequisite symbols).
* *(Skip adding soft clauses for symbols already in `requests`.)*




2. **Run `RC2`:**
```python
solver_name = "cadical195"  # fallback to "glucose4" if unavailable
with RC2(wcnf, solver=solver_name) as rc2:
    model = rc2.compute()

```


3. **If SAT (`model is not None`):**
* Convert `model` into a `set[int]` of positive literals.
* Reconstruct `TriVal` for every bool/tristate symbol (`Y` if `is_y in pos`, `M` if `ge_m in pos`, else `N`).
* Filter to symbols whose value changed relative to `current_values`.
* **Provenance Tagging (`_compute_reasons`):**
Perform a BFS starting from `requests`:
* Requested symbols → `"user_request"`
* Symbols appearing in `direct_dep`/`visibility` of an already-explained symbol → `f"required_by:{parent}"`
* Symbols in `selects` of an already-explained symbol → `f"selected_by:{parent}"`
* Sibling members of the same `ChoiceIR` flipped to `n` → `f"choice_replaced_by:{winner}"`
* Any remaining changed symbols → `"dependency_closure"`


* Return `SolveResult(status="ok", solve_time_ms=..., changes=..., warnings=...)`.


4. **If UNSAT (`model is None`) — Conflict Explanation:**
* Do **not** run `RC2`; instantiate `pysat.solvers.Solver(name=solver_name, bootstrap_with=base_hard_clauses)`.
* Create fresh assumption variables (or use unit literals directly) for:
* Each user request (`req_lits`)
* Each pinned symbol (`pin_lits`)


* Call `sat = solver.solve(assumptions=req_lits + pin_lits)`.
* If `not sat`, call `core = solver.get_core()` and map each literal in `core` back to either:
* `{ "kind": "user_request", "symbol": sym, "requested": val }`
* `{ "kind": "pinned_layer", "symbol": sym, "pinnedValue": val, "layerId": layer_id, "layerPath": path }`


* If `core` contains only `user_request` items (impossible even without pins, e.g., an architecture-excluded symbol or blocked by a folded `INT`/`HEX` symbol), inspect `direct_dep` of those symbols and report unsatisfied constant/non-bool expressions in `diagnostics`.
* Return `SolveResult(status="conflict", conflicts=..., diagnostics=...)`.



---

### 4.6 Layer Management & Phase 1 Finalization (`kconfig_server/layer_manager.py`)

#### `configs/layers.json` Schema

```json
{
  "version": 1,
  "base_target": "defconfig",
  "layers": [
    {
      "id": "qemu",
      "path": "configs/qemu.config",
      "enabled": true,
      "pinned": true,
      "readonly": false
    },
    {
      "id": "trace",
      "path": "configs/trace.config",
      "enabled": true,
      "pinned": true,
      "readonly": false
    },
    {
      "id": "solver",
      "path": "configs/solver_overlay.config",
      "enabled": true,
      "pinned": false,
      "readonly": true
    }
  ]
}

```

#### Implementation Instructions

1. **Fragment Parser (`parse_config_fragment`):**
Parse standard Kconfig lines:
* `^CONFIG_([A-Za-z0-9_]+)=(.+)$` → `(sym, val)`
* `^# CONFIG_([A-Za-z0-9_]+) is not set$` → `(sym, "n")`
Later enabled layers override earlier layers when building `pinned_map` (only `pinned=True` layers) and `user_injected_map` (`pinned=False` and `id != "solver"`).


2. **Overlay Persistence (`write_solver_overlay`):**
Merge newly applied `changes` into `configs/solver_overlay.config` (preserving previously resolved user choices that weren't overridden), writing canonical Kconfig syntax (`CONFIG_X=y`, `CONFIG_X=m`, `# CONFIG_X is not set`).
3. **Authoritative Phase 1 Invocation (`apply_layers`):**
* Collect enabled layer paths from `layers.json` in order.
* Execute `scripts/configure.sh` via `subprocess.run(..., capture_output=True, text=True)` with `BASE_CONFIG=<base_target>` and layer paths as positional args.
* Capture any `merge_config.sh` dropped-symbol warnings (`Value requested for CONFIG_... not in final .config`).


4. **Post-Verification (`verify_final_config`):**
* Re-parse `build/current/.config`.
* Check every symbol in `applied_changes` and `pinned_map`.
* Return `verified: bool` and `mismatches: list[{symbol, expected, actual}]` so the UI immediately flags any edge-case divergence between the SAT model and Kbuild's `olddefconfig`.



---

### 4.7 JSON-RPC 2.0 Server & CLI Entrypoint (`kconfig_server/main.py`)

#### Protocol Rules (Critical for VSCode Integration)

* **Transport:** Line-delimited JSON-RPC 2.0 (NDJSON) over `sys.stdin` / `sys.stdout`.
* **Strict `stdout` Hygiene:** Configure Python `logging` exclusively to `sys.stderr`. Never call `print()` to `stdout` outside the JSON-RPC serializer. Call `sys.stdout.flush()` after every message.
* **Error Codes:**
* `-32001`: Backend not initialized (`kconfig/init` not called yet)
* `-32002`: Kernel source or `Kconfig` not found
* `-32003`: `configure.sh` execution failed (include `stderr` in `error.data`)
* `-32602`: Invalid parameters (e.g., unknown symbol name or invalid tristate value)



#### RPC Methods

| Method | Request Params | Response Result |
| --- | --- | --- |
| `kconfig/init` | `workspaceRoot`, `kernelDir`, `buildDir`, `arch`, `layersJsonPath` | `symbolCount`, `choiceCount`, `initTimeMs`, `encodeTimeMs`, `warnings[]`, `layers` |
| `kconfig/getTree` | `parentId: str | null` | `nodes[]` (`id`, `kind` (`menu`/`symbol`/`choice`), `name`, `prompt`, `type`, `value`, `visible`, `pinnedBy`) |
| `kconfig/search` | `query: str`, `limit: int = 50`, `onlyChanged: bool = false` | `items[]` (symbol summary + match location) |
| `kconfig/getSymbolDetail` | `symbol: str` | `help`, `value`, `type`, `visible`, `pinnedBy`, `directDepText`, `selects[]`, `selectedBy[]`, `menuPath[]` |
| `kconfig/solve` | `requests: [{symbol, value}]`, `ignorePins: bool = false` | `status` (`"ok"` | `"conflict"`), `solveTimeMs`, `changes[]`, `conflicts[]`, `diagnostics[]` |
| `kconfig/layers/get` | `{}` | Current `layers.json` content + per-layer symbol counts |
| `kconfig/layers/set` | `baseTarget`, `layers[]` | Persists `layers.json`, reloads pinned/injected maps, optionally runs `configure.sh` |
| `kconfig/apply` | `changes: [{symbol, value}]` | Updates `solver_overlay.config`, runs `scripts/configure.sh`, reloads `.config`, returns `verified`, `mismatches[]`, `configureWarnings[]` |
| `kconfig/reloadConfig` | `{}` | Re-reads `build/current/.config` from disk (after external edits) without re-parsing Kconfig |

#### CLI Subcommands (For Headless Development & Testing)

Expose thin CLI subcommands via `argparse` in `main.py` using the same service class:

* `kconfig-server serve` — Starts the JSON-RPC 2.0 stdio daemon.
* `kconfig-server solve --workspace . --set NET_SCH_FQ=y [--set KPROBES=n] [--ignore-pins]` — Prints the JSON solve result to stdout.
* `kconfig-server apply --workspace . --set NET_SCH_FQ=y` — Solves, writes overlay, runs `scripts/configure.sh`, and prints post-verification status.
* `kconfig-server search --workspace . --query KPROBE` — Searches symbols from the terminal.

---

## 5. Python Implementation Constraints & Pitfalls to Avoid

1. **No Recursive Stack Overflow on Deep Kconfig Expressions:**
Linux Kconfig `depends on` and `select` chains can nest deeply. Implement `encode_expr` with explicit memoization and raise `sys.setrecursionlimit(10000)` defensively (or use iterative flattening for long `AND`/`OR` chains).
2. **Boolean Promotion on `select`:**
In Kconfig, if a `TRISTATE` symbol `A=m` does `select B` where `B` is `BOOL`, `B` becomes `y` (not `m`). Verify the domain invariant `[-ge_m(B), is_y(B)]` is always present so `ge_m(B)` implies `is_y(B)`.
3. **`imply` Is Not a Hard Constraint:**
Unlike `select`, Kconfig `imply` is a weak default that can be overridden to `n` by user config or unmet dependencies. Do **not** encode `imply` as a hard clause; treat it at most as a low-weight soft preference or defer it to `olddefconfig`.
4. **Normalize Symbol Names:**
Accept both `"CONFIG_FOO"` and `"FOO"` on all RPC/CLI inputs by stripping a leading `"CONFIG_"` prefix internally, while always writing `"CONFIG_FOO"` in `.config` fragments.
5. **Graceful Solver Backend Fallback:**
Prefer `cadical195` in `python-sat` for speed on 20k-symbol instances; detect availability at import time and fall back cleanly to `glucose4` or `m22`.
6. **Subprocess Safety:**
Never pass `shell=True` when invoking `make` or `scripts/configure.sh`. Always pass argument lists and validate that user-injected layer paths resolve cleanly (checking file existence before writing `layers.json`).

---

## 6. Verification & Test Plan

### 6.1 Unit Test Suite (`backend/tests/test_encoder_solver.py`)

Create small, deterministic Kconfig files under `backend/tests/fixtures/` and verify all 8 behaviors with `pytest`:

| Test Case | Kconfig Pattern | Expected Solver Behavior |
| --- | --- | --- |
| **1. Linear Dependency** | `C depends on B`, `B depends on A` | Request `C=y` → enables `A=y, B=y, C=y` with provenance chain. |
| **2. Disjunction Cost Minimization** | `C depends on A || (B1 && B2)` | Request `C=y` → chooses `A=y` (cost 1) instead of `B1+B2` (cost 2). |
| **3. Negation & Auto-Disable** | `B depends on !A` (`A=y` currently, unpinned) | Request `B=y` → sets `A=n, B=y`. |
| **4. Pinned Conflict + UNSAT Core** | `B depends on !A` (`A=y` in pinned `qemu.config`) | Request `B=y` → `status="conflict"`, UNSAT core identifies `A` (`layerId="qemu"`) and `B`. Re-running with `ignore_pins=True` succeeds. |
| **5. Tristate & `MODULES=n**` | `TRISTATE B`, `MODULES=n` | Request `B=m` → automatically enables `MODULES=y` (if unpinned) or conflicts (if `MODULES=n` is pinned). |
| **6. `select` Promotion** | `TRISTATE A` selects `BOOL B` | Request `A=m` → forces `B=y` (not `m`). |
| **7. Exclusive `choice` Switch** | Mandatory `choice` with `OPT_1` (active), `OPT_2` | Request `OPT_2=y` → sets `OPT_1=n, OPT_2=y`. |
| **8. Promptless Guard** | Promptless `INTERNAL` selected only by prompted `DRIVER_X` | Request `INTERNAL=y` → enables `DRIVER_X=y` (never flips `INTERNAL` without a valid selector/default). |

### 6.2 Real-Kernel Integration & Acceptance Criteria (`backend/tests/test_rpc_integration.py`)

Run against the real `kdev-workspace/linux/` tree:

1. **Startup Performance:** `kconfig/init` parses the full Linux tree and compiles the base CNF in under **10 seconds** (warm env cache).
2. **Interactive Solve Latency:** `kconfig/solve` for a non-trivial feature (e.g., enabling a filesystem or network scheduler disabled in `defconfig`) completes in under **500 ms**.
3. **End-to-End Apply & Post-Verification:** `kconfig/apply` writes `configs/solver_overlay.config`, invokes Phase 1's `scripts/configure.sh`, updates `build/current/include/generated/autoconf.h`, and returns `verified: true` with `mismatches: []`.
4. **Git Cleanliness:** `git -C linux status --porcelain` remains completely empty after running the entire test suite.
