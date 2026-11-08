import json
from uuid import uuid4

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from app.core.security import Principal, Role, get_principal


def test_liveness_and_request_headers(client):
    response = client.get("/health/live", headers={"X-Request-ID": "untrusted-client-input"})
    assert response.status_code == 200
    assert response.json()["service"] == "weibiye"
    assert response.headers["x-request-id"] != "untrusted-client-input"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"


def test_readiness_fails_honestly_without_dependencies(client):
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DEPENDENCIES_UNAVAILABLE"
    assert "redis://" not in response.text


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/users/me",
        "/api/v1/companion/sessions",
        "/api/v1/applications",
        "/api/v1/memory",
        "/api/v1/wallet",
        "/api/v1/admin",
        "/api/v1/moderation/reports",
    ],
)
def test_private_endpoints_require_authentication(client, path):
    response = client.get(path)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"
    assert response.json()["request_id"] == response.headers["x-request-id"]


def test_bearer_is_never_a_fake_identity(client):
    response = client.get("/api/v1/users/me", headers={"Authorization": "Bearer demo"})
    assert response.status_code == 401


@pytest.mark.parametrize("path", ["/api/v1/auth/login", "/api/v1/auth/register"])
def test_auth_mutations_require_csrf_and_never_issue_bearer_tokens(client, path):
    response = client.post(
        path,
        json={
            "email": "demo@example.com",
            "password": "Fictional-Test-Only!123",
            **({"display_name": "测试"} if path.endswith("register") else {}),
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CSRF_REJECTED"
    assert "access_token" not in response.text


def test_public_posts_never_return_fake_success(client):
    assert client.get("/api/v1/community/posts").status_code == 501
    assert client.get(f"/api/v1/community/posts/{uuid4()}").status_code == 501
    assert client.get("/api/v1/community/posts?limit=101").status_code == 422


def test_rbac_denies_regular_user_and_admin_still_has_no_business(client):
    app = client.app
    app.dependency_overrides[get_principal] = lambda: Principal(uuid4(), Role.USER)
    assert client.get("/api/v1/admin").status_code == 403
    app.dependency_overrides[get_principal] = lambda: Principal(uuid4(), Role.ADMIN)
    assert client.get("/api/v1/admin").status_code == 501
    app.dependency_overrides.clear()


def test_validation_does_not_echo_sensitive_input(client):
    secret = "do-not-echo-this-fictional-password"
    response = client.post("/api/v1/auth/login", json={"email": "bad", "password": secret})
    assert response.status_code == 422
    assert secret not in response.text
    assert "input" not in response.text


def test_cors_allowlist(client):
    allowed = client.options(
        "/health/live",
        headers={
            "Origin": "http://127.0.0.1:35174",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:35174"
    denied = client.options(
        "/health/live",
        headers={
            "Origin": "https://untrusted.invalid",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


def parse_events(text):
    events = []
    for frame in text.strip().split("\n\n"):
        lines = frame.splitlines()
        events.append((lines[0].removeprefix("event: "), json.loads(lines[1][6:])))
    return events


def test_sse_uses_mock_without_database_or_paid_model(client, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Demo must never call a paid model or database")

    monkeypatch.setattr("app.agent.providers.AsyncOpenAI", forbidden)
    client.app.state.session_factory = forbidden
    response = client.post("/api/v1/companion/demo/stream", json={"message": "fictional-input-314"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_events(response.text)
    assert events[0][0] == "meta"
    assert events[-1] == ("done", {"mode": "mock", "persisted": False})
    assert sum(event == "delta" for event, _ in events) == 4
    assert "fictional-input-314" not in response.text
    assert "Mock 演示" in response.text


def test_demo_validation_and_disable(client):
    assert client.post("/api/v1/companion/demo/stream", json={"message": " "}).status_code == 422
    assert (
        client.post("/api/v1/companion/demo/stream", json={"message": "x" * 2001}).status_code
        == 422
    )
    client.app.state.settings.demo_enabled = False
    assert client.post("/api/v1/companion/demo/stream", json={"message": "demo"}).status_code == 404


def test_rate_limit(client):
    client.app.state.settings.demo_requests_per_minute = 2
    for _ in range(2):
        assert (
            client.post("/api/v1/companion/demo/stream", json={"message": "demo"}).status_code
            == 200
        )
    assert client.post("/api/v1/companion/demo/stream", json={"message": "demo"}).status_code == 429


def test_redis_rate_limit_fails_closed(client):
    class UnavailableRedis:
        async def eval(self, *args):
            raise RedisConnectionError("fictional-private-connection-detail")

    client.app.state.settings.rate_limit_backend = "redis"
    client.app.state.redis = UnavailableRedis()
    response = client.post("/api/v1/companion/demo/stream", json={"message": "demo"})
    assert response.status_code == 503
    assert "fictional-private" not in response.text


def test_unexpected_errors_have_safe_envelope_and_headers(client):
    @client.app.get("/_test_error")
    async def error():
        raise RuntimeError("fictional-sensitive-detail")

    response = client.get("/_test_error")
    assert response.status_code == 500
    assert "fictional-sensitive" not in response.text
    assert response.json()["request_id"] == response.headers["x-request-id"]


def test_openapi_routes_and_domain_tags(client):
    schema = client.get("/openapi.json").json()
    for path in ("/api/v1/auth/login", "/api/v1/companion/demo/stream", "/api/v1/admin"):
        assert path in schema["paths"]
    tags = {
        tag
        for item in schema["paths"].values()
        for operation in item.values()
        for tag in operation.get("tags", [])
    }
    assert {
        "auth",
        "users",
        "community",
        "companion",
        "memory",
        "wallet",
        "applications",
        "moderation",
        "admin",
    } <= tags
