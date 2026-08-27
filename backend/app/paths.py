"""コンテナ内パスとホストパスの相互変換。

表示とコピーはホストパスでないと意味がない（ユーザーはホストで git を打つ）。
内部処理はコンテナパスで行う。
"""
from __future__ import annotations

from app import config


def to_host(container_path: str) -> str:
    if container_path == config.SCAN_ROOT:
        return config.HOST_PREFIX
    if container_path.startswith(config.SCAN_ROOT + "/"):
        return config.HOST_PREFIX + container_path[len(config.SCAN_ROOT):]
    return container_path


def to_container(host_path: str) -> str:
    if host_path == config.HOST_PREFIX:
        return config.SCAN_ROOT
    if host_path.startswith(config.HOST_PREFIX + "/"):
        return config.SCAN_ROOT + host_path[len(config.HOST_PREFIX):]
    return host_path
