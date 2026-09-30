"""Read one bounded page of a branch's history at immutable Git heads."""
from __future__ import annotations

from typing import Any

from app import gitinfo

PAGE_SIZE = 200
FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P"


def _parse(raw: str) -> list[dict[str, Any]] | None:
    commits = []
    for line in raw.splitlines():
        fields = line.split("\x1f")
        if len(fields) != 6:
            return None
        commit_hash, short, subject, author, date, parents = fields
        commits.append({"hash": commit_hash, "short": short, "subject": subject,
                        "author": author, "date": date, "parents": parents.split()})
    return commits


def read_tips(repo: str, heads: list[str]) -> list[dict[str, Any]] | None:
    """Read all requested tips independently of their distance in history.

    Deleted PR heads can be absent locally. Git skips those objects and the
    caller compares returned hashes with each row's expected heads.
    """
    unique_heads = list(dict.fromkeys(heads))
    requested_heads = set(unique_heads)
    commits = []
    for offset in range(0, len(unique_heads), PAGE_SIZE):
        raw = gitinfo._run(repo, [
            "log", "--no-walk=unsorted", "--ignore-missing", f"--format={FORMAT}",
            *unique_heads[offset:offset + PAGE_SIZE], "--",
        ])
        if raw is None:
            return None
        page = _parse(raw)
        if page is None:
            return None
        commits.extend(commit for commit in page if commit["hash"] in requested_heads)
    return commits


def read_page(repo: str, heads: list[str], offset: int) -> dict[str, Any] | None:
    if not heads:
        return {"commits": [], "next_offset": None}
    raw = gitinfo._run(repo, [
        "log", "--date-order", f"--skip={offset}", f"--max-count={PAGE_SIZE + 1}",
        f"--format={FORMAT}", *heads, "--",
    ])
    if raw is None:
        return None
    commits = _parse(raw)
    if commits is None:
        return None
    return {"commits": commits[:PAGE_SIZE],
            "next_offset": offset + PAGE_SIZE if len(commits) > PAGE_SIZE else None}
