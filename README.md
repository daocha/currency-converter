<img src="fx-banner.png" alt="FX / Currency Converter"/>

# currency-converter

A small currency converter web app with near-real-time FX rates. You can install it as a PWA.

- **Backend:** Python / FastAPI. It caches rates in memory and refreshes them in the background *before* the cache expires.
- **Rates:** [Yahoo Finance](https://finance.yahoo.com) quotes (`XXX=X` pairs) are the primary source. For any currency Yahoo doesn't return, the app falls back to the free [ExchangeRate-API open endpoint](https://www.exchangerate-api.com/docs/free) (no key needed). If both fail, it keeps serving the last good rates.
- **Frontend:** plain HTML/CSS/JS with no build step. You can add, remove and reorder currencies and pick a light, dark or system theme. Amount fields accept simple calculations (`+ − × ÷` and parentheses, e.g. `120×3+15`); they are entered with a built-in calculator keypad instead of the device keyboard (a physical keyboard also works on desktop). Preferences are stored in `localStorage`, and the last rates are cached so the app also opens offline.

## Run locally (debug)

```bash
./start.sh                 # http://localhost:8000, auto-reload
PORT=9000 CACHE_TTL_SECONDS=900 ./start.sh
```

`start.sh` creates `.venv`, installs `requirements-dev.txt`, and runs uvicorn with `--reload`.

Run the tests:

```bash
.venv/bin/python -m pytest -q   # backend
node --test tests/              # calculator (static/calc.js)
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
| `HISTORY_DB` | `data/history.db` (`/data/history.db` in Docker) | SQLite file holding the stored FX history used by the charts. Mount a volume on its directory. |
| `PORT` | `8000` | HTTP port. |
| `BASE_PATH` | *(empty)* | Optional sub-path such as `/fx`. Only needed if your proxy forwards `/fx/...` **without** stripping the prefix. The app keeps serving `/` either way. |

Run a single uvicorn worker, so there is one shared cache and refresher.

### Chart history

`/api/history` is served from a local SQLite database, not fetched per request. Only the USD legs
(45 currencies) are stored, at 5-minute, 30-minute and daily resolution, and any pair is computed
as `usd_quote / usd_base`. A background task refreshes each resolution; every refresh requests
everything since the newest stored bar, so after downtime the next refresh backfills the outage
(as far back as 4 days of 5-minute, 14 days of 30-minute and 370 days of daily data).

## API

- `GET /api/rates`: rates expressed as units per 1 USD, plus where each rate came from, `updated_at`, `expires_at` and `stale`.
- `GET /api/currencies`: the supported currencies and the default selection.
- `GET /healthz`: health check.

## Hosting under a sub-path (e.g. `https://example.com/fx/`)

The frontend uses only relative URLs, so the same build works at `http://<ip>:8000/` and behind a proxy at `/fx/`.

**nginx** (strips the prefix, so no app config is needed). With a trailing slash on both `location` and `proxy_pass`, nginx also redirects `/fx` to `/fx/`:

```nginx
location /fx/ {
    proxy_pass http://127.0.0.1:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If your proxy forwards the path unchanged (e.g. Traefik without `stripprefix`), set `BASE_PATH=/fx`. The app then serves both `/fx/...` and `/...`, and redirects `/fx` to `/fx/`.

The URL must end with a slash (`/fx/`) because relative URLs resolve against it.

## PWA

Browsers only allow installing a PWA from `localhost` or over **HTTPS**. In production, put the app behind a TLS-terminating reverse proxy (Caddy, nginx, Traefik, …).

The server stamps `styles.css`, `calc.js` and `app.js` in `index.html` with a content-hash version (`?v=…`), so browsers load changed files automatically. Bump `VERSION` in `static/sw.js` only when you want installed clients to drop their old offline caches. To regenerate the icons, run `python scripts/generate_icons.py` (needs Pillow).
