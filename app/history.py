"""Historical FX series for the rate chart.

Every series is built from Yahoo's ``<CODE>=X`` pairs (units of CODE per 1 USD), so a base -> quote
series is ``usd_quote / usd_base`` at each timestamp both legs share.
"""
from __future__ import annotations

import logging
import time
from typing import Dict, List, Optional, Tuple

import httpx

from .rates import YAHOO_CHART_URL

log = logging.getLogger(__name__)

# range -> (Yahoo range, Yahoo interval, bucket size in seconds used to line the two legs up)
RANGES: Dict[str, Tuple[str, str, int]] = {
    "1d": ("1d", "5m", 300),
    "1w": ("5d", "30m", 1800),
    "1m": ("1mo", "1d", 86400),
    "3m": ("3mo", "1d", 86400),
    "1y": ("1y", "1d", 86400),
}
CACHE_SECONDS = {"1d": 60, "1w": 300, "1m": 900, "3m": 900, "1y": 900}
MAX_CACHE_ENTRIES = 512

Series = Dict[int, float]  # bucket -> close
_cache: Dict[tuple, Tuple[float, List[List[float]]]] = {}


async def fetch_series(client: httpx.AsyncClient, code: str, rng: str) -> Series:
    """Closing prices of USD -> ``code`` keyed by time bucket; empty for USD itself."""
    if code == "USD":
        return {}
    yahoo_range, interval, bucket = RANGES[rng]
    resp = await client.get(
        YAHOO_CHART_URL.format(symbol=f"{code}=X"), params={"range": yahoo_range, "interval": interval}
    )
    resp.raise_for_status()
    result = resp.json()["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    out: Series = {}
    for ts, close in zip(result.get("timestamp") or [], closes):
        if close and close > 0:
            out[int(ts) // bucket] = float(close)  # later samples in a bucket win
    return out


def combine(base: Series, quote: Series, base_code: str, quote_code: str, bucket: int) -> List[List[float]]:
    """[[unix_ts, rate], ...] for 1 base_code in quote_code, oldest first."""
    if base_code == "USD":
        pairs = {b: v for b, v in quote.items()}
    elif quote_code == "USD":
        pairs = {b: 1.0 / v for b, v in base.items()}
    else:
        pairs = {b: quote[b] / base[b] for b in base.keys() & quote.keys()}
    return [[b * bucket, round(v, 6)] for b, v in sorted(pairs.items())]


async def get_history(client: httpx.AsyncClient, base: str, quote: str, rng: str) -> List[List[float]]:
    key = (base, quote, rng)
    hit = _cache.get(key)
    if hit and time.time() < hit[0]:
        return hit[1]
    base_s = await fetch_series(client, base, rng)
    quote_s = await fetch_series(client, quote, rng)
    points = combine(base_s, quote_s, base, quote, RANGES[rng][2])
    if len(_cache) >= MAX_CACHE_ENTRIES:
        _cache.clear()
    if points:
        _cache[key] = (time.time() + CACHE_SECONDS[rng], points)
    return points
