import subprocess
from pathlib import Path

import pytest

from app import timeline


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def empty_commit(repo: Path, subject: str) -> None:
    git(repo, "commit", "--allow-empty", "-qm", subject)


@pytest.fixture
def timeline_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Timeline Test")
    git(repo, "config", "user.email", "timeline@example.com")
    empty_commit(repo, "base")
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature")
    empty_commit(repo, "feature work")
    git(repo, "switch", "-q", "main")
    empty_commit(repo, "main work")
    git(repo, "push", "-q", "origin", "main")
    return repo, origin


def test_timeline_returns_branch_commits_and_ahead_behind(
    timeline_repo: tuple[Path, Path],
) -> None:
    repo, _ = timeline_repo

    result = timeline.build(str(repo))

    assert result is not None
    assert result["base"]["name"] == "main"
    assert result["base"]["ref"] == "origin/main"
    assert result["base"]["hash"] == git(repo, "rev-parse", "origin/main").strip()
    assert result["branches"]
    feature = next(branch for branch in result["branches"] if branch["name"] == "feature")
    assert feature["name"] == "feature"
    assert feature["hash"] == git(repo, "rev-parse", "feature").strip()
    assert feature["merge_base"] == git(repo, "merge-base", "origin/main", "feature").strip()
    assert feature["fork_time"] == int(
        git(repo, "show", "-s", "--format=%ct", feature["merge_base"]).strip()
    )
    # base...branch emits base-only first (behind), branch-only second (ahead).
    assert (feature["ahead"], feature["behind"]) == (1, 1)
    assert [commit["subject"] for commit in feature["commits"]] == ["feature work"]
    assert feature["commits_truncated"] is False
    assert all(branch["name"] != "main" for branch in result["branches"])
    assert result["trunk"]
    assert isinstance(result["now"], float)


def test_timeline_reports_regular_merge_and_merge_timestamp(
    timeline_repo: tuple[Path, Path],
) -> None:
    repo, _ = timeline_repo
    git(repo, "merge", "--no-ff", "-qm", "merge feature", "feature")
    git(repo, "push", "-q", "origin", "main")

    result = timeline.build(str(repo))
    assert result is not None
    feature = next(branch for branch in result["branches"] if branch["name"] == "feature")
    assert feature["merged"] is True
    assert feature["merge_hash"] == git(repo, "rev-parse", "HEAD").strip()
    assert feature["merged_at"] == int(
        git(repo, "show", "-s", "--format=%ct", "HEAD").strip()
    )


def test_timeline_is_stable_without_origin_head(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Timeline Test")
    git(repo, "config", "user.email", "timeline@example.com")
    empty_commit(repo, "initial")
    git(repo, "branch", "topic")

    result = timeline.build(str(repo))

    assert result is not None
    assert result["base"] is None
    assert result["branches"] == []
    assert result["trunk"] == []
    assert isinstance(result["now"], float)


def test_timeline_is_stable_for_empty_repository(tmp_path: Path) -> None:
    repo = tmp_path / "empty"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")

    result = timeline.build(str(repo))

    assert result is not None
    assert result["base"] is None
    assert result["trunk"] == []
    assert result["branches"] == []


def test_timeline_maps_linked_worktree_to_branch(
    timeline_repo: tuple[Path, Path],
    tmp_path: Path,
) -> None:
    repo, _ = timeline_repo
    worktree = tmp_path / "feature-worktree"
    git(repo, "worktree", "add", "-q", str(worktree), "feature")

    result = timeline.build(str(worktree))

    assert result is not None
    feature = next(branch for branch in result["branches"] if branch["name"] == "feature")
    assert feature["worktree"] == str(worktree)
