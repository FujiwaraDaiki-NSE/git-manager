"""ディスクを歩いて .git を探す。登録作業を無くすための心臓部。

見つけた順に yield するので、呼び出し側は探索の完了を待たずに配信できる。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from app import config

# 潜っても Git リポジトリが出てこない、あるいは大量のファイルで探索を潰すもの
SKIP_NAMES = {
    "node_modules", ".venv", "venv", "env", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox",
    ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "target",
    "vendor", "bower_components",
    ".cache", ".local", ".npm", ".yarn", ".pnpm-store",
    ".cargo", ".rustup", ".gradle", ".m2", ".ivy2", ".sbt",
    ".conda", "anaconda3", "miniconda3", "site-packages",
    ".steam", ".wine", "snap", "flatpak",
    ".git",
}

# 絶対パスで弾くもの
SKIP_ABS = {"/proc", "/sys", "/dev", "/run", "/tmp", "/var/lib/docker"}

# go/pkg や .cargo/registry のように「親との組み合わせ」で重いもの
SKIP_PAIRS = {("go", "pkg"), ("go", "bin")}

NETWORK_FSTYPES = {
    "nfs", "nfs4", "cifs", "smbfs", "smb3", "afs", "ceph", "glusterfs",
    "fuse.sshfs", "fuse.rclone", "fuse.s3fs", "fuse.gvfsd-fuse",
}


def network_mountpoints() -> set[str]:
    """ネットワークマウントを 1 リポジトリ数秒の地雷にしないため事前に集める。"""
    points: set[str] = set()
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 3 and parts[2] in NETWORK_FSTYPES:
                    points.add(parts[1])
    except OSError:
        pass
    return points


def activity_mtime(repo: str) -> float:
    """そのリポジトリで最後に git 操作が起きた時刻。

    commit / checkout / merge / pull で必ず更新される reflog を見る。
    os.stat 1 回で済むので、git を一度も起動する前に活動順ソートができる。
    """
    dot_git = os.path.join(repo, ".git")
    for candidate in (
        os.path.join(dot_git, "logs", "refs", "HEAD"),
        os.path.join(dot_git, "HEAD"),
        dot_git,
    ):
        try:
            return os.stat(candidate).st_mtime
        except OSError:
            continue
    return 0.0


def find_repos(roots: list[str] | None = None, max_depth: int | None = None) -> Iterator[str]:
    """roots 以下から .git を持つディレクトリを見つけ次第 yield する。"""
    roots = roots or [config.SCAN_ROOT]
    depth_limit = config.MAX_DEPTH if max_depth is None else max_depth
    skip_mounts = network_mountpoints() | SKIP_ABS
    seen: set[str] = set()

    for root in roots:
        base = Path(root)
        if not base.is_dir():
            continue
        yield from _walk(str(base), 0, depth_limit, skip_mounts, seen)


def _walk(
    directory: str,
    depth: int,
    depth_limit: int,
    skip_mounts: set[str],
    seen: set[str],
) -> Iterator[str]:
    if depth > depth_limit or directory in skip_mounts:
        return

    try:
        entries = list(os.scandir(directory))
    except (PermissionError, OSError):
        return

    # .git があればここがリポジトリ。サブモジュールまでは追わない
    if any(e.name == ".git" for e in entries):
        real = os.path.realpath(directory)
        if real not in seen:
            seen.add(real)
            yield directory
        return

    parent_name = os.path.basename(directory)
    for entry in entries:
        name = entry.name
        if name in SKIP_NAMES or (parent_name, name) in SKIP_PAIRS:
            continue
        if name.startswith("."):
            continue
        try:
            if not entry.is_dir(follow_symlinks=False):
                continue
        except OSError:
            continue
        yield from _walk(entry.path, depth + 1, depth_limit, skip_mounts, seen)
