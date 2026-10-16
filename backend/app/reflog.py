"""Read-only inspection of one explicitly selected Git reflog.

The reflog is an operation record rather than commit history.  In particular,
its timestamp is the timestamp written to the reflog entry and may differ from
the committer timestamp of the object the entry points at.  ``git log -g``
exposes that timestamp through the date form of ``%gD``; the other fields are
separated with NULs so a reflog message may safely contain whitespace or
newlines.

Only a single named ref can be inspected.  Revision expressions (``HEAD~1``,
``main@{1}``, and so on) are deliberately outside this module's contract.
That keeps the response tied to the ref the user selected and prevents a
caller from turning the read-only inventory into an arbitrary revision query.
"""
from __future__ import annotations

import re
import shlex
from datetime import datetime
from typing import Any

from app import gitinfo


MAX_RECORDS = 1_000
MAX_REF_LENGTH = 512

# ``%gD`` is rendered as ``<ref>@{<timestamp>}`` when ``--date=iso-strict`` is
# active.  The ref itself can contain ``@`` (and a date can contain ``+``), so
# split from the right rather than trying to validate the complete selector
# with one greedy expression.
_SELECTOR_DATE_RE = re.compile(r"@\{([^{}]+)\}$")
_OBJECT_HASH_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")

# Git's refname grammar is intentionally narrower than a generic string.  We
# validate the parts that are relevant to this API before passing the value as
# one subprocess argument.  The checks below mirror the disallowed refname
# characters and special sequences while allowing slash-separated names such
# as ``refs/heads/team/topic``.
_REF_DISALLOWED = re.compile(r"[\x00-\x20\x7f~^:?*\[\\]")
_REF_ALLOWED_PREFIXES = ("refs/heads/", "refs/remotes/")

# The NULs are structural.  ``git log`` appends a newline after every format
# record, so the first field after each NUL boundary can begin with one.
_REFLOG_FORMAT = "%H%x00%gD%x00%gs%x00%gn%x00%ge%x00"


class ReflogInputError(ValueError):
    """A user supplied reflog ref is outside the explicit API contract."""


def valid_ref(value: Any) -> bool:
    """Return whether *value* is an allowed, complete reflog ref.

    ``HEAD`` is the only symbolic name accepted.  Other refs must be fully
    qualified local/remote refs or the stash ref.  We reject Git revision
    operators and malformed refname fragments before invoking Git.
    """

    if not isinstance(value, str) or not value or len(value) > MAX_REF_LENGTH:
        return False
    if value == "HEAD" or value == "refs/stash":
        return True
    if not value.startswith(_REF_ALLOWED_PREFIXES):
        return False
    tail = value.split("/", 2)[-1] if value.startswith("refs/") else ""
    if not tail or tail.endswith("/") or _REF_DISALLOWED.search(value):
        return False
    # A pair of dots, a component beginning/ending with a dot, ``@{`` and
    # ``.lock`` are not legal Git refs and are also common revision-injection
    # attempts.  Keep this check explicit instead of relying on Git's error
    # text, which varies between versions.
    components = value.split("/")
    if ".." in value or "@{" in value or any(component.endswith(".lock") for component in components):
        return False
    if any(component in {"", ".", ".."} or component.startswith(".") for component in components):
        return False
    if any(component.endswith(".") for component in components):
        return False
    return True


def _validate_ref(value: str) -> str:
    if not valid_ref(value):
        raise ReflogInputError(
            "ref は HEAD、refs/heads/*、refs/remotes/*、refs/stash のいずれかの完全な参照名で指定してください"
        )
    return value


def _selector_date(selector: str) -> str | None:
    """Extract the actual reflog timestamp embedded in ``%gD``."""

    match = _SELECTOR_DATE_RE.search(selector)
    if match is None:
        return None
    value = match.group(1)
    try:
        # Validate the value without normalising it.  Keeping Git's ISO text
        # preserves the offset displayed by the reflog and gives the browser
        # a real instant for local-calendar filtering.
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def _parse_records(raw: str) -> list[dict[str, Any]] | None:
    """Parse the NUL-delimited ``git log -g`` output.

    The final field of each format record is followed by Git's normal newline.
    Removing that separator only at record boundaries keeps newlines inside a
    reflog message intact.
    """

    if raw == "":
        return []
    fields = raw.split("\x00")
    if not fields:
        return []
    # A successful --format command ends in ``<field>\0\n``.  Do not strip
    # arbitrary whitespace: it could be part of an actor or message.
    if fields[-1] == "\n":
        fields.pop()
    elif fields[-1] == "":
        # Be tolerant of a test double or a Git build that omits the trailing
        # newline while still requiring complete NUL records below.
        fields.pop()
    if len(fields) % 5 != 0:
        return None

    records: list[dict[str, Any]] = []
    for offset in range(0, len(fields), 5):
        commit_hash = fields[offset]
        if offset > 0 and commit_hash.startswith("\n"):
            commit_hash = commit_hash[1:]
        selector, message, actor_name, actor_email = fields[offset + 1:offset + 5]
        if _OBJECT_HASH_RE.fullmatch(commit_hash) is None or not selector:
            return None
        actor = actor_name
        if actor_email:
            actor = f"{actor_name} <{actor_email}>" if actor_name else actor_email
        records.append(
            {
                "hash": commit_hash.lower(),
                "selector": selector,
                "message": message,
                "actor": actor or None,
                "date": _selector_date(selector),
            }
        )
    return records


def _inventory(ref: str, records: list[dict[str, Any]], *, truncated: bool, available: bool) -> dict[str, Any]:
    """Build the stable response shape used by the endpoint and UI."""

    return {
        "ref": ref,
        "records": records,
        "truncated": truncated,
        "available": available,
        "command": (
            f"git log -g --max-count={MAX_RECORDS + 1} --date=iso-strict "
            f"--format={_REFLOG_FORMAT} {shlex.quote(ref)} --"
        ),
    }


def _ref_presence(repo: str, ref: str) -> str:
    """Return ``present``, ``missing``, or ``failed`` for one named ref."""

    _output, status = gitinfo._run_with_status(
        repo,
        ["show-ref", "--verify", "--quiet", ref],
    )
    if status == 0:
        return "present"
    if status == 1:
        # ``show-ref`` returns 1 for an unborn HEAD as well as an absent named
        # ref.  Both represent an empty inventory; a command failure has a
        # different status (or a None status from the runner).
        return "missing"
    return "failed"


def _reflog_exists(repo: str, ref: str) -> str:
    """Return ``present``, ``missing``, or ``failed`` for the reflog file."""

    _output, status = gitinfo._run_with_status(repo, ["reflog", "exists", ref])
    if status == 0:
        return "present"
    if status == 1:
        return "missing"
    return "failed"


def get_reflog(repo: str, ref: str) -> dict[str, Any] | None:
    """Read at most :data:`MAX_RECORDS` newest entries from *ref*.

    ``None`` means Git could not execute or the output was malformed.  A
    missing ref or an existing ref without a reflog is a valid empty
    observation and is returned with ``available=False``.  This distinction is
    important to callers: a Git failure must never be presented as an empty
    history.
    """

    ref = _validate_ref(ref)
    presence = _ref_presence(repo, ref)
    if presence == "failed":
        return None
    # Check the reflog file explicitly even when the ref itself is absent.
    # ``show-ref`` and ``reflog exists`` together distinguish an ordinary
    # missing/expired observation from an execution failure.
    log_presence = _reflog_exists(repo, ref)
    if log_presence == "failed":
        return None
    if presence == "missing" or log_presence == "missing":
        return _inventory(ref, [], truncated=False, available=False)

    raw, status = gitinfo._run_with_status(
        repo,
        [
            "log",
            "-g",
            # One extra record tells us whether the bounded response omitted
            # older entries.  Derive this from MAX_RECORDS at call time so a
            # bounded test configuration cannot accidentally widen the read.
            f"--max-count={MAX_RECORDS + 1}",
            "--date=iso-strict",
            f"--format={_REFLOG_FORMAT}",
            ref,
            "--",
        ],
    )
    if status != 0 or raw is None:
        return None
    records = _parse_records(raw)
    if records is None:
        return None
    truncated = len(records) > MAX_RECORDS
    if truncated:
        records = records[:MAX_RECORDS]
    return _inventory(ref, records, truncated=truncated, available=True)


__all__ = [
    "MAX_RECORDS",
    "ReflogInputError",
    "get_reflog",
    "valid_ref",
]
