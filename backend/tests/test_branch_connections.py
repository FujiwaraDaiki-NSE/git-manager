import itertools
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import branch_rows, detail


_git_times = itertools.count()


def git(repo: Path, *args: str) -> str:
    # Cross-ref reflogs only retain second precision. Give distinct fixture
    # operations distinct times so their order is actually provable.
    timestamp = (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=next(_git_times))).isoformat()
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_COMMITTER_DATE": timestamp, "GIT_AUTHOR_DATE": timestamp},
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


def test_local_fast_forward_and_lagging_remote_are_distinct(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "remote", "add", "origin", "git@github.com:owner/repo.git")
    git(repo, "switch", "-q", "-c", "ui", "main")
    start = commit(repo, "UI foundation")
    git(repo, "update-ref", "refs/remotes/origin/ui", start)
    git(repo, "branch", "--set-upstream-to=origin/ui", "ui")
    git(repo, "switch", "-q", "-c", "quantity", "ui")
    source = commit(repo, "quantity")
    git(repo, "switch", "-q", "ui")
    git(repo, "merge", "--ff-only", "quantity")
    commit(repo, "UI follow-up")

    rows = rows_for(repo, {"repository": "owner/repo"})
    result = branch_rows.connections(str(repo), rows)
    assert len(result["pairs"]) == len(result["refs"]) * (len(result["refs"]) - 1) // 2
    edge = next(item for item in result["edges"] if item.get("operation") == "fast_forward")
    assert edge["source_row_id"] == "local:quantity"
    assert edge["target_row_id"] == "remote:origin/ui"
    assert edge["target_ref_id"] == "refs/heads/ui"
    assert edge["source_commit_hash"] == edge["target_commit_hash"] == source

    def oriented_pair(first: str, second: str):
        pair = next(item for item in result["pairs"] if {
            item["left_ref_id"], item["right_ref_id"]
        } == {first, second})
        counts = (pair["left_only"], pair["right_only"])
        return counts if pair["left_ref_id"] == first else counts[::-1]

    assert oriented_pair("refs/heads/ui", "refs/heads/quantity") == (1, 0)
    assert oriented_pair("refs/remotes/origin/ui", "refs/heads/quantity") == (0, 1)


def test_pr_integration_without_source_ancestry_remains_a_recorded_event(tmp_path: Path) -> None:
    # Squash/rebase PRs integrate changes without preserving the source SHA.
    # The recorded PR must survive alongside the distinct current DAG facts.
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature", "main")
    source = commit(repo, "source changes")
    git(repo, "switch", "-q", "main")
    integrated = commit(repo, "integrated changes under a different SHA")
    github_data = {"repository": "owner/repo", "pulls": [{
        "number": 99, "url": "https://github.com/owner/repo/pull/99",
        "merged_at": "2026-10-07T00:00:00Z", "merge": integrated,
        "base": "main", "head": "feature", "head_sha": source,
        "head_repo": "owner/repo", "base_repo": "owner/repo",
    }]}
    result = branch_rows.connections(str(repo), rows_for(repo, github_data), github_data=github_data)
    edge = next(item for item in result["edges"] if item["id"] == "merge:pr:99")
    assert edge["source_commit_hash"] == source
    assert edge["target_commit_hash"] == integrated
    assert edge["evidence"] == "pull_request"
    assert edge["occurred_at"] == "2026-10-07T00:00:00Z"
    assert edge["source"] == "owner/repo:feature"
    assert edge["target"] == "owner/repo:main"
    assert edge["source_ref_id"] is None
    pair = next(item for item in result["pairs"] if {
        item["left_ref_id"], item["right_ref_id"]
    } == {"refs/heads/main", "refs/heads/feature"})
    assert pair["relation"] == "diverged"


def test_current_refs_are_compared_without_inventing_a_creation_branch(tmp_path: Path) -> None:
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

    assert not any(item["evidence"] == "merge_base" for item in result["edges"])
    assert len(result["pairs"]) == len(result["refs"]) * (len(result["refs"]) - 1) // 2
    pair = next(item for item in result["pairs"] if {
        item["left_ref_id"], item["right_ref_id"]
    } == {"refs/remotes/origin/main", "refs/remotes/origin/feature"})
    assert pair["relation"] == "diverged"
    assert pair["merge_bases"] == [git(repo, "merge-base", main_tip, feature_base).strip()]
    assert any(item["source"] == "HEAD" for item in result["unresolved"])


def test_named_branch_creation_keeps_a_stationary_base_and_advanced_child(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    base = git(repo, "rev-parse", "main").strip()
    git(repo, "switch", "-q", "-c", "feature", "main")
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
    assert edge["source_commit_hash"] == feature_head
    assert edge["target_commit_hash"] == merge_hash
    assert edge["source_commit"]["hash"] == feature_head
    assert edge["source_commit"]["date"] == git(repo, "show", "-s", "--format=%cI", feature_head).strip()
    assert edge["target_commit"]["hash"] == merge_hash
    assert edge["target_commit"]["date"] == git(repo, "show", "-s", "--format=%cI", merge_hash).strip()


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

    assert not any(item["evidence"] == "pull_request" for item in result["edges"])
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

    assert not any(item["evidence"] == "pull_request" for item in result["edges"])
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


def test_current_relation_failure_is_exposed(monkeypatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature", "main")
    commit(repo, "feature")
    rows = rows_for(repo, {"repository": "owner/repo"})
    # A current-state read failure must not erase recorded branch events.
    monkeypatch.setattr(branch_rows.branch_ref_relations, "build", lambda *_args: {
        "refs": [], "pairs": [], "ancestry_status": "unavailable",
    })
    result = branch_rows.connections(str(repo), rows)
    assert result["status"] == "partial"
    assert result["ancestry_status"] == "unavailable"
    assert any(item["evidence"] == "reflog" for item in result["edges"])


def test_branch_common_base_metadata_is_available_beyond_first_history_page(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    common_base = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "switch", "-q", "-c", "feature", "main")
    for index in range(201):
        commit(repo, f"feature {index}")
    git(repo, "switch", "-q", "main")
    for index in range(201):
        commit(repo, f"main {index}")

    rows = rows_for(repo, {"repository": "owner/repo"})
    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    edge = next(item for item in result["edges"] if item["kind"] == "branch")
    assert edge["commit_hash"] == common_base
    assert edge["source_commit_hash"] == common_base
    assert edge["target_commit_hash"] == common_base
    assert edge["source_commit"]["hash"] == common_base
    assert edge["target_commit"]["hash"] == common_base
    common_base_date = git(repo, "show", "-s", "--format=%cI", common_base).strip()
    assert edge["source_commit"]["date"] == common_base_date
    assert edge["target_commit"]["date"] == common_base_date


def test_missing_pr_source_object_keeps_hash_and_explicit_null_metadata(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "feature")
    commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "--no-ff", "-q", "feature", "-m", "merge feature")
    merge_hash = git(repo, "rev-parse", "HEAD").strip()
    missing_source = "f" * 40
    rows = rows_for(repo, {
        "repository": "owner/repo",
        "pulls": [{
            "number": 46,
            "url": "https://github.com/owner/repo/pull/46",
            "merged_at": "2026-09-30T00:00:00Z",
            "merge": merge_hash,
            "base": "main",
            "head": "deleted-feature",
            "head_sha": missing_source,
            "head_repo": "owner/repo",
            "base_repo": "owner/repo",
        }],
    })

    result = branch_rows.connections(
        str(repo), rows, default_branch="main", github_data={"repository": "owner/repo"}
    )

    edge = next(item for item in result["edges"] if item["kind"] == "merge")
    assert edge["source_commit_hash"] == missing_source
    assert edge["source_commit"] is None
    assert edge["target_commit_hash"] == merge_hash
    assert edge["target_commit"]["hash"] == merge_hash
