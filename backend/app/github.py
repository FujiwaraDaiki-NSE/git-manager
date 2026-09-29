"""Read current GitHub PR metadata with gh; never persist development history."""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from typing import Any

from app import gitinfo

# Response cache only: discard on restart, never retain old success after failure.
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_lock = threading.Lock()
_repository_locks: dict[str, threading.Lock] = {}


def unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason, "repository": None, "checked_at": None, "pulls": []}


def repository(repo: str) -> str | None:
    raw = gitinfo._run(repo, ["remote", "get-url", "origin"])
    if raw is None:
        return None
    match = re.fullmatch(r"(?:git@github\.com:|https://github\.com/|ssh://git@github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?/?", raw.strip())
    return match[1] if match else None


def load(repo: str) -> dict[str, Any]:
    name = repository(repo)
    if name is None:
        return {**unavailable("GitHubのoriginがないためPR情報は対象外です"), "status": "not_applicable"}
    with _lock:
        repository_lock = _repository_locks.setdefault(name, threading.Lock())
    with repository_lock:
        cached = _cache.get(name)
        if cached is not None and time.monotonic() < cached[0]:
            return cached[1]
        result = _read(name)
        _cache[name] = (time.monotonic() + 60, result)
        return result


def _read(name: str) -> dict[str, Any]:
    result = {**unavailable("PR情報を取得できません。ghの認証・接続を確認してください"),
              "repository": name, "checked_at": time.time()}
    # Explicit host and repo prevent a repository from redirecting credentials.
    query = 'map(select(.merged_at != null) | {number, url: .html_url, merged_at, merge: .merge_commit_sha, base: .base.ref, head: .head.ref, head_sha: .head.sha, head_repo: .head.repo.full_name, base_repo: .base.repo.full_name})'
    try:
        proc = subprocess.run(
            ["gh", "api", "--hostname", "github.com", "--paginate", "--method", "GET",
             f"repos/{name}/pulls?state=closed&per_page=100", "--jq", query],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_PAGER": "cat"},
        )
        if proc.returncode != 0:
            return result
        pages = proc.stdout.strip()
        if not pages:
            return result
        decoder = json.JSONDecoder()
        pulls = []
        while pages:
            page, end = decoder.raw_decode(pages)
            if not isinstance(page, list):
                raise ValueError("Invalid PR page")
            for item in page:
                if not isinstance(item, dict) or not all(isinstance(item.get(key), str) for key in ("merge", "base", "head", "head_sha", "base_repo", "url", "merged_at")) or not isinstance(item.get("number"), int):
                    raise ValueError("Invalid PR")
                pulls.append(item)
            pages = pages[end:].lstrip()
        return {**result, "status": "available", "reason": None, "pulls": pulls}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return result
