"""SQLite-backed Git observations; dynamic project fields are composed per read."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time

from app import config, github, project, project_facts, scanner
from app.bus import bus

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="project-snapshot")
_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_running: set[str] = set()


@contextmanager
def _connection():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(config.DATA_DIR / "project-snapshots.sqlite3", timeout=30)
    connection.execute("""CREATE TABLE IF NOT EXISTS project_snapshots (
        project_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        observed_at REAL NOT NULL, facts TEXT NOT NULL,
        failed_fingerprint TEXT, error TEXT)""")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def load(project_id, *, metadata_only=False):
    if not (config.DATA_DIR / "project-snapshots.sqlite3").exists():
        return None
    with _connection() as connection:
        columns = "fingerprint, observed_at, NULL, failed_fingerprint, error" if metadata_only else "fingerprint, observed_at, facts, failed_fingerprint, error"
        row = connection.execute(f"SELECT {columns} FROM project_snapshots WHERE project_id = ?", (project_id,)).fetchone()
    if row is None:
        return None
    return {"fingerprint": row[0], "observed_at": row[1], "facts": None if metadata_only else json.loads(row[2]), "failed_fingerprint": row[3], "error": row[4]}


def fingerprint(repo):
    """Track shared refs/reflogs plus every private HEAD and index, without Git."""
    layout = scanner.repo_layout(repo)
    if layout is None:
        raise RuntimeError("Gitディレクトリを取得できません")
    common = Path(layout.common_git_dir)
    files = [common / name for name in ("HEAD", "index", "config", "packed-refs", "shallow", "info/grafts")]
    for name in ("refs", "logs", "worktrees"):
        root = common / name
        if root.exists():
            files.extend(path for path in root.rglob("*") if path.is_file() and not path.name.endswith(".lock"))
    values = []
    for path in sorted(set(files)):
        try:
            stat = path.stat()
        except FileNotFoundError:
            values.append((str(path), None))
        else:
            values.append((str(path), stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size))
    return hashlib.sha256(json.dumps([2, values]).encode()).hexdigest()


def _validate(result):
    if result is None or result["graph"] is None or result["branch_rows"] is None:
        raise RuntimeError("プロジェクトのGit情報を取得できませんでした")
    if result["default_branch"] and result["default_hash"] is None:
        raise RuntimeError("デフォルトブランチの参照を取得できませんでした")
    for row in result["branch_rows"]:
        if row["history_heads"] and (not row["history_available"] or not row["commit_metadata_available"] or not row["tip_metadata_available"]):
            raise RuntimeError("ブランチの履歴を完全に取得できませんでした")
    for lane in result["lanes"]:
        if lane["head"] and lane["last_commit"] is None:
            raise RuntimeError("ブランチ先頭のコミットを取得できませんでした")
        if result["default_hash"] and lane["head"] and (lane["default_ahead"] is None or lane["default_behind"] is None):
            raise RuntimeError("デフォルトブランチとの差分を取得できませんでした")
    connections = result["branch_connections"]
    if (result["branch_rows"] and connections["ancestry_status"] in {"partial", "unavailable"}) or (result["branch_rows"] and connections["reflog_status"] != "available"):
        raise RuntimeError("ブランチ関係のGit情報を完全に取得できませんでした")
    if result["range"] == "all" and any(row.get("stats") is None for row in result["graph"]["rows"]):
        raise RuntimeError("コミットの集計を取得できませんでした")


def _build(repo, project_id, state_rows, repo_lock):
    # Both graph variants share the same fact map. Periods are never persisted.
    for _ in range(3):
        with repo_lock:
            before = fingerprint(repo)
            facts = {}
            with project_facts.using(facts):
                for range_name in ("all", "7d"):
                    result = project.build(repo, project_id, state_rows, range_name=range_name, github_data=github.unavailable("PR情報は未取得です"))
                    _validate(result)
            after = fingerprint(repo)
        if before == after:
            observed_at = time.time()
            with _connection() as connection:
                connection.execute("""INSERT INTO project_snapshots VALUES (?, ?, ?, ?, NULL, NULL)
                    ON CONFLICT(project_id) DO UPDATE SET fingerprint=excluded.fingerprint,
                    observed_at=excluded.observed_at, facts=excluded.facts,
                    failed_fingerprint=NULL, error=NULL""", (project_id, after, observed_at, json.dumps(facts, ensure_ascii=False)))
            return load(project_id)
    raise RuntimeError("Git状態が計算中に変化しました。再取得してください")


def _lock(project_id):
    with _guard:
        return _locks.setdefault(project_id, threading.Lock())


def _refresh(repo, project_id, state_rows, repo_lock):
    current = None
    try:
        with _lock(project_id):
            saved = load(project_id, metadata_only=True)
            current = fingerprint(repo)
            if saved is not None and saved["fingerprint"] == current:
                return
            _build(repo, project_id, state_rows, repo_lock)
    except Exception as error:
        with _connection() as connection:
            connection.execute("UPDATE project_snapshots SET failed_fingerprint=?, error=? WHERE project_id=?", (current, str(error), project_id))
    finally:
        with _guard:
            _running.discard(project_id)
        bus.publish_threadsafe("project", {"id": project_id})


def retry_failed(project_ids):
    """An explicit refresh/rescan may retry a failed observation unchanged."""
    if not (config.DATA_DIR / "project-snapshots.sqlite3").exists():
        return
    with _connection() as connection:
        connection.executemany("UPDATE project_snapshots SET failed_fingerprint=NULL, error=NULL WHERE project_id=? AND error IS NOT NULL", [(item,) for item in project_ids])


def refresh_existing(repo, project_id, state_rows, repo_lock):
    saved = load(project_id, metadata_only=True)
    if saved is None:
        return
    current = fingerprint(repo)
    if saved["fingerprint"] == current or saved["failed_fingerprint"] == current:
        return
    with _guard:
        if project_id in _running:
            return
        _running.add(project_id)
    bus.publish_threadsafe("project", {"id": project_id})
    _executor.submit(_refresh, repo, project_id, deepcopy(state_rows), repo_lock)


def get(repo, project_id, state_rows, repo_lock, range_name, as_of, load_github):
    saved = load(project_id)
    graph_key = json.dumps(["project.graph", [repo, None]], sort_keys=True, ensure_ascii=False)
    if saved is None or graph_key not in saved["facts"]:
        with _lock(project_id):
            saved = load(project_id)
            if saved is None or graph_key not in saved["facts"]:
                saved = _build(repo, project_id, state_rows, repo_lock)
    current = fingerprint(repo)
    stale = current != saved["fingerprint"]
    failed = stale and saved["failed_fingerprint"] == current
    if stale and not failed:
        refresh_existing(repo, project_id, state_rows, repo_lock)
    with project_facts.using(saved["facts"]):
        result = project.build(repo, project_id, state_rows, range_name=range_name, as_of=as_of, github_data=load_github())
    if result is None:
        raise RuntimeError("プロジェクト情報の合成に失敗しました")
    result["snapshot"] = {"observed_at": saved["observed_at"], "status": "failed" if failed else "refreshing" if stale else "ready", "error": saved["error"] if failed else None}
    return result
