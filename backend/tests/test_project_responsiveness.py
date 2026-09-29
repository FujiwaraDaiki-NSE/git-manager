"""The project list must not stall live updates or unrelated API requests."""
import asyncio
import threading

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
