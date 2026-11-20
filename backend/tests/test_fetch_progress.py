import asyncio

import pytest

from app import main
from test_project import git, init_repo


def test_fetch_progress_counts_repositories_and_failures(monkeypatch):
    states = {f'/{name}': {'path': f'/{name}', 'common_dir': f'/{name}', 'remote': 'origin', 'fetched_at': None} for name in ['success', 'failure', 'none', 'exception', 'no-status']}
    states['/linked'] = {**states['/success'], 'path': '/linked'}
    monkeypatch.setattr(main, 'STATE', states)
    monkeypatch.setattr(main, 'fetching', {'active': False, 'total': 99, 'done': 99, 'failed': 99})
    events = []
    monkeypatch.setattr(main.bus, 'publish', lambda kind, data: events.append(dict(data)) if kind == 'fetch' else None)
    monkeypatch.setattr(main, '_upsert', lambda result: None)
    monkeypatch.setattr(main.store, 'save', lambda state: None)

    def refresh(path, fetch, *args):
        if path == '/exception':
            raise RuntimeError('fetch failed')
        if path == '/none':
            return None
        return main._RefreshResult({**states[path], 'fetch_status': None if path == '/no-status' else {'result': 'success' if path == '/success' else 'failure'}}, state_published=True)

    monkeypatch.setattr(main, '_refresh_sync', refresh)
    asyncio.run(main._fetch_round(list(states)))
    assert events[0] == {'active': True, 'total': 5, 'done': 0, 'failed': 0}
    assert [event['done'] for event in events] == [0, 1, 2, 3, 4, 5, 5]
    assert all(0 <= right['failed'] - left['failed'] <= 1 for left, right in zip(events, events[1:]))
    assert events[-1] == {'active': False, 'total': 5, 'done': 5, 'failed': 4}


def test_overlapping_fetch_rounds_do_not_mix_progress(monkeypatch):
    states = {f'/{name}': {'path': f'/{name}', 'common_dir': f'/{name}', 'remote': 'origin', 'fetched_at': None} for name in ['a', 'b']}
    monkeypatch.setattr(main, 'STATE', states)
    monkeypatch.setattr(main, 'fetching', {'active': False, 'total': 0, 'done': 0, 'failed': 0})
    monkeypatch.setattr(main, '_fetch_round_lock', asyncio.Lock())
    events = []
    monkeypatch.setattr(main.bus, 'publish', lambda kind, data: events.append(dict(data)) if kind == 'fetch' else None)
    monkeypatch.setattr(main, '_upsert', lambda result: None)
    monkeypatch.setattr(main.store, 'save', lambda state: None)
    calls = []

    def refresh(path, fetch, *args):
        if fetch:
            calls.append(path)
        return main._RefreshResult({**states[path], 'fetched_at': main.time.time(), 'fetch_status': {'result': 'success'}}, state_published=True)

    monkeypatch.setattr(main, '_refresh_sync', refresh)

    async def run_two_rounds():
        await asyncio.gather(main._fetch_round(list(states)), main._fetch_round(list(states)))

    asyncio.run(run_two_rounds())
    assert all(event['done'] <= event['total'] for event in events)
    assert [event['active'] for event in events].count(False) == 1
    # 2回目のラウンドは1回目の取得済みを対象から外すため、同じリポジトリを再fetchしない。
    assert sorted(calls) == ['/a', '/b']


@pytest.mark.parametrize('refs_changed', [False, True], ids=['unchanged', 'changed'])
def test_fetch_round_refreshes_project_metadata_only_if_refs_changed(tmp_path, monkeypatch, refs_changed):
    repo = tmp_path / 'repo'
    init_repo(repo)
    representative = str(repo)
    linked = str(tmp_path / 'linked')
    states = {
        path: {'path': path, 'common_dir': representative, 'remote': 'origin', 'fetched_at': None}
        for path in [representative, linked]
    }
    fetch_status = {'attempted_at': main.time.time(), 'result': 'success', 'category': None, 'reason': None}
    events = []
    metadata_refreshes = []
    member_refreshes = []
    refresh_sync = main._refresh_sync

    def fetch(path):
        assert path == representative
        if refs_changed:
            git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
        return fetch_status

    def refresh(path, fetch, context=None, refresh_project_metadata=False):
        if refresh_project_metadata:
            metadata_refreshes.append(path)
        return refresh_sync(path, fetch, context, refresh_project_metadata)

    async def refresh_members(paths):
        member_refreshes.extend(paths)

    monkeypatch.setattr(main, 'STATE', states)
    monkeypatch.setattr(main, 'fetching', {})
    monkeypatch.setattr(main, '_fetch_round_lock', asyncio.Lock())
    monkeypatch.setattr(main, '_queue_project_snapshot_check', lambda row: None)
    monkeypatch.setattr(main.config, 'FETCH_ENABLED', True)
    monkeypatch.setattr(main.gitinfo, 'do_fetch', fetch)
    # When worktree metadata cannot be listed, the round refreshes members separately.
    monkeypatch.setattr(main.gitinfo, 'list_worktrees', lambda path: None)
    monkeypatch.setattr(main, '_refresh_sync', refresh)
    monkeypatch.setattr(main, '_refresh_many', refresh_members)
    monkeypatch.setattr(main.bus, 'publish', lambda kind, data: events.append((kind, dict(data))))
    monkeypatch.setattr(main.store, 'save', lambda state: None)

    asyncio.run(main._fetch_round(list(states)))

    assert metadata_refreshes == ([representative] if refs_changed else [])
    assert member_refreshes == ([linked] if refs_changed else [])
    for path in states:
        assert states[path]['fetch_status'] == fetch_status
        assert states[path]['fetched_at'] == fetch_status['attempted_at']
    assert {data['path'] for kind, data in events if kind == 'repo' and data.get('fetch_status') == fetch_status} == set(states)
    assert events[-1] == ('fetch', {'active': False, 'total': 1, 'done': 1, 'failed': 0})
