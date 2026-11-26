"""Read current GitHub PR metadata with gh; never persist development history."""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app import config, gitinfo, paths, scanner
from app.bus import bus

_PR_PAGE_TIMEOUT_SEC = 15
_PR_PAGINATION_TIMEOUT_SEC = 45

# Response cache only: discard on restart, never retain old success after failure.
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_lock = threading.Lock()
_pending: dict[str, set[str]] = {}
_executor = ThreadPoolExecutor(max_workers=config.GITHUB_PR_WORKERS, thread_name_prefix="github-pr-refresh")


def unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason, "repository": None, "checked_at": None, "pulls": []}


def repository(repo: str) -> str | None:
    raw = gitinfo._run(repo, ["remote", "get-url", "origin"])
    if raw is None:
        return None
    match = re.fullmatch(r"(?:git@github\.com:|https://github\.com/|ssh://git@github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?/?", raw.strip())
    return match[1] if match else None


def load(repo: str) -> dict[str, Any]:
    return _load(repo, "merged", _read)


def load_open(repo: str) -> dict[str, Any]:
    return _load(repo, "open", _read_open)


def shutdown() -> None:
    _executor.shutdown(wait=False, cancel_futures=True)


def _load(repo: str, kind: str, reader) -> dict[str, Any]:
    name = repository(repo)
    if name is None:
        return {**unavailable("GitHubのoriginがないためPR情報は対象外です"), "status": "not_applicable"}
    key = f"{kind}:{name}"
    with _lock:
        cached = _cache.get(key)
        if cached is not None and time.monotonic() < cached[0]:
            return cached[1]
        if key in _pending:
            _pending[key].add(repo)
        else:
            _pending[key] = {repo}
            try:
                _executor.submit(_refresh, key, name, reader)
            except RuntimeError:
                del _pending[key]
                raise
        if cached is not None:
            return cached[1]
        return {**unavailable("GitHubに照会中です。完了すると自動で反映します"), "status": "pending", "repository": name}


def _refresh(key: str, name: str, reader) -> None:
    try:
        result = reader(name)
    except Exception:
        with _lock:
            del _pending[key]
        raise
    with _lock:
        # Replace stale success even when the refresh reports a failure.
        _cache[key] = (time.monotonic() + 60, result)
        repos = _pending.pop(key)
    project_ids = {
        paths.to_host(layout.common_root)
        for repo in repos if (layout := scanner.repo_layout(repo)) is not None
    }
    for project_id in project_ids:
        bus.publish_threadsafe("project", {"id": project_id})


def _read(name: str) -> dict[str, Any]:
    result = {**unavailable("PR情報を取得できません。ghの認証・接続を確認してください"),
              "repository": name, "checked_at": time.time()}
    # Explicit host and repo prevent a repository from redirecting credentials.
    owner, repo_name = name.split("/")
    query = """query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: MERGED, first: 100, after: $endCursor,
          orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes { number url title mergedAt mergeCommit { oid } baseRefName headRefName headRefOid
            headRepository { nameWithOwner } baseRepository { nameWithOwner }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }"""
    command = ["gh", "api", "--hostname", "github.com", "graphql",
               "-f", f"query={query}", "-f", f"owner={owner}", "-f", f"name={repo_name}"]
    cursor = None
    complete = False
    pulls = []
    deadline = time.monotonic() + _PR_PAGINATION_TIMEOUT_SEC
    try:
        for _ in range(config.GITHUB_MERGED_PR_MAX_PAGES):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return result
            proc = subprocess.run(
                command if cursor is None else [*command, "-f", f"endCursor={cursor}"],
                capture_output=True, text=True, timeout=min(_PR_PAGE_TIMEOUT_SEC, remaining),
                env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_PAGER": "cat"},
            )
            if proc.returncode != 0:
                return result
            page = json.loads(proc.stdout)
            if not isinstance(page, dict) or page.get("errors"):
                raise ValueError("Invalid GraphQL page")
            connection = page["data"]["repository"]["pullRequests"]
            nodes = connection["nodes"]
            page_info = connection["pageInfo"]
            has_next = page_info["hasNextPage"]
            next_cursor = page_info["endCursor"]
            if not isinstance(nodes, list) or not isinstance(has_next, bool):
                raise ValueError("Invalid PR connection")
            if has_next and (not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor):
                raise ValueError("Invalid PR cursor")
            for item in nodes:
                merge_commit = item["mergeCommit"]
                head_repository = item["headRepository"]
                pull = {
                    "number": item["number"],
                    "url": item["url"],
                    "title": item["title"],
                    "merged_at": item["mergedAt"],
                    "merge": None if merge_commit is None else merge_commit["oid"],
                    "base": item["baseRefName"],
                    "head": item["headRefName"],
                    "head_sha": item["headRefOid"],
                    "head_repo": None if head_repository is None else head_repository["nameWithOwner"],
                    "base_repo": item["baseRepository"]["nameWithOwner"],
                }
                if (type(pull["number"]) is not int
                    or not all(isinstance(pull[key], str) for key in ("url", "title", "merged_at", "base", "head", "head_sha", "base_repo"))
                    or (merge_commit is not None and not isinstance(pull["merge"], str))
                    or (head_repository is not None and not isinstance(pull["head_repo"], str))):
                    raise ValueError("Invalid merged PR")
                pulls.append(pull)
            if not has_next:
                complete = True
                break
            cursor = next_cursor
        if time.monotonic() >= deadline:
            return result
        return {**result, "status": "available", "reason": None, "pulls": pulls,
                "complete": complete, "merged_count": len(pulls)}
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return result


def _read_open(name: str) -> dict[str, Any]:
    result = {**unavailable("オープンPRを取得できません。ghの認証・接続を確認してください"),
              "repository": name, "checked_at": time.time()}
    owner, repo_name = name.split("/")
    query = """query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 100, after: $endCursor) {
          nodes { number url title isDraft headRefName headRefOid baseRefName
            headRepository { nameWithOwner } reviewDecision
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }"""
    try:
        proc = subprocess.run(
            ["gh", "api", "--hostname", "github.com", "graphql", "--paginate",
             "-f", f"query={query}", "-f", f"owner={owner}", "-f", f"name={repo_name}"],
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
        has_next = True
        while pages:
            page, end = decoder.raw_decode(pages)
            if page.get("errors") or not has_next:
                raise ValueError("Invalid GraphQL page")
            connection = page["data"]["repository"]["pullRequests"]
            has_next = connection["pageInfo"]["hasNextPage"]
            if not isinstance(has_next, bool) or not isinstance(connection["nodes"], list):
                raise ValueError("Invalid PR connection")
            for item in connection["nodes"]:
                if (not isinstance(item["number"], int) or not isinstance(item["isDraft"], bool)
                    or not all(isinstance(item[key], str) for key in ("url", "title", "headRefName", "headRefOid", "baseRefName"))
                    or item["reviewDecision"] not in (None, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED")):
                    raise ValueError("Invalid open PR")
                head_repo = item["headRepository"]
                if head_repo is not None and not isinstance(head_repo["nameWithOwner"], str):
                    raise ValueError("Invalid head repository")
                commits = item["commits"]["nodes"]
                if not isinstance(commits, list) or len(commits) > 1:
                    raise ValueError("Invalid latest commit")
                rollup = commits[0]["commit"]["statusCheckRollup"] if commits else None
                state = rollup["state"] if rollup is not None else None
                if state not in (None, "SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"):
                    raise ValueError("Invalid CI state")
                pulls.append({key: item[key] for key in ("number", "url", "title", "isDraft", "headRefName", "headRefOid", "baseRefName", "reviewDecision")} |
                             {"headRepository": head_repo["nameWithOwner"] if head_repo is not None else None, "ciState": state})
            pages = pages[end:].lstrip()
        if has_next:
            raise ValueError("Incomplete PR pages")
        return {**result, "status": "available", "reason": None, "pulls": pulls}
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError, AttributeError):
        return result
