"""Credentialed cross-origin clients must see the server's retry deadline."""


def test_cors_exposes_retry_after_without_relaxing_origins(client, settings):
    allowed = settings.cors_origins[0]
    response = client.get("/health/live", headers={"Origin": allowed})
    assert response.headers["access-control-allow-origin"] == allowed
    assert response.headers["access-control-allow-credentials"] == "true"
    exposed = response.headers["access-control-expose-headers"].lower().split(", ")
    assert "retry-after" in exposed
    assert "x-request-id" in exposed
    denied = client.get("/health/live", headers={"Origin": "https://untrusted.invalid"})
    assert "access-control-allow-origin" not in denied.headers


def test_cors_allows_authenticated_sse_resume_preflight(client, settings):
    response = client.options(
        "/api/v1/companion/sessions/unused/generations/unused/events",
        headers={
            "Origin": settings.cors_origins[0],
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Last-Event-ID",
        },
    )
    assert response.status_code == 200
    assert "last-event-id" in response.headers["access-control-allow-headers"].lower()
