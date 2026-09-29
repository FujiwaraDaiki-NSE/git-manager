from app import github, project
from test_project import commit, git, init_repo


def snapshot(repo, prs=()):
    data = {"status": "available", "reason": None, "repository": "owner/repo", "checked_at": 1, "pulls": list(prs)}
    return project.build(str(repo), str(repo), range_name="all", github_data=data)


def pull(repo, number, head, merge):
    return {"number": number, "url": f"https://github.com/owner/repo/pull/{number}", "base": "main",
            "head": head, "merge": merge, "head_sha": git(repo, "rev-parse", f"{merge}^2").strip(),
            "base_repo": "owner/repo", "head_repo": "owner/repo", "merged_at": "2026-01-01T00:00:00Z"}


def default(repo):
    git(repo, "update-ref", "refs/remotes/origin/main", "main")
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")


def merges(repo):
    init_repo(repo)
    prs = []
    for n in (1, 2):
        git(repo, "switch", "-qc", f"feature-{n}")
        commit(repo, f"work {n}")
        git(repo, "switch", "-q", "main")
        git(repo, "merge", "--no-ff", "-qm", f"PR {n}", f"feature-{n}")
        prs.append(pull(repo, n, f"feature-{n}", git(repo, "rev-parse", "HEAD").strip()))
    default(repo)
    return prs


def test_reconstructs_pr_merges_after_clone_without_reflog(tmp_path):
    server = tmp_path / "server"
    prs = merges(server)
    repo = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(server), str(repo))
    git(repo, "reflog", "expire", "--expire=now", "--all")
    result = snapshot(repo, prs)
    edges = result["flow"]["connections"]
    for pr in prs:
        edge = next(e for e in edges if e["commit_hash"] == pr["merge"] and e["kind"] == "merge")
        assert (edge["source_branch"], edge["target_branch"]) == (pr["head"], "main")
        assert edge["pr_number"] == pr["number"]
        assert any(e["kind"] == "branch" and e["target_lane_id"] == edge["source_lane_id"] for e in edges)
    rows = result["graph"]["rows"]
    hashes = {r["hash"] for r in rows}
    expected = {(r["hash"], p) for r in rows for p in r["parents"] if p in hashes}
    assert {(e["commit_hash"], e["source_parent"]) for e in edges} == expected
    assert len(edges) == len(expected)


def test_deleted_branch_and_unavailable_pr_keep_edges(tmp_path):
    repo = tmp_path / "repo"
    prs = merges(repo)
    for pr in prs:
        git(repo, "branch", "-D", pr["head"])
    git(repo, "reflog", "expire", "--expire=now", "--all")
    result = project.build(str(repo), str(repo), range_name="all", github_data=github.unavailable("offline"))
    edges = result["flow"]["connections"]
    assert sum(e["kind"] == "merge" for e in edges) == 2
    assert all(e["source_lane_id"] and e["target_lane_id"] for e in edges)
    assert any(l["historical"] and l["branch"] is None for l in result["flow"]["lanes"])
    assert result["github"]["status"] == "unavailable"


def test_sync_and_final_pr_point_in_opposite_directions(tmp_path):
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-qc", "feature")
    commit(repo, "feature one")
    first = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "switch", "-q", "main")
    commit(repo, "main update")
    git(repo, "switch", "-q", "feature")
    git(repo, "merge", "--no-ff", "-qm", "sync main", "main")
    sync = git(repo, "rev-parse", "HEAD").strip()
    commit(repo, "feature two")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "--no-ff", "-qm", "PR", "feature")
    merged = git(repo, "rev-parse", "HEAD").strip()
    pr = pull(repo, 1, "feature", merged)
    default(repo)
    git(repo, "reflog", "expire", "--expire=now", "--all")
    result = snapshot(repo, [pr])
    edges = result["flow"]["connections"]
    incoming = next(e for e in edges if e["commit_hash"] == sync and e["kind"] == "merge")
    outgoing = next(e for e in edges if e["commit_hash"] == merged and e["kind"] == "merge")
    assert (incoming["source_branch"], incoming["target_branch"]) == ("main", "feature")
    assert (outgoing["source_branch"], outgoing["target_branch"]) == ("feature", "main")
    assert first in next(l["flow_hashes"] for l in result["flow"]["lanes"] if l["branch"] == "feature")


def test_alias_does_not_invent_fork(tmp_path):
    repo = tmp_path / "repo"
    merges(repo)
    git(repo, "branch", "empty-feature", "main")
    result = snapshot(repo)
    lane = next(l for l in result["flow"]["lanes"] if l["branch"] == "empty-feature")
    assert lane["flow_hashes"] == []
    assert lane["alias_lane_id"] == "branch:main"
    assert not any(e["target_lane_id"] == lane["id"] for e in result["flow"]["connections"])


def test_fork_pr_does_not_use_same_named_local_ref(tmp_path):
    repo = tmp_path / "repo"
    prs = merges(repo)
    git(repo, "branch", "-f", "feature-1", "main")
    prs[0]["head_repo"] = "contributor/fork"
    result = snapshot(repo, prs)
    edge = next(e for e in result["flow"]["connections"] if e["pr_number"] == 1)
    assert edge["source_lane_id"] == "pr:1:head"
    assert edge["source_branch"] == "contributor/fork:feature-1"


def test_pr_sha_mismatch_does_not_name_merge(tmp_path):
    repo = tmp_path / "repo"
    prs = merges(repo)
    prs[0]["head_sha"] = "0" * 40
    result = snapshot(repo, prs)
    edge = next(e for e in result["flow"]["connections"] if e["kind"] == "merge" and e["commit_hash"] == prs[0]["merge"])
    assert edge["pr_number"] is None


def test_stacked_current_refs_preserve_parent_branch(tmp_path):
    repo = tmp_path / "repo"
    init_repo(repo)
    default(repo)
    git(repo, "switch", "-qc", "feature-a")
    commit(repo, "first feature")
    parent = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "switch", "-qc", "feature-b")
    commit(repo, "stacked feature")
    result = snapshot(repo)
    edge = next(e for e in result["flow"]["connections"] if e["source_parent"] == parent)
    assert (edge["source_branch"], edge["target_branch"], edge["kind"]) == ("feature-a", "feature-b", "branch")
    assert parent in next(l["flow_hashes"] for l in result["flow"]["lanes"] if l["branch"] == "feature-a")
