"""Read one bounded page of a branch's history at immutable Git heads."""
from __future__ import annotations

import os
import subprocess
from collections.abc import Iterable
from typing import Any

from app import gitinfo, project_git_batch, project_facts

PAGE_SIZE = 200
FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P"


def missing_heads(repo: str, heads: Iterable[str]) -> set[str]:
    """Return only full object IDs explicitly reported missing by Git."""
    unique_heads = list(dict.fromkeys(heads))
    if not unique_heads:
        return set()
    requested = [head.encode("ascii") for head in unique_heads]
    try:
        result = subprocess.run(
            [gitinfo.GIT, "-C", repo, "cat-file", "--batch-check=%(objecttype)"],
            input=b"\n".join(requested) + b"\n",
            capture_output=True,
            timeout=gitinfo.config.GIT_TIMEOUT_SEC,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    lines = result.stdout.splitlines()
    if result.returncode != 0 or len(lines) != len(requested):
        return set()
    return {head for head, line in zip(unique_heads, lines) if line == head.encode("ascii") + b" missing"}


def _parse(raw: str) -> list[dict[str, Any]] | None:
    commits = []
    for line in raw.split("\n"):
        if not line:
            continue
        fields = line.split("\x1f")
        if len(fields) != 6:
            return None
        commit_hash, short, subject, author, date, parents = fields
        commits.append({"hash": commit_hash, "short": short, "subject": subject,
                        "author": author, "date": date, "parents": parents.split()})
    return commits


@project_facts.cached
def read_tips(repo: str, heads: list[str]) -> list[dict[str, Any]] | None:
    """Read all requested tips independently of their distance in history.

    Deleted PR heads can be absent locally. Git skips those objects and the
    caller compares returned hashes with each row's expected heads.
    """
    unique_heads = list(dict.fromkeys(heads))
    batch = project_git_batch.current(repo)
    if batch is not None and batch.commits is not None and all(head in batch.commits for head in unique_heads):
        return [dict(batch.commits[head]) for head in unique_heads]
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


# Callers only read/serialize the page; no presentation fields are added.
@project_facts.cached(copy_value=False)
def read_page(repo: str, heads: list[str], offset: int) -> dict[str, Any] | None:
    if not heads:
        return {"commits": [], "next_offset": None}
    args = ["log", "--date-order"]
    if offset != 0:
        args.append(f"--skip={offset}")
    args.extend([f"--max-count={PAGE_SIZE + 1}", f"--format={FORMAT}", *heads, "--"])
    raw = gitinfo._run(repo, args)
    if raw is None:
        return None
    commits = _parse(raw)
    if commits is None:
        return None
    return {"commits": commits[:PAGE_SIZE],
            "next_offset": offset + PAGE_SIZE if len(commits) > PAGE_SIZE else None}
