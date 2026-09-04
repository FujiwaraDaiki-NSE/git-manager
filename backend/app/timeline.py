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


class GitCommandError(RuntimeError):
    """Raised when a timeline plumbing command cannot produce its result."""


def _git_result(repo: str, args: list[str]) -> tuple[int, str]:
    status, output = gitinfo._run_result(repo, args)
    if status is None:
        command = shlex.join([gitinfo.GIT, "-C", repo, *args])
        raise GitCommandError(f"Git command did not complete: {command}")
    return status, output


def _run_required(repo: str, args: list[str]) -> str:
    status, output = _git_result(repo, args)
    if status != 0:
        command = shlex.join([gitinfo.GIT, "-C", repo, *args])
        raise GitCommandError(f"Git command failed ({status}): {command}")
    return output


def _origin_base(repo: str) -> dict[str, str] | None:
    """Return the remote base named by origin/HEAD, without guessing."""
    symbolic_args = ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]
    status, raw = _git_result(repo, symbolic_args)
    if status == 1:
        return None
    if status != 0:
        command = shlex.join([gitinfo.GIT, "-C", repo, *symbolic_args])
        raise GitCommandError(f"Git command failed ({status}): {command}")
    symbolic = raw.strip()
    prefix = "refs/remotes/origin/"
    if not symbolic.startswith(prefix):
        return None
    name = symbolic[len(prefix) :]
    if not name:
        return None
    ref = f"origin/{name}"
    status, commit_hash = _git_result(
        repo,
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{name}"],
    )
    if status == 1:
        # A dangling origin/HEAD is not a usable base.  Do not fall back to a
        # local branch with a familiar name.
        return None
    if status != 0:
        command = shlex.join(
            [
                gitinfo.GIT,
                "-C",
                repo,
                "rev-parse",
                "--verify",
                "--quiet",
                f"refs/remotes/origin/{name}",
            ]
        )
        raise GitCommandError(f"Git command failed ({status}): {command}")
    value = commit_hash.strip()
    if not value:
        raise GitCommandError("Git returned an empty origin/HEAD target")
    return {"name": name, "ref": ref, "hash": value}


def _local_branches(repo: str) -> list[dict[str, str]]:
    raw = _run_required(
        repo,
        [
            "for-each-ref",
            f"--format=%(refname:short){FIELD_SEPARATOR}%(objectname)",
            "refs/heads",
        ],
    )
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
    commits = _parse_commits(_run_required(repo, args))
    truncated = len(commits) > limit
    if truncated:
        commits = commits[:limit]
    commits.reverse()
    return commits, truncated


def _commit_time(repo: str, commit_hash: str) -> int:
    raw = _run_required(repo, ["show", "-s", "--format=%ct", commit_hash])
    if not raw.strip():
        raise GitCommandError(f"Git returned no committer time for {commit_hash}")
    try:
        return int(raw.strip())
    except ValueError as error:
        raise GitCommandError(f"Git returned an invalid committer time for {commit_hash}") from error


def _merge_base(repo: str, base: str, branch: str) -> str | None:
    status, raw = _git_result(repo, ["merge-base", base, branch])
    if status == 1:
        # Git uses status 1 to report two valid, unrelated histories.
        return None
    if status != 0:
        command = shlex.join([gitinfo.GIT, "-C", repo, "merge-base", base, branch])
        raise GitCommandError(f"Git command failed ({status}): {command}")
    value = raw.strip()
    if not value:
        raise GitCommandError(f"Git returned no merge base for {base} and {branch}")
    return value


def _ahead_behind(repo: str, base: str, branch: str) -> tuple[int, int]:
    """Return branch ahead/behind from the left/right count unchanged.

    ``base...branch`` reports base-only commits on the left and branch-only
    commits on the right.  They are directly assigned to behind/ahead; no
    graph-side approximation is used.
    """
    raw = _run_required(repo, ["rev-list", "--left-right", "--count", f"{base}...{branch}"])
    fields = raw.split()
    if len(fields) != 2:
        raise GitCommandError(f"Git returned an invalid ahead/behind count for {base} and {branch}")
    try:
        behind = int(fields[0])
        ahead = int(fields[1])
    except ValueError as error:
        raise GitCommandError(f"Git returned an invalid ahead/behind count for {base} and {branch}") from error
    return ahead, behind


def _worktree_paths(repo: str) -> dict[str, str]:
    records = gitinfo.list_worktrees(repo)
    if records is None:
        raise GitCommandError("Git could not list worktrees")
    result: dict[str, str] = {}
    for record in records:
        branch = record.get("branch")
        worktree = record.get("path")
        if isinstance(branch, str) and branch and isinstance(worktree, str) and worktree:
            result[branch] = paths.to_host(worktree)
    return result


def _merged_names(repo: str, base: str) -> set[str]:
    raw = _run_required(repo, ["branch", "--merged", base, "--format=%(refname:short)"])
    return {line.strip() for line in raw.splitlines() if line.strip()}


def _merge_commit(
    repo: str,
    branch: str,
    branch_hash: str,
    base: str,
    base_hash: str,
) -> tuple[str | None, int | None, str | None]:
    """Find the first base first-parent commit containing ``branch_hash``.

    Git is invoked once per merged branch.  The branch-to-base difference
    graph is collected in one pass so old local refs and indirect merges can
    be resolved without starting one ``merge-base --is-ancestor`` process per
    trunk commit.
    """
    raw = _run_required(
        repo,
        [
            "rev-list",
            "--reverse",
            "--pretty=format:%H%x1f%ct%x1f%P",
            "--no-commit-header",
            f"{branch_hash}..{base}",
        ],
    )
    if not raw:
        return None, None, None
    records: dict[str, tuple[int, list[str]]] = {}
    for line in raw.splitlines():
        fields = line.split(FIELD_SEPARATOR, 2)
        if len(fields) != 3 or not fields[0] or not fields[1]:
            raise GitCommandError(f"Git returned an invalid merge record for {branch}")
        try:
            merged_at = int(fields[1])
        except ValueError as error:
            raise GitCommandError(f"Git returned an invalid merge timestamp for {branch}") from error
        records[fields[0]] = (merged_at, fields[2].split())

    children: dict[str, list[str]] = {}
    for commit_hash, (_timestamp, parents) in records.items():
        for parent in parents:
            children.setdefault(parent, []).append(commit_hash)
    descendants = {branch_hash}
    pending = [branch_hash]
    while pending:
        ancestor = pending.pop()
        for child in children.get(ancestor, []):
            if child in descendants:
                continue
            descendants.add(child)
            pending.append(child)

    first_parent_chain: list[str] = []
    current = base_hash
    while current:
        if current not in records:
            # ``branch_hash..base`` intentionally omits the first parent that
            # is already reachable from the branch.  It is the end of the
            # base first-parent portion relevant to this branch.
            break
        first_parent_chain.append(current)
        parents = records[current][1]
        current = parents[0] if parents else ""

    for commit_hash in reversed(first_parent_chain):
        if commit_hash not in descendants:
            continue
        merged_at, parents = records[commit_hash]
        # The first base first-parent commit containing the branch tip is the
        # only merge point we can attribute from Git facts.  An ordinary
        # commit means fast-forward (or an already-on-trunk ref), so stop
        # rather than inventing a later merge timestamp.
        if len(parents) < 2:
            break
        return commit_hash, merged_at, parents[0]
    # Fast-forward and squash histories have no attributable merge commit.
    return None, None, None


def _oldest_fork_index(trunk: list[dict[str, Any]], fork_times: list[int]) -> int:
    if not fork_times:
        return 0
    first = min(fork_times)
    for index, commit in enumerate(trunk):
        if commit["timestamp"] >= first:
            return index
    return max(len(trunk) - 1, 0)


def build(repo: str, limit: int = TIMELINE_LIMIT) -> dict[str, Any]:
    """Build a stable project timeline from read-only Git plumbing commands."""
    if limit < 1:
        raise ValueError("limit must be positive")

    base = _origin_base(repo)
    branches = _local_branches(repo)

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
        merged = name in merged_names
        merge_hash: str | None = None
        merged_at: int | None = None
        merge_parent: str | None = None
        if merged:
            merge_hash, merged_at, merge_parent = _merge_commit(
                repo,
                name,
                branch["hash"],
                base["ref"],
                base["hash"],
            )
        fork_revision = merge_parent or base["ref"]
        merge_base = _merge_base(repo, fork_revision, name)
        fork_time = _commit_time(repo, merge_base) if merge_base else None
        if fork_time is not None:
            fork_times.append(fork_time)
        ahead, behind = _ahead_behind(repo, base["ref"], name)
        commits, commits_truncated = _log_commits(
            repo,
            f"{merge_base}..{name}" if merge_base else name,
            limit=limit,
        )
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
