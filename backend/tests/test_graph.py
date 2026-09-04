import subprocess
from pathlib import Path

import pytest

from app import graph


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


@pytest.fixture
def graph_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "base")
    git(repo, "switch", "-q", "-c", "feature")
    commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    commit(repo, "main")

    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main", "feature")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "branch", "--set-upstream-to=origin/main", "main")
    return repo


def test_graph_includes_default_branch_lane_and_all_local_heads(
    graph_repo: Path,
) -> None:
    result = graph.build(str(graph_repo), all_refs=True, limit=200)

    assert result is not None
    assert result["default_branch"] == "main"
    assert result["default_hash"] == git(
        graph_repo,
        "rev-parse",
        "origin/main",
    ).strip()
    assert isinstance(result["branch_heads"], list)
    assert all(set(branch) == {"name", "hash"} for branch in result["branch_heads"])
    heads = {branch["name"]: branch["hash"] for branch in result["branch_heads"]}
    assert set(heads) == {"main", "feature"}
    assert heads["main"] == next(
        row["hash"] for row in result["rows"] if row["subject"] == "main"
    )
    default_row = next(
        row for row in result["rows"] if row["hash"] == heads["main"]
    )
    assert result["default_lane"] == default_row["lane"]


def test_graph_does_not_guess_default_branch_without_origin_head(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "initial")
    git(repo, "branch", "topic")

    result = graph.build(str(repo), all_refs=True, limit=200)

    assert result is not None
    assert result["default_branch"] is None
    assert result["default_hash"] is None
    assert result["default_lane"] is None
    assert {branch["name"] for branch in result["branch_heads"]} == {
        "main",
        "topic",
    }


def test_graph_keeps_local_heads_when_their_rows_are_outside_limit(
    graph_repo: Path,
) -> None:
    old_head = git(graph_repo, "rev-parse", "feature~1").strip()
    git(graph_repo, "branch", "old", old_head)

    result = graph.build(str(graph_repo), all_refs=True, limit=1)

    assert result is not None
    assert next(
        branch["hash"] for branch in result["branch_heads"] if branch["name"] == "old"
    ) == old_head
    assert old_head not in {row["hash"] for row in result["rows"]}


@pytest.fixture
def remote_default_without_local(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "remote base")
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature")
    commit(repo, "feature")
    git(repo, "branch", "-D", "main")
    return repo


def test_graph_resolves_default_lane_from_remote_when_local_branch_is_absent(
    remote_default_without_local: Path,
) -> None:
    result = graph.build(str(remote_default_without_local), all_refs=True, limit=200)

    assert result is not None
    assert result["default_branch"] == "main"
    assert result["default_hash"] == git(
        remote_default_without_local,
        "rev-parse",
        "origin/main",
    ).strip()
    assert all(branch["name"] != "main" for branch in result["branch_heads"])
    remote_default_row = next(
        row
        for row in result["rows"]
        if any(
            ref["kind"] == "remote" and ref["name"] == "origin/main"
            for ref in row["refs"]
        )
    )
    assert result["default_lane"] == remote_default_row["lane"]


def test_graph_preserves_full_ref_names_when_tag_matches_branch(
    graph_repo: Path,
) -> None:
    git(graph_repo, "tag", "main")

    result = graph.build(str(graph_repo), all_refs=True, limit=200)

    assert result is not None
    assert result["default_branch"] == "main"
    assert {branch["name"] for branch in result["branch_heads"]} == {
        "main",
        "feature",
    }


def test_graph_default_hash_does_not_depend_on_log_decorations(
    graph_repo: Path,
) -> None:
    git(graph_repo, "config", "log.excludeDecoration", "refs/remotes/origin/*")

    result = graph.build(str(graph_repo), all_refs=True, limit=200)

    assert result is not None
    assert result["default_hash"] == git(
        graph_repo,
        "rev-parse",
        "origin/main",
    ).strip()
    assert result["default_lane"] is not None
    default_row = next(
        row for row in result["rows"] if row["hash"] == result["default_hash"]
    )
    assert all(ref["name"] != "origin/main" for ref in default_row["refs"])


def test_graph_all_false_keeps_existing_range_and_extended_metadata(
    graph_repo: Path,
) -> None:
    feature_head = git(graph_repo, "rev-parse", "feature").strip()
    result = graph.build(str(graph_repo), all_refs=False, limit=200)

    assert result is not None
    assert result["command"] == "git log --oneline --graph"
    assert feature_head not in {row["hash"] for row in result["rows"]}
    assert {branch["name"] for branch in result["branch_heads"]} == {
        "main",
        "feature",
    }


def test_graph_keeps_stable_shape_for_empty_repository(tmp_path: Path) -> None:
    repo = tmp_path / "empty"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")

    result = graph.build(str(repo), all_refs=True, limit=200)

    assert result == {
        "rows": [],
        "max_lane": 0,
        "head_lane": None,
        "default_branch": None,
        "default_hash": None,
        "default_lane": None,
        "branch_heads": [],
        "truncated": False,
        "command": "git log --oneline --graph --all",
    }
