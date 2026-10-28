"""FX rate fetching and a self-refreshing in-memory cache.

All rates are stored as "units of currency per 1 USD", so converting
A -> B is ``amount * rates[B] / rates[A]``.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import Counter
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

import httpx

log = logging.getLogger(__name__)

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
OPEN_ER_URL = "https://open.er-api.com/v6/latest/USD"
FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates"

Fetcher = Callable[[httpx.AsyncClient, Sequence[str]], Awaitable[Dict[str, float]]]


async def fetch_yahoo(client: httpx.AsyncClient, codes: Sequence[str]) -> Dict[str, float]:
    """Near-real-time quotes from Yahoo Finance. ``JPY=X`` is the USD/JPY pair."""
    sem = asyncio.Semaphore(8)

    async def one(code: str) -> Tuple[str, Optional[float]]:
        async with sem:
            try:
                resp = await client.get(
                    YAHOO_CHART_URL.format(symbol=f"{code}=X"),
                    params={"range": "1d", "interval": "1d"},
                )
                resp.raise_for_status()
                price = resp.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
                if price and float(price) > 0:
                    return code, float(price)
            except Exception as exc:  # noqa: BLE001 - one bad symbol shouldn't fail the batch
                log.debug("yahoo: %s failed: %s", code, exc)
            return code, None

    results = await asyncio.gather(*(one(c) for c in codes if c != "USD"))
    missing = [code for code, price in results if price is None]
    if missing:
        log.debug("yahoo: no quote for %d/%d symbols: %s", len(missing), len(results), ", ".join(missing))
    return {code: price for code, price in results if price is not None}


async def fetch_open_er(client: httpx.AsyncClient, codes: Sequence[str]) -> Dict[str, float]:
    """Fallback: ExchangeRate-API open access endpoint (free, no key, updated daily)."""
    resp = await client.get(OPEN_ER_URL)
    resp.raise_for_status()
    data = resp.json()
    if data.get("result") != "success":
        raise RuntimeError(f"open.er-api error: {data.get('error-type')}")
    rates = data["rates"]
    return {c: float(rates[c]) for c in codes if c in rates and float(rates[c]) > 0}


async def fetch_frankfurter(client: httpx.AsyncClient, codes: Sequence[str]) -> Dict[str, float]:
    """Daily USD-based rates from Frankfurter's v2 batch endpoint."""
    wanted = {code for code in codes if code != "USD"}
    if not wanted:
        return {}
    # Request all available quotes: an unsupported requested code can reject the whole batch.
    resp = await client.get(FRANKFURTER_URL, params={"base": "USD"})
    resp.raise_for_status()
    rows = resp.json()
    if not isinstance(rows, list):
        raise ValueError("unexpected Frankfurter rates response")
    result: Dict[str, float] = {}
    for row in rows:
        if row.get("base") != "USD" or row.get("quote") not in wanted:
            continue
        value = float(row["rate"])
        if math.isfinite(value) and value > 0:
            result[row["quote"]] = value
    return result


AVAILABLE_FETCHERS: List[Tuple[str, Fetcher]] = [
    ("yahoo", fetch_yahoo),
    ("frankfurter", fetch_frankfurter),
    ("open.er-api", fetch_open_er),
]


def select_fetchers(primary: str = "yahoo") -> List[Tuple[str, Fetcher]]:
    """Try the configured source first, then use the others for missing currencies."""
    names = {name for name, _ in AVAILABLE_FETCHERS}
    if primary not in names:
        raise ValueError(f"unknown FX_SOURCE {primary!r}; choose from {', '.join(sorted(names))}")
    return sorted(AVAILABLE_FETCHERS, key=lambda item: item[0] != primary)


@dataclass
class Snapshot:
    rates: Dict[str, float]
    sources: Dict[str, str]
    fetched_at: float
    expires_at: float
    base: str = "USD"

    @property
    def is_stale(self) -> bool:
        return time.time() >= self.expires_at


class RateService:
    """Caches rates for ``ttl`` seconds and refreshes ``refresh_margin`` seconds
    before they expire, so clients always see a fresh, non-expired snapshot."""

    def __init__(
        self,
        codes: Sequence[str],
        client: httpx.AsyncClient,
        ttl: float = 300,
        refresh_margin: Optional[float] = None,
        retry_delay: float = 30,
        fetchers: Optional[List[Tuple[str, Fetcher]]] = None,
    ) -> None:
        self.codes = list(codes)
        self.client = client
        self.ttl = ttl
        # Default: refresh 20% of the TTL early, capped at 60s (5 min TTL -> refresh at 4 min).
        self.refresh_margin = min(60.0, ttl * 0.2) if refresh_margin is None else refresh_margin
        self.retry_delay = retry_delay
        self.fetchers = fetchers if fetchers is not None else select_fetchers()
        self._snapshot: Optional[Snapshot] = None
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None

    @property
    def snapshot(self) -> Optional[Snapshot]:
        return self._snapshot

    async def get(self) -> Snapshot:
        if self._snapshot is None:
            async with self._lock:
                if self._snapshot is None:
                    await self._refresh_locked()
        assert self._snapshot is not None
        return self._snapshot

    async def refresh(self) -> Snapshot:
        async with self._lock:
            return await self._refresh_locked()

    async def _refresh_locked(self) -> Snapshot:
        started = time.monotonic()
        rates: Dict[str, float] = {"USD": 1.0}
        sources: Dict[str, str] = {"USD": "fixed"}
        for name, fetcher in self.fetchers:
            missing = [c for c in self.codes if c not in rates]
            if not missing:
                break
            try:
                got = await fetcher(self.client, missing)
            except Exception as exc:  # noqa: BLE001
                log.warning("source %s failed: %s", name, exc)
                continue
            for code, value in got.items():
                if code in missing:
                    rates[code] = value
                    sources[code] = name

        if len(rates) == 1 and len(self.codes) > 1:
            raise RuntimeError("all FX sources failed")

        # Keep the last known value for anything no source returned this round.
        previous = self._snapshot
        if previous is not None:
            for code in self.codes:
                if code not in rates and code in previous.rates:
                    rates[code] = previous.rates[code]
                    sources[code] = "stale"

        now = time.time()
        self._snapshot = Snapshot(rates=rates, sources=sources, fetched_at=now, expires_at=now + self.ttl)
        counts = Counter(source for source in sources.values() if source != "fixed")
        log.info(
            "refreshed %d/%d rates in %.2fs; sources: %s",
            len(rates), len(self.codes), time.monotonic() - started,
            ", ".join(f"{name}={count}" for name, count in sorted(counts.items())) or "none",
        )
        return self._snapshot

    async def _run(self) -> None:
        while True:
            try:
                await self.refresh()
                # Guard against a margin >= TTL turning this into a busy loop.
                delay = max(self.ttl * 0.1, self.ttl - self.refresh_margin)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("rate refresh failed; retrying in %ss", self.retry_delay)
                delay = self.retry_delay
            await asyncio.sleep(delay)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="fx-refresher")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
