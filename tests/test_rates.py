import asyncio

import pytest

from app.rates import RateService


def run(coro):
    return asyncio.run(coro)


def make_fetcher(values, calls=None, fail=False):
    async def fetcher(client, codes):
        if calls is not None:
            calls.append(list(codes))
        if fail:
            raise RuntimeError("boom")
        return {c: v for c, v in values.items() if c in codes}

    return fetcher


def test_primary_then_fallback_fills_missing():
    calls = []

    async def scenario():
        svc = RateService(
            ["USD", "EUR", "JPY", "XYZ"], client=None, ttl=300,
            fetchers=[
                ("primary", make_fetcher({"EUR": 0.9})),
                ("fallback", make_fetcher({"EUR": 0.5, "JPY": 150.0}, calls)),
            ],
        )
        return await svc.get()

    snap = run(scenario())
    assert snap.rates == {"USD": 1.0, "EUR": 0.9, "JPY": 150.0}
    assert snap.sources == {"USD": "fixed", "EUR": "primary", "JPY": "fallback"}
    assert calls == [["JPY", "XYZ"]]  # fallback only asked for what was missing
    assert snap.expires_at - snap.fetched_at == 300


def test_failed_source_is_skipped_and_previous_values_kept():
    async def scenario():
        svc = RateService(
            ["USD", "EUR", "JPY"], client=None, ttl=300,
            fetchers=[("primary", make_fetcher({"EUR": 0.9, "JPY": 150.0}))],
        )
        await svc.refresh()
        svc.fetchers = [("broken", make_fetcher({}, fail=True)), ("partial", make_fetcher({"EUR": 0.95}))]
        return await svc.refresh()

    snap = run(scenario())
    assert snap.rates["EUR"] == 0.95
    assert snap.rates["JPY"] == 150.0
    assert snap.sources["JPY"] == "stale"


def test_all_sources_failing_raises_and_keeps_old_snapshot():
    async def scenario():
        svc = RateService(
            ["USD", "EUR"], client=None, ttl=300,
            fetchers=[("primary", make_fetcher({"EUR": 0.9}))],
        )
        first = await svc.refresh()
        svc.fetchers = [("broken", make_fetcher({}, fail=True))]
        with pytest.raises(RuntimeError):
            await svc.refresh()
        return first, svc.snapshot

    first, current = run(scenario())
    assert current is first


def test_background_refresh_happens_before_expiry():
    calls = []

    async def scenario():
        svc = RateService(
            ["USD", "EUR"], client=None, ttl=0.5, refresh_margin=0.3,
            fetchers=[("primary", make_fetcher({"EUR": 0.9}, calls))],
        )
        svc.start()
        await asyncio.sleep(0.05)
        first = svc.snapshot
        await asyncio.sleep(0.3)  # refresh is due at 0.2s, expiry at 0.5s
        second = svc.snapshot
        await svc.stop()
        return first, second

    first, second = run(scenario())
    assert second is not first
    assert second.fetched_at < first.expires_at
    assert len(calls) >= 2


def test_concurrent_cold_gets_fetch_once():
    calls = []

    async def scenario():
        svc = RateService(
            ["USD", "EUR"], client=None, ttl=300,
            fetchers=[("primary", make_fetcher({"EUR": 0.9}, calls))],
        )
        return await asyncio.gather(*(svc.get() for _ in range(5)))

    snaps = run(scenario())
    assert len(calls) == 1
    assert all(s is snaps[0] for s in snaps)
