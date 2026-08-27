"""git を実行して状態を集める。

方針: 独自の記号を作らない。git status -sb が出すコード（M / ?? / UU など）を
そのまま持ち回り、集計もそのコード単位で行う。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Any

from app import config, paths

GIT = shutil.which("git") or "git"

# fetch がパスフレーズや認証を聞きに行って無言で固まるのを防ぐ。
# BatchMode が無いと ssh-agent に鍵が無いリポジトリでハングする。
NON_INTERACTIVE_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_SSH_COMMAND": "ssh -oBatchMode=yes -oConnectTimeout=5 -oStrictHostKeyChecking=accept-new",
    "GIT_ASKPASS": "true",
    "SSH_ASKPASS": "true",
    "GIT_PAGER": "cat",
}


def _run(repo: str, args: list[str], timeout: int | None = None) -> str | None:
    try:
        proc = subprocess.run(
            [GIT, "-C", repo, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout or config.GIT_TIMEOUT_SEC,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    return proc.stdout if proc.returncode == 0 else None


def _unquote(path: str) -> str:
    """porcelain v2 の path はそのまま。念のため前後の空白だけ落とす。"""
    return path.strip()


def _parse_status_v2(out: str) -> dict[str, Any]:
    """git status --porcelain=v2 --branch を、短縮形式のコードに戻して返す。"""
    branch: str | None = None
    upstream: str | None = None
    detached = False
    ahead = behind = 0
    entries: list[dict[str, str]] = []

    for line in out.splitlines():
        if line.startswith("# branch.head "):
            branch = line[len("# branch.head "):].strip()
            detached = branch == "(detached)"
        elif line.startswith("# branch.upstream "):
            upstream = line[len("# branch.upstream "):].strip()
        elif line.startswith("# branch.ab "):
            for token in line[len("# branch.ab "):].split():
                if token.startswith("+"):
                    ahead = int(token[1:])
                elif token.startswith("-"):
                    behind = int(token[1:])
        elif line.startswith("1 "):
            fields = line.split(" ", 8)
            entries.append({"xy": fields[1], "path": _unquote(fields[8])})
        elif line.startswith("2 "):
            fields = line.split(" ", 9)
            # rename は path\torigPath 形式。表示は新しい方
            entries.append({"xy": fields[1], "path": _unquote(fields[9].split("\t")[0])})
        elif line.startswith("u "):
            fields = line.split(" ", 10)
            entries.append({"xy": fields[1], "path": _unquote(fields[10])})
        elif line.startswith("? "):
            entries.append({"xy": "??", "path": _unquote(line[2:])})

    return {
        "branch": branch,
        "detached": detached,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "entries": entries,
    }


def branch_line(info: dict[str, Any]) -> str:
    """git status -sb の 1 行目を再現する。独自表記を使わないための要。"""
    if info["detached"]:
        head = "HEAD (no branch)"
    else:
        head = info["branch"] or "(unknown)"
    if not info["upstream"]:
        return f"## {head}"
    line = f"## {head}...{info['upstream']}"
    parts = []
    if info["ahead"]:
        parts.append(f"ahead {info['ahead']}")
    if info["behind"]:
        parts.append(f"behind {info['behind']}")
    if parts:
        line += " [" + ", ".join(parts) + "]"
    return line


def count_by_code(entries: list[dict[str, str]]) -> list[dict[str, Any]]:
    """XY コードごとの件数。git 自身の語彙のまま集計する。"""
    counts: dict[str, int] = {}
    for e in entries:
        counts[e["xy"]] = counts.get(e["xy"], 0) + 1
    return [{"xy": xy, "count": n} for xy, n in sorted(counts.items())]


def next_command(info: dict[str, Any], remote: str | None) -> dict[str, str] | None:
    """今の状態から、次に打つべきコマンドを 1 つだけ返す。

    順序が重要。作業ツリーが汚れているときに pull を勧めると失敗するので、
    先に手元を片付ける方向へ誘導する。
    """
    entries = info["entries"]
    conflicts = [e for e in entries if e["xy"] in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}]
    unstaged = [e for e in entries if e["xy"] != "??" and len(e["xy"]) == 2 and e["xy"][1] != "."]
    staged = [e for e in entries if e["xy"] != "??" and len(e["xy"]) == 2 and e["xy"][0] != "."]
    untracked = [e for e in entries if e["xy"] == "??"]

    if conflicts:
        return {"command": "git status", "reason": "コンフリクトが残っています"}
    if unstaged:
        return {"command": "git add -p", "reason": "未ステージの変更があります"}
    if untracked and not staged:
        return {"command": "git add -A", "reason": "未追跡ファイルがあります"}
    if staged:
        return {"command": "git commit", "reason": "ステージ済みの変更があります"}
    if info["detached"]:
        return {"command": "git switch -", "reason": "detached HEAD です"}
    if not info["upstream"] and info["branch"]:
        if not remote:
            # リモートが無いなら push を勧めても打てない
            return None
        return {
            "command": f"git push -u origin {info['branch']}",
            "reason": "上流ブランチが設定されていません",
        }
    if info["ahead"] and info["behind"]:
        return {"command": "git pull --rebase", "reason": "上流と分岐しています"}
    if info["behind"]:
        return {"command": "git pull --ff-only", "reason": "上流が進んでいます"}
    if info["ahead"]:
        return {"command": "git push", "reason": "未 push のコミットがあります"}
    return None


def do_fetch(repo: str) -> bool:
    """成功したら True。認証切れやオフラインでは False。"""
    out = _run(
        repo,
        ["fetch", "--quiet", "--no-tags", "--prune"],
        timeout=config.FETCH_TIMEOUT_SEC,
    )
    return out is not None


def collect(repo: str, fetch: bool = False) -> dict[str, Any]:
    """1 リポジトリの状態。失敗しても例外は投げない。"""
    fetched_at: float | None = None
    if fetch and config.FETCH_ENABLED:
        if do_fetch(repo):
            fetched_at = time.time()

    result: dict[str, Any] = {
        "path": paths.to_host(repo),
        "name": os.path.basename(repo.rstrip("/")),
        "error": None,
        "branch": None,
        "detached": False,
        "upstream": None,
        "ahead": 0,
        "behind": 0,
        "entries": [],
        "counts": [],
        "branch_line": "",
        "stashes": 0,
        "remote": None,
        "last_commit": None,
        "next_command": None,
        "can_ff": False,
        "diverged": False,
        "fetched_at": fetched_at,
        "checked_at": time.time(),
    }

    status = _run(repo, ["status", "--porcelain=v2", "--branch"])
    if status is None:
        result["error"] = "git status を実行できませんでした"
        return result

    info = _parse_status_v2(status)
    result.update(info)
    result["branch_line"] = branch_line(info)
    result["counts"] = count_by_code(info["entries"])
    result["can_ff"] = info["behind"] > 0 and info["ahead"] == 0
    result["diverged"] = info["behind"] > 0 and info["ahead"] > 0

    remote = _run(repo, ["config", "--get", "remote.origin.url"])
    if remote:
        result["remote"] = remote.strip()
    result["next_command"] = next_command(info, result["remote"])

    log = _run(repo, ["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%cI"])
    if log:
        parts = log.strip().split("\x1f")
        if len(parts) == 4:
            result["last_commit"] = {
                "hash": parts[0],
                "subject": parts[1],
                "author": parts[2],
                "date": parts[3],
            }

    stash = _run(repo, ["stash", "list"])
    if stash:
        result["stashes"] = len([ln for ln in stash.splitlines() if ln.strip()])

    return result
