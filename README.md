# currency-converter

A small currency converter web app with near-real-time FX rates. You can install it as a PWA.

- **Backend:** Python / FastAPI. It caches rates in memory and refreshes them in the background *before* the cache expires.
- **Rates:** [Yahoo Finance](https://finance.yahoo.com) quotes (`XXX=X` pairs) are the primary source. For any currency Yahoo doesn't return, the app falls back to the free [ExchangeRate-API open endpoint](https://www.exchangerate-api.com/docs/free) (no key needed). If both fail, it keeps serving the last good rates.
- **Frontend:** plain HTML/CSS/JS with no build step. You can add, remove and reorder currencies and pick a light, dark or system theme. Preferences are stored in `localStorage`, and the last rates are cached so the app also opens offline.

## Run locally (debug)

```bash
./start.sh                 # http://localhost:8000, auto-reload
PORT=9000 CACHE_TTL_SECONDS=900 ./start.sh
```

`start.sh` creates `.venv`, installs `requirements-dev.txt`, and runs uvicorn with `--reload`.

Run the tests:

```bash
.venv/bin/python -m pytest -q
```

## Docker

```bash
docker compose up -d --build
# or: CACHE_TTL_SECONDS=900 PORT=8080 docker compose up -d --build
```

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `CACHE_TTL_SECONDS` | `300` | How long fetched rates stay valid (e.g. 300 = 5 min, 900 = 15 min). |
| `REFRESH_MARGIN_SECONDS` | 20% of TTL, max 60 | How many seconds before expiry the background task refetches. |
| `LOG_LEVEL` | `warning` | Log verbosity. Only errors and failed sources are logged by default; set `debug` to see each refresh. HTTP access logs are disabled. |
| `PORT` | `8000` | HTTP port. |

Run a single uvicorn worker, so there is one shared cache and refresher.

## API

- `GET /api/rates`: rates expressed as units per 1 USD, plus where each rate came from, `updated_at`, `expires_at` and `stale`.
- `GET /api/currencies`: the supported currencies and the default selection.
- `GET /healthz`: health check.

## PWA

Browsers only allow installing a PWA from `localhost` or over **HTTPS**. In production, put the app behind a TLS-terminating reverse proxy (Caddy, nginx, Traefik, …).

If you change the frontend, bump `VERSION` in `static/sw.js` so installed clients pick up the new files. To regenerate the icons, run `python scripts/generate_icons.py` (needs Pillow).
