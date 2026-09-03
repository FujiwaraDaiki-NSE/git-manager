"""git を実行して状態を集める。

方針: 独自の記号を作らない。git status -sb が出すコード（M / ?? / UU など）を
そのまま持ち回り、集計もそのコード単位で行う。
"""
from __future__ import annotations

import os
import selectors
import shlex
import shutil
import subprocess
import time
from typing import Any, Mapping

from app import config, paths, scanner

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


def _run_limited(
    repo: str,
    args: list[str],
    max_bytes: int,
    timeout: int | None = None,
) -> str | None:
    """stdout を max_bytes + 1 bytes まで読み、超過時は git を終了させて返す。"""
    proc: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    timeout_sec = timeout or config.GIT_TIMEOUT_SEC
    try:
        proc = subprocess.Popen(
            [GIT, "-C", repo, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
        if proc.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout_sec
        while len(output) <= max_bytes:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(proc.args, timeout_sec)
            chunk = os.read(proc.stdout.fileno(), min(64 * 1024, max_bytes + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)

        if len(output) > max_bytes:
            proc.kill()
            proc.wait()
        else:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or proc.wait(timeout=remaining) != 0:
                return None
        return output.decode("utf-8", errors="replace")
    except (subprocess.TimeoutExpired, OSError):
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(timeout=1)
            except (subprocess.TimeoutExpired, OSError):
                pass
        return None
    finally:
        if selector is not None:
            selector.close()
        if proc is not None and proc.stdout is not None:
            proc.stdout.close()


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


def parse_worktree_list(raw: str) -> list[dict[str, Any]]:
    """Parse ``git worktree list --porcelain`` into JSON-friendly records.

    Newer Git supports ``-z`` for this output.  The NUL form is important for
    worktree paths containing newlines, so prefer it in :func:`list_worktrees`
    while retaining the line-oriented parser for callers/tests with legacy
    output.
    """
    worktrees: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def finish() -> None:
        if current is None or not current.get("path"):
            return
        if current.get("state") is None:
            current["state"] = "ok"
        current["detached"] = not bool(current.get("branch"))
        worktrees.append(current.copy())

    if "\x00" in raw:
        # ``git worktree list --porcelain -z`` emits NUL-terminated fields and
        # an additional NUL between records.  Do not use splitlines here: a
        # valid worktree path itself may contain a newline.
        for field in raw.split("\x00"):
            if not field:
                finish()
                current = None
                continue
            if field.startswith("worktree "):
                finish()
                current = {
                    "path": field[len("worktree "):],
                    "head": None,
                    "branch": None,
                    "state": None,
                }
            elif current is None:
                continue
            elif field.startswith("HEAD "):
                current["head"] = field[len("HEAD "):].strip() or None
            elif field.startswith("branch "):
                branch = field[len("branch "):].strip()
                if branch.startswith("refs/heads/"):
                    branch = branch[len("refs/heads/"):]
                current["branch"] = branch or None
            elif field == "detached":
                current["detached"] = True
            elif field.startswith("prunable"):
                current["state"] = "prunable"
            elif field.startswith("locked") and current.get("state") != "prunable":
                current["state"] = "locked"
        finish()
        return worktrees

    for line in raw.splitlines():
        if line.startswith("worktree "):
            finish()
            current = {
                "path": line[len("worktree "):],
                "head": None,
                "branch": None,
                "state": None,
            }
        elif current is None:
            continue
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD "):].strip() or None
        elif line.startswith("branch "):
            branch = line[len("branch "):].strip()
            if branch.startswith("refs/heads/"):
                branch = branch[len("refs/heads/"):]
            current["branch"] = branch or None
        elif line == "detached":
            current["detached"] = True
        elif line.startswith("prunable"):
            current["state"] = "prunable"
        elif line.startswith("locked") and current.get("state") != "prunable":
            current["state"] = "locked"
    finish()
    return worktrees


def list_worktrees(repo: str) -> list[dict[str, Any]] | None:
    """Return worktree metadata, or ``None`` when git cannot list it."""
    raw = _run(repo, ["worktree", "list", "--porcelain", "-z"])
    if raw is None:
        return None
    worktrees = parse_worktree_list(raw)
    # Git reports the external gitdir as the main worktree path for a
    # ``--separate-git-dir`` repository.  That repository is not linked, so
    # expose its actual checkout path to discovery and callers.
    layout = scanner.repo_layout(repo)
    if layout is not None and not layout.is_worktree:
        common_git_dir = os.path.realpath(layout.common_git_dir)
        repo_path = os.path.abspath(repo)
        for item in worktrees:
            if os.path.realpath(os.path.abspath(str(item.get("path", "")))) == common_git_dir:
                item["path"] = repo_path
    elif layout is not None:
        # From a linked checkout, the first record is indistinguishable from
        # an administration directory when --separate-git-dir was used.  Mark
        # the candidate so a caller with independent checkout evidence can
        # decide whether it is safe to expose.
        common_git_dir = os.path.realpath(layout.common_git_dir)
        for item in worktrees:
            item_path = os.path.realpath(os.path.abspath(str(item.get("path", ""))))
            separate_dot_git_admin = (
                os.path.basename(common_git_dir) == ".git"
                and item_path == os.path.dirname(common_git_dir)
            )
            if item_path == common_git_dir or separate_dot_git_admin:
                item["administrative_candidate"] = True
    return worktrees


def merged_branches(repo: str, base_commit: str) -> set[str] | None:
    """Return local branches already merged into the main worktree commit."""
    raw = _run(repo, ["branch", "--merged", base_commit, "--format=%(refname:short)"])
    if raw is None:
        return None
    return {line.strip() for line in raw.splitlines() if line.strip()}


def default_branch(repo: str) -> str | None:
    """Return origin's symbolic default branch without guessing a name."""
    raw = _run(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    if not raw:
        return None
    value = raw.strip()
    prefix = "origin/"
    return value[len(prefix):] if value.startswith(prefix) else None


def next_command(
    info: dict[str, Any],
    remote: str | None,
    context: Mapping[str, Any] | None = None,
    *,
    worktree_state: str | None = None,
    merged: bool | None = None,
    worktree: str | None = None,
) -> dict[str, str] | None:
    """今の状態から、次に打つべきコマンドを 1 つだけ返す。

    順序が重要。作業ツリーが汚れているときに pull を勧めると失敗するので、
    先に手元を片付ける方向へ誘導する。
    """
    context = context or {}
    if worktree_state is None:
        worktree_state = context.get("worktree_state")
    if merged is None:
        merged = bool(context.get("merged", False))
    if worktree is None:
        worktree = context.get("worktree")
    merged_branch = context.get("merged_branch")

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
    if worktree_state == "prunable":
        return {"command": "git worktree prune", "reason": "prunable な worktree があります"}
    if worktree_state == "locked" and merged and worktree:
        # Git refuses to remove a locked worktree.  Unlocking is safe to
        # present only after dirty/conflict checks above have passed.
        return {
            "command": shlex.join(["git", "worktree", "unlock", worktree]),
            "reason": "マージ済みですが worktree がロックされています",
        }
    if merged:
        if worktree:
            return {
                "command": shlex.join(["git", "worktree", "remove", worktree]),
                "reason": "マージ済みの worktree があります",
            }
    if merged_branch:
        return {
            "command": shlex.join(["git", "branch", "-d", str(merged_branch)]),
            "reason": "マージ済みで worktree のないブランチがあります",
        }
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


def collect(
    repo: str,
    fetch: bool = False,
    context: Mapping[str, Any] | None = None,
    *,
    common_dir: str | None = None,
    is_worktree: bool | None = None,
    worktree_state: str | None = None,
    worktree: str | None = None,
    merged: bool | None = None,
) -> dict[str, Any]:
    """1 リポジトリの状態。失敗しても例外は投げない。

    ``context`` is supplied by discovery, which already has the result of
    ``git worktree list --porcelain``.  Keeping that metadata out of the
    status parser makes a refresh cheap and also lets prunable worktrees be
    represented even when their directory no longer exists.
    """
    context = dict(context or {})
    if common_dir is not None:
        context["common_dir"] = common_dir
    if is_worktree is not None:
        context["is_worktree"] = is_worktree
    if worktree_state is not None:
        context["worktree_state"] = worktree_state
    if worktree is not None:
        context["worktree"] = worktree
    if merged is not None:
        context["merged"] = merged

    layout = scanner.repo_layout(repo)
    repo_host = paths.to_host(repo)
    resolved_common_dir = context.get("common_dir")
    if resolved_common_dir is None:
        if layout is None:
            resolved_common_dir = repo_host
        else:
            resolved_common_dir = paths.to_host(layout.common_root)
    resolved_is_worktree = context.get(
        "is_worktree",
        layout.is_worktree if layout is not None else False,
    )
    resolved_worktree = context.get("worktree")
    if resolved_worktree is None and resolved_is_worktree:
        resolved_worktree = repo_host
    resolved_worktree_state = context.get("worktree_state")
    resolved_merged = bool(context.get("merged", False))
    context_branch = context.get("branch")
    context_detached = bool(context.get("detached", False))
    merged_branches = list(context.get("merged_branches", []))
    merged_branch = context.get("merged_branch")

    # Git's own common-dir result is authoritative.  Discovery context remains
    # necessary for a prunable worktree whose directory no longer exists.
    common_raw = _run(repo, ["rev-parse", "--git-common-dir"])
    if common_raw:
        common_git_dir = common_raw.strip()
        if not os.path.isabs(common_git_dir):
            common_git_dir = os.path.join(repo, common_git_dir)
        if layout is not None:
            # scanner.repo_layout distinguishes a linked worktree from a
            # normal repository using actual != common, including the
            # separate-git-dir case where .git is a pointer file.
            resolved_common_dir = paths.to_host(layout.common_root)
            resolved_is_worktree = layout.is_worktree
        else:
            common_root = os.path.dirname(os.path.realpath(common_git_dir))
            resolved_common_dir = paths.to_host(common_root)
            resolved_is_worktree = os.path.realpath(repo) != common_root

    fetched_at: float | None = None
    if fetch and config.FETCH_ENABLED:
        if do_fetch(repo):
            fetched_at = time.time()

    result: dict[str, Any] = {
        "path": repo_host,
        "name": os.path.basename(repo.rstrip("/")),
        "common_dir": resolved_common_dir,
        "is_worktree": bool(resolved_is_worktree),
        "worktree_state": resolved_worktree_state,
        "worktree": resolved_worktree,
        "merged": resolved_merged,
        "merged_branches": merged_branches,
        "merged_branch": merged_branch,
        "error": None,
        "branch": context_branch,
        "detached": context_detached,
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
        status_info = {
            "branch": result["branch"],
            "detached": result["detached"],
            "upstream": result["upstream"],
            "ahead": result["ahead"],
            "behind": result["behind"],
            "entries": result["entries"],
        }
        result["branch_line"] = branch_line(status_info)
        result["next_command"] = next_command(
            status_info,
            result["remote"],
            context,
            worktree_state=resolved_worktree_state,
            merged=resolved_merged,
            worktree=resolved_worktree,
        )
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
    result["next_command"] = next_command(
        info,
        result["remote"],
        context,
        worktree_state=resolved_worktree_state,
        merged=resolved_merged,
        worktree=resolved_worktree,
    )

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
