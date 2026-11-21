import subprocess
from pathlib import Path

import pytest

from app import config, gitinfo, main, project, store
from test_project import git, init_repo


def test_fetch_success_failure_timeout(monkeypatch):
    monkeypatch.setattr(gitinfo.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0, b'', b''))
    assert gitinfo.do_fetch('/repo')['result'] == 'success'
    for stderr, category in [(b'Permission denied (publickey).', 'authentication'), (b'Could not resolve host: example.test', 'connection'), (b'Connection timed out', 'timeout'), (b'fatal: bad ref', 'other')]:
        monkeypatch.setattr(gitinfo.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 128, b'', stderr))
        status = gitinfo.do_fetch('/repo')
        assert status['result'] == 'failure'
        assert status['category'] == category
        assert status['reason'] == stderr.decode()
    def timeout(*a, **k):
        raise subprocess.TimeoutExpired('git', 1, stderr=b'partial stderr')
    monkeypatch.setattr(gitinfo.subprocess, 'run', timeout)
    assert gitinfo.do_fetch('/repo')['category'] == 'timeout'


def test_fetch_shared_persisted_and_retains_success(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'STATE', {'/repo': {'path': '/repo', 'common_dir': '/repo', 'fetched_at': 10}, '/linked': {'path': '/linked', 'common_dir': '/repo'}})
    failure = {'attempted_at': 20, 'result': 'failure', 'category': 'authentication', 'reason': 'denied'}
    merged, siblings = main._store_repo({'path': '/linked', 'common_dir': '/repo', 'fetch_status': failure, 'fetched_at': None})
    assert merged['fetched_at'] == 10
    assert siblings[0]['fetch_status'] == failure
    refreshed, _ = main._store_repo({'path': '/repo', 'common_dir': '/repo', 'fetch_status': None, 'fetched_at': None})
    assert refreshed['fetch_status'] == failure
    assert refreshed['fetched_at'] == 10
    monkeypatch.setattr(store, 'REPOS_FILE', tmp_path / 'repos.json')
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store.save(main.STATE)
    assert store.load()['/linked']['fetch_status'] == failure
    rows = project.summary_rows(main.STATE)
    assert rows[0]['fetch_status'] == failure
    assert rows[0]['fetched_at'] == 10


@pytest.mark.parametrize('marker,kind', [('MERGE_HEAD','merge'), ('rebase-merge','rebase'), ('rebase-apply','rebase'), ('CHERRY_PICK_HEAD','cherry-pick'), ('REVERT_HEAD','revert'), ('BISECT_LOG','bisect')])
def test_worktree_operation_markers(tmp_path: Path, marker, kind):
    repo, linked = tmp_path / 'repo', tmp_path / 'linked'
    init_repo(repo)
    git(repo, 'worktree', 'add', '-qb', 'topic', str(linked))
    directory = Path(git(linked, 'rev-parse', '--absolute-git-dir').strip())
    if kind == 'rebase':
        (directory / marker).mkdir()
        step, total = ('msgnum', 'end') if marker == 'rebase-merge' else ('next', 'last')
        (directory / marker / step).write_text('3')
        (directory / marker / total).write_text('7')
    else:
        (directory / marker).write_text('marker')
    assert gitinfo.operations(str(repo)) == []
    operation = gitinfo.operations(str(linked))[0]
    assert operation['kind'] == kind
    commands = [c['command'] for c in operation['commands']]
    assert 'git status' in commands
    assert f'git {kind} --abort' in commands if kind != 'bisect' else 'git bisect reset' in commands
    if kind == 'rebase':
        assert (operation['step'], operation['total']) == (3, 7)


def test_unavailable_git_facts(tmp_path):
    assert gitinfo.operations(str(tmp_path)) is None
    assert gitinfo.branch_destinations(str(tmp_path), 'main') is None


@pytest.mark.parametrize("action,kind,marker", [
    ("pick", "cherry-pick", "CHERRY_PICK_HEAD"),
    ("revert", "revert", "REVERT_HEAD"),
])
def test_sequencer_operation_belongs_to_linked_worktree(tmp_path, action, kind, marker):
    repo, linked = tmp_path / "repo", tmp_path / "linked"
    init_repo(repo)
    git(repo, "worktree", "add", "-qb", "topic", str(linked))
    directory = Path(git(linked, "rev-parse", "--absolute-git-dir").strip())
    todo = directory / "sequencer" / "todo"
    todo.parent.mkdir()
    todo.write_text(f"{action} {git(linked, 'rev-parse', '--short', 'HEAD').strip()} base\n")

    assert gitinfo.operations(str(repo)) == []
    assert [(op["kind"], op["marker"]) for op in gitinfo.operations(str(linked))] == [(kind, "sequencer/todo")]
    (directory / marker).touch()
    assert [(op["kind"], op["marker"]) for op in gitinfo.operations(str(linked))] == [(kind, marker)]
    (directory / marker).unlink()
    todo.unlink()
    assert gitinfo.operations(str(linked)) == []


def test_destinations_observe_tracking_head_and_distinguish_missing_ref_from_unset(tmp_path):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'remote', 'add', 'origin', 'https://example.test/repo.git')
    unset = gitinfo.branch_destinations(str(repo), 'main')
    assert unset['upstream_state'] == 'unset'
    assert unset['upstream'] is None
    assert unset['upstream_head'] is None
    assert unset['upstream_gone'] is False

    tracking_ref = 'refs/remotes/origin/different'
    git(repo, 'config', 'branch.main.remote', 'origin')
    git(repo, 'config', 'branch.main.merge', 'refs/heads/different')
    git(repo, 'commit', '--allow-empty', '-qm', 'second')
    git(repo, 'update-ref', tracking_ref, 'HEAD^')
    available = gitinfo.branch_destinations(str(repo), 'main')
    assert available['upstream'] == tracking_ref
    assert available['upstream_head'] == git(repo, 'rev-parse', 'HEAD^').strip()
    assert available['upstream_gone'] is False

    git(repo, 'update-ref', tracking_ref, 'HEAD')
    advanced = gitinfo.branch_destinations(str(repo), 'main')
    assert advanced['upstream'] == tracking_ref
    assert advanced['upstream_head'] == git(repo, 'rev-parse', 'HEAD').strip()

    git(repo, 'update-ref', '-d', tracking_ref)
    gone = gitinfo.branch_destinations(str(repo), 'main')
    assert gone['upstream_state'] == 'configured'
    assert gone['upstream'] == tracking_ref
    assert gone['upstream_head'] is None
    assert gone['upstream_gone'] is True


def test_destinations_precedence_urls_and_push_modes(tmp_path):
    repo = tmp_path / 'repo'
    init_repo(repo)
    for name in ('origin', 'publish', 'personal'):
        git(repo, 'remote', 'add', name, f'https://example.test/{name}.git')
    git(repo, 'config', 'branch.main.remote', 'origin')
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    facts = gitinfo.branch_destinations(str(repo), 'main')
    assert facts['upstream'] == 'refs/remotes/origin/main'
    assert facts['fetch_urls'] == ['https://example.test/origin.git']
    assert facts['push_remote'] == 'origin'
    assert facts['push_ref'] == 'refs/heads/main'
    git(repo, 'config', 'remote.pushDefault', 'publish')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_remote'] == 'publish'
    git(repo, 'config', 'branch.main.pushRemote', 'personal')
    git(repo, 'config', '--add', 'remote.personal.pushurl', 'ssh://example.test/one')
    git(repo, 'config', '--add', 'remote.personal.pushurl', 'ssh://example.test/two')
    facts = gitinfo.branch_destinations(str(repo), 'main')
    assert facts['push_remote'] == 'personal'
    assert facts['push_urls'] == ['ssh://example.test/one', 'ssh://example.test/two']
    assert facts['push_ref'] == 'refs/heads/main'  # triangular simple
    git(repo, 'config', 'push.default', 'upstream')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_ref'] is None
    git(repo, 'config', 'branch.main.pushRemote', 'origin')
    git(repo, 'config', 'branch.main.merge', 'refs/heads/different')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_ref'] == 'refs/heads/different'
    git(repo, 'config', 'push.default', 'simple')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_ref'] is None
    git(repo, 'config', 'push.default', 'current')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_ref'] == 'refs/heads/main'
    git(repo, 'config', 'push.default', 'nothing')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_ref'] is None
    git(repo, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/review/*')
    assert gitinfo.branch_destinations(str(repo), 'main')['push_ref'] == 'refs/heads/review/main'


def test_destination_batch_reads_config_and_refs_once_and_does_not_cache_across_requests(tmp_path, monkeypatch):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'branch', 'topic')
    git(repo, 'remote', 'add', 'origin', 'https://example.test/read')
    calls = []
    original_run = subprocess.run

    def record(command, **kwargs):
        if command[3] in ('config', 'for-each-ref'):
            calls.append(command[3:])
        return original_run(command, **kwargs)

    monkeypatch.setattr(gitinfo.subprocess, 'run', record)
    facts = gitinfo.branch_destinations_many(str(repo), ['main', 'topic'])
    assert set(facts) == {'main', 'topic'}
    batch_calls = [
        ['config', '-z', '--list'],
        ['for-each-ref', '--format=%(refname)%00%(upstream)%00%(objectname)', 'refs/'],
    ]
    assert calls == batch_calls
    assert facts['main']['push_default'] == 'simple'
    git(repo, 'config', 'push.default', 'current')
    calls.clear()
    assert gitinfo.branch_destinations_many(str(repo), ['main', 'topic'])['main']['push_default'] == 'current'
    assert calls == batch_calls


def test_destination_config_preserves_multivalues_and_subsection_case(tmp_path):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'branch', 'Main')
    config_file = repo / '.git' / 'config'
    with config_file.open('a') as handle:
        handle.write('''
[ReMoTe "Origin"]
    URL = https://example.test/read
    FETCH = +refs/heads/*:refs/remotes/Origin/*
[remote "origin"]
    url = https://example.test/lower
[Branch "Main"]
    Remote = Origin
    MERGE = refs/heads/Main
    PUSHREMOTE = origin
[branch "main"]
    remote = origin
    merge = refs/heads/main
[ReMoTe]
    PUSHDEFAULT = origin
[remote]
    pushDefault = Origin
[Push]
    DEFAULT = nothing
[push]
    default = current
[Remote "Origin"]
    PushURL = ssh://example.test/one
    pushurl = ssh://example.test/two
    PUSH = refs/heads/*:refs/heads/review/*
    push = refs/heads/Main:refs/heads/second
''')
    facts = gitinfo.branch_destinations_many(str(repo), ['main', 'Main'])
    upper, lower = facts['Main'], facts['main']
    assert upper['fetch_remote'] == 'Origin'
    assert lower['fetch_remote'] == 'origin'
    assert upper['push_remote'] == 'origin'  # exact branch subsection's pushRemote
    assert lower['push_remote'] == 'Origin'  # last pushDefault definition
    assert upper['fetch_urls'] == ['https://example.test/read']
    assert lower['fetch_urls'] == ['https://example.test/lower']
    assert lower['push_urls'] == ['ssh://example.test/one', 'ssh://example.test/two']
    assert lower['push_refspecs'] == ['refs/heads/*:refs/heads/review/*', 'refs/heads/Main:refs/heads/second']
    assert upper['push_ref'] == 'refs/heads/Main'
    assert lower['push_ref'] == 'refs/heads/review/main'
    assert lower['push_default'] == 'current'
    settings = gitinfo._branch_config(str(repo))
    assert settings['remote.Origin.pushurl'] == ['ssh://example.test/one', 'ssh://example.test/two']
    assert 'remote.origin.pushurl' not in settings
    assert settings['push.default'] == ['nothing', 'current']


def test_destination_config_preserves_empty_bare_and_multiline_values(tmp_path):
    repo = tmp_path / 'repo'
    init_repo(repo)
    with (repo / '.git' / 'config').open('a') as handle:
        handle.write('\n[push]\n autoSetupRemote\n[branch "main"]\n remote = ""\n[remote "origin"]\n push = "line1\\nline2"\n push = ""\n')
    settings = gitinfo._branch_config(str(repo))
    assert settings['push.autosetupremote'] == [None]
    assert settings['branch.main.remote'] == ['']
    assert settings['remote.origin.push'] == ['line1\nline2', '']


@pytest.mark.parametrize('value', ['true', 'TRUE', 'false', 'yes', 'no', 'on', 'off', '', '0', '1', '-1', '+2', '01', '0x10', '2k', '1M', '1g', 'invalid', '08', '2147483648', ' true ', ' 1', '\t1', '1 '])
def test_batched_boolean_matches_git(tmp_path, value):
    proc = subprocess.run(['git', '-C', str(tmp_path), '-c', f'push.autoSetupRemote={value}', 'config', '--type=bool', '--get', 'push.autoSetupRemote'], capture_output=True, text=True)
    expected = proc.stdout.strip() == 'true' if proc.returncode == 0 else None
    assert gitinfo._config_bool(value) == expected


@pytest.mark.parametrize('error', ['exit', 'timeout', 'os'])
def test_destination_batch_config_failure_is_null_without_key_queries(tmp_path, monkeypatch, error):
    calls = []

    def fail(command, **kwargs):
        calls.append(command[3:])
        if error == 'timeout':
            raise subprocess.TimeoutExpired(command, 1)
        if error == 'os':
            raise OSError('cannot run Git')
        return subprocess.CompletedProcess(command, 128, b'', b'bad config')

    monkeypatch.setattr(gitinfo.subprocess, 'run', fail)
    assert gitinfo.branch_destinations_many(str(tmp_path), ['main', 'topic']) == {'main': None, 'topic': None}
    assert calls == [['config', '-z', '--list']]


def test_destination_batch_shares_config_in_snapshot_observation(tmp_path, monkeypatch):
    from app import project_facts

    repo = tmp_path / 'repo'
    init_repo(repo)
    original_run = subprocess.run
    calls = []

    def record(command, **kwargs):
        if command[3] == 'config':
            calls.append(command[3:])
        return original_run(command, **kwargs)

    monkeypatch.setattr(gitinfo.subprocess, 'run', record)
    with project_facts.using({}):
        first = gitinfo.branch_destinations_many(str(repo), ['main'])
        assert gitinfo.branch_destinations_many(str(repo), ['main']) == first
    assert calls == [['config', '-z', '--list']]
    with project_facts.using({}):
        assert gitinfo.branch_destinations_many(str(repo), ['main']) == first
    assert calls == [['config', '-z', '--list'], ['config', '-z', '--list']]


def test_project_build_uses_one_destination_config_for_all_lanes(tmp_path, monkeypatch):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'branch', 'topic')
    original_run = subprocess.run
    calls = []

    def record(command, **kwargs):
        if command[3:] == ['config', '-z', '--list']:
            calls.append(command)
        return original_run(command, **kwargs)

    monkeypatch.setattr(gitinfo.subprocess, 'run', record)
    result = project.build(str(repo), str(repo))
    assert result is not None
    assert {lane['branch'] for lane in result['lanes']} == {'main', 'topic'}
    assert all(lane['destinations'] is not None for lane in result['lanes'])
    assert len(calls) == 1

@pytest.mark.parametrize("failed,healthy", [(0, 1), (1, 0), (1, 1)])
def test_summary_excludes_failed_git_status(tmp_path, failed, healthy):
    repo = tmp_path / "repo"
    init_repo(repo)
    rows = {}
    for i in range(failed + healthy):
        path = str(repo) if i == 0 else str(tmp_path / f"linked-{i}")
        rows[path] = {
            "path": path, "common_dir": str(repo), "is_worktree": i != 0,
            "error": "git status failed" if i < failed else None,
            "entries": [{"xy": "UU"}], "ahead": 2, "behind": 3,
        }
    summary = project.summary_rows(rows)[0]
    assert summary["git_status_failed"] == failed
    assert summary["git_status_available"] == bool(healthy)
    for key in ("dirty", "conflict", "ahead", "behind"):
        assert summary["git"][key] == healthy
    if not healthy:
        assert summary["next_lane"] is None


def test_origin_status_distinguishes_missing_config_and_failures(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    assert gitinfo.collect(str(repo), fetch=False)["remote_status"] == "unset"
    git(repo, "remote", "add", "other", "/tmp/other")
    assert gitinfo.collect(str(repo), fetch=False)["remote_status"] == "unset"
    git(repo, "remote", "add", "origin", "/tmp/origin")
    result = gitinfo.collect(str(repo), fetch=False)
    assert result["remote_status"] == "configured"
    assert result["remote"] == "/tmp/origin"
    monkeypatch.setattr(gitinfo, "_run_with_status", lambda *args: (None, None))
    assert gitinfo.collect(str(repo), fetch=False)["remote_status"] == "failed"
    original = gitinfo._run
    monkeypatch.setattr(gitinfo, "_run", lambda repo, args, **kwargs: None if "status" in args else original(repo, args, **kwargs))
    result = gitinfo.collect(str(repo), fetch=False)
    assert result["error"]
    assert result["remote_status"] == "failed"


@pytest.mark.parametrize(
    'mode,merge,push_remote,ref,command,reason',
    [
        ('nothing', 'main', None, None, 'git config --show-origin --get push.default', 'push.default=nothing'),
        ('simple', 'different', None, None, 'git push origin HEAD:refs/heads/different', '名前が異なる'),
        ('upstream', 'different', None, 'refs/heads/different', 'git push', None),
        ('simple', 'different', 'publish', 'refs/heads/main', 'git push', None),
        ('upstream', 'main', 'publish', None, "git config --show-origin --get-regexp '^(branch\\.|remote\\.)'", 'remoteが異なる'),
        ('simple', 'main', None, 'refs/heads/main', 'git push', None),
        ('nothing', 'main', 'publish', None, 'git config --show-origin --get push.default', 'push.default=nothing'),
    ],
)
def test_ahead_push_command_agrees_with_destinations(tmp_path, mode, merge, push_remote, ref, command, reason):
    repo = tmp_path / 'repo'
    init_repo(repo)
    for name in ('origin', 'publish'):
        git(repo, 'remote', 'add', name, f'https://example.test/{name}.git')
    git(repo, 'config', 'branch.main.remote', 'origin')
    git(repo, 'config', 'branch.main.merge', f'refs/heads/{merge}')
    git(repo, 'config', 'push.default', mode)
    if push_remote is not None:
        git(repo, 'config', 'branch.main.pushRemote', push_remote)
    git(repo, 'update-ref', f'refs/remotes/origin/{merge}', 'HEAD')
    git(repo, 'commit', '--allow-empty', '-qm', 'ahead')

    facts = gitinfo.branch_destinations(str(repo), 'main')
    result = gitinfo.collect(str(repo))
    assert (result['entries'], result['ahead'], result['behind']) == ([], 1, 0)
    assert facts['push_remote'] == (push_remote if push_remote is not None else 'origin')
    assert facts['push_ref'] == ref
    assert result['next_command']['command'] == command
    assert result['next_command'] == facts['push_next_command']
    if reason is not None:
        assert reason in facts['push_ref_reason']
        assert facts['push_ref_reason'] in result['next_command']['reason']
    else:
        assert facts['push_ref_reason'] is None


def test_remote_push_refspec_overrides_nothing_for_next_command(tmp_path):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'remote', 'add', 'origin', 'https://example.test/origin.git')
    git(repo, 'config', 'branch.main.remote', 'origin')
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(repo, 'config', 'push.default', 'nothing')
    git(repo, 'config', 'remote.origin.push', 'refs/heads/main:refs/heads/review/main')
    git(repo, 'commit', '--allow-empty', '-qm', 'ahead')
    facts = gitinfo.branch_destinations(str(repo), 'main')
    assert facts['push_ref'] == 'refs/heads/review/main'
    assert facts['push_ref_reason'] is None
    assert gitinfo.collect(str(repo))['next_command']['command'] == 'git push'


@pytest.mark.parametrize('state', ['clean', 'conflict', 'unstaged', 'behind', 'diverged'])
def test_collect_does_not_resolve_destinations_before_ahead(tmp_path, monkeypatch, state):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'remote', 'add', 'origin', 'https://example.test/origin.git')
    git(repo, 'config', 'branch.main.remote', 'origin')
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

    if state in ('conflict', 'unstaged', 'behind', 'diverged'):
        git(repo, 'commit', '--allow-empty', '-qm', 'local')
    if state in ('behind', 'diverged'):
        parent = git(repo, 'rev-parse', 'HEAD^').strip() if state == 'diverged' else git(repo, 'rev-parse', 'HEAD').strip()
        remote_tip = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', parent, '-m', 'remote').strip()
        git(repo, 'update-ref', 'refs/remotes/origin/main', remote_tip)
    if state == 'unstaged':
        tracked = repo / 'tracked.txt'
        tracked.write_text('initial')
        git(repo, 'add', 'tracked.txt')
        git(repo, 'commit', '-qm', 'tracked')
        tracked.write_text('changed')
    if state == 'conflict':
        blob = subprocess.run(['git', '-C', str(repo), 'hash-object', '-w', '--stdin'], input='conflict\n', text=True, check=True, capture_output=True).stdout.strip()
        subprocess.run(['git', '-C', str(repo), 'update-index', '--index-info'], input=f'100644 {blob} 1\tconflicted\n100644 {blob} 2\tconflicted\n100644 {blob} 3\tconflicted\n', text=True, check=True, capture_output=True)

    def unexpected_resolution(*args, **kwargs):
        pytest.fail('ahead分岐より前に送信先を解決しました')

    monkeypatch.setattr(gitinfo, 'branch_destinations', unexpected_resolution)
    result = gitinfo.collect(str(repo))
    expected = {'clean': None, 'conflict': 'git status', 'unstaged': 'git add -p', 'behind': 'git pull --ff-only', 'diverged': 'git pull --rebase'}[state]
    assert (result['next_command']['command'] if result['next_command'] else None) == expected
