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


def _connection_rows(rows: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Return current named rows eligible for a branch connection.

    Historical PR rows and detached worktree rows describe useful row data,
    but they do not describe a current branch tip from which a new relation
    can be inferred.
    """
    result: list[Mapping[str, Any]] = []
    for row in rows:
        if row.get("historical") is True:
            continue
        if not isinstance(row.get("id"), str) or not isinstance(row.get("name"), str) or not row.get("name"):
            continue
        if row.get("remote_ref") is None:
            locals_ = row.get("locals")
            if not isinstance(locals_, list):
                continue
            if not any(isinstance(lane, Mapping) and isinstance(lane.get("branch"), str) and lane.get("branch") for lane in locals_):
                continue
        result.append(row)
    return result


def _connection_repository(row: Mapping[str, Any], project_repository: str | None) -> str | None:
    value = row.get("remote_repository")
    if isinstance(value, str) and value:
        return value.lower()
    # A named local-only branch still belongs to the scanned repository. When
    # gh identified that repository, this is the exact identity available for
    # matching it to a remote default row or PR target.
    if (
        project_repository
        and row.get("historical") is not True
        and row.get("remote_ref") is None
        and row.get("remote_name") is None
        and row.get("remote_branch") is None
    ):
        return project_repository
    return None


def _connection_local_only(row: Mapping[str, Any]) -> bool:
    return (
        row.get("historical") is not True
        and row.get("remote_ref") is None
        and row.get("remote_name") is None
        and row.get("remote_branch") is None
    )


def _same_connection_repository(
    first: Mapping[str, Any],
    second: Mapping[str, Any],
    project_repository: str | None,
) -> bool:
    first_repository = _connection_repository(first, project_repository)
    second_repository = _connection_repository(second, project_repository)
    if first_repository is not None or second_repository is not None:
        return first_repository is not None and first_repository == second_repository
    # Unknown remote identities must not be treated as the same repository by
    # branch name. Two local-only rows are both facts about this checkout and
    # can use the checkout's unique default branch when no remote identity is
    # available.
    return _connection_local_only(first) and _connection_local_only(second)


def _connection_tip(row: Mapping[str, Any]) -> str | None:
    remote_hash = row.get("remote_hash")
    if isinstance(remote_hash, str) and _COMMIT_HASH_RE.fullmatch(remote_hash):
        return remote_hash
    locals_ = row.get("locals")
    if not isinstance(locals_, list):
        return None
    heads = {
        lane.get("head")
        for lane in locals_
        if isinstance(lane, Mapping)
        and isinstance(lane.get("head"), str)
        and _COMMIT_HASH_RE.fullmatch(lane["head"])
    }
    # A local-only row can be used only when its local head is exact. Never
    # select the first of several worktree heads as an inference input.
    return next(iter(heads)) if len(heads) == 1 else None


def _connection_target_label(row: Mapping[str, Any]) -> str:
    repository = row.get("remote_repository")
    if isinstance(repository, str) and repository:
        return f"{repository}:{row.get('name')}"
    return str(row.get("name") or "")


def _connection_unresolved(
    *,
    identifier: str,
    kind: str,
    source_row_id: str | None,
    target_row_id: str | None,
    source: str,
    target: str,
    reason: str,
    pull: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": identifier,
        "kind": kind,
        "source_row_id": source_row_id,
        "target_row_id": target_row_id,
        "source": source,
        "target": target,
        "reason": reason,
        "pr_number": pull.get("number") if isinstance(pull, Mapping) and isinstance(pull.get("number"), int) else None,
        "pr_url": pull.get("url") if isinstance(pull, Mapping) and isinstance(pull.get("url"), str) else None,
    }


def _connection_commit_hash(value: Any) -> str | None:
    """Return a commit hash only when the relation supplied an exact SHA.

    Connection endpoints are used as timeline anchors.  Keep those anchors
    separate from the relation's evidence hash and never turn a branch tip or
    a merge parent into an endpoint unless the source data identifies it.
    """
    return value if isinstance(value, str) and _COMMIT_HASH_RE.fullmatch(value) else None


def _pull_source_commit_hash(pull: Mapping[str, Any]) -> str | None:
    """Return the PR source SHA when GitHub supplied one.

    ``source_hash`` is the normalized field produced by ``_pr_row``. It is
    deliberately the only input here: the endpoint must stay unknown when
    that canonical evidence is absent, and is never inferred from the merge
    commit's parents.
    """
    return _connection_commit_hash(pull.get("source_hash"))


def _attach_connection_commit_metadata(
    repo: str,
    edges: list[dict[str, Any]],
) -> None:
    """Attach one exact metadata lookup to every connection endpoint.

    Branch rows intentionally expose only a bounded first history page.  An
    edge's common ancestor can be older than that page, so endpoint metadata
    is read independently with ``read_tips``.  A known SHA remains present
    when its object is missing locally; its metadata is then explicit ``None``.
    """
    endpoint_hashes = _history_heads(
        *(value
          for edge in edges
          for value in (edge.get("source_commit_hash"), edge.get("target_commit_hash")))
    )
    tip_rows = branch_history.read_tips(repo, endpoint_hashes) if endpoint_hashes else []
    tips_by_hash = {
        item["hash"]: item
        for item in tip_rows or []
        if isinstance(item, Mapping) and isinstance(item.get("hash"), str)
    }
    for edge in edges:
        source_hash = edge.get("source_commit_hash")
        target_hash = edge.get("target_commit_hash")
        edge["source_commit"] = tips_by_hash.get(source_hash) if isinstance(source_hash, str) else None
        edge["target_commit"] = tips_by_hash.get(target_hash) if isinstance(target_hash, str) else None


def _pr_target_candidates(
    rows: list[Mapping[str, Any]],
    pull: Mapping[str, Any],
    project_repository: str | None,
) -> list[Mapping[str, Any]]:
    target_repository = pull.get("target_repository")
    target_branch = pull.get("target_branch")
    if not isinstance(target_repository, str) or not isinstance(target_branch, str):
        return []
    target_repository = target_repository.lower()
    return [
        row
        for row in rows
        if row.get("name") == target_branch
        and _connection_repository(row, project_repository) == target_repository
    ]


def _ancestor_status(repo: str, ancestor: str, descendant: str) -> bool | None:
    _output, status = gitinfo._run_with_status(repo, ["merge-base", "--is-ancestor", ancestor, descendant])
    if status == 0:
        return True
    if status == 1:
        return False
    return None


def _object_available(repo: str, commit_hash: str) -> bool | None:
    _output, status = gitinfo._run_with_status(repo, ["cat-file", "-e", f"{commit_hash}^{{commit}}"])
    if status == 0:
        return True
    if status == 1:
        return False
    return None


def _merge_bases(repo: str, first: str, second: str) -> tuple[list[str] | None, bool]:
    """Return all merge bases and whether the Git query itself succeeded."""
    output, status = gitinfo._run_with_status(repo, ["merge-base", "--all", first, second])
    if status == 1:
        # Git's status 1 means the histories have no common ancestor, which is
        # a valid observation rather than an execution failure.
        return [], True
    if status != 0 or output is None:
        return None, False
    values = [line.strip() for line in output.splitlines() if line.strip()]
    if not values or not all(_COMMIT_HASH_RE.fullmatch(value) for value in values):
        return None, False
    return list(dict.fromkeys(values)), True


def _default_candidates(
    rows: list[Mapping[str, Any]],
    child: Mapping[str, Any],
    default_branch: str | None,
    project_repository: str | None,
) -> list[Mapping[str, Any]]:
    if not isinstance(default_branch, str) or not default_branch:
        return []
    return [
        row
        for row in rows
        if row.get("name") == default_branch
        and row.get("id") != child.get("id")
        and _same_connection_repository(child, row, project_repository)
    ]


def connections(
    repo: str,
    rows: list[Mapping[str, Any]] | None,
    *,
    default_branch: str | None = None,
    github_data: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build current branch-row connection facts from Git and merged PRs.

    Merge edges are explicit PR evidence. Branch edges are estimates from a
    unique Git merge base, and point from the selected base row to the current
    diverged row. This function performs one merge-base query per eligible
    current row; it does not compare every row pair.
    """
    if rows is None:
        return {"edges": [], "unresolved": [], "status": "unavailable"}
    current_rows = _connection_rows(rows)
    github_data = github_data or {}
    project_repository = _origin_repository(github_data)
    edges: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    edge_ids: set[str] = set()
    unresolved_ids: set[str] = set()

    def add_unresolved(item: dict[str, Any]) -> None:
        if item["id"] not in unresolved_ids:
            unresolved_ids.add(item["id"])
            unresolved.append(item)

    def add_edge(item: dict[str, Any]) -> None:
        if item["id"] not in edge_ids:
            edge_ids.add(item["id"])
            edges.append(item)

    # Every PR already attached to a row is a source identity. Resolve its
    # target by exact repository and branch, with merge ancestry only used to
    # disambiguate duplicate refs carrying the same repository/branch name.
    for source_row in rows:
        pulls = source_row.get("pull_requests")
        if not isinstance(pulls, list):
            continue
        for pull in pulls:
            if not isinstance(pull, Mapping):
                continue
            number = pull.get("number")
            if not isinstance(number, int):
                continue
            identifier = f"merge:pr:{number}"
            candidates = _pr_target_candidates(current_rows, pull, project_repository)
            merge_hash = pull.get("commit_hash")
            target_row: Mapping[str, Any] | None = None
            reason: str | None = None
            if not candidates:
                reason = "target_branch_not_found"
            elif not isinstance(merge_hash, str) or not _COMMIT_HASH_RE.fullmatch(merge_hash):
                reason = "merge_commit_unavailable"
            else:
                object_available = _object_available(repo, merge_hash)
                if object_available is not True:
                    reason = (
                        "merge_commit_unavailable"
                        if object_available is False
                        else "merge_commit_ancestry_unavailable"
                    )
                else:
                    ancestry: list[Mapping[str, Any]] = []
                    ancestry_uncertain = False
                    for candidate in candidates:
                        tip = _connection_tip(candidate)
                        if tip is None:
                            ancestry_uncertain = True
                            continue
                        status = _ancestor_status(repo, merge_hash, tip)
                        if status is True:
                            ancestry.append(candidate)
                        elif status is None:
                            ancestry_uncertain = True
                    if len(ancestry) == 1 and not ancestry_uncertain:
                        target_row = ancestry[0]
                    elif ancestry_uncertain:
                        reason = "merge_commit_ancestry_unavailable"
                    elif len(ancestry) > 1:
                        reason = "target_branch_ambiguous"
                    else:
                        reason = "merge_commit_not_ancestor"
            if target_row is None:
                target_repository = str(pull.get("target_repository") or "")
                target_branch = str(pull.get("target_branch") or "")
                target_candidate = candidates[0] if len(candidates) == 1 else None
                add_unresolved(_connection_unresolved(
                    identifier=identifier,
                    kind="merge",
                    source_row_id=source_row.get("id") if isinstance(source_row.get("id"), str) else None,
                    target_row_id=target_candidate.get("id") if isinstance(target_candidate, Mapping) and isinstance(target_candidate.get("id"), str) else None,
                    source=_connection_target_label(source_row),
                    target=f"{target_repository}:{target_branch}",
                    reason=reason or "target_branch_unresolved",
                    pull=pull,
                ))
                continue
            if target_row.get("id") == source_row.get("id"):
                add_unresolved(_connection_unresolved(
                    identifier=identifier,
                    kind="merge",
                    source_row_id=source_row.get("id") if isinstance(source_row.get("id"), str) else None,
                    target_row_id=target_row.get("id") if isinstance(target_row.get("id"), str) else None,
                    source=_connection_target_label(source_row),
                    target=_connection_target_label(target_row),
                    reason="source_and_target_are_same_row",
                    pull=pull,
                ))
                continue
            add_edge({
                "id": identifier,
                "kind": "merge",
                "source_row_id": source_row.get("id"),
                "target_row_id": target_row.get("id"),
                "evidence": "pull_request",
                "commit_hash": pull.get("commit_hash") if isinstance(pull.get("commit_hash"), str) else None,
                "source_commit_hash": _pull_source_commit_hash(pull),
                "target_commit_hash": _connection_commit_hash(pull.get("commit_hash")),
                "pr_number": number,
                "pr_url": pull.get("url") if isinstance(pull.get("url"), str) else None,
                "label": f"PR #{number}",
            })

    # A row with a confirmed PR target uses that target as its estimate base.
    # Rows without a confirmed PR target use the unique same-repository default
    # row. The estimate is retained only when both current tips are genuinely
    # divergent and Git reports exactly one merge base.
    for child in current_rows:
        child_id = child.get("id")
        if not isinstance(child_id, str):
            continue
        child_tip = _connection_tip(child)
        if child_tip is None:
            continue
        pulls = child.get("pull_requests")
        candidate_pulls = [
            pull
            for pull in pulls
            if isinstance(pull, Mapping)
            and isinstance(pull.get("target_branch"), str)
            and isinstance(pull.get("target_repository"), str)
        ] if isinstance(pulls, list) else []
        target_keys = {
            (str(pull["target_repository"]).lower(), str(pull["target_branch"]))
            for pull in candidate_pulls
        }
        if len(target_keys) > 1:
            add_unresolved(_connection_unresolved(
                identifier=f"branch:{child_id}:multiple-pr-targets",
                kind="branch",
                source_row_id=None,
                target_row_id=child_id,
                source="multiple PR targets",
                target=_connection_target_label(child),
                reason="multiple_pr_targets",
            ))
            continue
        confirmed_pull = candidate_pulls[0] if candidate_pulls else None
        if confirmed_pull is not None:
            candidates = _pr_target_candidates(current_rows, confirmed_pull, project_repository)
            target_label = f"{confirmed_pull.get('target_repository')}:{confirmed_pull.get('target_branch')}"
            if len(candidates) == 1:
                base_row = candidates[0]
            else:
                base_row = None
                reason = "target_branch_not_found" if not candidates else "target_branch_ambiguous"
                add_unresolved(_connection_unresolved(
                    identifier=f"branch:{child_id}:pr:{confirmed_pull.get('number')}",
                    kind="branch",
                    source_row_id=None,
                    target_row_id=child_id,
                    source=target_label,
                    target=_connection_target_label(child),
                    reason=reason,
                    pull=confirmed_pull,
                ))
        else:
            if child.get("name") == default_branch:
                continue
            candidates = _default_candidates(current_rows, child, default_branch, project_repository)
            if len(candidates) != 1:
                if default_branch is not None:
                    reason = "default_branch_not_found" if not candidates else "default_branch_ambiguous"
                    add_unresolved(_connection_unresolved(
                        identifier=f"branch:{child_id}:default",
                        kind="branch",
                        source_row_id=None,
                        target_row_id=child_id,
                        source=default_branch,
                        target=_connection_target_label(child),
                        reason=reason,
                    ))
                continue
            base_row = candidates[0]
        base_id = base_row.get("id") if base_row is not None else None
        base_tip = _connection_tip(base_row) if base_row is not None else None
        if not isinstance(base_id, str) or base_tip is None:
            if base_row is not None:
                add_unresolved(_connection_unresolved(
                    identifier=f"branch:{child_id}:tip",
                    kind="branch",
                    source_row_id=base_id,
                    target_row_id=child_id,
                    source=_connection_target_label(base_row),
                    target=_connection_target_label(child),
                    reason="base_tip_unavailable",
                ))
            continue
        if child_tip == base_tip:
            add_unresolved(_connection_unresolved(
                identifier=f"branch:{child_id}:shared-tip",
                kind="branch",
                source_row_id=base_id,
                target_row_id=child_id,
                source=_connection_target_label(base_row),
                target=_connection_target_label(child),
                reason="shared_tip",
            ))
            continue
        bases, git_ok = _merge_bases(repo, base_tip, child_tip)
        if not git_ok:
            add_unresolved(_connection_unresolved(
                identifier=f"branch:{child_id}:merge-base",
                kind="branch",
                source_row_id=base_id,
                target_row_id=child_id,
                source=_connection_target_label(base_row),
                target=_connection_target_label(child),
                reason="merge_base_unavailable",
            ))
            continue
        if not bases:
            add_unresolved(_connection_unresolved(
                identifier=f"branch:{child_id}:no-common-base",
                kind="branch",
                source_row_id=base_id,
                target_row_id=child_id,
                source=_connection_target_label(base_row),
                target=_connection_target_label(child),
                reason="no_common_merge_base",
            ))
            continue
        if len(bases) != 1:
            add_unresolved(_connection_unresolved(
                identifier=f"branch:{child_id}:multiple-bases",
                kind="branch",
                source_row_id=base_id,
                target_row_id=child_id,
                source=_connection_target_label(base_row),
                target=_connection_target_label(child),
                reason="multiple_merge_bases",
            ))
            continue
        merge_base = bases[0]
        # A child whose tip is already an ancestor of the base does not show
        # an active branch. A base tip that is the merge base is the common
        # new-branch case: the child advanced after it split, so retain the
        # estimate while keeping its merge-base evidence explicit.
        if merge_base == child_tip:
            continue
        add_edge({
            "id": f"branch:{base_id}->{child_id}",
            "kind": "branch",
            "source_row_id": base_id,
            "target_row_id": child_id,
            "evidence": "merge_base",
            "commit_hash": merge_base,
            "source_commit_hash": merge_base,
            "target_commit_hash": merge_base,
            "pr_number": None,
            "pr_url": None,
            "label": "共通祖先からの分岐推定",
        })

    _attach_connection_commit_metadata(repo, edges)
    status = "partial" if unresolved else "available"
    if not rows:
        status = "available"
    if not current_rows and rows:
        status = "unavailable"
    if not isinstance(default_branch, str) and not edges and not any(
        isinstance(row.get("pull_requests"), list) and row.get("pull_requests") for row in rows
    ):
        status = "unavailable"
    return {"edges": edges, "unresolved": unresolved, "status": status}
