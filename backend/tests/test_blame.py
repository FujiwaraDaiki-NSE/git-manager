from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from app import blame


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


def configure(repo: Path) -> None:
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "First Author")
    git(repo, "config", "user.email", "first@example.test")


def commit_file(repo: Path, name: str, content: str, message: str, *, author: str = "First Author", email: str = "first@example.test") -> str:
    target = repo / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    git(repo, "config", "user.name", author)
    git(repo, "config", "user.email", email)
    git(repo, "add", "--", name)
    git(repo, "commit", "-qm", message)
    return git(repo, "rev-parse", "HEAD").strip()


def test_blame_pins_revision_and_attributes_range_with_exact_metadata(tmp_path: Path) -> None:
    configure(tmp_path)
    first = commit_file(tmp_path, "src/example.ts", "one\ntwo\nthree\n", "base")
    second = commit_file(
        tmp_path,
        "src/example.ts",
        "one\ntwo changed\nthree\n",
        "change second line",
        author="Second Author",
        email="second@example.test",
    )
    third = commit_file(
        tmp_path,
        "src/example.ts",
        "one\ntwo changed\nthree changed\n",
        "change third line",
        author="First Author",
        email="first@example.test",
    )

    result = blame.get_blame(str(tmp_path), "HEAD", "src/example.ts", 2, 3)
    assert result is not None
    assert result["pinned_hash"] == third
    assert result["source_file"] == "src/example.ts"
    assert [line["final_line"] for line in result["lines"]] == [2, 3]
    assert result["lines"][0]["original_line"] == 2
    assert result["lines"][0]["commit"] == second
    assert result["lines"][0]["author"] == "Second Author"
    assert result["lines"][0]["email"] == "second@example.test"
    assert result["lines"][0]["summary"] == "change second line"
    assert result["lines"][0]["content"] == "two changed"
    assert isinstance(result["lines"][0]["time"], int)
    assert result["lines"][1]["commit"] == third

    # The full hash is retained even when the caller asked for a moving ref.
    assert len(result["pinned_hash"]) in {40, 64}
    assert first != second != third


def test_blame_preserves_quoted_filename_and_line_content(tmp_path: Path) -> None:
    configure(tmp_path)
    name = "dir/ name\twith\nnewline.txt "
    head = commit_file(tmp_path, name, "<tag>\tvalue\nvertical\vtab\n", "quoted path")

    result = blame.get_blame(str(tmp_path), head, name, 1, 2)
    assert result is not None
    assert result["source_file"] == name
    assert result["lines"][0]["path"] == name
    assert result["lines"][0]["content"] == "<tag>\tvalue"
    assert result["lines"][1]["content"] == "vertical\vtab"


def test_blame_tracks_deleted_line_back_to_original_line(tmp_path: Path) -> None:
    configure(tmp_path)
    initial = commit_file(tmp_path, "sample.txt", "kept one\ndeleted\nkept three\n", "base")
    latest = commit_file(tmp_path, "sample.txt", "kept one\nkept three\n", "delete middle", author="Second Author", email="second@example.test")

    result = blame.get_blame(str(tmp_path), latest, "sample.txt", 1, 2)
    assert result is not None
    assert [line["original_line"] for line in result["lines"]] == [1, 3]
    assert all(line["commit"] == initial for line in result["lines"])


def test_blame_rename_metadata_reports_original_path(tmp_path: Path) -> None:
    configure(tmp_path)
    old_name = "old name.txt"
    new_name = "new name.txt"
    base = commit_file(tmp_path, old_name, "first\nsecond\n", "base")
    git(tmp_path, "mv", "--", old_name, new_name)
    git(tmp_path, "commit", "-qm", "rename")
    latest = git(tmp_path, "rev-parse", "HEAD").strip()

    result = blame.get_blame(str(tmp_path), latest, new_name, 1, 2)
    assert result is not None
    assert [line["commit"] for line in result["lines"]] == [base, base]
    assert {line["path"] for line in result["lines"]} == {old_name}


def test_blame_rejects_binary_symlink_and_gitlink_objects(tmp_path: Path) -> None:
    configure(tmp_path)
    (tmp_path / "binary.dat").write_bytes(b"prefix\x00suffix")
    git(tmp_path, "add", "--", "binary.dat")
    git(tmp_path, "commit", "-qm", "binary")
    binary_head = git(tmp_path, "rev-parse", "HEAD").strip()
    with pytest.raises(blame.BlameUnsupportedError):
        blame.get_blame(str(tmp_path), binary_head, "binary.dat", 1, 1)

    (tmp_path / "target.txt").write_text("target\n", encoding="utf-8")
    os.symlink("target.txt", tmp_path / "link.txt")
    git(tmp_path, "add", "--", "target.txt", "link.txt")
    git(tmp_path, "commit", "-qm", "symlink")
    symlink_head = git(tmp_path, "rev-parse", "HEAD").strip()
    with pytest.raises(blame.BlameUnsupportedError):
        blame.get_blame(str(tmp_path), symlink_head, "link.txt", 1, 1)

    nested = tmp_path / "nested"
    nested.mkdir()
    git(nested, "init", "-q", "-b", "main")
    git(nested, "config", "user.name", "Nested")
    git(nested, "config", "user.email", "nested@example.test")
    (nested / "inside.txt").write_text("inside\n", encoding="utf-8")
    git(nested, "add", "--", "inside.txt")
    git(nested, "commit", "-qm", "nested")
    git(tmp_path, "add", "--", "nested")
    git(tmp_path, "commit", "-qm", "gitlink")
    gitlink_head = git(tmp_path, "rev-parse", "HEAD").strip()
    with pytest.raises(blame.BlameUnsupportedError):
        blame.get_blame(str(tmp_path), gitlink_head, "nested", 1, 1)


def test_blame_rejects_a_large_blob_before_reading_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configure(tmp_path)
    head = commit_file(tmp_path, "large.txt", "x" * 128 + "\n", "large text")
    monkeypatch.setattr(blame, "MAX_BLOB_BYTES", 64)

    def unexpected_blob_read(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("the blob must be rejected by cat-file -s before it is read")

    monkeypatch.setattr(blame, "_run_bytes_limited", unexpected_blob_read)
    with pytest.raises(blame.BlameUnsupportedError, match="大きすぎる"):
        blame.get_blame(str(tmp_path), head, "large.txt", 1, 1)


def test_blame_bounds_a_single_huge_line_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configure(tmp_path)
    head = commit_file(tmp_path, "long-line.txt", "x" * 2_048 + "\n", "long line")
    monkeypatch.setattr(blame, "MAX_BLAME_OUTPUT_BYTES", 256)
    with pytest.raises(blame.BlameUnsupportedError, match="出力が大きすぎる"):
        blame.get_blame(str(tmp_path), head, "long-line.txt", 1, 1)


def test_blame_range_and_path_validation_are_explicit(tmp_path: Path) -> None:
    configure(tmp_path)
    head = commit_file(tmp_path, "safe.txt", "one\ntwo\n", "safe")
    for start, end in ((0, 1), (2, 1), (1, blame.MAX_LINES + 1)):
        with pytest.raises(blame.BlameInputError):
            blame.get_blame(str(tmp_path), head, "safe.txt", start, end)
    with pytest.raises(blame.BlameGitError):
        blame.get_blame(str(tmp_path), head, "safe.txt", 1, 3)
    for unsafe in ("", "/tmp/outside", "../outside", "dir/../outside", "safe.txt\x00x"):
        with pytest.raises(blame.BlameInputError):
            blame.get_blame(str(tmp_path), head, unsafe, 1, 1)
    option_path_head = commit_file(tmp_path, "--all", "option path\n", "option path")
    option_result = blame.get_blame(str(tmp_path), option_path_head, "--all", 1, 1)
    assert option_result is not None and option_result["lines"][0]["content"] == "option path"
    assert blame.get_blame(str(tmp_path), "--all", "safe.txt", 1, 1) is None


def test_blame_does_not_mutate_repository(tmp_path: Path) -> None:
    configure(tmp_path)
    head = commit_file(tmp_path, "safe.txt", "one\ntwo\n", "safe")
    before_status = git(tmp_path, "status", "--porcelain=v1", "--untracked-files=all")
    before_head = git(tmp_path, "rev-parse", "HEAD")
    before_index_mtime = (tmp_path / ".git" / "index").stat().st_mtime_ns
    assert blame.get_blame(str(tmp_path), head, "safe.txt", 1, 2) is not None
    assert (tmp_path / ".git" / "index").stat().st_mtime_ns == before_index_mtime
    assert git(tmp_path, "status", "--porcelain=v1", "--untracked-files=all") == before_status
    assert git(tmp_path, "rev-parse", "HEAD") == before_head
