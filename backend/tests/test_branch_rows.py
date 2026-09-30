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


def lane(repo: Path, branch: dict) -> dict:
    return {
        "id": f"branch:{branch['name']}",
        "name": branch["name"],
        "branch": branch["name"],
        "head": git(repo, "rev-parse", f"refs/heads/{branch['name']}").strip(),
        "upstream": branch.get("upstream"),
        "upstream_ahead": None,
        "upstream_behind": None,
        "path": None,
    }


def test_rows_group_by_exact_upstream_and_keep_remote_local_states(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    init_repo(repo)
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")

    git(repo, "switch", "-q", "-c", "feature")
    feature_hash = commit(repo, "feature")
    git(repo, "push", "-q", "-u", "origin", "feature")
    git(repo, "branch", "--track", "feature-copy", "origin/feature")

    git(repo, "switch", "-q", "main")
    git(repo, "switch", "-q", "-c", "local-only")
    commit(repo, "local only")
    git(repo, "switch", "-q", "main")

    git(repo, "switch", "-q", "-c", "stale")
    stale_hash = commit(repo, "stale")
    git(repo, "push", "-q", "-u", "origin", "stale")
    git(repo, "switch", "-q", "main")
    git(repo, "push", "-q", "origin", "--delete", "stale")
    git(repo, "fetch", "-q", "--prune", "origin")

    git(repo, "switch", "-q", "-c", "remote-only")
    commit(repo, "remote only")
    git(repo, "push", "-q", "origin", "remote-only")
    git(repo, "switch", "-q", "main")
    git(repo, "branch", "-D", "remote-only")

    # This is a pull ref fetched below refs/remotes, but its source refspec is
    # refs/pull rather than refs/heads and therefore it must not be a row.
    git(repo, "config", "--add", "remote.origin.fetch", "+refs/pull/*/head:refs/remotes/origin/pr/*/head")
    git(repo, "update-ref", "refs/remotes/origin/pr/137/head", feature_hash)

    branches = detail.get_branches(str(repo))
    assert branches is not None
    lanes = [lane(repo, item) for item in branches["local"]]
    next(item for item in lanes if item["branch"] == "feature")["upstream"] = "origin/stale-cache"
    rows = branch_rows.build(str(repo), branches, lanes, default_branch="main")

    feature = next(row for row in rows if row["remote_ref"] == "origin/feature")
    assert {item["branch"] for item in feature["locals"]} == {"feature", "feature-copy"}
    assert feature["status"] == "synchronized"
    assert feature_hash in feature["commit_hashes"]

    stale = next(row for row in rows if row["name"] == "stale")
    assert stale["remote_ref"] == "origin/stale"
    assert stale["remote_hash"] is None
    assert stale["status"] == "upstream_deleted"
    assert stale_hash in stale["commit_hashes"]

    remote_only = next(row for row in rows if row["name"] == "remote-only")
    assert remote_only["status"] == "remote_only"
    assert remote_only["locals"] == []
    assert any(row["status"] == "local_only" and row["name"] == "local-only" for row in rows)
    assert not any("pr/137/head" in str(row["remote_ref"]) for row in rows)


def test_merged_deleted_pr_gets_named_history_row_and_fork_stays_explicit(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    init_repo(repo)
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")

    git(repo, "switch", "-q", "-c", "completed")
    completed_hash = commit(repo, "completed source")
    git(repo, "push", "-q", "-u", "origin", "completed")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "--no-ff", "-q", "completed", "-m", "merge completed")
    merge_hash = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "push", "-q", "origin", "main")
    git(repo, "branch", "-D", "completed")
    git(repo, "push", "-q", "origin", "--delete", "completed")
    git(repo, "fetch", "-q", "--prune", "origin")

    branches = detail.get_branches(str(repo))
    assert branches is not None
    lanes = [lane(repo, item) for item in branches["local"]]
    github_data = {
        "status": "available",
        "repository": "owner/repo",
        "pulls": [
            {
                "number": 10,
                "url": "https://github.com/owner/repo/pull/10",
                "merged_at": "2026-09-30T00:00:00Z",
                "merge": merge_hash,
                "base": "main",
                "head": "completed",
                "head_sha": completed_hash,
                "head_repo": "owner/repo",
                "base_repo": "owner/repo",
            },
            {
                "number": 11,
                "url": "https://github.com/owner/repo/pull/11",
                "merged_at": "2026-09-30T00:00:00Z",
                "merge": merge_hash,
                "base": "main",
                "head": "completed",
                "head_sha": completed_hash,
                "head_repo": "fork/repo",
                "base_repo": "owner/repo",
            },
            {
                "number": 12,
                "url": "https://github.com/owner/repo/pull/12",
                "merged_at": "2026-09-30T00:00:00Z",
                "merge": merge_hash,
                "base": "main",
                "head": "completed",
                "head_sha": completed_hash,
                "head_repo": "owner/repo",
                "base_repo": "owner/repo",
            },
            {
                "number": 13,
                "url": "https://github.com/owner/repo/pull/13",
                "merged_at": "2026-09-30T00:00:00Z",
                "merge": merge_hash,
                "base": "main",
                "head": "completed",
                "head_sha": completed_hash,
                "head_repo": None,
                "base_repo": "owner/repo",
            },
        ],
    }
    rows = branch_rows.build(str(repo), branches, lanes, github_data, default_branch="main")

    history = [row for row in rows if row["historical"]]
    assert {row["name"] for row in history} == {"completed"}
    owner_history = next(row for row in history if row["pull_requests"][0]["source"].startswith("owner/"))
    fork_history = next(row for row in history if row["pull_requests"][0]["source"].startswith("fork/"))
    unknown_history = next(row for row in history if row["pull_requests"][0]["number"] == 13)
    assert {pull["number"] for pull in owner_history["pull_requests"]} == {10, 12}
    assert completed_hash in owner_history["commit_hashes"]
    assert owner_history["pull_requests"][0]["source"] == "owner/repo:completed"
    assert owner_history["pull_requests"][0]["target"] == "owner/repo:main"
    assert owner_history["pull_requests"][0]["commit_hash"] == merge_hash
    assert fork_history["pull_requests"][0]["source"] == "fork/repo:completed"
    assert unknown_history["pull_requests"][0]["source"] == "元リポジトリ不明:completed"
    assert unknown_history["pull_requests"][0]["source_repository_available"] is False


def test_branch_row_metadata_keeps_an_older_tip_outside_global_graph_window(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    init_repo(repo)
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")

    git(repo, "switch", "-q", "-c", "older")
    older_hash = commit(repo, "older branch tip")
    git(repo, "push", "-q", "-u", "origin", "older")
    git(repo, "switch", "-q", "main")
    for index in range(205):
        commit(repo, f"main {index}")
    git(repo, "push", "-q", "origin", "main")

    branches = detail.get_branches(str(repo))
    assert branches is not None
    lanes = [lane(repo, item) for item in branches["local"]]
    rows = branch_rows.build(str(repo), branches, lanes, default_branch="main")
    older = next(row for row in rows if row["name"] == "older")

    assert older_hash in older["commit_hashes"]
    assert any(item["hash"] == older_hash and item["subject"] == "older branch tip" for item in older["commits"])
    assert older["commit_metadata_available"] is True
    main = next(row for row in rows if row["name"] == "main")
    assert len(main["commits"]) == 200
    assert main["history_cursor"] == 200
    assert main["history_truncated"] is True


def test_reused_branch_name_does_not_absorb_an_old_pr_head(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    init_repo(repo)
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature")
    old_head = commit(repo, "old PR head")
    git(repo, "push", "-q", "-u", "origin", "feature")
    git(repo, "switch", "-q", "main")
    git(repo, "remote", "set-url", "origin", "git@github.com:owner/repo.git")

    github_data = {
        "status": "available",
        "repository": "owner/repo",
        "pulls": [
            {
                "number": 21,
                "url": "https://github.com/owner/repo/pull/21",
                "merged_at": "2026-09-30T00:00:00Z",
                "merge": old_head,
                "base": "main",
                "head": "feature",
                "head_sha": old_head,
                "head_repo": "owner/repo",
                "base_repo": "owner/repo",
            }
        ],
    }

    branches = detail.get_branches(str(repo))
    assert branches is not None
    first = branch_rows.build(str(repo), branches, [lane(repo, item) for item in branches["local"]], github_data, "main")
    current = next(row for row in first if row["name"] == "feature")
    assert [pull["number"] for pull in current["pull_requests"]] == [21]

    git(repo, "switch", "-q", "feature")
    git(repo, "reset", "-q", "--hard", "main")
    new_head = commit(repo, "reused feature name")
    git(repo, "remote", "set-url", "origin", str(origin))
    git(repo, "push", "-q", "--force", "origin", "feature")
    git(repo, "switch", "-q", "main")
    # The remote has the GitHub identity only after the force-push fixture is
    # complete; the bare push URL above remains usable during construction.
    git(repo, "remote", "set-url", "origin", "git@github.com:owner/repo.git")
    branches = detail.get_branches(str(repo))
    assert branches is not None
    second = branch_rows.build(str(repo), branches, [lane(repo, item) for item in branches["local"]], github_data, "main")
    current = next(row for row in second if row["name"] == "feature")
    assert current["remote_hash"] == new_head
    assert current["pull_requests"] == []
    history = next(row for row in second if row["historical"] and row["pull_requests"][0]["number"] == 21)
    assert history["pull_requests"][0]["source"] == "owner/repo:feature"


def test_tip_metadata_keeps_all_remote_and_local_heads_when_page_is_truncated(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    origin = tmp_path / "origin.git"
    init_repo(repo)
    origin.mkdir()
    git(origin, "init", "--bare", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")

    git(repo, "switch", "-q", "-c", "feature")
    old_head = commit(repo, "old local head")
    git(repo, "push", "-q", "-u", "origin", "feature")
    git(repo, "branch", "--track", "feature-copy", "origin/feature")
    git(repo, "switch", "-q", "feature-copy")
    copy_head = commit(repo, "second local head")
    git(repo, "switch", "-q", "main")

    git(repo, "switch", "-q", "-c", "remote-advance", "feature-copy")
    for index in range(205):
        commit(repo, f"remote advance {index}")
    git(repo, "push", "-q", "origin", "remote-advance:feature")
    new_remote_head = git(repo, "rev-parse", "origin/feature").strip()
    git(repo, "switch", "-q", "main")
    git(repo, "branch", "-D", "remote-advance")

    branches = detail.get_branches(str(repo))
    assert branches is not None
    rows = branch_rows.build(str(repo), branches, [lane(repo, item) for item in branches["local"]], default_branch="main")
    feature = next(row for row in rows if row["remote_ref"] == "origin/feature")

    assert {item["branch"] for item in feature["locals"]} == {"feature", "feature-copy"}
    assert feature["history_cursor"] == 200
    assert old_head not in feature["commit_hashes"]
    assert {item["hash"] for item in feature["tip_commits"]} == {new_remote_head, old_head, copy_head}
    assert feature["tip_metadata_available"] is True
