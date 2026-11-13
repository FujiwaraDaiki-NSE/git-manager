"""One ref register and commit walk shared by a project build.

Git still selects a merge base when criss-cross history has multiple best
bases; the unique-base case and exact reachability counts use the shared walk.
"""
from __future__ import annotations

from contextvars import ContextVar
from functools import wraps

from app import gitinfo, project_facts

_active = ContextVar("project_git_batch", default=None)


def current(repo):
    batch = _active.get()
    return batch if batch is not None and batch.repo == repo else None


def _read(repo):
    from app import branch_history
    raw = gitinfo._run(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads", "refs/remotes"])
    refs = None
    if raw is not None:
        refs = {}
        for line in raw.splitlines():
            fields = line.split("\0")
            if len(fields) != 3:
                raise RuntimeError("Git参照の一括取得結果が不正です")
            refs[fields[0]] = {"hash": fields[1], "upstream": fields[2]}
    worktrees = gitinfo.list_worktrees(repo)
    heads = list(dict.fromkeys(item["head"] for item in worktrees or [] if item.get("head") and set(item["head"]) != {"0"}))
    raw = gitinfo._run(repo, ["log", "--all", f"--format={branch_history.FORMAT}", *heads, "--"])
    commits = branch_history._parse(raw) if raw is not None else None
    if refs is None or commits is None or worktrees is None:
        raise RuntimeError("Git参照・履歴の一括取得に失敗しました")
    return {"refs": refs, "commits": commits}


class Batch:
    def __init__(self, repo, data):
        self.repo = repo
        self.refs = data["refs"]
        self.commits = None if data["commits"] is None else {item["hash"]: item for item in data["commits"]}
        self.reachable = {}
        self.reflogs = {}

    def resolve(self, ref):
        if self.refs is None:
            return None
        if ref in self.refs:
            return self.refs[ref]["hash"]
        if self.commits is not None and ref in self.commits:
            return ref
        return None

    def ancestors(self, head):
        if self.commits is None or head not in self.commits:
            return None
        if head not in self.reachable:
            pending = [head]
            seen = set()
            while pending:
                item = pending.pop()
                if item in seen:
                    continue
                seen.add(item)
                commit = self.commits.get(item)
                if commit is not None:
                    pending.extend(commit["parents"])
            self.reachable[head] = seen
        return self.reachable[head]

    def counts(self, default_ref, branch_ref):
        left = self.ancestors(self.resolve(default_ref))
        right = self.ancestors(self.resolve(branch_ref))
        if left is None or right is None:
            return None, None
        return len(right - left), len(left - right)

    def bases(self, default_ref, branch_ref):
        left = self.ancestors(self.resolve(default_ref))
        right = self.ancestors(self.resolve(branch_ref))
        if left is None or right is None:
            return []
        common = left & right
        # Every common ancestor except a best base is parent of another
        # common ancestor (possibly through a chain of common ancestors).
        dominated = {parent for item in common if item in self.commits for parent in self.commits[item]["parents"]}
        return sorted(common - dominated)


def scoped(function):
    @wraps(function)
    def build(repo, *args, **kwargs):
        data = project_facts.observe("project.batch", [repo], lambda: _read(repo))
        token = _active.set(Batch(repo, data))
        try:
            return function(repo, *args, **kwargs)
        finally:
            _active.reset(token)
    return build
