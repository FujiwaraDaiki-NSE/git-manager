import subprocess
from pathlib import Path

from app import gitinfo


def git(repo, *args):
    return subprocess.run(['git','-C',str(repo),*args],check=True,capture_output=True).stdout.decode('utf-8')


def test_status_preserves_unicode_whitespace_quotes_and_rename_paths(tmp_path):
    repo = tmp_path / 'repo'; repo.mkdir()
    git(repo,'init','-q','-b','main')
    git(repo,'config','user.name','Test')
    git(repo,'config','user.email','test@example.invalid')
    old = '元の名前.txt'; (repo/old).write_text('initial\n')
    git(repo,'add','--',old); git(repo,'commit','-qm','initial')
    renamed = ' 新しい\t名前\n.txt '
    git(repo,'mv','--',old,renamed)
    names = ['未追跡 ファイル.txt',' leading and trailing ','tab\tfile','line\nbreak','carriage\rreturn','quote"file','back\\slash']
    for name in names: (repo/name).write_text('content\n')
    raw = gitinfo._run(str(repo),['status','--porcelain=v2','--branch','-z'])
    assert raw is not None
    result = gitinfo._parse_status_v2(raw)
    assert result['branch'] == 'main'
    assert {entry['path'] for entry in result['entries']} == {*names, renamed}
    assert next(entry for entry in result['entries'] if entry['path'] == renamed) == {
        'xy': 'R.', 'path': renamed, 'original_path': old,
    }
    assert all(entry['original_path'] is None for entry in result['entries'] if entry['path'] != renamed)
    assert len(result['entries']) == len(names) + 1


def test_unmerged_unicode_path_retains_conflict_state(tmp_path):
    repo=tmp_path/'conflict';repo.mkdir()
    git(repo,'init','-q','-b','main')
    git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid')
    name='競合 ファイル.txt';(repo/name).write_text('base\n')
    git(repo,'add','.');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature')
    (repo/name).write_text('feature\n');git(repo,'commit','-qam','feature')
    git(repo,'checkout','-q','main');(repo/name).write_text('main\n');git(repo,'commit','-qam','main')
    result=subprocess.run(['git','-C',str(repo),'merge','feature'],capture_output=True)
    assert result.returncode == 1
    raw=gitinfo._run(str(repo),['status','--porcelain=v2','--branch','-z'])
    assert raw is not None
    assert gitinfo._parse_status_v2(raw)['entries'] == [{'xy':'UU','path':name,'original_path':None}]


def test_collect_status_does_not_rewrite_the_index(tmp_path):
    import os

    repo = tmp_path / 'readonly'; repo.mkdir()
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.invalid')
    (repo / 'tracked.txt').write_text('unchanged content\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    index = repo / '.git' / 'index'
    before = index.read_bytes()
    stamp = (repo / 'tracked.txt').stat().st_mtime_ns
    os.utime(repo / 'tracked.txt', ns=(stamp + 10_000_000_000, stamp + 10_000_000_000))
    result = gitinfo.collect(str(repo), fetch=False)
    assert result['entries'] == []
    assert index.read_bytes() == before


def test_status_source_paths_are_explicit_and_preserved():
    original = ' 元\tの\n名前.txt '
    destination = ' 新\tしい\n名前.txt '
    for code in ('R', 'C'):
        raw = (f'2 {code}. N... 100644 100644 100644 abc def {code}100 {destination}\0'
               f'{original}\0'
               '1 .M N... 100644 100644 100644 abc def tracked.txt\0'
               '? untracked.txt\0')
        assert gitinfo._parse_status_v2(raw)['entries'] == [
            {'xy': f'{code}.', 'path': destination, 'original_path': original},
            {'xy': '.M', 'path': 'tracked.txt', 'original_path': None, 'regular_file': True},
            {'xy': '??', 'path': 'untracked.txt', 'original_path': None},
        ]


def test_status_reports_head_and_regular_file_modes_together():
    head = 'a' * 40
    rows = ('1 MM N... 100644 100755 100755 abc def regular.txt\0'
            '1 D. N... 100644 000000 000000 abc def deleted.txt\0'
            '1 M. S... 160000 160000 160000 abc def submodule\0'
            '1 A. N... 000000 120000 120000 abc def symlink\0')
    status = gitinfo._parse_status_v2(f'# branch.oid {head}\0{rows}')
    assert status['head'] == head
    assert [entry['regular_file'] for entry in status['entries']] == [True, True, False, False]
    assert gitinfo._parse_status_v2('# branch.oid (initial)\0')['head'] is None
