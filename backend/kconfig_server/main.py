"""JSON-RPC 2.0 stdio server and CLI entrypoint for the Kconfig Dependency Auto-Resolution Backend."""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
import sys
import time
from typing import Any

from .env_probe import probe_kbuild_env
from .layer_manager import ConfigureScriptError, LayerManager, parse_config_fragment
from .loader import load_kconfig, reload_dot_config
from .models import (
    KconfigIR,
    TriVal,
    eval_expr_trival,
    expr_to_str,
    normalize_sym_name,
)
from .sat_encoder import SATEncoder
from .solver import KconfigSolver

# JSON-RPC 2.0 Error Codes
ERR_PARSE_ERROR = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL_ERROR = -32603

ERR_NOT_INITIALIZED = -32001
ERR_KCONFIG_NOT_FOUND = -32002
ERR_CONFIGURE_FAILED = -32003


class JsonRpcError(Exception):
    """Structured JSON-RPC 2.0 error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_dict(self) -> dict[str, Any]:
        err: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            err["data"] = self.data
        return err


class KconfigService:
    """Stateful Kconfig resolution service managing IR, base CNF encoder, solver, and layers."""

    def __init__(self) -> None:
        self.workspace_root: Path | None = None
        self.kernel_dir: Path | None = None
        self.build_dir: Path | None = None
        self.arch: str = "x86_64"
        self.use_make_probe: bool = True
        self.kconfig_filename: str = "Kconfig"

        self.ir: KconfigIR | None = None
        self.current_values: dict[str, str] = {}
        self.initial_values: dict[str, str] = {}
        self.encoder: SATEncoder | None = None
        self.solver: KconfigSolver | None = None
        self.layer_manager: LayerManager | None = None

    def _require_initialized(self) -> tuple[KconfigIR, SATEncoder, KconfigSolver, LayerManager]:
        if (
            self.ir is None
            or self.encoder is None
            or self.solver is None
            or self.layer_manager is None
        ):
            raise JsonRpcError(
                ERR_NOT_INITIALIZED,
                "Backend not initialized; call 'kconfig/init' first.",
            )
        return self.ir, self.encoder, self.solver, self.layer_manager

    def rpc_init(self, params: dict[str, Any]) -> dict[str, Any]:
        t0 = time.perf_counter()

        ws_raw = params.get("workspaceRoot") or "."
        ws_root = Path(ws_raw).resolve()
        kernel_dir = Path(params.get("kernelDir") or (ws_root / "linux")).resolve()
        build_dir = Path(params.get("buildDir") or (ws_root / "build" / "current")).resolve()
        arch = str(params.get("arch") or "x86_64")
        layers_json_raw = params.get("layersJsonPath")
        layers_json_path = (
            Path(layers_json_raw).resolve()
            if layers_json_raw
            else (build_dir / "layers.json")
        )
        use_make_probe = bool(params.get("useMakeProbe", True))
        kconfig_filename = str(params.get("kconfigFilename") or "Kconfig")

        kconfig_file = kernel_dir / kconfig_filename
        if not kernel_dir.is_dir() or not kconfig_file.is_file():
            raise JsonRpcError(
                ERR_KCONFIG_NOT_FOUND,
                f"Kernel source or Kconfig not found at {kconfig_file}",
            )

        self.workspace_root = ws_root
        self.kernel_dir = kernel_dir
        self.build_dir = build_dir
        self.arch = arch
        self.use_make_probe = use_make_probe
        self.kconfig_filename = kconfig_filename

        self.layer_manager = LayerManager(
            workspace_root=ws_root,
            layers_json_path=layers_json_path,
            build_dir=build_dir,
            kernel_dir=kernel_dir,
            arch=arch,
        )

        env_vars = probe_kbuild_env(
            kernel_dir=kernel_dir,
            build_dir=build_dir,
            arch=arch,
            use_make_probe=use_make_probe,
        )

        try:
            ir, current_values, warnings = load_kconfig(
                kernel_dir=kernel_dir,
                build_dir=build_dir,
                env_vars=env_vars,
                kconfig_filename=kconfig_filename,
            )
        except FileNotFoundError as exc:
            raise JsonRpcError(ERR_KCONFIG_NOT_FOUND, str(exc)) from exc

        encoder = SATEncoder(ir=ir, current_values=current_values)
        solver = KconfigSolver(ir=ir, encoder=encoder)

        self.ir = ir
        self.current_values = current_values
        self.initial_values = dict(current_values)
        self.encoder = encoder
        self.solver = solver

        init_time_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "symbolCount": len(ir.symbols),
            "choiceCount": len(ir.choices),
            "initTimeMs": round(init_time_ms, 2),
            "encodeTimeMs": round(encoder.encode_time_ms, 2),
            "warnings": warnings,
            "layers": self.layer_manager.get_layers_info(),
        }

    def rpc_get_tree(self, params: dict[str, Any]) -> dict[str, Any]:
        ir, _, _, layer_mgr = self._require_initialized()
        parent_id = params.get("parentId")

        if parent_id is None:
            node_ids = ir.root_node_ids
        else:
            parent_node = ir.menu_nodes.get(str(parent_id))
            if parent_node is None:
                raise JsonRpcError(
                    ERR_INVALID_PARAMS, f"Unknown menu node parentId: {parent_id}"
                )
            node_ids = parent_node.children

        nodes_out: list[dict[str, Any]] = []
        for nid in node_ids:
            mnode = ir.menu_nodes.get(nid)
            if mnode is None:
                continue
            vis = (
                eval_expr_trival(mnode.visibility, self.current_values, ir.symbols)
                != TriVal.N
            )
            sym_type_str = "menu"
            val_str = ""
            pinned_by: str | None = None

            if mnode.kind == "symbol" and mnode.name and mnode.name in ir.symbols:
                sym_ir = ir.symbols[mnode.name]
                sym_type_str = sym_ir.sym_type.value
                val_str = self.current_values.get(mnode.name, "n")
                pin_info = layer_mgr.pinned_map.get(mnode.name)
                if pin_info is not None:
                    pinned_by = pin_info.layer_id
            elif mnode.kind == "choice" and mnode.name and mnode.name in ir.choices:
                ch_ir = ir.choices[mnode.name]
                sym_type_str = ch_ir.sym_type.value
                for m in ch_ir.members:
                    if self.current_values.get(m) == "y":
                        val_str = m
                        break

            nodes_out.append(
                {
                    "id": mnode.id,
                    "kind": mnode.kind,
                    "name": mnode.name,
                    "prompt": mnode.prompt,
                    "type": sym_type_str,
                    "value": val_str,
                    "visible": vis,
                    "pinnedBy": pinned_by,
                    "hasChildren": len(mnode.children) > 0,
                }
            )

        return {"nodes": nodes_out}

    def rpc_search(self, params: dict[str, Any]) -> dict[str, Any]:
        ir, _, _, layer_mgr = self._require_initialized()
        raw_query = str(params.get("query") or "").strip()
        query_norm = normalize_sym_name(raw_query).lower()
        limit = int(params.get("limit", 50))
        only_changed = bool(params.get("onlyChanged", False))

        overlay_syms: set[str] = set()
        overlay_path = layer_mgr.get_solver_overlay_path()
        if overlay_path.is_file():
            overlay_syms = set(parse_config_fragment(overlay_path).keys())

        scored_items: list[tuple[int, str, dict[str, Any]]] = []
        for sym_name, sym_ir in ir.symbols.items():
            cur_val = self.current_values.get(sym_name, "n")
            if only_changed:
                if (
                    sym_name not in overlay_syms
                    and cur_val == self.initial_values.get(sym_name, "n")
                ):
                    continue

            prompt_text = sym_ir.prompts[0][0] if sym_ir.prompts else ""
            name_lower = sym_name.lower()
            prompt_lower = prompt_text.lower()

            match_location: str | None = None
            rank = 99
            if not query_norm:
                match_location = "symbol"
                rank = 0
            elif name_lower == query_norm:
                match_location = "symbol_exact"
                rank = 0
            elif name_lower.startswith(query_norm):
                match_location = "symbol_prefix"
                rank = 1
            elif query_norm in name_lower:
                match_location = "symbol"
                rank = 2
            elif query_norm in prompt_lower:
                match_location = "prompt"
                rank = 3

            if match_location is None:
                continue

            vis = (
                eval_expr_trival(sym_ir.visibility, self.current_values, ir.symbols)
                != TriVal.N
            )
            pin_info = layer_mgr.pinned_map.get(sym_name)

            scored_items.append(
                (
                    rank,
                    sym_name,
                    {
                        "symbol": sym_name,
                        "prompt": prompt_text,
                        "type": sym_ir.sym_type.value,
                        "value": cur_val,
                        "visible": vis,
                        "pinnedBy": pin_info.layer_id if pin_info else None,
                        "matchLocation": match_location,
                        "menuPath": list(sym_ir.menu_path),
                    },
                )
            )

        scored_items.sort(key=lambda item: (item[0], item[1]))
        items_out = [item[2] for item in scored_items[: max(0, limit)]]
        return {"items": items_out}

    def rpc_get_symbol_detail(self, params: dict[str, Any]) -> dict[str, Any]:
        ir, _, _, layer_mgr = self._require_initialized()
        raw_sym = params.get("symbol")
        if not raw_sym or not isinstance(raw_sym, str):
            raise JsonRpcError(ERR_INVALID_PARAMS, "Parameter 'symbol' is required.")

        sym_name = normalize_sym_name(raw_sym)
        sym_ir = ir.symbols.get(sym_name)
        if sym_ir is None:
            raise JsonRpcError(ERR_INVALID_PARAMS, f"Unknown symbol: {raw_sym}")

        vis = (
            eval_expr_trival(sym_ir.visibility, self.current_values, ir.symbols)
            != TriVal.N
        )
        pin_info = layer_mgr.pinned_map.get(sym_name)

        selects_list = [
            {"symbol": t, "condition": expr_to_str(c)} for t, c in sym_ir.selects
        ]
        selected_by_list = [
            {"symbol": s, "condition": expr_to_str(c)}
            for s, c in ir.reverse_selects.get(sym_name, ())
        ]
        prompts_list = [
            {"text": p, "condition": expr_to_str(c)} for p, c in sym_ir.prompts
        ]

        return {
            "symbol": sym_name,
            "prompt": sym_ir.prompts[0][0] if sym_ir.prompts else "",
            "prompts": prompts_list,
            "help": sym_ir.help_text,
            "value": self.current_values.get(sym_name, "n"),
            "type": sym_ir.sym_type.value,
            "visible": vis,
            "pinnedBy": pin_info.layer_id if pin_info else None,
            "directDepText": expr_to_str(sym_ir.direct_dep),
            "selects": selects_list,
            "selectedBy": selected_by_list,
            "menuPath": list(sym_ir.menu_path),
            "choiceId": sym_ir.choice_id,
        }

    def rpc_solve(self, params: dict[str, Any]) -> dict[str, Any]:
        _, _, solver, layer_mgr = self._require_initialized()
        raw_requests = params.get("requests")
        if not isinstance(raw_requests, list) or not raw_requests:
            raise JsonRpcError(
                ERR_INVALID_PARAMS,
                "Parameter 'requests' must be a non-empty list of {symbol, value}.",
            )

        ignore_pins = bool(params.get("ignorePins", False))
        req_tuples: list[tuple[str, str]] = []
        for item in raw_requests:
            if not isinstance(item, dict) or "symbol" not in item or "value" not in item:
                raise JsonRpcError(
                    ERR_INVALID_PARAMS,
                    "Each request item must contain 'symbol' and 'value'.",
                )
            req_tuples.append((str(item["symbol"]), str(item["value"])))

        try:
            res = solver.solve(
                requests=req_tuples,
                current_values=self.current_values,
                pinned_map=layer_mgr.pinned_map,
                user_injected_map=layer_mgr.user_injected_map,
                ignore_pins=ignore_pins,
            )
        except ValueError as exc:
            raise JsonRpcError(ERR_INVALID_PARAMS, str(exc)) from exc

        return res.to_dict()

    def rpc_layers_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        _, _, _, layer_mgr = self._require_initialized()
        return layer_mgr.get_layers_info()

    def rpc_layers_set(self, params: dict[str, Any]) -> dict[str, Any]:
        ir, _, _, layer_mgr = self._require_initialized()
        base_target = params.get("baseTarget") or params.get("base_target")
        layers = params.get("layers")
        if not isinstance(layers, list):
            raise JsonRpcError(ERR_INVALID_PARAMS, "Parameter 'layers' must be a list.")

        run_configure = bool(params.get("runConfigure", False))
        try:
            info = layer_mgr.set_layers(base_target=base_target, new_layers=layers)
            if run_configure:
                apply_info = layer_mgr.apply_layers()
                assert self.build_dir is not None
                self.current_values = reload_dot_config(
                    ir, self.build_dir / ".config", self.current_values
                )
                info["applyResult"] = apply_info
            return info
        except FileNotFoundError as exc:
            raise JsonRpcError(ERR_INVALID_PARAMS, str(exc)) from exc
        except ConfigureScriptError as exc:
            raise JsonRpcError(
                ERR_CONFIGURE_FAILED,
                str(exc),
                data={"returncode": exc.returncode, "stderr": exc.stderr, "stdout": exc.stdout},
            ) from exc

    def rpc_apply(self, params: dict[str, Any]) -> dict[str, Any]:
        ir, _, _, layer_mgr = self._require_initialized()
        raw_changes = params.get("changes")
        if not isinstance(raw_changes, list):
            raise JsonRpcError(
                ERR_INVALID_PARAMS,
                "Parameter 'changes' must be a list of {symbol, value}.",
            )

        change_tuples: list[tuple[str, str]] = []
        for item in raw_changes:
            if not isinstance(item, dict) or "symbol" not in item:
                raise JsonRpcError(
                    ERR_INVALID_PARAMS,
                    "Each change item must contain 'symbol' and 'value' (or 'newValue').",
                )
            val = item.get("value") if "value" in item else item.get("newValue")
            if val is None:
                raise JsonRpcError(
                    ERR_INVALID_PARAMS,
                    f"Missing 'value' for symbol {item['symbol']!r}",
                )
            sym_name = normalize_sym_name(str(item["symbol"]))
            if sym_name not in ir.symbols:
                raise JsonRpcError(ERR_INVALID_PARAMS, f"Unknown symbol: {sym_name}")
            change_tuples.append((sym_name, str(val)))

        try:
            apply_res = layer_mgr.apply_layers(change_tuples)
        except ConfigureScriptError as exc:
            raise JsonRpcError(
                ERR_CONFIGURE_FAILED,
                str(exc),
                data={"returncode": exc.returncode, "stderr": exc.stderr, "stdout": exc.stdout},
            ) from exc

        assert self.build_dir is not None
        self.current_values = reload_dot_config(
            ir, self.build_dir / ".config", self.current_values
        )
        return apply_res

    def rpc_reload_config(self, _params: dict[str, Any]) -> dict[str, Any]:
        ir, _, _, layer_mgr = self._require_initialized()
        assert self.build_dir is not None
        dot_config = self.build_dir / ".config"
        self.current_values = reload_dot_config(ir, dot_config, self.current_values)
        layer_mgr.rebuild_constraint_maps()
        return {
            "reloaded": True,
            "configPath": str(dot_config),
            "exists": dot_config.is_file(),
        }

    def dispatch(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        params = params or {}
        if not isinstance(params, dict):
            raise JsonRpcError(ERR_INVALID_PARAMS, "JSON-RPC params must be an object.")

        handlers = {
            "kconfig/init": self.rpc_init,
            "kconfig/getTree": self.rpc_get_tree,
            "kconfig/search": self.rpc_search,
            "kconfig/getSymbolDetail": self.rpc_get_symbol_detail,
            "kconfig/solve": self.rpc_solve,
            "kconfig/layers/get": self.rpc_layers_get,
            "kconfig/layers/set": self.rpc_layers_set,
            "kconfig/apply": self.rpc_apply,
            "kconfig/reloadConfig": self.rpc_reload_config,
        }
        handler = handlers.get(method)
        if handler is None:
            raise JsonRpcError(ERR_METHOD_NOT_FOUND, f"Method not found: {method}")
        return handler(params)


def _write_jsonrpc_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def serve_jsonrpc() -> int:
    """Run the line-delimited JSON-RPC 2.0 (NDJSON) server over stdin/stdout."""
    service = KconfigService()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        req_id: Any = None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            _write_jsonrpc_response(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": ERR_PARSE_ERROR,
                        "message": f"Invalid JSON: {exc}",
                    },
                }
            )
            continue

        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            req_id = msg.get("id") if isinstance(msg, dict) else None
            _write_jsonrpc_response(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": ERR_INVALID_REQUEST,
                        "message": "Invalid JSON-RPC 2.0 request object.",
                    },
                }
            )
            continue

        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params")

        if not isinstance(method, str):
            _write_jsonrpc_response(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": ERR_INVALID_REQUEST,
                        "message": "Request 'method' must be a string.",
                    },
                }
            )
            continue

        try:
            result = service.dispatch(method, params)
            if "id" in msg:
                _write_jsonrpc_response(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": result,
                    }
                )
        except JsonRpcError as rpc_err:
            if "id" in msg:
                _write_jsonrpc_response(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": rpc_err.to_dict(),
                    }
                )
        except Exception as exc:
            logging.exception("Unhandled error while processing method %s", method)
            if "id" in msg:
                _write_jsonrpc_response(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": ERR_INTERNAL_ERROR,
                            "message": f"Internal error: {exc}",
                        },
                    }
                )
    return 0


def _parse_set_assignments(raw_items: list[str]) -> list[dict[str, str]]:
    requests: list[dict[str, str]] = []
    for item in raw_items:
        if "=" not in item:
            raise ValueError(f"Expected SYMBOL=VALUE format, got: {item!r}")
        sym, val = item.split("=", 1)
        requests.append({"symbol": normalize_sym_name(sym), "value": val.strip().lower()})
    return requests


def cli_main(argv: list[str] | None = None) -> int:
    # Configure logging strictly to stderr so stdout remains clean for JSON/NDJSON
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.WARNING,
        format="[kconfig-server] %(levelname)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        prog="kconfig-server",
        description="Kconfig Dependency Auto-Resolution Backend (JSON-RPC 2.0 & CLI)",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # serve
    subparsers.add_parser("serve", help="Start the JSON-RPC 2.0 stdio daemon")

    # solve
    p_solve = subparsers.add_parser("solve", help="Compute minimal dependency closure for symbol changes")
    p_solve.add_argument("--workspace", default=".", help="Path to parent workspace root")
    p_solve.add_argument("--kernel-dir", default=None, help="Override kernel directory")
    p_solve.add_argument("--build-dir", default=None, help="Override build directory")
    p_solve.add_argument("--arch", default="x86_64", help="Target architecture")
    p_solve.add_argument(
        "--set",
        dest="assignments",
        action="append",
        required=True,
        metavar="SYM=VAL",
        help="Target symbol assignment (e.g. NET_SCH_FQ=y)",
    )
    p_solve.add_argument(
        "--ignore-pins",
        action="store_true",
        help="Ignore pinned layer constraints",
    )

    # apply
    p_apply = subparsers.add_parser(
        "apply",
        help="Solve dependencies, write solver_overlay.config, and run scripts/configure.sh",
    )
    p_apply.add_argument("--workspace", default=".", help="Path to parent workspace root")
    p_apply.add_argument("--kernel-dir", default=None, help="Override kernel directory")
    p_apply.add_argument("--build-dir", default=None, help="Override build directory")
    p_apply.add_argument("--arch", default="x86_64", help="Target architecture")
    p_apply.add_argument(
        "--set",
        dest="assignments",
        action="append",
        required=True,
        metavar="SYM=VAL",
        help="Target symbol assignment (e.g. NET_SCH_FQ=y)",
    )
    p_apply.add_argument(
        "--ignore-pins",
        action="store_true",
        help="Ignore pinned layer constraints during solve",
    )

    # search
    p_search = subparsers.add_parser("search", help="Search Kconfig symbols by name or prompt")
    p_search.add_argument("--workspace", default=".", help="Path to parent workspace root")
    p_search.add_argument("--kernel-dir", default=None, help="Override kernel directory")
    p_search.add_argument("--build-dir", default=None, help="Override build directory")
    p_search.add_argument("--arch", default="x86_64", help="Target architecture")
    p_search.add_argument("--query", required=True, help="Search query string")
    p_search.add_argument("--limit", type=int, default=50, help="Max results to return")
    p_search.add_argument("--only-changed", action="store_true", help="Only return modified symbols")

    args = parser.parse_args(argv)

    if args.subcommand == "serve":
        return serve_jsonrpc()

    service = KconfigService()
    init_params: dict[str, Any] = {
        "workspaceRoot": args.workspace,
        "arch": args.arch,
    }
    if getattr(args, "kernel_dir", None):
        init_params["kernelDir"] = args.kernel_dir
    if getattr(args, "build_dir", None):
        init_params["buildDir"] = args.build_dir

    try:
        service.rpc_init(init_params)

        if args.subcommand == "solve":
            requests = _parse_set_assignments(args.assignments)
            res = service.rpc_solve({"requests": requests, "ignorePins": args.ignore_pins})
            sys.stdout.write(json.dumps(res, indent=2) + "\n")
            sys.stdout.flush()
            return 0 if res["status"] == "ok" else 1

        if args.subcommand == "apply":
            requests = _parse_set_assignments(args.assignments)
            solve_res = service.rpc_solve(
                {"requests": requests, "ignorePins": args.ignore_pins}
            )
            if solve_res["status"] != "ok":
                sys.stdout.write(json.dumps(solve_res, indent=2) + "\n")
                sys.stdout.flush()
                return 1
            changes = [
                {"symbol": c["symbol"], "value": c["newValue"]}
                for c in solve_res["changes"]
            ]
            apply_res = service.rpc_apply({"changes": changes})
            output = {
                "solve": solve_res,
                "apply": apply_res,
            }
            sys.stdout.write(json.dumps(output, indent=2) + "\n")
            sys.stdout.flush()
            return 0 if apply_res["verified"] else 1

        if args.subcommand == "search":
            res = service.rpc_search(
                {
                    "query": args.query,
                    "limit": args.limit,
                    "onlyChanged": args.only_changed,
                }
            )
            sys.stdout.write(json.dumps(res, indent=2) + "\n")
            sys.stdout.flush()
            return 0

    except (JsonRpcError, ValueError) as exc:
        err_out = (
            exc.to_dict()
            if isinstance(exc, JsonRpcError)
            else {"code": ERR_INVALID_PARAMS, "message": str(exc)}
        )
        sys.stderr.write(json.dumps({"error": err_out}, indent=2) + "\n")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main())
