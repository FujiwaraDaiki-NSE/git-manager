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
        self._wd_to_dir: dict[int, str] = {}
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
                os.path.join(layout.git_dir, "refs", "heads"),
                os.path.join(layout.git_dir, "logs"),
                os.path.join(layout.git_dir, "logs", "refs"),
            ]
            targets = list(private_targets)
            if layout.common_git_dir != layout.git_dir:
                targets.extend(
                    (
                        layout.common_git_dir,
                        os.path.join(layout.common_git_dir, "refs"),
                        os.path.join(layout.common_git_dir, "refs", "heads"),
                        os.path.join(layout.common_git_dir, "logs"),
                        os.path.join(layout.common_git_dir, "logs", "refs"),
                    )
                )

            private_paths = {os.path.realpath(path) for path in private_targets}
            for candidate in targets:
                target = os.path.realpath(candidate)
                wd = self._add_watch_target(
                    target,
                    {repo},
                    {repo} if target in private_paths else set(),
                )
                if wd is not None:
                    wds.append(wd)
                if self._is_heads_directory(target):
                    wds.extend(
                        self._add_existing_ref_directory_watches(
                            target,
                            {repo},
                            {repo} if target in private_paths else set(),
                        )
                    )
            if wds:
                self._repo_to_wds[repo] = list(dict.fromkeys(wds))

    @staticmethod
    def _is_heads_directory(path: str) -> bool:
        return (
            os.path.basename(path) == "heads"
            and os.path.basename(os.path.dirname(path)) == "refs"
        )

    def _add_existing_ref_directory_watches(
        self,
        root: str,
        users: set[str],
        private_users: set[str],
    ) -> list[int]:
        """Watch namespace directories already present below refs/heads."""
        if not os.path.isdir(root):
            return []
        watched: list[int] = []
        for parent, directories, _files in os.walk(root, followlinks=False):
            directories[:] = [
                name
                for name in directories
                if not os.path.islink(os.path.join(parent, name))
            ]
            for name in directories:
                wd = self._add_watch_target(
                    os.path.realpath(os.path.join(parent, name)),
                    users,
                    private_users,
                )
                if wd is not None:
                    watched.append(wd)
        return watched

    def _add_watch_target(
        self,
        target: str,
        users: set[str],
        private_users: set[str],
    ) -> int | None:
        """Register one directory for all current users of its parent."""
        if self._inotify is None or not os.path.isdir(target):
            return None
        wd = self._dir_to_wd.get(target)
        if wd is None:
            try:
                wd = self._inotify.add_watch(target, WATCH_FLAGS)
            except OSError:
                return None
            self._dir_to_wd[target] = wd
            self._wd_to_dir[wd] = target
            self._wd_users[wd] = set()
            self._wd_private_users[wd] = set()
            self._wd_to_repo[wd] = next(iter(users), "")
        self._wd_users.setdefault(wd, set()).update(users)
        self._wd_private_users.setdefault(wd, set()).update(private_users)
        for repo in users:
            repo_wds = self._repo_to_wds.setdefault(repo, [])
            if wd not in repo_wds:
                repo_wds.append(wd)
        return wd

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
                self._wd_to_dir.pop(wd, None)
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

    def _watch_created_directories(self, events: list[object]) -> None:
        if flags is None:
            return
        with self._lock:
            for event in events:
                mask = getattr(event, "mask", 0)
                name = getattr(event, "name", "")
                if not (mask & flags.ISDIR) or not (
                    mask & (flags.CREATE | flags.MOVED_TO)
                ):
                    continue
                parent = self._wd_to_dir.get(getattr(event, "wd", None))
                if parent is None:
                    continue
                heads_marker = f"{os.sep}refs{os.sep}heads"
                under_heads = parent.endswith(heads_marker) or (
                    f"{heads_marker}{os.sep}" in parent
                )
                if not under_heads and not (
                    os.path.basename(parent) == "refs" and name == "heads"
                ):
                    continue
                users = set(self._wd_users.get(getattr(event, "wd", None), set()))
                private_users = set(
                    self._wd_private_users.get(getattr(event, "wd", None), set())
                )
                target = os.path.realpath(os.path.join(parent, name))
                self._add_watch_target(
                    target,
                    users,
                    private_users,
                )
                if self._is_heads_directory(target):
                    self._add_existing_ref_directory_watches(
                        target,
                        users,
                        private_users,
                    )

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                events = self._inotify.read(timeout=1000)
            except (OSError, ValueError):
                break
            self._watch_created_directories(events)
            for repo in self._callbacks_for_events(events):
                self._on_change(repo)
