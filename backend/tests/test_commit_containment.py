"""Commit containment snapshots use real local Git refs and objects."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import commit_containment


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


@pytest.fixture
def repository(tmp_path: Path) -> tuple[Path, str, str, str]:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.name", "Containment test")
    git(tmp_path, "config", "user.email", "containment@example.invalid")
    git(tmp_path, "config", "core.hooksPath", "/dev/null")
    (tmp_path / "file.txt").write_text("root\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "root")
    root = git(tmp_path, "rev-parse", "HEAD")

    (tmp_path / "file.txt").write_text("root\nmain\n", encoding="utf-8")
    git(tmp_path, "commit", "-qam", "main")
    main = git(tmp_path, "rev-parse", "HEAD")
    # An ordinary local branch and a remote-tracking ref are both snapshots
    # in this checkout; no network or fetch is needed to create either one.
    git(tmp_path, "branch", "feature", main)
    git(tmp_path, "update-ref", "refs/remotes/origin/main", main)

    # Lightweight, annotated, and nested annotated tags all point to the same
    # commit.  A tree tag is intentionally excluded by the implementation.
    git(tmp_path, "tag", "lightweight", main)
    git(tmp_path, "tag", "-a", "-m", "base tag", "base-tag", main)
    git(tmp_path, "tag", "-a", "-m", "nested tag", "release", "base-tag")
    tree = git(tmp_path, "rev-parse", f"{main}^{{tree}}")
    git(tmp_path, "tag", "tree-tag", tree)

    git(tmp_path, "branch", "unrelated", root)
    return tmp_path, root, main, tree


def test_inventory_contains_local_remote_and_all_commit_tags(repository: tuple[Path, str, str, str]) -> None:
    repo, _root, main, _tree = repository
    result = commit_containment.get_containment(str(repo), main)

    assert result is not None
    assert result["pinned_hash"] == main
    assert result["revision"] == main
    assert result["truncated"] is False
    assert isinstance(result["observed_at"], float)
    assert all(set(item) == {"ref", "object_hash", "peeled_commit", "type"} for item in result["refs"])

    refs = {item["ref"]: item for item in result["refs"]}
    assert set(refs) == {
        "refs/heads/feature",
        "refs/heads/main",
        "refs/remotes/origin/main",
        "refs/tags/base-tag",
        "refs/tags/lightweight",
        "refs/tags/release",
    }
    assert refs["refs/heads/main"]["type"] == "local"
    assert refs["refs/remotes/origin/main"]["type"] == "remote"
    assert refs["refs/tags/base-tag"]["type"] == "tag"
    assert refs["refs/tags/base-tag"]["object_hash"] != main
    assert refs["refs/tags/base-tag"]["peeled_commit"] == main
    assert refs["refs/tags/release"]["peeled_commit"] == main
    assert refs["refs/tags/lightweight"]["object_hash"] == main


def test_unrelated_ref_and_tree_tag_are_omitted(repository: tuple[Path, str, str, str]) -> None:
    repo, root, main, _tree = repository
    result = commit_containment.get_containment(str(repo), main)
    assert result is not None
    refs = {item["ref"] for item in result["refs"]}
    assert "refs/heads/unrelated" not in refs
    assert "refs/tags/tree-tag" not in refs

    root_result = commit_containment.get_containment(str(repo), root)
    assert root_result is not None
    root_refs = {item["ref"] for item in root_result["refs"]}
    assert "refs/heads/unrelated" in root_refs


def test_ref_move_does_not_mutate_previous_snapshot(repository: tuple[Path, str, str, str]) -> None:
    repo, root, main, _tree = repository
    before = commit_containment.get_containment(str(repo), main)
    assert before is not None
    old_main = next(item for item in before["refs"] if item["ref"] == "refs/heads/main")
    assert old_main["object_hash"] == main

    git(repo, "update-ref", "refs/heads/main", root)
    assert old_main["object_hash"] == main
    after = commit_containment.get_containment(str(repo), main)
    assert after is not None
    assert "refs/heads/main" not in {item["ref"] for item in after["refs"]}
    assert before["observed_at"] <= after["observed_at"]


def test_valid_commit_with_no_refs_is_distinct_from_git_failure(repository: tuple[Path, str, str, str]) -> None:
    repo, root, _main, _tree = repository
    for ref in (
        "refs/heads/main",
        "refs/heads/feature",
        "refs/heads/unrelated",
        "refs/remotes/origin/main",
        "refs/tags/lightweight",
        "refs/tags/base-tag",
        "refs/tags/release",
        "refs/tags/tree-tag",
    ):
        git(repo, "update-ref", "-d", ref)
    result = commit_containment.get_containment(str(repo), root)
    assert result is not None
    assert result["refs"] == []
    assert result["truncated"] is False


def test_invalid_revision_does_not_reach_git_expression(repository: tuple[Path, str, str, str]) -> None:
    repo, _root, _main, _tree = repository
    for value in ("", "--help", "HEAD~1", "main..other", "refs/heads/main:README", "refs/heads/../main"):
        with pytest.raises(commit_containment.CommitContainmentInputError):
            commit_containment.get_containment(str(repo), value)

    assert commit_containment.get_containment(str(repo), "0" * 40) is None


def test_record_and_byte_limits_are_explicitly_truncated(repository: tuple[Path, str, str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    repo, _root, main, _tree = repository
    for index in range(12):
        git(repo, "update-ref", f"refs/heads/bounded-{index:02d}-with-a-long-name", main)

    monkeypatch.setattr(commit_containment, "MAX_REFS", 3)
    bounded = commit_containment.get_containment(str(repo), main)
    assert bounded is not None
    assert len(bounded["refs"]) == 3
    assert bounded["truncated"] is True
    assert bounded["record_limit"] == 3

    monkeypatch.setattr(commit_containment, "MAX_REFS", 1_000)
    monkeypatch.setattr(commit_containment, "MAX_OUTPUT_BYTES", 256)
    output_bounded = commit_containment.get_containment(str(repo), main)
    assert output_bounded is not None
    assert output_bounded["truncated"] is True
    assert len(output_bounded["refs"]) < 12 + 6


def test_query_is_read_only_and_does_not_create_fetch_side_effect(repository: tuple[Path, str, str, str]) -> None:
    repo, _root, main, _tree = repository
    before = git(repo, "status", "--porcelain", "--untracked-files=all")
    result = commit_containment.get_containment(str(repo), main)
    after = git(repo, "status", "--porcelain", "--untracked-files=all")
    assert result is not None
    assert before == after
    assert "fetch" not in result["command"]
