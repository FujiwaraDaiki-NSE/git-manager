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


def test_destination_batch_reads_config_once_and_does_not_cache_across_requests(tmp_path, monkeypatch):
    repo = tmp_path / 'repo'
    init_repo(repo)
    git(repo, 'branch', 'topic')
    git(repo, 'remote', 'add', 'origin', 'https://example.test/read')
    calls = []
    original_run = subprocess.run

    def record(command, **kwargs):
        if command[3] == 'config':
            calls.append(command[3:])
        return original_run(command, **kwargs)

    monkeypatch.setattr(gitinfo.subprocess, 'run', record)
    facts = gitinfo.branch_destinations_many(str(repo), ['main', 'topic'])
    assert set(facts) == {'main', 'topic'}
    assert calls == [['config', '-z', '--list']]
    assert facts['main']['push_default'] == 'simple'
    git(repo, 'config', 'push.default', 'current')
    calls.clear()
    assert gitinfo.branch_destinations_many(str(repo), ['main', 'topic'])['main']['push_default'] == 'current'
    assert calls == [['config', '-z', '--list']]


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
