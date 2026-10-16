from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import reflog


def git(repo: Path, *args: str, **kwargs) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        **kwargs,
    )
    return result.stdout


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Reflog Test")
    git(repo, "config", "user.email", "reflog@example.test")
    git(repo, "commit", "--allow-empty", "-qm", "base")
    return repo


def test_reads_actual_reflog_time_and_checkout_reset_actions(tmp_path: Path):
    repo = make_repo(tmp_path)
    first = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "commit", "--allow-empty", "-qm", "second")
    second = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "reset", "--hard", first)
    git(repo, "checkout", "-qb", "topic")
    git(repo, "checkout", "-q", "main")

    result = reflog.get_reflog(str(repo), "HEAD")

    assert result is not None
    assert result["available"] is True
    assert result["truncated"] is False
    assert result["records"]
    assert any(row["hash"] == second and row["message"].startswith("commit:") for row in result["records"])
    assert any("reset:" in row["message"] for row in result["records"])
    assert any("checkout:" in row["message"] for row in result["records"])
    assert all(row["actor"] == "Reflog Test <reflog@example.test>" for row in result["records"])
    assert all(row["date"] and "T" in row["date"] for row in result["records"])
    # The timestamp comes from the reflog selector, not from the pointed
    # commit's committer date.
    assert all(row["date"] == row["selector"].split("@{", 1)[1][:-1] for row in result["records"])


def test_full_refs_and_missing_ref_are_explicit(tmp_path: Path):
    repo = make_repo(tmp_path)
    result = reflog.get_reflog(str(repo), "refs/heads/main")
    assert result is not None
    assert result["ref"] == "refs/heads/main"
    assert result["available"] is True
    missing = reflog.get_reflog(str(repo), "refs/heads/no-such-branch")
    assert missing == {
        "ref": "refs/heads/no-such-branch",
        "records": [],
        "truncated": False,
        "available": False,
        "command": missing["command"],
    }


def test_no_reflog_is_not_a_git_failure(tmp_path: Path):
    repo = make_repo(tmp_path)
    git(repo, "config", "core.logAllRefUpdates", "false")
    # A new branch created after disabling reflogs is a present ref without a
    # log file, which must be distinguishable from a failed Git invocation.
    git(repo, "branch", "no-log")
    result = reflog.get_reflog(str(repo), "refs/heads/no-log")
    assert result is not None
    assert result["records"] == []
    assert result["available"] is False


def test_missing_and_git_failure_are_not_fabricated_success(monkeypatch):
    calls: list[list[str]] = []

    def fake_run(_repo: str, args: list[str]):
        calls.append(args)
        if args[:2] == ["show-ref", "--verify"]:
            return "", 1
        if args[:2] == ["reflog", "exists"]:
            return "", 1
        raise AssertionError(f"unexpected Git command: {args}")

    monkeypatch.setattr(reflog.gitinfo, "_run_with_status", fake_run)
    missing = reflog.get_reflog("repo", "refs/heads/missing")
    assert missing is not None and missing["available"] is False and missing["records"] == []

    def failed_run(_repo: str, args: list[str]):
        if args[:2] == ["show-ref", "--verify"]:
            return "", 128
        raise AssertionError(f"unexpected Git command: {args}")

    monkeypatch.setattr(reflog.gitinfo, "_run_with_status", failed_run)
    assert reflog.get_reflog("repo", "refs/heads/main") is None


@pytest.mark.parametrize(
    "value",
    ["", "--all", "HEAD~1", "HEAD@{1}", "refs/heads/main..other", "refs/tags/v1", "refs/heads/a b", "refs/heads/.hidden"],
)
def test_ref_validation_rejects_revision_expressions_and_options(value: str):
    with pytest.raises(reflog.ReflogInputError):
        reflog.get_reflog("repo", value)


def test_valid_ref_metacharacters_are_shell_quoted_in_copied_command(tmp_path: Path):
    repo = make_repo(tmp_path)
    branch = "refs/heads/x;echo-PWN"
    git(repo, "branch", branch.removeprefix("refs/heads/"))

    result = reflog.get_reflog(str(repo), branch)

    assert result is not None
    assert "'refs/heads/x;echo-PWN'" in result["command"]


def test_records_are_bounded_and_mark_truncation(tmp_path: Path, monkeypatch):
    repo = make_repo(tmp_path)
    # Keep the test fast while exercising the same bounded response logic.
    monkeypatch.setattr(reflog, "MAX_RECORDS", 2)
    git(repo, "commit", "--allow-empty", "-qm", "one")
    git(repo, "commit", "--allow-empty", "-qm", "two")
    git(repo, "commit", "--allow-empty", "-qm", "three")
    result = reflog.get_reflog(str(repo), "HEAD")
    assert result is not None
    assert len(result["records"]) == 2
    assert result["truncated"] is True
