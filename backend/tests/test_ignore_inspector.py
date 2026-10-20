from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import ignore_inspector


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


@pytest.fixture()
def ignore_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Ignore Test")
    git(repo, "config", "user.email", "ignore@example.invalid")
    (repo / ".gitignore").write_text(
        "cache/\n*.log\n!keep.log\n\\!literal.txt\n",
        encoding="utf-8",
    )
    (repo / "src").mkdir()
    (repo / "src" / ".gitignore").write_text("secret*.tmp\n", encoding="utf-8")
    (repo / "cache").mkdir()
    (repo / "cache" / "generated.txt").write_text("cache\n", encoding="utf-8")
    (repo / "debug.log").write_text("debug\n", encoding="utf-8")
    (repo / "keep.log").write_text("keep\n", encoding="utf-8")
    (repo / "src" / "secret note.tmp").write_text("secret\n", encoding="utf-8")
    (repo / "!literal.txt").write_text("literal\n", encoding="utf-8")
    (repo / "line\nname.txt").write_text("odd\n", encoding="utf-8")
    git(repo, "add", "--", ".gitignore", "src/.gitignore", "keep.log")
    git(repo, "commit", "-qm", "rules")
    return repo


def _rows(result: dict[str, object]) -> dict[str, dict[str, object]]:
    values = result["results"]
    assert isinstance(values, list)
    return {row["path"]: row for row in values}


def test_inventory_is_ignored_untracked_and_reports_nested_winning_rules(ignore_repo: Path) -> None:
    result = ignore_inspector.inventory_ignored(str(ignore_repo))
    assert result is not None
    rows = {row["path"]: row for row in result["entries"]}

    assert set(rows) == {
        "!literal.txt",
        "cache/generated.txt",
        "debug.log",
        "src/secret note.tmp",
    }
    assert "keep.log" not in rows
    assert rows["cache/generated.txt"]["source"] == ".gitignore"
    assert rows["cache/generated.txt"]["line"] == 1
    assert rows["cache/generated.txt"]["pattern"] == "cache/"
    assert rows["src/secret note.tmp"]["source"] == "src/.gitignore"
    assert rows["src/secret note.tmp"]["line"] == 1
    assert rows["!literal.txt"]["negation"] is False
    assert all(row["ignored"] is True and row["tracked"] is False for row in rows.values())
    assert result["truncated"] is False


def test_check_ignore_distinguishes_tracked_negative_and_no_match(ignore_repo: Path) -> None:
    (ignore_repo / "tracked.log").write_text("tracked\n", encoding="utf-8")
    git(ignore_repo, "add", "-f", "--", "tracked.log")
    paths = [
        "cache/generated.txt",
        "src/secret note.tmp",
        "keep.log",
        "tracked.log",
        "line\nname.txt",
        "!literal.txt",
        "./keep.log",
        "no-match.txt",
    ]
    result = ignore_inspector.check_ignore(str(ignore_repo), paths)
    assert result is not None
    rows = _rows(result)
    assert list(rows) == paths
    assert rows["cache/generated.txt"]["ignored"] is True
    assert rows["cache/generated.txt"]["tracked"] is False
    assert rows["keep.log"]["ignored"] is False
    assert rows["keep.log"]["negation"] is True
    assert rows["keep.log"]["tracked"] is True
    assert rows["./keep.log"]["negation"] is True
    assert rows["./keep.log"]["tracked"] is True
    assert rows["tracked.log"]["ignored"] is True
    assert rows["tracked.log"]["tracked"] is True
    assert rows["line\nname.txt"]["source"] is None
    assert rows["no-match.txt"]["pattern"] is None
    assert rows["no-match.txt"]["negation"] is None


def test_global_exclude_rule_is_reported_without_reading_host_files(ignore_repo: Path, tmp_path: Path) -> None:
    global_exclude = tmp_path / "global excludes"
    global_exclude.write_text("*.global\n", encoding="utf-8")
    git(ignore_repo, "config", "--local", "core.excludesFile", str(global_exclude))
    (ignore_repo / "outside.global").write_text("global\n", encoding="utf-8")

    result = ignore_inspector.check_ignore(str(ignore_repo), ["outside.global"])
    assert result is not None
    row = _rows(result)["outside.global"]
    assert row["ignored"] is True
    assert row["source"] == str(global_exclude)
    assert row["line"] == 1
    assert row["pattern"] == "*.global"


def test_inspection_does_not_change_index_or_worktree_state(ignore_repo: Path) -> None:
    index = ignore_repo / ".git" / "index"
    before_index = index.read_bytes()
    before_status = git(ignore_repo, "status", "--porcelain=v2", "-z")
    assert ignore_inspector.inventory_ignored(str(ignore_repo)) is not None
    assert ignore_inspector.check_ignore(str(ignore_repo), ["debug.log", "keep.log"]) is not None
    assert index.read_bytes() == before_index
    assert git(ignore_repo, "status", "--porcelain=v2", "-z") == before_status


def test_inputs_reject_absolute_traversal_nul_and_excess_candidates(ignore_repo: Path) -> None:
    for value in ("/tmp/no", "../outside", "a/../b", "", "a\x00b"):
        with pytest.raises(ignore_inspector.IgnoreInspectorInputError):
            ignore_inspector.check_ignore(str(ignore_repo), [value])
    with pytest.raises(ignore_inspector.IgnoreInspectorInputError):
        ignore_inspector.check_ignore(str(ignore_repo), [f"file-{index}" for index in range(101)])


def test_inventory_entry_bound_is_explicit_and_preserves_a_bounded_prefix(
    ignore_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(6):
        (ignore_repo / "cache" / f"generated-{index}.txt").write_text("cache\n", encoding="utf-8")
    monkeypatch.setattr(ignore_inspector, "MAX_INVENTORY_ENTRIES", 3)
    result = ignore_inspector.inventory_ignored(str(ignore_repo))
    assert result is not None
    assert result["truncated"] is True
    assert result["entry_limit"] == 3
    assert len(result["entries"]) == 3
