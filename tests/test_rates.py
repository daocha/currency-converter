import asyncio
import logging

import httpx
import pytest

from app.rates import FRANKFURTER_URL, RateService, fetch_frankfurter, select_fetchers


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


def test_frankfurter_fetches_usd_rates_and_ignores_unrequested_rows():
    def respond(request):
        assert str(request.url).startswith(FRANKFURTER_URL)
        assert request.url.params["base"] == "USD"
        assert "quotes" not in request.url.params
        return httpx.Response(200, json=[
            {"date": "2026-10-26", "base": "USD", "quote": "EUR", "rate": 0.92},
            {"date": "2026-10-26", "base": "USD", "quote": "JPY", "rate": 0},
            {"date": "2026-10-26", "base": "USD", "quote": "GBP", "rate": 0.8},
        ])

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_frankfurter(client, ["USD", "EUR", "JPY"])

    assert run(scenario()) == {"EUR": 0.92}


def test_configured_source_is_first_with_fallbacks():
    assert [name for name, _ in select_fetchers()] == ["yahoo", "frankfurter", "open.er-api"]
    assert [name for name, _ in select_fetchers("frankfurter")] == ["frankfurter", "yahoo", "open.er-api"]
    assert [name for name, _ in select_fetchers("open.er-api")] == ["open.er-api", "yahoo", "frankfurter"]
    with pytest.raises(ValueError, match="unknown FX_SOURCE"):
        select_fetchers("unknown")


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


def test_refresh_log_names_sources_and_counts(caplog):
    async def scenario():
        svc = RateService(
            ["USD", "EUR", "JPY"], client=None,
            fetchers=[
                ("frankfurter", make_fetcher({"EUR": 0.9})),
                ("yahoo", make_fetcher({"JPY": 150.0})),
            ],
        )
        await svc.refresh()

    with caplog.at_level(logging.INFO, logger="app.rates"):
        run(scenario())
    assert "sources: frankfurter=1, yahoo=1" in caplog.text


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
