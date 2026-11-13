"""Request-local Git observations used to record/replay project snapshots.

Only Git readers participate. README, STATE, clock, agents and GitHub never do.
Values are copied because project composition adds presentation fields in place.
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


def observe(name, args, read):
    values = _active.get()
    if values is None:
        return read()
    key = json.dumps([name, args], sort_keys=True, ensure_ascii=False)
    if key not in values:
        values[key] = read()
    return deepcopy(values[key])


def cached(function):
    @wraps(function)
    def read(*args, **kwargs):
        return observe(f"{function.__module__}.{function.__name__}", [args, kwargs], lambda: function(*args, **kwargs))
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
