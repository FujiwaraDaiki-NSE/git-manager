"""Read per-path Git object sizes from one immutable tree.

The size reported here is the size of the object referenced by each path in
the selected revision.  It is deliberately a path inventory: the same blob
referenced by two paths is counted twice, while a gitlink has no file-content
size and is reported as ``None``.  No checkout, symlink target, pack file, or
object database maintenance operation is inspected.
"""
from __future__ import annotations

import os
import re
import selectors
import subprocess
import time
from typing import Any

from app import config, gitinfo, repository_files


# These limits bound both the response and the amount of ls-tree output held
# while the process is streamed.  Keep the names public so callers/tests can
# tune the limits for a controlled repository without changing the parser.
MAX_TREE_ENTRIES = 10_000
MAX_TREE_OUTPUT_BYTES = 4 * 1024 * 1024
# Alias used by code/tests that describe the cap as a tree byte limit.
MAX_TREE_BYTES = MAX_TREE_OUTPUT_BYTES
# Short aliases follow the naming used by the other bounded Git inventories.
MAX_ENTRIES = MAX_TREE_ENTRIES
MAX_OUTPUT_BYTES = MAX_TREE_OUTPUT_BYTES

_HASH_RE = re.compile(r"^[0-9a-f]{40,64}$")
_DECIMAL_RE = re.compile(r"^[0-9]+$")


def _parse_ls_tree_record_bytes(record: bytes) -> dict[str, Any] | None:
    """Parse one NUL-delimited ``git ls-tree -r -l`` record.

    ``ls-tree`` emits ``mode type hash size<TAB>path`` in long format.  The
    size field is ``-`` for a commit object (the tree's gitlink entry), so it
    is intentionally converted to ``None`` instead of guessing a nested
    repository size.  Git path bytes are decoded only at the JSON boundary;
    replacement decoding preserves the record and never changes the command
    sent to Git.
    """
    try:
        metadata, path_bytes = record.split(b"\t", 1)
        fields = metadata.split()
        if len(fields) != 4:
            return None
        mode_bytes, type_bytes, hash_bytes, size_bytes = fields
        mode = mode_bytes.decode("ascii", errors="strict")
        object_type = type_bytes.decode("ascii", errors="strict")
        object_hash = hash_bytes.decode("ascii", errors="strict").lower()
        size_value = size_bytes.decode("ascii", errors="strict")
        path = path_bytes.decode("utf-8", errors="replace")
    except (UnicodeDecodeError, ValueError):
        return None
    if not mode or not object_type or not path or _HASH_RE.fullmatch(object_hash) is None:
        return None
    if size_value == "-":
        size: int | None = None
    elif _DECIMAL_RE.fullmatch(size_value) is not None:
        size = int(size_value)
    else:
        return None
    return {
        "path": path,
        "mode": mode,
        "type": object_type,
        "hash": object_hash,
        "size": size,
    }


def _stream_tree(repo: str, pinned_hash: str) -> tuple[list[dict[str, Any]], bool] | None:
    """Stream a bounded recursive tree, stopping Git at the first limit.

    A normal ``subprocess.run(..., capture_output=True)`` would retain all
    output before slicing it.  This reader keeps only the current incomplete
    record and records already accepted under the caps, then kills Git as
    soon as a subsequent record or output byte proves truncation.
    """
    command = [
        gitinfo.GIT,
        "-C",
        repo,
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-l",
        "-z",
        "--full-tree",
        pinned_hash,
        "--",
    ]
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    pending = bytearray()
    entries: list[dict[str, Any]] = []
    bytes_seen = 0
    truncated = False
    entry_limit = min(MAX_TREE_ENTRIES, MAX_ENTRIES)
    output_limit = min(MAX_TREE_OUTPUT_BYTES, MAX_TREE_BYTES, MAX_OUTPUT_BYTES)

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
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + config.GIT_TIMEOUT_SEC

        def consume_records() -> bool:
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
                parsed = _parse_ls_tree_record_bytes(record)
                if parsed is None:
                    raise ValueError("malformed ls-tree record")
                if len(entries) >= entry_limit:
                    truncated = True
                    return True
                entries.append(parsed)

        while True:
            remaining_bytes = output_limit - bytes_seen
            # One byte beyond the cap lets us distinguish an exact-size
            # successful stream from output that really continues.  The
            # extra byte is never retained in ``pending``.
            read_size = min(64 * 1024, max(1, remaining_bytes + 1))
            remaining_time = deadline - time.monotonic()
            if remaining_time <= 0 or not selector.select(remaining_time):
                raise subprocess.TimeoutExpired(command, config.GIT_TIMEOUT_SEC)
            chunk = os.read(process.stdout.fileno(), read_size)
            if not chunk:
                break
            before = bytes_seen
            bytes_seen += len(chunk)
            allowed = max(0, output_limit - before)
            if allowed:
                pending.extend(chunk[:allowed])
                if consume_records():
                    break
            if len(chunk) > allowed:
                truncated = True
                break

        if truncated:
            stop_process()
            return entries, True
        if pending:
            # Successful -z output ends at a NUL.  An incomplete record means
            # Git failed or the stream was corrupted, not a safe partial.
            raise ValueError("unterminated ls-tree record")
        remaining_time = deadline - time.monotonic()
        if remaining_time <= 0 or process.wait(timeout=remaining_time) != 0:
            return None
        return entries, False
    except (OSError, ValueError, subprocess.TimeoutExpired):
        stop_process()
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def get_tree_sizes(repo: str, revision: str) -> dict[str, Any] | None:
    """Return bounded path sizes for one explicitly pinned Git revision.

    ``revision`` is validated and resolved by the existing revision browser
    resolver before the tree is read.  ``None`` means the revision or Git
    operation could not be read; invalid input raises the same ``ValueError``
    family used by the repository-files endpoint.
    """
    pinned_hash = repository_files._resolve_revision(repo, revision)
    if pinned_hash is None:
        return None
    streamed = _stream_tree(repo, pinned_hash)
    if streamed is None:
        return None
    entries, truncated = streamed
    total_bytes = sum(entry["size"] for entry in entries if entry["size"] is not None)
    unknown_size_count = sum(1 for entry in entries if entry["size"] is None)
    return {
        "revision": revision,
        "pinned_hash": pinned_hash,
        "entries": entries,
        "total_bytes": total_bytes,
        "file_count": len(entries),
        "unknown_size_count": unknown_size_count,
        "truncated": truncated,
        "limit": min(MAX_TREE_ENTRIES, MAX_ENTRIES),
        "byte_limit": min(MAX_TREE_OUTPUT_BYTES, MAX_TREE_BYTES, MAX_OUTPUT_BYTES),
    }


__all__ = [
    "MAX_TREE_BYTES",
    "MAX_TREE_ENTRIES",
    "MAX_TREE_OUTPUT_BYTES",
    "MAX_ENTRIES",
    "MAX_OUTPUT_BYTES",
    "get_tree_sizes",
]
