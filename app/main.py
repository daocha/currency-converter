from __future__ import annotations

import hashlib
import html
import logging
import mimetypes
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from .currencies import CURRENCIES, DEFAULT_SELECTION
from .history import RANGES, HistoryService, HistoryStore
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
# Optional sub-path (e.g. "/fx") for reverse proxies that forward /fx/... without stripping it.
# The app keeps serving "/" too, so http://<ip>:8000/ works either way.
_base = os.getenv("BASE_PATH", "").strip("/")
BASE_PATH = f"/{_base}" if _base else ""
# SQLite file with the stored FX history; keep it on a persistent volume (and outside app/, which
# the dev server watches for reloads).
HISTORY_DB = os.getenv("HISTORY_DB") or str(Path(__file__).resolve().parent.parent / "data" / "history.db")
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
        history = HistoryService(list(CURRENCIES), client, HistoryStore(HISTORY_DB))
        app.state.history = history
        log.debug("cache TTL %ss, refreshing %ss before expiry", service.ttl, service.refresh_margin)
        service.start()
        history.start()
        try:
            yield
        finally:
            await history.stop()
            await service.stop()


app = FastAPI(title="Currency Converter", lifespan=lifespan)


class BasePathMiddleware:
    """Serve the app under BASE_PATH as well as at the root."""

    def __init__(self, app, base_path: str) -> None:
        self.app = app
        self.base_path = base_path

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope["path"]
            if path == self.base_path:
                # The frontend uses relative URLs, which need the trailing slash.
                query = scope.get("query_string", b"").decode("latin-1")
                location = self.base_path + "/" + (f"?{query}" if query else "")
                await RedirectResponse(location, status_code=308)(scope, receive, send)
                return
            if path.startswith(self.base_path + "/"):
                stripped = path[len(self.base_path):]
                scope = dict(
                    scope,
                    path=stripped,
                    raw_path=stripped.encode("latin-1"),
                    state={**scope.get("state", {}), "home_path": self.base_path + "/"},
                )
        await self.app(scope, receive, send)


if BASE_PATH:
    app.add_middleware(BasePathMiddleware, base_path=BASE_PATH)


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


@app.get("/api/history")
async def history(request: Request, base: str, quote: str, range: str = "1m"):
    base, quote = base.upper(), quote.upper()
    if base not in CURRENCIES or quote not in CURRENCIES or range not in RANGES:
        return JSONResponse({"error": "invalid base, quote or range"}, status_code=400)
    try:
        points = await request.app.state.history.get(base, quote, range)
    except Exception as exc:  # noqa: BLE001
        log.warning("history %s/%s %s failed: %s", base, quote, range, exc)
        points = []
    if not points:
        return JSONResponse({"error": "history unavailable"}, status_code=503)
    return JSONResponse(
        {"base": base, "quote": quote, "range": range, "points": points},
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/healthz")
async def healthz(request: Request):
    snap = request.app.state.rates.snapshot
    return {"status": "ok", "rates_loaded": snap is not None, "stale": snap.is_stale if snap else None}


# index.html references these; each gets a ?v=<content hash> so browsers load new files after a deploy.
VERSIONED_ASSETS = ("styles.css", "calc.js", "i18n.js", "app.js")
_index_cache: dict = {}


def _render_index() -> tuple:
    files = [STATIC_DIR / "index.html", *(STATIC_DIR / name for name in VERSIONED_ASSETS)]
    key = tuple(f.stat().st_mtime_ns for f in files)
    if _index_cache.get("key") != key:
        html = files[0].read_text(encoding="utf-8")
        for name, path in zip(VERSIONED_ASSETS, files[1:]):
            version = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
            html = html.replace(f'"{name}"', f'"{name}?v={version}"')
        etag = '"' + hashlib.sha256(html.encode()).hexdigest()[:16] + '"'
        _index_cache.update(key=key, html=html, etag=etag)
    return _index_cache["html"], _index_cache["etag"]


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
async def index(request: Request):
    html, etag = _render_index()
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return HTMLResponse(html, headers={"ETag": etag})


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    # Its scope is the directory it's served from ("/" or e.g. "/fx/"); never cache it long.
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.exception_handler(404)
async def not_found(request: Request, exc):
    home_path = html.escape(request.scope.get("state", {}).get("home_path", "./"), quote=True)
    page = (STATIC_DIR / "404.html").read_text(encoding="utf-8")
    return HTMLResponse(page.replace('href="./"', f'href="{home_path}"'), status_code=404)


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
