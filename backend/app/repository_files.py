"""Read-only browsing of the files stored in an explicit Git revision.

This module deliberately works with Git objects rather than the checkout on
disk.  A repository can have several worktrees, a dirty checkout, or a
symlink which points outside the repository; none of those facts should
change what a revision file browser returns.

The public functions require every investigation input explicitly.  A
revision is resolved to a full commit id before any tree or blob is read so
the response remains tied to one immutable snapshot even when a branch moves
while the browser is open.
"""
from __future__ import annotations

import base64
import ntpath
import os
import posixpath
import re
import selectors
import subprocess
import time
from typing import Any

from app import config, gitinfo


# Keep the inventory response bounded.  The browser searches the complete
# inventory returned by this function and tells the user when Git had more
# entries than the response can safely contain.
MAX_TREE_ENTRIES = 10_000

# The entry cap limits the JSON response, while this byte cap also limits the
# amount of raw ``ls-tree`` output retained when a repository contains very
# long paths.  The stream reader below stops Git as soon as either cap is
# exceeded.  Keep this independent from the blob cap: inventory metadata and
# file contents have different workloads.
MAX_TREE_BYTES = 16 * 1024 * 1024

# A download is allowed only when the full blob fits in this limit.  The same
# bounded read is used for the preview response so a large object cannot be
# accidentally presented as a complete downloadable file.
MAX_BLOB_BYTES = 1_048_576

_HASH_RE = re.compile(r"^[0-9a-f]{40,64}$")
_DECIMAL_RE = re.compile(r"^[0-9]+$")
_MAX_REVISION_LENGTH = 512


class RepositoryFilesInputError(ValueError):
    """An explicit revision browser input is invalid or unsafe."""


class RepositoryFilesNotFound(LookupError):
    """A requested versioned file does not exist in the pinned tree."""


def validate_file_path(file: str) -> str:
    """Validate one repository-relative Git path without normalising it.

    Git permits spaces, tabs, newlines, and many punctuation characters in a
    path.  Preserve those bytes as supplied while rejecting values that could
    escape the repository or be interpreted as a pathspec.  Backslash
    traversal is rejected as well so the same API contract remains safe on a
    Windows host.
    """
    if not isinstance(file, str) or not file or "\x00" in file:
        raise RepositoryFilesInputError("file は空でない相対パスで指定してください")
    if posixpath.isabs(file) or ntpath.isabs(file):
        raise RepositoryFilesInputError("file に絶対パスは指定できません")
    if any(part == ".." for part in re.split(r"[/\\]", file)):
        raise RepositoryFilesInputError("file に親ディレクトリ参照は指定できません")
    if file in {".", "./"}:
        raise RepositoryFilesInputError("file はファイルの相対パスで指定してください")
    return file


def validate_directory(directory: str) -> str:
    """Validate a repository-relative directory used by the inventory UI."""
    if not isinstance(directory, str) or "\x00" in directory:
        raise RepositoryFilesInputError("directory は相対ディレクトリで指定してください")
    if directory in {"", "."}:
        return ""
    if posixpath.isabs(directory) or ntpath.isabs(directory):
        raise RepositoryFilesInputError("directory に絶対パスは指定できません")
    if any(part in {"", ".", ".."} for part in re.split(r"[/\\]", directory)):
        raise RepositoryFilesInputError("directory は正規化済みの相対パスで指定してください")
    return directory.rstrip("/")


def _validate_revision(revision: str) -> str:
    """Validate one single Git ref/hash before invoking Git."""
    if not isinstance(revision, str) or not revision or "\x00" in revision:
        raise RepositoryFilesInputError("revision は空でない値で指定してください")
    if len(revision) > _MAX_REVISION_LENGTH:
        raise RepositoryFilesInputError("revision が長すぎます")
    # Even though --end-of-options is passed below, rejecting option-like and
    # expression-like values keeps the endpoint contract explicit.  A caller
    # can provide a named ref or a complete object id, not a revision range or
    # a path suffix.
    if revision.startswith("-") or any(
        character.isspace() or ord(character) < 0x20 for character in revision
    ):
        raise RepositoryFilesInputError("revision はハッシュまたはGit refで指定してください")
    if any(operator in revision for operator in ("..", "~", "^", ":", "@{")):
        raise RepositoryFilesInputError("revision は単一のコミットハッシュまたはGit refで指定してください")
    return revision


def _resolve_revision(repo: str, revision: str) -> str | None:
    """Resolve an explicit revision to an immutable full commit id."""
    value = _validate_revision(revision)
    raw = gitinfo._run(
        repo,
        ["rev-parse", "--verify", "--end-of-options", f"{value}^{{commit}}"],
    )
    if raw is None:
        return None
    resolved = raw.strip()
    return resolved.lower() if _HASH_RE.fullmatch(resolved) else None


def _parse_ls_tree(raw: str) -> list[dict[str, str]] | None:
    """Parse NUL-delimited ``git ls-tree`` output without path quoting."""
    entries: list[dict[str, str]] = []
    for record in raw.split("\x00"):
        if not record:
            continue
        try:
            metadata, path = record.split("\t", 1)
        except ValueError:
            return None
        fields = metadata.split(" ")
        if len(fields) != 3:
            return None
        mode, object_type, object_hash = fields
        if not mode or not object_type or _HASH_RE.fullmatch(object_hash) is None or not path:
            return None
        entries.append(
            {
                "path": path,
                "mode": mode,
                "type": object_type,
                "hash": object_hash.lower(),
            }
        )
    return entries


def _parse_ls_tree_record_bytes(record: bytes) -> dict[str, str] | None:
    """Parse one complete NUL-delimited ls-tree record without buffering all output."""
    try:
        metadata, path_bytes = record.split(b"\t", 1)
        mode_bytes, type_bytes, hash_bytes = metadata.split(None, 2)
        mode = mode_bytes.decode("ascii", errors="strict")
        object_type = type_bytes.decode("ascii", errors="strict")
        object_hash = hash_bytes.decode("ascii", errors="strict").lower()
        # Git paths are byte strings.  The public API is JSON, so retain all
        # valid UTF-8 exactly and use replacement only for an unrepresentable
        # byte sequence rather than rejecting the entire inventory.
        path = path_bytes.decode("utf-8", errors="replace")
    except (UnicodeDecodeError, ValueError):
        return None
    if not mode or not object_type or not path or _HASH_RE.fullmatch(object_hash) is None:
        return None
    return {"path": path, "mode": mode, "type": object_type, "hash": object_hash}


def _tree(repo: str, pinned_hash: str) -> tuple[list[dict[str, str]], bool] | None:
    """Read a bounded revision tree, including directory entries.

    ``git ls-tree`` can emit one record per path and a path can be several
    kilobytes long.  Reading it through ``gitinfo._run`` would therefore let a
    large repository allocate an unbounded response before the caller sliced
    it.  This reader keeps at most one pipe chunk plus one incomplete record,
    and kills Git after the first record beyond the entry limit or after the
    byte limit is crossed.
    """
    command = [
        gitinfo.GIT,
        "-C",
        repo,
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-t",
        "-z",
        "--full-tree",
        pinned_hash,
        "--",
    ]
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    pending = bytearray()
    entries: list[dict[str, str]] = []
    bytes_seen = 0
    truncated = False
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + config.GIT_TIMEOUT_SEC

        def consume_records() -> bool:
            """Consume complete records, returning whether entry cap was hit."""
            nonlocal truncated
            while True:
                try:
                    end = pending.index(0)
                except ValueError:
                    return False
                record = bytes(pending[:end])
                del pending[:end + 1]
                if not record:
                    continue
                parsed = _parse_ls_tree_record_bytes(record)
                if parsed is None:
                    raise ValueError("malformed ls-tree record")
                if len(entries) >= MAX_TREE_ENTRIES:
                    truncated = True
                    return True
                entries.append(parsed)

        while True:
            remaining_bytes = MAX_TREE_BYTES - bytes_seen
            # One byte beyond the cap tells us whether the output actually
            # continues.  Only bytes within the cap are added to ``pending``
            # and can become response entries.
            read_size = min(64 * 1024, max(1, remaining_bytes + 1))
            remaining_time = deadline - time.monotonic()
            if remaining_time <= 0 or not selector.select(remaining_time):
                raise subprocess.TimeoutExpired(command, config.GIT_TIMEOUT_SEC)
            chunk = os.read(process.stdout.fileno(), read_size)
            if not chunk:
                break
            before = bytes_seen
            bytes_seen += len(chunk)
            allowed = max(0, MAX_TREE_BYTES - before)
            if allowed:
                pending.extend(chunk[:allowed])
                if consume_records():
                    break
            if len(chunk) > allowed:
                truncated = True
                break

        if truncated:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=1)
            return entries, True
        if pending:
            # A successful ls-tree stream is NUL terminated.  Treat an
            # incomplete record as a Git parse failure rather than silently
            # returning a partial path.
            raise ValueError("unterminated ls-tree record")
        remaining_time = deadline - time.monotonic()
        if remaining_time <= 0 or process.wait(timeout=remaining_time) != 0:
            return None
        return entries, False
    except (OSError, ValueError, subprocess.TimeoutExpired):
        if process is not None and process.poll() is None:
            process.kill()
        if process is not None:
            try:
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def list_files(repo: str, revision: str) -> dict[str, Any] | None:
    """Return a bounded flat inventory for one explicit revision.

    The inventory includes both ``tree`` directory entries and leaf entries
    such as ``blob`` and ``commit`` (gitlink) objects.  Consumers can derive a
    directory tree and search all retrieved paths without another Git call.
    ``None`` means the revision or Git operation could not be resolved; input
    validation errors are raised as :class:`RepositoryFilesInputError`.
    """
    pinned_hash = _resolve_revision(repo, revision)
    if pinned_hash is None:
        return None
    tree = _tree(repo, pinned_hash)
    if tree is None:
        return None
    entries, truncated = tree
    return {
        "revision": revision,
        "pinned_hash": pinned_hash,
        "entries": entries,
        "truncated": truncated,
        "limit": MAX_TREE_ENTRIES,
        "byte_limit": MAX_TREE_BYTES,
    }


def _parse_single_tree_entry(raw: str, expected_path: str) -> dict[str, str] | None:
    entries = _parse_ls_tree(raw)
    if entries is None:
        return None
    exact = [entry for entry in entries if entry["path"] == expected_path]
    if len(exact) != 1:
        return None
    return exact[0]


def _find_file(repo: str, pinned_hash: str, file: str) -> dict[str, str] | None:
    """Resolve one literal path to the object recorded in the tree."""
    raw = gitinfo._run(
        repo,
        [
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            "--full-tree",
            pinned_hash,
            "--",
            file,
        ],
    )
    return _parse_single_tree_entry(raw, file) if raw is not None else None


def _object_size(repo: str, object_hash: str) -> int | None:
    raw = gitinfo._run(repo, ["cat-file", "-s", object_hash])
    if raw is None:
        return None
    value = raw.strip()
    if _DECIMAL_RE.fullmatch(value) is None:
        return None
    return int(value)


def _read_blob_limited(repo: str, object_hash: str, limit: int) -> tuple[bytes, bool] | None:
    """Read at most ``limit`` bytes from an object while preserving bytes."""
    proc: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        proc = subprocess.Popen(
            [gitinfo.GIT, "-C", repo, "cat-file", "blob", object_hash],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
        if proc.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        output = bytearray()
        deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
        # Read in bounded chunks so a multi-gigabyte blob cannot be buffered.
        while len(output) <= limit:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(proc.args, config.GIT_TIMEOUT_SEC)
            chunk = os.read(proc.stdout.fileno(), min(64 * 1024, limit + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
        truncated = len(output) > limit
        if truncated:
            proc.kill()
            proc.wait(timeout=1)
            return bytes(output[:limit]), True
        remaining = deadline - time.monotonic()
        if remaining <= 0 or proc.wait(timeout=remaining) != 0:
            return None
        return bytes(output), False
    except (OSError, subprocess.TimeoutExpired):
        if proc is not None and proc.poll() is None:
            proc.kill()
        if proc is not None:
            try:
                proc.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass
        return None
    finally:
        if selector is not None:
            selector.close()
        if proc is not None and proc.stdout is not None:
            proc.stdout.close()


def _text_value(data: bytes, truncated: bool = False) -> tuple[str | None, bool]:
    """Decode only strict UTF-8 text and reject NUL-containing blobs."""
    if b"\x00" in data:
        return None, True
    try:
        return data.decode("utf-8", errors="strict"), False
    except UnicodeDecodeError:
        if truncated:
            # The bounded prefix can end in the middle of a three or four
            # byte code point.  Trim only that incomplete suffix; an invalid
            # byte earlier in the prefix still keeps the blob binary.
            for end in range(len(data) - 1, max(-1, len(data) - 5), -1):
                try:
                    return data[:end].decode("utf-8", errors="strict"), False
                except UnicodeDecodeError:
                    continue
        return None, True


def get_file(repo: str, revision: str, file: str) -> dict[str, Any] | None:
    """Return bounded content and metadata for one versioned repository path.

    ``content_base64`` is always the exact prefix read from Git, with a
    ``truncated`` flag when the object is larger than ``MAX_BLOB_BYTES``.
    A caller may download only responses where ``downloadable`` is true; that
    flag is never true for a partial object, symlink, or gitlink.
    """
    validate_file_path(file)
    pinned_hash = _resolve_revision(repo, revision)
    if pinned_hash is None:
        return None
    entry = _find_file(repo, pinned_hash, file)
    if entry is None:
        raise RepositoryFilesNotFound("指定したrevisionにファイルがありません")

    object_type = entry["type"]
    mode = entry["mode"]
    if object_type not in {"blob", "commit"}:
        raise RepositoryFilesNotFound("指定したパスはファイルではありません")
    size = _object_size(repo, entry["hash"])
    if size is None:
        return None

    # A gitlink is a commit object, not a file.  Report it explicitly without
    # trying to resolve or read a nested repository.
    if mode == "160000" or object_type == "commit":
        return {
            "revision": revision,
            "pinned_hash": pinned_hash,
            "path": file,
            "hash": entry["hash"],
            "mode": mode,
            "type": "commit",
            "kind": "gitlink",
            "size": size,
            "binary": True,
            "text": None,
            "content_base64": "",
            "truncated": False,
            "downloadable": False,
            "download_limit": MAX_BLOB_BYTES,
        }

    blob = _read_blob_limited(repo, entry["hash"], MAX_BLOB_BYTES)
    if blob is None:
        return None
    data, truncated = blob
    text, binary = _text_value(data, truncated)
    symlink = mode == "120000"
    return {
        "revision": revision,
        "pinned_hash": pinned_hash,
        "path": file,
        "hash": entry["hash"],
        "mode": mode,
        "type": "blob",
        "kind": "symlink" if symlink else "blob",
        "size": size,
        "binary": binary,
        "text": text,
        "content_base64": base64.b64encode(data).decode("ascii"),
        "truncated": truncated,
        "downloadable": not symlink and not truncated and size <= MAX_BLOB_BYTES,
        "download_limit": MAX_BLOB_BYTES,
    }


__all__ = [
    "MAX_BLOB_BYTES",
    "MAX_TREE_BYTES",
    "MAX_TREE_ENTRIES",
    "RepositoryFilesInputError",
    "RepositoryFilesNotFound",
    "get_file",
    "list_files",
    "validate_directory",
    "validate_file_path",
]
