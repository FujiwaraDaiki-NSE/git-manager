"""ディスクを歩いて .git を探す。登録作業を無くすための心臓部。

見つけた順に yield するので、呼び出し側は探索の完了を待たずに配信できる。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator, NamedTuple

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


class RepoLayout(NamedTuple):
    """Filesystem paths used by a normal repository or a linked worktree."""

    git_dir: str
    common_git_dir: str
    common_root: str
    is_worktree: bool


def _gitdir_from_file(dot_git: str, repo: str) -> str | None:
    """Resolve the ``gitdir:`` pointer used by linked worktrees."""
    try:
        with open(dot_git, encoding="utf-8", errors="replace") as f:
            line = f.readline().strip()
    except OSError:
        return None
    if not line.lower().startswith("gitdir:"):
        return None
    value = line[len("gitdir:"):].strip()
    if not value:
        return None
    if not os.path.isabs(value):
        value = os.path.join(repo, value)
    return os.path.realpath(value)


def git_dir(repo: str) -> str | None:
    """Return the actual git directory for ``repo`` without invoking git."""
    repo = os.path.abspath(repo)
    dot_git = os.path.join(repo, ".git")
    if os.path.isdir(dot_git):
        return os.path.realpath(dot_git)
    if os.path.isfile(dot_git):
        return _gitdir_from_file(dot_git, repo)
    return None


def common_git_dir(repo: str, actual_git_dir: str | None = None) -> str | None:
    """Resolve the shared git directory for a worktree or normal repository."""
    actual = actual_git_dir or git_dir(repo)
    if actual is None:
        return None

    # Linked worktree gitdirs contain a commondir file.  It is more reliable
    # than assuming that the worktree id is exactly one directory deep.
    commondir_file = os.path.join(actual, "commondir")
    try:
        with open(commondir_file, encoding="utf-8", errors="replace") as f:
            value = f.readline().strip()
    except OSError:
        value = ""
    if value:
        if not os.path.isabs(value):
            value = os.path.join(actual, value)
        return os.path.realpath(value)

    return actual


def repo_layout(repo: str) -> RepoLayout | None:
    """Resolve gitdir/common gitdir and whether ``repo`` is a linked worktree."""
    actual = git_dir(repo)
    if actual is None:
        return None
    common = common_git_dir(repo, actual)
    if common is None:
        return None
    repo = os.path.abspath(repo)
    # ``--separate-git-dir`` also leaves a .git *file*, but it is a normal
    # repository: unlike a linked worktree its gitdir has no ``commondir``
    # pointing at another gitdir.  The actual/common distinction is the
    # authoritative signal for linked worktrees.
    is_worktree = actual != common
    # For a normal repository whose gitdir lives elsewhere, the project root
    # is still the repository itself.  For a linked worktree, the common git
    # directory normally is ``<main>/.git``.  With --separate-git-dir there
    # is no checkout path to derive from the common git directory, so retain
    # that directory as the stable project identity until the main checkout
    # itself is discovered.
    if not is_worktree:
        common_root = repo
    else:
        embedded_root = os.path.dirname(common)
        embedded_dot_git = os.path.realpath(os.path.join(embedded_root, ".git"))
        common_root = embedded_root if embedded_dot_git == common else common
    return RepoLayout(actual, common, os.path.realpath(common_root), is_worktree)


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
    actual_git_dir = git_dir(repo)
    # logs/HEAD is updated for commits, checkouts, merges, pulls, and resets.
    # For linked worktrees this must be resolved through the .git file; the
    # shared logs/refs directory does not contain a refs/HEAD file.
    candidates: list[str] = []
    if actual_git_dir is not None:
        candidates.extend(
            (
                os.path.join(actual_git_dir, "logs", "HEAD"),
                os.path.join(actual_git_dir, "HEAD"),
            )
        )
    candidates.extend(
        (
            os.path.join(dot_git, "logs", "HEAD"),
            os.path.join(dot_git, "HEAD"),
            dot_git,
        )
    )
    for candidate in candidates:
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
