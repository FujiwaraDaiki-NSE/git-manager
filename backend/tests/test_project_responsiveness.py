"""The project list must not stall live updates or unrelated API requests."""
import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app import main


def test_project_list_keeps_event_loop_responsive(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def slow_summary(snapshot):
        started.set()
        release.wait(timeout=2)
        return []

    monkeypatch.setattr(main.project, "summary_rows", slow_summary)

    async def scenario():
        listing = asyncio.create_task(main.get_projects())
        try:
            await asyncio.sleep(0)
            assert await asyncio.to_thread(started.wait, 1)
            assert not listing.done()
            assert (await asyncio.wait_for(main.health(), timeout=.2))["ok"] is True
        finally:
            release.set()
            result = await listing
        assert result["projects"] == []

    asyncio.run(scenario())


def test_project_pr_load_bypasses_fetch_backlog(monkeypatch):
    def snapshot(repo, project_id, state_rows, lock, range_name, as_of, load_pr):
        return load_pr()

    monkeypatch.setattr(main.project_snapshots, "get", snapshot)
    monkeypatch.setattr(main.github, "load", lambda repo: {"merged": [repo]})
    monkeypatch.setattr(main.github, "load_open", lambda repo: [repo])
    executor = ThreadPoolExecutor(max_workers=4)
    monkeypatch.setattr(main, "fetch_pool", executor)
    backlog = [executor.submit(time.sleep, 0.5) for _ in range(40)]
    try:
        started = time.perf_counter()
        result = main._get_project_sync("/repo", "/repo", "/repo", {}, "current")
        elapsed = time.perf_counter() - started
        print(f"PR load with 40 queued fetch jobs: {elapsed:.6f}s")
        assert result == {"merged": ["/repo"], "open": ["/repo"]}
        assert elapsed < 1.0
        assert any(not job.done() for job in backlog)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
