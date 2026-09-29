import asyncio
import time

from app import main


def test_changes_during_suppression_are_refreshed_after_deadline(monkeypatch):
    path = '/e2e/repository'
    monkeypatch.setattr(main, '_pending', set())
    monkeypatch.setattr(main, '_pending_task', None)
    monkeypatch.setattr(main, '_suppress', {path: time.time() + .08})
    monkeypatch.setattr(main, '_suppress_key', lambda value: value)
    monkeypatch.setattr(main.paths, 'to_host', lambda value: value)
    monkeypatch.setattr(main, 'DEBOUNCE_SEC', .001)
    monkeypatch.setattr(main, '_project_refresh_representatives', lambda paths: paths)
    calls = []

    async def refresh(paths, **kwargs):
        calls.append((paths, time.time()))

    monkeypatch.setattr(main, '_refresh_many', refresh)

    async def scenario():
        monkeypatch.setattr(main.app.state, 'loop', asyncio.get_running_loop(), raising=False)
        main._on_watch_event(path)
        await asyncio.sleep(.01)
        assert path in main._pending
        assert calls == []
        task = main._pending_task
        assert task is not None
        await asyncio.wait_for(task, timeout=1)
        assert calls[0][0] == [path]
        assert calls[0][1] >= main._suppress[path]
        assert not main._pending
        assert main._pending_task is None

    asyncio.run(scenario())


def test_events_arriving_during_refresh_are_not_lost(monkeypatch):
    path = '/e2e/repository'
    monkeypatch.setattr(main, '_pending', {path})
    monkeypatch.setattr(main, '_pending_task', None)
    monkeypatch.setattr(main, '_suppress', {})
    monkeypatch.setattr(main, '_suppress_key', lambda value: value)
    monkeypatch.setattr(main, 'DEBOUNCE_SEC', .001)
    monkeypatch.setattr(main, '_project_refresh_representatives', lambda paths: paths)
    calls = []

    async def refresh(paths, **kwargs):
        calls.append(paths)
        if len(calls) == 1:
            main._suppress[path] = time.time() + .01
            main._pending.add(path)

    monkeypatch.setattr(main, '_refresh_many', refresh)
    asyncio.run(main._drain_pending())
    assert calls == [[path], [path]]
    assert not main._pending
