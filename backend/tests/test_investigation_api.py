"""HTTP acceptance: known repositories, explicit parameters and no mutations."""
import subprocess
import pytest
from fastapi.testclient import TestClient
from app import main

@pytest.fixture
def investigation(tmp_path, monkeypatch):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(tmp_path), *args], text=True).strip()
    git('init', '-b', 'main')
    git('config', 'user.name', 'API Test')
    git('config', 'user.email', 'api@example.invalid')
    git('config', 'core.hooksPath', '/dev/null')
    (tmp_path / 'file.txt').write_text('one\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    base = git('rev-parse', 'HEAD')
    (tmp_path / 'file.txt').write_text('one\ntwo\n')
    git('commit', '-am', 'second')
    target = git('rev-parse', 'HEAD')
    (tmp_path / 'file.txt').write_text('one\ntwo\nstash\n')
    git('stash', 'push', '-m', 'API stash')
    stash = git('rev-parse', 'refs/stash')
    monkeypatch.setattr(main, 'STATE', {str(tmp_path): {}})
    monkeypatch.setattr(main.paths, 'to_container', lambda value: value)
    return TestClient(main.app), str(tmp_path), base, target, stash, git

def test_known_repository_endpoints_are_read_only(investigation):
    client, path, base, target, stash, git = investigation
    before = (git('status', '--porcelain=v2'), git('show-ref'), git('stash', 'list'))
    response = client.get('/api/repo/stashes', params={'path': path})
    assert response.status_code == 200
    assert response.json()['stashes'][0]['hash'] == stash
    response = client.get('/api/repo/stash', params={'path': path, 'hash': stash})
    assert response.status_code == 200
    assert 'stash' in response.json()['tracked']['patch']
    response = client.get('/api/repo/compare', params={'path': path, 'base': base, 'target': target, 'mode': 'direct'})
    assert response.status_code == 200
    assert response.json()['files'][0]['path'] == 'file.txt'
    response = client.get('/api/repo/file-history', params={'path': path, 'revision': target, 'file': 'file.txt', 'follow': False, 'offset': 0})
    assert response.status_code == 200
    assert len(response.json()['commits']) == 2
    assert (git('status', '--porcelain=v2'), git('show-ref'), git('stash', 'list')) == before

def test_unknown_repository_and_required_parameters(investigation):
    client, path, base, target, stash, _ = investigation
    endpoints = [('stashes', {}), ('stash', {'hash': stash}), ('compare', {'base': base, 'target': target, 'mode': 'direct'}), ('file-history', {'revision': target, 'file': 'file.txt', 'follow': False, 'offset': 0})]
    for endpoint, params in endpoints:
        assert client.get(f'/api/repo/{endpoint}', params={'path': '/unregistered', **params}).status_code == 404
        for field in params:
            missing = {key: value for key, value in params.items() if key != field}
            assert client.get(f'/api/repo/{endpoint}', params={'path': path, **missing}).status_code == 422
    assert client.get('/api/repo/stash', params={'path': path, 'hash': '--help'}).status_code == 422
    assert client.get('/api/repo/compare', params={'path': path, 'base': '--help', 'target': target, 'mode': 'direct'}).status_code == 422
    assert client.get('/api/repo/file-history', params={'path': path, 'revision': target, 'file': '../outside', 'follow': False, 'offset': 0}).status_code == 422


def test_reference_investigation_endpoints_preserve_git_state(investigation):
    client, path, base, target, stash, git = investigation
    git('tag', 'v1', base)
    git('tag', '-a', 'v2', '-m', 'Release notes', target)
    before = (git('status', '--porcelain=v2'), git('show-ref'), git('reflog', '--format=%H:%gs'))
    response = client.get('/api/repo/tags', params={'path': path})
    assert response.status_code == 200
    assert 'v1' in response.text and 'v2' in response.text
    response = client.get('/api/repo/tag', params={'path': path, 'name': 'v2'})
    assert response.status_code == 200
    assert 'Release notes' in response.text
    response = client.get('/api/repo/reflog', params={'path': path, 'ref': 'HEAD'})
    assert response.status_code == 200
    assert 'second' in response.text
    assert (git('status', '--porcelain=v2'), git('show-ref'), git('reflog', '--format=%H:%gs')) == before
    for endpoint, params in [('tags', {}), ('tag', {'name': 'v2'}), ('reflog', {'ref': 'HEAD'})]:
        assert client.get(f'/api/repo/{endpoint}', params={'path': '/unregistered', **params}).status_code == 404
        if params:
            assert client.get(f'/api/repo/{endpoint}', params={'path': path}).status_code == 422
    assert client.get('/api/repo/tag', params={'path': path, 'name': '--help'}).status_code == 404
    assert client.get('/api/repo/tag', params={'path': path, 'name': '../bad'}).status_code == 422
    assert client.get('/api/repo/reflog', params={'path': path, 'ref': '--all'}).status_code == 422


def test_file_and_line_investigations_are_pinned_and_read_only(investigation):
    import base64
    client, path, base, target, stash, git = investigation
    from pathlib import Path
    source = Path(path) / 'file.txt'
    source.write_text('staged\ntwo\n')
    git('add', 'file.txt')
    source.write_text('staged\nworking\n')
    before = (git('status', '--porcelain=v2'), git('show-ref'), git('diff', '--cached'), git('diff'))
    response = client.get('/api/repo/files', params={'path': path, 'revision': target})
    assert response.status_code == 200
    assert response.json()['pinned_hash'] == target
    assert 'file.txt' in response.text
    response = client.get('/api/repo/file', params={'path': path, 'revision': target, 'file': 'file.txt'})
    assert response.status_code == 200
    assert base64.b64decode(response.json()['content_base64']) == b'one\ntwo\n'
    response = client.get('/api/repo/blame', params={'path': path, 'revision': target, 'file': 'file.txt', 'start': 1, 'end': 2})
    assert response.status_code == 200
    assert 'API Test' in response.text
    for stage, expected, excluded in [('staged', '+staged', '+working'), ('unstaged', '+working', '+staged')]:
        response = client.get('/api/repo/worktree-diff', params={'path': path, 'stage': stage, 'file': 'file.txt', 'ignoreWhitespace': False})
        assert response.status_code == 200
        assert expected in response.json()['patch']
        assert excluded not in response.json()['patch']
    assert (git('status', '--porcelain=v2'), git('show-ref'), git('diff', '--cached'), git('diff')) == before


def test_file_endpoints_reject_missing_unsafe_and_unknown_inputs(investigation):
    client, path, base, target, stash, git = investigation
    endpoints = [('files', {'revision': target}), ('file', {'revision': target, 'file': 'file.txt'}), ('blame', {'revision': target, 'file': 'file.txt', 'start': 1, 'end': 1}), ('worktree-diff', {'stage': 'staged', 'file': '', 'ignoreWhitespace': False})]
    for endpoint, params in endpoints:
        assert client.get(f'/api/repo/{endpoint}', params={'path': '/unregistered', **params}).status_code == 404
        for field in params:
            missing = {key: value for key, value in params.items() if key != field}
            assert client.get(f'/api/repo/{endpoint}', params={'path': path, **missing}).status_code == 422
        if 'file' in params:
            assert client.get(f'/api/repo/{endpoint}', params={'path': path, **params, 'file': '../outside'}).status_code == 422


def test_content_and_file_rules_endpoints_are_explicit_and_read_only(investigation):
    from pathlib import Path
    client, path, _, _, _, git = investigation
    root = Path(path)
    (root / '.gitignore').write_text('*.log\n!keep.log\n')
    (root / '.gitattributes').write_text('*.txt text eol=lf\n')
    git('add', '.gitignore', '.gitattributes')
    git('commit', '-m', 'Add explicit file rules')
    revision = git('rev-parse', 'HEAD')
    (root / 'debug.log').write_text('ignored\n')
    (root / 'keep.log').write_text('not ignored\n')
    before = (git('status', '--porcelain=v2'), git('show-ref'), git('diff'), git('diff', '--cached'))
    search = {'path': path, 'revision': revision, 'query': 'two', 'caseSensitive': True, 'directory': ''}
    response = client.get('/api/repo/content-search', params=search)
    assert response.status_code == 200
    assert revision in response.text and 'file.txt' in response.text and 'two' in response.text
    for endpoint in ('ignored', 'eol'):
        response = client.get('/api/repo/' + endpoint, params={'path': path})
        assert response.status_code == 200
        assert ('debug.log' if endpoint == 'ignored' else 'file.txt') in response.text
    response = client.post('/api/repo/check-ignore', json={'path': path, 'paths': ['debug.log', 'keep.log', 'file.txt']})
    assert response.status_code == 200
    assert '*.log' in response.text and '!keep.log' in response.text
    response = client.post('/api/repo/attributes', json={'path': path, 'paths': ['file.txt'], 'mode': 'worktree'})
    assert response.status_code == 200
    assert 'eol' in response.text and 'lf' in response.text
    assert (git('status', '--porcelain=v2'), git('show-ref'), git('diff'), git('diff', '--cached')) == before
    assert client.get('/api/repo/content-search', params={**search, 'path': '/unregistered'}).status_code == 404
    for field in search:
        assert client.get('/api/repo/content-search', params={k: v for k, v in search.items() if k != field}).status_code == 422
    for endpoint, body in [('check-ignore', {'path': path, 'paths': ['file.txt']}), ('attributes', {'path': path, 'paths': ['file.txt'], 'mode': 'worktree'})]:
        assert client.post('/api/repo/' + endpoint, json={**body, 'path': '/unregistered'}).status_code == 404
        assert client.post('/api/repo/' + endpoint, json={**body, 'paths': ['../outside']}).status_code == 422
        for field in body:
            assert client.post('/api/repo/' + endpoint, json={k: v for k, v in body.items() if k != field}).status_code == 422


def test_file_rule_git_failures_do_not_become_empty_results(investigation, monkeypatch):
    client, path, _, revision, _, _ = investigation
    for module, function in [(main.content_search, 'get_content_search'), (main.ignore_inspector, 'inventory_ignored'), (main.ignore_inspector, 'check_ignore'), (main.file_attributes, 'get_eol_inventory'), (main.file_attributes, 'inspect_attributes')]:
        monkeypatch.setattr(module, function, lambda *args: None)
    for endpoint, params in [('content-search', {'path': path, 'revision': revision, 'query': 'x', 'directory': '', 'caseSensitive': True}), ('ignored', {'path': path}), ('eol', {'path': path})]:
        assert client.get('/api/repo/' + endpoint, params=params).status_code == 502
    for endpoint, body in [('check-ignore', {'path': path, 'paths': ['file.txt']}), ('attributes', {'path': path, 'paths': ['file.txt'], 'mode': 'worktree'})]:
        assert client.post('/api/repo/' + endpoint, json=body).status_code == 502


def test_object_investigations_verify_snapshots_and_preserve_conflicts(investigation):
    from pathlib import Path
    client, path, base, target, _, git = investigation
    git('checkout', '-b', 'conflict-feature', base)
    (Path(path) / 'file.txt').write_text('theirs\n')
    git('commit', '-am', 'conflicting change')
    git('checkout', 'main')
    result = subprocess.run(['git', '-C', path, 'merge', 'conflict-feature'], capture_output=True)
    assert result.returncode == 1
    before = (git('status', '--porcelain=v2'), git('show-ref'), git('diff'), git('diff', '--cached'))
    ours, theirs = git('rev-parse', ':2:file.txt'), git('rev-parse', ':3:file.txt')
    requests = [('conflicts', {'path': path}), ('conflict-stage', {'path': path, 'file': 'file.txt', 'stage': 2, 'expectedHash': ours}), ('conflict-comparison', {'path': path, 'file': 'file.txt', 'oursHash': ours, 'theirsHash': theirs}), ('containment', {'path': path, 'revision': base}), ('tree-sizes', {'path': path, 'revision': target})]
    for endpoint, params in requests:
        response = client.get('/api/repo/' + endpoint, params=params)
        assert response.status_code == 200, (endpoint, response.text)
        assert ('file.txt' if endpoint != 'containment' else base) in response.text
        assert client.get('/api/repo/' + endpoint, params={**params, 'path': '/unregistered'}).status_code == 404
        for field in params:
            assert client.get('/api/repo/' + endpoint, params={k: v for k, v in params.items() if k != field}).status_code == 422
    assert client.get('/api/repo/conflict-stage', params={'path': path, 'file': 'file.txt', 'stage': 2, 'expectedHash': '0' * 40}).status_code == 409
    assert client.get('/api/repo/conflict-stage', params={'path': path, 'file': '../outside', 'stage': 2, 'expectedHash': ours}).status_code == 422
    assert (git('status', '--porcelain=v2'), git('show-ref'), git('diff'), git('diff', '--cached')) == before


def test_object_investigation_git_faults_remain_errors(investigation, monkeypatch):
    client, path, base, _, _, _ = investigation
    for module, method in [(main.conflict_inspector, 'get_conflicts'), (main.conflict_inspector, 'get_conflict_stage'), (main.conflict_inspector, 'get_conflict_comparison'), (main.commit_containment, 'get_containment'), (main.tree_sizes, 'get_tree_sizes')]:
        monkeypatch.setattr(module, method, lambda *args: None)
    for endpoint, params in [('conflicts', {'path': path}), ('conflict-stage', {'path': path, 'file': 'file.txt', 'stage': 2, 'expectedHash': base}), ('conflict-comparison', {'path': path, 'file': 'file.txt', 'oursHash': base, 'theirsHash': base}), ('containment', {'path': path, 'revision': base}), ('tree-sizes', {'path': path, 'revision': base})]:
        assert client.get('/api/repo/' + endpoint, params=params).status_code == 502
