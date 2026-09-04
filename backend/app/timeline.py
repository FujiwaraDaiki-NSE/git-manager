"""プロジェクト単位のブランチタイムラインを組み立てる。"""

from __future__ import annotations

import shlex
import time
from typing import Any

from app import gitinfo, paths

# Timeline is deliberately bounded.  A project can have a very long history,
# while the UI only needs enough points to explain the current parallel work.
TIMELINE_LIMIT = 200
FIELD_SEPARATOR = "\x1f"


def _origin_base(repo: str) -> dict[str, str] | None:
    """Return the remote base named by origin/HEAD, without guessing."""
    raw = gitinfo._run(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    if not raw:
        return None
    symbolic = raw.strip()
    prefix = "refs/remotes/origin/"
    if not symbolic.startswith(prefix):
        return None
    name = symbolic[len(prefix) :]
    if not name:
        return None
    ref = f"origin/{name}"
    commit_hash = gitinfo._run(
        repo,
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{name}"],
    )
    if not commit_hash:
        # A dangling origin/HEAD is not a usable base.  Do not fall back to a
        # local branch with a familiar name.
        return None
    return {"name": name, "ref": ref, "hash": commit_hash.strip()}


def _local_branches(repo: str) -> list[dict[str, str]] | None:
    raw = gitinfo._run(
        repo,
        [
            "for-each-ref",
            f"--format=%(refname:short){FIELD_SEPARATOR}%(objectname)",
            "refs/heads",
        ],
    )
    if raw is None:
        return None
    branches: list[dict[str, str]] = []
    for line in raw.splitlines():
        name, separator, commit_hash = line.partition(FIELD_SEPARATOR)
        if separator and name and commit_hash:
            branches.append({"name": name, "hash": commit_hash})
    return branches


def _parse_commits(raw: str | None) -> list[dict[str, Any]]:
    if raw is None:
        return []
    commits: list[dict[str, Any]] = []
    for line in raw.splitlines():
        fields = line.split(FIELD_SEPARATOR)
        if len(fields) != 6 or not fields[0]:
            continue
        full, short, author, date, timestamp, subject = fields
        try:
            committer_time = int(timestamp)
        except ValueError:
            continue
        commits.append(
            {
                "hash": full,
                "short": short,
                "subject": subject,
                "author": author,
                "date": date,
                "timestamp": committer_time,
            }
        )
    return commits


def _log_commits(
    repo: str,
    revision: str,
    *,
    first_parent: bool = False,
    limit: int = TIMELINE_LIMIT,
) -> tuple[list[dict[str, Any]], bool]:
    """Read newest-first, then retain the newest bounded set chronologically."""
    args = [
        "log",
        "--no-decorate",
        f"--max-count={limit + 1}",
        "--format=%H%x1f%h%x1f%an%x1f%cI%x1f%ct%x1f%s",
    ]
    if first_parent:
        args.insert(1, "--first-parent")
    args.append(revision)
    commits = _parse_commits(gitinfo._run(repo, args))
    truncated = len(commits) > limit
    if truncated:
        commits = commits[:limit]
    commits.reverse()
    return commits, truncated


def _commit_time(repo: str, commit_hash: str) -> int | None:
    raw = gitinfo._run(repo, ["show", "-s", "--format=%ct", commit_hash])
    if not raw:
        return None
    try:
        return int(raw.strip())
    except ValueError:
        return None


def _merge_base(repo: str, base: str, branch: str) -> str | None:
    raw = gitinfo._run(repo, ["merge-base", base, branch])
    return raw.strip() if raw else None


def _ahead_behind(repo: str, base: str, branch: str) -> tuple[int, int]:
    """Return branch ahead/behind from the left/right count unchanged.

    ``base...branch`` reports base-only commits on the left and branch-only
    commits on the right.  They are directly assigned to behind/ahead; no
    graph-side approximation is used.
    """
    raw = gitinfo._run(repo, ["rev-list", "--left-right", "--count", f"{base}...{branch}"])
    if not raw:
        return 0, 0
    fields = raw.split()
    if len(fields) != 2:
        return 0, 0
    try:
        behind = int(fields[0])
        ahead = int(fields[1])
    except ValueError:
        return 0, 0
    return ahead, behind


def _worktree_paths(repo: str) -> dict[str, str]:
    records = gitinfo.list_worktrees(repo) or []
    result: dict[str, str] = {}
    for record in records:
        branch = record.get("branch")
        worktree = record.get("path")
        if isinstance(branch, str) and branch and isinstance(worktree, str) and worktree:
            result[branch] = paths.to_host(worktree)
    return result


def _merged_names(repo: str, base: str) -> set[str]:
    raw = gitinfo._run(repo, ["branch", "--merged", base, "--format=%(refname:short)"])
    if raw is None:
        return set()
    return {line.strip() for line in raw.splitlines() if line.strip()}


def _merge_commit(repo: str, branch: str, base: str) -> tuple[str | None, int | None]:
    raw = gitinfo._run(
        repo,
        [
            "log",
            "--first-parent",
            "--ancestry-path",
            f"{branch}..{base}",
            "--reverse",
            "-1",
            "--format=%H%x1f%ct",
        ],
    )
    if not raw:
        return None, None
    fields = raw.strip().split(FIELD_SEPARATOR)
    if len(fields) != 2 or not fields[0]:
        return None, None
    try:
        return fields[0], int(fields[1])
    except ValueError:
        return fields[0], None


def _oldest_fork_index(trunk: list[dict[str, Any]], fork_times: list[int]) -> int:
    if not fork_times:
        return 0
    first = min(fork_times)
    for index, commit in enumerate(trunk):
        if commit["timestamp"] >= first:
            return index
    return max(len(trunk) - 1, 0)


def build(repo: str, limit: int = TIMELINE_LIMIT) -> dict[str, Any] | None:
    """Build a stable project timeline from read-only Git plumbing commands."""
    if limit < 1:
        raise ValueError("limit must be positive")

    base = _origin_base(repo)
    branches = _local_branches(repo)
    if branches is None:
        return None

    now = time.time()
    if base is None:
        return {
            "base": None,
            "now": now,
            "trunk": [],
            "branches": [],
            "command": "git log --first-parent --format=oneline origin/HEAD",
        }

    worktrees = _worktree_paths(repo)
    merged_names = _merged_names(repo, base["ref"])
    branch_results: list[dict[str, Any]] = []
    fork_times: list[int] = []
    for branch in branches:
        name = branch["name"]
        if name == base["name"]:
            continue
        merge_base = _merge_base(repo, base["ref"], name)
        fork_time = _commit_time(repo, merge_base) if merge_base else None
        if fork_time is not None:
            fork_times.append(fork_time)
        ahead, behind = _ahead_behind(repo, base["ref"], name)
        commits, commits_truncated = _log_commits(
            repo,
            f"{merge_base}..{name}" if merge_base else name,
            limit=limit,
        )
        merged = name in merged_names
        merge_hash: str | None = None
        merged_at: int | None = None
        if merged:
            merge_hash, merged_at = _merge_commit(repo, name, base["ref"])
        branch_results.append(
            {
                "name": name,
                "hash": branch["hash"],
                "worktree": worktrees.get(name),
                "merge_base": merge_base,
                "fork_time": fork_time,
                "ahead": ahead,
                "behind": behind,
                "commits": commits,
                "commits_truncated": commits_truncated,
                "merged": merged,
                "merge_hash": merge_hash,
                "merged_at": merged_at,
            }
        )

    trunk, trunk_truncated = _log_commits(
        repo,
        base["ref"],
        first_parent=True,
        limit=limit,
    )
    # Drop points older than the earliest fork marker.  _log_commits already
    # bounds the history to the newest ``limit`` points, so an old fork that
    # fell outside that retained window leaves the bounded trunk untouched.
    trunk = trunk[_oldest_fork_index(trunk, fork_times) :]
    if len(trunk) > limit:
        trunk = trunk[-limit:]

    command = "git log --first-parent --format=oneline " + shlex.quote(base["ref"])
    response: dict[str, Any] = {
        "base": base,
        "now": now,
        "trunk": trunk,
        "branches": branch_results,
        "command": command,
    }
    # Kept as metadata for diagnostics while preserving the documented stable
    # fields consumed by the frontend.
    if trunk_truncated:
        response["trunk_truncated"] = True
    return response
