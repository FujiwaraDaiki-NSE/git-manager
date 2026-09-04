import shutil
import subprocess
from pathlib import Path

from app import detail, project


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


def test_branch_fact_failure_is_unavailable_instead_of_zero_lanes(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "initial")
    state = {
        str(repo): {
            "path": str(repo),
            "common_dir": str(repo),
            "is_worktree": False,
            "entries": [],
        }
    }
    monkeypatch.setattr(detail, "get_branches", lambda _repo: None)

    assert project.build(str(repo), str(repo), state) is None
    summary = project.summary_rows(state)
    assert len(summary) == 1
    assert summary[0]["lane_count"] is None


def test_branch_merge_and_summary_lane_count_use_project_git_facts(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    (repo / "README.md").write_text("facts\n", encoding="utf-8")
    git(repo, "add", "README.md")
    commit(repo, "base")
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")

    git(repo, "switch", "-q", "-c", "feature")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    commit(repo, "feature")
    git(repo, "push", "-q", "-u", "origin", "feature")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "--no-ff", "-q", "feature", "-m", "merge feature")
    branches = detail.get_branches(str(repo))

    assert branches is not None
    feature_branch = next(branch for branch in branches["local"] if branch["name"] == "feature")
    # The feature is merged into the local HEAD, but origin/HEAD still points
    # at the pre-feature default commit. It must not be folded as completed.
    assert feature_branch["merged"] is False
    assert next(branch for branch in branches["local"] if branch["name"] == "main")["merged"] is False

    state = {
        str(repo): {
            "path": str(repo),
            "common_dir": str(repo),
            "is_worktree": False,
            "entries": [],
            "remote": str(origin),
        }
    }
    result = project.build(str(repo), str(repo), state, range_name="current")
    assert result is not None
    feature = next(lane for lane in result["lanes"] if lane["branch"] == "feature")
    assert feature["upstream"] == "origin/feature"
    assert feature["upstream_ahead"] is None
    assert feature["upstream_behind"] is None
    assert result["range"] == "current"
    assert all(event["commit_hash"] in {lane["head"] for lane in result["lanes"]} for event in result["events"])
    assert all(
        row["stats"] is None
        for row in result["graph"]["rows"]
        if row["hash"] not in {lane["head"] for lane in result["lanes"]}
    )

    summaries = project.summary_rows(state)
    assert len(summaries) == 1
    assert summaries[0]["lane_count"] == 2

    all_history = project.build(str(repo), str(repo), state, range_name="all")
    assert all_history is not None
    assert len(all_history["events"]) > len(result["events"])


def test_project_maintenance_excludes_the_default_branch_from_merged_count(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "initial")
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "branch", "topic")

    state = {
        str(repo): {
            "path": str(repo),
            "common_dir": str(repo),
            "is_worktree": False,
            "entries": [],
            "remote": str(origin),
        }
    }
    result = project.build(str(repo), str(repo), state)

    assert result is not None
    assert next(lane for lane in result["lanes"] if lane["branch"] == "main")["merged"] is True
    assert next(lane for lane in result["lanes"] if lane["branch"] == "topic")["merged"] is True
    assert result["maintenance"]["merged"] == 1


def test_project_latest_git_event_survives_an_empty_display_range(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "known historical commit")
    head = git(repo, "rev-parse", "HEAD").strip()

    # The graph is a known Git snapshot, but its commit is intentionally
    # outside the requested seven-day event window. This isolates the
    # contract that the header's latest fact is not derived from filtered
    # display events.
    monkeypatch.setattr(
        project.graph,
        "build",
        lambda *_args, **_kwargs: {
            "rows": [{
                "hash": head,
                "parents": [],
                "date": "2020-01-02T03:04:05+00:00",
                "subject": "known historical commit",
                "author": "Test",
            }],
            "truncated": False,
        },
    )

    result = project.build(str(repo), str(repo), {str(repo): {"entries": []}}, range_name="7d")

    assert result is not None
    assert result["events"] == []
    assert result["latest_event"]["commit_hash"] == head
    assert result["latest_event"]["occurred_at"] == "2020-01-02T03:04:05+00:00"


def test_project_marks_a_prunable_linked_worktree_as_foldable_git_fact(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    linked = tmp_path / "linked"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "initial")
    git(repo, "worktree", "add", "-q", "-b", "stale", str(linked), "HEAD")
    # Removing the checkout directory leaves Git's explicit prunable marker;
    # the project endpoint must preserve that fact for the UI fold decision.
    shutil.rmtree(linked)

    result = project.build(str(repo), str(repo), {str(repo): {"entries": []}})

    assert result is not None
    stale = next(lane for lane in result["lanes"] if lane["branch"] == "stale")
    assert stale["is_worktree"] is True
    assert stale["worktree_state"] == "prunable"
    assert result["maintenance"]["prunable"] == 1
