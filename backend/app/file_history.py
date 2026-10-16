"""Read-only history for one repository-relative file path.

The public function intentionally keeps the query inputs explicit.  A caller
must provide the revision, path, follow setting, and page offset; there is no
implicit HEAD, current path, or default pagination value here.
"""
from __future__ import annotations

import ntpath
import posixpath
import re
from typing import Any

from app import gitinfo

PAGE_SIZE = 100
MAX_OFFSET = 10_000
_HASH_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class FileHistoryInputError(ValueError):
    """An explicit file-history input is unsafe or otherwise invalid."""


def validate_file_path(file: str) -> str:
    """Validate a repository-relative path without normalising it.

    Git paths may contain spaces, tabs, and newlines, so the original value is
    returned byte-for-byte as a Python string.  Absolute paths and traversal
    components are rejected before Git is invoked.  Backslash-separated
    traversal is rejected as well so a Windows-looking value cannot become an
    unsafe path when the API is moved between hosts.
    """
    if not isinstance(file, str) or not file or "\x00" in file:
        raise FileHistoryInputError("file は空でない相対パスで指定してください")
    if posixpath.isabs(file) or ntpath.isabs(file):
        raise FileHistoryInputError("file に絶対パスは指定できません")
    if any(part == ".." for part in re.split(r"[/\\]", file)):
        raise FileHistoryInputError("file に親ディレクトリ参照は指定できません")
    # A bare dot asks Git for the whole directory tree rather than one file.
    # Keep this endpoint file-specific and require an actual path component.
    if file in {".", "./"}:
        raise FileHistoryInputError("file はファイルの相対パスで指定してください")
    return file


def _resolve_revision(repo: str, revision: str) -> str | None:
    """Resolve an explicit revision to an immutable full object id."""
    if not isinstance(revision, str) or not revision or "\x00" in revision:
        raise FileHistoryInputError("revision は空でない値で指定してください")
    # ``--end-of-options`` makes even a value beginning with ``-`` data.  The
    # ``^{commit}`` suffix also prevents a tree/blob revision from being used
    # as the log starting point.
    raw = gitinfo._run(
        repo,
        ["rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
    )
    if raw is None:
        return None
    resolved = raw.rstrip("\r\n")
    return resolved if _HASH_RE.fullmatch(resolved) else None


def _parse_log(raw: str) -> list[dict[str, Any]] | None:
    """Parse ``git log --name-status -z`` without quoting file metadata.

    The format has six NUL-delimited metadata fields followed by a NUL and
    zero or more NUL-delimited status/path records.  A pathname is consumed as
    a whole token, so embedded newlines and tabs are retained exactly.
    """
    if raw == "":
        return []
    tokens = raw.split("\x00")
    records: list[dict[str, Any]] = []
    index = 0

    while index < len(tokens):
        # ``--format`` and ``-z`` can leave empty separators between records.
        while index < len(tokens) and tokens[index] == "":
            index += 1
        if index >= len(tokens):
            break
        commit_hash = tokens[index]
        if _HASH_RE.fullmatch(commit_hash) is None:
            return None
        if index + 5 >= len(tokens):
            return None
        short, author, date, parents, subject = tokens[index + 1:index + 6]
        index += 6

        changes: list[dict[str, str | None]] = []
        while index < len(tokens):
            token = tokens[index]
            if token == "":
                index += 1
                continue
            # The next metadata block starts directly with its full hash.
            if _HASH_RE.fullmatch(token):
                break
            # Status records are prefixed by the newline that Git places
            # before the name-status section.  Newlines in a path are in the
            # following token and therefore cannot be confused with this.
            if not token.startswith("\n") or len(token) == 1:
                return None
            status = token[1:]
            index += 1
            if index >= len(tokens):
                return None
            first_path = tokens[index]
            index += 1
            old_path: str | None = None
            path = first_path
            if status.startswith(("R", "C")):
                if index >= len(tokens):
                    return None
                old_path = first_path
                path = tokens[index]
                index += 1
            changes.append({"status": status, "path": path, "old_path": old_path})

        first = changes[0] if changes else None
        records.append(
            {
                "hash": commit_hash,
                "short": short,
                "subject": subject or None,
                "author": author or None,
                "date": date or None,
                "parents": parents.split() if parents else [],
                "status": first["status"] if first else None,
                "path": first["path"] if first else None,
                "old_path": first["old_path"] if first else None,
            }
        )

    return records


def get_file_history(
    repo: str,
    revision: str,
    file: str,
    follow: bool,
    offset: int,
) -> dict[str, Any] | None:
    """Return one bounded page of a file's history at an immutable revision.

    ``None`` means Git failed or returned malformed output.  A valid request
    with no matching history returns a response whose ``commits`` list is
    empty.  This distinction lets the API and UI keep an unavailable Git
    operation separate from a file that simply has no matching commits.
    """
    validate_file_path(file)
    if not isinstance(follow, bool):
        raise FileHistoryInputError("follow は true または false で指定してください")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > MAX_OFFSET:
        raise FileHistoryInputError(f"offset は 0 以上 {MAX_OFFSET} 以下の整数で指定してください")

    pinned_hash = _resolve_revision(repo, revision)
    if pinned_hash is None:
        return None

    format_spec = "%H%x00%h%x00%an%x00%aI%x00%P%x00%s%x00"
    args = [
        "--literal-pathspecs",
        "log",
        "--no-ext-diff",
        "--no-textconv",
        "--date-order",
        "--name-status",
        "-z",
        f"--format={format_spec}",
    ]
    if follow:
        # ``--skip`` counts before Git's rename traversal has recovered the
        # earlier path, so a page after a rename can appear empty.  Read the
        # bounded prefix from the pinned tip and slice it locally instead.
        args.append(f"--max-count={offset + PAGE_SIZE + 1}")
        args.append("--follow")
    else:
        args.extend([f"--skip={offset}", f"--max-count={PAGE_SIZE + 1}"])
    # ``--`` ends revisions, while ``--literal-pathspecs`` also disables
    # pathspec magic and globbing.  Keep both guarantees: a filename such as
    # ``:(glob)*`` or ``[abc].txt`` must remain one literal path.
    args.extend([pinned_hash, "--", file])
    raw = gitinfo._run(repo, args)
    if raw is None:
        return None
    commits = _parse_log(raw)
    if commits is None:
        return None
    if follow:
        has_more = len(commits) > offset + PAGE_SIZE
        commits = commits[offset:offset + PAGE_SIZE]
    else:
        has_more = len(commits) > PAGE_SIZE
        commits = commits[:PAGE_SIZE]
    limit_reached = has_more and offset + PAGE_SIZE > MAX_OFFSET
    next_offset = None if limit_reached else offset + PAGE_SIZE if has_more else None
    return {
        "commits": commits,
        "file": file,
        "revision": revision,
        "pinned_hash": pinned_hash,
        "follow": follow,
        "offset": offset,
        "has_more": has_more,
        "next_offset": next_offset,
        "limit_reached": limit_reached,
    }


