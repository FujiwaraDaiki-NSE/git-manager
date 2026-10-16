"""Read-only inspection of Git stash entries.

Git stores a normal stash as a merge commit whose first parent is the
original ``HEAD`` tree.  The optional third parent is a root commit containing
the untracked files captured by ``git stash push -u``.  Keeping those two
comparisons separate lets the UI explain exactly which part of a stash is
being shown and avoids presenting untracked files as ordinary tracked edits.
"""
from __future__ import annotations

import re
from typing import Any

from app import detail, gitinfo


# A stash is selected by an immutable object id.  Abbreviated ids are
# deliberately rejected: they can become ambiguous after objects are added
# and do not provide a stable command that can be copied and rerun.
FULL_HASH_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$", re.IGNORECASE)

LIST_FORMAT = "%H%x00%gd%x00%gs%x00%cI%x00"
LIST_COMMAND = f"git stash list --format='{LIST_FORMAT}'"
PATCH_MAX_BYTES = detail.PATCH_MAX_BYTES


class StashNotFound(LookupError):
    """The requested full hash is not a current stash entry."""


def valid_hash(value: str) -> bool:
    """Return whether *value* is a complete SHA-1 or SHA-256 object id."""

    return FULL_HASH_RE.fullmatch(value) is not None


def _parse_inventory(raw: str) -> list[dict[str, str]] | None:
    """Parse the NUL-delimited stash-list format without touching paths.

    ``git stash list`` adds a line ending after the final format record.  The
    format itself ends in NUL, so only a final standalone newline is removed;
    a newline inside a field would remain part of that field.
    """

    if raw == "":
        return []
    fields = raw.split("\0")
    if fields and fields[-1] in {"", "\n"}:
        fields.pop()
    if len(fields) % 4 != 0:
        return None

    entries: list[dict[str, str]] = []
    for offset in range(0, len(fields), 4):
        commit_hash, selector, subject, date = fields[offset:offset + 4]
        if not valid_hash(commit_hash) or not selector:
            return None
        entries.append(
            {
                "hash": commit_hash.lower(),
                "selector": selector,
                "subject": subject,
                "date": date,
            }
        )
    return entries


def get_stashes(repo: str) -> dict[str, Any] | None:
    """Return the current stash inventory, or ``None`` on a Git error.

    An empty, valid repository is represented by ``{"stashes": []}``; it is
    intentionally distinct from a failed ``git stash list`` invocation.
    """

    raw, status = gitinfo._run_with_status(repo, ["stash", "list", f"--format={LIST_FORMAT}"])
    if raw is None or status != 0:
        return None
    entries = _parse_inventory(raw)
    if entries is None:
        return None
    return {"stashes": entries, "command": LIST_COMMAND}


def _parse_numstat(raw: str) -> list[dict[str, Any]] | None:
    """Parse ``git diff --numstat -z`` with exact, NUL-safe paths.

    Rename detection is disabled for stash inspection, which means every
    record is the simple ``additions<TAB>deletions<TAB>path`` shape.  A path
    may still contain tabs or newlines; splitting at most twice preserves it.
    """

    files: list[dict[str, Any]] = []
    for record in raw.split("\0"):
        if record == "":
            continue
        fields = record.split("\t", 2)
        if len(fields) != 3:
            return None
        additions, deletions, path = fields
        if additions != "-" and not additions.isdecimal():
            return None
        if deletions != "-" and not deletions.isdecimal():
            return None
        files.append(
            {
                "additions": additions if additions == "-" else int(additions),
                "deletions": deletions if deletions == "-" else int(deletions),
                "path": path,
                "binary": additions == "-" and deletions == "-",
            }
        )
    return files


def _truncate_patch(patch: str) -> tuple[str, bool]:
    """Apply the same UTF-8-safe bound used by commit inspection."""

    encoded = patch.encode("utf-8")
    if len(encoded) <= PATCH_MAX_BYTES:
        return patch, False
    truncated = encoded[:PATCH_MAX_BYTES].decode("utf-8", errors="ignore")
    return truncated, True


def _part(
    repo: str,
    args: list[str],
    command: str,
    *,
    available: bool = True,
) -> dict[str, Any] | None:
    """Collect one stash part's stats and bounded patch.

    A ``None`` result means Git failed while reading the part.  Empty output
    from a successful command is represented by empty ``files`` and ``patch``
    instead of being treated as an error.
    """

    if not available:
        return {
            "available": False,
            "files": [],
            "patch": "",
            "patch_truncated": False,
            "command": None,
        }

    stats_raw = gitinfo._run(repo, args[:])
    if stats_raw is None:
        return None
    files = _parse_numstat(stats_raw)
    if files is None:
        return None

    # ``-z`` is essential for the numstat records, but it changes quoting in
    # patch headers.  The patch is a human-facing text view, so omit it from
    # that second read while keeping the NUL-safe stats invocation intact.
    patch_args = [arg for arg in args if arg != "-z"]
    # The stats command ends at --; retain the comparison and options but
    # replace numstat with a bounded patch request.
    try:
        numstat_index = patch_args.index("--numstat")
    except ValueError:
        return None
    patch_args[numstat_index:numstat_index + 1] = ["--patch", "--unified=3"]
    patch = gitinfo._run_limited(repo, patch_args, PATCH_MAX_BYTES)
    if patch is None:
        return None
    bounded_patch, patch_truncated = _truncate_patch(patch)
    return {
        "available": True,
        "files": files,
        "patch": bounded_patch,
        "patch_truncated": patch_truncated,
        "command": command,
    }


def _parents(repo: str, commit_hash: str) -> tuple[list[str] | None, bool]:
    """Return parents and whether a nonzero Git status means it vanished."""

    raw, status = gitinfo._run_with_status(repo, ["rev-list", "--parents", "-n", "1", commit_hash])
    if raw is None:
        # A nonzero Git exit after the inventory was read means the object was
        # removed between the two read-only calls.  ``None`` status is the
        # runner's timeout/OS-error sentinel and remains a command failure.
        return None, status is not None
    fields = raw.strip().split()
    if not fields or fields[0].lower() != commit_hash.lower():
        return None, True
    return fields[1:], False


def get_stash(repo: str, fullhash: str) -> dict[str, Any] | None:
    """Read one stash by its full immutable object id.

    The id must still be present in the current stash inventory.  A missing
    or vanished row raises :class:`StashNotFound`; a Git execution failure
    returns ``None`` so the API can distinguish a 404 from a 502.  Inventory
    membership also prevents callers from using this endpoint as an arbitrary
    commit viewer.
    """

    if not valid_hash(fullhash):
        raise StashNotFound("stash hash is not a full object id")
    canonical_hash = fullhash.lower()
    inventory = get_stashes(repo)
    if inventory is None:
        return None
    entry = next((item for item in inventory["stashes"] if item["hash"] == canonical_hash), None)
    if entry is None:
        raise StashNotFound("stash entry is no longer available")

    # The stash entry is a merge commit.  Requiring its first parent also
    # protects the diff expressions below from silently resolving an
    # arbitrary object or a malformed manually-created stash ref.
    parents, vanished = _parents(repo, canonical_hash)
    if parents is None:
        if vanished:
            raise StashNotFound("stash entry is no longer available")
        return None
    if len(parents) not in {2, 3}:
        return None

    tracked_revision = f"{canonical_hash}^1"
    tracked_command = (
        "git -c core.quotepath=false diff --no-ext-diff --no-textconv "
        f"--no-renames --no-color --patch --unified=3 {tracked_revision} {canonical_hash} --"
    )
    tracked_args = [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--numstat",
        "-z",
        tracked_revision,
        canonical_hash,
        "--",
    ]
    tracked = _part(repo, tracked_args, tracked_command)
    if tracked is None:
        return None

    has_untracked_parent = len(parents) >= 3
    untracked_command: str | None = None
    untracked: dict[str, Any] | None
    if has_untracked_parent:
        untracked_revision = f"{canonical_hash}^3"
        untracked_command = (
            "git -c core.quotepath=false diff-tree -r --root --no-commit-id "
            "--format= --no-ext-diff --no-textconv --no-renames --no-color "
            f"--patch --unified=3 {untracked_revision}"
        )
        untracked_args = [
            "-c",
            "core.quotepath=false",
            "diff-tree",
            "-r",
            "--root",
            "--no-commit-id",
            "--format=",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            "--numstat",
            "-z",
            untracked_revision,
        ]
        untracked = _part(repo, untracked_args, untracked_command)
        if untracked is None:
            return None
    else:
        untracked = _part(repo, [], "", available=False)

    return {
        "hash": canonical_hash,
        "selector": entry["selector"],
        "subject": entry["subject"],
        "date": entry["date"],
        "tracked": tracked,
        "untracked": untracked,
        # This is retained as a convenient top-level copy target for clients
        # that want the ordinary tracked diff.  The part-level commands are
        # authoritative when both sections are shown.
        "command": tracked_command,
        "untracked_command": untracked_command,
    }
