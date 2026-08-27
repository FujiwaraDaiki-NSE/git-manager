"""永続化。起動時に探索せず即表示するためのキャッシュ。"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

from app import config

REPOS_FILE = config.DATA_DIR / "repos.json"


def load() -> dict[str, Any]:
    try:
        with open(REPOS_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def save(state: dict[str, Any]) -> None:
    """途中で落ちても壊れないよう、一時ファイル経由で置き換える。"""
    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(config.DATA_DIR), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, REPOS_FILE)
    except OSError:
        pass
