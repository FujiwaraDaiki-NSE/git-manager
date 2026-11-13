from collections import Counter
import subprocess

from app import project
from test_project import init_repo, commit, git
from test_project_snapshots import without_times


def test_batched_output_matches_individual_git_queries_and_shares_reflogs(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-qc", "feature")
    commit(repo, "feature")
    git(repo, "switch", "-q", "main")
    commit(repo, "main")
    git(repo, "merge", "--no-ff", "-qm", "merge feature", "feature")
    git(repo, "update-ref", "refs/remotes/origin/main", "main")
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    detached = tmp_path / "detached"
    git(repo, "worktree", "add", "-q", "--detach", str(detached), "feature")
    state = {str(repo): {"path": str(repo), "entries": [], "is_worktree": False}}
    original = subprocess.run
    calls = []
    def run(args, **kwargs):
        if args[0].endswith("git"):
            calls.append(args[3:])
        return original(args, **kwargs)
    monkeypatch.setattr(subprocess, "run", run)
    expected = project.build.__wrapped__(str(repo), str(repo), state)
    individual_count = len(calls)
    calls.clear()
    actual = project.build(str(repo), str(repo), state)
    assert without_times(actual) == without_times(expected)
    assert len(calls) < individual_count
    reflogs = Counter(tuple(args) for args in calls if args[:2] == ["reflog", "show"] and args[-1].startswith("refs/heads/"))
    assert reflogs and max(reflogs.values()) == 1
    assert not any(args[:2] == ["rev-list", "--left-right"] for args in calls)


def test_shallow_counts_and_bases_match_git(tmp_path):
    source = tmp_path / "source"
    init_repo(source)
    for _ in range(3):
        commit(source, "next")
    repo = tmp_path / "shallow"
    subprocess.run(["git", "clone", "-q", "--depth=2", source.as_uri(), str(repo)], check=True)
    actual = project.build(str(repo), str(repo))
    expected = project.build.__wrapped__(str(repo), str(repo))
    assert without_times(actual) == without_times(expected)


def test_unpushed_hashes_match_git_and_ahead_with_unknown_distinct_from_empty(tmp_path):
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "remote", "add", "origin", str(tmp_path / "origin.git"))
    git(repo, "update-ref", "refs/remotes/origin/main", "main")
    git(repo, "branch", "--set-upstream-to=origin/main", "main")
    git(repo, "branch", "synced")
    git(repo, "branch", "--set-upstream-to=origin/main", "synced")
    git(repo, "branch", "local-only")
    commit(repo, "first unpushed")
    git(repo, "switch", "-qc", "side")
    commit(repo, "side unpushed")
    git(repo, "switch", "-q", "main")
    commit(repo, "second unpushed")
    git(repo, "merge", "--no-ff", "-qm", "unpushed merge", "side")
    git(repo, "branch", "missing")
    git(repo, "config", "branch.missing.remote", "origin")
    git(repo, "config", "branch.missing.merge", "refs/heads/deleted")
    result = project.build(str(repo), str(repo))
    lanes = {lane["branch"]: lane for lane in result["lanes"]}
    expected = set(git(repo, "rev-list", "origin/main..main").splitlines())
    assert set(lanes["main"]["unpushed_commits"]) == expected
    assert len(expected) == lanes["main"]["upstream_ahead"] == 4
    assert lanes["synced"]["unpushed_commits"] == []
    assert lanes["local-only"]["unpushed_commits"] is None
    assert lanes["missing"]["unpushed_commits"] is None
    row_lane = next(lane for row in result["branch_rows"] for lane in row["locals"] if lane["branch"] == "main")
    assert set(row_lane["unpushed_commits"]) == expected
