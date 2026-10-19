from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import app.worktree_diff as worktree_diff
from app.worktree_diff import PATCH_MAX_BYTES, WorktreeDiffError, get_worktree_diff


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.invalid")
    return repo


def commit_file(repo: Path, name: str, content: bytes) -> None:
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    git(repo, "add", "--", name)
    git(repo, "commit", "-qm", "fixture")


def test_staged_and_unstaged_snapshots_are_independent(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "same.txt", b"base\n")
    (repo / "same.txt").write_bytes(b"base\nstaged\n")
    git(repo, "add", "same.txt")
    (repo / "same.txt").write_bytes(b"base\nstaged\nworking\n")

    staged = get_worktree_diff(str(repo), "staged", "same.txt", False)
    unstaged = get_worktree_diff(str(repo), "unstaged", "same.txt", False)

    assert staged["stage"] == "staged"
    assert staged["stage_label"] == "ステージ済み"
    assert staged["files"] == [{"additions": 1, "deletions": 0, "path": "same.txt", "binary": False}]
    assert "+staged" in staged["patch"]
    assert "+working" not in staged["patch"]
    assert unstaged["stage"] == "unstaged"
    assert "-staged" in unstaged["patch"] or "+working" in unstaged["patch"]
    assert "+working" in unstaged["patch"]


def test_clean_repository_has_explicit_complete_empty_result(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "clean.txt", b"clean\n")

    result = get_worktree_diff(str(repo), "unstaged", None, False)

    assert result["files"] == []
    assert result["patch"] == ""
    assert result["patch_truncated"] is False
    assert result["patch_complete"] is True
    assert result["metadata_complete"] is True
    assert result["snapshot"]["scope"] == "all"


def test_staged_diff_works_before_the_first_commit(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "first.txt").write_text("first\n", encoding="utf-8")
    git(repo, "add", "--", "first.txt")

    result = get_worktree_diff(str(repo), "staged", "first.txt", False)

    assert result["files"] == [{"additions": 1, "deletions": 0, "path": "first.txt", "binary": False}]
    assert "new file mode" in result["patch"]
    assert "+first" in result["patch"]


def test_ignore_whitespace_removes_whitespace_only_change(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "spaces.txt", b"value\n")
    (repo / "spaces.txt").write_bytes(b"  value  \n")

    with_whitespace = get_worktree_diff(str(repo), "unstaged", None, False)
    ignored = get_worktree_diff(str(repo), "unstaged", None, True)

    assert len(with_whitespace["files"]) == 1
    assert with_whitespace["patch"]
    assert ignored["files"] == []
    assert ignored["patch"] == ""
    assert ignored["ignore_whitespace"] is True


@pytest.mark.parametrize("selected", ["old name.txt", "new name.txt"])
def test_selected_rename_keeps_complete_old_and_new_pair(tmp_path: Path, selected: str) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "old name.txt", b"same\n")
    git(repo, "mv", "--", "old name.txt", "new name.txt")
    git(repo, "add", "-A")

    result = get_worktree_diff(str(repo), "staged", selected, False)

    assert result["files"] == [{
        "additions": 0,
        "deletions": 0,
        "path": "new name.txt",
        "binary": False,
        "old_path": "old name.txt",
    }]
    assert "rename from old name.txt" in result["patch"]
    assert "rename to new name.txt" in result["patch"]
    assert "'old name.txt'" in result["command"]
    assert "'new name.txt'" in result["command"]


def test_selected_copy_keeps_the_source_and_destination_when_git_detects_copy(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "source.txt", b"same\n")
    (repo / "copy.txt").write_bytes(b"same\n")
    git(repo, "add", "--", "copy.txt")

    result = get_worktree_diff(str(repo), "staged", "copy.txt", False)

    # Git's default copy detector reports a copy when the source is unchanged;
    # if a particular Git version chooses an add record, it is still a
    # complete destination-only inventory rather than a fabricated source.
    assert result["files"][0]["path"] == "copy.txt"
    if "old_path" in result["files"][0]:
        assert result["files"][0]["old_path"] == "source.txt"
        assert "copy from source.txt" in result["patch"]
        assert "copy to copy.txt" in result["patch"]


def test_selected_copy_scope_keeps_a_modified_source_record_coherent(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "source.txt", b"same\n")
    (repo / "source.txt").write_bytes(b"changed\n")
    (repo / "copy.txt").write_bytes(b"same\n")
    git(repo, "add", "-A")

    result = get_worktree_diff(str(repo), "staged", "copy.txt", False)

    # The expanded literal scope includes the copy pair and the source's
    # independent edit; neither record is silently dropped from the same Git
    # snapshot.
    assert {item["path"] for item in result["files"]} == {"copy.txt", "source.txt"}
    assert "copy from source.txt" in result["patch"]
    assert "'source.txt'" in result["command"]
    assert "'copy.txt'" in result["command"]


def test_binary_diff_is_complete_metadata_with_unknown_line_counts(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "image.bin", b"\x00\x01\x02\x03")
    (repo / "image.bin").write_bytes(b"\x00\x01\x02\x04")

    result = get_worktree_diff(str(repo), "unstaged", "image.bin", False)

    assert result["files"][0]["binary"] is True
    assert result["files"][0]["additions"] == "-"
    assert result["files"][0]["deletions"] == "-"
    assert result["stats"]["binary"] == 1
    assert "Binary files" in result["patch"] or "GIT binary patch" in result["patch"]


def test_literal_pathspec_handles_tab_newline_and_glob_characters(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    name = "odd[glob]*\tname\n.txt"
    commit_file(repo, name, b"before\n")
    (repo / name).write_bytes(b"after\n")

    result = get_worktree_diff(str(repo), "unstaged", name, False)

    assert result["files"][0]["path"] == name
    assert "-before" in result["patch"]
    assert "+after" in result["patch"]
    assert name in result["command"]


def test_untracked_path_is_explicitly_excluded_without_reading_contents(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "tracked.txt", b"tracked\n")
    name = "new[glob].txt"
    (repo / name).write_bytes(b"secret content\n")

    result = get_worktree_diff(str(repo), "unstaged", name, False)

    assert result["files"] == []
    assert result["patch"] == ""
    assert result["excluded"]["untracked"] == [name]
    assert f"'{name}'" in result["command"]


def test_conflicted_path_is_explicitly_excluded_from_file_scope(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "conflict.txt", b"base\n")
    git(repo, "switch", "-qc", "other")
    (repo / "conflict.txt").write_bytes(b"other\n")
    git(repo, "commit", "-qam", "other")
    git(repo, "switch", "main")
    (repo / "conflict.txt").write_bytes(b"main\n")
    git(repo, "commit", "-qam", "main")
    git(repo, "merge", "other", check=False)

    result = get_worktree_diff(str(repo), "unstaged", "conflict.txt", False)

    assert result["files"] == []
    assert result["patch"] == ""
    assert result["excluded"]["conflict"] == ["conflict.txt"]


def make_conflicted_repo(tmp_path: Path) -> Path:
    repo = make_repo(tmp_path)
    commit_file(repo, "conflict.txt", b"base\n")
    commit_file(repo, "normal.txt", b"normal\n")
    git(repo, "switch", "-qc", "other")
    (repo / "conflict.txt").write_bytes(b"other\n")
    git(repo, "commit", "-qam", "other")
    git(repo, "switch", "-q", "main")
    (repo / "conflict.txt").write_bytes(b"main\n")
    git(repo, "commit", "-qam", "main")
    git(repo, "merge", "other", check=False)
    return repo


@pytest.mark.parametrize("stage", ["unstaged", "staged"])
def test_all_scope_conflict_only_is_explicitly_excluded(
    tmp_path: Path,
    stage: str,
) -> None:
    repo = make_conflicted_repo(tmp_path)

    result = get_worktree_diff(str(repo), stage, None, False)

    assert result["files"] == []
    assert result["patch"] == ""
    assert result["metadata_complete"] is True
    assert result["excluded"]["conflict"] == ["conflict.txt"]


@pytest.mark.parametrize("stage", ["unstaged", "staged"])
def test_all_scope_conflict_plus_normal_change_keeps_one_coherent_normal_diff(
    tmp_path: Path,
    stage: str,
) -> None:
    repo = make_conflicted_repo(tmp_path)
    (repo / "normal.txt").write_bytes(b"changed\n")
    if stage == "staged":
        git(repo, "add", "--", "normal.txt")

    result = get_worktree_diff(str(repo), stage, None, False)

    assert result["files"] == [{
        "additions": 1,
        "deletions": 1,
        "path": "normal.txt",
        "binary": False,
    }]
    assert "-normal" in result["patch"]
    assert "+changed" in result["patch"]
    assert "diff --cc conflict.txt" not in result["patch"]
    assert result["excluded"]["conflict"] == ["conflict.txt"]
    assert result["metadata_complete"] is True


def test_patch_is_bounded_and_partial_flag_is_explicit(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    commit_file(repo, "large.txt", b"old\n")
    (repo / "large.txt").write_bytes((b"new line\n" * 40_000))

    result = get_worktree_diff(str(repo), "unstaged", None, False)

    assert result["patch_truncated"] is True
    assert result["patch_complete"] is False
    assert result["patch_limit_bytes"] == PATCH_MAX_BYTES
    assert len(result["patch"].encode("utf-8")) <= PATCH_MAX_BYTES
    assert result["metadata_complete"] is True
    assert result["stats"]["files"] == 1


def test_selected_result_rejects_metadata_from_a_different_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The returned counts must come from the same Git call as the patch."""
    repo = make_repo(tmp_path)
    commit_file(repo, "same.txt", b"base\n")
    (repo / "same.txt").write_bytes(b"working\n")

    inventory_a = "1\t1\tsame.txt\x00"
    # Simulate an index/worktree transition after the rename-expansion
    # inventory: the combined command observes a different file record while
    # the later inventory has already returned to the original snapshot.
    monkeypatch.setattr(worktree_diff, "_run_inventory_limited", lambda *_: inventory_a)
    monkeypatch.setattr(
        worktree_diff,
        "_run_combined_limited",
        lambda *_: ("2\t1\tsame.txt\x00", "diff --git a/same.txt b/same.txt\n", False),
    )

    with pytest.raises(WorktreeDiffError) as error:
        get_worktree_diff(str(repo), "unstaged", "same.txt", False)

    assert error.value.code == "snapshot_changed"


@pytest.mark.parametrize(
    ("stage", "file", "ignore_whitespace", "code"),
    [
        ("other", None, False, "invalid_stage"),
        ("staged", "", False, "invalid_file"),
        ("unstaged", "bad\x00path", False, "invalid_file"),
        ("unstaged", "../outside", False, "invalid_file"),
        ("unstaged", "/etc/passwd", False, "invalid_file"),
        ("unstaged", None, "false", "invalid_ignore_whitespace"),
    ],
)
def test_invalid_parameters_are_rejected_explicitly(
    tmp_path: Path,
    stage: str,
    file: str | None,
    ignore_whitespace: object,
    code: str,
) -> None:
    repo = make_repo(tmp_path)
    with pytest.raises(WorktreeDiffError) as error:
        get_worktree_diff(str(repo), stage, file, ignore_whitespace)  # type: ignore[arg-type]
    assert error.value.code == code
