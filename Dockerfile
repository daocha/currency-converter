FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY static ./static

RUN useradd --create-home --uid 10001 appuser \
    && mkdir /data && chown appuser /data
USER appuser

ENV HOST=0.0.0.0 \
    PORT=8000 \
    CACHE_TTL_SECONDS=300 \
    HISTORY_DB=/data/history.db \
    LOG_LEVEL=warning

# Stored FX history (chart data). Mount a volume here so it survives container rebuilds.
VOLUME /data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/healthz', timeout=4)" || exit 1

# A single worker keeps a single shared rate cache / refresher.
CMD ["sh", "-c", "exec uvicorn app.main:app --host \"$HOST\" --port \"$PORT\" --proxy-headers --forwarded-allow-ips='*' --log-level \"$(echo $LOG_LEVEL | tr A-Z a-z)\" --no-access-log"]
