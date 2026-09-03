import asyncio
import os
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import detail, gitinfo, main, scanner
from app.watcher import Watcher


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


@pytest.fixture
def repo_with_worktree(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "main"
    worktree = tmp_path / "linked"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "commit", "--allow-empty", "-qm", "initial")
    git(repo, "branch", "merged-unused")
    git(repo, "worktree", "add", "-q", "-b", "feature", str(worktree))
    return repo, worktree


def test_linked_layout_and_activity_use_private_logs_head(
    repo_with_worktree: tuple[Path, Path],
) -> None:
    repo, worktree = repo_with_worktree
    layout = scanner.repo_layout(str(worktree))
    assert layout is not None
    assert layout.is_worktree is True
    assert layout.common_root == str(repo)

    private_head_log = Path(layout.git_dir) / "logs" / "HEAD"
    shared_refs_head_log = Path(layout.common_git_dir) / "logs" / "refs" / "HEAD"
    private_head_log.touch()
    os.utime(private_head_log, (200, 200))
    if shared_refs_head_log.exists():
        os.utime(shared_refs_head_log, (100, 100))
    assert scanner.activity_mtime(str(worktree)) == 200

    result = gitinfo.collect(str(worktree))
    assert result["common_dir"] == str(repo)
    assert result["is_worktree"] is True


def test_discovery_adds_worktree_outside_scan_and_preserves_context(
    repo_with_worktree: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, worktree = repo_with_worktree
    monkeypatch.setattr(main.config, "SCAN_ROOT", str(repo))
    monkeypatch.setattr(main.config, "HOST_PREFIX", str(repo))
    monkeypatch.setattr(main.config, "FETCH_ENABLED", False)
    monkeypatch.setattr(main.store, "save", lambda _state: None)
    monkeypatch.setattr(main, "watcher", None)
    main.STATE.clear()

    main._pending.clear()

    asyncio.run(main._discover())

    assert str(repo) in main.STATE
    assert str(worktree) in main.STATE
    linked = main.STATE[str(worktree)]
    assert linked["common_dir"] == str(repo)
    assert linked["is_worktree"] is True
    assert linked["worktree_state"] == "ok"
    assert linked["next_command"]["command"] == f"git worktree remove {worktree}"
    assert main.STATE[str(repo)]["is_worktree"] is False
    assert main.STATE[str(repo)]["worktree_state"] is None
    assert main.STATE[str(repo)]["merged_branches"] == ["feature", "merged-unused"]
    assert main.STATE[str(repo)]["next_command"]["command"] == "git branch -d merged-unused"

    git(worktree, "commit", "--allow-empty", "-qm", "feature advances")
    refreshed = main._refresh_sync(str(worktree), refresh_project_metadata=True)
    assert refreshed["merged"] is False
    assert refreshed["next_command"] is None
    assert main.STATE[str(repo)]["merged_branches"] == ["merged-unused"]


def test_branches_include_worktree_path(
    repo_with_worktree: tuple[Path, Path],
) -> None:
    repo, worktree = repo_with_worktree
    result = detail.get_branches(str(repo))
    assert result is not None
    feature = next(branch for branch in result["local"] if branch["name"] == "feature")
    assert feature["worktree"] == str(worktree)
    assert next(branch for branch in result["local"] if branch["name"] == "main")["worktree"] == str(repo)


def test_worktree_list_z_preserves_newline_path(
    repo_with_worktree: tuple[Path, Path],
) -> None:
    repo, _ = repo_with_worktree
    newline_worktree = repo.parent / "linked\nwith-newline"
    git(repo, "worktree", "add", "-q", "-b", "newline-feature", str(newline_worktree))

    records = gitinfo.list_worktrees(str(repo))

    assert records is not None
    assert any(record["path"] == str(newline_worktree) for record in records)


def test_separate_git_dir_is_a_normal_repository(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    git_dir = tmp_path / "git-dir"
    repo.mkdir()
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "init",
            "-q",
            "-b",
            "main",
            "--separate-git-dir",
            str(git_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "commit", "--allow-empty", "-qm", "initial")

    layout = scanner.repo_layout(str(repo))
    result = gitinfo.collect(str(repo))
    records = gitinfo.list_worktrees(str(repo))

    assert layout is not None
    assert layout.is_worktree is False
    assert layout.common_root == str(repo)
    assert result["is_worktree"] is False
    assert result["common_dir"] == str(repo)
    assert records is not None
    assert records[0]["path"] == str(repo)

    linked = tmp_path / "linked"
    git(repo, "worktree", "add", "-q", "-b", "feature", str(linked))
    linked_layout = scanner.repo_layout(str(linked))
    assert linked_layout is not None
    assert linked_layout.is_worktree is True
    assert linked_layout.common_root == str(git_dir)


def test_discovery_supports_only_linked_separate_git_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    git_dir = tmp_path / "git-dir"
    linked = tmp_path / "linked"
    repo.mkdir()
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "init",
            "-q",
            "-b",
            "main",
            "--separate-git-dir",
            str(git_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "commit", "--allow-empty", "-qm", "initial")
    git(repo, "worktree", "add", "-q", "-b", "feature", str(linked))

    monkeypatch.setattr(main.scanner, "find_repos", lambda: iter([str(linked)]))
    monkeypatch.setattr(main.config, "SCAN_ROOT", str(tmp_path))
    monkeypatch.setattr(main.config, "HOST_PREFIX", str(tmp_path))
    monkeypatch.setattr(main.config, "FETCH_ENABLED", False)
    monkeypatch.setattr(main.store, "save", lambda _state: None)
    monkeypatch.setattr(main, "watcher", None)
    main.STATE.clear()

    asyncio.run(main._discover())

    assert str(linked) in main.STATE
    assert str(git_dir) not in main.STATE
    assert main.STATE[str(linked)]["common_dir"] == str(git_dir)
    assert main.STATE[str(linked)]["is_worktree"] is True
    main.STATE.clear()


def test_linked_separate_dot_git_does_not_expose_administration_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    admin = tmp_path / "admin"
    git_dir = admin / ".git"
    linked = tmp_path / "linked"
    repo.mkdir()
    admin.mkdir()
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "init",
            "-q",
            "-b",
            "main",
            "--separate-git-dir",
            str(git_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "commit", "--allow-empty", "-qm", "initial")
    git(repo, "worktree", "add", "-q", "-b", "feature", str(linked))

    monkeypatch.setattr(main.config, "SCAN_ROOT", str(tmp_path))
    monkeypatch.setattr(main.config, "HOST_PREFIX", str(tmp_path))
    monkeypatch.setattr(main.config, "FETCH_ENABLED", False)
    monkeypatch.setattr(main.store, "save", lambda _state: None)
    monkeypatch.setattr(main, "watcher", None)
    main.STATE.clear()

    asyncio.run(main._discover())

    assert set(main.STATE) == {str(repo), str(linked)}
    assert str(admin) not in main.STATE
    assert main.STATE[str(repo)]["is_worktree"] is False
    assert main.STATE[str(linked)]["is_worktree"] is True
    main.STATE.clear()


def test_refresh_project_metadata_reconciles_members_and_publishes(
    repo_with_worktree: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, worktree = repo_with_worktree
    new_worktree = repo.parent / "linked-new"
    monkeypatch.setattr(main.config, "SCAN_ROOT", str(repo))
    monkeypatch.setattr(main.config, "HOST_PREFIX", str(repo))
    monkeypatch.setattr(main.config, "FETCH_ENABLED", False)
    monkeypatch.setattr(main.store, "save", lambda _state: None)
    monkeypatch.setattr(main, "watcher", None)
    main.STATE.clear()
    main._pending.clear()
    asyncio.run(main._discover())

    events: list[tuple[str, object]] = []
    monkeypatch.setattr(
        main.bus,
        "publish_threadsafe",
        lambda event, data: events.append((event, data)),
    )
    watched: list[str] = []
    unwatched: list[str] = []

    class FakeWatcher:
        def watch(self, path: str) -> None:
            watched.append(path)

        def unwatch(self, path: str) -> None:
            unwatched.append(path)

    monkeypatch.setattr(main, "watcher", FakeWatcher())

    git(repo, "worktree", "add", "-q", "-b", "new-feature", str(new_worktree))
    main._refresh_sync(str(repo), refresh_project_metadata=True)

    assert str(new_worktree) in main.STATE
    assert any(
        event == "repo" and isinstance(data, dict) and data.get("path") == str(new_worktree)
        for event, data in events
    )
    assert str(worktree) in watched

    # Advancing a sibling changes its merged status and next command.  The
    # metadata refresh must publish that sibling with its new context too.
    git(worktree, "commit", "--allow-empty", "-qm", "feature advances")
    events.clear()
    main._refresh_sync(str(repo), refresh_project_metadata=True)
    assert main.STATE[str(worktree)]["merged"] is False
    assert main.STATE[str(worktree)]["next_command"] is None
    assert any(
        event == "repo"
        and isinstance(data, dict)
        and data.get("path") == str(worktree)
        and data.get("merged") is False
        for event, data in events
    )

    git(repo, "worktree", "remove", "-f", str(new_worktree))
    events.clear()
    main._refresh_sync(str(repo), refresh_project_metadata=True)
    assert str(new_worktree) not in main.STATE
    assert ("removed", {"path": str(new_worktree)}) in events
    assert str(new_worktree) in unwatched
    main.STATE.clear()


def test_locked_merged_worktree_suggests_unlock() -> None:
    clean = {
        "entries": [],
        "detached": False,
        "branch": "feature",
        "upstream": None,
        "ahead": 0,
        "behind": 0,
    }
    result = gitinfo.next_command(
        clean,
        None,
        {"worktree_state": "locked", "merged": True, "worktree": "/repo/My Project"},
    )

    assert result == {
        "command": "git worktree unlock '/repo/My Project'",
        "reason": "マージ済みですが worktree がロックされています",
    }


def test_watcher_keeps_all_private_targets_but_collapses_shared_noise(
    repo_with_worktree: tuple[Path, Path],
) -> None:
    repo, worktree = repo_with_worktree
    second_worktree = repo.parent / "linked-second"
    git(repo, "worktree", "add", "-q", "-b", "second", str(second_worktree))
    watcher = Watcher(lambda _path: None)
    private_one, private_two, shared = 1, 2, 3
    watcher._wd_private_users = {
        private_one: {str(worktree)},
        private_two: {str(second_worktree)},
        shared: {str(repo)},
    }
    watcher._wd_users = {
        private_one: {str(worktree)},
        private_two: {str(second_worktree)},
        shared: {str(repo), str(worktree), str(second_worktree)},
    }
    watcher._wd_to_repo = {
        private_one: str(worktree),
        private_two: str(second_worktree),
        shared: str(repo),
    }

    callbacks = watcher._callbacks_for_events(
        [
            SimpleNamespace(wd=private_one, name="HEAD"),
            SimpleNamespace(wd=private_two, name="HEAD"),
            SimpleNamespace(wd=shared, name="refs"),
        ]
    )

    assert callbacks == sorted([str(worktree), str(second_worktree)])


def test_main_debounce_keeps_distinct_worktree_targets(
    repo_with_worktree: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, worktree = repo_with_worktree
    second_worktree = repo.parent / "linked-second"
    git(repo, "worktree", "add", "-q", "-b", "second", str(second_worktree))
    monkeypatch.setattr(main.config, "HOST_PREFIX", str(repo))
    monkeypatch.setattr(main.config, "SCAN_ROOT", str(repo))
    main.STATE.clear()
    main.STATE.update(
        {
            str(repo): {"common_dir": str(repo), "is_worktree": False},
            str(worktree): {"common_dir": str(repo), "is_worktree": True},
            str(second_worktree): {"common_dir": str(repo), "is_worktree": True},
        }
    )
    main._pending.clear()
    main._pending_task = None

    async def run() -> set[str]:
        monkeypatch.setattr(main.app.state, "loop", asyncio.get_running_loop(), raising=False)
        main._on_watch_event(str(worktree))
        main._on_watch_event(str(second_worktree))
        await asyncio.sleep(0)
        return set(main._pending)

    try:
        assert asyncio.run(run()) == {str(worktree), str(second_worktree)}
    finally:
        if main._pending_task is not None:
            main._pending_task.cancel()
        main._pending.clear()
        main.STATE.clear()


def test_debounce_refreshes_each_common_repository_once(
    repo_with_worktree: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, worktree = repo_with_worktree
    second_worktree = repo.parent / "linked-second"
    git(repo, "worktree", "add", "-q", "-b", "second", str(second_worktree))
    main.STATE.clear()
    main.STATE.update(
        {
            str(repo): {"common_dir": str(repo), "is_worktree": False},
            str(worktree): {"common_dir": str(repo), "is_worktree": True},
            str(second_worktree): {"common_dir": str(repo), "is_worktree": True},
        }
    )
    main._pending.clear()
    main._pending.update({str(worktree), str(second_worktree)})
    main._suppress.clear()
    refreshed: list[tuple[list[str], bool]] = []

    async def fake_refresh_many(
        paths: list[str],
        fetch: bool = False,
        contexts: dict[str, dict[str, object]] | None = None,
        refresh_project_metadata: bool = False,
    ) -> None:
        assert fetch is False
        assert contexts is None
        refreshed.append((paths, refresh_project_metadata))

    monkeypatch.setattr(main, "DEBOUNCE_SEC", 0)
    monkeypatch.setattr(main, "_refresh_many", fake_refresh_many)

    asyncio.run(main._drain_pending())

    assert refreshed == [([str(repo)], True)]
    main.STATE.clear()


def test_debounce_removes_last_vanished_linked_checkout(
    repo_with_worktree: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, worktree = repo_with_worktree
    main.STATE.clear()
    main.STATE[str(worktree)] = {
        "path": str(worktree),
        "common_dir": str(repo),
        "is_worktree": True,
    }
    main._pending.clear()
    main._pending.add(str(worktree))
    main._suppress.clear()
    refreshed: list[str] = []
    removed: list[tuple[str, object]] = []
    git(repo, "worktree", "remove", "-f", str(worktree))

    async def fake_refresh_many(paths: list[str], **_kwargs: object) -> None:
        refreshed.extend(paths)

    monkeypatch.setattr(main, "DEBOUNCE_SEC", 0)
    monkeypatch.setattr(main, "_refresh_many", fake_refresh_many)
    monkeypatch.setattr(
        main.bus,
        "publish_threadsafe",
        lambda event, data: removed.append((event, data)),
    )
    monkeypatch.setattr(main, "watcher", None)

    asyncio.run(main._drain_pending())

    assert refreshed == []
    assert str(worktree) not in main.STATE
    assert ("removed", {"path": str(worktree)}) in removed
    main.STATE.clear()


@pytest.mark.parametrize("worktree_state", ["locked", "prunable"])
def test_missing_managed_worktree_is_not_removed_without_git_confirmation(
    tmp_path: Path,
    worktree_state: str,
) -> None:
    worktree = str(tmp_path / "missing")
    main.STATE.clear()
    main.STATE[worktree] = {
        "path": worktree,
        "common_dir": str(tmp_path / "admin.git"),
        "is_worktree": True,
        "worktree_state": worktree_state,
    }

    assert main._project_refresh_representatives([worktree]) == []
    assert worktree in main.STATE
    main.STATE.clear()


def test_discovery_submits_all_project_metadata_concurrently(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = str(tmp_path / "slow")
    second = str(tmp_path / "fast")
    finished: list[str] = []
    monkeypatch.setattr(main.scanner, "find_repos", lambda: iter([first, second]))
    monkeypatch.setattr(
        main,
        "_base_worktree_context",
        lambda path: (
            path,
            {
                "common_dir": path,
                "is_worktree": False,
                "worktree_state": None,
                "worktree": None,
                "merged": False,
            },
        ),
    )
    monkeypatch.setattr(main.scanner, "repo_layout", lambda _path: None)
    monkeypatch.setattr(main.scanner, "activity_mtime", lambda _path: 0.0)
    monkeypatch.setattr(main.config, "FETCH_ENABLED", False)
    monkeypatch.setattr(main, "watcher", None)
    monkeypatch.setattr(main.store, "save", lambda _state: None)
    monkeypatch.setattr(main, "_refresh_many", lambda *args, **kwargs: asyncio.sleep(0))
    main.STATE.clear()

    def list_group(path: str) -> tuple[list[dict[str, object]], set[str], None]:
        if path == first:
            time.sleep(0.15)
        finished.append(path)
        return ([{"path": path, "branch": None, "state": "ok", "detached": True}], set(), None)

    monkeypatch.setattr(main, "_list_worktrees_sync", list_group)

    asyncio.run(main._discover())

    assert finished == [second, first]
    main.STATE.clear()


def test_worktree_states_and_next_command_precedence() -> None:
    records = gitinfo.parse_worktree_list(
        """worktree /repo
HEAD deadbeef
branch refs/heads/main

worktree /gone
HEAD deadbeef
branch refs/heads/feature
prunable missing

worktree /locked
HEAD deadbeef
branch refs/heads/hold
locked in use

worktree /detached
HEAD deadbeef
detached
"""
    )
    assert [record["state"] for record in records] == ["ok", "prunable", "locked", "ok"]
    assert records[-1]["detached"] is True

    clean = {
        "entries": [],
        "detached": False,
        "branch": "feature",
        "upstream": None,
        "ahead": 0,
        "behind": 0,
    }
    assert gitinfo.next_command(clean, None, {"worktree_state": "prunable"})["command"] == "git worktree prune"
    assert gitinfo.next_command(clean, None, {"merged": True, "worktree": "/repo/feature"})["command"] == "git worktree remove /repo/feature"
    assert gitinfo.next_command(clean, None, {"merged_branch": "merged-unused"})["command"] == "git branch -d merged-unused"
    assert gitinfo.next_command(
        clean,
        None,
        {"merged": True, "worktree": "/repo/My Project"},
    )["command"] == "git worktree remove '/repo/My Project'"
    dirty = {**clean, "entries": [{"xy": ".M", "path": "file"}], "detached": True}
    assert gitinfo.next_command(dirty, None, {"worktree_state": "prunable"})["command"] == "git add -p"


def test_shared_gitdir_events_are_owned_by_main_even_if_linked_is_watched_first(
    repo_with_worktree: tuple[Path, Path],
) -> None:
    repo, worktree = repo_with_worktree
    watcher = Watcher(lambda _path: None)
    watcher.start()
    if not watcher.available:
        pytest.skip("inotify is unavailable")
    try:
        watcher.watch(str(worktree))
        watcher.watch(str(repo))
        layout = scanner.repo_layout(str(repo))
        assert layout is not None
        wd = watcher._dir_to_wd[layout.common_git_dir]
        assert watcher._wd_private_users[wd] == {str(repo)}
    finally:
        watcher.stop()


def test_fetch_round_fetches_once_per_common_repository(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    main.STATE.clear()
    main.STATE.update(
        {
            "/repo": {
                "path": "/repo",
                "common_dir": "/repo",
                "remote": "git@example.com:owner/repo.git",
                "fetched_at": None,
            },
            "/linked": {
                "path": "/linked",
                "common_dir": "/repo",
                "remote": "git@example.com:owner/repo.git",
                "fetched_at": None,
            },
        }
    )
    fetch_calls: list[str] = []
    local_refreshes: list[str] = []

    def fake_refresh(
        path: str,
        fetch: bool = False,
        _context: dict[str, object] | None = None,
        _refresh_project_metadata: bool = False,
    ) -> dict[str, object] | None:
        if fetch:
            fetch_calls.append(path)
            return {
                **main.STATE[path],
                "fetched_at": 123.0,
            }
        # Simulate metadata reconciliation having already published current
        # members and removed a worktree that vanished during fetch.
        main.STATE.pop("/linked", None)
        return main._RefreshResult({**main.STATE[path]}, state_published=True)

    async def fake_refresh_many(
        paths: list[str],
        fetch: bool = False,
        contexts: dict[str, dict[str, object]] | None = None,
        refresh_project_metadata: bool = False,
    ) -> None:
        assert fetch is False
        local_refreshes.extend(paths)

    monkeypatch.setattr(main, "_refresh_sync", fake_refresh)
    monkeypatch.setattr(main, "_refresh_many", fake_refresh_many)
    monkeypatch.setattr(main.store, "save", lambda _state: None)
    asyncio.run(main._fetch_round(["/repo", "/linked"]))

    assert fetch_calls == ["/repo"]
    assert local_refreshes == []
    assert "/linked" not in main.STATE
    assert main.STATE["/repo"]["fetched_at"] == 123.0
    main.STATE.clear()
