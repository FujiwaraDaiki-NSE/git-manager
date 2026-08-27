"""環境変数。すべて docker compose から渡る。"""
from __future__ import annotations

import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return default if v is None else int(v)


# コンテナ内の走査起点。compose でホストのディレクトリをここに mount する
SCAN_ROOT = os.environ.get("GITDASH_SCAN_ROOT", "/scan")

# 表示用。SCAN_ROOT をホスト側のどのパスとして見せるか
HOST_PREFIX = os.environ.get("GITDASH_HOST_PREFIX", SCAN_ROOT)

DATA_DIR = Path(os.environ.get("GITDASH_DATA_DIR", "/data"))

MAX_DEPTH = _int("GITDASH_MAX_DEPTH", 8)
WORKERS = _int("GITDASH_WORKERS", 16)

FETCH_ENABLED = _bool("GITDASH_FETCH", True)
FETCH_WORKERS = _int("GITDASH_FETCH_WORKERS", 4)
FETCH_INTERVAL_SEC = _int("GITDASH_FETCH_INTERVAL_SEC", 300)
FETCH_TIMEOUT_SEC = _int("GITDASH_FETCH_TIMEOUT_SEC", 30)

GIT_TIMEOUT_SEC = _int("GITDASH_GIT_TIMEOUT_SEC", 20)

WATCH_ENABLED = _bool("GITDASH_WATCH", True)
