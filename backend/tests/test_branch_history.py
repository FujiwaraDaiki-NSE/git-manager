import subprocess

import pytest
from fastapi.testclient import TestClient

from app import branch_history, main


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def history_repo(tmp_path):
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "History Test")
    git(tmp_path, "config", "user.email", "history@example.test")
    for index in range(205):
        git(tmp_path, "commit", "--allow-empty", "-m", f"commit {index}")
    return tmp_path


def test_pages_preserve_snapshot_and_deduplicate_shared_ancestry(history_repo):
    repo = history_repo
    main_head = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-b", "feature", "HEAD~5")
    git(repo, "commit", "--allow-empty", "-m", "feature change")
    heads = [main_head, git(repo, "rev-parse", "HEAD")]
    expected = git(repo, "rev-list", "--date-order", *heads).splitlines()
    first = branch_history.read_page(str(repo), heads, 0)
    assert first is not None
    assert len(first["commits"]) == 200
    assert first["next_offset"] == 200
    git(repo, "commit", "--allow-empty", "-m", "new commit after first page")
    second = branch_history.read_page(str(repo), heads, first["next_offset"])
    assert second is not None and second["next_offset"] is None
    actual = [commit["hash"] for page in (first, second) for commit in page["commits"]]
    assert actual == expected
    assert len(set(actual)) == len(actual) == 206
    assert all(commit["date"] and commit["subject"] for commit in first["commits"])


def test_empty_history_is_distinct_from_git_failure(monkeypatch):
    assert branch_history.read_page("repo", [], 0) == {"commits": [], "next_offset": None}
    monkeypatch.setattr(branch_history.gitinfo, "_run", lambda *args: None)
    assert branch_history.read_page("repo", ["a" * 40], 0) is None


def test_tips_include_old_heads_without_reading_their_ancestry(history_repo):
    newest = git(history_repo, "rev-parse", "HEAD")
    oldest = git(history_repo, "rev-parse", "HEAD~204")
    commits = branch_history.read_tips(str(history_repo), [newest, oldest, newest, "f" * 40])
    assert commits is not None
    assert {commit["hash"] for commit in commits} == {newest, oldest}
    assert len(commits) == 2
    assert all(commit["date"] and commit["subject"] for commit in commits)
    assert branch_history.read_tips(str(history_repo), ["f" * 40]) == []


def test_history_endpoint_requires_known_repo_and_full_hashes(monkeypatch, history_repo):
    repo = str(history_repo)
    monkeypatch.setattr(main, "STATE", {repo: {}})
    client = TestClient(main.app)
    head = git(history_repo, "rev-parse", "HEAD")
    response = client.get("/api/repo/branch-history", params={"path": repo, "heads": head, "offset": 200})
    assert response.status_code == 200
    assert len(response.json()["commits"]) == 5
    assert response.json()["next_offset"] is None
    for params in (
        {"path": repo, "heads": "--all", "offset": 0},
        {"path": repo, "heads": head, "offset": -1},
        {"path": repo, "heads": head},
    ):
        assert client.get("/api/repo/branch-history", params=params).status_code == 422
    assert client.get("/api/repo/branch-history", params={"path": "/unregistered", "heads": head, "offset": 0}).status_code == 404
    monkeypatch.setattr(branch_history.gitinfo, "_run", lambda *args: None)
    assert client.get("/api/repo/branch-history", params={"path": repo, "heads": head, "offset": 0}).status_code == 502
