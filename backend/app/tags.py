"""Read-only inspection of Git tags.

The inventory is deliberately built from ``for-each-ref`` rather than from
``git tag`` output.  The NUL-delimited format keeps tag names and identities
intact, while the full ``refs/tags/`` namespace makes the object represented
by each row explicit.  No operation in this module updates refs, verifies
signatures, or contacts a remote.
"""
from __future__ import annotations

import re
from typing import Any

from app import gitinfo


FULL_HASH_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")

# The trailing NUL is intentional.  Git writes one extra newline after the
# final record; the parser removes only that newline and never splits fields
# on line boundaries.
REF_FORMAT = (
    "%(refname)%00%(objectname)%00%(objecttype)%00"
    "%(*objectname)%00%(*objecttype)%00"
    "%(creatordate:iso-strict)%00%(creator)%00"
)
LIST_COMMAND = f"git for-each-ref --format={REF_FORMAT} refs/tags/"

# Tag messages are untrusted repository data.  Keep the response bounded even
# when a tag object contains a very large message.  A little extra room is
# read so the fixed headers remain available when the message is truncated.
TAG_MESSAGE_MAX_BYTES = 64_000
TAG_OBJECT_READ_MAX_BYTES = TAG_MESSAGE_MAX_BYTES + 16_384


class TagNotFound(LookupError):
    """The requested tag is not present in the current inventory."""


class TagInputError(ValueError):
    """The requested tag name cannot identify a Git tag ref."""


def _valid_hash(value: str) -> bool:
    return FULL_HASH_RE.fullmatch(value) is not None


def _parse_inventory(raw: str) -> list[dict[str, Any]] | None:
    """Parse the NUL-delimited ``for-each-ref`` output.

    ``objectname`` is the direct object of the ref (a tag object for an
    annotated tag, and the target for a lightweight tag).  The ``*`` atoms
    are the recursively peeled object for annotated tags; lightweight tags
    have no peeled atom, so their direct object is used as the peeled target.
    """

    fields = raw.split("\0")
    if fields and fields[-1] in {"", "\n"}:
        fields.pop()
    if len(fields) % 7 != 0:
        return None

    tags: list[dict[str, Any]] = []
    for offset in range(0, len(fields), 7):
        refname, object_hash, object_type, peeled_hash, peeled_type, creator_date, creator = fields[offset:offset + 7]
        # ``for-each-ref`` appends a newline after every formatted record,
        # including before the next record's refname.  Refnames cannot contain
        # newlines, so remove only that record separator here; all other field
        # contents remain byte-for-byte intact.
        if offset and refname.startswith("\n"):
            refname = refname[1:]
        if not refname.startswith("refs/tags/"):
            return None
        name = refname[len("refs/tags/"):]
        if not name or not _valid_hash(object_hash):
            return None
        if object_type not in {"commit", "tree", "blob", "tag"}:
            return None

        annotated = object_type == "tag"
        if annotated:
            if not _valid_hash(peeled_hash) or peeled_type not in {"commit", "tree", "blob", "tag"}:
                return None
            target_hash = peeled_hash
            target_type = peeled_type
        else:
            # Git intentionally leaves *objectname/*objecttype empty for a
            # lightweight tag.  Its object is still the tag target.
            if peeled_hash or peeled_type:
                return None
            target_hash = object_hash
            target_type = object_type

        tags.append(
            {
                "name": name,
                "type": "annotated" if annotated else "lightweight",
                "hash": object_hash,
                "peeled_hash": target_hash,
                "peeled_type": target_type,
                "creator": creator or None,
                "creator_date": creator_date or None,
            }
        )
    return tags


def get_tags(repo: str) -> dict[str, Any] | None:
    """Return the current tag inventory, or ``None`` when Git cannot read it.

    An empty repository is represented by ``{"tags": []}``; it is distinct
    from a failed Git invocation.
    """

    raw = gitinfo._run(repo, ["for-each-ref", f"--format={REF_FORMAT}", "refs/tags/"])
    if raw is None:
        return None
    tags = _parse_inventory(raw)
    if tags is None:
        return None
    return {"tags": tags, "command": LIST_COMMAND}


def _valid_tag_name(name: str) -> bool:
    """Validate a tag component with Git's ref-name checker.

    The name is supplied as one argv item and is never interpolated into a
    shell command.  ``check-ref-format`` also keeps unusual but valid names
    (spaces, Unicode, and nested components) available to the exact lookup.
    """

    if not isinstance(name, str) or not name or "\x00" in name:
        return False
    # Keep validation local so the untrusted name never becomes an option or
    # a shell fragment in the detail path.
    if name.startswith("/") or name.endswith("/") or name.endswith("."):
        return False
    if name.startswith("."):
        return False
    if ".." in name or "@{" in name or "\\" in name:
        return False
    if any(ord(char) < 0x20 or ord(char) == 0x7F or char == " " for char in name):
        return False
    if any(char in name for char in "~^:?*[\\"):
        return False
    components = name.split("/")
    if any(component in {"", ".", ".."} for component in components):
        return False
    if any(
        component.startswith(".")
        or component.endswith(".")
        or component.endswith(".lock")
        for component in components
    ):
        return False
    return True


def _truncate_utf8(value: str, limit: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value, False
    return encoded[:limit].decode("utf-8", errors="ignore"), True


def _parse_tag_object(raw: str, summary: dict[str, Any]) -> dict[str, Any] | None:
    """Parse a bounded annotated tag object into metadata and message."""

    header_text, separator, message = raw.partition("\n\n")
    if not separator:
        return None
    headers: dict[str, str] = {}
    for line in header_text.split("\n"):
        key, separator, value = line.partition(" ")
        if not separator or not key:
            return None
        headers[key] = value

    object_hash = headers.get("object", "")
    object_type = headers.get("type", "")
    tag_name = headers.get("tag", "")
    if not _valid_hash(object_hash) or object_type not in {"commit", "tree", "blob", "tag"} or not tag_name:
        return None

    bounded_message, message_truncated = _truncate_utf8(message, TAG_MESSAGE_MAX_BYTES)
    return {
        "object_hash": object_hash,
        "object_type": object_type,
        "tag": tag_name,
        "tagger": summary["creator"],
        "tagger_date": summary["creator_date"],
        "message": bounded_message,
        "message_truncated": message_truncated,
        "command": f"git cat-file tag {summary['hash']}",
    }


def get_tag(repo: str, name: str) -> dict[str, Any] | None:
    """Return one exact tag and its bounded annotation, if present.

    Membership in the just-read inventory prevents this endpoint from
    becoming an arbitrary object viewer.  A lightweight tag has
    ``annotation: None``; an annotated tag has its fixed ``cat-file tag``
    metadata and message.  The peeled target is returned in the same summary
    fields as the inventory so callers can reuse the existing commit endpoint
    only when ``peeled_type == "commit"``.
    """

    if not _valid_tag_name(name):
        raise TagInputError("invalid tag name")
    inventory = get_tags(repo)
    if inventory is None:
        return None
    summary = next((item for item in inventory["tags"] if item["name"] == name), None)
    if summary is None:
        raise TagNotFound("tag is not present")

    result = {**summary, "annotation": None}
    if summary["type"] == "lightweight":
        return result

    raw = gitinfo._run_limited(
        repo,
        ["cat-file", "tag", "--", summary["hash"]],
        TAG_OBJECT_READ_MAX_BYTES,
    )
    if raw is None:
        # A ref may disappear between inventory and detail reads.  Recheck
        # membership so the API can distinguish that race from Git failure.
        refreshed = get_tags(repo)
        if refreshed is not None and not any(item["name"] == name for item in refreshed["tags"]):
            raise TagNotFound("tag is no longer present")
        return None
    annotation = _parse_tag_object(raw, summary)
    if annotation is None:
        return None
    result["annotation"] = annotation
    return result
