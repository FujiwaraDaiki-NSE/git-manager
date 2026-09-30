"""ブランチ単位で表示するための Git 参照集約。

このモジュールは、コミットを一つのブランチへ推測で割り当てない。
現在存在するリモート参照とローカル参照を行へまとめ、各行のログは
その参照を頭に ``branch_history`` のページとして再帰的に取得する。同じ
コミットが複数行に現れることは、各ブランチから到達できるという観測事実として許容する。
"""
from __future__ import annotations

import re
from typing import Any, Mapping

from app import branch_history, gitinfo


_FETCH_CONFIG_RE = re.compile(r"^remote\.(?P<remote>.+)\.fetch$")
_PULL_REF_RE = re.compile(r"(?:^|/)(?:pull|pr)/\d+/(?:head|merge)$")
_GITHUB_REMOTE_RE = re.compile(
    r"^(?:git@github\.com:|https://github\.com/|ssh://git@github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?/?$"
)
_COMMIT_HASH_RE = re.compile(r"^[0-9a-fA-F]{40}$")


def _full_ref(remote_ref: str) -> str:
    return f"refs/remotes/{remote_ref}"


def _remote_and_branch(remote_ref: str) -> tuple[str, str] | None:
    if "/" not in remote_ref:
        return None
    remote, branch = remote_ref.split("/", 1)
    if not remote or not branch:
        return None
    return remote, branch


def _refspec_regex(destination: str) -> re.Pattern[str] | None:
    """Turn one configured fetch destination into an exact ref matcher.

    Only destinations fed by ``refs/heads`` are branch refs. This excludes
    GitHub pull refs such as ``refs/pull/*/head`` even when they are stored
    below ``refs/remotes`` by a custom fetch refspec.
    """
    if not destination.startswith("refs/remotes/"):
        return None
    escaped = re.escape(destination)
    if "*" in destination:
        escaped = escaped.replace(r"\*", "(.+)")
    return re.compile(rf"^{escaped}$")


def _remote_branch_destinations(repo: str) -> dict[str, list[re.Pattern[str]]] | None:
    """Return configured ``refs/heads`` destinations by remote name.

    Git's remote tracking refs may include pull refs, temporary refs, and
    manually-created names. The remote fetch refspec is the authoritative
    distinction available locally, so only its ``refs/heads`` destinations
    participate in branch rows.
    """
    raw, status = gitinfo._run_with_status(repo, ["config", "--get-regexp", r"^remote\..+\.fetch$"])
    if status is None or status not in {0, 1}:
        return None
    if status == 1:
        return {}
    destinations: dict[str, list[re.Pattern[str]]] = {}
    for line in raw.splitlines() if raw else []:
        key, separator, refspec = line.partition(" ")
        if not separator:
            continue
        match = _FETCH_CONFIG_RE.fullmatch(key.strip())
        if match is None:
            continue
        refspec = refspec.strip().lstrip("+")
        source, separator, destination = refspec.partition(":")
        if not separator or not source.startswith("refs/heads/"):
            continue
        pattern = _refspec_regex(destination)
        if pattern is None:
            continue
        destinations.setdefault(match.group("remote"), []).append(pattern)
    return destinations


def _is_configured_branch_ref(
    remote_ref: str,
    destinations: Mapping[str, list[re.Pattern[str]]],
) -> bool:
    parts = _remote_and_branch(remote_ref)
    if parts is None:
        return False
    remote, branch = parts
    # This is an additional guard for unusual configurations whose destination
    # resembles a pull ref despite a broad source pattern.
    if _PULL_REF_RE.search(branch):
        return False
    full = _full_ref(remote_ref)
    return any(pattern.fullmatch(full) for pattern in destinations.get(remote, []))


def _is_remote_tracking_name(
    upstream: str,
    destinations: Mapping[str, list[re.Pattern[str]]],
) -> bool:
    """Recognize an upstream short name in the configured remote namespace."""
    if _is_configured_branch_ref(upstream, destinations):
        return True
    parts = _remote_and_branch(upstream)
    return parts is not None and parts[0] in destinations and not _PULL_REF_RE.search(parts[1])


def _hash(repo: str, ref: str | None) -> str | None:
    if not ref:
        return None
    raw = gitinfo._run(repo, ["rev-parse", "--verify", "--quiet", ref])
    value = raw.strip() if raw else ""
    return value or None


def _remote_repository(repo: str, remote: str | None) -> str | None:
    if not remote:
        return None
    raw = gitinfo._run(repo, ["remote", "get-url", remote])
    match = _GITHUB_REMOTE_RE.fullmatch(raw.strip()) if raw else None
    return match.group(1).lower() if match else None


def _history_heads(*values: str | None) -> list[str]:
    return list(dict.fromkeys(value for value in values if isinstance(value, str) and _COMMIT_HASH_RE.fullmatch(value)))


def _lane_branch(lane: Mapping[str, Any]) -> str | None:
    value = lane.get("branch")
    return value if isinstance(value, str) and value else None


def _tracking_counts(track: Any) -> tuple[int | None, int | None]:
    if not isinstance(track, str):
        return None, None
    if track.strip() == "[up to date]":
        return 0, 0
    ahead = re.search(r"ahead (\d+)", track)
    behind = re.search(r"behind (\d+)", track)
    return (
        int(ahead.group(1)) if ahead else 0 if behind else None,
        int(behind.group(1)) if behind else 0 if ahead else None,
    )


def _remote_row_key(remote_ref: str) -> str:
    return f"remote:{remote_ref}"


def _local_row_key(branch: str) -> str:
    return f"local:{branch}"


def _historical_row_key(number: int) -> str:
    return f"history:pr:{number}"


def _ref_contains(repo: str, ref: str, commit_hash: str) -> bool:
    return gitinfo._run(repo, ["merge-base", "--is-ancestor", commit_hash, ref]) is not None


def _pr_row(pr: Mapping[str, Any]) -> dict[str, Any] | None:
    number = pr.get("number")
    url = pr.get("url")
    source_branch = pr.get("head")
    target_branch = pr.get("base")
    source_repo = pr.get("head_repo")
    target_repo = pr.get("base_repo")
    if not isinstance(number, int) or not isinstance(url, str):
        return None
    if not all(isinstance(value, str) and value for value in (source_branch, target_branch, target_repo)):
        return None
    merged_at = pr.get("merged_at")
    if not isinstance(merged_at, str) or not merged_at:
        return None
    merge_hash = pr.get("merge") if isinstance(pr.get("merge"), str) else None
    head_hash = pr.get("head_sha") if isinstance(pr.get("head_sha"), str) else None
    source = (
        f"{source_repo}:{source_branch}"
        if isinstance(source_repo, str) and source_repo
        else f"元リポジトリ不明:{source_branch}"
    )
    return {
        "number": number,
        "url": url,
        "source": source,
        "target": f"{target_repo}:{target_branch}",
        "source_repository": source_repo if isinstance(source_repo, str) and source_repo else None,
        "source_repository_available": isinstance(source_repo, str) and bool(source_repo),
        "source_branch": source_branch,
        "source_hash": head_hash,
        "target_repository": target_repo,
        "target_branch": target_branch,
        "commit_hash": merge_hash,
        "head_hash": head_hash,
        "merged_at": merged_at,
    }


def _pr_rows(github_data: Mapping[str, Any]) -> list[dict[str, Any]]:
    pulls = github_data.get("pulls")
    if not isinstance(pulls, list):
        return []
    rows: list[dict[str, Any]] = []
    for pull in pulls:
        if not isinstance(pull, Mapping):
            continue
        parsed = _pr_row(pull)
        if parsed is not None:
            rows.append(parsed)
    return rows


def _origin_repository(github_data: Mapping[str, Any]) -> str | None:
    value = github_data.get("repository")
    return value.lower() if isinstance(value, str) and value else None


def _find_current_pr_row(
    repo: str,
    rows: list[dict[str, Any]],
    pull: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Join a PR only to a same-repository current source ref.

    A fork branch with the same name is a different ref identity and must
    become a historical PR row instead of being attached to the base repo's
    branch by name alone.
    """
    source_repo = pull.get("source_repository")
    source_branch = pull.get("source_branch")
    if not isinstance(source_repo, str) or not isinstance(source_branch, str):
        return None
    source_hash = pull.get("source_hash")
    if not isinstance(source_hash, str) or not _COMMIT_HASH_RE.fullmatch(source_hash):
        return None
    candidates = [
        row
        for row in rows
        if not row.get("historical")
        and row.get("name") == source_branch
        and row.get("remote_repository") == source_repo.lower()
        and any(
            isinstance(lane, Mapping) and _lane_branch(lane) == source_branch
            for lane in row.get("locals", [])
            if isinstance(row.get("locals"), list)
        )
    ]
    # A remote branch can remain current without a local checkout.
    if not candidates:
        candidates = [
            row
            for row in rows
            if not row.get("historical")
            and row.get("name") == source_branch
            and row.get("remote_repository") == source_repo.lower()
        ]
    if source_repo.lower() != str(pull.get("target_repository") or "").lower():
        return None
    containing = []
    for row in candidates:
        refs: list[str] = []
        remote_ref = row.get("remote_ref")
        if isinstance(remote_ref, str) and remote_ref:
            refs.append(_full_ref(remote_ref))
        for lane in row.get("locals", []):
            if isinstance(lane, Mapping) and isinstance(lane.get("branch"), str) and lane.get("branch"):
                refs.append(f"refs/heads/{lane['branch']}")
        if source_hash in row.get("commit_hashes", []) or any(_ref_contains(repo, ref, source_hash) for ref in refs):
            containing.append(row)
    return containing[0] if len(containing) == 1 else None


def _status(
    remote_ref: str | None,
    remote_hash: str | None,
    locals_: list[Mapping[str, Any]],
    remote_present: bool,
) -> str:
    if remote_ref is None:
        return "local_only"
    if remote_hash is None:
        if remote_present:
            return "remote_unavailable"
        return "upstream_deleted" if locals_ else "remote_only"
    if not locals_:
        return "remote_only"
    local_hashes = {lane.get("head") for lane in locals_ if isinstance(lane.get("head"), str)}
    if local_hashes and local_hashes == {remote_hash}:
        return "synchronized"
    tracks = [
        (lane.get("upstream_ahead"), lane.get("upstream_behind"))
        for lane in locals_
    ]
    if any(ahead is None or behind is None for ahead, behind in tracks):
        return "tracking_unavailable"
    if all(ahead == 0 and behind == 0 for ahead, behind in tracks):
        return "tracking_inconsistent"
    if all(ahead == 0 and behind > 0 for ahead, behind in tracks):
        return "remote_ahead"
    if tracks and all(ahead > 0 and behind == 0 for ahead, behind in tracks):
        return "local_ahead"
    if any(ahead == 0 and behind > 0 for ahead, behind in tracks) and any(
        ahead > 0 and behind == 0 for ahead, behind in tracks
    ):
        return "mixed"
    return "diverged"


def build(
    repo: str,
    branch_data: Mapping[str, Any],
    lanes: list[Mapping[str, Any]],
    github_data: Mapping[str, Any] | None = None,
    default_branch: str | None = None,
) -> list[dict[str, Any]] | None:
    """Build current and PR-backed historical branch rows.

    ``branch_data`` comes from ``detail.get_branches`` and therefore carries
    exact local upstream strings and worktree-enriched lanes are supplied
    separately. Remote refs are filtered using the configured fetch refspecs.
    """
    github_data = github_data or {}
    destinations = _remote_branch_destinations(repo)
    if destinations is None:
        return None
    remote_repositories = {
        remote: _remote_repository(repo, remote)
        for remote in destinations
    }
    fresh_local = {
        item.get("name"): item
        for item in branch_data.get("local", [])
        if isinstance(item, Mapping) and isinstance(item.get("name"), str)
    }
    remote_records: dict[str, Mapping[str, Any]] = {}
    for remote in branch_data.get("remotes", []) if isinstance(branch_data.get("remotes"), list) else []:
        if not isinstance(remote, Mapping):
            continue
        remote_ref = remote.get("name")
        if not isinstance(remote_ref, str) or not _is_configured_branch_ref(remote_ref, destinations):
            continue
        remote_records[remote_ref] = remote

    lanes_by_upstream: dict[str, list[Mapping[str, Any]]] = {}
    local_only: list[Mapping[str, Any]] = []
    current_lanes: list[dict[str, Any]] = []
    for lane in lanes:
        current = dict(lane)
        branch = _lane_branch(current)
        fresh = fresh_local.get(branch) if branch is not None else None
        if isinstance(fresh, Mapping):
            # Branch identity and tracking facts come from this request's
            # refs/for-each-ref snapshot. Worktree state remains from lane.
            current["upstream"] = fresh.get("upstream")
            ahead, behind = _tracking_counts(fresh.get("track"))
            current["upstream_ahead"] = ahead
            current["upstream_behind"] = behind
        current_lanes.append(current)
    for lane in current_lanes:
        branch = _lane_branch(lane)
        if branch is None:
            if isinstance(lane.get("path"), str) or isinstance(lane.get("head"), str):
                local_only.append(lane)
            continue
        upstream = lane.get("upstream")
        if isinstance(upstream, str) and upstream and _is_remote_tracking_name(upstream, destinations):
            lanes_by_upstream.setdefault(upstream, []).append(lane)
        else:
            local_only.append(lane)

    rows: list[dict[str, Any]] = []
    upstream_keys = set(lanes_by_upstream)
    for remote_ref in sorted(set(remote_records) | upstream_keys):
        remote = remote_records.get(remote_ref)
        parsed = _remote_and_branch(remote_ref)
        if parsed is None:
            continue
        _remote_name, branch_name = parsed
        remote_hash = _hash(repo, _full_ref(remote_ref)) if remote is not None else None
        local_lanes = list(lanes_by_upstream.get(remote_ref, []))
        remote_repository = remote_repositories.get(parsed[0])
        remote_head = remote_hash if remote is not None else None
        local_heads = [
            lane.get("head")
            for lane in local_lanes
            if isinstance(lane.get("head"), str)
        ]
        history_heads = _history_heads(remote_head, *local_heads)
        row = {
            "id": _remote_row_key(remote_ref),
            "name": branch_name,
            "remote_ref": remote_ref,
            "remote_hash": remote_hash,
            "remote_name": parsed[0],
            "remote_branch": branch_name,
            "remote_repository": remote_repository,
            "tracking_ref": remote_ref if local_lanes else None,
            "locals": [dict(lane) for lane in local_lanes],
            "commit_hashes": [],
            "history_heads": history_heads,
            "history_cursor": None,
            "history_truncated": False,
            "history_available": bool(history_heads),
            "historical": False,
            "status": _status(remote_ref, remote_hash, local_lanes, remote is not None),
            "pull_requests": [],
        }
        rows.append(row)

    for lane in local_only:
        branch_name = _lane_branch(lane)
        row_name = branch_name or (lane.get("name") if isinstance(lane.get("name"), str) else "detached HEAD")
        if not row_name:
            row_name = "detached HEAD"
        row_id = _local_row_key(branch_name) if branch_name else f"worktree:{lane.get('path') or row_name}"
        history_heads = _history_heads(lane.get("head"))
        upstream_parts = _remote_and_branch(str(lane.get("upstream"))) if isinstance(lane.get("upstream"), str) else None
        rows.append(
            {
                "id": row_id,
                "name": row_name,
                "remote_ref": None,
                "remote_hash": None,
                "remote_name": None,
                "remote_branch": None,
                "remote_repository": remote_repositories.get(upstream_parts[0]) if upstream_parts else None,
                "tracking_ref": lane.get("upstream"),
                "locals": [dict(lane)],
                "commit_hashes": [],
                "history_heads": history_heads,
                "history_cursor": None,
                "history_truncated": False,
                "history_available": bool(history_heads),
                "historical": False,
                "status": "detached" if branch_name is None else "local_only",
                "pull_requests": [],
            }
        )

    pulls = _pr_rows(github_data)
    historical_by_source: dict[tuple[str | None, str], dict[str, Any]] = {}
    for pull in pulls:
        current = _find_current_pr_row(repo, rows, pull)
        if current is not None:
            current["pull_requests"].append(pull)
            continue
        # Only PRs whose base belongs to this checkout can describe its
        # completed branch history. Fork sources remain explicit in source,
        # while their deleted branch receives a separate historical row.
        repository = _origin_repository(github_data)
        if repository is None or pull["target_repository"].lower() != repository:
            continue
        source_hash = pull.get("head_hash")
        history_heads = _history_heads(source_hash)
        source_repository = pull.get("source_repository")
        source_key = (
            source_repository.lower() if isinstance(source_repository, str) else None,
            (
                f"{pull['source_branch']}#{pull['source_hash']}"
                if isinstance(pull.get("source_hash"), str)
                else f"{pull['source_branch']}#pr:{pull['number']}"
            ),
        )
        historical = historical_by_source.get(source_key)
        if historical is not None:
            historical["pull_requests"].append(pull)
            continue
        historical = {
            "id": _historical_row_key(pull["number"]),
            "name": pull["source_branch"],
            "remote_ref": None,
            "remote_hash": None,
            "remote_name": None,
            "remote_branch": None,
            "remote_repository": None,
            "tracking_ref": None,
            "locals": [],
            "commit_hashes": [],
            "history_heads": history_heads,
            "history_cursor": None,
            "history_truncated": False,
            "history_available": bool(history_heads),
            "historical": True,
            "status": "historical_deleted",
            "pull_requests": [pull],
        }
        historical_by_source[source_key] = historical
        rows.append(historical)

    all_history_heads = list(
        dict.fromkeys(
            head
            for row in rows
            for head in row.get("history_heads", [])
            if isinstance(head, str)
        )
    )
    tip_rows = branch_history.read_tips(repo, all_history_heads)
    tips_by_hash = {
        item["hash"]: item
        for item in tip_rows or []
        if isinstance(item, Mapping) and isinstance(item.get("hash"), str)
    }
    for row in rows:
        heads = row.get("history_heads")
        expected_heads = heads if isinstance(heads, list) else []
        row["tip_commits"] = [tips_by_hash[head] for head in expected_heads if head in tips_by_hash]
        row["tip_metadata_available"] = tip_rows is not None and all(
            head in tips_by_hash for head in expected_heads
        )

    for row in rows:
        heads = row.get("history_heads")
        page = branch_history.read_page(repo, heads if isinstance(heads, list) else [], 0)
        if page is None:
            row["commits"] = []
            row["commit_hashes"] = []
            row["history_cursor"] = None
            row["history_truncated"] = False
            row["history_available"] = False
            row["commit_metadata_available"] = False
            continue
        commits = page.get("commits")
        if not isinstance(commits, list):
            row["commits"] = []
            row["commit_hashes"] = []
            row["history_cursor"] = None
            row["history_truncated"] = False
            row["history_available"] = False
            row["commit_metadata_available"] = False
            continue
        row["commits"] = commits
        row["commit_hashes"] = [
            item["hash"]
            for item in commits
            if isinstance(item, Mapping) and isinstance(item.get("hash"), str)
        ]
        row["history_cursor"] = page.get("next_offset") if isinstance(page.get("next_offset"), int) else None
        row["history_truncated"] = row["history_cursor"] is not None
        row["history_available"] = bool(heads)
        row["commit_metadata_available"] = len(row["commit_hashes"]) == len(commits)

    # Keep the default branch and ordinary current rows stable before the
    # completed history section; the caller may reorder the register later.
    rows.sort(
        key=lambda row: (
            bool(row.get("historical")),
            row.get("name") != default_branch if default_branch else False,
            row.get("remote_ref") is None,
            str(row.get("name") or ""),
            str(row.get("id") or ""),
        )
    )
    return rows
