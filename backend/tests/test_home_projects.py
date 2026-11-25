"""Home cards reflect current branch refs and expose the selected lane ID."""
import asyncio
import threading
import time

import pytest

from app import main, project
from app.watcher import Watcher, flags
from test_project import git, init_repo


def test_home_branch_count_follows_refs_during_refresh_and_suppression(tmp_path, monkeypatch):
    repo = tmp_path / 'repo'
    init_repo(repo)
    worktrees = [tmp_path / f'linked-{index}' for index in range(35)]
    for index, worktree in enumerate(worktrees):
        git(repo, 'worktree', 'add', '-qb', f'topic-{index}', str(worktree))
    for index in range(16):
        git(repo, 'branch', f'unchecked-{index}')
    path = str(repo)
    main_row = {'path': path, 'common_dir': path, 'is_worktree': False, 'branch': 'main'}
    rows = {path: main_row}
    for index, worktree in enumerate(worktrees):
        linked = str(worktree)
        rows[linked] = {'path': linked, 'common_dir': path, 'is_worktree': True, 'branch': f'topic-{index}'}

    monkeypatch.setattr(main, 'STATE', rows)
    monkeypatch.setattr(main, '_pending', set())
    monkeypatch.setattr(main, '_pending_task', None)
    monkeypatch.setattr(main, '_suppress', {})
    monkeypatch.setattr(main, 'DEBOUNCE_SEC', .01)
    monkeypatch.setattr(main, '_queue_project_snapshot_check', lambda row: None)
    monkeypatch.setattr(main.bus, 'publish_threadsafe', lambda *args: None)
    monkeypatch.setattr(main.bus, 'publish', lambda *args: None)
    monkeypatch.setattr(main.config, 'DATA_DIR', tmp_path)

    entered = threading.Event()
    release = threading.Event()
    collect = main.gitinfo.collect

    def collect_slowly(checkout, *args, **kwargs):
        if checkout == path:
            entered.set()
            assert release.wait(30)
        return collect(checkout, *args, **kwargs)

    monkeypatch.setattr(main.gitinfo, 'collect', collect_slowly)
    watcher = Watcher(main._on_watch_event)
    if not watcher.available:
        pytest.skip('inotify unavailable')
    monkeypatch.setattr(main, 'watcher', watcher)
    notices = []
    callbacks_for_events = watcher._callbacks_for_events

    def record_ref_events(events):
        callbacks = callbacks_for_events(events)
        if callbacks:
            heads_watch = watcher._dir_to_wd[str(repo / '.git/refs/heads')]
            notices.extend(
                event.mask for event in events
                if event.wd == heads_watch and event.name == 'zz-summary-probe'
                and event.mask & (flags.MOVED_TO | flags.DELETE)
            )
        return callbacks

    monkeypatch.setattr(watcher, '_callbacks_for_events', record_ref_events)

    async def wait_for_notice(mask):
        deadline = time.monotonic() + 3
        while not any(notice & mask for notice in notices):
            assert time.monotonic() < deadline
            await asyncio.sleep(.005)

    async def count_branches():
        return (await main.get_projects())['projects'][0]['lane_count']

    async def scenario():
        monkeypatch.setattr(main.app.state, 'loop', asyncio.get_running_loop(), raising=False)
        watcher.start()
        for checkout in rows:
            watcher.watch(checkout)
        try:
            assert await count_branches() == 52
            git(repo, 'branch', 'zz-summary-probe')
            await wait_for_notice(flags.MOVED_TO)
            assert await asyncio.to_thread(entered.wait, 3)
            assert await count_branches() == 53

            assert main._suppress[path] > time.time()
            git(repo, 'branch', '-D', 'zz-summary-probe')
            await wait_for_notice(flags.DELETE)
            assert await count_branches() == 52
        finally:
            watcher.stop()
            release.set()
            if main._pending_task is not None:
                await main._pending_task

    asyncio.run(scenario())


@pytest.mark.parametrize(('branch', 'entries', 'label', 'lane_id'), [
    ('main', [{'xy': ' M'}], 'main', 'branch:main'),
    ('(detached)', [{'xy': ' M'}], '(detached)', 'worktree:/linked'),
    ('main', [], None, None),
])
def test_next_lane_id_identifies_the_selected_checkout(monkeypatch, tmp_path, branch, entries, label, lane_id):
    monkeypatch.setattr(main.config, 'DATA_DIR', tmp_path)
    state = {
        '/repo': {'path': '/repo', 'common_dir': '/repo', 'is_worktree': False, 'branch': 'other'},
        '/linked': {'path': '/linked', 'common_dir': '/repo', 'is_worktree': True, 'branch': branch, 'entries': entries},
    }

    card = project.summary_rows(state)[0]

    assert card['next_lane'] == label
    assert card['next_lane_id'] == lane_id
