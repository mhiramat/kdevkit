#!/usr/bin/env python3
"""Helper CLI for the kdev-patch-series skill.

Automates deterministic, byte-preserving operations for Linux kernel patch
series submission and v1->vN iteration in kdevkit:
  - check-ascii:   Scan git commits and cover letters for stray non-ASCII chars.
  - fetch-sashiko: Fetch public review findings from sashiko.dev JSON API.
  - stage:         Generate git format-patch files, inject cover letter and
                   per-patch 'Changes in vN:' notes after '---', enforce ASCII
                   hygiene, and stage drafts into UndineD via MCP STDIO
                   (never sends SMTP).
"""

from __future__ import annotations

import argparse
import fcntl
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

EXEMPT_LINE_PREFIXES = (
    "+++",
    "---",
    "Author:",
    "From:",
    "Signed-off-by:",
    "Reviewed-by:",
    "Acked-by:",
    "Co-developed-by:",
    "Reported-by:",
    "Tested-by:",
    "Suggested-by:",
)

SASHIKO_API_BASE = "https://sashiko.dev/api/patch"
SASHIKO_MIN_INTERVAL_SEC = 1.0
RATE_LOCK_PATH = Path("/tmp/kdev-sashiko-api.lock")


class RateLimitError(RuntimeError):
    """Raised when an upstream HTTP API responds with HTTP 429."""


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def rate_limit_wait(min_interval: float = SASHIKO_MIN_INTERVAL_SEC) -> None:
    """Cross-process file-lock rate limiter using monotonic timestamps."""
    RATE_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with RATE_LOCK_PATH.open("a+", encoding="utf-8") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        try:
            lf.seek(0)
            raw = lf.read().strip()
            last_ts = float(raw) if raw else 0.0
            now = time.monotonic()
            # Handle reboot/monotonic reset gracefully.
            if last_ts > now:
                last_ts = 0.0
            wait = min_interval - (now - last_ts)
            if wait > 0:
                time.sleep(wait)
            lf.seek(0)
            lf.truncate()
            lf.write(f"{time.monotonic():.6f}\n")
            lf.flush()
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def scan_text_non_ascii(
    text: str,
    source: str,
    strict: bool = False,
) -> list[dict[str, object]]:
    """Scan a diff or text stream for non-ASCII characters."""
    hits: list[dict[str, object]] = []
    commit = ""
    current_file = ""
    for lineno, line in enumerate(text.splitlines(), 1):
        if line.startswith("commit "):
            parts = line.split()
            if len(parts) >= 2:
                commit = parts[1][:12]
        elif line.startswith("diff --git "):
            m = re.search(r" b/(.+)$", line)
            current_file = m.group(1) if m else ""

        if not strict:
            if current_file.startswith("Documentation/translations/"):
                continue
            if line.lstrip().startswith(EXEMPT_LINE_PREFIXES):
                continue

        for col, ch in enumerate(line, 1):
            if ord(ch) > 127:
                hits.append(
                    {
                        "source": source,
                        "commit": commit,
                        "file": current_file,
                        "line": lineno,
                        "col": col,
                        "codepoint": f"U+{ord(ch):04X}",
                        "char": ch,
                        "text": line,
                    }
                )
    return hits


def cmd_check_ascii(args: argparse.Namespace) -> int:
    hits: list[dict[str, object]] = []

    if args.range:
        proc = subprocess.run(
            ["git", "-C", args.repo, "log", "--reverse", "-p", args.range],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            print(f"Error: git log failed: {proc.stderr.strip()}", file=sys.stderr)
            return 1
        hits.extend(scan_text_non_ascii(proc.stdout, f"git:{args.range}", strict=args.strict))

    if args.cover:
        cover_path = Path(args.cover)
        if not cover_path.is_file():
            print(f"Error: Cover letter file not found: {cover_path}", file=sys.stderr)
            return 1
        cover_text = cover_path.read_text(encoding="utf-8")
        hits.extend(scan_text_non_ascii(cover_text, str(cover_path), strict=True))

    report = {
        "repo": args.repo,
        "range": args.range,
        "cover": args.cover,
        "strict": args.strict,
        "non_ascii_count": len(hits),
        "hits": hits,
    }
    if args.output:
        write_json(Path(args.output), report)

    if hits:
        print(f"Found {len(hits)} non-ASCII character(s):", file=sys.stderr)
        for h in hits[:20]:
            loc = h["file"] or h["source"]
            print(
                f"  {h['commit']} {loc} line {h['line']} col {h['col']} "
                f"{h['codepoint']} {h['char']!r}: {h['text']}",
                file=sys.stderr,
            )
        if args.output:
            print(f"Full report written to: {args.output}")
        return 1

    msg = "OK: 0 non-ASCII characters found."
    if args.output:
        msg += f" Report written to: {args.output}"
    print(msg)
    return 0


def extract_message_id(id_or_url: str) -> str:
    raw = id_or_url.strip()
    m = re.search(r"/patchset/([^/?#]+)", raw)
    if m:
        return urllib.parse.unquote(m.group(1))
    return raw.strip("<>")


def fetch_json_with_retry(url: str, max_retries: int = 3) -> dict:
    backoff = 2.0
    for attempt in range(1, max_retries + 1):
        rate_limit_wait()
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "kdev-patch-series/1.0", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace").strip()
            if exc.code == 429:
                if attempt == max_retries:
                    raise RateLimitError(
                        f"HTTP 429 from {url} (rate limit {SASHIKO_MIN_INTERVAL_SEC}s/req): {body}"
                    ) from exc
                print(
                    f"[retry {attempt}/{max_retries}] HTTP 429 from {url}; sleeping {backoff:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(backoff)
                backoff *= 2
            elif 500 <= exc.code < 600 and attempt < max_retries:
                print(
                    f"[retry {attempt}/{max_retries}] HTTP {exc.code} from {url}; sleeping {backoff:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(backoff)
                backoff *= 2
            else:
                raise RuntimeError(
                    f"HTTP {exc.code} fetching {url}: {body or exc.reason}"
                ) from exc
        except urllib.error.URLError as exc:
            if attempt == max_retries:
                raise RuntimeError(f"Network error fetching {url}: {exc.reason}") from exc
            print(
                f"[retry {attempt}/{max_retries}] Network error ({exc.reason}); sleeping {backoff:.1f}s",
                file=sys.stderr,
            )
            time.sleep(backoff)
            backoff *= 2
    raise RuntimeError(f"Exhausted retries fetching {url}")


def cmd_fetch_sashiko(args: argparse.Namespace) -> int:
    msg_id = extract_message_id(args.target)
    encoded_id = urllib.parse.quote(msg_id, safe="")
    url = f"{SASHIKO_API_BASE}?id={encoded_id}"

    try:
        raw = fetch_json_with_retry(url)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    reviews_summary = []
    for rev in raw.get("reviews") or []:
        inline = rev.get("inline_review") or ""
        has_issues = bool(inline.strip()) and inline.strip() != "No issues found."
        reviews_summary.append(
            {
                "review_id": rev.get("id"),
                "patch_id": rev.get("patch_id"),
                "status": rev.get("status"),
                "result": rev.get("result"),
                "has_issues": has_issues,
                "inline_review": inline,
            }
        )

    output_data = {
        "message_id": msg_id,
        "api_url": url,
        "subject": raw.get("subject"),
        "status": raw.get("status"),
        "baseline": raw.get("baseline"),
        "patch_count": len(raw.get("patches") or []),
        "reviews": reviews_summary,
        "bugs": raw.get("bugs") or [],
    }
    out_path = Path(args.output)
    write_json(out_path, output_data)

    issue_reviews = sum(1 for r in reviews_summary if r["has_issues"])
    print(
        f"Fetched Sashiko review for {msg_id}: status={output_data['status']}, "
        f"patches={output_data['patch_count']}, reviews_with_issues={issue_reviews}. "
        f"Saved to: {out_path}"
    )
    return 0


def parse_formatted_patch(
    path: Path,
    index: int,
    is_cover: bool,
    cover_subject: str | None,
    cover_blurb: str | None,
    signature: str | None,
    v_note: str | None,
    version: int,
) -> dict[str, object]:
    raw = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    sep = raw.find("\n\n")
    hdr = raw[:sep] if sep >= 0 else raw
    body = raw[sep + 2 :] if sep >= 0 else ""

    lines = hdr.split("\n")
    commit_sha: str | None = None
    if lines:
        m = re.match(r"^From\s+([0-9a-f]{40})\s+", lines[0])
        if m and not re.match(r"^0+$", m.group(1)):
            commit_sha = m.group(1)

    subject = ""
    for i, line in enumerate(lines):
        if re.match(r"^Subject:\s*", line, re.I):
            subject = re.sub(r"^Subject:\s*", "", line, flags=re.I)
            j = i + 1
            while j < len(lines) and re.match(r"^[ \t]+", lines[j]):
                subject += " " + lines[j].strip()
                j += 1
            subject = subject.strip()
            break

    if is_cover:
        if cover_subject:
            subject = cover_subject
        if cover_blurb is not None:
            body = body.replace("*** BLURB HERE ***", cover_blurb, 1)
        if signature:
            body = re.sub(
                r"\n-- \n2\.\d+.*\n?$",
                f"\n-- \n{signature}\n",
                body,
            )
    elif v_note:
        marker = "\n---\n"
        pos = body.find(marker)
        if pos < 0:
            raise RuntimeError(f"Could not find '---' separator in {path}")
        note_block = v_note.rstrip("\n")
        if not note_block.startswith(f"Changes in v{version}:"):
            note_block = f"Changes in v{version}:\n{note_block}"
        body = body[: pos + len(marker)] + note_block + "\n\n" + body[pos + len(marker) :]

    msg: dict[str, object] = {
        "index": index,
        "is_cover_letter": is_cover,
        "subject": subject,
        "body": body,
    }
    if commit_sha and not is_cover:
        msg["commit_sha"] = commit_sha
    return msg


def resolve_git_signature(repo: str) -> str:
    name = subprocess.run(
        ["git", "-C", repo, "config", "user.name"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    email = subprocess.run(
        ["git", "-C", repo, "config", "user.email"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    if name and email:
        return f"{name} <{email}>"
    return email or name


def call_undined_stage(undined_bin: str, payload: dict[str, object]) -> dict:
    proc = subprocess.Popen(
        [undined_bin, "--mcp-stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None

    def rpc(req: dict[str, object]) -> dict | None:
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        if "id" in req:
            line = proc.stdout.readline()
            if not line:
                err = proc.stderr.read()
                raise RuntimeError(f"EOF from {undined_bin} --mcp-stdio: {err}")
            return json.loads(line)
        return None

    try:
        rpc(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "kdev-patch-series", "version": "1.0"},
                },
            }
        )
        rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
        resp = rpc(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "stage_patch_series",
                    "arguments": payload,
                },
            }
        )
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)

    assert resp is not None
    if "error" in resp or resp.get("result", {}).get("isError"):
        raise RuntimeError(f"UndineD stage_patch_series failed: {json.dumps(resp)}")
    return resp


def cmd_stage(args: argparse.Namespace) -> int:
    repo = args.repo
    base_sha = subprocess.check_output(
        ["git", "-C", repo, "rev-parse", "--verify", args.base],
        text=True,
    ).strip()

    branch = args.branch
    if not branch:
        branch = subprocess.check_output(
            ["git", "-C", repo, "symbolic-ref", "--short", "HEAD"],
            text=True,
        ).strip()

    staging_dir = Path(args.staging_dir)
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)

    fmt_cmd = [
        "git",
        "-C",
        repo,
        "format-patch",
        f"--base={base_sha}",
        f"--subject-prefix={args.subject_prefix}",
        "-o",
        str(staging_dir),
    ]
    if args.version > 1:
        fmt_cmd.extend(["-v", str(args.version)])
    if not args.no_cover:
        fmt_cmd.append("--cover-letter")
    fmt_cmd.append(f"{base_sha}..{args.head}")

    proc = subprocess.run(fmt_cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(f"Error: git format-patch failed: {proc.stderr.strip()}", file=sys.stderr)
        return 1

    cover_subject: str | None = None
    cover_blurb: str | None = None
    if args.cover:
        cover_raw = Path(args.cover).read_text(encoding="utf-8").replace("\r\n", "\n").strip()
        if "\n\n" not in cover_raw:
            print(
                "Error: Cover file must contain subject line, blank line, and body.",
                file=sys.stderr,
            )
            return 1
        cover_subject, cover_blurb = cover_raw.split("\n\n", 1)

    notes_map: dict[int, str] = {}
    if args.notes_json:
        raw_notes = json.loads(Path(args.notes_json).read_text(encoding="utf-8"))
        for k, v in raw_notes.items():
            notes_map[int(k)] = str(v)

    signature = args.signature if args.signature is not None else resolve_git_signature(repo)
    patch_files = sorted(Path(p) for p in glob.glob(str(staging_dir / "*.patch")))
    if not patch_files:
        print(f"Error: No patches generated for {base_sha}..{args.head}", file=sys.stderr)
        return 1

    messages: list[dict[str, object]] = []
    for pf in patch_files:
        is_cover = "0000-cover-letter" in pf.name
        m = re.search(r"(?:v\d+-)?(\d{4})-", pf.name)
        idx = int(m.group(1)) if m else len(messages)
        msg = parse_formatted_patch(
            pf,
            index=idx,
            is_cover=is_cover,
            cover_subject=cover_subject,
            cover_blurb=cover_blurb,
            signature=signature,
            v_note=notes_map.get(idx),
            version=args.version,
        )
        if not args.allow_non_ascii:
            non_ascii = scan_text_non_ascii(
                str(msg["subject"]) + "\n" + str(msg["body"]),
                pf.name,
                strict=False,
            )
            if non_ascii:
                print(
                    f"Error: Found {len(non_ascii)} non-ASCII char(s) in {pf.name} "
                    f"(first: {non_ascii[0]['codepoint']} at line {non_ascii[0]['line']}). "
                    "Fix before staging or pass --allow-non-ascii.",
                    file=sys.stderr,
                )
                return 1
        messages.append(msg)

    series_key = args.series_key or f"{branch}:v{args.version}"
    payload: dict[str, object] = {
        "series_key": series_key,
        "branch": branch,
        "version": args.version,
        "base_commit": base_sha,
        "replace_existing": bool(args.replace_existing),
        "to": args.to,
        "cc": args.cc or [],
        "messages": messages,
    }
    if args.in_reply_to:
        payload["in_reply_to"] = args.in_reply_to

    if args.dry_run:
        out_path = Path(args.output)
        write_json(out_path, payload)
        print(
            f"Dry-run OK: prepared {len(messages)} message(s) for {series_key}. "
            f"Payload written to: {out_path}"
        )
        return 0

    try:
        resp = call_undined_stage(args.undined_bin, payload)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    out_path = Path(args.output)
    write_json(out_path, resp)
    structured = (
        resp.get("result", {}).get("structuredContent", {}).get("result")
        or json.loads(resp["result"]["content"][0]["text"])
    )
    items = structured.get("items") or []
    draft_ids = [str(it.get("draft_id")) for it in items]
    print(
        f"Staged {series_key} ({len(items)} messages, draft_ids={draft_ids[0]}..{draft_ids[-1]}): "
        f"{structured.get('web_url')} | Output: {out_path}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Helper CLI for kdev-patch-series skill (check-ascii, fetch-sashiko, stage)."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ascii = sub.add_parser(
        "check-ascii",
        help="Scan git commits and/or cover letter for stray non-ASCII characters.",
    )
    p_ascii.add_argument("--repo", default="linux", help="Path to Linux git repo (default: linux).")
    p_ascii.add_argument("--range", help="Git revision range, e.g. BASE..HEAD.")
    p_ascii.add_argument("--cover", help="Optional cover letter markdown/text file.")
    p_ascii.add_argument("--strict", action="store_true", help="Do not exempt trailers or translations.")
    p_ascii.add_argument("--output", help="Optional JSON report output file path.")
    p_ascii.set_defaults(func=cmd_check_ascii)

    p_sashiko = sub.add_parser(
        "fetch-sashiko",
        help="Fetch public review findings from sashiko.dev JSON API (rate-limited).",
    )
    p_sashiko.add_argument(
        "target",
        help="sashiko.dev patchset URL or root Message-ID.",
    )
    p_sashiko.add_argument(
        "--output",
        required=True,
        help="Destination JSON file path for fetched review report.",
    )
    p_sashiko.set_defaults(func=cmd_fetch_sashiko)

    p_stage = sub.add_parser(
        "stage",
        help="Format patches, inject cover letter & Changes in vN:, and stage via UndineD MCP.",
    )
    p_stage.add_argument("--repo", default="linux", help="Path to Linux git repo (default: linux).")
    p_stage.add_argument("--base", required=True, help="Upstream base commit or ref.")
    p_stage.add_argument("--head", default="HEAD", help="Series tip ref (default: HEAD).")
    p_stage.add_argument("--branch", help="Source branch name (default: current branch).")
    p_stage.add_argument("--series-key", help="Logical series key (default: <branch>:v<version>).")
    p_stage.add_argument("--version", type=int, default=1, help="Series version number (default: 1).")
    p_stage.add_argument(
        "--subject-prefix",
        default="PATCH",
        help="Subject prefix, e.g. 'PATCH' or 'RFC PATCH' (default: PATCH).",
    )
    p_stage.add_argument("--cover", help="Cover letter file (line 1: subject, blank line, blurb).")
    p_stage.add_argument("--no-cover", action="store_true", help="Omit 0/N cover letter.")
    p_stage.add_argument(
        "--notes-json",
        help="JSON file mapping 1-based patch index to per-patch 'Changes in vN:' notes.",
    )
    p_stage.add_argument(
        "--to",
        action="append",
        required=True,
        help="To recipient (repeatable).",
    )
    p_stage.add_argument(
        "--cc",
        action="append",
        default=[],
        help="Cc recipient (repeatable).",
    )
    p_stage.add_argument("--in-reply-to", help="Optional external thread Message-ID.")
    p_stage.add_argument("--signature", help="Override cover letter signature line.")
    p_stage.add_argument(
        "--staging-dir",
        required=True,
        help="Directory outside linux/ to store git format-patch output.",
    )
    p_stage.add_argument(
        "--output",
        required=True,
        help="Destination JSON file path for staging result (or dry-run payload).",
    )
    p_stage.add_argument(
        "--replace-existing",
        action="store_true",
        help="Replace an existing unsent UndineD draft queue for series_key.",
    )
    p_stage.add_argument(
        "--allow-non-ascii",
        action="store_true",
        help="Allow non-ASCII characters in staged patch subjects/bodies.",
    )
    p_stage.add_argument(
        "--undined-bin",
        default="undined",
        help="Path or command name for undined binary (default: undined).",
    )
    p_stage.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and validate the JSON payload without calling undined.",
    )
    p_stage.set_defaults(func=cmd_stage)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
