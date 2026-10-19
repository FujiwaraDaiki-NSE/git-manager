"""Read-only staged and working-tree diffs.

The worktree diff is deliberately built from Git's index and object database.
It never opens a path from the working tree itself.  A complete ``--numstat
-z`` inventory is collected before a file-scoped request is made so rename
and copy pairs can be kept together.  This matters for a selected old path:
passing only the new path to ``git diff`` would make a rename look like an
ordinary add.
"""
from __future__ import annotations

import os
import ntpath
import posixpath
import re
import selectors
import subprocess
import time
from typing import Any

from app import config, gitinfo


PATCH_MAX_BYTES = 200_000
# The patch has a product-facing bound, while its NUL-delimited numstat
# prefix must remain complete.  A very large inventory is rejected explicitly
# rather than returning counts that only describe a prefix of the repository.
COMBINED_METADATA_MAX_BYTES = 8 * 1024 * 1024
MAX_FILE_LENGTH = 4_096
STAGES = frozenset({"staged", "unstaged"})
STAGE_LABELS = {
    "staged": "ステージ済み",
    "unstaged": "未ステージ",
}


class WorktreeDiffError(ValueError):
    """A safe, user-visible input or Git result failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_stage(stage: str) -> str:
    if not isinstance(stage, str) or stage not in STAGES:
        raise WorktreeDiffError(
            "invalid_stage",
            "stage は staged または unstaged のいずれかで指定してください",
        )
    return stage


def _validate_file(file: str | None) -> str | None:
    if file is None:
        return None
    if not isinstance(file, str):
        raise WorktreeDiffError("invalid_file", "file は文字列または null で指定してください")
    if file == "" or len(file) > MAX_FILE_LENGTH or "\x00" in file:
        raise WorktreeDiffError("invalid_file", "file が長すぎるか不正な文字を含んでいます")
    if posixpath.isabs(file) or ntpath.isabs(file):
        raise WorktreeDiffError("invalid_file", "file に絶対パスは指定できません")
    if any(part == ".." for part in re.split(r"[/\\]", file)):
        raise WorktreeDiffError("invalid_file", "file に親ディレクトリ参照は指定できません")
    if file in {".", "./", ".\\"}:
        raise WorktreeDiffError("invalid_file", "file はファイルの相対パスで指定してください")
    return file


def _git_command(repo: str, args: list[str], *, literal_pathspecs: bool = True) -> list[str]:
    """Build a Git command with literal pathspec handling at the Git level.

    The ordinary request path always enables ``--literal-pathspecs``.  The
    all-files conflict path needs Git's explicit ``:(exclude,literal)``
    pathspec magic, so that one internal call opts out of the global switch
    and marks every exclusion literal in the pathspec itself.
    """
    prefix = [gitinfo.GIT, "--no-optional-locks"]
    if literal_pathspecs:
        prefix.append("--literal-pathspecs")
    return [*prefix, "-C", repo, *args]


def _run(repo: str, args: list[str]) -> str | None:
    try:
        proc = subprocess.run(
            _git_command(repo, args),
            capture_output=True,
            timeout=config.GIT_TIMEOUT_SEC,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    return proc.stdout.decode("utf-8", errors="replace") if proc.returncode == 0 else None


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    """Stop a bounded Git reader without turning a completed process into an error."""
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=1)
    except (subprocess.TimeoutExpired, OSError):
        pass


def _run_bounded_output(repo: str, args: list[str], *, limit: int) -> bytes | None:
    """Read stdout with a hard byte bound while keeping Git read-only."""
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    timeout = config.GIT_TIMEOUT_SEC
    try:
        process = subprocess.Popen(
            _git_command(repo, args),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        while len(output) <= limit:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(process.args, timeout)
            chunk = os.read(
                process.stdout.fileno(),
                min(64 * 1024, limit + 1 - len(output)),
            )
            if not chunk:
                break
            output.extend(chunk)
        if len(output) > limit:
            _terminate_process(process)
            raise WorktreeDiffError(
                "metadata_incomplete",
                "差分のファイル一覧が大きすぎるため完全に取得できませんでした",
            )
        if process.wait(timeout=max(0.0, deadline - time.monotonic())) != 0:
            return None
        return bytes(output)
    except WorktreeDiffError:
        raise
    except (subprocess.TimeoutExpired, OSError):
        if process is not None:
            _terminate_process(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _run_inventory_limited(repo: str, args: list[str]) -> str | None:
    """Read a complete NUL-delimited numstat inventory with a hard bound."""
    raw = _run_bounded_output(repo, args, limit=COMBINED_METADATA_MAX_BYTES)
    return raw.decode("utf-8", errors="replace") if raw is not None else None


def _conflict_paths_limited(repo: str, stage: str) -> list[str] | None:
    """Return unmerged paths without reading their working-tree contents."""
    args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--find-copies",
    ]
    if stage == "staged":
        args.append("--cached")
    args.extend(["--name-only", "--diff-filter=U", "-z", "--"])
    raw = _run_bounded_output(repo, args, limit=COMBINED_METADATA_MAX_BYTES)
    if raw is None:
        return None
    if raw and not raw.endswith(b"\x00"):
        raise WorktreeDiffError(
            "metadata_incomplete",
            "競合ファイルの一覧を完全に取得できませんでした",
        )
    paths = [part.decode("utf-8", errors="replace") for part in raw.split(b"\x00") if part]
    # Git should not emit duplicates, but stable de-duplication keeps the
    # exclusion list deterministic if a future diff mode does so.
    return sorted(set(paths), key=repr)


def _run_combined_limited(
    repo: str,
    args: list[str],
    literal_pathspecs: bool = True,
) -> tuple[str, str, bool] | None:
    """Read one ``--numstat -z --patch`` result coherently.

    Git emits all NUL-delimited numstat records, followed by a second NUL and
    the textual patch.  Keep the complete prefix and bound only the patch.
    This avoids pairing a numstat inventory from one Git process with a patch
    produced by another process after the index or worktree changed.
    """
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    metadata = bytearray()
    patch = bytearray()
    phase = "metadata"
    timeout = config.GIT_TIMEOUT_SEC
    try:
        command = (
            _git_command(repo, args)
            if literal_pathspecs
            else _git_command(repo, args, literal_pathspecs=False)
        )
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
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(process.args, timeout)
            chunk = os.read(process.stdout.fileno(), 64 * 1024)
            if not chunk:
                break

            if phase == "metadata":
                metadata.extend(chunk)
                boundary = metadata.find(b"\x00\x00")
                # ``boundary`` indexes the first separator NUL, so the
                # complete metadata prefix is ``boundary + 1`` bytes.
                if boundary >= COMBINED_METADATA_MAX_BYTES:
                    _terminate_process(process)
                    raise WorktreeDiffError(
                        "metadata_incomplete",
                        "差分のファイル一覧が大きすぎるため完全に取得できませんでした",
                    )
                if boundary < 0:
                    if len(metadata) > COMBINED_METADATA_MAX_BYTES:
                        _terminate_process(process)
                        raise WorktreeDiffError(
                            "metadata_incomplete",
                            "差分のファイル一覧が大きすぎるため完全に取得できませんでした",
                        )
                    continue
                # Include the first NUL in the numstat record, and omit both
                # separator NULs from the patch text.
                patch.extend(metadata[boundary + 2 :])
                del metadata[boundary + 1 :]
                phase = "patch"
            else:
                patch.extend(chunk)

            if phase == "patch" and len(patch) > PATCH_MAX_BYTES:
                _terminate_process(process)
                patch_text = bytes(patch[: PATCH_MAX_BYTES + 1]).decode("utf-8", errors="replace")
                return (
                    bytes(metadata).decode("utf-8", errors="replace"),
                    patch_text,
                    True,
                )

        if process.wait(timeout=max(0.0, deadline - time.monotonic())) != 0:
            return None
        if phase == "metadata":
            if not metadata or not metadata.replace(b"\x00", b""):
                return "", "", False
            raise WorktreeDiffError(
                "metadata_incomplete",
                "差分のファイル一覧と本文の境界を確認できませんでした",
            )
        return (
            bytes(metadata).decode("utf-8", errors="replace"),
            bytes(patch).decode("utf-8", errors="replace"),
            False,
        )
    except WorktreeDiffError:
        raise
    except (subprocess.TimeoutExpired, OSError):
        if process is not None:
            _terminate_process(process)
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _truncate_patch(patch: str, already_truncated: bool) -> tuple[str, bool]:
    encoded = patch.encode("utf-8")
    if len(encoded) <= PATCH_MAX_BYTES and not already_truncated:
        return patch, False
    return encoded[:PATCH_MAX_BYTES].decode("utf-8", errors="ignore"), True


def _diff_prefix(stage: str, *, numstat: bool = False, ignore_whitespace: bool = False) -> list[str]:
    args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--find-copies",
    ]
    if stage == "staged":
        args.append("--cached")
    if ignore_whitespace:
        args.append("--ignore-all-space")
    if numstat:
        args.extend(["--numstat", "-z"])
    else:
        args.extend(["--patch", "--binary", "--unified=3"])
    return args


def _combined_diff_prefix(stage: str, *, ignore_whitespace: bool = False) -> list[str]:
    """Request NUL-safe metadata and patch text in one Git invocation."""
    args = _diff_prefix(stage, numstat=True, ignore_whitespace=ignore_whitespace)
    args.extend(["--patch", "--binary", "--unified=3"])
    return args


def _parse_numstat(raw: str) -> list[dict[str, Any]]:
    """Parse Git's NUL-delimited numstat records, including rename pairs."""
    fields = raw.split("\x00")
    files: list[dict[str, Any]] = []
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if record == "":
            continue
        columns = record.split("\t", 2)
        if len(columns) != 3:
            raise WorktreeDiffError("git_unavailable", "差分のファイル一覧を解釈できませんでした")
        additions, deletions, path = columns
        if additions != "-" and not additions.isdecimal():
            raise WorktreeDiffError("git_unavailable", "差分の追加行数を解釈できませんでした")
        if deletions != "-" and not deletions.isdecimal():
            raise WorktreeDiffError("git_unavailable", "差分の削除行数を解釈できませんでした")

        old_path: str | None = None
        if path == "":
            if index + 1 >= len(fields):
                raise WorktreeDiffError("git_unavailable", "名前変更の差分を解釈できませんでした")
            old_path = fields[index]
            path = fields[index + 1]
            index += 2
            if old_path == "" or path == "":
                raise WorktreeDiffError("git_unavailable", "名前変更のパスを解釈できませんでした")
        if path == "":
            raise WorktreeDiffError("git_unavailable", "差分のパスを解釈できませんでした")
        item: dict[str, Any] = {
            "additions": additions if additions == "-" else int(additions),
            "deletions": deletions if deletions == "-" else int(deletions),
            "path": path,
            "binary": additions == "-" and deletions == "-",
        }
        if old_path is not None:
            item["old_path"] = old_path
        files.append(item)
    return files


def _stats(files: list[dict[str, Any]]) -> dict[str, Any]:
    additions = 0
    deletions = 0
    additions_known = True
    deletions_known = True
    for item in files:
        if item["binary"] or not isinstance(item["additions"], int):
            additions_known = False
        else:
            additions += item["additions"]
        if item["binary"] or not isinstance(item["deletions"], int):
            deletions_known = False
        else:
            deletions += item["deletions"]
    return {
        "files": len(files),
        "additions": additions if additions_known else None,
        "deletions": deletions if deletions_known else None,
        "binary": sum(1 for item in files if item["binary"]),
        "renamed": sum(1 for item in files if "old_path" in item),
    }


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def _command(
    repo: str,
    stage: str,
    file_paths: list[str],
    ignore_whitespace: bool,
    exclude_paths: list[str] | None = None,
) -> str:
    exclude_paths = exclude_paths or []
    literal = not exclude_paths
    parts = [
        f"git --no-optional-locks {'--literal-pathspecs ' if literal else ''}-C {_shell_quote(repo)} diff",
        "--cached" if stage == "staged" else "",
        "--ignore-all-space" if ignore_whitespace else "",
        "--no-ext-diff --no-textconv --find-renames --find-copies --patch --binary --unified=3",
    ]
    display_paths = [*file_paths, *(f":(exclude,literal){path}" for path in exclude_paths)]
    if display_paths:
        # This is display metadata only.  The actual subprocess receives each
        # path as its own argument after ``--``; conflict exclusions use the
        # same explicit literal pathspec magic shown here.
        parts.append("-- " + " ".join(_shell_quote(path) for path in display_paths))
    else:
        parts.append("--")
    return " ".join(part for part in parts if part)


def _selected_paths(files: list[dict[str, Any]], file: str | None) -> tuple[list[str], list[dict[str, Any]], str | None]:
    if file is None:
        return [], files, None
    matched = [
        item
        for item in files
        if item["path"] == file or item.get("old_path") == file
    ]
    if not matched:
        return [], [], "not-in-diff"
    paths: list[str] = []
    seen: set[str] = set()
    for item in matched:
        for path in (item.get("old_path"), item["path"]):
            if isinstance(path, str) and path not in seen:
                seen.add(path)
                paths.append(path)
    # Expanding a rename/copy to both literal paths can also include another
    # record that touches the source path (for example, a copied file whose
    # source was edited in the same snapshot).  Keep every inventory record
    # in that expanded path set so the combined command and returned metadata
    # describe the same scope rather than rejecting a legitimate pair.
    scoped = [
        item
        for item in files
        if item["path"] in seen or item.get("old_path") in seen
    ]
    return paths, scoped, None


def _file_signatures(files: list[dict[str, Any]]) -> tuple[tuple[Any, ...], ...]:
    """Compare inventory records without depending on dict insertion order."""
    values = [
        (
            item.get("old_path"),
            item.get("path"),
            item.get("additions"),
            item.get("deletions"),
            item.get("binary"),
        )
        for item in files
    ]
    return tuple(sorted(values, key=repr))


def _excluded_kind(repo: str, file: str, stage: str) -> str:
    """Classify a missing diff path from status metadata only.

    This call is intentionally limited to porcelain status.  It does not open
    the selected path and keeps an untracked row from being mistaken for an
    empty tracked diff.
    """
    raw = _run(
        repo,
        [
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
            "-z",
            "--",
            file,
        ],
    )
    if raw is None:
        return "not_in_diff"
    fields = raw.split("\x00")
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if not record:
            continue
        if record.startswith("? "):
            if record[2:] == file:
                return "untracked"
            continue
        if record.startswith("u "):
            # An unmerged v2 row has ten space-delimited metadata fields
            # before its path.  Keep the path as one field so spaces in a
            # filename are not mistaken for another metadata value.
            columns = record.split(" ", 10)
            if len(columns) > 10 and columns[10] == file:
                return "conflict"
            continue
        if record.startswith("1 "):
            columns = record.split(" ", 8)
            if len(columns) > 8 and columns[8] == file:
                # A staged or unstaged path which vanished between the
                # inventory and status reads is still an explicit omission.
                return "not_in_diff"
            continue
        if record.startswith("2 "):
            columns = record.split(" ", 9)
            old_path = fields[index] if index < len(fields) else None
            if index < len(fields):
                index += 1
            if len(columns) > 9 and columns[9] == file:
                return "conflict" if "U" in columns[1] else "not_in_diff"
            if old_path == file:
                return "conflict" if "U" in columns[1] else "not_in_diff"
    return "not_in_diff"


def get_worktree_diff(
    repo: str,
    stage: str,
    file: str | None,
    ignore_whitespace: bool,
) -> dict[str, Any]:
    """Return a bounded read-only diff for the index or working tree.

    ``file=None`` is the all-files scope.  A selected rename or copy is
    expanded to both literal paths based on the complete inventory.  Missing
    paths are represented as an explicit exclusion and produce no patch; in
    particular, untracked files are never opened or synthesized as a diff.
    """
    stage = _validate_stage(stage)
    file = _validate_file(file)
    if not isinstance(ignore_whitespace, bool):
        raise WorktreeDiffError(
            "invalid_ignore_whitespace",
            "ignoreWhitespace は true または false で指定してください",
        )

    excluded: dict[str, list[str]] = {
        "untracked": [],
        "conflict": [],
        "not_in_diff": [],
    }
    inventory_raw: str | None = None
    inventory: list[dict[str, Any]] = []
    expected_files: list[dict[str, Any]] = []
    pathspecs: list[str] = []
    exclusion: str | None = None
    conflict_paths_before: list[str] = []
    conflict_exclusions: list[str] = []
    if file is not None:
        # A complete metadata-only inventory is needed only to expand a
        # selected rename/copy into both literal paths.  The returned file
        # counts still come from the combined command below.
        inventory_args = _diff_prefix(stage, numstat=True, ignore_whitespace=ignore_whitespace) + ["--"]
        inventory_raw = _run_inventory_limited(repo, inventory_args)
        if inventory_raw is None:
            raise WorktreeDiffError("git_unavailable", "差分のファイル一覧を取得できませんでした")
        inventory = _parse_numstat(inventory_raw)
        pathspecs, expected_files, exclusion = _selected_paths(inventory, file)
        if exclusion is not None:
            excluded[_excluded_kind(repo, file, stage)].append(file)
        elif _excluded_kind(repo, file, stage) == "conflict":
            # Git can emit a combined conflict patch without the normal
            # numstat/patch NUL boundary.  File-level display deliberately
            # leaves that state excluded instead of returning an unparseable
            # or misleading ordinary diff.
            exclusion = "conflict"
            excluded["conflict"].append(file)
    else:
        # A conflicted path makes an ordinary ``--numstat -z --patch`` call
        # emit a combined ``diff --cc`` patch without the NUL metadata
        # boundary.  Discover those paths first, then exclude them with
        # explicit literal pathspec magic so normal tracked changes can still
        # be returned from one coherent bounded Git call.
        conflict_paths_before = _conflict_paths_limited(repo, stage)
        if conflict_paths_before is None:
            raise WorktreeDiffError(
                "git_unavailable",
                "競合ファイルの一覧を取得できませんでした",
            )
        conflict_exclusions = [
            f":(exclude,literal){path}" for path in conflict_paths_before
        ]
        excluded["conflict"] = list(conflict_paths_before)

    # Git itself is the authority for both the numstat records and patch
    # contents.  The NUL-delimited metadata prefix is separated from the
    # patch while streaming, so a large patch is bounded without truncating
    # the file inventory.
    files: list[dict[str, Any]] = []
    patch = ""
    patch_truncated = False
    if exclusion != "conflict":
        combined_args = _combined_diff_prefix(stage, ignore_whitespace=ignore_whitespace)
        combined_paths = pathspecs if pathspecs else ([file] if file is not None else [])
        if file is None and conflict_exclusions:
            combined_paths = conflict_exclusions
        combined_args.extend(["--", *combined_paths])
        # ``--literal-pathspecs`` treats the ``:(exclude,literal)`` tokens as
        # ordinary filenames, so this one all-scope call uses pathspec magic
        # explicitly marked literal instead.
        if file is None and conflict_exclusions:
            combined = _run_combined_limited(repo, combined_args, False)
        else:
            combined = _run_combined_limited(repo, combined_args)
        if combined is None:
            raise WorktreeDiffError("git_unavailable", "差分のファイル一覧と本文を取得できませんでした")
        metadata_raw, patch, patch_truncated = combined
        files = _parse_numstat(metadata_raw)
        patch, patch_truncated = _truncate_patch(patch, patch_truncated)

    if file is None:
        conflict_paths_after = _conflict_paths_limited(repo, stage)
        if conflict_paths_after is None:
            raise WorktreeDiffError(
                "git_unavailable",
                "競合ファイルのスナップショットを再確認できませんでした",
            )
        if conflict_paths_after != conflict_paths_before:
            raise WorktreeDiffError(
                "snapshot_changed",
                "差分の取得中にGitの状態が変わりました。再読み込みして確認してください",
            )

    if file is not None:
        # A selected file must resolve to exactly the inventory record used to
        # expand a rename/copy.  If it appeared or changed while the combined
        # command was running, do not return a misleading add-only or empty
        # result.
        if exclusion is not None:
            changed = bool(files)
        else:
            changed = _file_signatures(files) != _file_signatures(expected_files)
        if changed:
            raise WorktreeDiffError(
                "snapshot_changed",
                "差分の取得中にGitの状態が変わりました。再読み込みして確認してください",
            )
        if inventory_raw is None:
            raise WorktreeDiffError("git_unavailable", "差分のスナップショットを確認できませんでした")
        inventory_after = _run_inventory_limited(repo, inventory_args)
        if inventory_after is None:
            raise WorktreeDiffError("git_unavailable", "差分のスナップショットを再確認できませんでした")
        if inventory_after != inventory_raw:
            raise WorktreeDiffError(
                "snapshot_changed",
                "差分の取得中にGitの状態が変わりました。再読み込みして確認してください",
            )

    patch_bytes = len(patch.encode("utf-8"))
    return {
        # The direct fields are the actual immutable request snapshot used to
        # produce this response.  ``input`` is kept separate so consumers can
        # discard a late response after changing controls.
        "stage": stage,
        "stage_label": STAGE_LABELS[stage],
        "file": file,
        "ignore_whitespace": ignore_whitespace,
        "input": {
            "stage": stage,
            "file": file,
            "ignore_whitespace": ignore_whitespace,
        },
        "snapshot": {
            "stage": stage,
            "stage_label": STAGE_LABELS[stage],
            "file": file,
            "scope": "all" if file is None else "file",
            "ignore_whitespace": ignore_whitespace,
        },
        "scope": "all" if file is None else "file",
        "files": files,
        "stats": _stats(files),
        "patch": patch,
        "patch_truncated": patch_truncated,
        "patch_complete": not patch_truncated,
        "patch_bytes": patch_bytes,
        "patch_limit_bytes": PATCH_MAX_BYTES,
        "metadata_complete": True,
        "excluded": excluded,
        # Keep an explicit excluded path in the displayed command as well.
        # An empty pathspec here would otherwise look like an all-files
        # command even though this response intentionally contains no patch.
        "command": _command(
            repo,
            stage,
            pathspecs if pathspecs else ([file] if file is not None else []),
            ignore_whitespace,
            conflict_paths_before if file is None else None,
        ),
    }
