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
