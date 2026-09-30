import subprocess
from pathlib import Path

from app import branch_rows, detail


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def commit(repo: Path, subject: str) -> str:
    git(repo, "commit", "--allow-empty", "-qm", subject)
    return git(repo, "rev-parse", "HEAD").strip()


def init_repo(repo: Path) -> None:
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    commit(repo, "base")


def rows_for(repo: Path, github_data: dict | None = None) -> list[dict]:
    branches = detail.get_branches(str(repo))
    assert branches is not None
    lanes = [
        {
            "id": f"branch:{item['name']}",
            "name": item["name"],
            "branch": item["name"],
            "head": git(repo, "rev-parse", f"refs/heads/{item['name']}").strip(),
            "upstream": item.get("upstream"),
            "upstream_ahead": None,
            "upstream_behind": None,
            "path": None,
        }
        for item in branches["local"]
    ]
    return branch_rows.build(str(repo), branches, lanes, github_data, "main") or []


def test_branch_estimate_points_from_default_to_diverged_head(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    origin = tmp_path / "origin.git"
    git(origin, "init", "--bare", "-q", "-b", "main") if origin.exists() else None
    if not origin.exists():
        origin.mkdir()
        git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature")
    feature_base = commit(repo, "feature work")
    git(repo, "push", "-q", "-u", "origin", "feature")
    git(repo, "switch", "-q", "main")
    main_tip = commit(repo, "main work")
    git(repo, "push", "-q", "origin", "main")
    git(repo, "remote", "set-url", "origin", "git@github.com:owner/repo.git")
    git(repo, "remote", "set-head", "origin", "main")

    rows = rows_for(repo, {"repository": "owner/repo"})
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    edge = next(item for item in result["edges"] if item["kind"] == "branch")
    assert edge["source_row_id"] == "remote:origin/main"
    assert edge["target_row_id"] == "remote:origin/feature"
    assert edge["commit_hash"] == git(repo, "merge-base", str(main_tip), str(feature_base)).strip()
    assert result["status"] == "available"


def test_branch_estimate_keeps_a_stationary_base_and_advanced_child(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    base = git(repo, "rev-parse", "main").strip()
    git(repo, "switch", "-q", "-c", "feature")
    child = commit(repo, "feature work")
    rows = rows_for(repo, {"repository": "owner/repo"})
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    edge = next(item for item in result["edges"] if item["kind"] == "branch")
    assert edge["source_row_id"] == "local:main"
    assert edge["target_row_id"] == "local:feature"
    assert edge["commit_hash"] == base
    assert edge["commit_hash"] != child


def test_merge_pr_edge_resolves_exact_repository_target(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature")
    feature_head = commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    merge_hash = commit(repo, "main before merge")
    git(repo, "merge", "--no-ff", "-q", "feature", "-m", "merge feature")
    merge_hash = git(repo, "rev-parse", "HEAD").strip()
    rows = rows_for(repo, {
        "repository": "owner/repo",
        "pulls": [{
            "number": 42,
            "url": "https://github.com/owner/repo/pull/42",
            "merged_at": "2026-09-30T00:00:00Z",
            "merge": merge_hash,
            "base": "main",
            "head": "feature",
            "head_sha": feature_head,
            "head_repo": "owner/repo",
            "base_repo": "owner/repo",
        }],
    })
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    edge = next(item for item in result["edges"] if item["kind"] == "merge")
    assert edge["id"] == "merge:pr:42"
    assert edge["source_row_id"] == "history:pr:42"
    assert edge["target_row_id"] == "local:main"
    assert edge["commit_hash"] == merge_hash
    assert edge["evidence"] == "pull_request"


def test_pr_without_merge_commit_stays_unresolved(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature")
    feature_head = commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "--no-ff", "-q", "feature", "-m", "merge feature")
    rows = rows_for(repo, {
        "repository": "owner/repo",
        "pulls": [{
            "number": 43,
            "url": "https://github.com/owner/repo/pull/43",
            "merged_at": "2026-09-30T00:00:00Z",
            "merge": None,
            "base": "main",
            "head": "feature",
            "head_sha": feature_head,
            "head_repo": "owner/repo",
            "base_repo": "owner/repo",
        }],
    })
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    assert not any(item["kind"] == "merge" for item in result["edges"])
    unresolved = next(item for item in result["unresolved"] if item["kind"] == "merge")
    assert unresolved["reason"] == "merge_commit_unavailable"
    assert unresolved["target_row_id"] == "local:main"
    assert unresolved["pr_number"] == 43
    assert unresolved["pr_url"].endswith("/43")


def test_recreated_target_tip_rejects_non_ancestor_pr_merge(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    base = git(repo, "rev-parse", "main").strip()
    git(repo, "switch", "-q", "-c", "feature")
    feature_head = commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "--no-ff", "-q", "feature", "-m", "merge feature")
    merge_hash = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "reset", "--hard", "-q", base)
    rows = rows_for(repo, {
        "repository": "owner/repo",
        "pulls": [{
            "number": 44,
            "url": "https://github.com/owner/repo/pull/44",
            "merged_at": "2026-09-30T00:00:00Z",
            "merge": merge_hash,
            "base": "main",
            "head": "feature",
            "head_sha": feature_head,
            "head_repo": "owner/repo",
            "base_repo": "owner/repo",
        }],
    })
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    assert not any(item["kind"] == "merge" for item in result["edges"])
    unresolved = next(item for item in result["unresolved"] if item["kind"] == "merge")
    assert unresolved["reason"] == "merge_commit_not_ancestor"
    assert unresolved["target_row_id"] == "local:main"


def test_same_repository_target_refs_remain_ambiguous(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    merge_hash = commit(repo, "merge object")
    rows = [
        {
            "id": "remote:origin/main",
            "name": "main",
            "remote_ref": "origin/main",
            "remote_hash": merge_hash,
            "remote_repository": "owner/repo",
            "historical": False,
        },
        {
            "id": "remote:upstream/main",
            "name": "main",
            "remote_ref": "upstream/main",
            "remote_hash": merge_hash,
            "remote_repository": "owner/repo",
            "historical": False,
        },
        {
            "id": "history:pr:45",
            "name": "feature",
            "remote_ref": None,
            "remote_repository": None,
            "historical": True,
            "pull_requests": [{
                "number": 45,
                "url": "https://github.com/owner/repo/pull/45",
                "target_repository": "owner/repo",
                "target_branch": "main",
                "commit_hash": merge_hash,
            }],
        },
    ]
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    assert not result["edges"]
    unresolved = next(item for item in result["unresolved"] if item["kind"] == "merge")
    assert unresolved["reason"] == "target_branch_ambiguous"
    assert unresolved["target_row_id"] is None


def test_missing_pr_target_is_unresolved_without_name_only_match(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature")
    feature_head = commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    rows = rows_for(repo, {
        "repository": "owner/repo",
        "pulls": [{
            "number": 7,
            "url": "https://github.com/owner/repo/pull/7",
            "merged_at": "2026-09-30T00:00:00Z",
            "merge": None,
            "base": "deleted-target",
            "head": "feature",
            "head_sha": feature_head,
            "head_repo": "owner/repo",
            "base_repo": "owner/repo",
        }],
    })
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )
    unresolved = next(item for item in result["unresolved"] if item["kind"] == "merge")
    assert unresolved["source_row_id"] == "history:pr:7"
    assert unresolved["target_row_id"] is None
    assert unresolved["target"] == "owner/repo:deleted-target"
    assert unresolved["pr_number"] == 7
    assert result["status"] == "partial"


def test_git_merge_base_failure_is_partial(monkeypatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature")
    commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    commit(repo, "main")
    rows = rows_for(repo, {"repository": "owner/repo"})
    original = branch_rows.gitinfo._run_with_status

    def fail_merge_base(repo_path: str, args: list[str], timeout: int | None = None):
        if args[:2] == ["merge-base", "--all"]:
            return None, None
        return original(repo_path, args, timeout)

    monkeypatch.setattr(branch_rows.gitinfo, "_run_with_status", fail_merge_base)
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )
    assert result["status"] == "partial"
    assert any(item["reason"] == "merge_base_unavailable" for item in result["unresolved"])
