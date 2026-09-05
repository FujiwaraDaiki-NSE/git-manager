"""プロジェクト管制画面向けの Git 事実集約。

このモジュールは Git から観測できる値だけを返す。agent、PR、CI、合流先や
次工程はここで推測しないため、呼び出し側が渡さない限り常に ``None`` になる。
コミットの patch は取得せず、詳細 API は従来の ``/api/repo/commit`` に任せる。
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Mapping

from app import agent_events, detail, gitinfo, graph, paths, scanner

MAX_PROJECT_COMMITS = 200
README_MAX_CHARS = 280
PROJECT_RANGES = {"current", "24h", "7d", "all"}
_COMMIT_HASH_LINE = re.compile(r"^[0-9a-fA-F]{40}$")


def _key(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _iso_epoch(value: Any) -> float | None:
    """Parse an ISO timestamp as an absolute epoch only when it has an offset."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc).timestamp()


def _commit_metadata(repo: str, commit_hash: str | None) -> dict[str, Any] | None:
    if not commit_hash:
        return None
    raw = gitinfo._run(
        repo,
        ["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI", commit_hash],
    )
    if not raw:
        return None
    fields = raw.rstrip("\n").split("\x1f")
    if len(fields) != 5 or not fields[0] or not fields[1] or not fields[4]:
        return None
    return {
        "hash": fields[0],
        "short": fields[1],
        "subject": fields[2],
        "author": fields[3],
        "date": fields[4],
    }


def _commit_stats(repo: str, commit_hash: str | None) -> dict[str, Any] | None:
    """Return lightweight numstat facts without loading a patch/diff body."""
    if not commit_hash:
        return None
    raw = gitinfo._run(
        repo,
        [
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "--format=",
            commit_hash,
        ],
    )
    if raw is None:
        return None
    files = 0
    additions = 0
    deletions = 0
    paths: list[str] = []
    unknown_additions = False
    unknown_deletions = False
    for line in raw.splitlines():
        fields = line.split("\t", 2)
        if len(fields) != 3:
            continue
        added, deleted, path = fields
        files += 1
        if len(paths) < 3:
            paths.append(path)
        if added.isdecimal():
            additions += int(added)
        else:
            unknown_additions = True
        if deleted.isdecimal():
            deletions += int(deleted)
        else:
            unknown_deletions = True
    return {
        "files": files,
        "additions": None if unknown_additions else additions,
        "deletions": None if unknown_deletions else deletions,
        "paths": paths,
    }


def _commit_stats_many(repo: str, commit_hashes: list[str]) -> dict[str, dict[str, Any] | None]:
    """Fetch numstat for the requested commits with one bounded Git process.

    The project endpoint needs lightweight hover data, but it must not start a
    separate ``git show`` process for every graph row.  A single multi-object
    ``git show`` keeps the initial request bounded while retaining exact
    per-commit facts.  Empty or failed output stays explicitly unavailable.
    """
    hashes = [value for value in dict.fromkeys(commit_hashes) if _COMMIT_HASH_LINE.fullmatch(value)]
    result: dict[str, dict[str, Any] | None] = {value: None for value in hashes}
    if not hashes:
        return result
    raw = gitinfo._run(
        repo,
        [
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "--format=%H",
            *hashes,
        ],
    )
    if raw is None:
        return result
    current: str | None = None
    by_hash: dict[str, dict[str, Any]] = {}
    for line in raw.splitlines():
        if _COMMIT_HASH_LINE.fullmatch(line) and line in result:
            current = line
            by_hash[current] = {"files": 0, "additions": 0, "deletions": 0, "paths": []}
            continue
        if current is None:
            continue
        fields = line.split("\t", 2)
        if len(fields) != 3:
            continue
        added, deleted, path = fields
        entry = by_hash[current]
        entry["files"] += 1
        if len(entry["paths"]) < 3:
            entry["paths"].append(path)
        if added.isdecimal() and entry["additions"] is not None:
            entry["additions"] += int(added)
        elif not added.isdecimal():
            entry["additions"] = None
        if deleted.isdecimal():
            if entry["deletions"] is not None:
                entry["deletions"] += int(deleted)
        else:
            entry["deletions"] = None
    result.update(by_hash)
    return result


def _count_against_default(
    repo: str,
    default_ref: str | None,
    branch_ref: str,
) -> tuple[int | None, int | None]:
    """Return ahead/behind relative to the explicit default ref.

    There is deliberately no local ``main``/``master`` fallback. If Git cannot
    identify the default branch, both values stay ``None`` in the response.
    """
    if not default_ref:
        return None, None
    raw = gitinfo._run(repo, ["rev-list", "--left-right", "--count", f"{default_ref}...{branch_ref}"])
    if not raw:
        return None, None
    parts = raw.split()
    if len(parts) != 2 or not all(part.isdecimal() for part in parts):
        return None, None
    # left is default-only (behind), right is branch-only (ahead).
    return int(parts[1]), int(parts[0])


def _merge_base(repo: str, default_ref: str | None, branch_ref: str) -> str | None:
    if not default_ref:
        return None
    raw = gitinfo._run(repo, ["merge-base", default_ref, branch_ref])
    return raw.strip() if raw and raw.strip() else None


def _ref_hash(repo: str, ref: str) -> str | None:
    """Resolve a local/ref name to its full Git object id when available."""
    raw = gitinfo._run(repo, ["rev-parse", "--verify", "--quiet", ref])
    value = raw.strip() if raw else ""
    return value or None


def _readme_description(repo: str) -> str | None:
    """Read only the conventional README.md; missing/empty means unavailable."""
    readme = os.path.join(repo, "README.md")
    try:
        with open(readme, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    paragraphs: list[str] = []
    current: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            continue
        if line.startswith("#") and not current:
            continue
        current.append(line)
    if current:
        paragraphs.append(" ".join(current))
    if not paragraphs:
        return None
    value = paragraphs[0].strip()
    if not value:
        return None
    if len(value) > README_MAX_CHARS:
        return f"{value[:README_MAX_CHARS - 1].rstrip()}…"
    return value


def _repo_status(row: Mapping[str, Any] | None) -> dict[str, Any]:
    """Copy status facts from the existing snapshot without inventing values."""
    if row is None:
        return {
            "dirty": None,
            "conflict": None,
            "upstream": None,
            "upstream_ahead": None,
            "upstream_behind": None,
            "detached": None,
            "branch_line": None,
            "next_command": None,
            "error": "未取得",
        }
    entries = row.get("entries")
    dirty = len(entries) > 0 if isinstance(entries, list) else None
    conflict_codes = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
    conflict = (
        any(isinstance(entry, dict) and entry.get("xy") in conflict_codes for entry in entries)
        if isinstance(entries, list)
        else None
    )
    return {
        "dirty": dirty,
        "conflict": conflict,
        "upstream": row.get("upstream"),
        "upstream_ahead": row.get("ahead"),
        "upstream_behind": row.get("behind"),
        "detached": row.get("detached"),
        "branch_line": row.get("branch_line") or None,
        "next_command": row.get("next_command"),
        "error": row.get("error"),
    }


def _worktree_rows(
    repo: str,
    project_id: str,
    state_rows: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], str]:
    """Return Git worktrees and lookup maps, preserving prunable/locked rows."""
    raw = gitinfo.list_worktrees(repo) or []
    result: list[dict[str, Any]] = []
    by_branch: dict[str, dict[str, Any]] = {}
    by_path: dict[str, dict[str, Any]] = {}
    for item in raw:
        raw_path = item.get("path")
        if not raw_path:
            continue
        container_path = os.path.abspath(str(raw_path))
        host_path = paths.to_host(container_path)
        if item.get("administrative_candidate") is True:
            # An administration directory is not a checkout. A matching state
            # row is the only explicit evidence that it is a real main path.
            candidate = state_rows.get(host_path)
            if not candidate or candidate.get("is_worktree") is not False:
                continue
        record = {
            "path": host_path,
            "branch": item.get("branch"),
            "head": item.get("head"),
            "state": item.get("state"),
            "detached": bool(item.get("detached", False)),
            "is_main": _key(host_path) == _key(project_id),
        }
        result.append(record)
        by_path[_key(host_path)] = record
        branch = record.get("branch")
        if isinstance(branch, str) and branch:
            by_branch[branch] = record

    # ``project_id`` is normally the main checkout. If it is outside the scan,
    # keep the concrete selected checkout as the API's main path.
    main_path = next(
        (row["path"] for row in result if row["is_main"]),
        next((row["path"] for row in result if row.get("state") not in {"prunable", "locked"}), project_id),
    )
    return result, by_branch, main_path


def _lane_status(
    branch: Mapping[str, Any],
    worktree: Mapping[str, Any] | None,
    state_rows: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    path = worktree.get("path") if worktree else branch.get("worktree")
    row = state_rows.get(str(path)) if isinstance(path, str) else None
    status = _repo_status(row)
    # A local branch that is not checked out has no Repo snapshot.  Its
    # upstream and tracking counts are nevertheless concrete facts from
    # ``for-each-ref`` and must not disappear just because there is no
    # worktree row to join.
    branch_upstream = branch.get("upstream")
    branch_track = branch.get("track")
    if row is None:
        status["upstream"] = branch_upstream
        status["upstream_ahead"], status["upstream_behind"] = _parse_track(branch_track)
    else:
        status["upstream"] = status["upstream"] or branch_upstream
        if status["upstream_ahead"] is None or status["upstream_behind"] is None:
            tracked_ahead, tracked_behind = _parse_track(branch_track)
            if tracked_ahead is not None and tracked_behind is not None:
                status["upstream_ahead"] = tracked_ahead
                status["upstream_behind"] = tracked_behind
    return {
        **status,
        "path": path,
        "worktree_state": worktree.get("state") if worktree else None,
        "worktree": path if worktree else None,
    }


def _agent_counts(snapshots: list[Mapping[str, Any]]) -> dict[str, int | None]:
    """Count explicit agent projections; no snapshot means unavailable."""
    if not snapshots:
        return {
            "running": None,
            "waiting_for_user": None,
            "problem": None,
            "reviewing": None,
            "integratable": None,
        }
    categories = _agent_priority_categories(snapshots)
    return {
        "running": categories["active"],
        "waiting_for_user": categories["waiting_for_user"],
        "problem": categories["blocked"],
        "reviewing": categories["review_required"],
        "integratable": categories["merge_ready"],
    }


def _agent_priority_categories(snapshots: list[Mapping[str, Any]]) -> dict[str, int | None]:
    """Classify each task into exactly one explicit priority bucket."""
    if not snapshots:
        return {name: None for name in ("waiting_for_user", "blocked", "review_required", "merge_ready", "active", "completed")}
    result = {name: 0 for name in ("waiting_for_user", "blocked", "review_required", "merge_ready", "active", "completed")}
    for item in snapshots:
        attention = item.get("attention")
        if attention in {"waiting_for_user", "blocked", "review_required", "merge_ready"}:
            result[attention] += 1
        elif item.get("run_state") == "active":
            result["active"] += 1
        elif item.get("outcome") == "completed":
            result["completed"] += 1
    return result


def _parse_track(track: str | None) -> tuple[int | None, int | None]:
    """Parse Git's explicit ``[ahead N, behind M]`` tracking fact."""
    if not track:
        return None, None
    if track.strip() == "[up to date]":
        return 0, 0
    ahead_match = re.search(r"ahead (\d+)", track)
    behind_match = re.search(r"behind (\d+)", track)
    if ahead_match is None and behind_match is None:
        # ``[up to date]`` and ``[gone]`` do not expose counts.
        return None, None
    return (
        int(ahead_match.group(1)) if ahead_match else 0,
        int(behind_match.group(1)) if behind_match else 0,
    )


def _event_from_row(
    row: Mapping[str, Any],
    lane_names: list[str],
    observed_at: float,
) -> dict[str, Any]:
    hash_value = str(row.get("hash"))
    return {
        "id": f"commit:{hash_value}",
        "occurred_at": row.get("date"),
        "observed_at": observed_at,
        "type": "commit",
        "source": "git",
        "project_id": None,
        "worktree": None,
        "branch": lane_names[0] if lane_names else None,
        "lane_id": f"branch:{lane_names[0]}" if lane_names else None,
        "lane_names": lane_names,
        "commit_hash": hash_value,
        "subject": row.get("subject") or "",
        "author": row.get("author") or "",
        "parents": row.get("parents") or [],
        "stats": row.get("stats"),
    }


def build(
    repo: str,
    project_id: str,
    state_rows: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    limit: int = MAX_PROJECT_COMMITS,
    range_name: str = "current",
    as_of: datetime | None = None,
) -> dict[str, Any] | None:
    """Build the project control payload from one concrete Git checkout."""
    if range_name not in PROJECT_RANGES:
        raise ValueError(f"unknown project range: {range_name}")
    state_rows = state_rows or {}
    # State keys are host paths. Keep a normalized lookup for callers that
    # supplied equivalent path spellings.
    normalized_state: dict[str, Mapping[str, Any]] = {
        _key(path): row for path, row in state_rows.items()
    }

    layout = scanner.repo_layout(repo)
    common_host = paths.to_host(layout.common_root) if layout is not None else project_id
    # Include exact and normalized keys. This is deliberately a lookup, not a
    # value fallback: unavailable fields remain None in _repo_status.
    exact_rows = dict(state_rows)
    for path, row in normalized_state.items():
        exact_rows.setdefault(path, row)

    agent_snapshots = agent_events.snapshots(project_id=project_id, state=state_rows, as_of=as_of)
    agent_history = agent_events.project_events(project_id, state=state_rows, as_of=as_of)

    worktrees, worktree_by_branch, main_path = _worktree_rows(repo, common_host, exact_rows)
    branch_data = detail.get_branches(repo)
    if branch_data is None:
        # Branch facts are required to build a trustworthy lane register. Do
        # not turn an acquisition failure into an empty project (or a false
        # zero-lane result); let the API surface the unavailable project.
        return None
    local = branch_data.get("local")
    remotes = branch_data.get("remotes")
    if not isinstance(local, list) or not isinstance(remotes, list):
        return None

    default_branch = gitinfo.default_branch(repo)
    default_ref = f"refs/remotes/origin/{default_branch}" if default_branch else None
    default_hash = _ref_hash(repo, default_ref) if default_ref else None

    lanes: list[dict[str, Any]] = []
    branch_heads: dict[str, str] = {}
    for branch in local:
        name = branch.get("name")
        if not isinstance(name, str) or not name:
            continue
        worktree = worktree_by_branch.get(name)
        branch_ref = f"refs/heads/{name}"
        # detail.get_branches intentionally returns a short hash for the
        # existing branch UI. Resolve the same ref here so graph ancestry can
        # join it to graph rows without treating an abbreviated value as a
        # different commit.
        head = _ref_hash(repo, branch_ref)
        if head is None and isinstance(branch.get("hash"), str):
            head = branch["hash"]
        branch_heads[name] = head or ""
        ahead, behind = _count_against_default(repo, default_ref, branch_ref)
        base = _merge_base(repo, default_ref, branch_ref)
        commit = _commit_metadata(repo, head if isinstance(head, str) else None)
        status = _lane_status(branch, worktree, exact_rows)
        lane_id = f"branch:{name}"
        lanes.append(
            {
                "id": lane_id,
                "name": name,
                "branch": name,
                "path": status["path"],
                "is_worktree": worktree is not None,
                "worktree_state": status["worktree_state"],
                "head": head,
                "merge_base": base,
                "default_ahead": ahead,
                "default_behind": behind,
                "merged": branch.get("merged"),
                "dirty": status["dirty"],
                "conflict": status["conflict"],
                "detached": status["detached"],
                "upstream": status["upstream"],
                "upstream_ahead": status["upstream_ahead"],
                "upstream_behind": status["upstream_behind"],
                "branch_line": status["branch_line"],
                "last_commit": commit,
                "next_command": status["next_command"],
                "error": status["error"],
                "agent": agent_snapshots.get(status["path"]) if isinstance(status.get("path"), str) else None,
                "merge_target": None,
                "next_phase": None,
            }
        )

    known_worktree_paths = {
        _key(lane["path"])
        for lane in lanes
        if isinstance(lane.get("path"), str)
    }
    # Detached linked worktrees have no local branch row but are still Git
    # work lanes. Include them with an explicit null branch.
    for worktree in worktrees:
        if _key(worktree["path"]) in known_worktree_paths:
            continue
        path = worktree["path"]
        state_row = exact_rows.get(path)
        if state_row is None:
            state_row = normalized_state.get(_key(path))
        status = _repo_status(state_row)
        head = worktree.get("head")
        ahead, behind = _count_against_default(repo, default_ref, head) if head else (None, None)
        base = _merge_base(repo, default_ref, head) if head else None
        commit = _commit_metadata(repo, head)
        lanes.append(
            {
                "id": f"worktree:{path}",
                "name": "detached HEAD",
                "branch": None,
                "path": path,
                "is_worktree": not worktree.get("is_main", False),
                "worktree_state": worktree.get("state"),
                "head": head,
                "merge_base": base,
                "default_ahead": ahead,
                "default_behind": behind,
                "merged": None,
                "dirty": status["dirty"],
                "conflict": status["conflict"],
                "detached": True,
                "upstream": status["upstream"],
                "upstream_ahead": status["upstream_ahead"],
                "upstream_behind": status["upstream_behind"],
                "branch_line": status["branch_line"],
                "last_commit": commit,
                "next_command": status["next_command"],
                "error": status["error"],
                "agent": agent_snapshots.get(path),
                "merge_target": None,
                "next_phase": None,
            }
        )
        known_worktree_paths.add(_key(path))

    # A project can have no local branch refs but still expose an empty graph.
    graph_data = graph.build(repo, all_refs=True, limit=limit)
    observed_at = time.time()
    events: list[dict[str, Any]] = []
    known_events: list[dict[str, Any]] = []
    latest_event: dict[str, Any] | None = None
    if graph_data is not None:
        parents_by_hash = {
            row.get("hash"): row.get("parents") or []
            for row in graph_data.get("rows", [])
            if isinstance(row.get("hash"), str)
        }
        lane_hashes: dict[str, set[str]] = {}
        for lane in lanes:
            head = lane.get("head")
            if not isinstance(head, str) or not head:
                continue
            pending = [head]
            seen: set[str] = set()
            while pending:
                current = pending.pop()
                if current in seen or current not in parents_by_hash:
                    continue
                seen.add(current)
                pending.extend(
                    parent
                    for parent in parents_by_hash[current]
                    if isinstance(parent, str)
                )
            lane_hashes[lane["id"]] = seen
        graph_rows = graph_data.get("rows", [])
        head_hashes = {
            lane.get("head")
            for lane in lanes
            if isinstance(lane.get("head"), str) and lane.get("head")
        }
        range_cutoff = (
            observed_at - 86_400
            if range_name == "24h"
            else observed_at - 604_800
            if range_name == "7d"
            else None
        )

        def in_range(row: Mapping[str, Any]) -> bool:
            if range_name == "current":
                return row.get("hash") in head_hashes
            if range_cutoff is None:
                return True
            date = row.get("date")
            if not isinstance(date, str):
                return False
            occurred = _iso_epoch(date)
            if occurred is None:
                return False
            return occurred >= range_cutoff

        visible_hashes = {
            row.get("hash")
            for row in graph_rows
            if isinstance(row.get("hash"), str) and in_range(row)
        }
        stats_by_hash = _commit_stats_many(
            repo,
            [str(row.get("hash")) for row in graph_rows if row.get("hash") in visible_hashes],
        )
        for row in graph_rows:
            # Graph rows are intentionally metadata-only; numstat is the
            # bounded summary needed by a hover card, while the existing
            # commit endpoint remains the sole source of full patch data.
            hash_value = row.get("hash")
            row["stats"] = stats_by_hash.get(hash_value) if hash_value in visible_hashes else None
            names = [
                lane["branch"]
                for lane in lanes
                if isinstance(lane.get("branch"), str)
                and row.get("hash") in lane_hashes.get(lane["id"], set())
            ]
            event = _event_from_row(row, names, observed_at)
            event["project_id"] = project_id
            # Keep the latest Git fact independent from the requested display
            # range. The range limits event cards/map points, while the
            # project header must retain the last known commit even when the
            # selected window contains no events.
            known_events.append(event)
            if in_range(row):
                events.append(event)

    latest_event = max(
        (event for event in known_events if _iso_epoch(event.get("occurred_at")) is not None),
        key=lambda event: _iso_epoch(event.get("occurred_at")),
        default=None,
    )
    merged_count = sum(
        1
        for lane in lanes
        if lane.get("merged") is True
        and (default_branch is None or lane.get("branch") != default_branch)
    )
    prunable_count = sum(1 for item in worktrees if item.get("state") == "prunable")
    locked_count = sum(1 for item in worktrees if item.get("state") == "locked")
    main_row = exact_rows.get(main_path) or normalized_state.get(_key(main_path))
    fetched_at = main_row.get("fetched_at") if main_row else None

    agent_history.sort(key=lambda event: (_iso_epoch(event.get("occurred_at")) or 0, event.get("sequence", 0)))
    agent_latest_event = agent_history[-1] if agent_history else None
    # The activity feed contains both explicit agent events and Git facts. The
    # legacy latest_event field remains the latest Git commit for compatibility.
    events.extend(agent_history)
    events.sort(key=lambda event: (_iso_epoch(event.get("occurred_at")) or 0, event.get("sequence", 0)))
    agent_counts = _agent_counts(list(agent_snapshots.values()))
    agent_priority_counts = _agent_priority_categories(list(agent_snapshots.values()))
    return {
        "id": project_id,
        "name": os.path.basename(project_id.rstrip("/")) or project_id,
        "description": _readme_description(repo),
        "remote": (main_row or {}).get("remote") if main_row else None,
        "default_branch": default_branch,
        "default_hash": default_hash,
        "main_path": main_path,
        "fetched_at": fetched_at,
        "observed_at": observed_at,
        "range": range_name,
        "graph": graph_data,
        "lanes": lanes,
        "events": events,
        "latest_event": latest_event,
        "agent_events": agent_history,
        "agent_latest_event": agent_latest_event,
        "agent_snapshots": list(agent_snapshots.values()),
        "branch_counts": {"local": len(local), "remote": len(remotes)},
        "worktrees": worktrees,
        "maintenance": {
            "merged": merged_count,
            "prunable": prunable_count,
            "locked": locked_count,
        },
        # Metadata not observed from Git / Phase 2 / Phase 3 remains explicit.
        "languages": None,
        "directories": None,
        "test_commands": None,
        "agent_tasks": sorted(list(agent_snapshots.values()), key=lambda item: (item.get("worktree") or "", item.get("task_id") or "")) or None,
        "agent_counts": agent_counts,
        "agent_priority_counts": agent_priority_counts,
        "ci": None,
        "reviews": None,
        "merge_target": None,
    }


def summary_rows(state: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Build fast home cards from the existing Git snapshot only."""
    groups: dict[str, list[Mapping[str, Any]]] = {}
    for row in state.values():
        common = row.get("common_dir")
        if not isinstance(common, str) or not common:
            continue
        groups.setdefault(common, []).append(row)

    summaries: list[dict[str, Any]] = []
    for project_id, rows in groups.items():
        agent_snapshots = agent_events.snapshots(project_id=project_id, state=state)
        snapshot_values = list(agent_snapshots.values())
        agent_counts = _agent_counts(snapshot_values)
        agent_priority_counts = _agent_priority_categories(snapshot_values)
        agent_history = agent_events.project_events(project_id, state=state)
        agent_history.sort(key=lambda event: (_iso_epoch(event.get("occurred_at")) or 0, event.get("sequence", 0)))
        latest_agent = agent_history[-1] if agent_history else None
        main = next((row for row in rows if row.get("is_worktree") is False), rows[0])
        commits = [
            row.get("last_commit")
            for row in rows
            if isinstance(row.get("last_commit"), dict)
            and isinstance(row.get("last_commit", {}).get("date"), str)
        ]
        latest = max(
            (commit for commit in commits if _iso_epoch(commit.get("date")) is not None),
            key=lambda commit: _iso_epoch(commit.get("date")),
            default=None,
        )
        conflicts = sum(
            1
            for row in rows
            if any(
                isinstance(entry, dict)
                and entry.get("xy") in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
                for entry in (row.get("entries") or [])
            )
        )
        dirty = sum(1 for row in rows if isinstance(row.get("entries"), list) and row["entries"])
        ahead = sum(1 for row in rows if isinstance(row.get("ahead"), int) and row["ahead"] > 0)
        behind = sum(1 for row in rows if isinstance(row.get("behind"), int) and row["behind"] > 0)
        attention_row = next(
            (
                row
                for row in rows
                if any(
                    isinstance(entry, dict)
                    and entry.get("xy") in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
                    for entry in (row.get("entries") or [])
                )
                or (isinstance(row.get("entries"), list) and bool(row["entries"]))
                or (isinstance(row.get("behind"), int) and row["behind"] > 0)
                or (isinstance(row.get("ahead"), int) and row["ahead"] > 0)
            ),
            None,
        )
        next_lane = (
            attention_row.get("branch")
            or attention_row.get("path")
            if attention_row
            else None
        )
        merged = len(main.get("merged_branches") or []) + sum(
            1 for row in rows if row.get("is_worktree") and row.get("merged")
        )
        prunable = sum(1 for row in rows if row.get("worktree_state") == "prunable")
        locked = sum(1 for row in rows if row.get("worktree_state") == "locked")
        lane_count: int | None = None
        checkout = main.get("path") if isinstance(main.get("path"), str) else None
        if checkout:
            branch_data = detail.get_branches(paths.to_container(checkout))
            if branch_data is not None:
                local_branches = branch_data.get("local")
                if isinstance(local_branches, list):
                    lane_count = len(local_branches)
        largest_difference_lane: str | None = None
        largest_difference = -1
        if checkout:
            repo = paths.to_container(checkout)
            default_branch = gitinfo.default_branch(repo)
            default_ref = f"refs/remotes/origin/{default_branch}" if default_branch else None
            if default_ref:
                for row in rows:
                    branch = row.get("branch")
                    if not isinstance(branch, str) or not branch or branch == default_branch:
                        continue
                    ahead_count, behind_count = _count_against_default(
                        repo,
                        default_ref,
                        f"refs/heads/{branch}",
                    )
                    if ahead_count is None or behind_count is None:
                        continue
                    difference = ahead_count + behind_count
                    if difference > largest_difference:
                        largest_difference = difference
                        largest_difference_lane = branch
        # Explicit agent attention has priority over Git maintenance facts.
        attention_priority = {
            "waiting_for_user": 0,
            "blocked": 1,
            "review_required": 2,
            "merge_ready": 3,
        }
        explicit_priorities = [
            attention_priority[item.get("attention")]
            for item in snapshot_values
            if item.get("attention") in attention_priority
        ]
        active_agents = any(item.get("run_state") == "active" for item in snapshot_values)
        completed_agents = bool(snapshot_values) and all(item.get("outcome") == "completed" for item in snapshot_values)
        issue_rank = (
            min(explicit_priorities)
            if explicit_priorities
            else 4
            if active_agents
            else 5
            if completed_agents
            else 6
            if snapshot_values
            else 0 if conflicts else 1 if dirty else 2 if behind else 3
        )
        latest_summary = latest_agent.get("summary") if latest_agent else None
        agent_state = None
        if snapshot_values:
            state_order = ("waiting_for_user", "blocked", "review_required", "merge_ready")
            agent_state = next((value for value in state_order if any(item.get("attention") == value for item in snapshot_values)), None)
            if agent_state is None and active_agents:
                agent_state = "active"
            elif agent_state is None and completed_agents:
                agent_state = "completed"
            elif agent_state is None:
                agent_state = next((item.get("phase") for item in snapshot_values if item.get("phase")), None)
        summaries.append(
            {
                "id": project_id,
                "name": os.path.basename(project_id.rstrip("/")) or project_id,
                "remote": main.get("remote"),
                "main_path": main.get("path"),
                # A worktree is a checkout, not a branch lane. Match the
                # project endpoint's local-branch lane count instead of
                # counting snapshot rows.
                "lane_count": lane_count,
                "worktree_count": sum(1 for row in rows if row.get("is_worktree")),
                "git": {
                    "dirty": dirty,
                    "conflict": conflicts,
                    "ahead": ahead,
                    "behind": behind,
                    "merged": merged,
                    "prunable": prunable,
                    "locked": locked,
                },
                "latest_event": latest,
                "latest_agent_event": latest_agent,
                "latest_summary": latest_summary,
                "agent_tasks": sorted(snapshot_values, key=lambda item: (item.get("worktree") or "", item.get("task_id") or "")) or None,
                "latest_observed_at": max(
                    (row.get("activity", 0) for row in rows if isinstance(row.get("activity", 0), (int, float))),
                    default=0,
                ),
                "priority": issue_rank,
                "next_lane": next_lane,
                "largest_difference_lane": largest_difference_lane,
                # Never interpret a worktree as an agent being active.
                "agent_counts": agent_counts,
                "agent_priority_counts": agent_priority_counts,
                "agent_state": agent_state,
            }
        )
    summaries.sort(
        key=lambda item: (
            item.get("priority", 99),
            -(item.get("latest_observed_at") or 0),
            item.get("name", ""),
        )
    )
    return summaries
