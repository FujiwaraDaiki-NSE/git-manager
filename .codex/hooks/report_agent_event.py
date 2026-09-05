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
    hook = sys.argv[1] if len(sys.argv) > 1 else ""
    endpoint = os.environ.get("GITDASH_AGENT_ENDPOINT")
    token = os.environ.get("GITDASH_AGENT_TOKEN")
    task_id = os.environ.get("GITDASH_TASK_ID") or os.environ.get("CODEX_TASK_ID")
    if not endpoint or not token or not task_id or hook not in STATES:
        return 0
    try:
        worktree = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
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
        "task_id": task_id,
        "agent_id": os.environ.get("GITDASH_AGENT_ID"),
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
