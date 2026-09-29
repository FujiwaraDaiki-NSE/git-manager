import asyncio
import json

from app import main
from app.bus import Bus


def event_data(raw):
    return json.loads(raw.split('data: ', 1)[1])


def test_stream_disconnect_after_snapshot_releases_subscription(monkeypatch):
    bus = Bus()
    monkeypatch.setattr(main, 'bus', bus)

    async def scenario():
        response = await main.stream()
        assert len(bus._subscribers) == 0
        assert (await anext(response.body_iterator)).startswith('event: snapshot\n')
        assert len(bus._subscribers) == 1
        await response.body_iterator.aclose()
        assert len(bus._subscribers) == 0

    asyncio.run(scenario())


def test_reconnect_receives_current_scan_and_fetch_states(monkeypatch):
    bus = Bus()
    monkeypatch.setattr(main, 'bus', bus)
    monkeypatch.setattr(main, 'scanning', {'active': True, 'found': 12})
    monkeypatch.setattr(main, 'fetching', {'active': True, 'total': 3})

    async def scenario():
        response = await main.stream()
        stream = response.body_iterator
        try:
            await anext(stream)
            scan = await anext(stream)
            fetch = await anext(stream)
            assert scan.startswith('event: scan\n')
            assert event_data(scan) == {'active': True, 'found': 12}
            assert fetch.startswith('event: fetch\n')
            assert event_data(fetch) == {'active': True, 'total': 3}
            main.scanning['active'] = False
            bus.publish('scan', dict(main.scanning))
            assert event_data(await anext(stream))['active'] is False
        finally:
            await stream.aclose()
        fresh = (await main.stream()).body_iterator
        try:
            await anext(fresh)
            assert event_data(await anext(fresh))['active'] is False
        finally:
            await fresh.aclose()
        assert len(bus._subscribers) == 0

    asyncio.run(scenario())
