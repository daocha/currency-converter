import asyncio

from app.history import DAY, INTERVALS, HistoryService, HistoryStore, combine

FIVE = INTERVALS["5m"]
DAILY = INTERVALS["1d"]
T0 = 1_800_000_000 - 1_800_000_000 % 86400  # a UTC midnight


def run(coro):
    return asyncio.run(coro)


def test_usd_base_uses_quote_leg():
    assert combine({}, {1: 150.0, 2: 151.0}, "USD", "JPY", 86400) == [[86400, 150.0], [172800, 151.0]]


def test_usd_quote_inverts_base_leg():
    assert combine({1: 4.0}, {}, "PLN", "USD", 60) == [[60, 0.25]]


def test_cross_pair_uses_shared_buckets_only():
    pts = combine({1: 0.5, 2: 0.5, 3: 0.5}, {2: 1.0, 3: 2.0, 4: 9.0}, "EUR", "GBP", 10)
    assert pts == [[20, 2.0], [30, 4.0]]


class FakeYahoo:
    """Serves a bar every `bucket` seconds up to `self.now`, and records each request."""

    def __init__(self, now):
        self.now = now
        self.calls = []

    async def __call__(self, client, code, iv, start, end):
        self.calls.append((code, iv.name, start, end))
        first = -(-start // iv.bucket) * iv.bucket
        return [(ts, 100.0 + ts / iv.bucket % 7) for ts in range(first, min(end, self.now) + 1, iv.bucket)]


def make(tmp_path, fake, clock):
    return HistoryService(["USD", "JPY", "EUR"], None, HistoryStore(str(tmp_path / "h.db")), fetcher=fake, clock=clock)


def buckets(svc, code, iv):
    return sorted(svc.store.load(code, iv.name, 100_000))


def test_downtime_is_backfilled_without_holes(tmp_path):
    now = [T0 + DAY]
    fake = FakeYahoo(now[0])
    svc = make(tmp_path, fake, lambda: now[0])

    run(svc.refresh_leg("JPY", FIVE))
    before = buckets(svc, "JPY", FIVE)
    assert before[-1] * 300 >= now[0] - 300

    # The app is down for 5 hours: nothing runs, but the market keeps moving.
    now[0] += 5 * 3600
    fake.now = now[0]
    run(svc.refresh_leg("JPY", FIVE))

    after = buckets(svc, "JPY", FIVE)
    assert set(before[-500:]) <= set(after)  # (the oldest bars may be pruned by the keep limit)
    assert after[-1] * 300 >= now[0] - 300
    # every 5-minute bar from before the outage up to now is present
    assert after[after.index(before[-1]):] == list(range(before[-1], after[-1] + 1))


def test_refresh_requests_from_newest_bar_not_just_latest(tmp_path):
    now = [T0 + DAY]
    fake = FakeYahoo(now[0])
    svc = make(tmp_path, fake, lambda: now[0])
    run(svc.refresh_leg("JPY", FIVE))
    newest = svc.store.newest("JPY", "5m") * 300
    now[0] += 3 * 3600
    fake.now = now[0]
    run(svc.refresh_leg("JPY", FIVE))
    _, _, start, end = fake.calls[-1]
    assert start == newest - FIVE.overlap and end == now[0]


def test_outage_longer_than_lookback_drops_the_discontinuous_tail(tmp_path):
    now = [T0 + DAY]
    fake = FakeYahoo(now[0])
    svc = make(tmp_path, fake, lambda: now[0])
    run(svc.refresh_leg("JPY", FIVE))
    old_newest = svc.store.newest("JPY", "5m")

    now[0] += 10 * DAY  # far beyond the 4-day lookback
    fake.now = now[0]
    run(svc.refresh_leg("JPY", FIVE))

    after = buckets(svc, "JPY", FIVE)
    assert min(after) * 300 >= now[0] - FIVE.lookback - 300  # stale rows from before the gap are gone
    assert old_newest not in after
    assert after == list(range(after[0], after[-1] + 1))  # contiguous


def test_failed_refresh_loses_nothing(tmp_path):
    now = [T0 + DAY]
    fake = FakeYahoo(now[0])
    svc = make(tmp_path, fake, lambda: now[0])
    run(svc.refresh_leg("JPY", FIVE))
    stored = buckets(svc, "JPY", FIVE)

    async def boom(*a):
        raise RuntimeError("yahoo down")

    svc.fetcher = boom
    now[0] += 2 * 3600
    run(svc.refresh_interval(FIVE))  # logs, does not raise
    assert buckets(svc, "JPY", FIVE) == stored

    svc.fetcher = fake
    fake.now = now[0]
    run(svc.refresh_leg("JPY", FIVE))
    after = buckets(svc, "JPY", FIVE)
    assert after == list(range(after[0], after[-1] + 1))
    assert after[-1] * 300 >= now[0] - 300


def test_in_progress_bar_is_updated_not_duplicated(tmp_path):
    svc = make(tmp_path, FakeYahoo(0), lambda: T0)
    store = svc.store
    store.upsert("JPY", DAILY, [(T0 + 100, 150.0)])
    store.upsert("JPY", DAILY, [(T0 + 5000, 151.0)])  # same day, later tick
    assert store.load("JPY", "1d", 10) == {T0 // 86400: 151.0}


def test_prunes_to_keep_newest_bars(tmp_path):
    svc = make(tmp_path, FakeYahoo(0), lambda: T0)
    bars = [(T0 + i * 300, 100.0) for i in range(FIVE.keep + 50)]
    svc.store.upsert("JPY", FIVE, bars)
    rows = svc.store.load("JPY", "5m", 10_000)
    assert len(rows) == FIVE.keep
    assert max(rows) == (T0 + (FIVE.keep + 49) * 300) // 300


def test_get_builds_cross_pair_and_fills_missing_leg_on_demand(tmp_path):
    now = T0 + 3 * DAY
    fake = FakeYahoo(now)
    svc = make(tmp_path, fake, lambda: now)
    pts = run(svc.get("JPY", "EUR", "1d"))  # nothing stored yet: both legs fetched on first use
    assert {c[0] for c in fake.calls} == {"JPY", "EUR"}
    assert 0 < len(pts) <= 288
    assert all(a[0] < b[0] for a, b in zip(pts, pts[1:]))
    n = len(fake.calls)
    run(svc.get("JPY", "EUR", "1d"))
    assert len(fake.calls) == n  # second request is served from the database


def test_concurrent_first_requests_fetch_once(tmp_path):
    now = T0 + 3 * DAY
    fake = FakeYahoo(now)
    svc = make(tmp_path, fake, lambda: now)

    async def scenario():
        await asyncio.gather(*(svc.get("USD", "JPY", "1w") for _ in range(20)))

    run(scenario())
    assert len([c for c in fake.calls if c[0] == "JPY" and c[1] == "30m"]) == 1


def test_daily_ranges_use_calendar_span(tmp_path):
    now = T0 + 400 * DAY
    svc = make(tmp_path, FakeYahoo(now), lambda: now)
    month = run(svc.get("USD", "JPY", "1m"))
    year = run(svc.get("USD", "JPY", "1y"))
    assert len(month) == 32 and len(year) == 367  # inclusive of both ends
