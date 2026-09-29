"""inotify で .git を監視し、変化したリポジトリだけ再取得させる。

これが動いている限り全体スキャンは不要になる。

限界: 作業ツリーのファイルを編集しても .git は変化しないため M / ?? は拾えない。
作業ツリーごと watch するのは .gitignore の解釈が要る上に watch 数が爆発するので
やらない。画面の「再走査」で取り直す。
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
        | flags.DELETE_SELF | flags.MOVE_SELF
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
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)
        if self._inotify is not None:
            try:
                self._inotify.close()
            except OSError:
                pass

    def watch(self, repo: str) -> None:
        """1 リポジトリの Git 管理ディレクトリと参照 namespace を監視する。"""
        if self._inotify is None:
            return
        repo = os.path.abspath(repo)
        with self._lock:
            wds = list(self._repo_to_wds.get(repo, []))
            layout = scanner.repo_layout(repo)
            if layout is None:
                return

            # A linked worktree's .git is a pointer file.  Watch the actual
            # per-worktree gitdir (HEAD/logs/index) and the shared refs/logs
            # directories instead of the pointer itself.
            private_targets = self._git_targets(layout.git_dir)
            targets = list(private_targets)
            if layout.common_git_dir != layout.git_dir:
                targets.extend(self._git_targets(layout.common_git_dir))
            private_paths = {os.path.realpath(path) for path in private_targets}

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
                if target in private_paths:
                    self._wd_private_users.setdefault(wd, set()).add(repo)
                wds.append(wd)
            if wds:
                self._repo_to_wds[repo] = list(dict.fromkeys(wds))

    @staticmethod
    def _git_targets(git_dir: str) -> list[str]:
        # Recurse only through refs/reflogs, never objects or worktree files.
        targets = [git_dir, os.path.join(git_dir, "logs")]
        for root in (os.path.join(git_dir, "refs"), os.path.join(git_dir, "logs", "refs")):
            targets.extend(directory for directory, _, _ in os.walk(root, followlinks=False))
        return targets

    def _refresh_watches_for_events(self, events: list[object]) -> None:
        """New namespaces and deleted/recreated directories need fresh watches."""
        refresh: set[str] = set()
        with self._lock:
            for event in events:
                wd = getattr(event, "wd", None)
                mask = getattr(event, "mask", 0)
                users = set(self._wd_users.get(wd, set()))
                invalidated = mask & (flags.IGNORED | flags.DELETE_SELF | flags.MOVE_SELF)
                if invalidated:
                    self._wd_users.pop(wd, None)
                    self._wd_private_users.pop(wd, None)
                    self._wd_to_repo.pop(wd, None)
                    for directory, descriptor in list(self._dir_to_wd.items()):
                        if descriptor == wd:
                            self._dir_to_wd.pop(directory)
                    for repo in users:
                        self._repo_to_wds[repo] = [value for value in self._repo_to_wds.get(repo, []) if value != wd]
                    if not mask & flags.IGNORED:
                        try:
                            self._inotify.rm_watch(wd)
                        except OSError:
                            pass
                if invalidated or (mask & flags.ISDIR and mask & (flags.CREATE | flags.MOVED_TO | flags.DELETE)):
                    refresh.update(users)
        for repo in refresh:
            self.watch(repo)

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

    @staticmethod
    def _group_for_repo(repo: str) -> str:
        layout = scanner.repo_layout(repo)
        if layout is None:
            return os.path.realpath(repo)
        return os.path.realpath(layout.common_root)

    @staticmethod
    def _shared_representative(repos: set[str]) -> str | None:
        """Choose the normal repository for one shared-gitdir event."""
        for repo in sorted(repos):
            layout = scanner.repo_layout(repo)
            if layout is not None and not layout.is_worktree:
                return repo
        return sorted(repos)[0] if repos else None

    def _callbacks_for_events(self, events: list[object]) -> list[str]:
        """Route private events individually and shared events once/group."""
        private_repos: dict[str, set[str]] = {}
        shared_repos: dict[str, set[str]] = {}
        with self._lock:
            for event in events:
                name = getattr(event, "name", "")
                if name.endswith(".lock"):
                    # index.lock などのロックファイルは git 内部の一時
                    # ファイルで、自分の git status を起こし続ける。
                    continue
                wd = getattr(event, "wd", None)
                private_users = set(self._wd_private_users.get(wd, set()))
                users = set(self._wd_users.get(wd, set()))
                fallback = self._wd_to_repo.get(wd)
                if not users and fallback:
                    users.add(fallback)
                # Multi-user watches are shared even when the main checkout
                # originally registered that directory as a private target.
                # Only a single-user watch identifies one concrete worktree.
                event_private = private_users if len(users) <= 1 else set()
                for repo in event_private:
                    private_repos.setdefault(self._group_for_repo(repo), set()).add(repo)

                # Users not owning the private directory observe this as a
                # shared-gitdir event.  When there is no private owner, every
                # user is shared.  Keep all candidates here, then collapse
                # only the representative callback per common repository.
                shared_users = users - event_private
                if not event_private:
                    shared_users = users
                for repo in shared_users:
                    shared_repos.setdefault(self._group_for_repo(repo), set()).update(users)

        callbacks = sorted(repo for repos in private_repos.values() for repo in repos)
        for group, repos in shared_repos.items():
            if private_repos.get(group):
                continue
            representative = self._shared_representative(repos)
            if representative is not None:
                callbacks.append(representative)
        return callbacks

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                events = self._inotify.read(timeout=1000)
            except (OSError, ValueError):
                if not self._stop.is_set():
                    raise
                break
            callbacks = self._callbacks_for_events(events)
            self._refresh_watches_for_events(events)
            for repo in callbacks:
                self._on_change(repo)
