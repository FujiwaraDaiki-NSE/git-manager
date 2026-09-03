"""inotify で .git を監視し、変化したリポジトリだけ再取得させる。

これが動いている限り全体スキャンは不要になる。

限界: 作業ツリーのファイルを編集しても .git は変化しないため M / ?? は拾えない。
作業ツリーごと watch するのは .gitignore の解釈が要る上に watch 数が爆発するので
やらない。フロント側でフォーカス復帰時に取り直すことで補う。
"""
from __future__ import annotations

import os
import threading
from typing import Callable

from app import scanner

try:
    from inotify_simple import INotify, flags
except ImportError:  # 監視なしでも動くようにする
    INotify = None
    flags = None

WATCH_FLAGS = 0
if flags is not None:
    WATCH_FLAGS = (
        flags.CLOSE_WRITE | flags.MOVED_TO | flags.CREATE | flags.DELETE
    )


class Watcher:
    """.git ディレクトリを監視する。index / HEAD / refs の書き換えを拾う。"""

    def __init__(self, on_change: Callable[[str], None]) -> None:
        self._on_change = on_change
        self._inotify = None
        self._wd_to_repo: dict[int, str] = {}
        self._repo_to_wds: dict[str, list[int]] = {}
        self._dir_to_wd: dict[str, int] = {}
        self._wd_users: dict[int, set[str]] = {}
        self._wd_private_users: dict[int, set[str]] = {}
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    @property
    def available(self) -> bool:
        return INotify is not None

    def start(self) -> None:
        if not self.available or self._thread is not None:
            return
        self._inotify = INotify()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="inotify")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._inotify is not None:
            try:
                self._inotify.close()
            except OSError:
                pass

    def watch(self, repo: str) -> None:
        """1 リポジトリを監視対象に加える。既に登録済みなら何もしない。"""
        if self._inotify is None:
            return
        repo = os.path.abspath(repo)
        with self._lock:
            if repo in self._repo_to_wds:
                return
            wds: list[int] = []
            layout = scanner.repo_layout(repo)
            if layout is None:
                return

            # A linked worktree's .git is a pointer file.  Watch the actual
            # per-worktree gitdir (HEAD/logs/index) and the shared refs/logs
            # directories instead of the pointer itself.
            private_targets = [
                layout.git_dir,
                os.path.join(layout.git_dir, "refs"),
                os.path.join(layout.git_dir, "logs"),
                os.path.join(layout.git_dir, "logs", "refs"),
            ]
            targets = list(private_targets)
            if layout.common_git_dir != layout.git_dir:
                targets.extend(
                    (
                        layout.common_git_dir,
                        os.path.join(layout.common_git_dir, "refs"),
                        os.path.join(layout.common_git_dir, "logs"),
                        os.path.join(layout.common_git_dir, "logs", "refs"),
                    )
                )

            seen_targets: set[str] = set()
            for candidate in targets:
                target = os.path.realpath(candidate)
                if target in seen_targets:
                    continue
                seen_targets.add(target)
                if not os.path.isdir(target):
                    continue
                wd = self._dir_to_wd.get(target)
                if wd is None:
                    try:
                        wd = self._inotify.add_watch(target, WATCH_FLAGS)
                    except OSError:
                        continue
                    self._dir_to_wd[target] = wd
                    self._wd_users[wd] = set()
                    self._wd_private_users[wd] = set()
                    self._wd_to_repo[wd] = repo
                users = self._wd_users.setdefault(wd, set())
                users.add(repo)
                if target in {os.path.realpath(path) for path in private_targets}:
                    self._wd_private_users.setdefault(wd, set()).add(repo)
                wds.append(wd)
            if wds:
                self._repo_to_wds[repo] = list(dict.fromkeys(wds))

    def unwatch(self, repo: str) -> None:
        if self._inotify is None:
            return
        repo = os.path.abspath(repo)
        with self._lock:
            for wd in self._repo_to_wds.pop(repo, []):
                users = self._wd_users.get(wd)
                if users is None:
                    continue
                users.discard(repo)
                self._wd_private_users.get(wd, set()).discard(repo)
                if users:
                    if self._wd_to_repo.get(wd) == repo:
                        self._wd_to_repo[wd] = next(iter(users))
                    continue
                self._wd_users.pop(wd, None)
                self._wd_private_users.pop(wd, None)
                self._wd_to_repo.pop(wd, None)
                for target, target_wd in list(self._dir_to_wd.items()):
                    if target_wd == wd:
                        self._dir_to_wd.pop(target, None)
                try:
                    self._inotify.rm_watch(wd)
                except OSError:
                    pass

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                events = self._inotify.read(timeout=1000)
            except OSError:
                break
            # A linked-worktree commit touches its private logs/HEAD and the
            # shared refs/logs directories.  Collapse those events to one
            # callback for the common repository, preferring the worktree
            # that has the private HEAD event.
            touched: dict[str, str] = {}
            with self._lock:
                for event in events:
                    # index.lock などのロックファイルは git 内部の一時ファイル。
                    # これを拾うと自分の git status が自分を起こし続ける
                    if event.name.endswith(".lock"):
                        continue
                    private_users = self._wd_private_users.get(event.wd, set())
                    repo = next(iter(private_users), self._wd_to_repo.get(event.wd))
                    if repo:
                        layout = scanner.repo_layout(repo)
                        group = (
                            os.path.realpath(layout.common_root)
                            if layout is not None
                            else os.path.realpath(repo)
                        )
                        previous = touched.get(group)
                        if previous is None:
                            touched[group] = repo
                        else:
                            previous_layout = scanner.repo_layout(previous)
                            if (
                                layout is not None
                                and layout.is_worktree
                                and (
                                    previous_layout is None
                                    or not previous_layout.is_worktree
                                )
                            ):
                                touched[group] = repo
            for repo in touched.values():
                self._on_change(repo)
