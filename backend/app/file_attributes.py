"""Read-only Git EOL and attribute inspection.

This module deliberately asks Git for the facts it owns.  It never opens a
checkout path or an attributes file directly, and every Git invocation keeps
optional locks disabled so a status/inspection request cannot refresh the
index as a side effect.
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


MAX_INVENTORY_ENTRIES = 1_000
MAX_ATTRIBUTE_PATHS = 100
MAX_INPUT_BYTES = 1 * 1024 * 1024
MAX_OUTPUT_BYTES = 1 * 1024 * 1024
MAX_PATH_LENGTH = 4_096

_EOL_VALUES = frozenset({"lf", "crlf", "mixed", "none", "-text", "?"})
_EOL_ATTRIBUTE_RE = re.compile(r"(?:^|\s)eol=([^\s]+)(?:$|\s)")
_PATH_SPLIT_RE = re.compile(r"[/\\]")


class FileAttributesError(ValueError):
    """An explicit file-attribute input or bounded Git result is invalid."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class AttributeOutputTooLarge(FileAttributesError):
    """The complete attribute response cannot fit in the output bound."""

    def __init__(self) -> None:
        super().__init__(
            "attributes_output_too_large",
            "Git属性の結果が大きすぎるため、部分結果を表示できません",
        )


def _git_command(repo: str, args: list[str]) -> list[str]:
    """Build one literal, non-mutating Git command."""
    return [
        gitinfo.GIT,
        "--no-optional-locks",
        "--literal-pathspecs",
        "-C",
        repo,
        *args,
    ]


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _run_bounded_output(repo: str, args: list[str], *, limit: int) -> bytes | None:
    """Read stdout with a hard bound, without retaining unbounded Git output."""
    if limit < 1:
        raise ValueError("limit must be positive")
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
    try:
        process = subprocess.Popen(
            _git_command(repo, args),
            stdin=subprocess.PIPE if "--stdin" in args else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                **os.environ,
                **gitinfo.NON_INTERACTIVE_ENV,
                "GIT_OPTIONAL_LOCKS": "0",
            },
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        if process.stdin is not None:
            # The caller has already encoded the explicit path list into the
            # command argument list only when this helper is not used.  A
            # stdin command is supplied through ``_run_attribute_output``.
            process.stdin.close()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        while len(output) <= limit:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            chunk = os.read(
                process.stdout.fileno(),
                min(64 * 1024, limit + 1 - len(output)),
            )
            if not chunk:
                break
            output.extend(chunk)
        if len(output) > limit:
            _terminate_process(process)
            raise FileAttributesError(
                "git_output_too_large",
                "Gitの結果が大きすぎるため、完全な調査結果を取得できません",
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
        return bytes(output)
    except FileAttributesError:
        raise
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            _terminate_process(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()


def _run_inventory_output(repo: str) -> bytes | None:
    """Run ``ls-files --eol -z`` with no checkout file reads."""
    return _run_bounded_output(repo, ["ls-files", "--eol", "-z"], limit=MAX_OUTPUT_BYTES)


def _run_attribute_output(repo: str, paths: list[str], mode: str) -> bytes | None:
    """Run check-attr for one explicit NUL-delimited path batch."""
    args = ["check-attr"]
    if mode == "index":
        args.append("--cached")
    args.extend(["--all", "-z", "--stdin"])
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
    encoded_paths = "".join(f"{path}\0" for path in paths).encode("utf-8", errors="surrogateescape")
    input_offset = 0
    input_closed = False
    output_closed = False
    try:
        process = subprocess.Popen(
            _git_command(repo, args),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                **os.environ,
                **gitinfo.NON_INTERACTIVE_ENV,
                "GIT_OPTIONAL_LOCKS": "0",
            },
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("git stdio is unavailable")
        # Both streams are non-blocking.  ``check-attr --all`` can emit a
        # large response for each path, so writing the whole batch before
        # reading stdout would deadlock once either pipe fills.
        os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        selector.register(process.stdin, selectors.EVENT_WRITE)

        def close_input() -> None:
            nonlocal input_closed
            if input_closed:
                return
            try:
                selector.unregister(process.stdin)  # type: ignore[arg-type]
            except (KeyError, ValueError):
                pass
            try:
                process.stdin.close()
            except OSError:
                pass
            input_closed = True

        while not output_closed:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            events = selector.select(remaining)
            if not events:
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            for key, mask in events:
                if key.fileobj is process.stdout and mask & selectors.EVENT_READ:
                    try:
                        chunk = os.read(process.stdout.fileno(), 64 * 1024)
                    except BlockingIOError:
                        chunk = None
                    except OSError:
                        _terminate_process(process)
                        return None
                    if chunk == b"":
                        try:
                            selector.unregister(process.stdout)
                        except (KeyError, ValueError):
                            pass
                        output_closed = True
                    elif chunk is not None:
                        if len(output) + len(chunk) > MAX_OUTPUT_BYTES:
                            _terminate_process(process)
                            raise AttributeOutputTooLarge()
                        output.extend(chunk)
                elif key.fileobj is process.stdin and mask & selectors.EVENT_WRITE:
                    if input_offset >= len(encoded_paths):
                        close_input()
                        continue
                    try:
                        written = os.write(
                            process.stdin.fileno(),
                            encoded_paths[input_offset : input_offset + 64 * 1024],
                        )
                    except BlockingIOError:
                        continue
                    except (BrokenPipeError, OSError):
                        close_input()
                        continue
                    input_offset += written
                    if input_offset >= len(encoded_paths):
                        close_input()
        close_input()
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
        return bytes(output)
    except AttributeOutputTooLarge:
        raise
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            _terminate_process(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()


def _decode(value: bytes) -> str:
    return value.decode("utf-8", errors="replace")


def _validate_relative_path(path: str) -> str:
    if not isinstance(path, str) or not path or "\x00" in path:
        raise FileAttributesError(
            "invalid_path",
            "paths には空でない相対パスを指定してください",
        )
    if len(path) > MAX_PATH_LENGTH:
        raise FileAttributesError("invalid_path", "path が長すぎます")
    if posixpath.isabs(path) or ntpath.isabs(path):
        raise FileAttributesError("invalid_path", "path に絶対パスは指定できません")
    if any(part == ".." for part in _PATH_SPLIT_RE.split(path)):
        raise FileAttributesError("invalid_path", "path に親ディレクトリ参照は指定できません")
    if path in {".", "./", ".\\"}:
        raise FileAttributesError("invalid_path", "path はファイルの相対パスで指定してください")
    return path


def _parse_eol_field(value: str) -> str:
    """Return Git's eolinfo token without replacing an unknown fact."""
    if value in _EOL_VALUES:
        return value
    # New Git versions may add an eolinfo token.  Preserve the raw fact so
    # the UI can report it rather than calling a new value "good" or "bad".
    return value or "?"


def _attribute_eol(value: str) -> str | None:
    match = _EOL_ATTRIBUTE_RE.search(value)
    return match.group(1) if match else None


def _eol_flags(index_eol: str, worktree_eol: str) -> list[str]:
    flags: list[str] = []
    if index_eol == "mixed" or worktree_eol == "mixed":
        flags.append("mixed")
    if index_eol == "?" or worktree_eol == "?":
        flags.append("unknown")
    if index_eol != worktree_eol:
        flags.append("different")
    return flags


def _parse_inventory(raw: bytes) -> tuple[list[dict[str, Any]], bool] | None:
    if raw and not raw.endswith(b"\x00"):
        return None
    records = [record for record in raw.split(b"\x00") if record]
    truncated = len(records) > MAX_INVENTORY_ENTRIES
    entries: list[dict[str, Any]] = []
    for record in records[: MAX_INVENTORY_ENTRIES + 1]:
        separator = record.find(b"\t")
        if separator <= 0:
            return None
        header = _decode(record[:separator])
        path = _decode(record[separator + 1 :])
        fields = header.split(None, 2)
        if len(fields) != 3:
            return None
        if not fields[0].startswith("i/") or not fields[1].startswith("w/") or not fields[2].startswith("attr/"):
            return None
        index_eol = _parse_eol_field(fields[0][2:])
        worktree_eol = _parse_eol_field(fields[1][2:])
        # Git pads the attr column to a fixed width.  The padding is display
        # formatting, not an attribute value, so remove only trailing spaces;
        # path whitespace remains untouched because it was split separately.
        attributes = fields[2][5:].rstrip()
        flags = _eol_flags(index_eol, worktree_eol)
        entry = {
            "path": path,
            "index_eol": index_eol,
            "worktree_eol": worktree_eol,
            "attributes": attributes,
            "attribute_eol": _attribute_eol(attributes),
            "flags": flags,
            "eol_status": (
                "mixed"
                if "mixed" in flags
                else "unknown"
                if "unknown" in flags
                else "different"
                if "different" in flags
                else "same"
            ),
        }
        # Keep the Git field vocabulary available alongside the descriptive
        # names used by the UI.  These are the same facts, never inferred
        # fallbacks or values from another mode.
        entry.update({
            "index": index_eol,
            "worktree": worktree_eol,
            "attr": attributes,
            "eol_attr": entry["attribute_eol"],
        })
        entries.append(entry)
        if len(entries) > MAX_INVENTORY_ENTRIES:
            entries.pop()
            break
    return entries, truncated


def get_eol_inventory(repo: str) -> dict[str, Any] | None:
    """Return a bounded tracked-file EOL inventory from Git's index/worktree."""
    raw = _run_inventory_output(repo)
    if raw is None:
        return None
    parsed = _parse_inventory(raw)
    if parsed is None:
        return None
    entries, truncated = parsed
    return {
        "entries": entries,
        "count": len(entries),
        "truncated": truncated,
        "limit": MAX_INVENTORY_ENTRIES,
        "entry_limit": MAX_INVENTORY_ENTRIES,
        "byte_limit": MAX_OUTPUT_BYTES,
        "command": "git ls-files --eol -z",
    }


def _parse_attributes(raw: bytes, paths: list[str]) -> list[dict[str, Any]] | None:
    if raw and not raw.endswith(b"\x00"):
        return None
    tokens = raw.split(b"\x00")
    if tokens and tokens[-1] == b"":
        tokens.pop()
    if len(tokens) % 3 != 0:
        return None
    requested = set(paths)
    by_path: dict[str, dict[str, str]] = {path: {} for path in paths}
    for index in range(0, len(tokens), 3):
        path = _decode(tokens[index])
        attribute = _decode(tokens[index + 1])
        value = _decode(tokens[index + 2])
        if path not in requested or not attribute:
            return None
        by_path[path][attribute] = value
    return [{"path": path, "attributes": dict(by_path[path])} for path in paths]


def _attribute_command(mode: str) -> str:
    command = "git check-attr"
    if mode == "index":
        command += " --cached"
    return command + " --all --stdin"


def inspect_attributes(repo: str, paths: list[str], mode: str) -> dict[str, Any] | None:
    """Inspect effective attributes for explicit paths in one Git mode.

    ``worktree`` follows the current working-tree attributes, while ``index``
    uses the staged ``.gitattributes`` via ``--cached``.  A path with no
    records from ``check-attr --all`` receives an explicit empty mapping; no
    attribute value is inferred from a sibling path or from the other mode.
    """
    if not isinstance(mode, str) or mode not in {"worktree", "index"}:
        raise FileAttributesError(
            "invalid_mode",
            "mode は worktree または index のいずれかで指定してください",
        )
    if not isinstance(paths, list):
        raise FileAttributesError("invalid_paths", "paths は配列で指定してください")
    if len(paths) == 0:
        raise FileAttributesError("invalid_paths", "paths を1件以上指定してください")
    if len(paths) > MAX_ATTRIBUTE_PATHS:
        raise FileAttributesError(
            "too_many_paths",
            f"一度に調べられるパスは{MAX_ATTRIBUTE_PATHS}件以下です",
        )
    validated = [_validate_relative_path(path) for path in paths]
    input_bytes = sum(len(path.encode("utf-8", errors="strict")) + 1 for path in validated)
    if input_bytes > MAX_INPUT_BYTES:
        raise FileAttributesError(
            "input_too_large",
            "paths の入力が大きすぎます",
        )
    raw = _run_attribute_output(repo, validated, mode)
    if raw is None:
        return None
    entries = _parse_attributes(raw, validated)
    if entries is None:
        return None
    return {
        "mode": mode,
        "paths": list(validated),
        "entries": entries,
        "count": len(entries),
        "limit": MAX_ATTRIBUTE_PATHS,
        "path_limit": MAX_ATTRIBUTE_PATHS,
        "byte_limit": MAX_OUTPUT_BYTES,
        "command": _attribute_command(mode),
    }
