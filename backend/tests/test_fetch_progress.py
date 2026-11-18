import asyncio

from app import main


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
