"""gitdash backend。読み取り専用。fetch 以外は git に書き込まない。"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import config, detail, gitinfo, graph, paths, scanner, store
from app.bus import bus
from app.watcher import Watcher

# ホストパスをキーにした現在の状態
STATE: dict[str, dict[str, Any]] = {}
STATE_LOCK = threading.Lock()

pool = ThreadPoolExecutor(max_workers=config.WORKERS, thread_name_prefix="git")
fetch_pool = ThreadPoolExecutor(max_workers=config.FETCH_WORKERS, thread_name_prefix="fetch")

scanning = {"active": False, "found": 0}
watcher: Watcher | None = None

# 自分が走らせた git status も .git/index を書き戻すため、inotify が自分自身を
# 起こし続ける。取得直後の一定時間はイベントを捨てる
SUPPRESS_SEC = 3.0
_suppress: dict[str, float] = {}

# 同一リポジトリで git を並行実行すると index.lock を奪い合って壊れる
_repo_locks: dict[str, threading.Lock] = {}
_repo_locks_guard = threading.Lock()

# inotify は 1 操作で複数イベントを出すのでまとめてから叩く
DEBOUNCE_SEC = 1.0
_pending: set[str] = set()
_pending_groups: dict[str, str] = {}
_pending_task: asyncio.Task | None = None

MAX_GRAPH_LIMIT = 2_000


def _repo_lock_key(host_path: str) -> str:
    """Use one lock for every worktree belonging to the same repository."""
    with STATE_LOCK:
        known = STATE.get(host_path)
        common = known.get("common_dir") if known else None
    if common:
        return os.path.realpath(os.path.abspath(common))

    container_path = paths.to_container(host_path)
    layout = scanner.repo_layout(container_path)
    if layout is not None:
        return os.path.realpath(os.path.abspath(paths.to_host(layout.common_root)))
    return os.path.realpath(os.path.abspath(host_path))


def _repo_lock(host_path: str) -> threading.Lock:
    """Return the lock shared by the main repository and linked worktrees."""
    key = _repo_lock_key(host_path)
    with _repo_locks_guard:
        lock = _repo_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _repo_locks[key] = lock
        return lock


def _repo_context(host_path: str) -> dict[str, Any]:
    """Copy worktree metadata needed when a cached row is refreshed."""
    with STATE_LOCK:
        known = STATE.get(host_path, {})
        return {
            key: known[key]
            for key in (
                "common_dir",
                "is_worktree",
                "worktree_state",
                "worktree",
                "merged",
                "merged_branches",
                "merged_branch",
                "branch",
                "detached",
            )
            if key in known
        }


def _known_repo(host_path: str) -> str:
    with STATE_LOCK:
        if host_path not in STATE:
            raise HTTPException(status_code=404, detail="リポジトリが見つかりません")
    return paths.to_container(host_path)


def _build_graph_sync(
    host_path: str,
    repo: str,
    all_refs: bool,
    limit: int,
) -> dict[str, Any] | None:
    with _repo_lock(host_path):
        return graph.build(repo, all_refs, limit)


def _get_commit_sync(host_path: str, repo: str, commit_hash: str) -> dict[str, Any] | None:
    with _repo_lock(host_path):
        return detail.get_commit(repo, commit_hash)


def _get_branches_sync(host_path: str, repo: str) -> dict[str, Any] | None:
    with _repo_lock(host_path):
        return detail.get_branches(repo)


def _upsert(repo: dict[str, Any]) -> None:
    with STATE_LOCK:
        existing = STATE.get(repo["path"], {})
        merged = {**existing, **repo}
        STATE[repo["path"]] = merged
    bus.publish("repo", merged)


def _stub(
    container_path: str,
    mtime: float,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """探索で見つかった直後の、まだ git を叩いていない行。"""
    stub = {
        "path": paths.to_host(container_path),
        "name": os.path.basename(container_path.rstrip("/")),
        "activity": mtime,
        "pending": True,
    }
    if context:
        stub.update(context)
    return stub


def _suppress_key(host_path: str) -> str:
    return _repo_lock_key(host_path)


def _refresh_sync(
    host_path: str,
    fetch: bool = False,
    context: dict[str, Any] | None = None,
    refresh_project_metadata: bool = False,
) -> dict[str, Any]:
    container = paths.to_container(host_path)
    with STATE_LOCK:
        existing_fetched_at = STATE.get(host_path, {}).get("fetched_at")
    context = context if context is not None else _repo_context(host_path)
    with _repo_lock(host_path):
        if refresh_project_metadata and context.get("common_dir"):
            common_host = context["common_dir"]
            worktrees = gitinfo.list_worktrees(paths.to_container(common_host))
            merged = gitinfo.merged_branches(paths.to_container(common_host))
            default_branch = gitinfo.default_branch(paths.to_container(common_host))
            if worktrees is not None:
                project_contexts = _worktree_contexts(
                    common_host,
                    worktrees,
                    merged or set(),
                    default_branch,
                )
                with STATE_LOCK:
                    for path, current_context in project_contexts.items():
                        if path in STATE:
                            STATE[path].update(current_context)
                context = project_contexts.get(host_path, context)
        suppress_until = time.time() + SUPPRESS_SEC
        _suppress[host_path] = suppress_until
        _suppress[_suppress_key(host_path)] = suppress_until
        result = gitinfo.collect(container, fetch=fetch, context=context)
        if not fetch:
            result["fetched_at"] = existing_fetched_at
        result["activity"] = scanner.activity_mtime(container)
        result["pending"] = False
        # git の書き込みが落ち着くまで、取得完了時点から数える
        suppress_until = time.time() + SUPPRESS_SEC
        _suppress[host_path] = suppress_until
        _suppress[_suppress_key(host_path)] = suppress_until
    return result


async def _refresh_many(
    host_paths: list[str],
    fetch: bool = False,
    contexts: dict[str, dict[str, Any]] | None = None,
    refresh_project_metadata: bool = False,
) -> None:
    loop = asyncio.get_running_loop()
    executor = fetch_pool if fetch else pool
    tasks = [
        loop.run_in_executor(
            executor,
            _refresh_sync,
            p,
            fetch,
            (contexts or {}).get(p),
            refresh_project_metadata,
        )
        for p in host_paths
    ]
    for coro in asyncio.as_completed(tasks):
        try:
            _upsert(await coro)
        except Exception:
            continue


def _path_key(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _worktree_contexts(
    common_host: str,
    worktrees: list[dict[str, Any]],
    merged: set[str],
    default_branch: str | None,
) -> dict[str, dict[str, Any]]:
    """Build current project metadata from Git's worktree and merged refs."""
    common_key = _path_key(common_host)
    checked_out = {
        item.get("branch")
        for item in worktrees
        if item.get("branch")
    }
    main_branch = next(
        (
            item.get("branch")
            for item in worktrees
            if _path_key(paths.to_host(os.path.abspath(str(item.get("path", "")))))
            == common_key
        ),
        None,
    )
    protected = {name for name in (main_branch, default_branch) if name}
    merged_candidates = sorted(merged - protected)
    orphaned = [name for name in merged_candidates if name not in checked_out]

    contexts: dict[str, dict[str, Any]] = {}
    for item in worktrees:
        raw_path = item.get("path")
        if not raw_path:
            continue
        host_path = paths.to_host(os.path.abspath(str(raw_path)))
        is_main = _path_key(host_path) == common_key
        branch = item.get("branch")
        context: dict[str, Any] = {
            "common_dir": common_host,
            "is_worktree": not is_main,
            "worktree_state": None if is_main else item.get("state"),
            "worktree": host_path if not is_main else None,
            "merged": bool(branch and not is_main and branch in merged),
            "merged_branches": merged_candidates,
            "merged_branch": orphaned[0] if is_main and orphaned else None,
            "branch": branch,
            "detached": bool(item.get("detached", False)),
        }
        contexts[host_path] = context
    return contexts


def _base_worktree_context(container_path: str) -> tuple[str, dict[str, Any]]:
    """Build metadata that can be obtained without starting a git process."""
    host_path = paths.to_host(container_path)
    layout = scanner.repo_layout(container_path)
    if layout is None:
        common_dir = host_path
        is_worktree = False
    else:
        common_dir = paths.to_host(layout.common_root)
        is_worktree = layout.is_worktree
    return host_path, {
        "common_dir": common_dir,
        "is_worktree": is_worktree,
        "worktree_state": None,
        "worktree": host_path if is_worktree else None,
        "merged": False,
    }


def _list_worktrees_sync(
    host_path: str,
) -> tuple[list[dict[str, Any]] | None, set[str] | None, str | None]:
    """List one common repository and its merged branches under one lock."""
    container_path = paths.to_container(host_path)
    with _repo_lock(host_path):
        worktrees = gitinfo.list_worktrees(container_path)
        if worktrees is None:
            return None, None, None
        merged = gitinfo.merged_branches(container_path)
        default_branch = gitinfo.default_branch(container_path)
    return worktrees, merged, default_branch


async def _discover() -> None:
    """探索し、common repository 単位で範囲外 worktree も補完する。"""
    scanning["active"] = True
    scanning["found"] = 0
    bus.publish("scan", {"active": True, "found": 0})

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def walk() -> None:
        try:
            for path in scanner.find_repos():
                loop.call_soon_threadsafe(queue.put_nowait, path)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=walk, daemon=True, name="scan").start()

    # key -> (host path, container path, activity mtime, context)
    discovered: dict[str, dict[str, Any]] = {}
    # key -> main/common host path and paths yielded by the filesystem scan
    groups: dict[str, dict[str, Any]] = {}

    def publish_stub(
        container_path: str,
        mtime: float,
        context: dict[str, Any],
        host_path: str,
    ) -> None:
        stub = _stub(container_path, mtime, context)
        # Worktree paths reported by git are canonical state keys.  Keep the
        # explicit host path when the path came from a list outside the scan.
        stub["path"] = host_path
        with STATE_LOCK:
            existing = STATE.get(host_path, {})
            state = {**existing, **stub}
            STATE[host_path] = state
        bus.publish("repo", state)

    def add_record(
        container_path: str,
        mtime: float,
        context: dict[str, Any],
        *,
        publish: bool,
    ) -> str:
        host_path = paths.to_host(container_path)
        key = _path_key(host_path)
        record = discovered.get(key)
        if record is None:
            record = {
                "host_path": host_path,
                "container_path": container_path,
                "mtime": mtime,
                "context": dict(context),
            }
            discovered[key] = record
            if publish:
                publish_stub(container_path, mtime, record["context"], host_path)
        else:
            record["mtime"] = max(record["mtime"], mtime)
            record["context"].update(context)
            if publish:
                publish_stub(
                    record["container_path"],
                    record["mtime"],
                    record["context"],
                    record["host_path"],
                )
        return key

    while True:
        path = await queue.get()
        if path is None:
            break
        host_path, context = _base_worktree_context(path)
        mtime = scanner.activity_mtime(path)
        key = add_record(path, mtime, context, publish=True)
        layout = scanner.repo_layout(path)
        common_container = layout.common_root if layout is not None else path
        common_host = paths.to_host(common_container)
        group_key = _path_key(common_host)
        group = groups.setdefault(
            group_key,
            {
                "common_host": common_host,
                "main_host": common_host,
                "scan_paths": [],
            },
        )
        group["scan_paths"].append(path)
        if not os.path.isdir(paths.to_container(group["main_host"])):
            group["main_host"] = host_path

        # ``found`` counts unique paths, not duplicate scanner hits.
        scanning["found"] = len(discovered)
        if watcher is not None:
            watcher.watch(path)

    # A worktree can live outside SCAN_ROOT.  Resolve each common repository
    # once, and make every git invocation in discovery pass through its lock.
    for group in groups.values():
        result = await loop.run_in_executor(
            pool,
            _list_worktrees_sync,
            group["main_host"],
        )
        worktrees, merged, default_branch = result
        if worktrees is None:
            continue
        merged = merged or set()
        common_host = group["common_host"]
        common_key = _path_key(common_host)
        project_contexts = _worktree_contexts(
            common_host,
            worktrees,
            merged,
            default_branch,
        )
        for worktree_info in worktrees:
            raw_path = worktree_info.get("path")
            if not raw_path:
                continue
            container_path = os.path.abspath(str(raw_path))
            host_path = paths.to_host(container_path)
            is_main = _path_key(host_path) == common_key
            context = project_contexts[host_path]
            key = add_record(
                container_path,
                scanner.activity_mtime(container_path),
                context,
                publish=True,
            )
            record = discovered[key]
            # Use the exact host path in a remove command and in the API when
            # the scanner and worktree list used different path spellings.
            record["context"]["worktree"] = host_path if not is_main else None
            record["context"]["common_dir"] = common_host
            record["context"]["is_worktree"] = not is_main
            record["context"].update(context)
            if watcher is not None and os.path.isdir(container_path):
                watcher.watch(container_path)

    scanning["active"] = False
    bus.publish("scan", {"active": False, "found": len(discovered)})

    # 活動が新しい順。git を 1 度も起動する前に順序が決まっている
    ordered_records = sorted(
        discovered.values(),
        key=lambda record: record["mtime"],
        reverse=True,
    )
    ordered = [record["host_path"] for record in ordered_records]
    contexts = {record["host_path"]: record["context"] for record in ordered_records}

    # 消えたリポジトリを落とす
    alive = set(ordered)
    with STATE_LOCK:
        gone = [p for p in STATE if p not in alive]
        for p in gone:
            STATE.pop(p, None)
    for p in gone:
        if watcher is not None:
            watcher.unwatch(paths.to_container(p))
        bus.publish("removed", {"path": p})

    await _refresh_many(ordered, contexts=contexts)
    store.save(STATE)
    bus.publish("done", {"count": len(ordered)})

    if config.FETCH_ENABLED:
        asyncio.create_task(_fetch_round(ordered))


async def _fetch_round(host_paths: list[str]) -> None:
    """ネットワーク処理。ローカルとは別プールで、画面が埋まった後に走る。"""
    now = time.time()
    projects: dict[str, list[str]] = {}
    with STATE_LOCK:
        for p in host_paths:
            repo = STATE.get(p) or {}
            common = repo.get("common_dir") or p
            projects.setdefault(common, []).append(p)

        targets: list[tuple[str, str, list[str]]] = []
        for common, members in projects.items():
            representative = next(
                (
                    path
                    for path in members
                    if path == common and (STATE.get(path) or {}).get("remote")
                ),
                None,
            )
            if representative is None:
                representative = next(
                    (path for path in members if (STATE.get(path) or {}).get("remote")),
                    None,
                )
            if representative is None:
                continue
            last = max((STATE.get(path) or {}).get("fetched_at") or 0 for path in members)
            if now - last >= config.FETCH_INTERVAL_SEC:
                targets.append((common, representative, members))

    if not targets:
        return
    bus.publish("fetch", {"active": True, "total": len(targets)})
    loop = asyncio.get_running_loop()

    async def fetch_project(
        common: str,
        representative: str,
        members: list[str],
    ) -> tuple[str, str, list[str], dict[str, Any]]:
        fetched = await loop.run_in_executor(
            fetch_pool,
            _refresh_sync,
            representative,
            True,
        )
        fetched_at = fetched.get("fetched_at")
        if fetched_at is None:
            return common, representative, members, fetched
        with STATE_LOCK:
            for path in members:
                if path in STATE:
                    STATE[path]["fetched_at"] = fetched_at
        # Fetch can change merged/ahead/behind state. Recompute project
        # metadata after refs have moved, without executing another fetch.
        result = await loop.run_in_executor(
            fetch_pool,
            _refresh_sync,
            representative,
            False,
            None,
            True,
        )
        return common, representative, members, result

    fetch_tasks = [fetch_project(*target) for target in targets]
    refresh_after_fetch: list[str] = []
    for future in asyncio.as_completed(fetch_tasks):
        try:
            _common, representative, members, result = await future
        except Exception:
            continue
        _upsert(result)
        fetched_at = result.get("fetched_at")
        if fetched_at is None:
            continue
        with STATE_LOCK:
            for path in members:
                if path in STATE:
                    STATE[path]["fetched_at"] = fetched_at
        refresh_after_fetch.extend(path for path in members if path != representative)
    if refresh_after_fetch:
        await _refresh_many(refresh_after_fetch)
    store.save(STATE)
    bus.publish("fetch", {"active": False, "total": len(targets)})


def _load_cached_state() -> dict[str, dict[str, Any]]:
    """Discard rows from the pre-worktree cache schema before first SSE."""
    cached: dict[str, dict[str, Any]] = {}
    for host_path, repo in store.load().items():
        if not isinstance(host_path, str) or not isinstance(repo, dict):
            continue
        if not isinstance(repo.get("common_dir"), str):
            continue
        if not isinstance(repo.get("is_worktree"), bool):
            continue
        if repo.get("worktree_state") not in {"ok", "prunable", "locked", None}:
            continue
        if not (
            os.path.isdir(paths.to_container(host_path))
            or repo.get("worktree_state") in {"prunable", "locked"}
        ):
            continue
        cached[host_path] = repo
    return cached


async def _drain_pending() -> None:
    global _pending_task
    await asyncio.sleep(DEBOUNCE_SEC)
    targets = [
        p
        for p in _pending
        if time.time() >= max(_suppress.get(p, 0), _suppress.get(_suppress_key(p), 0))
    ]
    _pending.clear()
    _pending_groups.clear()
    _pending_task = None
    if targets:
        await _refresh_many(targets, refresh_project_metadata=True)


def _on_watch_event(container_path: str) -> None:
    """inotify スレッドから呼ばれる。イベントループへ受け渡す。"""
    host_path = paths.to_host(container_path)
    # 自分の git 実行が起こしたイベントなら捨てる
    if time.time() < max(
        _suppress.get(host_path, 0),
        _suppress.get(_suppress_key(host_path), 0),
    ):
        return
    loop = getattr(app.state, "loop", None)
    if loop is None:
        return

    def schedule() -> None:
        global _pending_task
        target = host_path
        group = _suppress_key(target)
        previous = _pending_groups.get(group)
        if previous is not None and previous != target:
            # A linked worktree commit also emits an event in the shared git
            # directory.  Keep one representative per common repository and
            # prefer the linked path because its private HEAD changed.
            with STATE_LOCK:
                current = STATE.get(target, {})
                old = STATE.get(previous, {})
            if not current.get("is_worktree") and old.get("is_worktree"):
                target = previous
            else:
                _pending.discard(previous)
        _pending.add(target)
        _pending_groups[group] = target
        if _pending_task is None or _pending_task.done():
            _pending_task = asyncio.create_task(_drain_pending())

    loop.call_soon_threadsafe(schedule)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global watcher
    loop = asyncio.get_running_loop()
    _app.state.loop = loop
    bus.bind(loop)

    # 探索せずキャッシュから即座に立ち上げる
    cached = _load_cached_state()
    with STATE_LOCK:
        STATE.update(cached)

    if config.WATCH_ENABLED:
        watcher = Watcher(_on_watch_event)
        watcher.start()
        if watcher.available:
            for host_path in list(STATE):
                container = paths.to_container(host_path)
                if os.path.isdir(container):
                    watcher.watch(container)

    asyncio.create_task(_discover())
    yield

    if watcher is not None:
        watcher.stop()
    pool.shutdown(wait=False)
    fetch_pool.shutdown(wait=False)


app = FastAPI(title="gitdash", docs_url="/api/docs", lifespan=lifespan)


@app.get("/api/repos")
async def get_repos() -> dict[str, Any]:
    with STATE_LOCK:
        repos = list(STATE.values())
    repos.sort(key=lambda r: r.get("activity", 0), reverse=True)
    return {
        "count": len(repos),
        "scanning": scanning["active"],
        "repos": repos,
        "commands": {
            "status": "git status -sb",
            "log": "git log --oneline --graph --all",
        },
    }


@app.get("/api/repo/graph")
async def get_repo_graph(
    path: str,
    all: bool = False,
    limit: int = 200,
) -> dict[str, Any]:
    if limit < 1:
        raise HTTPException(status_code=422, detail="limit は 1 以上で指定してください")
    if limit > MAX_GRAPH_LIMIT:
        raise HTTPException(
            status_code=422,
            detail=f"limit は {MAX_GRAPH_LIMIT} 以下で指定してください",
        )
    repo = _known_repo(path)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        pool,
        _build_graph_sync,
        path,
        repo,
        all,
        limit,
    )
    if result is None:
        raise HTTPException(status_code=502, detail="git log を実行できませんでした")
    return result


@app.get("/api/repo/commit")
async def get_repo_commit(path: str, hash: str) -> dict[str, Any]:
    repo = _known_repo(path)
    if not detail.valid_hash(hash):
        raise HTTPException(status_code=400, detail="不正なコミットハッシュです")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(pool, _get_commit_sync, path, repo, hash)
    if result is None:
        raise HTTPException(status_code=404, detail="コミットが見つかりません")
    return result


@app.get("/api/repo/branches")
async def get_repo_branches(path: str) -> dict[str, Any]:
    repo = _known_repo(path)
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(pool, _get_branches_sync, path, repo)
    if result is None:
        raise HTTPException(status_code=502, detail="ブランチ一覧を取得できませんでした")
    return result


@app.get("/api/stream")
async def stream() -> StreamingResponse:
    queue = bus.subscribe()

    async def gen():
        with STATE_LOCK:
            snapshot = list(STATE.values())
        snapshot.sort(key=lambda r: r.get("activity", 0), reverse=True)
        yield f"event: snapshot\ndata: {json.dumps(snapshot, ensure_ascii=False)}\n\n"
        try:
            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class RefreshRequest(BaseModel):
    paths: list[str]
    fetch: bool = False


@app.post("/api/refresh")
async def refresh(req: RefreshRequest) -> dict[str, Any]:
    """可視領域の優先取得に使う。フロントの IntersectionObserver から呼ばれる。"""
    with STATE_LOCK:
        known = [p for p in req.paths if p in STATE]
    asyncio.create_task(_refresh_many(known, fetch=req.fetch))
    return {"queued": len(known)}


@app.post("/api/rescan")
async def rescan() -> dict[str, Any]:
    if scanning["active"]:
        return {"started": False, "reason": "既に走査中です"}
    asyncio.create_task(_discover())
    return {"started": True}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "repos": len(STATE),
        "scanning": scanning["active"],
        "watching": watcher is not None and watcher.available,
        "fetch": config.FETCH_ENABLED,
    }
