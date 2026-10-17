"""Historical FX series for the rate chart, kept in a local SQLite database.

Only the USD legs are stored (Yahoo's ``<CODE>=X`` pairs, i.e. units of CODE per 1 USD). Any
base -> quote series is ``usd_quote / usd_base`` at the timestamps both legs share, which matches
how the live rates in ``rates.py`` are derived.

Gaps: every refresh asks Yahoo for everything *since the newest stored bar* (minus a small overlap
that also refreshes the still-forming last bar), not just "the latest". After downtime the next
refresh therefore backfills the whole outage, as far back as Yahoo serves that interval.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

import httpx

from .rates import YAHOO_CHART_URL

log = logging.getLogger(__name__)

DAY = 86400


@dataclass(frozen=True)
class Interval:
    name: str          # Yahoo interval
    bucket: int        # seconds per bar; also the key resolution in the database
    lookback: int      # seconds of history to backfill (and the most we ever re-request)
    keep: int          # newest bars kept per currency (0 = keep everything)
    every: int         # seconds between refreshes
    overlap: int       # re-request this much before the newest stored bar


INTERVALS: Dict[str, Interval] = {
    "5m": Interval("5m", 300, 4 * DAY, 1200, 300, 3600),
    "30m": Interval("30m", 1800, 14 * DAY, 600, 1800, 3 * 3600),
    "1d": Interval("1d", DAY, 370 * DAY, 0, 3600, 3 * DAY),
}

# chart range -> (interval, how much of it to show): ("bars", n) = newest n bars, ("days", n) = last n days.
# Intraday ranges count bars rather than calendar time so they still show data on weekends.
RANGES: Dict[str, Tuple[str, str, int]] = {
    "1d": ("5m", "bars", 288),
    "1w": ("30m", "bars", 240),
    "1m": ("1d", "days", 31),
    "3m": ("1d", "days", 93),
    "1y": ("1d", "days", 366),
}

Series = Dict[int, float]  # bucket -> close
Bars = List[Tuple[int, float]]  # (timestamp, close)
BarFetcher = Callable[[httpx.AsyncClient, str, Interval, int, int], Awaitable[Bars]]


async def fetch_bars(client: httpx.AsyncClient, code: str, iv: Interval, start: int, end: int) -> Bars:
    """Closes of USD -> ``code`` between two unix times; nulls (no trades) are dropped."""
    resp = await client.get(
        YAHOO_CHART_URL.format(symbol=f"{code}=X"),
        params={"period1": start, "period2": end, "interval": iv.name},
    )
    resp.raise_for_status()
    result = resp.json()["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    return [(int(ts), float(c)) for ts, c in zip(result.get("timestamp") or [], closes) if c and c > 0]


def combine(base: Series, quote: Series, base_code: str, quote_code: str, bucket: int) -> List[List[float]]:
    """[[unix_ts, rate], ...] for 1 base_code in quote_code, oldest first."""
    if base_code == "USD":
        pairs = dict(quote)
    elif quote_code == "USD":
        pairs = {b: 1.0 / v for b, v in base.items()}
    else:
        pairs = {b: quote[b] / base[b] for b in base.keys() & quote.keys()}
    return [[b * bucket, round(v, 6)] for b, v in sorted(pairs.items())]


class HistoryStore:
    """Thin SQLite wrapper. Every call opens its own short-lived connection, so it is safe to use
    from worker threads (WAL mode lets readers proceed while a refresh writes)."""

    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS bars ("
                " code TEXT NOT NULL, interval TEXT NOT NULL, bucket INTEGER NOT NULL, close REAL NOT NULL,"
                " PRIMARY KEY (code, interval, bucket)) WITHOUT ROWID"
            )

    @contextmanager
    def _conn(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:  # commit on success, roll back on error
                yield db
        finally:
            db.close()

    def newest(self, code: str, interval: str) -> Optional[int]:
        with self._conn() as db:
            row = db.execute("SELECT MAX(bucket) FROM bars WHERE code=? AND interval=?", (code, interval)).fetchone()
        return row[0]

    def upsert(self, code: str, iv: Interval, bars: Bars, drop_before: Optional[int] = None) -> None:
        rows = {ts // iv.bucket: close for ts, close in bars}  # later bars in a bucket win
        with self._conn() as db:
            if drop_before is not None:  # a gap longer than the lookback: older rows would be discontinuous
                db.execute(
                    "DELETE FROM bars WHERE code=? AND interval=? AND bucket<?", (code, iv.name, drop_before // iv.bucket)
                )
            db.executemany(
                "INSERT INTO bars (code, interval, bucket, close) VALUES (?,?,?,?)"
                " ON CONFLICT(code, interval, bucket) DO UPDATE SET close=excluded.close",
                [(code, iv.name, b, c) for b, c in rows.items()],
            )
            if iv.keep:
                db.execute(
                    "DELETE FROM bars WHERE code=? AND interval=? AND bucket <"
                    " (SELECT bucket FROM bars WHERE code=? AND interval=? ORDER BY bucket DESC LIMIT 1 OFFSET ?)",
                    (code, iv.name, code, iv.name, iv.keep - 1),
                )

    def load(self, code: str, interval: str, limit: int) -> Series:
        with self._conn() as db:
            rows = db.execute(
                "SELECT bucket, close FROM bars WHERE code=? AND interval=? ORDER BY bucket DESC LIMIT ?",
                (code, interval, limit),
            ).fetchall()
        return dict(rows)


class HistoryService:
    def __init__(
        self,
        codes: Sequence[str],
        client: Optional[httpx.AsyncClient],
        store: HistoryStore,
        fetcher: BarFetcher = fetch_bars,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.codes = [c for c in codes if c != "USD"]
        self.client = client
        self.store = store
        self.fetcher = fetcher
        self.clock = clock
        self._locks: Dict[Tuple[str, str], asyncio.Lock] = {}
        self._sem: Optional[asyncio.Semaphore] = None  # created on first use, inside the running loop
        self._task: Optional[asyncio.Task] = None

    def _lock(self, code: str, interval: str) -> asyncio.Lock:
        return self._locks.setdefault((code, interval), asyncio.Lock())

    async def refresh_leg(self, code: str, iv: Interval, only_if_empty: bool = False) -> int:
        """Fetch everything since the newest stored bar and store it. Returns the bars received."""
        async with self._lock(code, iv.name):  # concurrent callers queue here instead of all hitting Yahoo
            now = int(self.clock())
            earliest = now - iv.lookback
            newest = await asyncio.to_thread(self.store.newest, code, iv.name)
            if only_if_empty and newest is not None:
                return 0  # someone else filled it while we waited
            if newest is None:
                start, drop_before = earliest, None
            else:
                start = max(newest * iv.bucket - iv.overlap, earliest)
                drop_before = earliest if newest * iv.bucket - iv.overlap < earliest else None
            if self._sem is None:
                self._sem = asyncio.Semaphore(8)
            async with self._sem:
                bars = await self.fetcher(self.client, code, iv, start, now)
            if bars:
                await asyncio.to_thread(self.store.upsert, code, iv, bars, drop_before)
            return len(bars)

    async def refresh_interval(self, iv: Interval) -> None:
        results = await asyncio.gather(*(self.refresh_leg(c, iv) for c in self.codes), return_exceptions=True)
        failed = [c for c, r in zip(self.codes, results) if isinstance(r, Exception)]
        if failed:
            # Nothing is lost: the next run starts again from the newest stored bar of each leg.
            log.warning("history %s: %d/%d currencies failed (%s)", iv.name, len(failed), len(self.codes), ", ".join(failed))

    async def _ensure(self, code: str, iv: Interval) -> None:
        if await asyncio.to_thread(self.store.newest, code, iv.name) is None:
            await self.refresh_leg(code, iv, only_if_empty=True)

    async def get(self, base: str, quote: str, rng: str) -> List[List[float]]:
        interval, unit, amount = RANGES[rng]
        iv = INTERVALS[interval]
        legs = [c for c in (base, quote) if c != "USD"]
        await asyncio.gather(*(self._ensure(c, iv) for c in legs))  # first use before the background fill got there
        limit = iv.keep or 400
        series = {c: await asyncio.to_thread(self.store.load, c, iv.name, limit) for c in legs}
        points = combine(series.get(base, {}), series.get(quote, {}), base, quote, iv.bucket)
        if unit == "bars":
            return points[-amount:]
        if not points:
            return points
        cutoff = points[-1][0] - amount * DAY
        return [p for p in points if p[0] >= cutoff]

    async def _run(self) -> None:
        due = {name: 0.0 for name in INTERVALS}  # all due at once on start-up: this is the gap backfill
        while True:
            now = self.clock()
            for name, iv in INTERVALS.items():
                if now >= due[name]:
                    try:
                        await self.refresh_interval(iv)
                    except asyncio.CancelledError:
                        raise
                    except Exception:  # noqa: BLE001
                        log.exception("history refresh %s failed", name)
                    due[name] = self.clock() + iv.every
            await asyncio.sleep(max(5.0, min(due.values()) - self.clock()))

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="history-refresher")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
