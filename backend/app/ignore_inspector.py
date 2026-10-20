"""Read-only inspection of Git's ignore rules.

The inspector asks Git for both the ignored-file inventory and the winning
rule for explicit candidate paths.  It never opens a checkout path or an
ignore file itself.  All path values are passed through NUL-delimited Git
interfaces, so whitespace, newlines, and shell metacharacters remain data.
"""
from __future__ import annotations

import ntpath
import os
import posixpath
import re
import selectors
import subprocess
import time
from typing import Any

from app import config, gitinfo


# The inventory is useful as a bounded view, rather than a second filesystem
# browser.  Keep both limits explicit so a repository with many long paths
# cannot create an unbounded response.
MAX_INVENTORY_ENTRIES = 1_000
MAX_INVENTORY_BYTES = 1_048_576

# The candidate UI presents one path per line.  The API keeps the same hard
# count while allowing an individual path to contain a newline.
MAX_CHECK_PATHS = 100
MAX_PATH_LENGTH = 4_096
MAX_CHECK_INPUT_BYTES = 1_048_576
MAX_RULE_OUTPUT_BYTES = 4 * 1_048_576


class IgnoreInspectorInputError(ValueError):
    """An explicit ignore-inspector input is invalid or exceeds its bound."""


class IgnoreInspectorGitError(LookupError):
    """Git returned output that cannot be interpreted as this contract."""


def validate_path(path: str) -> str:
    """Validate one repository-relative path without normalising it.

    Git paths can contain spaces, tabs, newlines, leading punctuation, and
    trailing spaces.  Keep those spellings intact, while rejecting values
    that could escape a repository or alter the NUL-delimited protocol.
    """
    if not isinstance(path, str) or not path or "\x00" in path:
        raise IgnoreInspectorInputError("path は空でない相対パスで指定してください")
    if len(path) > MAX_PATH_LENGTH:
        raise IgnoreInspectorInputError(f"path は{MAX_PATH_LENGTH}文字以下で指定してください")
    if posixpath.isabs(path) or ntpath.isabs(path):
        raise IgnoreInspectorInputError("path に絶対パスは指定できません")
    if any(part == ".." for part in re.split(r"[/\\]", path)):
        raise IgnoreInspectorInputError("path に親ディレクトリ参照は指定できません")
    if path in {".", "./", ".\\"}:
        raise IgnoreInspectorInputError("path はファイルの相対パスで指定してください")
    return path


def _validate_paths(paths: list[str], *, limit: int) -> list[str]:
    if not isinstance(paths, list):
        raise IgnoreInspectorInputError("paths は配列で指定してください")
    if len(paths) == 0:
        raise IgnoreInspectorInputError("paths を1件以上指定してください")
    if len(paths) > limit:
        raise IgnoreInspectorInputError(f"paths は{limit}件以下で指定してください")
    values = [validate_path(path) for path in paths]
    encoded_size = sum(len(path.encode("utf-8", errors="strict")) + 1 for path in values)
    if encoded_size > MAX_CHECK_INPUT_BYTES:
        raise IgnoreInspectorInputError(
            f"paths の入力は{MAX_CHECK_INPUT_BYTES}バイト以下で指定してください"
        )
    return values


def _environment() -> dict[str, str]:
    # GIT_OPTIONAL_LOCKS=0 prevents a read-only command from refreshing the
    # index and writing an index.lock while another operation is in progress.
    return {
        **os.environ,
        **gitinfo.NON_INTERACTIVE_ENV,
        "GIT_OPTIONAL_LOCKS": "0",
    }


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _read_bounded(
    command: list[str],
    *,
    max_bytes: int,
    allow_returncodes: frozenset[int] = frozenset({0}),
) -> tuple[bytes, int] | None:
    """Read stdout with a hard byte bound and a Git timeout."""
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=_environment(),
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        while len(output) <= max_bytes:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            chunk = os.read(
                process.stdout.fileno(),
                min(64 * 1024, max_bytes + 1 - len(output)),
            )
            if not chunk:
                break
            output.extend(chunk)
        if len(output) > max_bytes:
            _terminate(process)
            return None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
        returncode = process.wait(timeout=remaining)
        if returncode not in allow_returncodes:
            return None
        return bytes(output), returncode
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            _terminate(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _inventory_paths(repo: str) -> tuple[list[str], bool] | None:
    command = [
        gitinfo.GIT,
        "--no-optional-locks",
        "-C",
        repo,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
    ]
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    pending = bytearray()
    paths: list[str] = []
    bytes_seen = 0
    truncated = False
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC

    def consume() -> bool:
        nonlocal truncated
        while True:
            try:
                end = pending.index(0)
            except ValueError:
                return False
            record = bytes(pending[:end])
            del pending[: end + 1]
            if not record:
                continue
            if len(paths) >= MAX_INVENTORY_ENTRIES:
                truncated = True
                return True
            paths.append(record.decode("utf-8", errors="replace"))

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=_environment(),
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            chunk = os.read(
                process.stdout.fileno(),
                min(64 * 1024, MAX_INVENTORY_BYTES + 1 - bytes_seen),
            )
            if not chunk:
                break
            bytes_seen += len(chunk)
            pending.extend(chunk)
            record_limit_hit = consume()
            if bytes_seen > MAX_INVENTORY_BYTES or record_limit_hit:
                truncated = True
                _terminate(process)
                break
        if not truncated:
            if pending:
                # Git's -z contract must end each path with NUL.  Returning a
                # partial path would make the inventory appear authoritative.
                return None
            if process.wait(timeout=max(0.0, deadline - time.monotonic())) != 0:
                return None
        return paths, truncated
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        if process is not None:
            _terminate(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _wire_path(path: str) -> str:
    """Avoid check-ignore's ``:(magic)`` parser for a literal leading colon."""
    return f"./{path}" if path.startswith(":") else path


def _canonical_git_path(path: str) -> str:
    """Match Git's pathspec spelling while retaining the caller's path."""
    canonical = posixpath.normpath(path)
    return "" if canonical == "." else canonical


def _read_check_output(command: list[str], stdin: bytes) -> tuple[bytes, int] | None:
    """Feed check-ignore while bounding both sides of its pipe."""
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    offset = 0
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=_environment(),
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("git pipes are unavailable")
        os.set_blocking(process.stdin.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            events = selector.select(remaining)
            if not events:
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            for key, mask in events:
                if key.data == "stdin" and mask & selectors.EVENT_WRITE:
                    if offset >= len(stdin):
                        selector.unregister(process.stdin)
                        process.stdin.close()
                    else:
                        try:
                            written = os.write(process.stdin.fileno(), stdin[offset:])
                        except BrokenPipeError:
                            selector.unregister(process.stdin)
                            process.stdin.close()
                        else:
                            offset += written
                elif key.data == "stdout" and mask & selectors.EVENT_READ:
                    chunk = os.read(key.fileobj.fileno(), min(64 * 1024, MAX_RULE_OUTPUT_BYTES + 1 - len(output)))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    else:
                        output.extend(chunk)
                        if len(output) > MAX_RULE_OUTPUT_BYTES:
                            _terminate(process)
                            return None
            if not selector.get_map():
                break
        returncode = process.wait(timeout=max(0.0, deadline - time.monotonic()))
        if returncode not in {0, 1}:
            return None
        return bytes(output), returncode
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            _terminate(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()


def _parse_rule_pattern(pattern: str | None) -> tuple[bool | None, bool]:
    """Return (negation, ignored) for Git's winning pattern field."""
    if pattern is None:
        return None, False
    # A leading backslash quotes a literal exclamation mark.  Only an
    # unescaped first ``!`` is a negation rule.
    negation = pattern.startswith("!")
    return negation, not negation


def _check_rules(repo: str, paths: list[str], *, max_paths: int) -> list[dict[str, Any]] | None:
    values = _validate_paths(paths, limit=max_paths)
    wire_paths = [_wire_path(path) for path in values]
    stdin = b"".join(path.encode("utf-8") + b"\x00" for path in wire_paths)
    command = [
        gitinfo.GIT,
        "--no-optional-locks",
        "-C",
        repo,
        "check-ignore",
        "-v",
        "-z",
        "--stdin",
        "--no-index",
        "--non-matching",
        "--",
    ]
    # check-ignore rejects the global --literal-pathspecs switch itself.  Its
    # NUL stdin mode treats ordinary wildcard characters as path data; only a
    # leading colon needs the ./ representation above.  Paths are mapped back
    # to their exact caller spelling in the returned rows.
    result = _read_check_output(command, stdin)
    if result is None:
        return None
    output, _ = result

    fields = output.split(b"\x00")
    if fields and fields[-1] == b"":
        fields.pop()
    if len(fields) != len(values) * 4:
        return None
    rows: list[dict[str, Any]] = []
    for index, path in enumerate(values):
        offset = index * 4
        source_raw, line_raw, pattern_raw, echoed_raw = fields[offset:offset + 4]
        try:
            source = source_raw.decode("utf-8", errors="replace") or None
            line_text = line_raw.decode("ascii")
            pattern = pattern_raw.decode("utf-8", errors="replace") or None
            echoed = echoed_raw.decode("utf-8", errors="replace")
        except UnicodeError:
            return None
        expected_echo = wire_paths[index]
        if echoed != expected_echo:
            return None
        if source is None:
            line = None
        elif not re.fullmatch(r"[0-9]+", line_text):
            return None
        else:
            line = int(line_text)
        negation, ignored = _parse_rule_pattern(pattern)
        rows.append(
            {
                "path": path,
                "ignored": ignored,
                "source": source,
                "line": line,
                "pattern": pattern,
                "negation": negation,
            }
        )
    return rows


def _tracked_paths(repo: str, paths: list[str]) -> set[str] | None:
    """Return exact index paths, keeping Git pathspecs literal and bounded."""
    values = _validate_paths(paths, limit=MAX_CHECK_PATHS)
    command = [
        gitinfo.GIT,
        "--no-optional-locks",
        "--literal-pathspecs",
        "-C",
        repo,
        "ls-files",
        "-z",
        "--",
        *values,
    ]
    result = _read_bounded(command, max_bytes=MAX_CHECK_INPUT_BYTES)
    if result is None:
        return None
    raw, _ = result
    if raw and not raw.endswith(b"\x00"):
        return None
    records = [record for record in raw.split(b"\x00") if record]
    try:
        return {
            _canonical_git_path(record.decode("utf-8", errors="replace"))
            for record in records
        }
    except UnicodeError:
        return None


def _with_tracked(repo: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    tracked = _tracked_paths(repo, [row["path"] for row in rows])
    if tracked is None:
        return None
    return [
        {**row, "tracked": _canonical_git_path(row["path"]) in tracked}
        for row in rows
    ]


def check_ignore(repo: str, paths: list[str]) -> dict[str, Any] | None:
    """Diagnose the winning ignore rule for each explicit candidate path."""
    values = _validate_paths(paths, limit=MAX_CHECK_PATHS)
    rows = _check_rules(repo, values, max_paths=MAX_CHECK_PATHS)
    if rows is None:
        return None
    with_tracked = _with_tracked(repo, rows)
    if with_tracked is None:
        return None
    return {
        "results": with_tracked,
        "count": len(with_tracked),
        "path_limit": MAX_CHECK_PATHS,
        "command": "git check-ignore -v -z --stdin --no-index --non-matching",
    }


def inventory_ignored(repo: str) -> dict[str, Any] | None:
    """Return ignored, untracked paths and their winning rule metadata."""
    inventory = _inventory_paths(repo)
    if inventory is None:
        return None
    paths, truncated = inventory
    if not paths:
        return {
            "entries": [],
            "count": 0,
            "truncated": truncated,
            "entry_limit": MAX_INVENTORY_ENTRIES,
            "byte_limit": MAX_INVENTORY_BYTES,
            "command": "git ls-files --others --ignored --exclude-standard -z",
        }
    # Keep one bounded request for the complete inventory prefix.  Inventory
    # rows are known to be ignored and untracked from ls-files; rule metadata
    # comes from Git's check-ignore response and is allowed to be null only for
    # an explicit no-rule result.
    rules = _check_rules(repo, paths, max_paths=MAX_INVENTORY_ENTRIES)
    if rules is None:
        return None
    entries = [
        {
            **row,
            "ignored": True,
            "tracked": False,
        }
        for row in rules
    ]
    return {
        "entries": entries,
        "count": len(entries),
        "truncated": truncated,
        "entry_limit": MAX_INVENTORY_ENTRIES,
        "byte_limit": MAX_INVENTORY_BYTES,
        "command": "git ls-files --others --ignored --exclude-standard -z",
    }


__all__ = [
    "MAX_CHECK_INPUT_BYTES",
    "MAX_CHECK_PATHS",
    "MAX_INVENTORY_BYTES",
    "MAX_INVENTORY_ENTRIES",
    "MAX_PATH_LENGTH",
    "IgnoreInspectorGitError",
    "IgnoreInspectorInputError",
    "check_ignore",
    "inventory_ignored",
    "validate_path",
]
