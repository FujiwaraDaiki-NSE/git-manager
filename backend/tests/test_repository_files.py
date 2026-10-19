"""Revision file browser tests use Git objects, never checkout reads."""
from __future__ import annotations

import base64
import subprocess
from pathlib import Path

import pytest

from app import repository_files
from app.repository_files import (
    MAX_BLOB_BYTES,
    RepositoryFilesInputError,
    RepositoryFilesNotFound,
    get_file,
    list_files,
)


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


@pytest.fixture
def repository(tmp_path: Path) -> tuple[Path, str, str]:
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Repository files test")
    git(tmp_path, "config", "user.email", "repository-files@example.invalid")
    git(tmp_path, "config", "core.hooksPath", "/dev/null")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "example.ts").write_text("one\n", encoding="utf-8")
    (tmp_path / "binary\tfile.bin").write_bytes(b"\x00\x01\xff")
    (tmp_path / "line\nfile.txt").write_text("odd path\n", encoding="utf-8")
    outside = tmp_path.parent / "repository-files-outside.txt"
    outside.write_text("must never be followed", encoding="utf-8")
    (tmp_path / "link").symlink_to(outside)
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial revision")
    first = git(tmp_path, "rev-parse", "HEAD")
    (tmp_path / "src" / "example.ts").write_text("one\ntwo\n", encoding="utf-8")
    git(tmp_path, "commit", "-am", "second revision")
    second = git(tmp_path, "rev-parse", "HEAD")
    return tmp_path, first, second


def test_list_files_returns_directory_entries_and_pins_revision(repository: tuple[Path, str, str]) -> None:
    repo, first, _ = repository
    result = list_files(str(repo), first)
    assert result is not None
    assert result["pinned_hash"] == first
    assert result["truncated"] is False
    by_path = {entry["path"]: entry for entry in result["entries"]}
    assert by_path["src"]["type"] == "tree"
    assert by_path["src/example.ts"]["type"] == "blob"
    assert by_path["binary\tfile.bin"]["type"] == "blob"
    assert by_path["line\nfile.txt"]["type"] == "blob"


def test_get_file_preserves_binary_and_does_not_follow_symlink(repository: tuple[Path, str, str]) -> None:
    repo, first, _ = repository
    odd = get_file(str(repo), first, "line\nfile.txt")
    assert odd is not None
    assert odd["text"] == "odd path\n"

    binary = get_file(str(repo), first, "binary\tfile.bin")
    assert binary is not None
    assert binary["binary"] is True
    assert binary["text"] is None
    assert base64.b64decode(binary["content_base64"]) == b"\x00\x01\xff"
    assert binary["downloadable"] is True

    link = get_file(str(repo), first, "link")
    assert link is not None
    assert link["kind"] == "symlink"
    assert link["downloadable"] is False
    assert link["text"] == str(repo.parent / "repository-files-outside.txt")


def test_get_file_rejects_directories_and_path_traversal(repository: tuple[Path, str, str]) -> None:
    repo, first, _ = repository
    with pytest.raises(RepositoryFilesNotFound):
        get_file(str(repo), first, "src")
    for value in ("../outside", "/etc/passwd", "src/../example.ts"):
        with pytest.raises(RepositoryFilesInputError):
            get_file(str(repo), first, value)
    with pytest.raises(RepositoryFilesInputError):
        list_files(str(repo), "--help")


def test_large_blob_is_partial_preview_and_never_downloadable(tmp_path: Path) -> None:
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Repository files test")
    git(tmp_path, "config", "user.email", "repository-files@example.invalid")
    data = b"x" * (MAX_BLOB_BYTES + 1)
    (tmp_path / "large.dat").write_bytes(data)
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "large blob")
    revision = git(tmp_path, "rev-parse", "HEAD")

    result = get_file(str(tmp_path), revision, "large.dat")
    assert result is not None
    assert result["size"] == MAX_BLOB_BYTES + 1
    assert result["truncated"] is True
    assert result["downloadable"] is False
    assert len(base64.b64decode(result["content_base64"])) == MAX_BLOB_BYTES


def test_pinned_hash_remains_stable_when_named_ref_moves(repository: tuple[Path, str, str]) -> None:
    repo, first, second = repository
    first_listing = list_files(str(repo), "main")
    assert first_listing is not None
    assert first_listing["pinned_hash"] == second

    # Move the named branch after the listing.  Reading with the returned
    # immutable hash must still produce the original snapshot.
    git(repo, "update-ref", "refs/heads/main", first)
    moved = list_files(str(repo), "main")
    assert moved is not None
    assert moved["pinned_hash"] == first
    old_file = get_file(str(repo), first_listing["pinned_hash"], "src/example.ts")
    assert old_file is not None
    assert old_file["text"] == "one\ntwo\n"


def test_inventory_entry_cap_stops_git_but_targeted_file_lookup_is_unbounded(repository: tuple[Path, str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    repo, first, _ = repository
    monkeypatch.setattr(repository_files, "MAX_TREE_ENTRIES", 2)
    result = repository_files.list_files(str(repo), first)
    assert result is not None
    assert len(result["entries"]) == 2
    assert result["truncated"] is True

    # The exact file endpoint uses a literal targeted ls-tree request and is
    # still able to inspect a path that the bounded inventory did not return.
    selected = repository_files.get_file(str(repo), first, "src/example.ts")
    assert selected is not None
    assert selected["text"] == "one\n"


def test_inventory_byte_cap_reports_truncation_without_retaining_unbounded_output(repository: tuple[Path, str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    repo, first, _ = repository
    monkeypatch.setattr(repository_files, "MAX_TREE_BYTES", 1)
    result = repository_files.list_files(str(repo), first)
    assert result is not None
    assert result["truncated"] is True
    assert len(result["entries"]) == 0
    assert result["byte_limit"] == 1
