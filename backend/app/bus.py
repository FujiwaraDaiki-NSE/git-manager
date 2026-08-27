"""SSE 配信。スレッド（inotify）からも安全に投げられるようにする。"""
from __future__ import annotations

import asyncio
from typing import Any


class Bus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, event: str, data: Any) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait((event, data))
            except asyncio.QueueFull:
                pass

    def publish_threadsafe(self, event: str, data: Any) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self.publish, event, data)


bus = Bus()
