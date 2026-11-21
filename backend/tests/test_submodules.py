from app import detail
from test_project import commit, git, init_repo


def test_parse_submodule_states_and_recorded_commit():
    recorded = "a" * 40
    checkout = "b" * 40
    for marker, state in [("-", "uninitialized"), ("+", "different"), (" ", "same"), ("U", "conflict")]:
        index = f"160000 {recorded} {1 if marker == 'U' else 0}\tlibs/a module\0"
        status_sha = recorded if marker in (" ", "-") else checkout
        assert detail.parse_submodule_status(f"{marker}{status_sha} libs/a module (heads/main)\n", index) == [
            {"path": "libs/a module", "recorded_commit": None if marker == "U" else recorded,
             "checkout_commit": status_sha if marker in (" ", "+") else None, "status": state}
        ]
    assert detail.parse_submodule_status("invalid", "") is None


def test_checkout_and_index_shas_match_git(tmp_path):
    source = tmp_path / "source"
    repo = tmp_path / "repo"
    init_repo(source)
    init_repo(repo)
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", str(source), "libs/module")
    submodule = repo / "libs/module"
    recorded = git(repo, "rev-parse", ":libs/module").strip()
    for status in ("same", "different"):
        checkout = git(submodule, "rev-parse", "HEAD").strip()
        assert detail.get_submodules(str(repo)) == {"submodules": [{
            "path": "libs/module", "recorded_commit": recorded, "checkout_commit": checkout, "status": status,
        }]}
        if status == "same":
            git(submodule, "config", "user.name", "Test")
            git(submodule, "config", "user.email", "test@example.com")
            commit(submodule, "local submodule commit")


def test_without_gitmodules_does_not_run_git(tmp_path, monkeypatch):
    def unexpected(*args):
        raise AssertionError("Git must not run")
    monkeypatch.setattr(detail.gitinfo, "_run", unexpected)
    assert detail.get_submodules(str(tmp_path)) == {"submodules": []}


def test_git_failure_is_not_empty_list(tmp_path, monkeypatch):
    (tmp_path / ".gitmodules").touch()
    monkeypatch.setattr(detail.gitinfo, "_run", lambda *args: None)
    assert detail.get_submodules(str(tmp_path)) is None


def test_detail_endpoint_preserves_empty_failure_and_unknown(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app import main
    path = str(tmp_path)
    monkeypatch.setattr(main, "STATE", {path: {}})
    monkeypatch.setattr(main.paths, "to_container", lambda value: value)
    client = TestClient(main.app)
    assert client.get("/api/repo/submodules", params={"path": path}).json() == {"submodules": []}
    assert client.get("/api/repo/submodules", params={"path": "/unknown"}).status_code == 404
    (tmp_path / ".gitmodules").touch()
    monkeypatch.setattr(detail.gitinfo, "_run", lambda *args: None)
    assert client.get("/api/repo/submodules", params={"path": path}).status_code == 502
