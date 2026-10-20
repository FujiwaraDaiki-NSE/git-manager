from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from app import file_attributes


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


def configure(repo: Path) -> None:
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "File attributes test")
    git(repo, "config", "user.email", "file-attributes@example.invalid")


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    configure(tmp_path)
    (tmp_path / ".gitattributes").write_text(
        "*.txt text eol=lf\n*.bin -text\nsrc/alpha.txt diff=custom\n",
        encoding="utf-8",
    )
    (tmp_path / "crlf.txt").write_bytes(b"one\r\ntwo\r\n")
    (tmp_path / "lf.txt").write_bytes(b"one\ntwo\n")
    (tmp_path / "mixed.txt").write_bytes(b"one\r\ntwo\n")
    (tmp_path / "binary.bin").write_bytes(b"prefix\x00suffix")
    (tmp_path / " space\tname\n.txt").write_bytes(b"odd\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "alpha.txt").write_bytes(b"alpha\n")
    (tmp_path / "src" / "plain.txt").write_bytes(b"plain\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "initial attributes")
    # Leave the working-tree attribute rules dirty so mode selection has a
    # visible, testable difference from the staged index rules.
    (tmp_path / ".gitattributes").write_text(
        "*.txt text eol=crlf\n*.bin -text\nsrc/alpha.txt diff=working-only\n",
        encoding="utf-8",
    )
    return tmp_path


def test_inventory_preserves_paths_and_reports_eol_facts(repository: Path) -> None:
    result = file_attributes.get_eol_inventory(str(repository))
    assert result is not None
    by_path = {entry["path"]: entry for entry in result["entries"]}
    assert set(by_path) == {
        ".gitattributes",
        "crlf.txt",
        "lf.txt",
        "mixed.txt",
        "binary.bin",
        " space\tname\n.txt",
        "src/alpha.txt",
        "src/plain.txt",
    }
    assert by_path["crlf.txt"]["index_eol"] == "lf"
    assert by_path["crlf.txt"]["worktree_eol"] == "crlf"
    assert by_path["crlf.txt"]["attribute_eol"] == "crlf"
    assert by_path["mixed.txt"]["eol_status"] == "mixed"
    assert "mixed" in by_path["mixed.txt"]["flags"]
    assert by_path["binary.bin"]["index_eol"] == "-text"
    assert by_path["binary.bin"]["worktree_eol"] == "-text"
    assert by_path["binary.bin"]["attribute_eol"] is None
    assert result["truncated"] is False


def test_attribute_modes_and_missing_attributes_are_explicit(repository: Path) -> None:
    worktree = file_attributes.inspect_attributes(
        str(repository), ["src/alpha.txt", "src/plain.txt", "missing\nfile"], "worktree"
    )
    index = file_attributes.inspect_attributes(
        str(repository), ["src/alpha.txt", "src/plain.txt", "missing\nfile"], "index"
    )
    assert worktree is not None and index is not None
    worktree_by_path = {entry["path"]: entry["attributes"] for entry in worktree["entries"]}
    index_by_path = {entry["path"]: entry["attributes"] for entry in index["entries"]}
    assert worktree_by_path["src/alpha.txt"]["eol"] == "crlf"
    assert worktree_by_path["src/alpha.txt"]["diff"] == "working-only"
    assert index_by_path["src/alpha.txt"]["eol"] == "lf"
    assert index_by_path["src/alpha.txt"]["diff"] == "custom"
    assert worktree_by_path["missing\nfile"] == {}
    assert index_by_path["missing\nfile"] == {}


def test_inspection_rejects_unsafe_paths_and_exceeds_batch_bound(repository: Path) -> None:
    with pytest.raises(file_attributes.FileAttributesError):
        file_attributes.inspect_attributes(str(repository), [], "worktree")
    for value in ("", "/tmp/outside", "../outside", "src/../outside", "safe\x00file"):
        with pytest.raises(file_attributes.FileAttributesError):
            file_attributes.inspect_attributes(str(repository), [value], "worktree")
    with pytest.raises(file_attributes.FileAttributesError):
        file_attributes.inspect_attributes(str(repository), ["file.txt"], "other")
    with pytest.raises(file_attributes.FileAttributesError):
        file_attributes.inspect_attributes(
            str(repository), [f"file-{index}.txt" for index in range(file_attributes.MAX_ATTRIBUTE_PATHS + 1)], "worktree"
        )


def test_inventory_entry_bound_is_explicitly_truncated(repository: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_attributes, "MAX_INVENTORY_ENTRIES", 2)
    result = file_attributes.get_eol_inventory(str(repository))
    assert result is not None
    assert result["truncated"] is True
    assert len(result["entries"]) == 2
    assert result["limit"] == 2


def test_attribute_output_bound_is_an_explicit_fault_without_partial_result(
    repository: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(file_attributes, "MAX_OUTPUT_BYTES", 16)
    with pytest.raises(file_attributes.AttributeOutputTooLarge) as error:
        file_attributes.inspect_attributes(str(repository), ["src/alpha.txt"], "worktree")
    assert error.value.code == "attributes_output_too_large"


def test_large_attribute_batch_is_streamed_without_pipe_deadlock(
    repository: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules = "\n".join(f"* custom{index}=value-{index}" for index in range(200)) + "\n"
    (repository / ".gitattributes").write_text(rules, encoding="utf-8")
    monkeypatch.setattr(file_attributes, "MAX_OUTPUT_BYTES", 1_024)
    paths = [f"file-{index}-{'x' * 4_000}" for index in range(100)]
    with pytest.raises(file_attributes.AttributeOutputTooLarge):
        file_attributes.inspect_attributes(str(repository), paths, "worktree")


def test_inspection_is_read_only(repository: Path) -> None:
    index = repository / ".git" / "index"
    before_bytes = index.read_bytes()
    before_mtime = index.stat().st_mtime_ns
    assert file_attributes.get_eol_inventory(str(repository)) is not None
    assert file_attributes.inspect_attributes(str(repository), ["crlf.txt"], "worktree") is not None
    assert index.read_bytes() == before_bytes
    assert index.stat().st_mtime_ns == before_mtime
    assert git(repository, "status", "--porcelain=v1") == " M .gitattributes\n"
