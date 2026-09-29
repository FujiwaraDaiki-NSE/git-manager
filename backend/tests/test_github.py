import json
import subprocess
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


def test_cache_expiry_does_not_retain_stale_success(monkeypatch):
    github._cache.clear()
    monkeypatch.setattr(github, "repository", lambda _: "o/r")
    clock = [0]
    monkeypatch.setattr(github.time, "monotonic", lambda: clock[0])
    replies = iter([{**github.unavailable(""), "status": "available"}, github.unavailable("offline")])
    monkeypatch.setattr(github, "_read", lambda _: next(replies))
    assert github.load("repo")["status"] == "available"
    assert github.load("repo")["status"] == "available"
    clock[0] = 61
    assert github.load("repo")["status"] == "unavailable"
    github._cache.clear()
