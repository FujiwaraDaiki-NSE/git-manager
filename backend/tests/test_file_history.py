import subprocess

import pytest

from app import file_history


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8").strip()


def configure(repo):
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "History Test")
    git(repo, "config", "user.email", "history@example.test")


def commit_file(repo, path, content, message):
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    git(repo, "add", "--", path)
    git(repo, "commit", "-qm", message)


def test_follow_renames_and_deleted_paths_keep_literal_names(tmp_path):
    configure(tmp_path)
    old = "old name.txt"
    new = "renamed\nname.txt"
    commit_file(tmp_path, old, "base\n", "base")
    git(tmp_path, "mv", "--", old, new)
    git(tmp_path, "commit", "-qm", "rename")
    commit_file(tmp_path, new, "changed\n", "change")
    git(tmp_path, "rm", "--", new)
    git(tmp_path, "commit", "-qm", "delete")
    head = git(tmp_path, "rev-parse", "HEAD")

    followed = file_history.get_file_history(str(tmp_path), head, new, True, 0)
    assert followed is not None
    assert [row["subject"] for row in followed["commits"]] == ["delete", "change", "rename", "base"]
    rename = next(row for row in followed["commits"] if row["subject"] == "rename")
    assert rename["old_path"] == old
    assert rename["path"] == new
    assert followed["pinned_hash"] == head

    without_follow = file_history.get_file_history(str(tmp_path), head, new, False, 0)
    assert without_follow is not None
    assert [row["subject"] for row in without_follow["commits"]] == ["delete", "change", "rename"]


def test_deleted_file_can_be_requested_at_explicit_revision(tmp_path):
    configure(tmp_path)
    path = "deleted.txt"
    commit_file(tmp_path, path, "gone\n", "add")
    added = git(tmp_path, "rev-parse", "HEAD")
    git(tmp_path, "rm", "--", path)
    git(tmp_path, "commit", "-qm", "delete")
    deleted = git(tmp_path, "rev-parse", "HEAD")

    result = file_history.get_file_history(str(tmp_path), added, path, False, 0)
    assert result is not None
    assert [row["subject"] for row in result["commits"]] == ["add"]
    assert file_history.get_file_history(str(tmp_path), deleted, path, False, 0)["commits"][0]["subject"] == "delete"


def test_newline_path_and_no_match_are_distinct_from_git_failure(tmp_path, monkeypatch):
    configure(tmp_path)
    path = "dir/file\nwith-newline.txt"
    commit_file(tmp_path, path, "content\n", "newline path")
    head = git(tmp_path, "rev-parse", "HEAD")

    result = file_history.get_file_history(str(tmp_path), head, path, False, 0)
    assert result is not None
    assert result["commits"][0]["path"] == path
    assert file_history.get_file_history(str(tmp_path), head, "missing.txt", False, 0)["commits"] == []

    monkeypatch.setattr(file_history.gitinfo, "_run", lambda *args: None)
    assert file_history.get_file_history(str(tmp_path), head, path, False, 0) is None


def test_pagination_is_bounded_and_uses_pinned_hash(tmp_path):
    configure(tmp_path)
    path = "many.txt"
    for index in range(105):
        commit_file(tmp_path, path, f"{index}\n", f"commit {index}")
    head = git(tmp_path, "rev-parse", "HEAD")

    first = file_history.get_file_history(str(tmp_path), "HEAD", path, False, 0)
    assert first is not None
    assert len(first["commits"]) == 100
    assert first["has_more"] is True
    assert first["next_offset"] == 100
    assert first["pinned_hash"] == head

    second = file_history.get_file_history(str(tmp_path), first["pinned_hash"], path, False, first["next_offset"])
    assert second is not None
    assert len(second["commits"]) == 5
    assert second["has_more"] is False
    assert second["next_offset"] is None
    assert {row["hash"] for row in first["commits"]}.isdisjoint(row["hash"] for row in second["commits"])


def test_paths_and_revisions_cannot_be_used_as_git_options(tmp_path):
    configure(tmp_path)
    commit_file(tmp_path, "safe.txt", "safe\n", "safe")
    commit_file(tmp_path, "[abc].txt", "bracket\n", "bracket")
    commit_file(tmp_path, "glob*.txt", "glob\n", "glob")
    head = git(tmp_path, "rev-parse", "HEAD")

    # A dash-prefixed filename stays after Git's literal-path separator and
    # cannot turn into --all or another revision selector.
    result = file_history.get_file_history(str(tmp_path), head, "--all", False, 0)
    assert result is not None and result["commits"] == []
    bracket = file_history.get_file_history(str(tmp_path), head, "[abc].txt", False, 0)
    assert bracket is not None and [row["subject"] for row in bracket["commits"]] == ["bracket"]
    glob = file_history.get_file_history(str(tmp_path), head, "glob*.txt", False, 0)
    assert glob is not None and [row["subject"] for row in glob["commits"]] == ["glob"]
    assert file_history.get_file_history(str(tmp_path), "--all", "safe.txt", False, 0) is None

    for unsafe in ("/tmp/secret", "../secret", "dir/../secret", r"dir\..\secret", ""):
        with pytest.raises(file_history.FileHistoryInputError):
            file_history.get_file_history(str(tmp_path), head, unsafe, False, 0)

