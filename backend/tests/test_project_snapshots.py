import threading

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
    main._refresh_project_snapshot(state[str(linked)])
    assert calls[0][0] == str(repo)
    assert calls[0][1] == str(repo)
