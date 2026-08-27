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
_pending_task: asyncio.Task | None = None


def _repo_lock(host_path: str) -> threading.Lock:
    with _repo_locks_guard:
        lock = _repo_locks.get(host_path)
        if lock is None:
            lock = threading.Lock()
            _repo_locks[host_path] = lock
        return lock


def _known_repo(host_path: str) -> str:
    with STATE_LOCK:
        if host_path not in STATE:
            raise HTTPException(status_code=404, detail="リポジトリが見つかりません")
    return paths.to_container(host_path)


def _build_graph_sync(host_path: str, repo: str, all_refs: bool, limit: int) -> dict[str, Any]:
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


def _stub(container_path: str, mtime: float) -> dict[str, Any]:
    """探索で見つかった直後の、まだ git を叩いていない行。"""
    return {
        "path": paths.to_host(container_path),
        "name": os.path.basename(container_path.rstrip("/")),
        "activity": mtime,
        "pending": True,
    }


def _refresh_sync(host_path: str, fetch: bool = False) -> dict[str, Any]:
    container = paths.to_container(host_path)
    with _repo_lock(host_path):
        _suppress[host_path] = time.time() + SUPPRESS_SEC
        result = gitinfo.collect(container, fetch=fetch)
        result["activity"] = scanner.activity_mtime(container)
        result["pending"] = False
        # git の書き込みが落ち着くまで、取得完了時点から数える
        _suppress[host_path] = time.time() + SUPPRESS_SEC
    return result


async def _refresh_many(host_paths: list[str], fetch: bool = False) -> None:
    loop = asyncio.get_running_loop()
    executor = fetch_pool if fetch else pool
    tasks = [
        loop.run_in_executor(executor, _refresh_sync, p, fetch)
        for p in host_paths
    ]
    for coro in asyncio.as_completed(tasks):
        try:
            _upsert(await coro)
        except Exception:
            continue


async def _discover() -> None:
    """探索。見つけ次第 SSE に流し、活動が新しい順に状態取得する。"""
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

    discovered: list[tuple[str, float]] = []
    while True:
        path = await queue.get()
        if path is None:
            break
        mtime = scanner.activity_mtime(path)
        discovered.append((path, mtime))
        scanning["found"] = len(discovered)
        stub = _stub(path, mtime)
        with STATE_LOCK:
            if stub["path"] not in STATE:
                STATE[stub["path"]] = stub
        bus.publish("repo", STATE[stub["path"]])
        if watcher is not None:
            watcher.watch(path)

    scanning["active"] = False
    bus.publish("scan", {"active": False, "found": len(discovered)})

    # 活動が新しい順。git を 1 度も起動する前に順序が決まっている
    discovered.sort(key=lambda x: x[1], reverse=True)
    ordered = [paths.to_host(p) for p, _ in discovered]

    # 消えたリポジトリを落とす
    alive = set(ordered)
    with STATE_LOCK:
        gone = [p for p in STATE if p not in alive]
        for p in gone:
            STATE.pop(p, None)
    for p in gone:
        bus.publish("removed", {"path": p})

    await _refresh_many(ordered)
    store.save(STATE)
    bus.publish("done", {"count": len(ordered)})

    if config.FETCH_ENABLED:
        asyncio.create_task(_fetch_round(ordered))


async def _fetch_round(host_paths: list[str]) -> None:
    """ネットワーク処理。ローカルとは別プールで、画面が埋まった後に走る。"""
    now = time.time()
    targets = []
    with STATE_LOCK:
        for p in host_paths:
            repo = STATE.get(p) or {}
            if not repo.get("remote"):
                continue
            last = repo.get("fetched_at") or 0
            if now - last < config.FETCH_INTERVAL_SEC:
                continue
            targets.append(p)
    if not targets:
        return
    bus.publish("fetch", {"active": True, "total": len(targets)})
    await _refresh_many(targets, fetch=True)
    store.save(STATE)
    bus.publish("fetch", {"active": False, "total": len(targets)})


async def _drain_pending() -> None:
    global _pending_task
    await asyncio.sleep(DEBOUNCE_SEC)
    targets = [p for p in _pending if time.time() >= _suppress.get(p, 0)]
    _pending.clear()
    _pending_task = None
    if targets:
        await _refresh_many(targets)


def _on_watch_event(container_path: str) -> None:
    """inotify スレッドから呼ばれる。イベントループへ受け渡す。"""
    host_path = paths.to_host(container_path)
    # 自分の git 実行が起こしたイベントなら捨てる
    if time.time() < _suppress.get(host_path, 0):
        return
    loop = getattr(app.state, "loop", None)
    if loop is None:
        return

    def schedule() -> None:
        global _pending_task
        _pending.add(host_path)
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
    cached = store.load()
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
    if "command" not in result:
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
