from __future__ import annotations

import logging
import mimetypes
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .currencies import CURRENCIES, DEFAULT_SELECTION
from .rates import RateService

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "WARNING").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("currency-converter")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
CACHE_TTL_SECONDS = float(os.getenv("CACHE_TTL_SECONDS", "300"))
_margin = os.getenv("REFRESH_MARGIN_SECONDS")
REFRESH_MARGIN_SECONDS = float(_margin) if _margin else None
# Yahoo answers 429 to full browser UA strings sent without browser cookies; a bare one works.
USER_AGENT = "Mozilla/5.0"

mimetypes.add_type("application/manifest+json", ".webmanifest")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(10.0), headers={"User-Agent": USER_AGENT}, follow_redirects=True
    ) as client:
        service = RateService(
            codes=list(CURRENCIES),
            client=client,
            ttl=CACHE_TTL_SECONDS,
            refresh_margin=REFRESH_MARGIN_SECONDS,
        )
        app.state.rates = service
        log.debug("cache TTL %ss, refreshing %ss before expiry", service.ttl, service.refresh_margin)
        service.start()
        try:
            yield
        finally:
            await service.stop()


app = FastAPI(title="Currency Converter", lifespan=lifespan)


@app.middleware("http")
async def revalidate_by_default(request: Request, call_next):
    # Make browsers revalidate static files (ETag -> 304) so HTML, CSS and JS never mix versions.
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


@app.get("/api/rates")
async def get_rates(request: Request):
    service: RateService = request.app.state.rates
    try:
        snap = await service.get()
    except Exception as exc:  # noqa: BLE001
        log.error("no rates available: %s", exc)
        return JSONResponse({"error": "rates unavailable"}, status_code=503)
    return JSONResponse(
        {
            "base": snap.base,
            "rates": snap.rates,
            "sources": snap.sources,
            "updated_at": _iso(snap.fetched_at),
            "expires_at": _iso(snap.expires_at),
            "ttl": service.ttl,
            "stale": snap.is_stale,
        },
        # Clients always ask the server; the server's in-memory cache does the caching.
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/api/currencies")
async def get_currencies():
    return {
        "currencies": [{"code": c, "name": n} for c, n in CURRENCIES.items()],
        "defaults": DEFAULT_SELECTION,
    }


@app.get("/healthz")
async def healthz(request: Request):
    snap = request.app.state.rates.snapshot
    return {"status": "ok", "rates_loaded": snap is not None, "stale": snap.is_stale if snap else None}


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    # The service worker must be served from the root for a "/" scope and never be cached long.
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
