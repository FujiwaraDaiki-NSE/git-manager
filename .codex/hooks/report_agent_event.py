#!/usr/bin/env python3
"""Report Codex lifecycle hooks without reading or interpreting transcripts."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timezone

STATES = {
    "SessionStart": "active",
    "SubagentStart": "active",
    "Interrupt": "interrupted",
    "SubagentStop": "idle",
    "SessionEnd": "ended",
}


def main() -> int:
    try:
        hook_input = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(hook_input, dict):
        return 0
    hook = hook_input.get("hook_event_name")
    cwd = hook_input.get("cwd")
    session_id = hook_input.get("session_id")
    endpoint = os.environ.get("GITDASH_AGENT_ENDPOINT")
    token = os.environ.get("GITDASH_AGENT_TOKEN")
    if (
        not endpoint
        or not token
        or not isinstance(session_id, str)
        or not session_id
        or not isinstance(cwd, str)
        or not os.path.isabs(cwd)
        or not isinstance(hook, str)
        or hook not in STATES
    ):
        return 0
    try:
        worktree = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return 0
    if not worktree or not os.path.isabs(worktree):
        return 0
    payload = {
        "event_id": str(uuid.uuid4()),
        "task_id": session_id,
        "agent_id": hook_input.get("agent_id"),
        "worktree": worktree,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "kind": "lifecycle",
        "run_state": STATES[hook],
        "action": {"SessionStart": "session_start", "SubagentStart": "subagent_start", "Interrupt": "interrupt", "SubagentStop": "subagent_stop", "SessionEnd": "session_end"}[hook],
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=5).close()
    except (OSError, urllib.error.URLError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
