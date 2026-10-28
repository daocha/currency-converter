<img src="fx-banner.png" alt="FX / Currency Converter"/>

# currency-converter

A small currency converter web app with near-real-time FX rates and history charts. You can install it as a PWA (an app-like install from the browser).

## ✨ Features

- 🔢 **Calculator input:** amount fields accept simple calculations (`+ − × ÷` and parentheses, e.g. `120×3+15`). They are entered with a built-in keypad instead of the device keyboard (a physical keyboard also works on desktop).
- 📈 **Rate charts:** tap a currency's flag or name to see how 1 unit of your base currency has moved (1D, 1W, 1M, 3M, 1Y). Drag across the chart to read a value at any time. Tap outside the chart to close it.
- 📋 **Copy a value:** long-press an amount to copy it as a plain number.
- ↕️ **Your list, your order:** add and remove currencies, and drag the ☰ handle in edit mode to reorder them.
- 🌐 **English and 繁體中文:** the language follows your system, and you can switch it with the 🌐 button.
- 🌗 **Themes:** light, dark or follow the system.
- 📴 **Works offline:** preferences are stored in `localStorage` and the last rates are cached, so the app still opens without a connection.

## 🧱 How it works

- **Backend:** Python / FastAPI. It caches rates in memory and refreshes them in the background *before* the cache expires.
- **Rates:** [Yahoo Finance](https://finance.yahoo.com) quotes (`XXX=X` pairs) are the default source for live conversions. Set `FX_SOURCE` to choose another primary source. Missing currencies are filled from the other sources ([Frankfurter](https://frankfurter.dev/), daily official rates, and the free [ExchangeRate-API open endpoint](https://www.exchangerate-api.com/docs/free)); the last good rates are kept if none has a new value. The backend logs the source and currency count on each cache refresh.
- **History:** stored in a local SQLite database (see [Chart history](#-chart-history)).
- **Frontend:** plain HTML/CSS/JS with no build step.

## 🚀 Run locally (debug)

```bash
./start.sh                 # http://localhost:8000, auto-reload
PORT=9000 CACHE_TTL_SECONDS=900 ./start.sh
FX_SOURCE=frankfurter ./start.sh
```

`start.sh` creates `.venv`, installs `requirements-dev.txt`, and runs uvicorn with `--reload`.

Run the tests:

```bash
.venv/bin/python -m pytest -q   # backend
node --test tests/              # calculator (static/calc.js)
```

## 🐳 Docker

```bash
docker compose up -d --build
# or: FX_SOURCE=frankfurter CACHE_TTL_SECONDS=900 PORT=8080 docker compose up -d --build
```

The chart history is kept in a Docker **named volume** (`fx-data`, mounted at `/data`). It is managed by Docker, so you won't see a folder in the project, and it survives rebuilds and `docker compose down`. `docker compose down -v` deletes it, and the history is then fetched again from Yahoo on the next start.

## ⚙️ Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `FX_SOURCE` | `yahoo` | Preferred live-rate source: `yahoo`, `frankfurter`, or `open.er-api`. Remaining sources fill missing currencies. Restart the server after changing it. |
| `CACHE_TTL_SECONDS` | `300` | How long fetched rates stay valid (e.g. 300 = 5 min, 900 = 15 min). |
| `REFRESH_MARGIN_SECONDS` | 20% of TTL, max 60 | How many seconds before expiry the background task refetches. |
| `LOG_LEVEL` | `info` | Log verbosity. Each successful rate refresh logs the actual sources and currency counts; failures also log warnings. HTTP access logs are disabled. |
| `HISTORY_DB` | `data/history.db` (`/data/history.db` in Docker) | SQLite file holding the stored FX history used by the charts. Mount a volume on its directory. |
| `PORT` | `8000` | HTTP port. |
| `BASE_PATH` | *(empty)* | Optional sub-path such as `/fx`. Only needed if your proxy forwards `/fx/...` **without** stripping the prefix. The app keeps serving `/` either way. |

> ⚠️ Run a single uvicorn worker, so there is one shared cache and refresher.

## 📊 Chart history

`/api/history` is served from a local SQLite database, not fetched per request.

- **What is stored:** only the USD legs (45 currencies), at 5-minute, 30-minute and daily resolution. Any pair is computed as `usd_quote / usd_base`.
- **Refreshing:** a background task refreshes each resolution. Every refresh requests everything since the newest stored bar, so after downtime the next refresh backfills the outage (as far back as 4 days of 5-minute, 14 days of 30-minute and 370 days of daily data).
- **Quiet currencies:** some currencies (e.g. PHP, VND) have long stretches with no Yahoo quotes. For pairs between two non-USD currencies, a currency's last quote is reused for up to 12 hours (4 days on the daily chart), so the line stays continuous. Real market closures, such as weekends, still show as gaps.

## 🔌 API

- `GET /api/rates`: rates expressed as units per 1 USD, plus where each rate came from, `updated_at`, `expires_at` and `stale`.
- `GET /api/currencies`: the supported currencies and the default selection.
- `GET /api/history?base=USD&quote=JPY&range=1m`: chart points as `[unix_time, rate]` pairs. `range` is one of `1d`, `1w`, `1m`, `3m`, `1y`. It returns 400 for an unknown currency or range, and 503 when no history is available.
- `GET /healthz`: health check.

## 🌍 Hosting under a sub-path (e.g. `https://example.com/fx/`)

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

## 📱 PWA

Browsers only allow installing a PWA from `localhost` or over **HTTPS**. In production, put the app behind a TLS-terminating reverse proxy (Caddy, nginx, Traefik, …).

The server stamps `styles.css`, `calc.js`, `i18n.js` and `app.js` in `index.html` with a content-hash version (`?v=…`), so browsers load changed files automatically. Bump `VERSION` in `static/sw.js` only when you want installed clients to drop their old offline caches. To regenerate the icons, run `python scripts/generate_icons.py` (needs Pillow).

## ⚠️ Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Yahoo. The `yahoo` source, which is the default, and the history charts use unofficial Yahoo Finance endpoints that are meant for personal use. You are responsible for following [Yahoo's Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html). The rates and history are provided as-is, without any guarantee of accuracy, and are not financial advice.

For a public or commercial deployment, set `FX_SOURCE=frankfurter` to use a freely redistributable source, or use a provider whose licence allows redistribution. History charts always use Yahoo, whatever `FX_SOURCE` is set to.
