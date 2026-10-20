"""Search committed text in one explicitly selected Git revision.

The operation is intentionally read only.  It resolves a moving ref to a
full commit id first and then searches that immutable tree with ``git grep``.
The grep invocation uses fixed strings, disables external grep and textconv,
and excludes binary files.  Both the amount of output read from Git and the
number of rows returned to the caller are bounded.
"""
from __future__ import annotations

import os
import re
import selectors
import subprocess
import time
from typing import Any

from app import config, gitinfo, repository_files


# A search is useful as an investigation aid, but an unrestricted result can
# make a repository with generated files overwhelm the API and browser.
MAX_MATCHES = 1_000
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_QUERY_LENGTH = 4_096
MAX_DIRECTORY_LENGTH = 4_096

_HASH_RE = re.compile(r"^[0-9a-f]{40,64}$")


class ContentSearchInputError(ValueError):
    """An explicit content-search input is invalid or unsafe."""


def _validate_repo(repo: str) -> str:
    if not isinstance(repo, str) or not repo or "\x00" in repo:
        raise ContentSearchInputError("repo は空でないリポジトリパスで指定してください")
    return repo


def _validate_query(query: str) -> str:
    if not isinstance(query, str) or not query or "\x00" in query:
        raise ContentSearchInputError("query は空でない文字列で指定してください")
    if len(query) > MAX_QUERY_LENGTH:
        raise ContentSearchInputError(f"query は{MAX_QUERY_LENGTH}文字以下で指定してください")
    return query


def _validate_directory(directory: str) -> str:
    if not isinstance(directory, str) or len(directory) > MAX_DIRECTORY_LENGTH:
        raise ContentSearchInputError(
            f"directory は{MAX_DIRECTORY_LENGTH}文字以下の相対パスで指定してください"
        )
    try:
        return repository_files.validate_directory(directory)
    except ValueError as error:
        raise ContentSearchInputError(str(error)) from error


def _resolve_revision(repo: str, revision: str) -> str | None:
    """Resolve a caller-supplied ref to one full commit id."""
    try:
        resolved = repository_files._resolve_revision(repo, revision)
    except ValueError as error:
        raise ContentSearchInputError(str(error)) from error
    if resolved is None or _HASH_RE.fullmatch(resolved) is None:
        return None
    return resolved.lower()


def _search_command(
    repo: str,
    pinned_hash: str,
    query: str,
    case_sensitive: bool,
    directory: str,
) -> list[str]:
    """Build a literal, revision-scoped Git grep command.

    ``-e`` keeps a query beginning with ``-`` as data.  The global
    ``--literal-pathspecs`` option makes the optional directory a literal Git
    path instead of a wildcard expression.
    """
    command = [
        gitinfo.GIT,
        "-C",
        repo,
        "--literal-pathspecs",
        "grep",
        "--no-ext-grep",
        "--no-textconv",
        "--fixed-strings",
        "--no-color",
        "--line-number",
        "--full-name",
        "--null",
        "-I",
    ]
    if not case_sensitive:
        command.append("--ignore-case")
    command.extend(["-e", query, pinned_hash, "--"])
    if directory:
        command.append(directory)
    return command


def _run_search(
    command: list[str],
) -> tuple[bytes, bool, int] | None:
    """Run Git with bounded stdout and return ``(output, truncated, status)``.

    The command is killed as soon as one byte beyond ``MAX_OUTPUT_BYTES`` is
    observed.  A timeout, failed process setup, or failed wait is a Git fault
    and returns ``None``.  ``git grep`` status 1 is retained for the caller to
    distinguish a valid no-match search from an operational error.
    """
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    truncated = False
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC

    def stop_process() -> None:
        if process is None:
            return
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                **os.environ,
                **gitinfo.NON_INTERACTIVE_ENV,
                # Searching an immutable tree does not need to refresh or
                # lock the index.  Keep this guarantee explicit in case Git
                # changes an optimization in a future release.
                "GIT_OPTIONAL_LOCKS": "0",
            },
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(command, config.GIT_TIMEOUT_SEC)
            read_size = min(64 * 1024, MAX_OUTPUT_BYTES + 1 - len(output))
            if read_size <= 0:
                read_size = 1
            chunk = os.read(process.stdout.fileno(), read_size)
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_OUTPUT_BYTES:
                truncated = True
                output = output[:MAX_OUTPUT_BYTES]
                stop_process()
                return bytes(output), True, 0

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(command, config.GIT_TIMEOUT_SEC)
        status = process.wait(timeout=remaining)
        return bytes(output), truncated, status
    except (OSError, subprocess.TimeoutExpired):
        stop_process()
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _parse_matches(raw: bytes, pinned_hash: str) -> list[dict[str, Any]] | None:
    """Parse ``git grep --null --line-number`` output.

    With a tree object, Git prefixes each path with ``<tree>:``, then emits a
    NUL after the path and line number, and a newline after the matching text.
    Parsing those delimiters directly keeps tabs, spaces, backslashes, and
    actual newlines in repository paths intact.
    """
    prefix = f"{pinned_hash}:".encode("ascii")
    matches: list[dict[str, Any]] = []
    position = 0
    length = len(raw)
    while position < length:
        path_end = raw.find(b"\x00", position)
        if path_end < 0:
            # A bounded read may end in the middle of a row.  The caller
            # decides whether that is expected from the truncation flag.
            break
        line_start = path_end + 1
        line_end = raw.find(b"\x00", line_start)
        if line_end < 0:
            break
        text_start = line_end + 1
        text_end = raw.find(b"\n", text_start)
        if text_end < 0:
            break

        header = raw[position:path_end]
        line_bytes = raw[line_start:line_end]
        if not header.startswith(prefix):
            return None
        path_bytes = header[len(prefix):]
        if not path_bytes or not line_bytes.isdigit():
            return None
        try:
            line = int(line_bytes.decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            return None
        if line < 1:
            return None
        try:
            path = path_bytes.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            # A Git path may contain bytes that cannot be represented in the
            # JSON API.  Replacement is deterministic and keeps the search
            # result bounded; the path remains a display-only locator.
            path = path_bytes.decode("utf-8", errors="replace")
        text = raw[text_start:text_end].decode("utf-8", errors="replace")
        matches.append({"path": path, "line": line, "text": text})
        position = text_end + 1
    return matches


def get_content_search(
    repo: str,
    revision: str,
    query: str,
    case_sensitive: bool,
    directory: str,
) -> dict[str, Any] | None:
    """Return literal text matches in one pinned Git revision.

    Every input is required, including ``case_sensitive`` and ``directory``;
    callers pass an empty directory explicitly to search the whole tree.
    Input errors raise :class:`ContentSearchInputError` (a ``ValueError``).
    A Git fault returns ``None``.  A successful search with no matches returns
    a normal response with an empty ``matches`` list.
    """
    _validate_repo(repo)
    _validate_query(query)
    if not isinstance(case_sensitive, bool):
        raise ContentSearchInputError("case_sensitive はtrueまたはfalseで指定してください")
    normalized_directory = _validate_directory(directory)
    pinned_hash = _resolve_revision(repo, revision)
    if pinned_hash is None:
        return None

    command = _search_command(
        repo,
        pinned_hash,
        query,
        case_sensitive,
        normalized_directory,
    )
    result = _run_search(command)
    if result is None:
        return None
    raw, output_truncated, status = result
    if status not in {0, 1}:
        return None
    matches = _parse_matches(raw, pinned_hash)
    if matches is None:
        return None

    truncated = output_truncated or len(matches) > MAX_MATCHES
    if len(matches) > MAX_MATCHES:
        matches = matches[:MAX_MATCHES]
    return {
        "revision": revision,
        "pinned_hash": pinned_hash,
        "query": query,
        "case_sensitive": case_sensitive,
        "directory": normalized_directory,
        "matches": matches,
        "truncated": truncated,
        "limit": MAX_MATCHES,
        "byte_limit": MAX_OUTPUT_BYTES,
    }


__all__ = [
    "MAX_DIRECTORY_LENGTH",
    "MAX_MATCHES",
    "MAX_OUTPUT_BYTES",
    "MAX_QUERY_LENGTH",
    "ContentSearchInputError",
    "get_content_search",
]
