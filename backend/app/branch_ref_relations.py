"""Calculate exact relations between the Git refs represented by branch rows.

``branch_rows`` is a presentation-oriented structure: a row can contain one
remote tracking ref and zero or more local lanes.  A relation between rows is
therefore insufficient for callers that need to distinguish the local and
remote tips.  This module expands the rows into refs and calculates every
unordered pair from one complete parent graph query.

The hashes in the input are snapshots.  They are intentionally not resolved
again by ref name: a refresh can change a ref while a project response is
being assembled, and doing so would make the relation describe a different
state from the rows shown to the caller.
"""
from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from app import gitinfo


_COMMIT_HASH_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REF_PREFIX_LOCAL = "refs/heads/"
_REF_PREFIX_REMOTE = "refs/remotes/"


@dataclass
class _Ref:
    """Internal ref record, including hash validation state."""

    identifier: str
    row_id: str | None
    name: str
    kind: str
    hash_value: str | None
    valid_hash: str | None
    hash_reason: str | None = None


@dataclass
class _Graph:
    """The result of the single rev-list invocation."""

    parents: dict[str, tuple[str, ...]]
    indexes: dict[str, int]
    hashes: tuple[str, ...]
    reach: dict[str, int]
    children: tuple[tuple[int, ...], ...]
    incomplete: dict[str, bool]
    malformed: bool


def _snapshot_hash(value: Any) -> tuple[str | None, str | None, str | None]:
    """Return ``(display_value, normalized_value, reason)`` for a snapshot.

    Keep malformed strings in the public ref snapshot so the caller can see
    what was supplied, while only a complete SHA is eligible for Git graph
    traversal.  Non-string and empty values are explicit unavailable hashes.
    """

    if not isinstance(value, str) or not value:
        return None, None, "hash_unavailable"
    if _COMMIT_HASH_RE.fullmatch(value) is None:
        return value, None, "invalid_hash"
    return value, value.lower(), None


def _row_id(row: Mapping[str, Any]) -> str | None:
    value = row.get("id")
    return value if isinstance(value, str) and value else None


def _remote_identifier(value: Any) -> tuple[str, str] | None:
    """Return a full remote ref name and its short branch name."""

    if not isinstance(value, str) or not value:
        return None
    if value.startswith(_REF_PREFIX_REMOTE):
        identifier = value
        short = value[len(_REF_PREFIX_REMOTE):]
    elif value.startswith("refs/"):
        # A remote row must not be silently changed into another ref kind.
        return None
    else:
        identifier = f"{_REF_PREFIX_REMOTE}{value}"
        short = value
    if not short or short.endswith("/"):
        return None
    return identifier, short.rsplit("/", 1)[-1]


def _local_identifier(value: Any) -> tuple[str, str] | None:
    """Return a full local ref name and its branch name."""

    if not isinstance(value, str) or not value:
        return None
    if value.startswith(_REF_PREFIX_LOCAL):
        identifier = value
        name = value[len(_REF_PREFIX_LOCAL):]
    elif value.startswith("refs/"):
        # ``lane.branch`` is a local branch name in branch_rows.  Reject an
        # already-qualified ref of another namespace instead of guessing.
        return None
    else:
        identifier = f"{_REF_PREFIX_LOCAL}{value}"
        name = value
    if not name or name.endswith("/"):
        return None
    return identifier, name


def _detached_identifier(lane: Mapping[str, Any]) -> tuple[str, str] | None:
    path = lane.get("path")
    if not isinstance(path, str) or not path:
        return None
    # Prefixing avoids a path colliding with a fully-qualified ref id while
    # retaining the exact path as the identity for a detached worktree.
    return f"detached:{path}", lane.get("name") if isinstance(lane.get("name"), str) and lane.get("name") else "detached HEAD"


def _append_ref(refs: list[_Ref], by_id: dict[str, _Ref], ref: _Ref) -> None:
    """Append a ref, coalescing repeated snapshots of one Git ref.

    Duplicate rows can occur while a branch register is being joined with
    worktree data.  A duplicate with conflicting hashes is evidence that the
    snapshot is ambiguous, so it is retained as an unknown hash rather than
    selecting one occurrence by position.
    """

    previous = by_id.get(ref.identifier)
    if previous is None:
        by_id[ref.identifier] = ref
        refs.append(ref)
        return
    if previous.kind != ref.kind:
        # This should be impossible for the names we generate, but treating it
        # as an unknown ref is safer than allowing a false relation.
        previous.hash_value = None
        previous.valid_hash = None
        previous.hash_reason = "duplicate_ref"
        return
    same_snapshot = (
        previous.hash_value == ref.hash_value
        or (
            previous.valid_hash is not None
            and ref.valid_hash is not None
            and previous.valid_hash == ref.valid_hash
        )
    )
    if not same_snapshot:
        previous.hash_value = None
        previous.valid_hash = None
        previous.hash_reason = "duplicate_ref"


def _refs_from_rows(rows: Sequence[Any]) -> list[_Ref]:
    refs: list[_Ref] = []
    by_id: dict[str, _Ref] = {}

    for raw_row in rows:
        if not isinstance(raw_row, Mapping):
            continue
        row = raw_row
        row_id = _row_id(row)

        remote = _remote_identifier(row.get("remote_ref"))
        if remote is not None:
            identifier, name = remote
            display, normalized, reason = _snapshot_hash(row.get("remote_hash"))
            _append_ref(
                refs,
                by_id,
                _Ref(
                    identifier=identifier,
                    row_id=row_id,
                    name=(row.get("name") if isinstance(row.get("name"), str) and row.get("name") else name),
                    kind="remote",
                    hash_value=display,
                    valid_hash=normalized,
                    hash_reason=reason,
                ),
            )

        lanes = row.get("locals")
        if not isinstance(lanes, list):
            continue
        for raw_lane in lanes:
            if not isinstance(raw_lane, Mapping):
                continue
            lane = raw_lane
            branch = lane.get("branch")
            local = _local_identifier(branch)
            if local is not None:
                identifier, name = local
                display, normalized, reason = _snapshot_hash(lane.get("head"))
                _append_ref(
                    refs,
                    by_id,
                    _Ref(
                        identifier=identifier,
                        row_id=row_id,
                        name=(lane.get("name") if isinstance(lane.get("name"), str) and lane.get("name") else name),
                        kind="local",
                        hash_value=display,
                        valid_hash=normalized,
                        hash_reason=reason,
                    ),
                )
                continue

            # branch_rows marks detached worktrees with ``branch: None``.
            # Honour an explicit detached marker too for sparse test/input
            # rows, but never invent a path when one was not supplied.
            if branch is None or lane.get("detached") is True:
                detached = _detached_identifier(lane)
                if detached is None:
                    continue
                identifier, name = detached
                display, normalized, reason = _snapshot_hash(lane.get("head"))
                _append_ref(
                    refs,
                    by_id,
                    _Ref(
                        identifier=identifier,
                        row_id=row_id,
                        name=name,
                        kind="detached",
                        hash_value=display,
                        valid_hash=normalized,
                        hash_reason=reason,
                    ),
                )

    return refs


def _parse_graph(raw: str, tips: Sequence[str]) -> _Graph | None:
    parents: dict[str, tuple[str, ...]] = {}
    malformed = False
    for line in raw.splitlines():
        fields = line.split()
        if not fields:
            continue
        commit = fields[0].lower()
        if _COMMIT_HASH_RE.fullmatch(commit) is None:
            malformed = True
            continue
        parsed_parents: list[str] = []
        for value in fields[1:]:
            parent = value.lower()
            if _COMMIT_HASH_RE.fullmatch(parent) is None:
                malformed = True
                continue
            parsed_parents.append(parent)
        previous = parents.get(commit)
        current = tuple(dict.fromkeys(parsed_parents))
        if previous is not None and previous != current:
            malformed = True
        else:
            parents[commit] = current

    indexes = {commit: index for index, commit in enumerate(parents)}
    hashes = tuple(parents)
    if malformed:
        # A malformed graph cannot establish negative ancestry facts. Keep the
        # parsed nodes so tip presence can still be reported as a snapshot.
        return _Graph(
            parents=parents,
            indexes=indexes,
            hashes=hashes,
            reach={},
            children=tuple(() for _ in hashes),
            incomplete={},
            malformed=True,
        )

    # Store only O(commits + edges) adjacency. The expensive bitsets below are
    # made for requested tips, not for every commit in the repository.
    parent_indexes: list[tuple[int, ...]] = []
    children_lists: list[list[int]] = [[] for _ in hashes]
    incomplete_bits = 0
    for commit, commit_parents in parents.items():
        commit_index = indexes[commit]
        current_parents: list[int] = []
        for parent in commit_parents:
            parent_index = indexes.get(parent)
            if parent_index is None:
                incomplete_bits |= 1 << commit_index
                continue
            current_parents.append(parent_index)
            children_lists[parent_index].append(commit_index)
        parent_indexes.append(tuple(current_parents))

    # Propagate a mask from every requested tip to its parents. A mask has one
    # bit per tip, so shared history is traversed once and no commit stores its
    # full ancestor bitset.
    tip_masks = [0] * len(hashes)
    tip_indexes: dict[str, int] = {}
    for tip in dict.fromkeys(tips):
        commit_index = indexes.get(tip)
        if commit_index is not None:
            tip_index = len(tip_indexes)
            tip_masks[commit_index] |= 1 << tip_index
            tip_indexes[tip] = tip_index

    child_counts = [len(children) for children in children_lists]
    pending = deque(index for index, count in enumerate(child_counts) if count == 0)
    processed = 0
    while pending:
        commit_index = pending.popleft()
        processed += 1
        mask = tip_masks[commit_index]
        for parent_index in parent_indexes[commit_index]:
            tip_masks[parent_index] |= mask
            child_counts[parent_index] -= 1
            if child_counts[parent_index] == 0:
                pending.append(parent_index)
    if processed != len(hashes):
        malformed = True

    reach_by_tip = [0] * len(tip_indexes)
    for commit_index, mask in enumerate(tip_masks):
        commit_bit = 1 << commit_index
        while mask:
            tip_bit = mask & -mask
            tip_index = tip_bit.bit_length() - 1
            if tip_index < len(reach_by_tip):
                reach_by_tip[tip_index] |= commit_bit
            mask ^= tip_bit

    reach = {
        tip: reach_by_tip[index]
        for tip, index in tip_indexes.items()
        if index < len(reach_by_tip)
    }
    incomplete = {
        tip: bool(reach.get(tip, 0) & incomplete_bits)
        for tip in tip_indexes
    }

    return _Graph(
        parents=parents,
        indexes=indexes,
        hashes=hashes,
        reach=reach,
        children=tuple(tuple(children) for children in children_lists),
        incomplete=incomplete,
        malformed=malformed,
    )


def _graph_for(repo: str, tips: Sequence[str]) -> _Graph | None:
    """Load one parent graph for all valid tip snapshots."""

    if not tips:
        return None
    # The hashes are already validated and normalized.  De-duplicate them so
    # a local and a remote snapshot at the same tip do not enlarge argv or the
    # Git walk.
    unique_tips = list(dict.fromkeys(tips))
    raw = gitinfo._run(
        repo,
        ["rev-list", "--ignore-missing", "--parents", *unique_tips],
    )
    if raw is None:
        return None
    return _parse_graph(raw, unique_tips)


def _shallow_boundaries(repo: str) -> tuple[bool, set[str] | None]:
    """Return shallow state and the exact shallow boundary set.

    A shallow boundary is a real commit object whose parent edges are omitted
    from the local graph.  Reading the file is safe after Git resolves its
    path, and lets a pair prove that the omitted ancestry is shared when both
    tips reach the same boundary set.
    """

    state = gitinfo._run(repo, ["rev-parse", "--is-shallow-repository"])
    shallow = bool(state and state.strip().lower() == "true")
    if not shallow:
        return False, set()
    raw_path = gitinfo._run(repo, ["rev-parse", "--git-path", "shallow"])
    if not raw_path or not raw_path.strip():
        return True, None
    path = Path(raw_path.strip())
    if not path.is_absolute():
        path = Path(repo) / path
    try:
        if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
            return True, None
        lines = path.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError):
        return True, None
    values = {line.strip().lower() for line in lines if line.strip()}
    if not values or not all(_COMMIT_HASH_RE.fullmatch(value) for value in values):
        return True, None
    return True, values


def _merge_bases(graph: _Graph, common: int, hashes: Sequence[str]) -> list[str]:
    """Return every best common ancestor from the common bitset.

    A common commit is best when none of its direct children is also common.
    If a descendant common ancestor existed farther away, the first common
    commit on that path would be a direct common child.  Checking children
    therefore avoids a per-pair merge-base subprocess and handles criss-cross
    histories with multiple best bases.
    """

    if not common:
        return []
    candidates: list[str] = []
    for index, commit in enumerate(hashes):
        bit = 1 << index
        if common & bit and not any(common & (1 << child) for child in graph.children[index]):
            candidates.append(commit)
    return candidates


def _unknown_pair(
    left: _Ref,
    right: _Ref,
    graph: _Graph | None,
    graph_failed: bool,
    shallow: bool,
) -> tuple[str, str]:
    """Return ``(reason, status)`` for a pair that cannot be fully classified."""

    if left.valid_hash is None:
        return left.hash_reason or "hash_unavailable", "unknown"
    if right.valid_hash is None:
        return right.hash_reason or "hash_unavailable", "unknown"
    if graph_failed or graph is None:
        return "ancestry_unavailable", "unknown"
    if left.valid_hash not in graph.parents or right.valid_hash not in graph.parents:
        return "missing_object", "unknown"
    if shallow:
        return "shallow_history", "unknown"
    if graph.malformed or graph.incomplete.get(left.valid_hash) or graph.incomplete.get(right.valid_hash):
        return "missing_object", "unknown"
    return "ancestry_unavailable", "unknown"


def _pair(
    left: _Ref,
    right: _Ref,
    graph: _Graph | None,
    graph_failed: bool,
    shallow: bool,
    boundary_bits: int | None,
    commit_hashes: Sequence[str],
    merge_base_cache: dict[int, list[str]],
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "left_ref_id": left.identifier,
        "right_ref_id": right.identifier,
        "relation": "unknown",
        "left_only": None,
        "right_only": None,
        "reason": None,
        "merge_bases": None,
    }

    if left.valid_hash is None or right.valid_hash is None:
        base["reason"], _ = _unknown_pair(left, right, graph, graph_failed, shallow)
        return base
    if left.valid_hash == right.valid_hash:
        base["relation"] = "equal"
        base["left_only"] = 0
        base["right_only"] = 0
        if graph is not None and left.valid_hash in graph.parents:
            base["merge_bases"] = [left.valid_hash]
        return base

    reason, _ = _unknown_pair(left, right, graph, graph_failed, shallow)
    if graph_failed or graph is None:
        base["reason"] = reason
        return base
    left_bits = graph.reach.get(left.valid_hash)
    right_bits = graph.reach.get(right.valid_hash)
    if left_bits is None or right_bits is None:
        base["reason"] = reason
        return base

    # A direct membership test is the proof of inclusion.  Even when a
    # shallow/missing-parent boundary exists, an observed path to the other
    # tip is a sound positive ancestry fact.  Counts and merge bases remain
    # unknown until the full graph is available.
    right_bit = 1 << graph.indexes[right.valid_hash]
    left_bit = 1 << graph.indexes[left.valid_hash]
    left_contains_right = bool(left_bits & right_bit)
    right_contains_left = bool(right_bits & left_bit)
    shared_boundary = False
    if shallow and boundary_bits is not None:
        shared_boundary = (left_bits & boundary_bits) == (right_bits & boundary_bits)
    uncertain_graph = (
        shallow
        or graph.malformed
        or graph.incomplete.get(left.valid_hash, False)
        or graph.incomplete.get(right.valid_hash, False)
    )
    if shallow and shared_boundary and not graph.malformed:
        uncertain_graph = (
            graph.incomplete.get(left.valid_hash, False)
            or graph.incomplete.get(right.valid_hash, False)
        )

    if left_contains_right:
        base["relation"] = "ahead"
        if not uncertain_graph:
            base["left_only"] = (left_bits & ~right_bits).bit_count()
            base["right_only"] = 0
            common = left_bits & right_bits
            if common not in merge_base_cache:
                merge_base_cache[common] = _merge_bases(graph, common, commit_hashes)
            base["merge_bases"] = list(merge_base_cache[common])
        else:
            base["reason"] = "shallow_history" if shallow else "missing_object"
        return base
    if right_contains_left:
        base["relation"] = "behind"
        if not uncertain_graph:
            base["left_only"] = 0
            base["right_only"] = (right_bits & ~left_bits).bit_count()
            common = left_bits & right_bits
            if common not in merge_base_cache:
                merge_base_cache[common] = _merge_bases(graph, common, commit_hashes)
            base["merge_bases"] = list(merge_base_cache[common])
        else:
            base["reason"] = "shallow_history" if shallow else "missing_object"
        return base

    if uncertain_graph:
        base["reason"] = "shallow_history" if shallow else "missing_object"
        return base

    common = left_bits & right_bits
    if not common:
        base["relation"] = "unrelated"
        base["left_only"] = left_bits.bit_count()
        base["right_only"] = right_bits.bit_count()
        base["merge_bases"] = []
        return base

    base["relation"] = "diverged"
    base["left_only"] = (left_bits & ~right_bits).bit_count()
    base["right_only"] = (right_bits & ~left_bits).bit_count()
    if common not in merge_base_cache:
        merge_base_cache[common] = _merge_bases(graph, common, commit_hashes)
    base["merge_bases"] = list(merge_base_cache[common])
    return base


def build(repo: str, rows: list[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Return ref snapshots and exact pair relations for ``branch_rows``.

    ``rows=None`` means branch-row acquisition failed and is represented as an
    unavailable result.  An empty list is a valid empty register.  Every
    malformed or missing hash remains a ref when its identity is known, but
    all pairs involving it are explicitly unknown.
    """

    if rows is None:
        return {"refs": [], "pairs": [], "ancestry_status": "unavailable"}
    if not isinstance(rows, list):
        return {"refs": [], "pairs": [], "ancestry_status": "unavailable"}

    refs = _refs_from_rows(rows)
    public_refs = [
        {
            "id": ref.identifier,
            "row_id": ref.row_id,
            "name": ref.name,
            "kind": ref.kind,
            "hash": ref.hash_value,
        }
        for ref in refs
    ]
    if len(refs) < 2:
        # No pair needs ancestry.  Empty rows are a successful empty view;
        # refs with unusable hashes are a partial view of the register.
        status = "complete" if not refs or all(ref.valid_hash is not None for ref in refs) else "partial"
        return {"refs": public_refs, "pairs": [], "ancestry_status": status}

    valid_tips = [ref.valid_hash for ref in refs if ref.valid_hash is not None]
    graph = _graph_for(repo, valid_tips)
    graph_failed = bool(valid_tips) and graph is None
    shallow, boundaries = _shallow_boundaries(repo) if graph is not None else (False, set())
    boundary_bits: int | None = None
    if shallow and boundaries is not None and graph is not None:
        boundary_bits = 0
        for boundary in boundaries:
            index = graph.indexes.get(boundary)
            if index is not None:
                boundary_bits |= 1 << index

    commit_hashes = graph.hashes if graph is not None else ()
    merge_base_cache: dict[int, list[str]] = {}
    pairs: list[dict[str, Any]] = []
    for left_index, left in enumerate(refs[:-1]):
        for right in refs[left_index + 1:]:
            pairs.append(
                _pair(
                    left,
                    right,
                    graph,
                    graph_failed,
                    shallow,
                    boundary_bits,
                    commit_hashes,
                    merge_base_cache,
                )
            )

    if graph_failed:
        ancestry_status = "unavailable"
    elif shallow:
        ancestry_status = "shallow"
    elif any(ref.valid_hash is None for ref in refs):
        ancestry_status = "partial"
    elif graph is None:
        ancestry_status = "partial"
    elif (
        any(ref.valid_hash not in graph.parents for ref in refs if ref.valid_hash is not None)
        or any(graph.incomplete.values())
        or graph.malformed
    ):
        ancestry_status = "partial"
    else:
        ancestry_status = "complete"

    return {
        "refs": public_refs,
        "pairs": pairs,
        "ancestry_status": ancestry_status,
    }
