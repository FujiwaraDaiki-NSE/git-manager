import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import main
from test_project import git, init_repo


def test_background_refresh_does_not_queue_ui_work(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def refresh(*args):
        started.set()
        assert release.wait(2)
        return None

    async def scenario():
        task = asyncio.create_task(main._refresh_many(['/repo']))
        try:
            assert await asyncio.to_thread(started.wait, 1)
            assert await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(main.pool, lambda: 'ui'),
                timeout=.5,
            ) == 'ui'
        finally:
            release.set()
            await task

    with ThreadPoolExecutor(max_workers=1) as ui, ThreadPoolExecutor(max_workers=1) as background:
        monkeypatch.setattr(main, 'pool', ui)
        monkeypatch.setattr(main, 'refresh_pool', background)
        monkeypatch.setattr(main, '_refresh_sync', refresh)
        asyncio.run(scenario())


@pytest.mark.parametrize('outcome,expected_time', [('success', 20), ('failure', 10)])
def test_fetch_releases_repository_lock_and_preserves_result(tmp_path, monkeypatch, outcome, expected_time):
    repo = tmp_path / 'repo'
    init_repo(repo)
    path = str(repo)
    monkeypatch.setattr(main.paths, 'to_container', lambda value: value)
    monkeypatch.setattr(main.paths, 'to_host', lambda value: value)
    monkeypatch.setattr(main.config, 'FETCH_ENABLED', True)
    monkeypatch.setattr(main, 'STATE', {path: {'fetched_at': 10}})
    monkeypatch.setattr(main, '_suppress', {})
    lock = threading.Lock()
    monkeypatch.setattr(main, '_repo_lock', lambda value: lock)
    started = threading.Event()
    release = threading.Event()
    status = {'attempted_at': 20, 'result': outcome, 'category': None, 'reason': None}
    calls = []

    def fetch(repo):
        calls.append(repo)
        started.set()
        assert release.wait(2)
        return status

    monkeypatch.setattr(main.gitinfo, 'do_fetch', fetch)
    collect = main.gitinfo.collect

    def collect_locked(*args, **kwargs):
        assert lock.locked()
        return collect(*args, **kwargs)

    monkeypatch.setattr(main.gitinfo, 'collect', collect_locked)
    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(main._refresh_sync, path, True)
        try:
            assert started.wait(1)
            assert lock.acquire(timeout=.5)
            lock.release()
        finally:
            release.set()
        row = result.result(timeout=2)
    assert row['fetch_status'] == status
    assert row['fetched_at'] == expected_time
    assert calls == [path]


def test_fetches_for_linked_worktrees_are_serialized(tmp_path, monkeypatch):
    repo = tmp_path / 'repo'
    init_repo(repo)
    worktree = tmp_path / 'worktree'
    git(repo, 'worktree', 'add', '-b', 'linked', str(worktree))
    monkeypatch.setattr(main.paths, 'to_container', lambda value: value)
    monkeypatch.setattr(main.paths, 'to_host', lambda value: value)
    monkeypatch.setattr(main.config, 'FETCH_ENABLED', True)
    monkeypatch.setattr(main, 'STATE', {})
    monkeypatch.setattr(main, '_suppress', {})
    monkeypatch.setattr(main, '_fetch_locks', {})
    started = threading.Event()
    release = threading.Event()
    second_requested = threading.Event()
    second_started = threading.Event()
    fetch_lock = main._fetch_lock

    def observed_fetch_lock(path):
        lock = fetch_lock(path)
        if path == str(worktree):
            second_requested.set()
        return lock

    def fetch(path):
        if path == str(repo):
            started.set()
            assert release.wait(2)
        else:
            second_started.set()
        return None

    monkeypatch.setattr(main, '_fetch_lock', observed_fetch_lock)
    monkeypatch.setattr(main.gitinfo, 'do_fetch', fetch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(main._refresh_sync, str(repo), True)
        try:
            assert started.wait(1)
            second = executor.submit(main._refresh_sync, str(worktree), True)
            assert second_requested.wait(1)
            assert not second_started.wait(.1)
        finally:
            release.set()
        first.result(timeout=2)
        second.result(timeout=2)
    assert second_started.is_set()
