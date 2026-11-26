"""git を実行して状態を集める。

方針: 独自の記号を作らない。git status -sb が出すコード（M / ?? / UU など）を
そのまま持ち回り、集計もそのコード単位で行う。
"""
from __future__ import annotations

import os
import re
import selectors
import shlex
import shutil
import subprocess
import time
from typing import Any, Callable, Mapping

from app import config, paths, scanner, project_facts

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


@project_facts.cached
def _run(repo: str, args: list[str], timeout: int | None = None) -> str | None:
    try:
        proc = subprocess.run(
            [GIT, "-C", repo, *args],
            capture_output=True,
            timeout=timeout or config.GIT_TIMEOUT_SEC,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    return proc.stdout.decode("utf-8", errors="replace") if proc.returncode == 0 else None


@project_facts.cached
def _run_with_status(
    repo: str,
    args: list[str],
    timeout: int | None = None,
) -> tuple[str | None, int | None]:
    """Run Git while retaining its exit status for explicit no-match facts."""
    try:
        proc = subprocess.run(
            [GIT, "-C", repo, *args],
            capture_output=True,
            timeout=timeout or config.GIT_TIMEOUT_SEC,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
    except (subprocess.TimeoutExpired, OSError):
        return None, None
    output = proc.stdout.decode("utf-8", errors="replace")
    return output if proc.returncode == 0 else None, proc.returncode


def _run_status(repo: str) -> tuple[str | None, str | None]:
    error = "git status を実行できませんでした"
    try:
        proc = subprocess.run(
            [GIT, "-C", repo, "--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"],
            capture_output=True,
            timeout=config.GIT_TIMEOUT_SEC,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
    except subprocess.TimeoutExpired:
        return None, f"{error}: タイムアウト（{config.GIT_TIMEOUT_SEC}秒）"
    except OSError as exc:
        return None, f"{error}: Gitの起動に失敗しました（{exc}）"
    if proc.returncode == 0:
        return proc.stdout.decode("utf-8", errors="replace"), None
    first_line = proc.stderr.decode("utf-8", errors="replace").partition("\n")[0].removesuffix("\r")
    if first_line:
        return None, f"{error}: {first_line}"
    return None, error


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


def _parse_status_v2(out: str) -> dict[str, Any]:
    """Parse NUL-delimited porcelain v2 without quoting or trimming file paths."""
    branch: str | None = None
    head: str | None = None
    upstream: str | None = None
    detached = False
    ahead = behind = 0
    entries: list[dict[str, Any]] = []

    records = iter(out.split("\0"))
    for line in records:
        if line.startswith("# branch.oid "):
            oid = line[len("# branch.oid "):]
            if oid != "(initial)":
                head = oid
        elif line.startswith("# branch.head "):
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
            modes = fields[3:6]  # HEAD, index, worktree
            regular_file = all(mode in ("000000", "100644", "100755") for mode in modes)
            entries.append({"xy": fields[1], "path": fields[8], "original_path": None, "regular_file": regular_file})
        elif line.startswith("2 "):
            fields = line.split(" ", 9)
            # In -z mode the destination is followed by a separate source record.
            entries.append({"xy": fields[1], "path": fields[9], "original_path": next(records, None)})
        elif line.startswith("u "):
            fields = line.split(" ", 10)
            entries.append({"xy": fields[1], "path": fields[10], "original_path": None})
        elif line.startswith("? "):
            entries.append({"xy": "??", "path": line[2:], "original_path": None})

    return {
        "branch": branch,
        "head": head,
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
        if current["state"] != "locked":
            current["lock_reason"] = None
        if current["state"] != "prunable":
            current["prunable_reason"] = None
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
            elif field == "prunable" or field.startswith("prunable "):
                current["state"] = "prunable"
                current["prunable_reason"] = field.partition(" ")[2] or None
            elif (field == "locked" or field.startswith("locked ")) and current.get("state") != "prunable":
                current["state"] = "locked"
                current["lock_reason"] = field.partition(" ")[2] or None
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
        elif line == "prunable" or line.startswith("prunable "):
            current["state"] = "prunable"
            current["prunable_reason"] = line.partition(" ")[2] or None
        elif (line == "locked" or line.startswith("locked ")) and current.get("state") != "prunable":
            current["state"] = "locked"
            current["lock_reason"] = line.partition(" ")[2] or None
    finish()
    return worktrees


def list_worktrees(repo: str) -> list[dict[str, Any]] | None:
    """Return worktree metadata, or ``None`` when git cannot list it."""
    # Parse the cached Git output so existing snapshots also expose worktree reasons.
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
        reported_admin_paths = {common_git_dir}
        if os.path.basename(common_git_dir) == ".git":
            reported_admin_paths.add(os.path.dirname(common_git_dir))
        for item in worktrees:
            item_path = os.path.realpath(os.path.abspath(str(item.get("path", ""))))
            if item_path in reported_admin_paths:
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


def _can_switch_back(repo: str) -> bool:
    previous = _run(repo, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", "@{-1}"])
    if previous is None or not previous.startswith("refs/heads/"):
        return False
    ref = previous.rstrip("\n")
    checkout = _run(repo, ["for-each-ref", "--format=%(refname)%00%(worktreepath)", "--", ref])
    return checkout == f"{ref}\0\n"


def next_command_without_status(worktree_state: str | None) -> dict[str, str] | None:
    if worktree_state == "prunable":
        return {"command": "git worktree prune", "reason": "prunable な worktree があります"}
    return None


def next_command(
    info: dict[str, Any],
    remote: str | None,
    context: Mapping[str, Any] | None = None,
    *,
    resolve_destinations: Callable[[], dict[str, Any] | None] | None = None,
    can_switch_back: Callable[[], bool] | None = None,
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
        if can_switch_back is not None and can_switch_back():
            return {"command": "git switch -", "reason": "detached HEAD です"}
        return {"command": "git branch --contains HEAD", "reason": "detached HEAD の戻り先を確認できないため、現在のコミットを含むブランチを表示します"}
    if worktree_state == "prunable":
        return next_command_without_status(worktree_state)
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
            "command": shlex.join(["git", "push", "-u", "origin", info["branch"]]),
            "reason": "上流ブランチが設定されていません",
        }
    if info["ahead"] and info["behind"]:
        return {"command": "git pull --rebase", "reason": "上流と分岐しています"}
    if info["behind"]:
        return {"command": "git pull --ff-only", "reason": "上流が進んでいます"}
    if info["ahead"]:
        destinations = resolve_destinations() if resolve_destinations is not None else None
        if destinations is None:
            return {"command": "git config --show-origin --get push.default", "reason": "実効push設定を取得できないため設定を確認します"}
        return destinations["push_next_command"]
    return None


def do_fetch(repo: str) -> dict[str, Any]:
    """Retain the latest attempt independently of the last successful fetch."""
    category = None
    reason = None
    try:
        proc = subprocess.run(
            [GIT, "-C", repo, "fetch", "--quiet", "--no-tags", "--prune"],
            capture_output=True, timeout=config.FETCH_TIMEOUT_SEC,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
        success = proc.returncode == 0
        if not success:
            reason = " ".join(proc.stderr.decode("utf-8", errors="replace").split())[:600]
            lower = reason.lower()
            category = (
                "authentication" if any(x in lower for x in ("authentication", "permission denied", "could not read username", "terminal prompts disabled", "access denied"))
                else "timeout" if any(x in lower for x in ("timed out", "timeout"))
                else "connection" if any(x in lower for x in ("could not resolve", "unable to access", "connection", "network is unreachable", "no route to host"))
                else "other"
            )
    except subprocess.TimeoutExpired as exc:
        success, category = False, "timeout"
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
        reason = ("fetch timed out: " + " ".join(stderr.split()))[:600]
    except OSError as exc:
        success, category, reason = False, "other", str(exc)[:600]
    return {"attempted_at": time.time(), "result": "success" if success else "failure", "category": category, "reason": reason}


def operations(repo: str) -> list[dict[str, Any]] | None:
    """Read worktree-specific markers; None means observation failed."""
    raw = _run(repo, ["rev-parse", "--absolute-git-dir"])
    if raw is None:
        return None
    from pathlib import Path
    directory = Path(raw.strip())
    result = []
    markers = [("MERGE_HEAD", "merge"), ("rebase-merge", "rebase"), ("rebase-apply", "unknown"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert"), ("BISECT_LOG", "bisect")]
    try:
        todo = "sequencer/todo"
        try:
            with (directory / todo).open(encoding="utf-8", errors="replace") as pending:
                action = pending.readline().split(maxsplit=2)
        except FileNotFoundError:
            action = []
        todo_kind = None
        todo_first = None
        if len(action) >= 2 and action[0] in ("pick", "revert"):
            todo_kind = "cherry-pick" if action[0] == "pick" else "revert"
            markers.append((todo, todo_kind))
            sha = action[1]
            if re.fullmatch(r"[0-9a-fA-F]{4,64}", sha):
                commit = _run(repo, ["log", "-1", "--no-show-signature", "--format=%H%x00%s", f"{sha}^{{commit}}", "--"])
                if commit is not None:
                    commit_hash, separator, subject = commit.removesuffix("\n").partition("\x00")
                    if separator and commit_hash.startswith(sha.lower()):
                        todo_first = {"hash": commit_hash, "subject": subject}
        for marker, kind in markers:
            target = directory / marker
            if marker == todo:
                if any(operation["kind"] == kind for operation in result):
                    continue
            else:
                try:
                    target.stat()
                except FileNotFoundError:
                    continue
            if marker == "rebase-apply":
                applying = (target / "applying").is_file()
                rebasing = (target / "rebasing").is_file()
                if applying != rebasing:
                    kind = "am" if applying else "rebase"
            step = total = None
            if kind in ("rebase", "am"):
                step_file, total_file = ("msgnum", "end") if marker == "rebase-merge" else ("next", "last")
                try:
                    step = int((target / step_file).read_text().strip())
                    total = int((target / total_file).read_text().strip())
                except (OSError, ValueError):
                    step = total = None
            commands = [{"command": "git status", "reason": "競合と現在の作業状態を確認します"}]
            if kind == "bisect":
                commands += [{"command": "git bisect log", "reason": "これまでの判定を確認します"}, {"command": "git bisect good", "reason": "現在のコミットを正常と判定して探索を続けます"}, {"command": "git bisect bad", "reason": "現在のコミットを問題ありと判定して探索を続けます"}, {"command": "git bisect reset", "reason": "探索を終了し開始前のHEADに戻します"}]
            elif kind != "unknown":
                commands += [{"command": f"git {kind} --continue", "reason": "競合を解消してステージした後、操作を継続します"}, {"command": f"git {kind} --abort", "reason": "進行中の操作を中止します"}]
            result.append({"kind": kind, "marker": marker, "step": step, "total": total, "commands": commands,
                           "todo_first": todo_first if kind == todo_kind else None})
    except OSError:
        return None
    return result


def _config_key(key: str) -> str:
    """Git folds section/key case but preserves subsection case."""
    section, _, rest = key.partition(".")
    subsection, dot, name = rest.rpartition(".")
    return f"{section.lower()}.{subsection}.{name.lower()}" if dot else f"{section.lower()}.{rest.lower()}"


@project_facts.cached
def _branch_config_sources(repo: str) -> tuple[dict[str, list[str | None]], dict[str, list[dict[str, str | None]]]] | None:
    # 保存済み観測は関数名で引くため、戻り値の形を変えるときは関数名も変える。
    # Keep the resolution and its source in one Git observation. Retain only
    # settings used here, and origins for the three push remote selectors.
    try:
        proc = subprocess.run(
            [GIT, "-C", repo, "config", "-z", "--show-origin", "--show-scope", "--list"],
            capture_output=True, timeout=config.GIT_TIMEOUT_SEC,
            env={**os.environ, **NON_INTERACTIVE_ENV},
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    settings: dict[str, list[str | None]] = {}
    push_sources: dict[str, list[dict[str, str | None]]] = {}
    fields = proc.stdout.decode("utf-8", errors="replace").split("\0")[:-1]
    for scope, origin, record in zip(fields[::3], fields[1::3], fields[2::3], strict=True):
        key, separator, value = record.partition("\n")
        key = _config_key(key)
        section, _, rest = key.partition(".")
        name = rest.rsplit(".", 1)[-1]
        if (section == "branch" and name in ("remote", "pushremote", "merge")) or (section == "remote" and name in ("pushdefault", "push", "pushurl")) or key in ("push.default", "push.autosetupremote"):
            settings.setdefault(key, []).append(value if separator else None)
        if (section == "branch" and name in ("pushremote", "remote")) or key == "remote.pushdefault":
            push_sources.setdefault(key, []).append({"scope": scope, "origin": origin, "value": value if separator else None})
    return settings, push_sources


def _config_bool(value: str | None) -> bool | None:
    """Parse Git's boolean text and integer forms; None as input is a bare key."""
    if value is None or value.lower() in ("true", "yes", "on"):
        return True
    if value.lower() in ("false", "no", "off", ""):
        return False
    number = re.fullmatch(r"([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)", value.lstrip(" \t\n\r\v\f"))
    if number is None:
        return None
    sign, digits, unit = number.groups()
    base = 16 if digits.lower().startswith("0x") else 8 if digits.startswith("0") else 10
    parsed = int(("-" if sign == "-" else "") + digits, base) * (1024 ** ("kmg".index(unit.lower()) + 1) if unit else 1)
    return parsed != 0 if -(2 ** 31) <= parsed < 2 ** 31 else None


def branch_destinations_many(repo: str, branches: list[str]) -> dict[str, dict[str, Any] | None]:
    """Resolve a repository's branches using one config observation per batch."""
    observed = _branch_config_sources(repo)
    # Fetch refspecs can place tracking refs outside refs/remotes/.
    raw = _run(repo, ["for-each-ref", f"--format={_DESTINATION_REF_FORMAT}", "refs/"]) if observed is not None else None
    if observed is None or raw is None:
        return dict.fromkeys(branches)
    settings, push_sources = observed
    refs = {fields[0]: fields for fields in (line.split("\0") for line in raw.splitlines())}
    return {branch: _branch_destinations(repo, branch, settings, refs, push_sources) for branch in dict.fromkeys(branches)}


def branch_destinations(repo: str, branch: str) -> dict[str, Any] | None:
    return branch_destinations_many(repo, [branch])[branch]


_DESTINATION_REF_FORMAT = "%(refname)%00%(upstream)%00%(objectname)"


def _branch_destinations(repo: str, branch: str, settings: dict[str, list[str | None]], refs: dict[str, list[str]], push_sources: dict[str, list[dict[str, str | None]]]) -> dict[str, Any] | None:
    # Git resolves pushRemote/pushDefault/remote, refspecs and push.default.
    fields = refs.get(f"refs/heads/{branch}")
    if fields is None:
        return None
    def setting(key: str) -> str | None:
        values = settings.get(_config_key(key))
        # --get emits a bare key as an empty string; an absent key stays None.
        return (values[-1] if values[-1] is not None else "").strip() if values is not None else None

    def all_values(key: str) -> list[str] | None:
        values = settings.get(_config_key(key))
        # Preserve --get-all's handling of embedded newlines and empty values.
        return ("\n".join(value if value is not None else "" for value in values) + "\n").splitlines() if values is not None else None

    fetch_remote = setting(f"branch.{branch}.remote")
    if fetch_remote is None:
        remotes = _run(repo, ["remote"])
        if remotes is None:
            return None
        names = remotes.splitlines()
        fetch_remote = names[0] if len(names) == 1 else "origin" if "origin" in names else None
    push_default = setting("push.default")
    push_remote = None
    push_remote_key = None
    push_remote_keys = (f"branch.{branch}.pushRemote", "remote.pushDefault", f"branch.{branch}.remote")
    for key in push_remote_keys:
        candidate = setting(key)
        if candidate is not None:
            push_remote = candidate
            push_remote_key = key
            break
    if push_remote is None:
        remotes = _run(repo, ["remote"])
        if remotes is None:
            return None
        names = remotes.splitlines()
        push_remote = names[0] if len(names) == 1 else "origin" if "origin" in names else None
    merge = setting(f"branch.{branch}.merge")
    mode = "simple" if push_default is None else push_default
    refspecs = None
    if push_remote is not None:
        values = all_values(f"remote.{push_remote}.push")
        refspecs = values if values is not None else []
    auto_setup_values = settings.get("push.autosetupremote")
    auto_setup = _config_bool(auto_setup_values[-1]) if auto_setup_values is not None else False
    if auto_setup is None:
        return None
    push_refs = []
    push_reason = None
    push_command = "git push"
    source = f"refs/heads/{branch}"
    if refspecs:
        for spec in refspecs:
            spec = spec.removeprefix("+")
            if spec == ":":
                push_reason = "matching: リモートに同名ブランチがある場合に送信"
                continue
            src, separator, dst = spec.partition(":")
            if not separator or dst == "":
                dst = src
            if src in (source, branch):
                push_refs.append(dst if dst.startswith("refs/") else f"refs/heads/{dst}")
            elif "*" in src and "*" in dst:
                prefix, suffix = src.split("*", 1)
                if source.startswith(prefix) and source.endswith(suffix):
                    middle = source[len(prefix):len(source)-len(suffix) if suffix else None]
                    push_refs.append(dst.replace("*", middle))
            elif src == "HEAD":
                current = _run(repo, ["symbolic-ref", "-q", "HEAD"])
                if current is not None and current.strip() == source:
                    push_refs.append(source if dst == "HEAD" else dst if dst.startswith("refs/") else f"refs/heads/{dst}")
                else:
                    push_reason = "HEAD refspec: このworktreeのHEADは選択ブランチではありません"
        if not push_refs and push_reason is None:
            push_reason = "remote.push refspecにこのブランチの送信指定なし"
    elif push_remote is None:
        push_reason = "push remote未設定"
        push_command = shlex.join(["git", "config", "--show-origin", "--get-regexp", "^(branch\\.|remote\\.)"])
    elif mode == "nothing":
        push_reason = "push.default=nothing: 引数なしのpushは拒否"
        push_command = "git config --show-origin --get push.default"
    elif mode == "matching":
        push_reason = "matching: リモートに同名ブランチがある場合に送信"
    elif mode == "current" or (mode == "simple" and push_remote != fetch_remote):
        push_refs = [source]
    elif mode in ("upstream", "tracking", "simple"):
        merges = all_values(f"branch.{branch}.merge")
        if merge is None and auto_setup:
            push_refs = [source]
        elif merge is None or merges is None or len(merges) != 1:
            push_reason = "upstreamが一意に設定されていないためpushは拒否"
            push_command = shlex.join(["git", "config", "--show-origin", "--get-all", f"branch.{branch}.merge"])
        elif push_remote != fetch_remote:
            push_reason = "push先とupstream remoteが異なるためpushは拒否"
            push_command = shlex.join(["git", "config", "--show-origin", "--get-regexp", "^(branch\\.|remote\\.)"])
        elif mode == "simple" and merge != source:
            push_reason = "simple: upstreamとローカルの名前が異なるためpushは拒否"
            push_command = shlex.join(["git", "push", push_remote, f"HEAD:{merge}"])
        else:
            push_refs = [merge]
    else:
        push_reason = "push.defaultの値を解決できません"
        push_command = "git config --show-origin --get push.default"
    def urls(remote: str | None, push: bool) -> list[str] | None:
        if remote is None:
            return None
        if remote == ".":
            return ["."]
        value = _run(repo, ["remote", "get-url", *(["--push", "--all"] if push else []), "--", remote])
        return value.splitlines() if value is not None else None
    upstream = fields[1] or None
    tracking = refs.get(upstream) if upstream is not None else None
    upstream_head = tracking[2] if tracking is not None else None
    upstream_gone = upstream is not None and tracking is None
    push_remote_config = {
        "selected_key": push_remote_key,
        "keys": [
            {
                "key": key,
                "values": push_sources.get(_config_key(key), []),
                "command": shlex.join(["git", "-C", paths.to_host(repo), "config", "--show-origin", "--show-scope", "--get-all", key]),
            }
            for key in push_remote_keys
        ],
    }
    return {"fetch_remote": fetch_remote, "fetch_urls": urls(fetch_remote, False), "upstream": upstream, "upstream_ref": merge, "upstream_state": "unset" if merge is None else "configured", "upstream_head": upstream_head, "upstream_gone": upstream_gone, "push_remote": push_remote, "push_remote_config": push_remote_config, "push_urls": urls(push_remote, True), "push_ref": " / ".join(push_refs) if push_refs else None, "push_ref_reason": push_reason, "push_refspecs": refspecs, "push_default": mode, "push_next_command": {"command": push_command, "reason": push_reason if push_command != "git push" else "未 push のコミットがあります"}}


def collect(
    repo: str,
    fetch: bool = False,
    context: Mapping[str, Any] | None = None,
    *,
    fetch_status: dict[str, Any] | None = None,
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
    ``fetch_status`` accepts an already completed fetch so callers can keep
    network I/O outside their repository lock.
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

    # Verified discovery context is authoritative.  Git's common-dir result
    # fills only fields that were not supplied; a linked checkout alone cannot
    # distinguish an external .git parent from the actual main checkout.
    common_raw = _run(repo, ["rev-parse", "--git-common-dir"])
    if common_raw:
        common_git_dir = common_raw.strip()
        if not os.path.isabs(common_git_dir):
            common_git_dir = os.path.join(repo, common_git_dir)
        if layout is not None:
            # scanner.repo_layout distinguishes a linked worktree from a
            # normal repository using actual != common, including the
            # separate-git-dir case where .git is a pointer file.
            if "common_dir" not in context:
                resolved_common_dir = paths.to_host(layout.common_root)
            if "is_worktree" not in context:
                resolved_is_worktree = layout.is_worktree
        else:
            common_root = os.path.dirname(os.path.realpath(common_git_dir))
            if "common_dir" not in context:
                resolved_common_dir = paths.to_host(common_root)
            if "is_worktree" not in context:
                resolved_is_worktree = os.path.realpath(repo) != common_root

    fetched_at: float | None = None
    if fetch and config.FETCH_ENABLED:
        fetch_status = do_fetch(repo)
    if fetch_status is not None and fetch_status["result"] == "success":
        fetched_at = fetch_status["attempted_at"]

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
        "head": None,
        "detached": context_detached,
        "upstream": None,
        "ahead": 0,
        "behind": 0,
        "entries": [],
        "counts": [],
        "branch_line": "",
        "stashes": 0,
        "remote": None,
        "remote_status": "failed",
        "last_commit": None,
        "next_command": None,
        "can_ff": False,
        "diverged": False,
        "fetched_at": fetched_at,
        "fetch_status": fetch_status,
        "operations": operations(repo),
        "checked_at": time.time(),
    }

    status, error = _run_status(repo)
    if status is None:
        result["error"] = error
        result["branch_line"] = branch_line(result)
        result["next_command"] = next_command_without_status(resolved_worktree_state)
        return result

    info = _parse_status_v2(status)
    result.update(info)
    result["branch_line"] = branch_line(info)
    result["counts"] = count_by_code(info["entries"])
    result["can_ff"] = info["behind"] > 0 and info["ahead"] == 0
    result["diverged"] = info["behind"] > 0 and info["ahead"] > 0

    remote, remote_code = _run_with_status(repo, ["config", "--get", "remote.origin.url"])
    if remote_code == 0:
        result["remote"] = remote.strip()
        result["remote_status"] = "configured"
    elif remote_code == 1:
        result["remote_status"] = "unset"
    if result["operations"]:
        result["next_command"] = {"command": "git status", "reason": "進行中のGit操作と競合を確認します"}
    else:
        result["next_command"] = next_command(
            info,
            result["remote"],
            context,
            resolve_destinations=lambda: branch_destinations(repo, info["branch"]),
            can_switch_back=lambda: _can_switch_back(repo),
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
