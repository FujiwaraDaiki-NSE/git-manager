"""Read-only inventory of refs that contain one explicitly pinned commit.

The containment query is deliberately a snapshot operation.  A revision is
resolved to a complete commit id first, and ``for-each-ref --contains`` is
then run against the local heads, remote-tracking refs, and tags.  No fetch,
remote negotiation, or ref update is performed here.

Both the number of records and the bytes retained from Git are bounded.  The
result therefore describes the observed snapshot and says when the inventory
may be incomplete instead of allowing a repository with arbitrary ref names
to create an unbounded response.
"""
from __future__ import annotations

import os
import re
import selectors
import subprocess
import time
from typing import Any

from app import config, gitinfo, repository_files


# Keep these public so the API layer and focused tests can state the same
# limits as the implementation.  Four MiB is enough for unusually long ref
# names while still putting a hard ceiling on the retained Git output.
MAX_REFS = 1_000
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_REVISION_LENGTH = 512

_HASH_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$", re.IGNORECASE)
_REVISION_OPERATOR_RE = re.compile(r"(?:\.\.|~|\^|:|@\{)")
_REF_DISALLOWED_RE = re.compile(r"[\x00-\x20\x7f~^:?*\[\\]")

# The NUL separators are structural.  Git appends a newline after each
# formatted record; the parser removes only that record separator and never
# splits a ref on whitespace.
REF_FORMAT = (
    "%(refname)%00%(objectname)%00%(objecttype)%00"
    "%(*objectname)%00%(*objecttype)%00"
)
CONTAINMENT_COMMAND = (
    "git for-each-ref --contains=<pinned-commit> --sort=refname "
    f"--format={REF_FORMAT} refs/heads refs/remotes refs/tags"
)


class CommitContainmentInputError(repository_files.RepositoryFilesInputError):
    """A containment revision is outside the explicit input contract."""


def valid_revision(value: Any) -> bool:
    """Return whether *value* is a single safe ref/hash candidate.

    ``repository_files._resolve_revision`` performs the final Git-backed
    validation and resolution.  This local predicate is used by callers that
    need to disable an action before invoking Git, and makes the contract
    explicit: HEAD, a ref name, or a complete object id is accepted; revision
    expressions and option-like values are not.
    """

    if not isinstance(value, str) or not value or "\x00" in value:
        return False
    if len(value) > MAX_REVISION_LENGTH:
        return False
    if value.startswith("-") or _REVISION_OPERATOR_RE.search(value):
        return False
    if any(ord(character) < 0x20 or character.isspace() for character in value):
        return False
    if _HASH_RE.fullmatch(value):
        return True
    if value == "HEAD":
        return True

    # A short branch/tag name is a valid Git revision candidate, as are the
    # fully qualified namespaces shown by the project UI.  Reject malformed
    # ref components before passing the value to Git.  The resolver still
    # verifies that it actually names a commit in this repository.
    if value.startswith("/") or value.endswith("/") or value.endswith("."):
        return False
    if ".." in value or "@{" in value or _REF_DISALLOWED_RE.search(value):
        return False
    components = value.split("/")
    if any(
        not component
        or component in {".", ".."}
        or component.startswith(".")
        or component.endswith(".")
        or component.endswith(".lock")
        for component in components
    ):
        return False
    return True


def _validate_revision(value: str) -> str:
    if not valid_revision(value):
        raise CommitContainmentInputError(
            "revision は HEAD、単一のコミットハッシュ、またはGit refで指定してください"
        )
    return value


def _read_limited(repo: str, args: list[str], limit: int) -> tuple[bytes, bool] | None:
    """Run Git while retaining at most ``limit`` bytes of stdout.

    ``subprocess.run(capture_output=True)`` is intentionally avoided here:
    ref names are repository data and could make its output arbitrarily large.
    A selector keeps the timeout effective even when Git fills the pipe.
    """

    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    output = bytearray()
    timeout = config.GIT_TIMEOUT_SEC
    try:
        process = subprocess.Popen(
            [gitinfo.GIT, "-C", repo, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, **gitinfo.NON_INTERACTIVE_ENV},
        )
        if process.stdout is None:
            raise OSError("git stdout is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        truncated = False
        while len(output) <= limit:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(process.args, timeout)
            # Read one byte beyond the limit so a producer that has more data
            # is distinguishable from an output that ended exactly at the cap.
            chunk = os.read(process.stdout.fileno(), min(64 * 1024, limit + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > limit:
                truncated = True
                break

        if truncated:
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass
            return bytes(output[:limit]), True

        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            return None
        return bytes(output), False
    except (OSError, subprocess.TimeoutExpired):
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


def _decode_field(value: bytes, *, ascii_only: bool = False) -> str | None:
    try:
        return value.decode("ascii" if ascii_only else "utf-8", errors="strict")
    except UnicodeDecodeError:
        # A ref name can contain valid non-ASCII UTF-8.  Object metadata is
        # ASCII by Git's grammar, so callers request strict ASCII there.
        if ascii_only:
            return None
        return value.decode("utf-8", errors="replace")


def _parse_records(raw: bytes, *, allow_incomplete: bool = False) -> list[dict[str, str]] | None:
    """Parse complete NUL records from a bounded for-each-ref response."""

    if not raw:
        return []
    fields = raw.split(b"\x00")
    # A normal successful response ends with ``field\0\n``.  Test doubles and
    # some older Git versions may omit the final newline, so accept ``field\0``
    # as well.  If the bounded reader cut through a record, discard only that
    # incomplete tail when the caller already knows the output was truncated.
    if fields[-1] in {b"", b"\n"}:
        fields.pop()
    if len(fields) % 5:
        if not allow_incomplete:
            return None
        fields = fields[: len(fields) - (len(fields) % 5)]

    records: list[dict[str, str]] = []
    for offset in range(0, len(fields), 5):
        ref_bytes, object_bytes, object_type_bytes, peeled_bytes, peeled_type_bytes = fields[offset:offset + 5]
        if offset and ref_bytes.startswith(b"\n"):
            ref_bytes = ref_bytes[1:]
        ref = _decode_field(ref_bytes)
        object_hash = _decode_field(object_bytes, ascii_only=True)
        object_type = _decode_field(object_type_bytes, ascii_only=True)
        peeled_hash = _decode_field(peeled_bytes, ascii_only=True)
        peeled_type = _decode_field(peeled_type_bytes, ascii_only=True)
        if ref is None or object_hash is None or object_type is None or peeled_hash is None or peeled_type is None:
            return None
        if not ref.startswith(("refs/heads/", "refs/remotes/", "refs/tags/")):
            return None
        if not _HASH_RE.fullmatch(object_hash):
            return None
        if object_type not in {"commit", "tag"}:
            # A heads/remotes ref may be manually pointed at another object.
            # It is not a commit-containing ref and is omitted deliberately.
            continue

        if object_type == "commit":
            if peeled_hash or peeled_type:
                return None
            peeled_commit = object_hash
        else:
            # ``%(*objectname)``/``%(*objecttype)`` recursively peel nested
            # tag objects in supported Git versions.  Keep only commit tags;
            # tree/blob tags do not contain a commit and are ignored.
            if peeled_type != "commit" or not _HASH_RE.fullmatch(peeled_hash):
                continue
            peeled_commit = peeled_hash

        if ref.startswith("refs/heads/"):
            ref_type = "local"
        elif ref.startswith("refs/remotes/"):
            ref_type = "remote"
        else:
            ref_type = "tag"
        records.append(
            {
                "ref": ref,
                "object_hash": object_hash.lower(),
                "peeled_commit": peeled_commit.lower(),
                "type": ref_type,
            }
        )
    return records


def _inventory(
    revision: str,
    pinned_hash: str,
    refs: list[dict[str, str]],
    *,
    truncated: bool,
) -> dict[str, Any]:
    return {
        "revision": revision,
        "pinned_hash": pinned_hash,
        "refs": refs,
        "observed_at": time.time(),
        "truncated": truncated,
        "record_limit": MAX_REFS,
        "byte_limit": MAX_OUTPUT_BYTES,
        "command": CONTAINMENT_COMMAND.replace("<pinned-commit>", pinned_hash),
    }


def get_containment(repo: str, revision: str) -> dict[str, Any] | None:
    """Return the refs containing *revision* as one bounded Git snapshot.

    ``None`` means the revision cannot be resolved or Git failed/malformed its
    response.  A valid commit with no matching refs returns a successful
    inventory whose ``refs`` list is empty, allowing callers to distinguish
    no matches from an unknown fault.
    """

    value = _validate_revision(revision)
    # Reuse the repository-files resolver so all read-only revision endpoints
    # pin a single complete commit hash using the same validation rules.
    pinned_hash = repository_files._resolve_revision(repo, value)
    if pinned_hash is None:
        return None

    bounded = _read_limited(
        repo,
        [
            "for-each-ref",
            f"--contains={pinned_hash}",
            "--sort=refname",
            f"--format={REF_FORMAT}",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        MAX_OUTPUT_BYTES,
    )
    if bounded is None:
        return None
    raw, output_truncated = bounded
    records = _parse_records(raw, allow_incomplete=output_truncated)
    if records is None:
        return None
    record_truncated = len(records) > MAX_REFS
    return _inventory(
        value,
        pinned_hash,
        records[:MAX_REFS],
        truncated=output_truncated or record_truncated,
    )


__all__ = [
    "CONTAINMENT_COMMAND",
    "CommitContainmentInputError",
    "MAX_OUTPUT_BYTES",
    "MAX_REFS",
    "REF_FORMAT",
    "get_containment",
    "valid_revision",
]
