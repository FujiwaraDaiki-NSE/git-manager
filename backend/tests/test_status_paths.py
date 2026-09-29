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
    assert next(entry for entry in result['entries'] if entry['path'] == renamed)['xy'] == 'R.'
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
    assert gitinfo._parse_status_v2(raw)['entries'] == [{'xy':'UU','path':name}]
