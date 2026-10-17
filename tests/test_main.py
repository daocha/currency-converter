import hashlib
import re

from fastapi.testclient import TestClient

from app.main import STATIC_DIR, VERSIONED_ASSETS, app

client = TestClient(app)  # no `with`: skips the lifespan, so no network fetches


def test_index_assets_carry_content_hash_versions():
    resp = client.get("/")
    assert resp.status_code == 200
    for name in VERSIONED_ASSETS:
        expected = hashlib.sha256((STATIC_DIR / name).read_bytes()).hexdigest()[:10]
        assert f'"{name}?v={expected}"' in resp.text
    assert not re.search(r'"(styles\.css|calc\.js|i18n\.js|app\.js)"', resp.text)
    assert client.get("/index.html").text == resp.text


def test_index_revalidates_with_etag():
    first = client.get("/")
    second = client.get("/", headers={"If-None-Match": first.headers["etag"]})
    assert second.status_code == 304
    assert first.headers["cache-control"] == "no-cache"


def test_versioned_asset_urls_are_served():
    html = client.get("/").text
    for url in re.findall(r'(?:href|src)="((?:styles\.css|calc\.js|i18n\.js|app\.js)\?v=\w+)"', html):
        assert client.get("/" + url).status_code == 200


def test_history_rejects_bad_params():
    assert client.get("/api/history?base=USD&quote=XXX").status_code == 400
    assert client.get("/api/history?base=USD&quote=JPY&range=5y").status_code == 400


class FakeHistory:
    def __init__(self, result=None, error=None):
        self.result, self.error = result, error

    async def get(self, base, quote, rng):
        if self.error:
            raise self.error
        return self.result


def test_history_returns_points():
    app.state.history = FakeHistory([[1700000000, 150.5], [1700086400, 151.0]])
    data = client.get("/api/history?base=usd&quote=jpy&range=1w").json()
    assert data == {"base": "USD", "quote": "JPY", "range": "1w", "points": [[1700000000, 150.5], [1700086400, 151.0]]}


def test_history_unavailable_is_503():
    app.state.history = FakeHistory(error=RuntimeError("down"))
    assert client.get("/api/history?base=USD&quote=JPY").status_code == 503
    app.state.history = FakeHistory([])
    assert client.get("/api/history?base=USD&quote=JPY").status_code == 503
