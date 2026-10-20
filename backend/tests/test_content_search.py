"""Content search reads only the selected Git tree and keeps its response bounded."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import content_search


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()


def configure(repo: Path) -> None:
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Content search test")
    git(repo, "config", "user.email", "content-search@example.invalid")
    git(repo, "config", "core.hooksPath", "/dev/null")


def commit(repo: Path, message: str) -> str:
    git(repo, "add", ".")
    git(repo, "commit", "-qm", message)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repository(tmp_path: Path) -> tuple[Path, str, str]:
    configure(tmp_path)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "alpha.txt").write_text(
        "Needle first\nneedle lower\nnone\nNeedle last\n",
        encoding="utf-8",
    )
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "beta.md").write_text("Needle documentation\n", encoding="utf-8")
    odd_name = "odd\nname.txt"
    (tmp_path / odd_name).write_text("Needle odd path\n", encoding="utf-8")
    (tmp_path / "binary.dat").write_bytes(b"Needle\x00binary\n")
    first = commit(tmp_path, "initial content")

    (tmp_path / "src" / "alpha.txt").write_text("changed revision\n", encoding="utf-8")
    second = commit(tmp_path, "replace source")
    return tmp_path, first, second


def test_search_is_literal_case_aware_scoped_and_excludes_binary(repository: tuple[Path, str, str]) -> None:
    repo, _first, second = repository
    insensitive = content_search.get_content_search(str(repo), second, "Needle", False, "")
    assert insensitive is not None
    assert insensitive["pinned_hash"] == second
    assert insensitive["case_sensitive"] is False
    assert [match["path"] for match in insensitive["matches"]] == [
        "docs/beta.md",
        "odd\nname.txt",
    ]
    assert all(match["path"] != "binary.dat" for match in insensitive["matches"])

    # A query containing regexp punctuation remains literal data.
    literal = content_search.get_content_search(str(repo), second, "Needle.", False, "")
    assert literal is not None and literal["matches"] == []

    scoped = content_search.get_content_search(str(repo), second, "Needle", False, "src")
    assert scoped is not None
    assert scoped["directory"] == "src"
    assert scoped["matches"] == []


def test_search_pins_named_ref_before_it_moves(repository: tuple[Path, str, str]) -> None:
    repo, first, second = repository
    before_move = content_search.get_content_search(str(repo), "main", "Needle", False, "")
    assert before_move is not None
    assert before_move["pinned_hash"] == second

    git(repo, "update-ref", "refs/heads/main", first)
    pinned = content_search.get_content_search(str(repo), before_move["pinned_hash"], "Needle", False, "")
    moved = content_search.get_content_search(str(repo), "main", "Needle", False, "")
    assert pinned is not None and moved is not None
    assert pinned["pinned_hash"] == second
    assert [match["path"] for match in pinned["matches"]] == [
        "docs/beta.md",
        "odd\nname.txt",
    ]
    assert any(match["path"] == "src/alpha.txt" for match in moved["matches"])


def test_no_matches_is_a_success_and_invalid_revision_is_a_git_fault(repository: tuple[Path, str, str]) -> None:
    repo, _first, second = repository
    no_match = content_search.get_content_search(str(repo), second, "not present", False, "")
    assert no_match is not None
    assert no_match["matches"] == []
    assert no_match["truncated"] is False
    assert content_search.get_content_search(str(repo), "does-not-exist", "Needle", False, "") is None


def test_invalid_inputs_raise_value_error(repository: tuple[Path, str, str]) -> None:
    repo, _first, second = repository
    invalid = [
        ("", second, "Needle", False, ""),
        (str(repo), second, "", False, ""),
        (str(repo), second, "Needle", 0, ""),
        (str(repo), second, "Needle", False, "../outside"),
        (str(repo), second, "Needle", False, "/tmp"),
        (str(repo), second, "Needle", False, "src/../outside"),
        (str(repo), second, "Needle\x00x", False, ""),
    ]
    for args in invalid:
        with pytest.raises(ValueError):
            content_search.get_content_search(*args)


def test_match_and_output_limits_are_reported(repository: tuple[Path, str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    repo, _first, second = repository
    source = repo / "many.txt"
    source.write_text("needle\n" * 20, encoding="utf-8")
    many = commit(repo, "many matches")

    monkeypatch.setattr(content_search, "MAX_MATCHES", 3)
    result = content_search.get_content_search(str(repo), many, "needle", False, "")
    assert result is not None
    assert len(result["matches"]) == 3
    assert result["truncated"] is True
    assert result["limit"] == 3

    monkeypatch.setattr(content_search, "MAX_OUTPUT_BYTES", 40)
    bounded = content_search.get_content_search(str(repo), many, "needle", False, "")
    assert bounded is not None
    assert bounded["truncated"] is True
    assert len(bounded["matches"]) <= 3
    assert bounded["byte_limit"] == 40


def test_search_does_not_change_checkout_index_or_head(repository: tuple[Path, str, str]) -> None:
    repo, _first, second = repository
    before_status = git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    before_head = git(repo, "rev-parse", "HEAD")
    index = repo / ".git" / "index"
    before_index_mtime = index.stat().st_mtime_ns

    result = content_search.get_content_search(str(repo), second, "Needle", False, "")
    assert result is not None
    assert git(repo, "rev-parse", "HEAD") == before_head
    assert index.stat().st_mtime_ns == before_index_mtime
    assert git(repo, "status", "--porcelain=v1", "--untracked-files=all") == before_status
