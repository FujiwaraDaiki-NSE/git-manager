"""Read-only, line-oriented attribution for one Git revision and path.

The public operation is deliberately explicit: callers provide a repository,
revision, file, and one-based inclusive line range.  The revision is pinned to
its full object id before the tree and blob are inspected, so the response
cannot silently move when a branch advances while the request is running.

Only committed regular UTF-8 blobs are supported.  Symlinks, gitlinks, binary
objects, and paths that Git cannot resolve are rejected before ``git blame``
is run.  No checkout path is opened; all file inspection is done through Git
objects.
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


MAX_LINES = 1_000
# Descriptive aliases keep the cap discoverable to the API adapter and tests.
MAX_BLAME_LINES = MAX_LINES
MAX_LINES_PER_REQUEST = MAX_LINES
# A line count cap does not bound a single line.  Probe the committed object
# size before reading it, then keep the porcelain response bounded as well.
MAX_BLOB_BYTES = 2 * 1024 * 1024
MAX_BLAME_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_BLOB_SIZE_BYTES = MAX_BLOB_BYTES
MAX_OUTPUT_BYTES = MAX_BLAME_OUTPUT_BYTES
_HASH_RE = re.compile(r"^[0-9a-f]{40,64}$")
_REVISION_MAX_LENGTH = 512
_HEADER_RE = re.compile(
    r"^(?P<commit>[0-9a-f]{40,64}) (?P<original>[0-9]+) "
    r"(?P<final>[0-9]+)(?: (?P<count>[0-9]+))?$"
)
_TIME_RE = re.compile(r"^-?[0-9]+$")


class BlameInputError(ValueError):
    """An explicit blame input is invalid or exceeds the endpoint limit."""


class BlameUnsupportedError(BlameInputError):
    """The requested Git object is not a regular text file."""


class BlameGitError(LookupError):
    """Git could not produce a valid attribution for the requested range."""


def validate_file_path(file: str) -> str:
    """Validate a repository-relative path without normalising its spelling.

    Spaces, tabs, newlines, and leading/trailing whitespace are valid Git path
    bytes and are returned exactly as supplied.  Absolute paths and traversal
    components are rejected before any Git command is started.
    """
    if not isinstance(file, str) or not file or "\x00" in file:
        raise BlameInputError("file は空でない相対パスで指定してください")
    if posixpath.isabs(file) or ntpath.isabs(file):
        raise BlameInputError("file に絶対パスは指定できません")
    if any(part == ".." for part in re.split(r"[/\\]", file)):
        raise BlameInputError("file に親ディレクトリ参照は指定できません")
    if file in {".", "./"}:
        raise BlameInputError("file はファイルの相対パスで指定してください")
    return file


def _validate_revision(revision: str) -> str:
    if not isinstance(revision, str) or not revision or "\x00" in revision:
        raise BlameInputError("revision は空でない値で指定してください")
    if len(revision) > _REVISION_MAX_LENGTH:
        raise BlameInputError("revision が長すぎます")
    return revision


def _validate_range(start: int, end: int) -> tuple[int, int]:
    # bool is an int subclass, but a JSON true/false is not a line number.
    if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int):
        raise BlameInputError("start と end は1以上の整数で指定してください")
    if start < 1 or end < 1:
        raise BlameInputError("start と end は1以上の整数で指定してください")
    if end < start:
        raise BlameInputError("end は start 以上で指定してください")
    if end - start + 1 > MAX_LINES:
        raise BlameInputError(f"1回に取得できる行数は{MAX_LINES}行以下です")
    return start, end


def _resolve_revision(repo: str, revision: str) -> str | None:
    value = _validate_revision(revision)
    raw = gitinfo._run(
        repo,
        ["rev-parse", "--verify", "--end-of-options", f"{value}^{{commit}}"],
    )
    if raw is None:
        return None
    pinned = raw.strip().lower()
    return pinned if _HASH_RE.fullmatch(pinned) else None


def _run_bytes(repo: str, args: list[str]) -> tuple[bytes, bytes, int] | None:
    """Run a read-only Git command while retaining raw NUL/path bytes."""
    try:
        process = subprocess.run(
            [gitinfo.GIT, "-C", repo, *args],
            capture_output=True,
            timeout=config.GIT_TIMEOUT_SEC,
            # Git's optional index refresh can update ``.git/index`` even for
            # a read-only command.  Disable that write path for every blame
            # probe and attribution command.
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return process.stdout, process.stderr, process.returncode


def _run_bytes_limited(
    repo: str,
    args: list[str],
    max_bytes: int,
) -> tuple[bytes, int] | None:
    """Run Git while consuming at most ``max_bytes`` of stdout.

    ``subprocess.run(capture_output=True)`` is intentionally not used for
    blobs or blame output: one committed line can be arbitrarily long even
    when the requested line count is small.  stderr is discarded because the
    caller returns a stable user-facing error rather than exposing Git's
    environment-dependent diagnostics.
    """
    if max_bytes < 1:
        raise ValueError("max_bytes must be positive")
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()

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
            [gitinfo.GIT, "-C", repo, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV, "GIT_OPTIONAL_LOCKS": "0"},
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
        while True:
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
                stop_process()
                raise BlameUnsupportedError(
                    f"Gitの出力が大きすぎるため行帰属に対応できません（上限{max_bytes}バイト）"
                )

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
        returncode = process.wait(timeout=remaining)
        return bytes(output), returncode
    except BlameUnsupportedError:
        raise
    except (OSError, subprocess.TimeoutExpired):
        stop_process()
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _tree_entry(repo: str, pinned_hash: str, file: str) -> dict[str, str] | None:
    """Resolve one literal path to the exact tree entry at ``pinned_hash``."""
    try:
        path_bytes = file.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise BlameInputError("file はUTF-8で指定してください") from error
    result = _run_bytes(
        repo,
        [
            "-c",
            "core.quotepath=false",
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            "--full-tree",
            pinned_hash,
            "--",
            file,
        ],
    )
    if result is None:
        raise BlameGitError("Gitのファイル一覧を取得できませんでした")
    output, _error, returncode = result
    if returncode != 0:
        raise BlameGitError("指定したファイルをGitのリビジョンから取得できませんでした")

    matches: list[dict[str, str]] = []
    for record in output.split(b"\x00"):
        if not record:
            continue
        try:
            metadata, path = record.split(b"\t", 1)
            mode, object_type, object_hash = metadata.split(None, 2)
        except ValueError as error:
            raise BlameGitError("Gitのファイル情報を解釈できませんでした") from error
        if path != path_bytes or not _HASH_RE.fullmatch(object_hash.decode("ascii", errors="ignore")):
            continue
        matches.append(
            {
                "mode": mode.decode("ascii", errors="replace"),
                "type": object_type.decode("ascii", errors="replace"),
                "hash": object_hash.decode("ascii").lower(),
                "path": file,
            }
        )
    if len(matches) != 1:
        return None
    return matches[0]


def _object_size(repo: str, object_hash: str) -> int | None:
    """Read a blob's size without reading the blob itself."""
    raw = gitinfo._run(repo, ["cat-file", "-s", object_hash])
    if raw is None:
        return None
    value = raw.strip()
    if not value.isdecimal():
        return None
    return int(value)


def _probe_text_blob(repo: str, object_hash: str) -> None:
    """Read a bounded committed blob and reject binary or invalid UTF-8."""
    size = _object_size(repo, object_hash)
    if size is None:
        raise BlameGitError("Gitのファイルサイズを取得できませんでした")
    if size > MAX_BLOB_BYTES:
        raise BlameUnsupportedError(
            f"ファイルが大きすぎるため行帰属に対応していません（上限{MAX_BLOB_BYTES}バイト）"
        )
    result = _run_bytes_limited(repo, ["cat-file", "blob", object_hash], MAX_BLOB_BYTES)
    if result is None:
        raise BlameGitError("Gitのファイル内容を取得できませんでした")
    output, returncode = result
    if returncode != 0:
        raise BlameGitError("Gitのファイル内容を取得できませんでした")
    if b"\x00" in output:
        raise BlameUnsupportedError("バイナリファイルの行帰属には対応していません")
    try:
        output.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise BlameUnsupportedError("UTF-8ではないバイナリファイルの行帰属には対応していません") from error


def _decode_git_quoted_path(value: str) -> str:
    """Decode Git's C-quoted ``filename`` field without losing UTF-8 bytes."""
    if len(value) < 2 or value[0] != '"' or value[-1] != '"':
        return value

    encoded = bytearray()
    index = 1
    end = len(value) - 1
    simple = {
        "a": 0x07,
        "b": 0x08,
        "t": 0x09,
        "n": 0x0A,
        "v": 0x0B,
        "f": 0x0C,
        "r": 0x0D,
        "e": 0x1B,
        "\\": 0x5C,
        '"': 0x22,
        "?": 0x3F,
    }
    while index < end:
        character = value[index]
        if character != "\\":
            encoded.extend(character.encode("utf-8"))
            index += 1
            continue
        index += 1
        if index >= end:
            raise BlameGitError("Gitのファイル名エスケープを解釈できませんでした")
        escaped = value[index]
        if escaped in simple:
            encoded.append(simple[escaped])
            index += 1
            continue
        if escaped not in "01234567":
            raise BlameGitError("Gitのファイル名エスケープを解釈できませんでした")
        digits = escaped
        index += 1
        while index < end and len(digits) < 3 and value[index] in "01234567":
            digits += value[index]
            index += 1
        encoded.append(int(digits, 8))
    try:
        return bytes(encoded).decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise BlameGitError("Gitのファイル名をUTF-8として解釈できませんでした") from error


def _parse_blame(raw: str, expected_lines: int, start: int) -> list[dict[str, Any]]:
    """Parse ``--line-porcelain`` while preserving content tabs verbatim."""
    records: list[dict[str, Any]] = []
    # Split only on Git's LF record separator.  ``str.splitlines`` also
    # treats vertical tab/form feed as a line break, although those bytes are
    # valid content in a committed text blob and must remain part of the row.
    physical_lines = raw.split("\n")
    if physical_lines and physical_lines[-1] == "":
        physical_lines.pop()
    index = 0
    while index < len(physical_lines):
        header = physical_lines[index]
        match = _HEADER_RE.fullmatch(header)
        if match is None:
            raise BlameGitError("git blame の行ヘッダーを解釈できませんでした")
        index += 1
        metadata: dict[str, str] = {}
        content: str | None = None
        while index < len(physical_lines):
            metadata_line = physical_lines[index]
            if metadata_line.startswith("\t"):
                content = metadata_line[1:]
                index += 1
                break
            key, separator, value = metadata_line.partition(" ")
            if not separator:
                value = ""
            if key == "filename":
                metadata[key] = _decode_git_quoted_path(value)
            else:
                metadata[key] = value
            index += 1
        if content is None:
            raise BlameGitError("git blame の行内容を取得できませんでした")

        commit = match.group("commit")
        original = int(match.group("original"))
        final = int(match.group("final"))
        author_time = metadata.get("author-time", "")
        if not _TIME_RE.fullmatch(author_time):
            raise BlameGitError("git blame の時刻を解釈できませんでした")
        if not metadata.get("author") or "summary" not in metadata or "filename" not in metadata:
            raise BlameGitError("git blame のコミット情報が不足しています")
        author_mail = metadata.get("author-mail", "")
        email = author_mail[1:-1] if len(author_mail) >= 2 and author_mail[0] == "<" and author_mail[-1] == ">" else author_mail
        records.append(
            {
                "original_line": original,
                "final_line": final,
                "commit": commit,
                "author": metadata["author"],
                "email": email,
                "time": int(author_time),
                "content": content,
                "summary": metadata["summary"],
                "path": metadata["filename"],
            }
        )

    if len(records) != expected_lines:
        raise BlameGitError("指定した行範囲の行帰属を完全には取得できませんでした")
    expected_final = list(range(start, start + expected_lines))
    if [record["final_line"] for record in records] != expected_final:
        raise BlameGitError("git blame の行番号が指定範囲と一致しません")
    return records


def get_blame(
    repo: str,
    revision: str,
    file: str,
    start: int,
    end: int,
) -> dict[str, Any] | None:
    """Return immutable line attribution for one explicit revision/file range.

    ``None`` is reserved for a Git process that could not be started or whose
    revision could not be resolved.  Input errors, unsupported objects, and a
    range that Git rejects are raised explicitly so an API route cannot turn
    them into an apparently empty successful response.
    """
    validate_file_path(file)
    start, end = _validate_range(start, end)
    pinned_hash = _resolve_revision(repo, revision)
    if pinned_hash is None:
        return None

    entry = _tree_entry(repo, pinned_hash, file)
    if entry is None:
        raise BlameGitError("指定したファイルがリビジョンに存在しません")
    if entry["mode"] == "120000":
        raise BlameUnsupportedError("シンボリックリンクの行帰属には対応していません")
    if entry["mode"] == "160000" or entry["type"] == "commit":
        raise BlameUnsupportedError("Gitリンクの行帰属には対応していません")
    if entry["type"] != "blob":
        raise BlameUnsupportedError("通常のファイル以外の行帰属には対応していません")
    _probe_text_blob(repo, entry["hash"])

    result = _run_bytes_limited(
        repo,
        [
            "-c",
            "core.quotepath=false",
            "--literal-pathspecs",
            "blame",
            "--line-porcelain",
            "--no-textconv",
            "--encoding=UTF-8",
            "-L",
            f"{start},{end}",
            pinned_hash,
            "--",
            file,
        ],
        MAX_BLAME_OUTPUT_BYTES,
    )
    if result is None:
        return None
    output, returncode = result
    if returncode != 0:
        raise BlameGitError("指定した行範囲をgit blameで取得できませんでした")
    try:
        decoded = output.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise BlameGitError("git blame の出力をUTF-8として解釈できませんでした") from error
    lines = _parse_blame(decoded, end - start + 1, start)
    return {
        "revision": revision,
        "pinned_hash": pinned_hash,
        "source_file": file,
        "start": start,
        "end": end,
        "lines": lines,
    }


__all__ = [
    "MAX_BLOB_BYTES",
    "MAX_BLOB_SIZE_BYTES",
    "MAX_BLAME_LINES",
    "MAX_BLAME_OUTPUT_BYTES",
    "MAX_LINES",
    "MAX_LINES_PER_REQUEST",
    "MAX_OUTPUT_BYTES",
    "BlameGitError",
    "BlameInputError",
    "BlameUnsupportedError",
    "get_blame",
    "validate_file_path",
]
