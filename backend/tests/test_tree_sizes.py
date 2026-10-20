"""Revision tree-size inventory tests use Git objects only."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import tree_sizes
from app.tree_sizes import get_tree_sizes


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


@pytest.fixture
def repository(tmp_path: Path) -> tuple[Path, str, str]:
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Tree sizes test")
    git(tmp_path, "config", "user.email", "tree-sizes@example.invalid")
    git(tmp_path, "config", "core.hooksPath", "/dev/null")

    content = b"same blob\n"
    (tmp_path / "first.txt").write_bytes(content)
    (tmp_path / "duplicate.txt").write_bytes(content)
    (tmp_path / "binary\tfile.bin").write_bytes(b"\x00\x01\xff\x00")
    (tmp_path / "line\nfile.txt").write_bytes(b"odd path\n")
    outside = tmp_path.parent / "tree-sizes-outside.txt"
    outside.write_bytes(b"x" * 4096)
    (tmp_path / "link").symlink_to(outside)
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial tree size revision")
    first = git(tmp_path, "rev-parse", "HEAD")

    (tmp_path / "first.txt").write_bytes(content + b"second revision\n")
    git(tmp_path, "commit", "-am", "second tree size revision")
    second = git(tmp_path, "rev-parse", "HEAD")
    return tmp_path, first, second


def test_get_tree_sizes_reports_actual_blob_symlink_binary_and_odd_path_sizes(
    repository: tuple[Path, str, str],
) -> None:
    repo, first, _ = repository
    result = get_tree_sizes(str(repo), first)

    assert result is not None
    assert result["pinned_hash"] == first
    assert result["truncated"] is False
    assert result["file_count"] == 5
    assert result["unknown_size_count"] == 0
    entries = {entry["path"]: entry for entry in result["entries"]}
    assert entries["first.txt"]["size"] == len(b"same blob\n")
    assert entries["duplicate.txt"]["size"] == len(b"same blob\n")
    assert entries["binary\tfile.bin"]["size"] == 4
    assert entries["line\nfile.txt"]["size"] == len(b"odd path\n")
    assert entries["link"]["mode"] == "120000"
    assert entries["link"]["size"] == len(str(repo.parent / "tree-sizes-outside.txt").encode())
    assert result["total_bytes"] == sum(entry["size"] for entry in entries.values())
    assert result["total_bytes"] > entries["first.txt"]["size"]


def test_duplicate_blob_paths_are_counted_per_path_and_symlink_target_is_not_followed(
    repository: tuple[Path, str, str],
) -> None:
    repo, first, _ = repository
    result = get_tree_sizes(str(repo), first)
    assert result is not None
    entries = {entry["path"]: entry for entry in result["entries"]}
    assert entries["first.txt"]["hash"] == entries["duplicate.txt"]["hash"]
    assert entries["first.txt"]["size"] == entries["duplicate.txt"]["size"]
    # The external file is intentionally much larger than the link text; the
    # inventory must use Git's symlink blob and never stat or read the target.
    assert entries["link"]["size"] < len((repo.parent / "tree-sizes-outside.txt").read_bytes())


def test_gitlink_has_explicit_unknown_size_and_does_not_read_nested_repo(tmp_path: Path) -> None:
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Tree sizes test")
    git(tmp_path, "config", "user.email", "tree-sizes@example.invalid")
    nested = tmp_path / "nested"
    nested.mkdir()
    git(nested, "init", "-b", "main")
    git(nested, "config", "user.name", "Nested")
    git(nested, "config", "user.email", "nested@example.invalid")
    (nested / "payload.bin").write_bytes(b"nested bytes that are not read")
    git(nested, "add", ".")
    git(nested, "commit", "-m", "nested")
    nested_hash = git(nested, "rev-parse", "HEAD")
    # Add a tree entry that points at the nested commit without creating a
    # submodule checkout or asking Git to inspect the nested repository.
    git(tmp_path, "update-index", "--add", "--cacheinfo", f"160000,{nested_hash},submodule")
    git(tmp_path, "commit", "-m", "gitlink")
    revision = git(tmp_path, "rev-parse", "HEAD")

    result = get_tree_sizes(str(tmp_path), revision)

    assert result is not None
    assert result["file_count"] == 1
    assert result["unknown_size_count"] == 1
    assert result["total_bytes"] == 0
    entry = result["entries"][0]
    assert entry["path"] == "submodule"
    assert entry["type"] == "commit"
    assert entry["mode"] == "160000"
    assert entry["size"] is None


def test_empty_tree_is_a_valid_zero_inventory_and_invalid_revision_is_no_result(tmp_path: Path) -> None:
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Tree sizes test")
    git(tmp_path, "config", "user.email", "tree-sizes@example.invalid")
    git(tmp_path, "commit", "--allow-empty", "-m", "empty tree")
    revision = git(tmp_path, "rev-parse", "HEAD")
    result = get_tree_sizes(str(tmp_path), revision)
    assert result is not None
    assert result["entries"] == []
    assert result["total_bytes"] == 0
    assert result["file_count"] == 0
    assert result["unknown_size_count"] == 0
    assert result["truncated"] is False
    assert get_tree_sizes(str(tmp_path), "does-not-exist") is None


def test_revision_is_pinned_before_named_ref_moves(repository: tuple[Path, str, str]) -> None:
    repo, first, second = repository
    result = get_tree_sizes(str(repo), "main")
    assert result is not None
    assert result["pinned_hash"] == second
    git(repo, "update-ref", "refs/heads/main", first)
    moved = get_tree_sizes(str(repo), "main")
    assert moved is not None
    assert moved["pinned_hash"] == first
    assert {entry["path"] for entry in moved["entries"]} == {entry["path"] for entry in get_tree_sizes(str(repo), first)["entries"]}


def test_entry_limit_returns_partial_aggregates_and_stops_at_limit(
    repository: tuple[Path, str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, first, _ = repository
    monkeypatch.setattr(tree_sizes, "MAX_TREE_ENTRIES", 2)
    result = get_tree_sizes(str(repo), first)
    assert result is not None
    assert len(result["entries"]) == 2
    assert result["file_count"] == 2
    assert result["truncated"] is True
    assert result["total_bytes"] == sum(entry["size"] for entry in result["entries"] if entry["size"] is not None)


def test_output_byte_limit_is_bounded_and_reports_partial_aggregate(
    repository: tuple[Path, str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, first, _ = repository
    monkeypatch.setattr(tree_sizes, "MAX_TREE_BYTES", 1)
    result = get_tree_sizes(str(repo), first)
    assert result is not None
    assert result["byte_limit"] == 1
    assert result["truncated"] is True
    assert len(result["entries"]) == 0


def test_git_failure_returns_no_result_and_does_not_write_repository(
    repository: tuple[Path, str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, first, _ = repository
    before = git(repo, "status", "--porcelain=v1")
    monkeypatch.setattr(tree_sizes.gitinfo, "GIT", "/definitely/not/a/git-binary")
    assert get_tree_sizes(str(repo), first) is None
    assert git(repo, "status", "--porcelain=v1") == before
