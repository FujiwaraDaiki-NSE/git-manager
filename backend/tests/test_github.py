import json
import subprocess
import threading
from types import SimpleNamespace
import pytest
from app import github


def test_remote_is_explicit_github_only(monkeypatch):
    for remote, expected in [("git@github.com:owner/repo.git", "owner/repo"), ("https://github.com/owner/repo.git", "owner/repo"), ("ssh://git@github.com/owner/repo.git", "owner/repo"), ("https://github.com.attacker/repo.git", None), ("/tmp/repo", None)]:
        monkeypatch.setattr(github.gitinfo, "_run", lambda *args: remote)
        assert github.repository("repo") == expected


def test_paginated_metadata_and_no_credentials_in_payload(monkeypatch):
    pr = {"number": 1, "url": "https://github.com/o/r/pull/1", "merge": "a" * 40, "head_sha": "b" * 40, "base": "main", "head": "feature", "head_repo": "o/r", "base_repo": "o/r", "merged_at": "2026-09-29T00:00:00Z"}
    def run(args, **kwargs):
        assert args[:4] == ["gh", "api", "--hostname", "github.com"]
        assert "--paginate" in args
        assert kwargs["timeout"] == 15
        return SimpleNamespace(returncode=0, stdout=json.dumps([pr]) + '\n[]', stderr="secret")
    monkeypatch.setattr(github.subprocess, "run", run)
    result = github._read("o/r")
    assert result["status"] == "available"
    assert result["pulls"] == [pr]
    assert "secret" not in json.dumps(result)


@pytest.mark.parametrize("credential_name", ["GH_TOKEN", "GITHUB_TOKEN"])
def test_gh_credentials_are_forwarded_to_subprocess_without_entering_payload(monkeypatch, credential_name):
    token = f"test-{credential_name.lower()}-value"
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv(credential_name, token)

    def run(_args, **kwargs):
        assert kwargs["env"][credential_name] == token
        return SimpleNamespace(returncode=1, stdout="", stderr=f"auth failed: {token}")

    monkeypatch.setattr(github.subprocess, "run", run)
    result = github._read("o/r")
    assert result["status"] == "unavailable"
    assert token not in json.dumps(result)


@pytest.mark.parametrize("failure", ["auth", "timeout", "missing", "malformed", "partial"])
def test_failures_never_report_no_prs_as_success(monkeypatch, failure):
    def run(*args, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired("gh", 15)
        if failure == "missing":
            raise FileNotFoundError("gh")
        return SimpleNamespace(returncode=1 if failure == "auth" else 0, stdout='[] {broken' if failure == "partial" else '{}', stderr="secret")
    monkeypatch.setattr(github.subprocess, "run", run)
    result = github._read("o/r")
    assert result["status"] == "unavailable"
    assert result["pulls"] == []
    assert "secret" not in json.dumps(result)


@pytest.mark.parametrize("kind, loader, reader_name", [
    ("merged", github.load, "_read"), ("open", github.load_open, "_read_open"),
])
@pytest.mark.parametrize("refresh_status", ["available", "unavailable"])
def test_empty_and_expired_cache_refresh_without_waiting(monkeypatch, kind, loader, reader_name, refresh_status):
    monkeypatch.setattr(github, "_cache", {})
    monkeypatch.setattr(github, "_pending", {})
    monkeypatch.setattr(github, "repository", lambda _: "o/r")
    monkeypatch.setattr(github.scanner, "repo_layout", lambda repo: SimpleNamespace(common_root=repo))
    clock = [0]
    monkeypatch.setattr(github.time, "monotonic", lambda: clock[0])
    initial = {**github.unavailable(""), "status": "available", "reason": None, "checked_at": 100}
    refreshed = {**github.unavailable("offline"), "status": refresh_status, "checked_at": 200}
    started, release = threading.Event(), threading.Event()
    notified = threading.Event()
    notifications = set()
    calls = []

    def read(name):
        calls.append(name)
        started.set()
        assert release.wait(timeout=5)
        return initial if len(calls) == 1 else refreshed

    def publish(event, data):
        notifications.add((event, data["id"]))
        if len(notifications) == 2:
            notified.set()

    monkeypatch.setattr(github, reader_name, read)
    monkeypatch.setattr(github.bus, "publish_threadsafe", publish)
    try:
        pending = loader("/repo")
        assert pending["repository"] == "o/r"
        assert pending["status"] == "pending"
        assert pending["checked_at"] is None
        assert pending["pulls"] == []
        assert started.wait(timeout=2)
        assert loader("/clone") == pending
        assert loader("/repo") == pending
        assert calls == ["o/r"]
    finally:
        release.set()
        assert notified.wait(timeout=5)
    assert notifications == {("project", "/clone"), ("project", "/repo")}
    assert loader("/repo") is initial
    assert calls == ["o/r"]

    started.clear()
    release.clear()
    notified.clear()
    notifications.clear()
    clock[0] = 61
    try:
        assert loader("/repo") is initial
        assert started.wait(timeout=2)
        # Return the original checked_at while the refresh remains blocked.
        assert loader("/repo") is initial
        assert loader("/clone") is initial
        assert calls == ["o/r", "o/r"]
    finally:
        release.set()
        assert notified.wait(timeout=5)
    assert loader("/repo") is refreshed
    assert github._cache[f"{kind}:o/r"] == (121, refreshed)
    assert calls == ["o/r", "o/r"]


def test_open_pr_graphql_pages_and_nulls(monkeypatch):
    item = dict(number=2, url="https://github.com/o/r/pull/2", title="変更", isDraft=True,
                headRefName="feature", headRefOid="a" * 40, baseRefName="main",
                headRepository={"nameWithOwner": "o/r"}, reviewDecision=None,
                commits={"nodes": [{"commit": {"statusCheckRollup": None}}]})
    def page(nodes, more):
        return json.dumps({"data": {"repository": {"pullRequests": {
            "nodes": nodes, "pageInfo": {"hasNextPage": more, "endCursor": "cursor"}}}}})
    output = [page([item], True) + '\n' + page([], False)]
    def run(args, **kwargs):
        assert args[:5] == ["gh", "api", "--hostname", "github.com", "graphql"]
        assert "--paginate" in args
        assert kwargs["timeout"] == 15
        return SimpleNamespace(returncode=0, stdout=output[0])
    monkeypatch.setattr(github.subprocess, "run", run)
    result = github._read_open("o/r")
    assert result["status"] == "available"
    assert result["pulls"][0]["reviewDecision"] is None
    assert result["pulls"][0]["ciState"] is None
    assert result["pulls"][0]["headRepository"] == "o/r"
    item["reviewDecision"] = "APPROVED"
    item["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = {"state": "SUCCESS"}
    output[0] = page([item], False)
    assert github._read_open("o/r")["pulls"][0]["ciState"] == "SUCCESS"
    for invalid in [page([item], True), page([item], False) + '\n{broken', '{"errors":[{"message":"secret"}]}']:
        output[0] = invalid
        failed = github._read_open("o/r")
        assert failed["status"] == "unavailable"
        assert failed["pulls"] == []
        assert "secret" not in json.dumps(failed)
