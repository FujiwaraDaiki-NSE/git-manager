from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import stashes


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Stash Test")
    git(repo, "config", "user.email", "stash@example.invalid")
    (repo / "tracked.txt").write_text("base\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "base")
    return repo


def test_empty_inventory_is_distinct_from_git_failure(tmp_path: Path):
    repo = make_repo(tmp_path)

    result = stashes.get_stashes(str(repo))

    assert result is not None
    assert result["stashes"] == []
    assert result["command"].startswith("git stash list")
    assert stashes.get_stashes(str(tmp_path / "missing")) is None


def test_stash_inventory_and_detail_keep_tracked_and_untracked_parts_separate(tmp_path: Path):
    repo = make_repo(tmp_path)
    (repo / "tracked.txt").write_text("base\nstaged\n", encoding="utf-8")
    git(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("base\nstaged\nunstaged\n", encoding="utf-8")
    untracked_names = {"line\nbreak.txt", "tab\tfile.txt"}
    for name in untracked_names:
        (repo / name).write_text("untracked\n", encoding="utf-8")
    git(repo, "stash", "push", "-u", "-m", "stash subject")

    inventory = stashes.get_stashes(str(repo))
    assert inventory is not None
    assert len(inventory["stashes"]) == 1
    entry = inventory["stashes"][0]
    assert len(entry["hash"]) == 40
    assert entry["selector"] == "stash@{0}"
    assert entry["subject"] == "On main: stash subject"
    assert entry["date"]

    result = stashes.get_stash(str(repo), entry["hash"])
    assert result is not None
    assert result["hash"] == entry["hash"]
    assert result["tracked"]["available"] is True
    assert [file["path"] for file in result["tracked"]["files"]] == ["tracked.txt"]
    assert result["tracked"]["files"][0]["additions"] == 2
    assert "+staged" in result["tracked"]["patch"]
    assert "+unstaged" in result["tracked"]["patch"]
    assert result["untracked"]["available"] is True
    assert {file["path"] for file in result["untracked"]["files"]} == untracked_names
    assert all(file["additions"] == 1 for file in result["untracked"]["files"])
    assert "untracked" in result["untracked"]["patch"]
    assert entry["hash"] in result["tracked"]["command"]
    assert entry["hash"] in result["untracked"]["command"]
    assert "stash@" not in result["tracked"]["command"]
    assert "apply" not in result["tracked"]["command"]
    assert "pop" not in result["untracked"]["command"]


def test_stash_without_untracked_files_has_explicit_empty_untracked_part(tmp_path: Path):
    repo = make_repo(tmp_path)
    (repo / "tracked.txt").write_text("changed\n", encoding="utf-8")
    git(repo, "stash", "push", "-m", "tracked only")
    entry = stashes.get_stashes(str(repo))["stashes"][0]

    result = stashes.get_stash(str(repo), entry["hash"])

    assert result is not None
    assert result["untracked"] == {
        "available": False,
        "files": [],
        "patch": "",
        "patch_truncated": False,
        "command": None,
    }
    assert result["untracked_command"] is None


def test_invalid_arbitrary_and_vanished_hashes_are_not_inspectable(tmp_path: Path):
    repo = make_repo(tmp_path)
    commit_hash = git(repo, "rev-parse", "HEAD").strip()

    assert stashes.valid_hash("0" * 39) is False
    assert stashes.valid_hash("0" * 40) is True
    with pytest.raises(stashes.StashNotFound):
        stashes.get_stash(str(repo), "0" * 40)
    with pytest.raises(stashes.StashNotFound):
        stashes.get_stash(str(repo), commit_hash)

    (repo / "tracked.txt").write_text("stashed\n", encoding="utf-8")
    git(repo, "stash", "push", "-m", "vanish me")
    entry = stashes.get_stashes(str(repo))["stashes"][0]
    git(repo, "stash", "clear")
    with pytest.raises(stashes.StashNotFound):
        stashes.get_stash(str(repo), entry["hash"])


def test_patch_is_bounded_without_breaking_utf8(tmp_path: Path, monkeypatch):
    repo = make_repo(tmp_path)
    (repo / "tracked.txt").write_text("".join(f"行 {index}\n" for index in range(80)), encoding="utf-8")
    git(repo, "stash", "push", "-m", "large patch")
    entry = stashes.get_stashes(str(repo))["stashes"][0]
    monkeypatch.setattr(stashes, "PATCH_MAX_BYTES", 64)

    result = stashes.get_stash(str(repo), entry["hash"])

    assert result is not None
    assert result["tracked"]["patch_truncated"] is True
    assert len(result["tracked"]["patch"].encode("utf-8")) <= 64
    result["tracked"]["patch"].encode("utf-8").decode("utf-8")
