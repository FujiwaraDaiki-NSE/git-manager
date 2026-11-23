import threading
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import config, github, project, project_snapshots
from test_project import init_repo, commit, git


def without_times(value):
    if isinstance(value, dict):
        return {key: without_times(item) for key, item in value.items() if key not in {"observed_at", "snapshot"}}
    if isinstance(value, list):
        return [without_times(item) for item in value]
    return value


@pytest.fixture
def snapshot_repo(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    commit(repo, "second")
    git(repo, "branch", "feature")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    state = {str(repo): {"path": str(repo), "common_dir": str(repo), "is_worktree": False, "entries": []}}
    return repo, state


def read(repo, state, range_name="current", as_of=None):
    return project_snapshots.get(str(repo), str(repo), state, threading.Lock(), range_name, as_of, lambda: github.unavailable("PR情報は未取得です"))


@pytest.mark.parametrize("range_name", ["current", "24h", "7d", "all"])
def test_snapshot_matches_live_and_survives_reload(snapshot_repo, range_name):
    repo, state = snapshot_repo
    expected = project.build(str(repo), str(repo), state, range_name=range_name)
    actual = read(repo, state, range_name)
    assert without_times(actual) == without_times(expected)
    again = read(repo, state, range_name)
    assert without_times(again) == without_times(expected)
    assert again["snapshot"]["observed_at"] == actual["snapshot"]["observed_at"]


def test_dynamic_state_and_readme_are_not_frozen(snapshot_repo):
    repo, state = snapshot_repo
    before = read(repo, state)
    (repo / "README.md").write_text("Changed description\n")
    state[str(repo)]["entries"] = [{"xy": ".M", "path": "README.md"}]
    after = read(repo, state)
    assert after["description"] == "Changed description"
    assert next(lane for lane in after["lanes"] if lane["branch"] == "main")["dirty"] is True
    assert after["snapshot"] == before["snapshot"]


def test_failed_build_is_not_persisted(snapshot_repo, monkeypatch):
    repo, state = snapshot_repo
    original = project.build
    def incomplete(*args, **kwargs):
        result = original(*args, **kwargs)
        result["graph"] = None
        return result
    monkeypatch.setattr(project, "build", incomplete)
    with pytest.raises(RuntimeError):
        read(repo, state)
    assert project_snapshots.load(str(repo)) is None


@pytest.mark.parametrize("ancestry_status,reflog_status", [("partial", "available"), ("available", "partial"), ("partial", "partial")])
def test_partial_connections_are_persisted_and_returned(snapshot_repo, monkeypatch, ancestry_status, reflog_status):
    repo, state = snapshot_repo
    original = project.build
    def partial(*args, **kwargs):
        result = original(*args, **kwargs)
        result["branch_connections"]["ancestry_status"] = ancestry_status
        result["branch_connections"]["reflog_status"] = reflog_status
        return result
    monkeypatch.setattr(project, "build", partial)
    actual = read(repo, state)
    assert project_snapshots.load(str(repo)) is not None
    again = read(repo, state)
    for result in (actual, again):
        assert result["snapshot"]["status"] == "ready"
        assert result["branch_connections"]["ancestry_status"] == ancestry_status
        assert result["branch_connections"]["reflog_status"] == reflog_status
    assert again["snapshot"] == actual["snapshot"]


@pytest.mark.parametrize("status_key", ["ancestry_status", "reflog_status"])
def test_unavailable_connections_are_persisted_explicitly(snapshot_repo, monkeypatch, status_key):
    repo, state = snapshot_repo
    original = project.build
    def unavailable(*args, **kwargs):
        result = original(*args, **kwargs)
        result["branch_connections"][status_key] = "unavailable"
        return result
    monkeypatch.setattr(project, "build", unavailable)
    actual = read(repo, state)
    assert actual["branch_connections"][status_key] == "unavailable"
    assert project_snapshots.load(str(repo)) is not None


def test_stale_is_returned_without_waiting_and_failure_is_explicit(snapshot_repo, monkeypatch):
    repo, state = snapshot_repo
    before = read(repo, state)
    commit(repo, "new")
    queued = []
    monkeypatch.setattr(project_snapshots._executor, "submit", lambda *args: queued.append(args))
    stale = read(repo, state)
    assert stale["snapshot"]["status"] == "refreshing"
    assert stale["snapshot"]["observed_at"] == before["snapshot"]["observed_at"]
    assert len(queued) == 1
    monkeypatch.setattr(project_snapshots, "_build", lambda *args: (_ for _ in ()).throw(RuntimeError("test failure")))
    function, *args = queued[0]
    function(*args)
    failed = read(repo, state)
    assert failed["snapshot"]["status"] == "failed"
    assert failed["snapshot"]["error"] == "test failure"
    project_snapshots.retry_failed([str(repo)])
    assert read(repo, state)["snapshot"]["status"] == "refreshing"
    function, *args = queued[-1]
    function(*args)


def test_agents_github_as_of_and_time_are_composed_per_read(snapshot_repo, monkeypatch):
    from datetime import datetime, timezone
    from app import agent_events
    repo, state = snapshot_repo
    before = read(repo, state)
    at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    seen = []
    snapshot = {"task_id": "task", "branch": "main", "worktree": str(repo), "status": "implementing"}
    event = {"kind": "status", "status": "implementing", "occurred_at": at.isoformat(), "sequence": 1}
    def snapshots(**kwargs):
        seen.append(kwargs["as_of"])
        return {"task": snapshot}
    monkeypatch.setattr(agent_events, "snapshots", snapshots)
    monkeypatch.setattr(agent_events, "project_events", lambda *args, **kwargs: [event.copy()])
    changed_github = {**github.unavailable("test"), "checked_at": 1234}
    actual = project_snapshots.get(str(repo), str(repo), state, threading.Lock(), "24h", at, lambda: changed_github)
    expected = project.build(str(repo), str(repo), state, range_name="24h", as_of=at, github_data=changed_github)
    assert without_times(actual) == without_times(expected)
    assert actual["agent_snapshots"] == [snapshot]
    assert actual["agent_events"] == [event]
    assert actual["github"]["checked_at"] == 1234
    assert seen == [at, at]
    assert actual["observed_at"] > before["observed_at"]
    assert actual["snapshot"]["observed_at"] == before["snapshot"]["observed_at"]


def test_refresh_publishes_completion_and_reuses_unchanged_snapshot(snapshot_repo, monkeypatch):
    repo, state = snapshot_repo
    before = read(repo, state)
    queued = []
    events = []
    monkeypatch.setattr(project_snapshots._executor, "submit", lambda *args: queued.append(args))
    monkeypatch.setattr(project_snapshots.bus, "publish_threadsafe", lambda *args: events.append(args))
    project_snapshots.refresh_existing(str(repo), str(repo), state, threading.Lock())
    assert queued == []
    commit(repo, "new")
    assert read(repo, state)["snapshot"]["status"] == "refreshing"
    function, *args = queued.pop()
    function(*args)
    after = read(repo, state)
    assert after["snapshot"]["status"] == "ready"
    assert after["snapshot"]["observed_at"] > before["snapshot"]["observed_at"]
    assert after["latest_event"]["subject"] == "new"
    assert events[-1] == ("project", {"id": str(repo)})
    assert queued == []


def test_linked_refresh_uses_the_same_representative_as_project_api(snapshot_repo, monkeypatch):
    from app import main
    repo, state = snapshot_repo
    linked = repo.parent / "linked"
    git(repo, "worktree", "add", "-q", str(linked), "feature")
    state[str(linked)] = {"path": str(linked), "common_dir": str(repo), "is_worktree": True}
    monkeypatch.setattr(main, "STATE", state)
    calls = []
    monkeypatch.setattr(project_snapshots, "refresh_existing", lambda *args: calls.append(args))
    main._refresh_project_snapshot(str(repo), str(linked))
    assert calls[0][0] == str(repo)
    assert calls[0][1] == str(repo)


@pytest.fixture
def queued_snapshot_checks(monkeypatch):
    from app import main

    queued = []
    monkeypatch.setattr(main, "STATE", {})
    monkeypatch.setattr(main, "_pending_snapshot_checks", set())
    monkeypatch.setattr(main.refresh_pool, "submit", lambda *args: queued.append(args))
    monkeypatch.setattr(main.bus, "publish_threadsafe", lambda *args: None)
    return queued


def test_pending_snapshot_checks_are_coalesced(queued_snapshot_checks, monkeypatch):
    from app import main

    calls = []
    monkeypatch.setattr(project_snapshots, "refresh_existing", lambda *args: calls.append(args))
    main._upsert({"path": "/repo", "common_dir": "/repo", "is_worktree": False})
    main._upsert_threadsafe({"path": "/linked", "common_dir": "/repo", "is_worktree": True})

    assert calls == []
    assert len(queued_snapshot_checks) == 1
    function, *args = queued_snapshot_checks.pop()
    function(*args)
    assert len(calls) == 1
    assert set(calls[0][2]) == {"/repo", "/linked"}


def test_snapshot_check_can_be_queued_again_after_it_starts(queued_snapshot_checks, monkeypatch):
    from app import main

    row = {"path": "/repo", "common_dir": "/repo", "is_worktree": False, "branch": "main"}
    checked_branches = []

    def refresh_existing(repo, project_id, state_rows, repo_lock):
        checked_branches.append(state_rows["/repo"]["branch"])
        if len(checked_branches) == 1:
            main._upsert_threadsafe({**row, "branch": "updated"})

    monkeypatch.setattr(project_snapshots, "refresh_existing", refresh_existing)
    main._upsert(row)
    function, *args = queued_snapshot_checks.pop()
    function(*args)

    assert len(queued_snapshot_checks) == 1
    function, *args = queued_snapshot_checks.pop()
    function(*args)
    assert checked_branches == ["main", "updated"]


def test_all_is_computed_lazily_and_missing_stats_are_saved(snapshot_repo, monkeypatch):
    from app import graph
    repo, state = snapshot_repo
    original = graph.build
    limits = []
    def build(*args, **kwargs):
        limits.append(kwargs["limit"])
        return original(*args, **kwargs)
    monkeypatch.setattr(graph, "build", build)
    monkeypatch.setattr(project, "_commit_stats_many", lambda repo, hashes: {value: None for value in hashes})
    for period in ("current", "24h", "7d"):
        read(repo, state, period)
    assert limits == [200]
    actual = read(repo, state, "all")
    assert limits == [200, None]
    assert actual["graph"]["rows"]
    assert all(row["stats"] is None for row in actual["graph"]["rows"])
    saved = project_snapshots.load(str(repo))
    again = read(repo, state, "all")
    assert limits == [200, None]
    assert without_times(again) == without_times(actual)
    assert project_snapshots.load(str(repo)) == saved


def test_cached_facts_reload_after_an_observation_changes_on_another_thread(snapshot_repo):
    repo, state = snapshot_repo
    project_id = str(repo)
    read(repo, state)
    before = project_snapshots.load(project_id)
    assert project_snapshots.load(project_id)["facts"] is before["facts"]

    # Extending the graph changes the observation without changing Git refs.
    with ThreadPoolExecutor(max_workers=1) as executor:
        executor.submit(read, repo, state, "all").result()

    after = project_snapshots.load(project_id)
    assert after["fingerprint"] == before["fingerprint"]
    assert after["observed_at"] > before["observed_at"]
    assert after["facts"] is not before["facts"]
    assert json.dumps(["project.graph.v2", [project_id, None]], ensure_ascii=False) in after["facts"]
    assert project_snapshots.load(project_id)["facts"] is after["facts"]


def test_additional_git_results_are_shared_only_within_one_observation(snapshot_repo, monkeypatch):
    from app import gitinfo, project_facts

    repo, state = snapshot_repo
    project_id = str(repo)
    read(repo, state)
    heads = [git(repo, "rev-parse", ref).strip() for ref in ("HEAD~1", "HEAD")]
    missing = "f" * 40
    calls = []
    original_run = gitinfo.subprocess.run

    def run(args, **kwargs):
        if args[3:6] == ["log", "--date-order", "-1"]:
            calls.append(args[-1])
        return original_run(args, **kwargs)

    barrier = threading.Barrier(2)

    def build(repo, *args, github_data, **kwargs):
        pulls = project_facts.observe("test.prs", [], lambda: github_data["pulls"])
        commits = [
            gitinfo._run(repo, ["log", "--date-order", "-1", "--format=%H", head])
            for head in [*pulls, missing]
        ]
        if github_data["concurrent"]:
            barrier.wait(timeout=5)
        return {"pulls": pulls, "commits": commits}

    def request(pulls, concurrent):
        return project_snapshots.get(
            project_id, project_id, state, threading.Lock(), "current", None,
            lambda: {"pulls": pulls, "concurrent": concurrent},
        )

    monkeypatch.setattr(gitinfo.subprocess, "run", run)
    monkeypatch.setattr(project, "build", build)
    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = [executor.submit(request, [head], True) for head in heads]
        assert [future.result()["pulls"] for future in pending] == [[head] for head in heads]

    calls.clear()
    result = request(heads, False)
    assert result["pulls"] == heads
    assert result["commits"] == [head + "\n" for head in heads] + [None]
    assert calls == [missing]

    with project_snapshots._connection() as connection:
        connection.execute("UPDATE project_snapshots SET observed_at = observed_at + 1 WHERE project_id = ?", (project_id,))
    calls.clear()
    assert request(heads, False)["commits"] == result["commits"]
    assert calls == [*heads, missing]


@pytest.mark.parametrize("range_name", ["current", "24h", "7d", "all"])
def test_composition_does_not_mutate_recorded_history(snapshot_repo, range_name):
    from app import project_facts

    repo, state = snapshot_repo
    read(repo, state, range_name)
    facts = project_snapshots.load(str(repo))["facts"]
    before = json.dumps(facts, sort_keys=True)
    with project_facts.using(facts):
        project.build(str(repo), str(repo), state, range_name=range_name)
        project.build(str(repo), str(repo), state, range_name="current")
    assert json.dumps(facts, sort_keys=True) == before


def test_parsed_facts_keep_only_recently_read_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(project_snapshots.config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(project_snapshots, "_parsed_facts", {})
    count = project_snapshots._PARSED_FACTS_LIMIT + 1
    for index in range(count):
        with project_snapshots._connection() as connection:
            connection.execute("INSERT INTO project_snapshots VALUES (?, 'fp', 1.0, ?, NULL, NULL)", (f"p{index}", json.dumps({"value": index})))
        assert project_snapshots.load(f"p{index}")["facts"] == {"value": index}
    kept = [project_id for _, project_id in project_snapshots._parsed_facts]
    assert kept == [f"p{index}" for index in range(1, count)]
    assert project_snapshots.load("p0")["facts"] == {"value": 0}
