"""Read-only inspection of the unmerged entries in a Git index.

The conflict inspector deliberately treats the index as its authority.  A
stage endpoint may receive an object id from a previous inventory, but it is
allowed to read that object only after the same path and stage still point to
the exact id in the current index.  This prevents the endpoint from becoming
an arbitrary object reader while a merge is being changed by another
process.

All Git output is read through bounded pipes.  The inventory is NUL-delimited
so paths containing whitespace, newlines, tabs, glob characters, or leading
punctuation remain data.  The module never opens a checkout path and never
changes the index or working tree.
"""
from __future__ import annotations

import base64
import hashlib
import json
import ntpath
import os
import posixpath
import re
import selectors
import shlex
import subprocess
import time
from typing import Any

from app import config, gitinfo


# A response may describe at most this many conflict paths.  The byte bound
# applies to raw ``ls-files`` output, before JSON encoding or path decoding.
MAX_CONFLICT_FILES = 1_000
MAX_INVENTORY_BYTES = 4 * 1_048_576
MAX_BLOB_BYTES = 1_048_576
MAX_PATCH_BYTES = 200_000
MAX_PATH_LENGTH = 4_096

_HASH_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$", re.IGNORECASE)
_MODE_RE = re.compile(r"^[0-7]{6}$")
_SIZE_RE = re.compile(r"^[0-9]+$")
_STAGES = (1, 2, 3)
_STAGE_NAMES = {1: "base", 2: "ours", 3: "theirs"}
_REGULAR_MODES = {"100644", "100755"}


class ConflictInspectorInputError(ValueError):
    """An explicit conflict-inspector input is invalid."""

    code = "invalid_conflict_input"
    status_code = 422


class ConflictChangedError(ValueError):
    """The current index no longer matches the requested conflict snapshot."""

    code = "conflict_changed"
    status_code = 409


# Keep the descriptive alias available to callers that use the older name.
SnapshotChangedError = ConflictChangedError


class ConflictInspectorGitError(LookupError):
    """Git returned an output that cannot establish the requested snapshot."""

    code = "conflict_git_error"


def validate_file_path(file: str) -> str:
    """Validate a repository-relative path without normalising its spelling."""
    if not isinstance(file, str) or not file or "\x00" in file:
        raise ConflictInspectorInputError("file は空でない相対パスで指定してください")
    if len(file) > MAX_PATH_LENGTH:
        raise ConflictInspectorInputError(f"file は{MAX_PATH_LENGTH}文字以下で指定してください")
    if posixpath.isabs(file) or ntpath.isabs(file):
        raise ConflictInspectorInputError("file に絶対パスは指定できません")
    if any(part == ".." for part in re.split(r"[/\\]", file)):
        raise ConflictInspectorInputError("file に親ディレクトリ参照は指定できません")
    if file in {".", "./", ".\\"}:
        raise ConflictInspectorInputError("file はファイルの相対パスで指定してください")
    return file


def _validate_hash(value: str, name: str) -> str:
    if not isinstance(value, str) or "\x00" in value or _HASH_RE.fullmatch(value) is None:
        raise ConflictInspectorInputError(f"{name} は完全なGitオブジェクトhashで指定してください")
    return value.lower()


def _validate_stage(stage: int) -> int:
    # ``bool`` is an ``int`` subclass, but it is not a stage identifier.
    if isinstance(stage, bool) or not isinstance(stage, int) or stage not in _STAGES:
        raise ConflictInspectorInputError("stage は1（BASE）、2（OURS）、3（THEIRS）のいずれかです")
    return stage


def _environment() -> dict[str, str]:
    # Read-only inspection must not refresh the index while another Git
    # operation is writing it, and Git must never ask for interactive input.
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


def _git_command(repo: str, *args: str) -> list[str]:
    return [gitinfo.GIT, "--no-optional-locks", "-C", repo, *args]


def _index_marker(repo: str) -> tuple[str, int, int, int] | None:
    """Return a cheap mutation marker for the current worktree index.

    The stage hashes are the public snapshot identity.  The index marker also
    catches an intervening write that changes the index and then restores the
    same stage hashes (an ABA sequence) while a blob or diff is being read.
    Only metadata is inspected; the index file is never opened by this
    module.
    """
    result = _read_limited_output(_git_command(repo, "rev-parse", "--git-path", "index"), max_bytes=4_096)
    if result is None:
        return None
    raw, truncated = result
    if truncated:
        return None
    try:
        index_path = raw.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        return None
    if not index_path:
        return None
    if not os.path.isabs(index_path):
        index_path = os.path.join(repo, index_path)
    try:
        stat = os.stat(index_path, follow_symlinks=False)
    except OSError:
        return None
    return (os.path.realpath(index_path), stat.st_mtime_ns, stat.st_size, stat.st_ino)


def _read_limited_output(
    command: list[str],
    *,
    max_bytes: int,
) -> tuple[bytes, bool] | None:
    """Read stdout up to ``max_bytes`` and report whether it was truncated."""
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
            chunk = os.read(process.stdout.fileno(), min(64 * 1024, max_bytes + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
        if len(output) > max_bytes:
            _terminate(process)
            return bytes(output[:max_bytes]), True
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
        return bytes(output), False
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            _terminate(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _batch_object_info(repo: str, hashes: list[str]) -> dict[str, dict[str, Any]] | None:
    """Resolve known index object ids to type and size with bounded pipes.

    ``cat-file --batch-check`` is used only after ids came from
    ``ls-files --unmerged``.  Both sides of the pipe are non-blocking because
    a large inventory can fill stdout before all request hashes are written.
    """
    unique_hashes = list(dict.fromkeys(hashes))
    if not unique_hashes:
        return {}
    request = b"".join(value.encode("ascii") + b"\n" for value in unique_hashes)
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    offset = 0
    stdout_closed = False
    stdin_closed = False
    max_output = max(512, len(unique_hashes) * 128)
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC
    command = _git_command(repo, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)")
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
        os.set_blocking(process.stdout.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        while not stdout_closed:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            events = selector.select(remaining)
            if not events:
                raise subprocess.TimeoutExpired(process.args, config.GIT_TIMEOUT_SEC)
            for key, mask in events:
                if key.data == "stdin" and mask & selectors.EVENT_WRITE:
                    if offset >= len(request):
                        selector.unregister(process.stdin)
                        process.stdin.close()
                        stdin_closed = True
                        continue
                    try:
                        written = os.write(process.stdin.fileno(), request[offset:])
                    except (BrokenPipeError, OSError):
                        _terminate(process)
                        return None
                    if written <= 0:
                        _terminate(process)
                        return None
                    offset += written
                elif key.data == "stdout" and mask & selectors.EVENT_READ:
                    chunk = os.read(process.stdout.fileno(), min(64 * 1024, max_output + 1 - len(output)))
                    if not chunk:
                        selector.unregister(process.stdout)
                        stdout_closed = True
                    else:
                        output.extend(chunk)
                        if len(output) > max_output:
                            _terminate(process)
                            return None
        if not stdin_closed and process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
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

    if not output or not output.endswith(b"\n"):
        return None
    result: dict[str, dict[str, Any]] = {}
    try:
        for raw_line in output.splitlines():
            fields = raw_line.decode("ascii", errors="strict").split(" ")
            if len(fields) == 2 and fields[1] == "missing":
                return None
            if len(fields) != 3:
                return None
            object_hash, object_type, object_size = fields
            if _HASH_RE.fullmatch(object_hash) is None or not _SIZE_RE.fullmatch(object_size):
                return None
            result[object_hash.lower()] = {"type": object_type, "size": int(object_size)}
    except (UnicodeDecodeError, ValueError, OverflowError):
        return None
    if set(result) != set(unique_hashes):
        return None
    return result


def _parse_index_record(record: bytes) -> tuple[str, int, str, str] | None:
    try:
        metadata, path_bytes = record.split(b"\t", 1)
        mode_bytes, hash_bytes, stage_bytes = metadata.split(b" ", 2)
        mode = mode_bytes.decode("ascii", errors="strict")
        object_hash = hash_bytes.decode("ascii", errors="strict").lower()
        stage = int(stage_bytes.decode("ascii", errors="strict"))
        path = path_bytes.decode("utf-8", errors="replace")
    except (UnicodeDecodeError, ValueError):
        return None
    if _MODE_RE.fullmatch(mode) is None or _HASH_RE.fullmatch(object_hash) is None:
        return None
    if stage not in _STAGES or not path or "\x00" in path:
        return None
    return path, stage, object_hash, mode


def _read_index_inventory(repo: str) -> tuple[list[dict[str, Any]], bool] | None:
    """Read a bounded, coherent index conflict inventory."""
    command = _git_command(repo, "ls-files", "--unmerged", "-z", "--")
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    pending = bytearray()
    current_path: str | None = None
    current_stages: dict[int, dict[str, Any]] = {}
    files: list[dict[str, Any]] = []
    bytes_seen = 0
    truncated = False
    deadline = time.monotonic() + config.GIT_TIMEOUT_SEC

    def flush_current() -> None:
        nonlocal current_path, current_stages
        if current_path is None:
            return
        files.append({"path": current_path, "stages": current_stages})
        current_path = None
        current_stages = {}

    def consume_records() -> bool:
        nonlocal current_path, current_stages, truncated
        while True:
            try:
                end = pending.index(0)
            except ValueError:
                return False
            record = bytes(pending[:end])
            del pending[: end + 1]
            if not record:
                continue
            parsed = _parse_index_record(record)
            if parsed is None:
                raise ConflictInspectorGitError("Gitのunmerged INDEX出力を解釈できません")
            path, stage, object_hash, mode = parsed
            if current_path != path:
                flush_current()
                if len(files) >= MAX_CONFLICT_FILES:
                    truncated = True
                    return True
                current_path = path
            if stage in current_stages:
                raise ConflictInspectorGitError("同一パス・stageのINDEXエントリが重複しています")
            current_stages[stage] = {"stage": stage, "hash": object_hash, "mode": mode}

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
            chunk = os.read(process.stdout.fileno(), min(64 * 1024, MAX_INVENTORY_BYTES + 1 - bytes_seen))
            if not chunk:
                break
            bytes_seen += len(chunk)
            pending.extend(chunk)
            if consume_records():
                _terminate(process)
                break
            if bytes_seen > MAX_INVENTORY_BYTES:
                truncated = True
                _terminate(process)
                break
        if not truncated:
            if pending:
                # The -z contract must terminate every index record.
                return None
            flush_current()
            remaining = deadline - time.monotonic()
            if remaining <= 0 or process.wait(timeout=remaining) != 0:
                return None
        else:
            # The last path may contain only a prefix of its stage records when
            # the byte or file cap was reached.  Do not expose that partial
            # group as if it were an authoritative conflict.
            current_path = None
            current_stages = {}
        return files, truncated
    except (ConflictInspectorGitError, OSError, subprocess.TimeoutExpired):
        if process is not None:
            _terminate(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _stage_kind(mode: str, object_type: str) -> str:
    if mode == "120000":
        return "symlink"
    if mode == "160000" or object_type == "commit":
        return "gitlink"
    if object_type != "blob":
        return "unsupported"
    return "file"


def _stage_record_with_info(record: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    value = {
        **record,
        "type": info["type"],
        "size": info["size"],
        "kind": _stage_kind(record["mode"], info["type"]),
    }
    return value


def _snapshot_key(files: list[dict[str, Any]], truncated: bool) -> str:
    rows = [
        {
            "path": item["path"],
            "stages": {
                str(stage): {
                    "hash": item["stages"][stage]["hash"],
                    "mode": item["stages"][stage]["mode"],
                }
                for stage in _STAGES
                if stage in item["stages"]
            },
        }
        for item in files
    ]
    encoded = json.dumps({"files": rows, "truncated": truncated}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _snapshot_file(item: dict[str, Any]) -> dict[str, Any]:
    """Return a compact path plus stage-hash identity for one conflict."""
    stages = {
        _STAGE_NAMES[stage]: {
            "hash": item["stages"][stage]["hash"],
            "mode": item["stages"][stage]["mode"],
        }
        if stage in item["stages"]
        else None
        for stage in _STAGES
    }
    return {
        "path": item["path"],
        "stages": stages,
        "stage_hashes": {
            name: value["hash"] if value is not None else None
            for name, value in stages.items()
        },
        "base_hash": stages["base"]["hash"] if stages["base"] is not None else None,
        "ours_hash": stages["ours"]["hash"] if stages["ours"] is not None else None,
        "theirs_hash": stages["theirs"]["hash"] if stages["theirs"] is not None else None,
    }


def _public_file(item: dict[str, Any], infos: dict[str, dict[str, Any]]) -> dict[str, Any]:
    stages: dict[str, dict[str, Any]] = {}
    for stage in _STAGES:
        record = item["stages"].get(stage)
        if record is not None:
            stages[str(stage)] = _stage_record_with_info(record, infos[record["hash"]])
    return {
        "path": item["path"],
        "stages": stages,
        "base": stages.get("1"),
        "ours": stages.get("2"),
        "theirs": stages.get("3"),
        "missing_stages": [stage for stage in _STAGES if str(stage) not in stages],
    }


def _inventory(repo: str) -> tuple[list[dict[str, Any]], bool, dict[str, dict[str, Any]]] | None:
    inventory = _read_index_inventory(repo)
    if inventory is None:
        return None
    files, truncated = inventory
    hashes = [record["hash"] for item in files for record in item["stages"].values()]
    infos = _batch_object_info(repo, hashes)
    if infos is None:
        return None
    return files, truncated, infos


def get_conflicts(repo: str) -> dict[str, Any] | None:
    """Return a bounded, grouped view of the current unmerged INDEX entries."""
    inventory = _inventory(repo)
    if inventory is None:
        return None
    files, truncated, infos = inventory
    public_files = [_public_file(item, infos) for item in files]
    snapshot = _snapshot_key(files, truncated)
    snapshot_files = [_snapshot_file(item) for item in files]
    return {
        "files": public_files,
        "truncated": truncated,
        "file_limit": MAX_CONFLICT_FILES,
        "byte_limit": MAX_INVENTORY_BYTES,
        "snapshot_key": snapshot,
        "snapshot": {
            "key": snapshot,
            "files": snapshot_files,
            "truncated": truncated,
        },
    }


def _current_stage(
    repo: str,
    file: str,
    stage: int,
    expected_hash: str,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Return the exact current record and object info, or raise on drift."""
    inventory = _inventory(repo)
    if inventory is None:
        return None
    files, _truncated, infos = inventory
    for item in files:
        if item["path"] != file:
            continue
        record = item["stages"].get(stage)
        if record is None or record["hash"] != expected_hash:
            raise ConflictChangedError("競合のINDEXが変わりました。最新の一覧を取得して再試行してください")
        info = infos.get(record["hash"])
        if info is None:
            return None
        return _stage_record_with_info(record, info), _snapshot_file(item)
    raise ConflictChangedError("指定した競合パスがINDEXにありません。最新の一覧を取得して再試行してください")


def _read_blob_limited(repo: str, object_hash: str, limit: int) -> tuple[bytes, bool] | None:
    result = _read_limited_output(_git_command(repo, "cat-file", "blob", object_hash), max_bytes=limit)
    return result


def _text_value(data: bytes, truncated: bool) -> tuple[str | None, bool]:
    """Decode complete UTF-8 text only; return ``binary`` separately."""
    if b"\x00" in data:
        return None, True
    try:
        if truncated:
            return None, False
        return data.decode("utf-8", errors="strict"), False
    except UnicodeDecodeError:
        return None, True


def _stage_response_identity(file: str, stage: int, expected_hash: str) -> dict[str, Any]:
    return {"file": file, "stage": stage, "expected_hash": expected_hash}


def get_conflict_stage(repo: str, file: str, stage: int, expected_hash: str) -> dict[str, Any] | None:
    """Read one current conflict stage after exact INDEX identity checking."""
    file = validate_file_path(file)
    stage = _validate_stage(stage)
    expected_hash = _validate_hash(expected_hash, "expected_hash")
    marker_before = _index_marker(repo)
    current = _current_stage(repo, file, stage, expected_hash)
    if current is None:
        return None
    record, snapshot = current
    identity = _stage_response_identity(file, stage, expected_hash)
    base = {
        "input": identity,
        "path": file,
        "file": file,
        "stage": stage,
        "stage_name": _STAGE_NAMES[stage],
        "hash": record["hash"],
        "mode": record["mode"],
        "type": record["type"],
        "kind": record["kind"],
        "size": record["size"],
        "snapshot": snapshot,
        "download_limit": MAX_BLOB_BYTES,
        "content_base64": "",
        "text": None,
        "binary": True,
        "truncated": False,
        "complete": False,
        "downloadable": False,
        "unavailable_reason": None,
    }

    if record["kind"] == "symlink":
        base["unavailable_reason"] = "シンボリックリンクはリンク先を追跡せず表示しません"
        marker_after = _index_marker(repo)
        current_after = _current_stage(repo, file, stage, expected_hash)
        if current_after is None:
            return None
        if marker_before is not None and marker_after is not None and marker_before != marker_after:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        if current_after[1]["stages"] != snapshot["stages"]:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        return base
    if record["kind"] == "gitlink":
        base["unavailable_reason"] = "gitlinkのネストしたリポジトリは表示しません"
        marker_after = _index_marker(repo)
        current_after = _current_stage(repo, file, stage, expected_hash)
        if current_after is None:
            return None
        if marker_before is not None and marker_after is not None and marker_before != marker_after:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        if current_after[1]["stages"] != snapshot["stages"]:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        return base
    if record["type"] != "blob":
        base["unavailable_reason"] = "INDEXのstageが通常のblobではないため表示しません"
        base["binary"] = False
        marker_after = _index_marker(repo)
        current_after = _current_stage(repo, file, stage, expected_hash)
        if current_after is None:
            return None
        if marker_before is not None and marker_after is not None and marker_before != marker_after:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        if current_after[1]["stages"] != snapshot["stages"]:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        return base

    blob = _read_blob_limited(repo, record["hash"], MAX_BLOB_BYTES)
    if blob is None:
        return None
    data, truncated = blob
    text, binary = _text_value(data, truncated)
    marker_after = _index_marker(repo)
    current_after = _current_stage(repo, file, stage, expected_hash)
    if current_after is None:
        return None
    if marker_before is not None and marker_after is not None and marker_before != marker_after:
        raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
    if current_after[1]["stages"] != snapshot["stages"]:
        raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
    base.update(
        {
            "content_base64": base64.b64encode(data).decode("ascii"),
            "text": text,
            "binary": binary,
            "truncated": truncated,
            "complete": not truncated and len(data) == record["size"],
            "downloadable": not truncated and len(data) == record["size"] and record["size"] <= MAX_BLOB_BYTES,
        }
    )
    return base


def _current_comparison(
    repo: str,
    file: str,
    ours_hash: str,
    theirs_hash: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    inventory = _inventory(repo)
    if inventory is None:
        return None
    files, _truncated, infos = inventory
    for item in files:
        if item["path"] != file:
            continue
        ours = item["stages"].get(2)
        theirs = item["stages"].get(3)
        if ours is None or theirs is None:
            raise ConflictChangedError("OURSまたはTHEIRSのINDEX stageがありません。最新の一覧を取得して再試行してください")
        if ours["hash"] != ours_hash or theirs["hash"] != theirs_hash:
            raise ConflictChangedError("競合のINDEXが変わりました。最新の一覧を取得して再試行してください")
        ours_info = infos.get(ours["hash"])
        theirs_info = infos.get(theirs["hash"])
        if ours_info is None or theirs_info is None:
            return None
        ours_public = _stage_record_with_info(ours, ours_info)
        theirs_public = _stage_record_with_info(theirs, theirs_info)
        snapshot = _snapshot_file(item)
        return ours_public, theirs_public, snapshot
    raise ConflictChangedError("指定した競合パスがINDEXにありません。最新の一覧を取得して再試行してください")


def get_conflict_comparison(
    repo: str,
    file: str,
    ours_hash: str,
    theirs_hash: str,
) -> dict[str, Any] | None:
    """Compare current regular-file OURS and THEIRS blobs with bounded output."""
    file = validate_file_path(file)
    ours_hash = _validate_hash(ours_hash, "ours_hash")
    theirs_hash = _validate_hash(theirs_hash, "theirs_hash")
    marker_before = _index_marker(repo)
    current = _current_comparison(repo, file, ours_hash, theirs_hash)
    if current is None:
        return None
    ours, theirs, snapshot = current
    identity = {"file": file, "ours_hash": ours_hash, "theirs_hash": theirs_hash}
    if (
        ours["mode"] not in _REGULAR_MODES
        or theirs["mode"] not in _REGULAR_MODES
        or ours["type"] != "blob"
        or theirs["type"] != "blob"
    ):
        unavailable = {
            "input": identity,
            "path": file,
            "ours_hash": ours_hash,
            "theirs_hash": theirs_hash,
            "snapshot": snapshot,
            "patch": "",
            "patch_bytes": 0,
            "patch_limit_bytes": MAX_PATCH_BYTES,
            "patch_truncated": False,
            "patch_complete": False,
            "binary": False,
            "unavailable_reason": "シンボリックリンクまたはgitlinkは比較しません",
            "command": None,
        }
        marker_after = _index_marker(repo)
        current_after = _current_comparison(repo, file, ours_hash, theirs_hash)
        if current_after is None:
            return None
        if marker_before is not None and marker_after is not None and marker_before != marker_after:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        if current_after[2]["stages"] != snapshot["stages"]:
            raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
        return unavailable

    command = _git_command(
        repo,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        ours_hash,
        theirs_hash,
        "--",
    )
    result = _read_limited_output(command, max_bytes=MAX_PATCH_BYTES)
    if result is None:
        return None
    patch_bytes, truncated = result
    patch = patch_bytes.decode("utf-8", errors="replace")
    binary = b"Binary files " in patch_bytes or b"GIT binary patch" in patch_bytes
    marker_after = _index_marker(repo)
    current_after = _current_comparison(repo, file, ours_hash, theirs_hash)
    if current_after is None:
        return None
    if marker_before is not None and marker_after is not None and marker_before != marker_after:
        raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
    if current_after[2]["stages"] != snapshot["stages"]:
        raise ConflictChangedError("競合のINDEXが読み出し中に変わりました。最新の一覧を取得して再試行してください")
    return {
        "input": identity,
        "path": file,
        "ours_hash": ours_hash,
        "theirs_hash": theirs_hash,
        "snapshot": snapshot,
        "patch": patch,
        "patch_bytes": len(patch_bytes),
        "patch_limit_bytes": MAX_PATCH_BYTES,
        "patch_truncated": truncated,
        "patch_complete": not truncated,
        "binary": binary,
        "unavailable_reason": None,
        "command": shlex.join(command),
    }


__all__ = [
    "ConflictChangedError",
    "ConflictInspectorGitError",
    "ConflictInspectorInputError",
    "MAX_BLOB_BYTES",
    "MAX_CONFLICT_FILES",
    "MAX_INVENTORY_BYTES",
    "MAX_PATH_LENGTH",
    "MAX_PATCH_BYTES",
    "SnapshotChangedError",
    "get_conflict_comparison",
    "get_conflict_stage",
    "get_conflicts",
    "validate_file_path",
]
