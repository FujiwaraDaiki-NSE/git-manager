"""One ref register and bounded history pages shared by a project build.

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
    # Read only the first branch-history page and its pagination sentinel.
    commits = [] if refs is not None and worktrees is not None else None
    tips = list(dict.fromkeys([item["hash"] for item in (refs or {}).values()] + heads))
    by_hash = {}
    for head in tips:
        raw = gitinfo._run(repo, ["log", "--date-order", f"--max-count={branch_history.PAGE_SIZE + 1}", f"--format={branch_history.FORMAT}", head, "--"])
        page = branch_history._parse(raw) if raw is not None else None
        if page is None:
            commits = None
            break
        by_hash.update((item["hash"], item) for item in page)
    if commits is not None:
        commits = list(by_hash.values())
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
            # A bounded page cannot establish ancestry beyond its boundary.
            self.reachable[head] = None
            pending = [head]
            seen = set()
            while pending:
                item = pending.pop()
                if item in seen:
                    continue
                seen.add(item)
                commit = self.commits.get(item)
                if commit is None:
                    return None
                pending.extend(commit["parents"])
            self.reachable[head] = seen
        return self.reachable[head]

    def unpushed_commits(self, branch_ref):
        """Exact upstream..branch hashes from the shared persisted walk."""
        branch = self.refs.get(branch_ref) if self.refs is not None else None
        if branch is None or not branch["upstream"]:
            return None
        upstream = self.ancestors(self.resolve(branch["upstream"]))
        local = self.ancestors(self.resolve(branch_ref))
        if upstream is None or local is None:
            raw = gitinfo._run(self.repo, ["rev-list", f"{branch['upstream']}..{branch_ref}", "--"])
            return sorted(raw.splitlines()) if raw is not None else None
        return sorted(local - upstream)

    def counts(self, default_ref, branch_ref):
        left = self.ancestors(self.resolve(default_ref))
        right = self.ancestors(self.resolve(branch_ref))
        if left is None or right is None:
            raw = gitinfo._run(self.repo, ["rev-list", "--left-right", "--count", f"{default_ref}...{branch_ref}"])
            parts = raw.split() if raw is not None else []
            return (int(parts[1]), int(parts[0])) if len(parts) == 2 and all(part.isdecimal() for part in parts) else (None, None)
        return len(right - left), len(left - right)

    def bases(self, default_ref, branch_ref):
        left = self.ancestors(self.resolve(default_ref))
        right = self.ancestors(self.resolve(branch_ref))
        if left is None or right is None:
            raw = gitinfo._run(self.repo, ["merge-base", default_ref, branch_ref])
            return raw.splitlines() if raw is not None else []
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
