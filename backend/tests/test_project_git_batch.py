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


def test_empty_repository_is_a_valid_snapshot(tmp_path, monkeypatch):
    from app import config, project_git_batch
    from test_project_snapshots import read
    repo = tmp_path / "empty"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    assert project_git_batch._read(str(repo)) == {"refs": {}, "commits": []}
    for period in ("current", "all"):
        assert read(repo, {}, period)["graph"]["rows"] == []


def test_batch_history_is_bounded_and_incomplete_ancestry_is_not_counted(tmp_path, monkeypatch):
    from app import branch_history, gitinfo, project_git_batch
    repo = tmp_path / "repo"
    init_repo(repo)
    parent = git(repo, "rev-parse", "HEAD").strip()
    for index in range(branch_history.PAGE_SIZE + 2):
        parent = git(repo, "commit-tree", "HEAD^{tree}", "-p", parent, "-m", str(index)).strip()
    git(repo, "update-ref", "refs/heads/main", parent)
    original = gitinfo._run
    calls = []
    def run(repo, args, **kwargs):
        calls.append(args)
        return original(repo, args, **kwargs)
    monkeypatch.setattr(gitinfo, "_run", run)
    data = project_git_batch._read(str(repo))
    assert len(data["commits"]) == branch_history.PAGE_SIZE + 1
    assert all("--max-count=201" in args and "--all" not in args for args in calls if args[0] == "log")
    batch = project_git_batch.Batch(str(repo), data)
    assert batch.ancestors(parent) is None
    assert batch.counts("refs/heads/main", "refs/heads/main") == (0, 0)
    assert without_times(project.build(str(repo), str(repo))) == without_times(project.build.__wrapped__(str(repo), str(repo)))


def test_batch_failure_remains_explicit_and_does_not_raise(tmp_path, monkeypatch):
    from app import config, gitinfo, project_git_batch
    from test_project_snapshots import read
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    original = gitinfo._run
    def run(repo, args, **kwargs):
        if args[0] == "log" and any(arg.startswith("--max-count=") for arg in args) and "--decorate=full" not in args:
            return None
        return original(repo, args, **kwargs)
    monkeypatch.setattr(gitinfo, "_run", run)
    assert project_git_batch._read(str(repo))["commits"] is None
    actual = read(repo, {})
    assert actual["snapshot"]["status"] == "ready"
    assert any(not row["history_available"] for row in actual["branch_rows"])


def test_history_subject_control_character_does_not_split_commit():
    from app import branch_history
    raw = "hash\x1fshort\x1fadd \ffooter\x1fauthor\x1fdate\x1fparent\n"
    assert branch_history._parse(raw)[0]["subject"] == "add \ffooter"
