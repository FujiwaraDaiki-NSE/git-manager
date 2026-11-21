import json
import os
import subprocess
import pytest
from app import investigation


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, 'init', '-b', 'main')
    git(tmp_path, 'config', 'user.name', 'Investigator')
    git(tmp_path, 'config', 'user.email', 'test@example.com')
    (tmp_path / 'shared.txt').write_text('base\n')
    git(tmp_path, 'add', '.')
    git(tmp_path, 'commit', '-m', 'base')
    return tmp_path


def test_overlaps_including_rename_and_untracked(repo, tmp_path):
    other = tmp_path / 'other'
    git(repo, 'worktree', 'add', '-b', 'other', str(other))
    for tree in (repo, other):
        (tree / 'shared.txt').write_text('changed\n')
        (tree / 'new file.txt').write_text('new\n')
    result = investigation.overlaps(str(repo))
    assert result['complete']
    assert [v['path'] for v in result['overlaps']] == ['new file.txt', 'shared.txt']
    assert {xy for v in result['overlaps'] for w in v['worktrees'] for xy in w['xy']} == {' M', '??'}
    git(repo, 'mv', 'shared.txt', 'renamed.txt')
    assert 'shared.txt' in [v['path'] for v in investigation.overlaps(str(repo))['overlaps']]


def test_rename_and_recreated_source_count_once_per_worktree(repo, tmp_path):
    other = tmp_path / 'other'
    git(repo, 'worktree', 'add', '-b', 'other', str(other))
    git(other, 'mv', 'shared.txt', 'renamed.txt')
    (other / 'shared.txt').write_text('recreated\n')
    assert investigation.overlaps(str(repo))['overlaps'] == []

    (repo / 'shared.txt').write_text('changed\n')
    assert investigation.overlaps(str(repo))['overlaps'] == [{
        'path': 'shared.txt',
        'worktrees': [
            {'worktree': str(repo), 'branch': 'refs/heads/main', 'xy': [' M']},
            {'worktree': str(other), 'branch': 'refs/heads/other', 'xy': ['R ', '??']},
        ],
    }]


def test_search_filters_and_paging(repo):
    for i in range(52):
        git(repo, 'commit', '--allow-empty', '-m', f'needle {i}', '-m', 'body match')
    first = investigation.search(str(repo), '--all', 'body match', 'Investigator', '', '', '', 0, 540)
    second = investigation.search(str(repo), '--all', 'body match', 'Investigator', '', '', '', 50, 540)
    assert len(first['commits']) == 50 and first['has_more']
    assert len(second['commits']) == 2 and not second['has_more']
    assert not {v['hash'] for v in first['commits']} & {v['hash'] for v in second['commits']}
    assert len(investigation.search(str(repo), '--all', '', '', '', '', 'shared.txt', 0, 540)['commits']) == 1
    with pytest.raises(ValueError):
        investigation.search(str(repo), '--all', '', '', 'bad-date', '', '', 0, 540)


def test_recovery_sources_and_reachable_exclusion(repo):
    git(repo, 'commit', '--allow-empty', '-m', 'lost')
    lost = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'reset', '--hard', 'HEAD~1')
    result = investigation.recovery(str(repo))['commits']
    candidate = next(c for c in result if c['hash'] == lost)
    assert any('@{' in s['selector'] for s in candidate['sources'])
    assert candidate['command'] == f'git branch recover/{lost[:12]} {lost}'
    git(repo, 'tag', 'saved', lost)
    assert investigation.recovery(str(repo))['commits'] == []


def test_cherry_patch_equivalence(repo):
    git(repo, 'checkout', '-b', 'left')
    (repo / 'shared.txt').write_text('equivalent\n')
    git(repo, 'commit', '-am', 'left patch')
    patch = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'right', 'main')
    git(repo, 'commit', '--allow-empty', '-m', 'right only')
    git(repo, 'cherry-pick', patch)
    result = investigation.cherry(str(repo), 'left', 'right')
    right_sha = git(repo, 'rev-parse', 'HEAD')
    assert (result['left'], result['right']) == ('left', 'right')
    assert (result['left_sha'], result['right_sha']) == (patch, right_sha)
    assert result['command'] == f'git log --cherry-mark --left-right {patch}...{right_sha}'
    assert [c['mark'] for c in result['commits']].count('=') == 2
    assert '>' in [c['mark'] for c in result['commits']]
    with pytest.raises(ValueError):
        investigation.cherry(str(repo), '--all', 'right')


def test_git_failure_is_not_empty(monkeypatch):
    monkeypatch.setattr(investigation.gitinfo, '_run', lambda *args: None)
    with pytest.raises(RuntimeError):
        investigation.overlaps('/missing')


def test_partial_worktree_failure_is_explicit(repo, tmp_path, monkeypatch):
    other = tmp_path / 'unavailable'
    git(repo, 'worktree', 'add', '-b', 'other', str(other))
    original = investigation.gitinfo._run
    monkeypatch.setattr(investigation.gitinfo, '_run', lambda path, args: None if path == str(other) and args[0] == 'status' else original(path, args))
    result = investigation.overlaps(str(repo))
    assert not result['complete']
    assert result['unavailable'] == [str(other)]
    assert result['overlaps'] == []


def test_routes_require_explicit_inputs_and_reject_unknown_repo(repo):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Lock
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from app.investigation_routes import create_router
    def known(path):
        if path != str(repo):
            raise HTTPException(404, 'unknown')
        return path
    with ThreadPoolExecutor() as pool:
        app = FastAPI()
        app.include_router(create_router(known, lambda _: Lock(), pool))
        with TestClient(app) as client:
            assert client.get('/api/repo/commit-search', params={'path': str(repo)}).status_code == 422
            assert client.get('/api/repo/worktree-overlaps', params={'path': '/unknown'}).status_code == 404
            assert client.get('/api/repo/worktree-overlaps', params={'path': str(repo)}).json()['complete']
            assert client.get('/api/repo/recovery-candidates', params={'path': str(repo)}).json()['commits'] == []
            assert client.get('/api/repo/patch-equivalence', params={'path': str(repo), 'left': 'main', 'right': 'main'}).json()['commits'] == []
            params = dict(path=str(repo), scope='--all', grep='', author='', since='', until='', file='', offset=0, tz_offset=540)
            assert len(client.get('/api/repo/commit-search', params=params).json()['commits']) == 1
            for invalid in ('not-json', '{}', '[null]', '["main"]', '["--all"]', json.dumps(['f' * 40]), json.dumps([git(repo, 'rev-parse', 'HEAD:shared.txt')])):
                response = client.get('/api/repo/commit-search', params={**params, 'fixed_shas': invalid})
                assert response.status_code == 400, response.text
            sha = git(repo, 'rev-parse', 'HEAD')
            response = client.get('/api/repo/commit-search', params={**params, 'fixed_shas': json.dumps([sha])})
            assert response.status_code == 200
            assert response.json()['fixed_shas'] == [sha]



def test_search_date_bounds_cover_whole_calendar_days(tmp_path):
    repo = tmp_path / 'dates'
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    for stamp in ('2026-01-01T08:00:00+0000', '2026-01-01T12:00:00+0000', '2026-01-02T15:30:00+0000'):
        env = {**os.environ, 'GIT_AUTHOR_DATE': stamp, 'GIT_COMMITTER_DATE': stamp}
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', stamp], check=True, env=env)
    same_day = investigation.search(str(repo), '--all', '', '', '2026-01-01', '2026-01-01', '', 0, 0)
    assert [c['subject'] for c in same_day['commits']] == ['2026-01-01T12:00:00+0000', '2026-01-01T08:00:00+0000']
    # 2026-01-02T15:30Z is 2026-01-03 00:30 in UTC+9, so it is outside Jan 2 in that zone.
    jst = investigation.search(str(repo), '--all', '', '', '2026-01-02', '2026-01-02', '', 0, 540)
    assert jst['commits'] == []


@pytest.mark.parametrize("scope", ["--all", "main"])
def test_search_snapshot_survives_ref_advance(repo, scope):
    for i in range(52):
        git(repo, 'commit', '--allow-empty', '-m', f'history {i}')
    expected = git(repo, 'log', '--format=%H', scope).splitlines()
    first = investigation.search(str(repo), scope, '', '', '', '', '', 0, 540)
    git(repo, 'commit', '--allow-empty', '-m', 'new commit')
    git(repo, 'branch', 'new-ref')
    second = investigation.search(str(repo), scope, '', '', '', '', '', 50, 540, json.dumps(first['fixed_shas']))
    actual = [c['hash'] for c in first['commits'] + second['commits']]
    assert actual == expected
    assert len(actual) == len(set(actual)) == 53
    assert second['fixed_shas'] == first['fixed_shas']
    refreshed = investigation.search(str(repo), scope, '', '', '', '', '', 0, 540)
    assert refreshed['commits'][0]['subject'] == 'new commit'


def test_empty_snapshot_does_not_use_head(repo):
    result = investigation.search(str(repo), '--all', '', '', '', '', '', 0, 540, '[]')
    assert result['commits'] == []
    assert result['fixed_shas'] == []


def test_large_snapshot_post_uses_one_batch_validation(repo, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Lock
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.investigation_routes import create_router

    for i in range(52):
        git(repo, 'commit', '--allow-empty', '-m', f'page {i}')
    expected = git(repo, 'log', '--format=%H').splitlines()[50:]
    shas = [git(repo, 'rev-parse', 'HEAD')] * 1800
    original = subprocess.run
    validations = []

    def tracked(args, **kwargs):
        if 'cat-file' in args:
            validations.append((args, kwargs['input']))
        assert 'rev-parse' not in args
        return original(args, **kwargs)

    monkeypatch.setattr(investigation.subprocess, 'run', tracked)
    body = dict(path=str(repo), scope='--all', grep='', author='', since='', until='',
                file='', offset=50, tz_offset=540, fixed_shas=shas)
    with ThreadPoolExecutor() as pool:
        app = FastAPI()
        app.include_router(create_router(lambda path: path, lambda _: Lock(), pool))
        with TestClient(app) as client:
            response = client.post('/api/repo/commit-search', json=body)
            assert response.status_code == 200, response.text
            assert [c['hash'] for c in response.json()['commits']] == expected
            assert response.json()['fixed_shas'] == shas
            assert len(validations) == 1
            assert validations[0][1].splitlines() == shas
            for invalid in (['f' * 40], ['--all']):
                assert client.post('/api/repo/commit-search', json={**body, 'fixed_shas': invalid}).status_code == 400
