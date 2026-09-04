import subprocess
from pathlib import Path

from app import project


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def commit(repo: Path, subject: str) -> None:
    git(repo, "commit", "--allow-empty", "-qm", subject)


def test_build_keeps_git_facts_separate_and_resolves_linked_lane(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    linked = tmp_path / "linked"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    (repo / "README.md").write_text("A project description.\n", encoding="utf-8")
    git(repo, "add", "README.md")
    commit(repo, "base")
    git(repo, "switch", "-q", "-c", "feature")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    commit(repo, "feature")
    feature_head = git(repo, "rev-parse", "feature").strip()
    git(repo, "switch", "-q", "main")
    (repo / "main.txt").write_text("main\n", encoding="utf-8")
    git(repo, "add", "main.txt")
    commit(repo, "main")
    main_head = git(repo, "rev-parse", "main").strip()

    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main", "feature")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "worktree", "add", "-q", str(linked), "feature")

    state = {
        str(repo): {
            "path": str(repo),
            "common_dir": str(repo),
            "is_worktree": False,
            "entries": [],
            "remote": str(origin),
        },
        str(linked): {
            "path": str(linked),
            "common_dir": str(repo),
            "is_worktree": True,
            "entries": [{"xy": ".M", "path": "feature.txt"}],
            "remote": str(origin),
        },
    }
    result = project.build(str(repo), str(repo), state)

    assert result is not None
    assert result["default_branch"] == "main"
    assert result["default_hash"] == git(repo, "rev-parse", "origin/main").strip()
    assert result["description"] == "A project description."
    feature = next(lane for lane in result["lanes"] if lane["branch"] == "feature")
    assert feature["head"] == feature_head
    assert feature["merge_base"] == git(repo, "merge-base", "origin/main", "feature").strip()
    assert feature["default_ahead"] == 1
    assert feature["default_behind"] == 1
    assert feature["path"] == str(linked)
    assert feature["dirty"] is True
    graph_row = next(row for row in result["graph"]["rows"] if row["hash"] == feature_head)
    assert graph_row["stats"]["files"] == 1
    assert graph_row["stats"]["paths"] == ["feature.txt"]
    assert all(lane["agent"] is None and lane["merge_target"] is None for lane in result["lanes"])
    assert all(event["source"] == "git" for event in result["events"])
    assert main_head != feature_head


def test_build_does_not_guess_default_branch_without_origin_head(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "initial")
    git(repo, "branch", "topic")

    result = project.build(str(repo), str(repo), {str(repo): {"entries": []}})

    assert result is not None
    assert result["default_branch"] is None
    assert result["default_hash"] is None
    assert all(lane["merge_base"] is None for lane in result["lanes"])
    assert all(lane["default_ahead"] is None and lane["default_behind"] is None for lane in result["lanes"])
