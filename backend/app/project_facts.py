"""Request-local Git observations used to record/replay project snapshots.

Only Git readers participate. README, STATE, clock, agents and GitHub never do.
Values are copied by default because composition adds presentation fields.
Readers whose callers leave the entire result untouched may opt out.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
import json
from typing import Any

_active: ContextVar[dict[str, Any] | None] = ContextVar("project_git_facts", default=None)


@contextmanager
def using(values: dict[str, Any]):
    token = _active.set(values)
    try:
        yield
    finally:
        _active.reset(token)


def observe(name, args, read, *, copy_value=True):
    values = _active.get()
    if values is None:
        return read()
    key = json.dumps([name, args], sort_keys=True, ensure_ascii=False)
    if key not in values:
        values[key] = read()
    return deepcopy(values[key]) if copy_value else values[key]


def observe_subset(name, args, keys, read):
    """Read missing keys in one batch without mutating a shared snapshot."""
    values = _active.get()
    if values is None:
        return read(keys)
    key = json.dumps([name, args], sort_keys=True, ensure_ascii=False)
    known = values.get(key, {})
    missing = [item for item in keys if item not in known]
    if missing:
        observed = read(missing)
        known = {**known, **{item: observed.get(item) for item in missing}}
        values[key] = known
    return deepcopy({item: known[item] for item in keys})


def cached(function=None, *, copy_value=True):
    if function is None:
        return lambda function: cached(function, copy_value=copy_value)

    @wraps(function)
    def read(*args, **kwargs):
        return observe(f"{function.__module__}.{function.__name__}", [args, kwargs], lambda: function(*args, **kwargs), copy_value=copy_value)
    return read


def relation_rows(rows):
    """Ref/reflog computations depend on identities, never lane status or PRs."""
    if rows is None:
        return None
    fields = ("id", "name", "remote_ref", "remote_hash", "remote_repository", "historical", "history_heads", "tracking_ref")
    return [{**{key: row.get(key) for key in fields}, "locals": [
        {key: lane.get(key) for key in ("id", "name", "branch", "head", "path", "upstream", "detached")}
        for lane in row.get("locals", [])
    ]} for row in rows if not row.get("historical")]
