"""Real inotify integration: nested/new/deleted Git ref namespaces."""
import queue
import subprocess
import time

import pytest

from app.watcher import Watcher


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    assert predicate(), 'watcher did not reach the expected state'


@pytest.fixture
def watched_repo(tmp_path):
    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    refs = repo / '.git/refs/remotes/origin/team'
    refs.mkdir(parents=True)
    notices = queue.Queue()
    watcher = Watcher(notices.put)
    if not watcher.available:
        pytest.skip('inotify unavailable')
    watcher.start()
    watcher.watch(str(repo))
    try:
        yield repo, watcher, notices
    finally:
        watcher.stop()


def drain(notices):
    while not notices.empty():
        notices.get_nowait()


def test_nested_remote_ref_changes_are_observed(watched_repo):
    repo, watcher, notices = watched_repo
    ref = repo / '.git/refs/remotes/origin/team/main'
    ref.write_text('a' * 40 + '\n')
    assert notices.get(timeout=3) == str(repo)
    assert str(ref.parent) in watcher._dir_to_wd
    assert not any('/objects/' in directory for directory in watcher._dir_to_wd)


def test_new_namespace_is_watched_for_subsequent_updates(watched_repo):
    repo, watcher, notices = watched_repo
    namespace = repo / '.git/refs/heads/feature/deep'
    namespace.mkdir(parents=True)
    wait_for(lambda: str(namespace) in watcher._dir_to_wd)
    drain(notices)
    (namespace / 'branch').write_text('b' * 40 + '\n')
    assert notices.get(timeout=3) == str(repo)


def test_deleted_namespace_can_be_recreated(watched_repo):
    repo, watcher, notices = watched_repo
    namespace = repo / '.git/refs/remotes/origin/team'
    namespace.rmdir()
    wait_for(lambda: str(namespace) not in watcher._dir_to_wd)
    namespace.mkdir()
    wait_for(lambda: str(namespace) in watcher._dir_to_wd)
    drain(notices)
    (namespace / 'again').write_text('c' * 40 + '\n')
    assert notices.get(timeout=3) == str(repo)


def test_repeated_registration_and_unwatch_do_not_leak_descriptors(watched_repo):
    repo, watcher, notices = watched_repo
    before = dict(watcher._dir_to_wd)
    for _ in range(5):
        watcher.watch(str(repo))
    assert watcher._dir_to_wd == before
    assert len(watcher._repo_to_wds[str(repo)]) == len(before)
    watcher.unwatch(str(repo))
    assert not watcher._dir_to_wd
    assert not watcher._wd_users
    assert not watcher._repo_to_wds
