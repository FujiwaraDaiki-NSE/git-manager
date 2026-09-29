"""コミット詳細とブランチ一覧の git 出力を API 用に変換する。"""
from __future__ import annotations

import re
from typing import Any

from app import gitinfo, paths

PATCH_MAX_BYTES = 200_000
HASH_RE = re.compile(r"^[0-9a-fA-F]{4,64}$")
REF_SEPARATOR = "\x1f"
# refname:short だけでは slash 付き local branch と remote を区別できない。
# 最後の full ref は分類専用で、レスポンスには含めない。
REF_FORMAT = (
    "%(refname:short)%1f%(objectname:short)%1f%(upstream:short)"
    "%1f%(upstream:track)%1f%(committerdate:iso-strict)%1f%(HEAD)"
    "%1f%(refname)%1f%(worktreepath)"
)


def valid_hash(value: str) -> bool:
    return HASH_RE.fullmatch(value) is not None


def _parse_numstat(raw: str) -> dict[str, Any] | None:
    header = raw.split("\0", 5)
    if len(header) != 6 or not header[0]:
        return None
    commit_hash, subject, author, date, parents, body = header
    records = iter(body.removeprefix("\n").split("\0"))
    files: list[dict[str, Any]] = []
    for record in records:
        if not record:
            continue
        fields = record.split("\t", 2)
        if len(fields) != 3:
            return None
        additions, deletions, path = fields
        old_path = None
        if not path:
            old_path = next(records, None)
            path = next(records, None)
            if old_path is None or path is None:
                return None
        if additions != "-" and not additions.isdecimal():
            return None
        if deletions != "-" and not deletions.isdecimal():
            return None
        file = {
            "additions": additions if additions == "-" else int(additions),
            "deletions": deletions if deletions == "-" else int(deletions),
            "path": path,
            "binary": additions == "-" and deletions == "-",
        }
        if old_path is not None:
            file["old_path"] = old_path
        files.append(file)

    return {
        "hash": commit_hash,
        "subject": subject,
        "author": author,
        "date": date,
        "parents": parents.split() if parents else [],
        "files": files,
    }


def _truncate_patch(patch: str) -> tuple[str, bool]:
    encoded = patch.encode("utf-8")
    if len(encoded) <= PATCH_MAX_BYTES:
        return patch, False
    truncated = encoded[:PATCH_MAX_BYTES].decode("utf-8", errors="ignore")
    return truncated, True


def get_commit(repo: str, commit_hash: str) -> dict[str, Any] | None:
    """指定コミットのメタデータ、numstat、patch を取得する。"""
    if gitinfo._run(repo, ["cat-file", "-t", commit_hash]) != "commit\n":
        return None
    numstat = gitinfo._run(
        repo,
        [
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            "--format=%H%x00%s%x00%an%x00%cI%x00%P",
            commit_hash,
        ],
    )
    if numstat is None:
        return None
    result = _parse_numstat(numstat)
    if result is None:
        return None

    patch = gitinfo._run_limited(
        repo,
        [
            "-c",
            "core.quotepath=false",
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--format=",
            "--patch",
            "--unified=3",
            "--cc",
            commit_hash,
        ],
        PATCH_MAX_BYTES,
    )
    if patch is None:
        return None
    result["patch"], result["patch_truncated"] = _truncate_patch(patch)
    result["command"] = f"git -c core.quotepath=false show {commit_hash}"
    return result


def _parse_ref_line(line: str) -> dict[str, Any] | None:
    fields = line.split(REF_SEPARATOR)
    if len(fields) not in {7, 8} or not fields[0]:
        return None
    name, commit_hash, upstream, track, date, head, refname = fields[:7]
    worktree_path = fields[7] if len(fields) == 8 else ""
    if refname.startswith("refs/remotes/") and refname.endswith("/HEAD"):
        return None
    is_remote = refname.startswith("refs/remotes/")
    return {
        "name": name,
        "hash": commit_hash,
        "upstream": upstream or None,
        "track": track or None,
        "date": date,
        "current": head.strip() == "*",
        "merged": False,
        "remote": is_remote,
        "worktree": paths.to_host(worktree_path.strip()) if worktree_path.strip() else None,
    }


def get_branches(repo: str) -> dict[str, Any] | None:
    """ローカル/リモート ref と origin/HEAD 基準の merged 状態を返す。"""
    refs = gitinfo._run(repo, ["for-each-ref", f"--format={REF_FORMAT}", "refs/heads", "refs/remotes"])
    if refs is None:
        return None
    default_branch = gitinfo.default_branch(repo)
    merged: set[str] | None = None
    if default_branch:
        merged_raw = gitinfo._run(
            repo,
            [
                "branch",
                "--merged",
                f"refs/remotes/origin/{default_branch}",
                "--format=%(refname:short)",
            ],
        )
        if merged_raw is not None:
            merged = {line.strip() for line in merged_raw.splitlines() if line.strip()}
    local: list[dict[str, Any]] = []
    remotes: list[dict[str, Any]] = []
    for line in refs.splitlines():
        branch = _parse_ref_line(line)
        if branch is None:
            continue
        # Without origin/HEAD Git has not supplied a trustworthy merge target;
        # keep the fact unavailable instead of treating the current checkout's
        # reachability as project completion.
        branch["merged"] = branch["name"] in merged if merged is not None and not branch["remote"] else None
        if branch.pop("remote"):
            remotes.append(branch)
        else:
            local.append(branch)

    return {
        "local": local,
        "remotes": remotes,
        "command": "git branch -vv",
    }
