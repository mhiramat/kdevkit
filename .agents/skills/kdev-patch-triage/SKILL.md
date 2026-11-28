---
name: kdev-patch-triage
description: >-
  Scan UndineD's TODO folder (Patchwork-assigned patches) via UndineD MCP,
  exclude self-authored patches, lightly inspect patch descriptions and thread
  context without applying patches to linux/, and triage each thread by
  applying priority/status color tags: P1 ($cl_1), P2 ($cl_2), P3 ($cl_3), or
  Done/Superseded ($cl_5). Uses UndineD MCP Phase 1-2 triage APIs
  (get_user_identity, list_tags, list_threads, get_thread_context with
  include_diff=false, update_email_tags). Use when asked to "triage TODO",
  "scan TODO folder", "tag patches with P1-P3", "classify incoming patches",
  or "triage patches in UndineD".
---

# Linux Kernel Patch Triage (`kdev-patch-triage`)

## Overview

This skill triages incoming Linux kernel patches in UndineD's `TODO` folder (which mirrors Patchwork-assigned patches) by reading commit descriptions, cover letters, trailers, diffstats, and cached thread replies—**without applying patches to `linux/`**—and tagging each patch series with UndineD color labels:

- **`$cl_1` (P1 — Urgent / Critical)**: Crashes, UAF, OOB, leaks, livelocks, security fixes, `Cc: stable` bugs in maintained subsystems.
- **`$cl_2` (P2 — Normal / Actionable)**: Functional bug fixes, KernelCI/selftest failures, design/API reviews, `v2+` revisions ready for review, arch-tree probe fixes needing maintainer feedback.
- **`$cl_3` (P3 — Low Priority)**: Documentation updates, non-functional cleanups/refactorings, early RFCs, minor test tweaks.
- **`$cl_5` (Done / Resolved / Superseded)**: Already picked/applied, explicitly superseded by a newer `vN+1` revision, rejected/withdrawn, or already completed with no further action required.

### Core Safety Invariants

1. **Description-Only Inspection (Never Touch `linux/`)**: Never run `git am`, `b4`, or modify `linux/` during triage. Judge priority strictly from email metadata, cover letters, commit logs, trailers, diffstats, and cached replies.
2. **Zero SMTP Transmission**: Never send email or draft replies unless the user explicitly asks.
3. **Zero Deletion / Zero Folder Move**: Never delete, expunge, or move messages out of `TODO`. Because `TODO` mirrors Patchwork assignments, mark completed or superseded threads with `$cl_5` instead of moving them.
4. **Local Cache Only (No On-Demand IMAP Fetch)**: `TODO` messages are locally cached via Patchwork. Never trigger bulk or on-demand IMAP `FETCH` for unhydrated replies in IMAP folders; when `body_hydrated: false` appears on a reply, surface it as a follow-up note in the triage report.
5. **Explicit Client-Side Tag Exclusion**: `update_email_tags` is a generic tag API without server-side mutual exclusion. Always pass both `add_tags` and `remove_tags` explicitly so `$cl_1`, `$cl_2`, `$cl_3`, and `$cl_5` never overlap on the same thread.
6. **Never Bypass MCP**: Never mutate UndineD's SQLite database or Maildir files directly. If the connected UndineD MCP server does not yet expose `update_email_tags`, fall back to a read-only triage report and clearly state which MCP tools are missing.

---

## UndineD MCP API Contract (Assumed Implemented)

This skill relies on the `undine` MCP server's Phase 1–2 triage extensions:

| Tool | Purpose | Key Arguments |
|---|---|---|
| `get_user_identity` | Resolve maintainer email addresses/aliases to exclude self-authored patches. | *(none)* |
| `list_tags` | Inspect configured color labels (`$cl_1`–`$cl_5`) and current counts in `TODO`. | `folder="TODO"` |
| `list_threads` | Paginated, series-grouped listing with author exclusion and tag filtering. | `folder`, `exclude_from=["self"]`, `patches_only=true`, `without_tags`, `limit`, `cursor` |
| `get_thread_context` | Lightweight thread inspection without raw diff hunks and without folder duplicates. | `message_id`, `include_diff=false`, `deduplicate=true` |
| `get_email` | Lightweight single-message inspection when needed. | `message_id`, `include_diff=false` |
| `update_email_tags` | Generic tag add/remove across a message or thread; defaults to all folder copies sharing the `Message-ID` (and queues IMAP sync for IMAP copies). | `message_ids`, `scope="thread"`, `add_tags`, `remove_tags`, `folder=null`, `dry_run` |

*Fallback note*: If `list_threads` is unavailable on an intermediate Phase 1 server, fall back to `list_recent_emails(folder="TODO", exclude_from=["self"], without_tags=[...], limit=100)` and group by thread client-side.

---

## Classification Criteria

Assign **exactly one** tag from `{ $cl_1, $cl_2, $cl_3, $cl_5 }` per thread:

### `$cl_1` — P1 (Critical / Urgent)
- Kernel crashes, oopses, panics, KASAN/UBSAN splats, slab-use-after-free (UAF), double-free, out-of-bounds (OOB) read/write, memory or slot leaks, deadlocks/livelocks/hangs.
- Security-relevant or unprivileged-reachable bugs (e.g., triggerable via user/net namespaces).
- Regressions with `Fixes:` / `Cc: stable@vger.kernel.org` in core subsystems directly maintained by the user (e.g., `kernel/trace/`, `kernel/kprobes.c`, `kernel/events/uprobes.c`, `lib/bootconfig.c`).

### `$cl_2` — P2 (Normal / Actionable)
- Non-crash functional bug fixes in kernel code, `tools/bootconfig/`, or `tools/testing/selftests/ftrace/`.
- Fixes for active CI / KernelCI / kselftest failures.
- New hooks, features, or performance changes touching core maintained files (e.g., `kernel/kprobes.c`, `kernel/events/uprobes.c`) that require design review.
- `v2+` patches submitted in direct response to the maintainer's earlier review feedback.
- Architecture-specific crash/bug fixes routed primarily through an arch maintainer's tree (e.g., `sparc64`, `riscv`, `arm64`) where cross-subsystem review is still pending.

### `$cl_3` — P3 (Low Priority)
- Documentation-only updates (`Documentation/`).
- Pure cleanups, style fixes, or refactorings with no functional change.
- Early `RFC` patches or isolated partial slices from large cross-subsystem RFCs not ready for pickup.
- Minor selftest ergonomics/polish without active CI breakage.

### `$cl_5` — Done / Resolved / Superseded
- Threads where the maintainer has already replied indicating pickup/merge (e.g., `"Let me pick it"`, `"Applied"`, `"Looks good, picked"`) with no subsequent regressions or open requests.
- Older patch versions (`v1` / `vN`) superseded by a newer revision (`vN+1`) already present in `TODO` or the same thread.
- Patches explicitly NACKed, withdrawn, or already completely signed off (`Reviewed-by:` / `Acked-by:` sent by the maintainer on an arch-tree patch with nothing left for this maintainer to merge).

> [!TIP]
> When a thread sits on the boundary between P1 and P2 (e.g., an arch-specific oops fix being merged by an arch maintainer, or an older bug fix with unhydrated discussion replies), pick the more conservative actionable priority and note the nuance in the summary table.

---

## 5-Step Triage Workflow

### Step 1: Preflight — Identity, Labels & Mode Selection

1. Call `get_user_identity()` and `list_tags(folder="TODO")` in parallel on the `undine` MCP server.
2. Determine the scan mode from the user's prompt:
   - **Incremental triage (default)**: Scan only untriaged threads by passing `without_tags: ["$cl_1", "$cl_2", "$cl_3", "$cl_5"]`.
   - **Full re-triage**: Triggered when the user asks to re-scan or re-triage all patches in `TODO`; omit `without_tags`.
   - **Dry-run preview**: Triggered when the user asks to preview classifications before tagging; pass `dry_run: true` to `update_email_tags` (or wait for approval before Step 4).
3. Target folder defaults to `"TODO"` unless the user specifies another folder.

### Step 2: Discover Non-Self Patch Threads

1. Call `list_threads` in a pagination loop until `next_cursor` is `null`:
   ```json
   {
     "folder": "TODO",
     "limit": 100,
     "cursor": null,
     "exclude_from": ["self"],
     "patches_only": true,
     "without_tags": ["$cl_1", "$cl_2", "$cl_3", "$cl_5"],
     "sort": "latest_date_desc"
   }
   ```
2. Record total thread count and check across the returned list for:
   - **Cross-thread version pairs** (e.g., `[PATCH 01/13]` and `[PATCHv2 1/2]` by the same author on the same topic) so superseded earlier versions can be marked `$cl_5`.
   - **Self-authored patches under a synthetic root sender**: verify actual patch authors during Step 3 in case a cover letter has a malformed/synthetic `From` address (e.g., `None@smtp.subspace.kernel.org`) that bypasses root-author `exclude_from: ["self"]`.

### Step 3: Lightweight Thread Inspection (No Raw Diffs)

1. Batch `get_thread_context` calls in parallel for the discovered threads (using `root_message_id` or the first ID in `folder_message_ids`):
   ```json
   {
     "message_id": "<root_or_patch_id>",
     "include_diff": false,
     "deduplicate": true
   }
   ```
2. For each thread, inspect:
   - Cover letter (`0/N`) and patch commit descriptions
   - Trailers (`Fixes:`, `Cc: stable`, `Reported-by:`, `Reviewed-by:`, `Acked-by:`)
   - Diffstat (target files/subsystems and change size)
   - Cached replies (maintainer pickup/review comments, Sashiko AI findings, follow-up pings)
   - Any replies with `body_hydrated: false`: record `(sender, date, id)` so the user knows an uncached IMAP reply exists.
3. Do **not** fetch full diffs (`include_diff: true`) unless a patch's commit message is completely ambiguous and checking a small diff clarifies severity.

### Step 4: Apply Priority / Status Tags (`update_email_tags`)

Group threads by target tag (`$cl_1`, `$cl_2`, `$cl_3`, `$cl_5`) and issue **one batched `update_email_tags` call per tag bucket** (respecting the 100-ID limit per call):

- **P1 (`$cl_1`)**:
  ```json
  {
    "message_ids": ["<id1>", "<id2>"],
    "scope": "thread",
    "add_tags": ["$cl_1"],
    "remove_tags": ["$cl_2", "$cl_3", "$cl_5"],
    "dry_run": false
  }
  ```
- **P2 (`$cl_2`)**: `add_tags: ["$cl_2"]`, `remove_tags: ["$cl_1", "$cl_3", "$cl_5"]`
- **P3 (`$cl_3`)**: `add_tags: ["$cl_3"]`, `remove_tags: ["$cl_1", "$cl_2", "$cl_5"]`
- **Done / Superseded (`$cl_5`)**: `add_tags: ["$cl_5"]`, `remove_tags: ["$cl_1", "$cl_2", "$cl_3"]`

Key parameter rules:
- Leave `folder` unset (`null`, default) so tags propagate to **all folder copies sharing the same `Message-ID`** (e.g., `TODO` and `kernel.org/mhiramat`, automatically queuing IMAP sync for IMAP copies). Only set `folder: "TODO"` if the user explicitly asks for folder-local tagging.
- **Mixed-version threads**: If a `v2` patch was sent in reply to `v1` and both reside in the same thread in `TODO`, use `scope: "message"` on each ID individually (`$cl_5` on the superseded `v1`, `$cl_1`–`$cl_3` on the active `v2`) instead of `scope: "thread"`.
- Check each response for `not_found` entries and report `updated_count` / `imap_sync_queued_count`.

### Step 5: Present Concise Triage Report

Output a concise summary organized into four sections—**P1 (`$cl_1`)**, **P2 (`$cl_2`)**, **P3 (`$cl_3`)**, and **Done / Superseded (`$cl_5`)**—containing:

- Counts: total scanned threads, excluded self-authored count, skipped already-tagged count, newly tagged counts per bucket, and IMAP sync queue count.
- Per-bucket Markdown table: `DB ID(s)` | `Date` | `Author` | `Subject & Rationale` (1–2 lines explaining severity, trailers, and current thread status).
- **Unhydrated Replies Callout**: Explicitly list any P1/P2 threads that had `body_hydrated: false` replies (e.g., from co-maintainers) so the user can check them in UndineD Web UI.

---

## Common Mistakes

1. **Forgetting `remove_tags`**: Adding `$cl_1` or `$cl_5` without removing the other `$cl_*` tags leaves multiple conflicting priority labels on the same thread.
2. **Omitting `include_diff: false`**: Downloading full raw diffs for multi-patch series wastes context tokens and slows down triage.
3. **Restricting `folder: "TODO"` by default**: Prevents tag propagation to the matching `Message-ID` copy in IMAP folders; leave `folder` unset (`null`) unless explicitly asked otherwise.
4. **Missing superseded `v1` series**: Failing to compare subjects/authors across threads in `TODO` can leave an obsolete `v1` tagged P1/P2 instead of `$cl_5`.
5. **Silently ignoring `body_hydrated: false` replies**: Unhydrated replies in IMAP folders may contain a co-maintainer's Ack/NACK or merge notice—always mention them in the report.
6. **Applying patches or editing `linux/`**: Triage is strictly read-only with respect to the kernel tree.
7. **Trying to move or delete emails**: `TODO` mirrors Patchwork assignments; mark finished items with `$cl_5` instead.
