import subprocess

from app import detail


def git(repo, *args):
    return subprocess.run(
        ['git', '-C', str(repo), *args], check=True, capture_output=True
    ).stdout.decode('utf-8')


def test_commit_preserves_filenames_and_rename_pairs(tmp_path):
    git(tmp_path, 'init', '-q', '-b', 'main')
    git(tmp_path, 'config', 'user.name', 'Test')
    git(tmp_path, 'config', 'user.email', 'test@example.invalid')
    old = '旧 名前.txt'
    (tmp_path / old).write_text('rename content\n')
    git(tmp_path, 'add', '.')
    git(tmp_path, 'commit', '-qm', 'base')
    renamed = ' 新しい\t名前\n.txt '
    git(tmp_path, 'mv', '--', old, renamed)
    names = ['日本語.txt', 'line\nbreak', 'carriage\rreturn', 'tab\tfile', ' leading and trailing ', 'quote"file', 'back\\slash']
    for name in names:
        (tmp_path / name).write_text('new content\n')
    (tmp_path / 'binary.bin').write_bytes(b'\0\1\2')
    git(tmp_path, 'add', '.')
    git(tmp_path, 'commit', '-qm', '日本語の変更\x1f区切り文字も保持')
    result = detail.get_commit(str(tmp_path), git(tmp_path, 'rev-parse', 'HEAD').strip())
    assert result is not None
    assert result['subject'] == '日本語の変更\x1f区切り文字も保持'
    files = {file['path']: file for file in result['files']}
    assert set(files) == {*names, renamed, 'binary.bin'}
    assert files[renamed]['old_path'] == old
    assert files[renamed]['additions'] == 0
    assert files['日本語.txt']['additions'] == 1
    assert 'old_path' not in files['日本語.txt']
    assert files['binary.bin']['binary'] is True
    assert files['binary.bin']['additions'] == '-'


def test_empty_commit_has_no_files(tmp_path):
    git(tmp_path, 'init', '-q', '-b', 'main')
    git(tmp_path, 'config', 'user.name', 'Test')
    git(tmp_path, 'config', 'user.email', 'test@example.invalid')
    git(tmp_path, 'commit', '--allow-empty', '-qm', 'empty')
    result = detail.get_commit(str(tmp_path), git(tmp_path, 'rev-parse', 'HEAD').strip())
    assert result is not None
    assert result['files'] == []
    assert result['parents'] == []
    assert result['patch'] == ''


def test_batched_graph_stats_keep_exact_paths_without_per_commit_processes(tmp_path, monkeypatch):
    from app import gitinfo, project

    git(tmp_path, 'init', '-q', '-b', 'main')
    git(tmp_path, 'config', 'user.name', 'Test')
    git(tmp_path, 'config', 'user.email', 'test@example.invalid')
    original = '日本語\tファイル\n.txt '
    (tmp_path / original).write_text('first\nsecond\n')
    git(tmp_path, 'add', '.')
    git(tmp_path, 'commit', '-qm', 'first')
    first = git(tmp_path, 'rev-parse', 'HEAD').strip()
    renamed = '新しい\r名前.txt'
    git(tmp_path, 'mv', '--', original, renamed)
    (tmp_path / 'binary.bin').write_bytes(b'\0\1\2')
    git(tmp_path, 'add', '.')
    git(tmp_path, 'commit', '-qm', 'rename and binary')
    second = git(tmp_path, 'rev-parse', 'HEAD').strip()
    git(tmp_path, 'commit', '--allow-empty', '-qm', 'empty')
    empty = git(tmp_path, 'rev-parse', 'HEAD').strip()
    calls = []
    run = gitinfo._run

    def tracked(repo, args, *rest, **kwargs):
        calls.append(args)
        return run(repo, args, *rest, **kwargs)

    monkeypatch.setattr(gitinfo, '_run', tracked)
    result = project._commit_stats_many(str(tmp_path), [first, second, empty])
    assert len(calls) == 1
    assert result[first] == {'files': 1, 'additions': 2, 'deletions': 0, 'paths': [original]}
    assert result[second]['files'] == 2
    assert set(result[second]['paths']) == {renamed, 'binary.bin'}
    assert result[second]['additions'] is None
    assert result[second]['deletions'] is None
    assert result[empty] == {'files': 0, 'additions': 0, 'deletions': 0, 'paths': []}
