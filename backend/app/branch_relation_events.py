"""ブランチ間の操作を Git reflog から復元する。

``branch_rows.connections`` が現在の ref 間比較をまとめるのに対して、
このモジュールは reflog に残っている操作そのものを証拠として扱う。PR の
情報や表示用のグラフの先頭ページには依存しない。したがって、操作後に対象
ブランチが reset されても、コミットオブジェクトが残っている限り、当時の
SHA と操作時刻を保持した関係を返す。

reflog は保持期間のある観測記録なので、取得できたことは全過去の網羅を
意味しない。取得状態は既存のブランチ関係 API と同じ
``available`` / ``partial`` / ``unavailable`` で返し、名前や SHA だけから
ブランチを推測することはしない。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import os
import re
from typing import Any, Mapping

from app import branch_history, gitinfo


_COMMIT_HASH_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REFLOG_FORMAT = "%H%x1f%gD%x1f%gs%x1f%cI"
_BRANCH_CREATE_RE = re.compile(r"^branch: Created from (?P<source>.+)$")
_CHECKOUT_RE = re.compile(r"^checkout: moving from (?P<old>.+) to (?P<new>.+)$")
_RENAME_RE = re.compile(
    r"^Branch: renamed refs/heads/(?P<old>.+) to refs/heads/(?P<new>.+)$"
)


@dataclass(frozen=True)
class _Binding:
    """A row identity for one complete Git ref."""

    full_ref: str
    row_id: str
    kind: str
    display: str


@dataclass(frozen=True)
class _Token:
    raw: str
    full_ref: str | None
    bindings: tuple[_Binding, ...]
    reason: str | None = None


@dataclass(frozen=True)
class _Event:
    """One parsed reflog operation before endpoint resolution."""

    reflog_ref: str
    target_ref: str | None
    after: str
    occurred_at: str | None
    commit_date: str | None
    action: str
    operation: str
    kind: str
    source_tokens: tuple[str, ...]
    old_hash: str | None
    sequence: int


@dataclass(frozen=True)
class _RefTimeline:
    """The historical names occupied by one surviving local ref."""

    initial_name: str
    transitions: tuple[tuple[str | None, str, str], ...]
    activation_at: str | None


def _is_hash(value: Any) -> bool:
    return isinstance(value, str) and _COMMIT_HASH_RE.fullmatch(value) is not None


def _full_local_ref(branch: str) -> str:
    return branch if branch.startswith("refs/heads/") else f"refs/heads/{branch}"


def _full_remote_ref(remote_ref: str) -> str:
    return (
        remote_ref
        if remote_ref.startswith("refs/remotes/")
        else f"refs/remotes/{remote_ref}"
    )


def _operation_time(selector: str) -> str | None:
    """Extract and validate the ISO timestamp embedded in ``%gD``."""
    marker = "@{"
    if marker not in selector or not selector.endswith("}"):
        return None
    value = selector.rsplit(marker, 1)[1][:-1]
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def _read_reflog(repo: str, ref: str) -> tuple[list[dict[str, Any]] | None, str]:
    """Read one ref's reflog without invoking a shell.

    The status is ``ok`` for a successful (possibly empty) reflog, ``missing``
    when the ref no longer exists, and ``failed`` for an execution or parse
    failure. A missing remote-tracking ref is a normal absence of evidence and
    must not turn an otherwise healthy snapshot into a partial failure.
    """
    output, status = gitinfo._run_with_status(
        repo,
        [
            "reflog",
            "show",
            "--date=iso-strict",
            f"--format={_REFLOG_FORMAT}",
            ref,
        ],
    )
    if status != 0 or output is None:
        if status == 1:
            return [], "missing"
        # ``reflog show`` uses status 128 for both a missing ref and a command
        # failure. Verify the ref separately so an expired/deleted remote ref
        # remains an ordinary no-record observation.
        _verified, verify_status = gitinfo._run_with_status(
            repo, ["show-ref", "--verify", "--quiet", ref]
        )
        if verify_status == 1:
            return [], "missing"
        return None, "failed"
    entries: list[dict[str, Any]] = []
    for sequence, line in enumerate(output.splitlines()):
        fields = line.split("\x1f", 3)
        if len(fields) != 4:
            return None, "failed"
        after, selector, action, commit_date = fields
        if not _is_hash(after):
            # A reflog entry may point at an expired object, but Git still
            # prints its complete SHA. A malformed SHA is not evidence.
            return None, "failed"
        entries.append(
            {
                "after": after,
                "selector": selector,
                "action": action,
                "occurred_at": _operation_time(selector),
                "commit_date": commit_date if commit_date else None,
                "sequence": sequence,
            }
        )
    return entries, "ok"


def _worktree_head_refs(repo: str) -> tuple[list[str], str]:
    """Enumerate Git's retained per-worktree HEAD reflog refs.

    The worktree directory may already be prunable or removed while Git keeps
    ``worktrees/<id>/HEAD`` in the common reflog. Reading the ref by its name
    avoids relying on a filesystem path that no longer exists.
    """
    output, status = gitinfo._run_with_status(
        repo,
        [
            "reflog",
            "show",
            "--all",
            "--date=iso-strict",
            "--format=%gD",
        ],
    )
    if status != 0 or output is None:
        return [], "failed"
    refs: set[str] = set()
    for selector in output.splitlines():
        value = selector.strip()
        if "@{" not in value:
            continue
        ref = value.rsplit("@{", 1)[0]
        if ref.startswith("worktrees/") and ref.endswith("/HEAD"):
            refs.add(ref)
    return sorted(refs), "ok"


def _rows_and_bindings(
    rows: list[Mapping[str, Any]],
) -> tuple[dict[str, list[_Binding]], dict[str, Mapping[str, Any]], set[str]]:
    by_ref: dict[str, list[_Binding]] = {}
    by_id: dict[str, Mapping[str, Any]] = {}
    remote_names: set[str] = set()

    def add(binding: _Binding) -> None:
        existing = by_ref.setdefault(binding.full_ref, [])
        if not any(
            item.row_id == binding.row_id and item.kind == binding.kind
            for item in existing
        ):
            existing.append(binding)

    for row in rows:
        if not isinstance(row, Mapping):
            continue
        row_id = row.get("id")
        if not isinstance(row_id, str) or not row_id:
            continue
        by_id[row_id] = row
        remote_ref = row.get("remote_ref")
        if isinstance(remote_ref, str) and remote_ref:
            full_ref = _full_remote_ref(remote_ref)
            add(_Binding(full_ref, row_id, "remote", remote_ref))
            parts = remote_ref.removeprefix("refs/remotes/").split("/", 1)
            if parts[0]:
                remote_names.add(parts[0])
        locals_ = row.get("locals")
        if not isinstance(locals_, list):
            continue
        for lane in locals_:
            if not isinstance(lane, Mapping):
                continue
            branch = lane.get("branch")
            if not isinstance(branch, str) or not branch:
                continue
            add(_Binding(_full_local_ref(branch), row_id, "local", branch))
    return by_ref, by_id, remote_names


def _remote_names(repo: str) -> set[str]:
    """Return configured remote namespaces for slash-containing names.

    A local branch may itself contain a slash. A token such as
    ``origin/topic`` is treated as a remote ref only when ``origin`` is a
    known remote, avoiding a local/remote name collision.
    """
    raw = gitinfo._run(repo, ["remote"])
    return {line.strip() for line in raw.splitlines() if line.strip()} if raw else set()


def _historical_aliases(
    by_ref: Mapping[str, list[_Binding]],
    reflogs: Mapping[str, list[dict[str, Any]] | None],
) -> dict[str, tuple[tuple[_Binding, str | None], ...]]:
    """Map a renamed historical local ref name to its current incarnation.

    ``git branch -m`` copies the old branch's reflog to the new ref and keeps
    an explicit rename entry. That entry is stronger than a name-only guess,
    but it is time bounded: an event after the rename must use a newly created
    old ref, while an equal-second rename cannot establish the order.
    """
    rename_edges: dict[str, list[tuple[str, str | None]]] = {}
    for entries in reflogs.values():
        if entries is None:
            continue
        for entry in entries:
            action = entry.get("action")
            if not isinstance(action, str):
                continue
            rename = _RENAME_RE.fullmatch(action)
            if rename is None:
                continue
            old_ref = _full_local_ref(rename.group("old"))
            new_ref = _full_local_ref(rename.group("new"))
            edge = (new_ref, entry.get("occurred_at"))
            if edge not in rename_edges.setdefault(old_ref, []):
                rename_edges[old_ref].append(edge)

    aliases: dict[str, list[tuple[_Binding, str | None]]] = {}

    def visit(
        original_ref: str,
        current_ref: str,
        first_rename_at: str | None,
        visited: set[str],
    ) -> None:
        if current_ref in visited:
            return
        visited.add(current_ref)
        bindings = by_ref.get(current_ref, ())
        if bindings and len(bindings) == 1 and current_ref != original_ref:
            candidate = (bindings[0], first_rename_at)
            if candidate not in aliases.setdefault(original_ref, []):
                aliases[original_ref].append(candidate)
        # A historical name can have a current binding after a later
        # delete-and-recreate. Continue through rename edges even in that
        # case; stopping here would select the recreated name over the
        # original renamed incarnation.
        for next_ref, renamed_at in rename_edges.get(current_ref, ()):
            visit(
                original_ref,
                next_ref,
                first_rename_at if first_rename_at is not None else renamed_at,
                set(visited),
            )

    for old_ref in rename_edges:
        visit(old_ref, old_ref, None, set())
    return {ref: tuple(candidates) for ref, candidates in aliases.items()}


def _ref_timelines(
    by_ref: Mapping[str, list[_Binding]],
    reflogs: Mapping[str, list[dict[str, Any]] | None],
) -> dict[str, _RefTimeline]:
    """Reconstruct the names occupied by each surviving local ref over time.

    A rename copies the source reflog to the new ref. Consequently the newest
    ref name alone cannot identify which incarnation owned an old operation:
    the copied log may contain both the old and the new names, and a later
    delete/recreate may reuse either one. The chronological rename chain and
    the first creation marker provide the small amount of identity evidence
    needed by source endpoint resolution.
    """
    timelines: dict[str, _RefTimeline] = {}
    for ref, bindings in by_ref.items():
        if not ref.startswith("refs/heads/") or len(bindings) != 1:
            continue
        entries = reflogs.get(ref)
        if entries is None or not entries:
            continue
        chronological = list(reversed(entries))
        transitions: list[tuple[str | None, str, str]] = []
        activation_times: list[str] = []
        for entry in chronological:
            action = entry.get("action")
            occurred_at = entry.get("occurred_at")
            if not isinstance(action, str):
                continue
            branch_create = _BRANCH_CREATE_RE.fullmatch(action)
            rename = _RENAME_RE.fullmatch(action)
            if branch_create is not None and isinstance(occurred_at, str):
                activation_times.append(occurred_at)
            if rename is None:
                continue
            transitions.append(
                (
                    occurred_at if isinstance(occurred_at, str) else None,
                    rename.group("old"),
                    rename.group("new"),
                )
            )

        if transitions:
            # The first rename's old side is the name held by this reflog
            # before the copied rename chain began. This is also true for a
            # branch that was created as ``old`` and later renamed to ``new``.
            initial_name = transitions[0][1]
        else:
            initial_name = ref.removeprefix("refs/heads/")
        activation_at = min(activation_times) if activation_times else None
        timelines[ref] = _RefTimeline(
            initial_name=initial_name,
            transitions=tuple(transitions),
            activation_at=activation_at,
        )
    return timelines


def _timeline_name_at(
    timeline: _RefTimeline,
    occurred_at: str | None,
) -> tuple[str | None, bool]:
    """Return ``(name, active)`` for a ref at one reflog operation time.

    Equal-second operations do not prove ordering. Treating them as
    ambiguous is necessary for the delete/recreate case where Git copied the
    same SHA into a fresh ref in the same second as the historical operation.
    """
    if occurred_at is None:
        return None, False if timeline.transitions or timeline.activation_at else True
    if timeline.activation_at is not None and timeline.activation_at >= occurred_at:
        return None, False

    name = timeline.initial_name
    for transition_at, old_name, new_name in timeline.transitions:
        if transition_at is None:
            return None, False
        if transition_at < occurred_at:
            name = new_name
            continue
        if transition_at == occurred_at:
            return None, False
        break
    return name, True


def _historical_ref_for_time(
    ref: str | None,
    occurred_at: str | None,
    aliases: Mapping[str, tuple[tuple[_Binding, str | None], ...]],
) -> str | None:
    """Canonicalize an old local ref name when its rename is after an event."""
    if ref is None:
        return None
    candidates = aliases.get(ref, ())
    eligible = {
        binding.full_ref
        for binding, renamed_at in candidates
        if occurred_at is not None
        and renamed_at is not None
        and renamed_at > occurred_at
    }
    return next(iter(eligible)) if len(eligible) == 1 else ref


def _resolve_token(
    repo: str,
    raw: str,
    by_ref: Mapping[str, list[_Binding]],
    remote_names: set[str],
    *,
    aliases: Mapping[str, tuple[tuple[_Binding, str | None], ...]] | None = None,
    occurred_at: str | None = None,
    timelines: Mapping[str, _RefTimeline] | None = None,
) -> _Token:
    token = raw.strip()
    if not token or token == "HEAD" or _is_hash(token):
        return _Token(token, None, (), "source_ref_not_named")

    if token.startswith("refs/heads/"):
        full_ref = token
    elif token.startswith("refs/remotes/"):
        full_ref = token
    elif token.startswith("refs/"):
        return _Token(token, token, (), "source_ref_not_named")
    elif "/" in token:
        remote_ref = _full_remote_ref(token)
        local_ref = _full_local_ref(token)
        remote_exists = remote_ref in by_ref
        local_exists = local_ref in by_ref
        if remote_exists and local_exists:
            # Git reports this spelling as ambiguous when both namespaces
            # exist. Keep the evidence unresolved instead of selecting one by
            # configured remote name.
            return _Token(token, None, (), "source_ref_ambiguous")
        if remote_exists:
            # Git's remote-qualified spelling is an explicit namespace when
            # the tracking ref exists.
            full_ref = remote_ref
        elif local_exists:
            # A configured remote does not make a local branch named
            # ``origin/topic`` disappear when the tracking ref is absent.
            full_ref = local_ref
        elif token.split("/", 1)[0] in remote_names:
            full_ref = remote_ref
        else:
            full_ref = local_ref
    else:
        # A plain name always means refs/heads/<name>. For an unknown
        # slash-containing name this preserves the possibility of a local
        # branch named e.g. feature/one without silently choosing a remote.
        full_ref = _full_local_ref(token)

    bindings = tuple(by_ref.get(full_ref, ()))
    alias_candidates = tuple((aliases or {}).get(full_ref, ()))
    if alias_candidates:
        eligible: list[_Binding] = []
        ambiguous_time = False
        for binding, renamed_at in alias_candidates:
            if occurred_at is None or renamed_at is None:
                eligible.append(binding)
            elif renamed_at > occurred_at:
                eligible.append(binding)
            elif renamed_at == occurred_at:
                ambiguous_time = True
        # A copied reflog can make several current refs look like candidates
        # for the same old spelling. Keep only refs whose own rename timeline
        # occupied that spelling at the operation time. This distinguishes a
        # surviving historical incarnation from a later same-name recreation.
        if not ambiguous_time and occurred_at is not None:
            named: list[_Binding] = []
            for binding in eligible:
                timeline = (timelines or {}).get(binding.full_ref)
                if timeline is None:
                    named.append(binding)
                    continue
                historical_name, active = _timeline_name_at(timeline, occurred_at)
                if active and historical_name == full_ref.removeprefix("refs/heads/"):
                    named.append(binding)
            eligible = named
        if ambiguous_time:
            return _Token(token, None, (), "source_ref_ambiguous")
        unique_aliases = tuple(
            binding
            for index, binding in enumerate(eligible)
            if not any(
                other.row_id == binding.row_id
                and other.kind == binding.kind
                and other.full_ref == binding.full_ref
                for other in eligible[:index]
            )
        )
        if len(unique_aliases) > 1:
            return _Token(
                token,
                None,
                unique_aliases,
                "source_ref_ambiguous",
            )
        if len(unique_aliases) == 1:
            alias = unique_aliases[0]
            # A currently reused old name cannot hide a later rename that is
            # the only evidence for this historical event. Prefer the alias
            # only when the rename is proven to be after the event; otherwise
            # retain the current exact ref binding.
            if not bindings or any(
                renamed_at is not None
                and occurred_at is not None
                and renamed_at > occurred_at
                for candidate, renamed_at in alias_candidates
                if candidate.full_ref == alias.full_ref
            ):
                return _Token(token, alias.full_ref, (alias,), None)
    if bindings and occurred_at is not None:
        timeline = (timelines or {}).get(full_ref)
        if timeline is not None:
            historical_name, active = _timeline_name_at(timeline, occurred_at)
            expected_name = full_ref.removeprefix("refs/heads/")
            if not active or historical_name != expected_name:
                return _Token(token, full_ref, (), "source_ref_incarnation_unproven")
    return _Token(token, full_ref, bindings, None if bindings else "source_ref_not_found")


def _entry_before_or_at(
    entries: list[dict[str, Any]] | None,
    commit_hash: str,
    occurred_at: str | None,
) -> bool:
    """Confirm that a named source ref recorded the endpoint by the event.

    This check distinguishes a currently reused branch name from the ref
    incarnation that supplied the merge. Reflog timestamps have only second
    precision, so an equal-second source entry is accepted only when a
    branch-create or rename marker for that same ref incarnation is strictly
    older than the operation. A source ref that was deleted and recreated
    after the operation therefore stays unresolved even when the recreated ref
    points at the same SHA.
    """
    if entries is None:
        return False
    equal_time_match = False
    for entry in entries:
        if entry.get("after") != commit_hash:
            continue
        entry_time = entry.get("occurred_at")
        if occurred_at is None or entry_time is None:
            continue
        if entry_time < occurred_at:
            return True
        if entry_time == occurred_at:
            equal_time_match = True
    if not equal_time_match or occurred_at is None:
        return False

    # A same-second endpoint is safe when the current ref incarnation itself
    # is proven to predate the operation. A fresh ``branch: Created from`` or
    # rename entry at the same second does not prove that ordering and is
    # deliberately rejected.
    for entry in entries:
        action = entry.get("action")
        started_at = entry.get("occurred_at")
        if not isinstance(action, str) or not isinstance(started_at, str):
            continue
        if not (
            _BRANCH_CREATE_RE.fullmatch(action)
            or _RENAME_RE.fullmatch(action)
        ):
            continue
        if started_at < occurred_at:
            return True
    return False


def _parse_action(action: str) -> tuple[str, str, tuple[str, ...]] | None:
    """Return ``(operation, kind, named source refs)`` for a reflog subject."""
    branch = _BRANCH_CREATE_RE.fullmatch(action)
    if branch is not None:
        return "branch_create", "branch", (branch.group("source").strip(),)

    if action.startswith("merge "):
        command, separator, _message = action[len("merge "):].partition(": ")
        if not separator:
            return None
        tokens = tuple(
            token
            for token in command.split()
            if token and not token.startswith("-")
        )
        operation = "fast_forward" if _message.startswith("Fast-forward") else "merge"
        return operation, "merge", tokens

    if action.startswith("pull"):
        _command, separator, message = action.partition(": ")
        if not separator:
            return None
        operation = "fast_forward" if message.startswith("Fast-forward") else "merge"
        # A pull's reflog subject normally omits its upstream. The caller
        # resolves it from the target row's exact tracking ref.
        tokens = tuple(
            token
            for token in _command[len("pull"):].split()
            if token and not token.startswith("-")
        )
        if len(tokens) == 2:
            # ``git pull <remote> <branch>`` names the remote-tracking source
            # as two command arguments while the target reflog keeps both in
            # its subject. Preserve that exact namespace for joining.
            tokens = (f"{tokens[0]}/{tokens[1]}",)
        return operation, "merge", tokens

    # A conflict-resolution commit retains merge topology but no longer keeps
    # the source name in its subject. Parent SHA evidence is handled later and
    # remains unresolved when no named ref can be joined.
    if action.startswith("commit (merge)"):
        return "merge", "merge", ()
    return None


def _current_branch(repo: str) -> str | None:
    raw = gitinfo._run(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    value = raw.strip() if raw else ""
    return value or None


def _head_target_refs(
    entries: list[dict[str, Any]],
    current_branch: str | None = None,
) -> dict[int, str | None]:
    """Infer the checked-out branch for HEAD reflog merge entries.

    This is only used as a recovery path for a target ref whose own reflog was
    removed after branch deletion. The walk is newest-to-oldest so the current
    symbolic branch can be used to reverse checkout/rename transitions. It
    never assumes that an unknown detached HEAD names a branch.
    """
    result: dict[int, str | None] = {}
    current = current_branch
    for entry in entries:
        sequence = entry.get("sequence")
        action = entry.get("action")
        if not isinstance(sequence, int) or not isinstance(action, str):
            continue
        parsed = _parse_action(action)
        if parsed is not None and parsed[1] == "merge":
            result[sequence] = _full_local_ref(current) if current else None

        checkout = _CHECKOUT_RE.fullmatch(action)
        if checkout is not None:
            old_branch = checkout.group("old").strip()
            new_branch = checkout.group("new").strip()
            # While walking backwards, the branch before the checkout is the
            # action's ``old`` side. The current value may be unknown for a
            # detached snapshot, in which case this transition cannot prove
            # a target and intentionally remains unresolved.
            if current is not None and current == new_branch:
                current = None if old_branch in {"HEAD", "(detached)"} else old_branch
            continue
        rename = _RENAME_RE.fullmatch(action)
        if rename is not None:
            old_branch = rename.group("old")
            new_branch = rename.group("new")
            if current is not None and current == new_branch:
                current = old_branch
    return result


def _target_reflog_proves_event(
    event: _Event,
    target_ref: str | None,
    target_entries: list[dict[str, Any]] | None,
) -> bool:
    """Require a current target incarnation for a HEAD-only event.

    A HEAD reflog records merge topology but does not identify the ref being
    updated. The current target reflog must contain the exact operation. This
    keeps a deleted-and-recreated branch with the same name from inheriting an
    old HEAD event while allowing a renamed branch, whose reflog is copied by
    Git, to retain its historical operation.
    """
    if event.reflog_ref != "HEAD" and not event.reflog_ref.startswith("HEAD@"):
        return True
    if target_ref is None or target_entries is None:
        return False
    return any(
        entry.get("after") == event.after
        and entry.get("action") == event.action
        and entry.get("occurred_at") == event.occurred_at
        for entry in target_entries
    )


def _events_for_ref(
    ref: str,
    entries: list[dict[str, Any]],
    *,
    target_ref: str | None = None,
) -> list[_Event]:
    events: list[_Event] = []
    for index, entry in enumerate(entries):
        action = entry.get("action")
        after = entry.get("after")
        if not isinstance(action, str) or not _is_hash(after):
            continue
        parsed = _parse_action(action)
        if parsed is None:
            continue
        operation, kind, source_tokens = parsed
        old_hash = None
        if index + 1 < len(entries):
            candidate = entries[index + 1].get("after")
            old_hash = candidate if _is_hash(candidate) else None
        events.append(
            _Event(
                reflog_ref=ref,
                target_ref=target_ref or ref,
                after=after,
                occurred_at=entry.get("occurred_at")
                if isinstance(entry.get("occurred_at"), str)
                else None,
                commit_date=entry.get("commit_date")
                if isinstance(entry.get("commit_date"), str)
                else None,
                action=action,
                operation=operation,
                kind=kind,
                source_tokens=source_tokens,
                old_hash=old_hash,
                sequence=index,
            )
        )
    return events


def _tracking_tokens(row: Mapping[str, Any]) -> tuple[str, ...]:
    values: list[str] = []
    tracking = row.get("tracking_ref")
    if isinstance(tracking, str) and tracking:
        values.append(tracking)
    locals_ = row.get("locals")
    if isinstance(locals_, list):
        for lane in locals_:
            if not isinstance(lane, Mapping):
                continue
            upstream = lane.get("upstream")
            if isinstance(upstream, str) and upstream:
                values.append(upstream)
    return tuple(dict.fromkeys(values))


def _metadata_by_hash(repo: str, hashes: list[str]) -> dict[str, dict[str, Any]]:
    if not hashes:
        return {}
    commits = branch_history.read_tips(repo, list(dict.fromkeys(hashes)))
    return {
        item["hash"]: dict(item)
        for item in commits or []
        if isinstance(item, Mapping) and _is_hash(item.get("hash"))
    }


def _current_ref_hash(repo: str, ref: str | None) -> str | None:
    if not ref:
        return None
    raw = gitinfo._run(repo, ["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"])
    value = raw.strip() if raw else ""
    return value if _is_hash(value) else None


def _display_source(token: str | None, full_ref: str | None) -> str:
    if isinstance(token, str) and token:
        return token
    return full_ref or "参照名未取得"


def _display_target(binding: _Binding | None, full_ref: str | None) -> str:
    if binding is not None:
        return binding.display
    return full_ref or "参照名未取得"


def _label(operation: str, source: str) -> str:
    if operation == "branch_create":
        return f"ブランチ作成（{source}）"
    if operation == "fast_forward":
        return f"早送りマージ（{source}）"
    return f"マージ（{source}）"


def _event_id(
    event: _Event,
    source_ref: str | None,
    source_hash: str | None,
    target_ref: str | None,
) -> str:
    return ":".join(
        (
            "reflog",
            event.operation,
            target_ref or event.reflog_ref,
            f"{event.occurred_at or 'entry'}-seq-{event.sequence}",
            event.after,
            source_ref or (event.source_tokens[0] if event.source_tokens else "unknown"),
            source_hash or "unknown",
        )
    )


def _unresolved(
    *,
    event: _Event,
    identifier: str,
    source: str,
    target: str,
    source_row_id: str | None,
    target_row_id: str | None,
    source_ref: str | None,
    target_ref: str | None,
    source_hash: str | None,
    reason: str,
    target_binding: _Binding | None,
) -> dict[str, Any]:
    target_hash = event.after
    return {
        "id": identifier,
        "kind": event.kind,
        "source_row_id": source_row_id,
        "target_row_id": target_row_id,
        "source": source,
        "target": target,
        "reason": reason,
        "pr_number": None,
        "pr_url": None,
        "evidence": "reflog",
        "commit_hash": target_hash,
        "source_commit_hash": source_hash,
        "target_commit_hash": target_hash,
        "source_commit": None,
        "target_commit": None,
        "label": _label(event.operation, source),
        "occurred_at": event.occurred_at,
        "operation": event.operation,
        "source_ref_id": source_ref,
        "target_ref_id": target_ref,
        "historical": target_binding is None,
    }


def build(repo: str, rows: list[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Build branch relation edges from named refs and their reflogs.

    ``rows`` is the current ``branch_rows.build`` result. A relation is
    emitted only when both endpoint row identities are uniquely joined to the
    named refs recorded by Git. Missing, deleted, or ambiguous refs remain in
    ``unresolved`` with their raw operation and SHA evidence.
    """
    if rows is None:
        return {"edges": [], "unresolved": [], "reflog_status": "unavailable"}

    current_rows = [row for row in rows if isinstance(row, Mapping)]
    by_ref, rows_by_id, remote_names = _rows_and_bindings(current_rows)
    remote_names |= _remote_names(repo)
    refs = set(by_ref)

    reflogs: dict[str, list[dict[str, Any]] | None] = {}
    retrieval_states: list[str] = []
    for ref in sorted(refs):
        entries, state = _read_reflog(repo, ref)
        reflogs[ref] = entries
        retrieval_states.append(state)

    # Every linked worktree owns a separate HEAD reflog. A relation may be
    # visible only there after the worktree is switched away from, or removed
    # after, the target branch. Keep each path as a distinct evidence source;
    # the target resolver below leaves an operation unresolved when that HEAD
    # history cannot identify a branch.
    head_sources: list[tuple[str, str, str | None]] = [
        ("HEAD", repo, _current_branch(repo))
    ]
    seen_head_paths = {os.path.realpath(os.path.abspath(repo))}
    for row in current_rows:
        locals_ = row.get("locals")
        if not isinstance(locals_, list):
            continue
        for lane in locals_:
            if not isinstance(lane, Mapping):
                continue
            path = lane.get("path")
            if not isinstance(path, str) or not path:
                continue
            canonical = os.path.realpath(os.path.abspath(path))
            if canonical in seen_head_paths:
                continue
            seen_head_paths.add(canonical)
            head_sources.append(
                (f"HEAD@{canonical}", path, _current_branch(path))
            )

    for head_key, head_path, _current in head_sources:
        entries, state = _read_reflog(head_path, "HEAD")
        reflogs[head_key] = entries
        retrieval_states.append(state)

    # Retain common-Git-dir reflogs for worktrees whose checkout directory is
    # already gone. These refs are intentionally target-unknown unless a live
    # path above supplied the symbolic branch, but their operation and parent
    # SHA still belong in ``unresolved``.
    worktree_refs, worktree_state = _worktree_head_refs(repo)
    retrieval_states.append(worktree_state)
    for worktree_ref in worktree_refs:
        head_key = f"HEAD@{worktree_ref}"
        if head_key in reflogs:
            continue
        entries, state = _read_reflog(repo, worktree_ref)
        reflogs[head_key] = entries
        retrieval_states.append(state)
        head_sources.append((head_key, repo, None))

    historical_aliases = _historical_aliases(by_ref, reflogs)
    ref_timelines = _ref_timelines(by_ref, reflogs)

    events: list[_Event] = []
    for ref in sorted(by_ref):
        entries = reflogs.get(ref)
        if entries is not None:
            events.extend(_events_for_ref(ref, entries))

    for head_key, _head_path, current_branch in head_sources:
        head_entries = reflogs.get(head_key)
        if head_entries is None:
            continue
        target_by_sequence = _head_target_refs(head_entries, current_branch)
        for event in _events_for_ref(head_key, head_entries):
            events.append(
                _Event(
                    reflog_ref=event.reflog_ref,
                    target_ref=target_by_sequence.get(event.sequence),
                    after=event.after,
                    occurred_at=event.occurred_at,
                    commit_date=event.commit_date,
                    action=event.action,
                    operation=event.operation,
                    kind=event.kind,
                    source_tokens=event.source_tokens,
                    old_hash=event.old_hash,
                    sequence=event.sequence,
                )
            )

    # The same operation is often recorded in a branch reflog, the shared
    # repository HEAD log, and one or more worktree HEAD logs. Collapse those
    # observations before endpoint resolution while retaining distinct target
    # refs and distinct branch-reflog sequences. The latter matters when a
    # target is reset and fast-forwarded to the same SHA again in one second.
    events_by_base: dict[tuple[Any, ...], list[_Event]] = {}
    for event in events:
        base_key = (
            event.operation,
            event.after,
            event.source_tokens,
            event.occurred_at,
        )
        events_by_base.setdefault(base_key, []).append(event)

    deduped_events: list[_Event] = []
    for group in events_by_base.values():
        by_target: dict[str | None, list[_Event]] = {}
        for event in group:
            target_key = _historical_ref_for_time(
                event.target_ref,
                event.occurred_at,
                historical_aliases,
            )
            by_target.setdefault(target_key, []).append(event)

        # A HEAD-only observation with an unknown target can be paired with
        # the only concrete target in the group (for example a retained
        # worktree ref plus its path HEAD log). Different concrete targets are
        # always kept independently.
        concrete_targets = [key for key in by_target if key is not None]
        if len(concrete_targets) == 1 and None in by_target:
            by_target[concrete_targets[0]].extend(by_target.pop(None))

        for target_group in by_target.values():
            direct = [
                event
                for event in target_group
                if not event.reflog_ref.startswith("HEAD")
            ]
            if direct:
                # Each target-ref reflog entry is authoritative for one
                # operation. HEAD observations are one-to-one duplicates.
                deduped_events.extend(direct)
                continue

            # With no target-ref reflog left, prefer a path-backed HEAD over
            # a common-dir worktree ref and keep all of its sequences. This
            # preserves repeated same-second operations while dropping the
            # duplicate observation from ``worktrees/<id>/HEAD``.
            head_groups: dict[str, list[_Event]] = {}
            for event in target_group:
                head_groups.setdefault(event.reflog_ref, []).append(event)
            if not head_groups:
                continue
            selected_ref, selected_events = max(
                head_groups.items(),
                key=lambda item: (
                    any(event.target_ref is not None for event in item[1]),
                    len(item[1]),
                    not item[0].startswith("HEAD@worktrees/"),
                    item[0],
                ),
            )
            del selected_ref
            deduped_events.extend(selected_events)
    events = deduped_events

    # Parent topology is read directly for operation endpoints. It does not
    # use project graph windows or the bounded branch history page.
    after_hashes = [event.after for event in events]
    metadata = _metadata_by_hash(repo, after_hashes)
    # Normal merge source endpoints are the actual second-and-later parents,
    # which are not necessarily reflog ``after`` values themselves. Read
    # those tips independently as well so every emitted edge carries the same
    # commit metadata shape as the existing branch connection edges.
    endpoint_hashes = list(after_hashes)
    for event in events:
        if event.operation != "merge":
            continue
        commit = metadata.get(event.after)
        parents = commit.get("parents") if isinstance(commit, Mapping) else None
        if isinstance(parents, list):
            endpoint_hashes.extend(
                parent for parent in parents[1:] if _is_hash(parent)
            )
    metadata = _metadata_by_hash(repo, endpoint_hashes)

    edges: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    edge_ids: set[str] = set()
    unresolved_ids: set[str] = set()
    edge_relation_keys: set[tuple[Any, ...]] = set()
    unresolved_by_relation: dict[tuple[Any, ...], dict[str, Any]] = {}

    def _canonical_target_ref(item: Mapping[str, Any]) -> str | None:
        target_ref = item.get("target_ref_id")
        if not isinstance(target_ref, str):
            return None
        occurred_at = item.get("occurred_at")
        return _historical_ref_for_time(
            target_ref,
            occurred_at if isinstance(occurred_at, str) else None,
            historical_aliases,
        )

    def _relation_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
        return (
            item.get("id"),
            item.get("kind"),
            item.get("operation"),
            item.get("commit_hash"),
            item.get("source_commit_hash"),
            item.get("source_ref_id") or item.get("source"),
            _canonical_target_ref(item),
            item.get("occurred_at"),
        )

    def add_unresolved(item: dict[str, Any]) -> None:
        identifier = item.get("id")
        if not isinstance(identifier, str) or identifier in unresolved_ids:
            return
        relation_key = _relation_key(item)
        if relation_key in edge_relation_keys:
            return
        if relation_key in unresolved_by_relation:
            return
        unresolved_ids.add(identifier)
        unresolved_by_relation[relation_key] = item
        unresolved.append(item)

    def add_edge(item: dict[str, Any]) -> None:
        identifier = item.get("id")
        if not isinstance(identifier, str) or identifier in edge_ids:
            return
        relation_key = _relation_key(item)
        edge_relation_keys.add(relation_key)
        previous_unresolved = unresolved_by_relation.pop(relation_key, None)
        if previous_unresolved is not None:
            unresolved.remove(previous_unresolved)
        edge_ids.add(identifier)
        edges.append(item)

    def resolve_source(
        source_token: str,
        source_hash: str | None,
        event: _Event,
    ) -> _Token:
        token = _resolve_token(
            repo,
            source_token,
            by_ref,
            remote_names,
            aliases=historical_aliases,
            occurred_at=event.occurred_at,
            timelines=ref_timelines,
        )
        # Name timelines remove most copied-reflog ambiguity. If more than
        # one historical ref still occupied the name, the endpoint SHA is the
        # remaining independent evidence: a ref that recorded that exact
        # endpoint before the operation is the only candidate we may join.
        if token.reason == "source_ref_ambiguous" and token.bindings:
            proven = [
                binding
                for binding in token.bindings
                if _is_hash(source_hash)
                and _entry_before_or_at(
                    reflogs.get(binding.full_ref),
                    source_hash,
                    event.occurred_at,
                )
            ]
            unique_proven = tuple(
                binding
                for index, binding in enumerate(proven)
                if not any(
                    other.full_ref == binding.full_ref
                    and other.row_id == binding.row_id
                    and other.kind == binding.kind
                    for other in proven[:index]
                )
            )
            if len(unique_proven) == 1:
                binding = unique_proven[0]
                return _Token(
                    source_token,
                    binding.full_ref,
                    (binding,),
                    None,
                )
        return token

    for event in events:
        target_ref = event.target_ref
        target_bindings = tuple(by_ref.get(target_ref or "", ())) if target_ref else ()
        target_binding = target_bindings[0] if len(target_bindings) == 1 else None
        target_row = rows_by_id.get(target_binding.row_id) if target_binding else None
        target_label = _display_target(target_binding, target_ref)
        target_reason = None
        if target_ref is None:
            target_reason = "target_ref_unknown"
        elif len(target_bindings) == 0:
            target_reason = "target_ref_not_found"
        elif len(target_bindings) > 1:
            target_reason = "target_ref_ambiguous"
        if target_reason is not None:
            target_metadata = metadata.get(event.after)
            target_parents = (
                target_metadata.get("parents")
                if isinstance(target_metadata, Mapping)
                and isinstance(target_metadata.get("parents"), list)
                else []
            )
            if event.operation in {"branch_create", "fast_forward"}:
                missing_target_source_hashes: list[str | None] = [event.after]
            else:
                missing_target_source_hashes = [
                    parent for parent in target_parents[1:] if _is_hash(parent)
                ] or [None]
            source_tokens = list(event.source_tokens)
            for index, source_hash in enumerate(missing_target_source_hashes):
                source_token = (
                    source_tokens[index]
                    if len(source_tokens) == len(missing_target_source_hashes)
                    else source_tokens[0]
                    if source_tokens
                    else ""
                )
                token = resolve_source(source_token, source_hash, event)
                source_binding = token.bindings[0] if len(token.bindings) == 1 else None
                source_row_id = source_binding.row_id if source_binding else None
                source_ref = token.full_ref
                identifier = _event_id(event, source_ref, source_hash, target_ref)
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=_display_source(source_token, source_ref),
                        target=target_label,
                        source_row_id=source_row_id,
                        target_row_id=None,
                        source_ref=source_ref,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason=target_reason,
                        target_binding=None,
                    )
                )
            continue

        # A merge seen only in a HEAD reflog has no target ref identity of its
        # own. Do not attach it to a current branch merely because the name
        # happens to match: a recreated branch can point at the same commit
        # while having a different reflog incarnation. A renamed branch keeps
        # the exact action in Git's copied reflog and therefore passes this
        # check.
        target_entries = reflogs.get(target_ref or "")
        if not _target_reflog_proves_event(event, target_ref, target_entries):
            target_metadata = metadata.get(event.after)
            target_parents = (
                target_metadata.get("parents")
                if isinstance(target_metadata, Mapping)
                and isinstance(target_metadata.get("parents"), list)
                else []
            )
            if event.operation in {"branch_create", "fast_forward"}:
                target_source_hashes: list[str | None] = [event.after]
            else:
                target_source_hashes = [
                    parent for parent in target_parents[1:] if _is_hash(parent)
                ] or [None]
            source_tokens = list(event.source_tokens)
            for index, source_hash in enumerate(target_source_hashes):
                source_token = (
                    source_tokens[index]
                    if len(source_tokens) == len(target_source_hashes)
                    else source_tokens[0]
                    if source_tokens
                    else ""
                )
                token = resolve_source(source_token, source_hash, event)
                source_binding = token.bindings[0] if len(token.bindings) == 1 else None
                source_ref = token.full_ref
                identifier = _event_id(event, source_ref, source_hash, target_ref)
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=_display_source(source_token, source_ref),
                        target=target_label,
                        source_row_id=source_binding.row_id if source_binding else None,
                        target_row_id=target_binding.row_id,
                        source_ref=source_ref,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason="target_incarnation_unproven",
                        target_binding=target_binding,
                    )
                )
            continue

        target_row_id = target_binding.row_id
        target_metadata = metadata.get(event.after)
        target_parents = (
            target_metadata.get("parents")
            if isinstance(target_metadata, Mapping)
            and isinstance(target_metadata.get("parents"), list)
            else []
        )

        source_tokens = list(event.source_tokens)
        if (
            event.action.startswith("pull")
            and len(source_tokens) <= 1
            and target_row is not None
        ) or (not source_tokens and event.operation in {"merge", "fast_forward"}):
            tracking = _tracking_tokens(target_row or {})
            if len(tracking) == 1:
                source_tokens = [tracking[0]]

        if event.operation == "branch_create":
            source_tokens = list(event.source_tokens)
            source_hashes = [event.after]
        elif event.operation == "fast_forward":
            source_hashes = [event.after]
        else:
            if not target_metadata:
                identifier = _event_id(event, None, None, target_ref)
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=_display_source(
                            source_tokens[0] if source_tokens else None, None
                        ),
                        target=target_label,
                        source_row_id=None,
                        target_row_id=target_row_id,
                        source_ref=None,
                        target_ref=target_ref,
                        source_hash=None,
                        reason="target_commit_unavailable",
                        target_binding=target_binding,
                    )
                )
                continue
            source_hashes = [
                parent for parent in target_parents[1:] if _is_hash(parent)
            ]
            if not source_hashes:
                identifier = _event_id(event, None, None, target_ref)
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=_display_source(
                            source_tokens[0] if source_tokens else None, None
                        ),
                        target=target_label,
                        source_row_id=None,
                        target_row_id=target_row_id,
                        source_ref=None,
                        target_ref=target_ref,
                        source_hash=None,
                        reason="merge_parent_unavailable",
                        target_binding=target_binding,
                    )
                )
                continue

        if event.operation == "fast_forward" and not source_tokens:
            identifier = _event_id(event, None, event.after, target_ref)
            add_unresolved(
                _unresolved(
                    event=event,
                    identifier=identifier,
                    source="参照名未取得",
                    target=target_label,
                    source_row_id=None,
                    target_row_id=target_row_id,
                    source_ref=None,
                    target_ref=target_ref,
                    source_hash=event.after,
                    reason="source_ref_not_named",
                    target_binding=target_binding,
                )
            )
            continue

        if event.operation == "branch_create" and not source_tokens:
            source_tokens = [""]

        if event.operation == "merge" and len(source_tokens) != len(source_hashes):
            # Preserve every actual parent SHA. Mapping one name to a
            # different parent would turn an incomplete reflog subject into a
            # false branch relation, especially for octopus merges.
            for source_hash in source_hashes:
                identifier = _event_id(event, None, source_hash, target_ref)
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=_display_source(
                            source_tokens[0] if source_tokens else None, None
                        ),
                        target=target_label,
                        source_row_id=None,
                        target_row_id=target_row_id,
                        source_ref=None,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason="merge_source_count_mismatch"
                        if source_tokens
                        else "source_ref_not_named",
                        target_binding=target_binding,
                    )
                )
            continue

        if event.operation in {"branch_create", "fast_forward"}:
            pairs = [(source_tokens[0] if source_tokens else "", source_hashes[0])]
        else:
            pairs = list(zip(source_tokens, source_hashes, strict=True))

        for source_token, source_hash in pairs:
            token = resolve_source(source_token, source_hash, event)
            source_binding = token.bindings[0] if len(token.bindings) == 1 else None
            source_row_id = source_binding.row_id if source_binding else None
            source_label = _display_source(source_token, token.full_ref)
            identifier = _event_id(event, token.full_ref, source_hash, target_ref)
            if token.reason is not None:
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=source_label,
                        target=target_label,
                        source_row_id=source_row_id,
                        target_row_id=target_row_id,
                        source_ref=token.full_ref,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason=token.reason,
                        target_binding=target_binding,
                    )
                )
                continue
            if len(token.bindings) != 1 or source_binding is None:
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=source_label,
                        target=target_label,
                        source_row_id=None,
                        target_row_id=target_row_id,
                        source_ref=token.full_ref,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason="source_ref_ambiguous",
                        target_binding=target_binding,
                    )
                )
                continue
            if (
                source_binding.row_id == target_row_id
                and token.full_ref == target_ref
            ):
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=source_label,
                        target=target_label,
                        source_row_id=source_binding.row_id,
                        target_row_id=target_row_id,
                        source_ref=token.full_ref,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason="source_and_target_are_same_row",
                        target_binding=target_binding,
                    )
                )
                continue

            source_entries = reflogs.get(token.full_ref or "")
            # Fast-forward and branch creation require both named endpoint
            # refs to have recorded the after SHA. A normal merge additionally
            # gets its source endpoint from the actual second parent, but the
            # source ref's reflog still guards against a later same-name
            # incarnation.
            if not _entry_before_or_at(source_entries, source_hash, event.occurred_at):
                add_unresolved(
                    _unresolved(
                        event=event,
                        identifier=identifier,
                        source=source_label,
                        target=target_label,
                        source_row_id=source_binding.row_id,
                        target_row_id=target_row_id,
                        source_ref=token.full_ref,
                        target_ref=target_ref,
                        source_hash=source_hash,
                        reason="source_commit_not_in_reflog"
                        if source_entries is not None
                        else "source_reflog_unavailable",
                        target_binding=target_binding,
                    )
                )
                continue

            source_metadata = metadata.get(source_hash)
            target_current_hash = _current_ref_hash(repo, target_ref)
            historical = target_current_hash is not None and target_current_hash != event.after
            edge = {
                "id": identifier,
                "kind": event.kind,
                "source_row_id": source_binding.row_id,
                "target_row_id": target_row_id,
                "evidence": "reflog",
                "commit_hash": event.after,
                "source_commit_hash": source_hash,
                "target_commit_hash": event.after,
                "source_commit": dict(source_metadata) if source_metadata else None,
                "target_commit": dict(target_metadata) if target_metadata else None,
                "pr_number": None,
                "pr_url": None,
                "label": _label(event.operation, source_label),
                "occurred_at": event.occurred_at,
                "operation": event.operation,
                "source_ref_id": token.full_ref,
                "target_ref_id": target_ref,
                "historical": historical,
            }
            add_edge(edge)

    edges.sort(key=lambda item: (item.get("occurred_at") or "", item.get("id") or ""))
    unresolved.sort(
        key=lambda item: (item.get("occurred_at") or "", item.get("id") or "")
    )
    if not current_rows:
        reflog_status = "unavailable"
    else:
        failures = sum(state == "failed" for state in retrieval_states)
        successful = sum(state in {"ok", "missing"} for state in retrieval_states)
        if failures == 0:
            reflog_status = "available"
        elif successful == 0:
            reflog_status = "unavailable"
        else:
            reflog_status = "partial"
    return {
        "edges": edges,
        "unresolved": unresolved,
        "reflog_status": reflog_status,
    }


__all__ = ["build"]
