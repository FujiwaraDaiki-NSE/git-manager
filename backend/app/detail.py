"""コミット詳細とブランチ一覧の git 出力を API 用に変換する。"""
from __future__ import annotations

import re
from typing import Any

from app import gitinfo

PATCH_MAX_BYTES = 200_000
HASH_RE = re.compile(r"^[0-9a-fA-F]{4,64}$")
REF_SEPARATOR = "\x1f"
# refname:short だけでは slash 付き local branch と remote を区別できない。
# 最後の full ref は分類専用で、レスポンスには含めない。
REF_FORMAT = (
    "%(refname:short)%1f%(objectname:short)%1f%(upstream:short)"
    "%1f%(upstream:track)%1f%(committerdate:iso-strict)%1f%(HEAD)"
    "%1f%(refname)"
)


def valid_hash(value: str) -> bool:
    return HASH_RE.fullmatch(value) is not None


def _parse_numstat(raw: str) -> dict[str, Any] | None:
    lines = raw.splitlines()
    if not lines:
        return None

    header = lines[0].split(REF_SEPARATOR, 4)
    if len(header) != 5 or not header[0]:
        return None
    commit_hash, subject, author, date, parents = header

    files: list[dict[str, Any]] = []
    for line in lines[1:]:
        fields = line.split("\t", 2)
        if len(fields) != 3:
            continue
        additions, deletions, path = fields
        if additions != "-" and not additions.isdecimal():
            continue
        if deletions != "-" and not deletions.isdecimal():
            continue
        files.append(
            {
                "additions": additions if additions == "-" else int(additions),
                "deletions": deletions if deletions == "-" else int(deletions),
                "path": path,
                "binary": additions == "-" and deletions == "-",
            }
        )

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
            "--format=%H%x1f%s%x1f%an%x1f%cI%x1f%P",
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
    result["command"] = f"git show {commit_hash}"
    return result


def _parse_ref_line(line: str) -> dict[str, Any] | None:
    fields = line.split(REF_SEPARATOR)
    if len(fields) != 7 or not fields[0]:
        return None
    name, commit_hash, upstream, track, date, head, refname = fields
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
    }


def get_branches(repo: str) -> dict[str, Any] | None:
    """ローカル/リモート ref と HEAD にマージ済みのローカル ref を返す。"""
    refs = gitinfo._run(repo, ["for-each-ref", f"--format={REF_FORMAT}", "refs/heads", "refs/remotes"])
    if refs is None:
        return None
    merged_raw = gitinfo._run(repo, ["branch", "--merged", "HEAD", "--format=%(refname:short)"])
    if merged_raw is None:
        merged = set()
    else:
        merged = {line.strip() for line in merged_raw.splitlines() if line.strip()}
    local: list[dict[str, Any]] = []
    remotes: list[dict[str, Any]] = []
    for line in refs.splitlines():
        branch = _parse_ref_line(line)
        if branch is None:
            continue
        branch["merged"] = branch["name"] in merged
        if branch.pop("remote"):
            remotes.append(branch)
        else:
            local.append(branch)

    return {
        "local": local,
        "remotes": remotes,
        "command": "git branch -vv",
    }
