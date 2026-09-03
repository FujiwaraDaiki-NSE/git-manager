import asyncio
import os
import subprocess
from pathlib import Path

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
    main._pending_groups.clear()

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
    ) -> dict[str, object]:
        if fetch:
            fetch_calls.append(path)
        return {
            **main.STATE[path],
            "fetched_at": 123.0 if fetch else main.STATE[path].get("fetched_at"),
        }

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
    assert local_refreshes == ["/linked"]
    assert main.STATE["/linked"]["fetched_at"] == 123.0
    main.STATE.clear()
