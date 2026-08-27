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
        with self._lock:
            if repo in self._repo_to_wds:
                return
            wds: list[int] = []
            for sub in (".git", os.path.join(".git", "refs"), os.path.join(".git", "logs", "refs")):
                target = os.path.join(repo, sub)
                if not os.path.isdir(target):
                    continue
                try:
                    wd = self._inotify.add_watch(target, WATCH_FLAGS)
                except OSError:
                    continue
                wds.append(wd)
                self._wd_to_repo[wd] = repo
            if wds:
                self._repo_to_wds[repo] = wds

    def unwatch(self, repo: str) -> None:
        if self._inotify is None:
            return
        with self._lock:
            for wd in self._repo_to_wds.pop(repo, []):
                self._wd_to_repo.pop(wd, None)
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
            touched: set[str] = set()
            with self._lock:
                for event in events:
                    # index.lock などのロックファイルは git 内部の一時ファイル。
                    # これを拾うと自分の git status が自分を起こし続ける
                    if event.name.endswith(".lock"):
                        continue
                    repo = self._wd_to_repo.get(event.wd)
                    if repo:
                        touched.add(repo)
            for repo in touched:
                self._on_change(repo)
