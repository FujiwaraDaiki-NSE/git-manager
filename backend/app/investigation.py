"""Read-only repository investigation, with explicit failures and request scopes."""
from collections import defaultdict
from datetime import date
import shlex
import json
import re
import os
import subprocess

from app import compare, gitinfo, paths

PAGE_SIZE = 50
FORMAT = "%H%x00%s%x00%aI%x00%an%x00"


def run(repo, args):
    value = gitinfo._run(repo, args)
    if value is None:
        raise RuntimeError("Gitの調査結果を取得できませんでした")
    return value


def records(raw):
    fields = raw.split("\0")
    if fields[-1].strip():
        raise RuntimeError("Gitの応答形式が不正です")
    fields.pop()
    if len(fields) % 4:
        raise RuntimeError("Gitの応答形式が不正です")
    return [dict(zip(("hash", "subject", "date", "author"), [fields[i].lstrip("\n"), *fields[i + 1:i + 4]])) for i in range(0, len(fields), 4)]


def overlaps(repo):
    inventory = run(repo, ["worktree", "list", "--porcelain", "-z"])
    groups = defaultdict(dict)
    unavailable = []
    for block in inventory.split("\0\0"):
        fields = block.split("\0")
        if not fields[0]:
            continue
        worktree = fields[0].removeprefix("worktree ")
        if "bare" in fields:
            continue
        host_path = paths.to_host(worktree)
        branch = next((v.removeprefix("branch ") for v in fields if v.startswith("branch ")), None)
        raw = gitinfo._run(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        if raw is None:
            unavailable.append(host_path)
            continue
        entries = raw.split("\0")
        index = 0
        while index < len(entries) and entries[index]:
            entry = entries[index]
            xy, file = entry[:2], entry[3:]
            changed_paths = [file]
            if "R" in xy or "C" in xy:
                index += 1
                changed_paths.append(entries[index])
            for file in set(changed_paths):
                change = groups[file].setdefault(host_path, {"worktree": host_path, "branch": branch, "xy": []})
                if xy not in change["xy"]:
                    change["xy"].append(xy)
            index += 1
    return {"overlaps": [{"path": file, "worktrees": list(values.values())} for file, values in sorted(groups.items()) if len(values) > 1], "unavailable": unavailable, "complete": not unavailable}


class InvalidSearchSnapshot(ValueError):
    pass


def search(repo, scope, grep, author, since, until, file, offset, tz_offset, fixed_shas=None):
    if offset < 0:
        raise ValueError("offset は0以上で指定してください")
    if not -14 * 60 <= tz_offset <= 14 * 60:
        raise ValueError("tz_offset は -840〜840 分で指定してください")
    for value in (since, until):
        if value:
            date.fromisoformat(value)
    if since and until and since > until:
        raise ValueError("開始日は終了日以前にしてください")
    if fixed_shas is None:
        if scope == "--all":
            revision = sorted(set(run(repo, ["log", "--all", "--no-walk", "--format=%H", "--"]).splitlines()))
        else:
            revision = [compare._resolve_commit(repo, scope, "検索範囲")]
    else:
        try:
            revision = json.loads(fixed_shas) if isinstance(fixed_shas, str) else fixed_shas
        except (ValueError, TypeError) as error:
            raise InvalidSearchSnapshot("fixed_shas はコミットSHAのJSON配列で指定してください") from error
        if not isinstance(revision, list):
            raise InvalidSearchSnapshot("fixed_shas はコミットSHAのJSON配列で指定してください")
        for sha in revision:
            if not isinstance(sha, str) or re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", sha) is None:
                raise InvalidSearchSnapshot("fixed_shas に不正なコミットSHAがあります")
        if revision:
            try:
                checked = subprocess.run(
                    [gitinfo.GIT, "-C", repo, "cat-file", "--batch-check=%(objecttype)"],
                    input="\n".join(revision) + "\n", text=True, capture_output=True,
                    timeout=gitinfo.config.GIT_TIMEOUT_SEC,
                    env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
                )
            except (subprocess.TimeoutExpired, OSError) as error:
                raise RuntimeError("固定SHAを検証できませんでした") from error
            if checked.returncode != 0:
                raise RuntimeError("固定SHAを検証できませんでした")
            if checked.stdout.splitlines() != ["commit"] * len(revision):
                raise InvalidSearchSnapshot("fixed_shas に存在しない、またはcommitではないSHAがあります")
    args = ["log", *revision, f"--format={FORMAT}", f"--skip={offset}", f"--max-count={PAGE_SIZE + 1}"]
    # Date inputs are calendar days in the viewer's timezone (minutes east of UTC).
    zone = f"{'+' if tz_offset >= 0 else '-'}{abs(tz_offset) // 60:02d}{abs(tz_offset) % 60:02d}"
    bounds = (("since", f"{since} 00:00:00 {zone}" if since else ""), ("until", f"{until} 23:59:59 {zone}" if until else ""))
    for flag, value in (("grep", grep), ("author", author), *bounds):
        if value:
            args.append(f"--{flag}={value}")
    args.append("--")
    if file:
        args.append(file)
    values = records(run(repo, args)) if revision else []
    return {"scope": scope, "fixed_shas": revision, "offset": offset, "has_more": len(values) > PAGE_SIZE, "commits": values[:PAGE_SIZE]}


def recovery(repo):
    candidates = set(run(repo, ["rev-list", "--reflog", "--all"]).splitlines()) - set(run(repo, ["rev-list", "--all", "HEAD"]).splitlines())
    sources = defaultdict(list)
    raw = run(repo, ["log", "-g", "--all", "--format=%H%x00%gD%x00%gs%x00"])
    fields = raw.split("\0")
    for i in range(0, len(fields) - 1, 3):
        sources[fields[i].lstrip("\n")].append({"selector": fields[i + 1], "message": fields[i + 2]})
    commits = []
    for sha in sorted(candidates):
        item = records(run(repo, ["show", "-s", f"--format={FORMAT}", sha]))[0]
        item["sources"] = sources[sha]
        item["command"] = f"git branch recover/{sha[:12]} {sha}"
        commits.append(item)
    commits.sort(key=lambda item: (item["date"], item["hash"]), reverse=True)
    return {"commits": commits}


def cherry(repo, left, right):
    a = compare._resolve_commit(repo, left, "A")
    b = compare._resolve_commit(repo, right, "B")
    raw = run(repo, ["log", "--cherry-mark", "--left-right", f"--format=%m%x00{FORMAT}", f"{a}...{b}", "--"])
    fields = raw.split("\0")
    commits = []
    for i in range(0, len(fields) - 1, 5):
        commits.append({"mark": fields[i].strip(), **dict(zip(("hash", "subject", "date", "author"), fields[i + 1:i + 5]))})
    return {"left": left, "right": right, "left_sha": a, "right_sha": b, "commits": commits, "command": shlex.join(["git", "log", "--cherry-mark", "--left-right", f"{a}...{b}"])}
