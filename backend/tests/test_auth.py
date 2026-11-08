from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from auth_helpers import PASSWORD, csrf, login, post, register
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import func, select, update

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.applications.models import JobApplication
from app.modules.auth import service
from app.modules.auth.models import AuthSession, EmailVerification
from app.modules.companion.models import AICompanion, ChatMessage, ChatSession
from app.modules.memory.models import Memory
from app.modules.users.models import User
from app.modules.wallet.models import Wallet, WalletTransaction


def test_register_normalizes_hashes_and_does_not_expose_verification_token(
    auth_client, auth_database
):
    response = register(auth_client, email="First@Example.COM")
    assert response.status_code == 202
    assert not {"token", "user_id", "password_hash"} & response.json().keys()
    engine, _ = auth_database
    with engine.connect() as db:
        row = db.execute(select(User.__table__)).mappings().one()
        verification = db.execute(select(EmailVerification.__table__)).mappings().one()
        assert row["email"] == "first@example.com"
        assert (
            row["display_name"] == "小未同学"
            and row["status"] == "active"
            and row["role"] == "user"
        )
        assert row["password_hash"].startswith("$argon2id$")
        assert service.PASSWORD_HASHER.verify(row["password_hash"], PASSWORD)
        assert verification["token_hash"] == service.digest(
            auth_client.app.state.mailer.messages[0].token
        )
        assert auth_client.app.state.mailer.messages[0].token not in response.text
    assert auth_client.get("/api/v1/auth/me").status_code == 401


def test_duplicate_email_is_generic_and_does_not_replace_password(auth_client, auth_database):
    first = register(auth_client)
    duplicate = register(auth_client, email="FIRST@example.com", password="Different-Strong!2026")
    assert first.status_code == duplicate.status_code == 202
    assert first.json() == duplicate.json()
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert db.scalar(select(func.count()).select_from(EmailVerification)) == 1
    assert len(auth_client.app.state.mailer.messages) == 1
    assert login(auth_client).status_code == 200


@pytest.mark.parametrize(
    "password", ["short", "alllowercasepassword", "password123!", "1234567890123"]
)
def test_weak_password_rejected_without_echo(auth_client, auth_database, password):
    response = register(auth_client, password=password)
    assert response.status_code == 422 and password not in response.text
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


def test_registration_cannot_set_privileged_fields(auth_client):
    response = post(
        auth_client,
        "register",
        {
            "email": "admin@example.com",
            "password": PASSWORD,
            "display_name": "x",
            "role": "admin",
            "status": "active",
        },
    )
    assert response.status_code == 422


def test_login_current_user_and_hashed_persistent_session(auth_client, auth_database):
    register(auth_client)
    response = login(auth_client)
    assert response.status_code == 200
    assert response.json()["display_name"] == "小未同学"
    assert not {"password_hash", "token_hash", "csrf_hash"} & response.json().keys()
    token = auth_client.cookies.get("weibiye_session")
    with auth_database[0].connect() as db:
        session = db.execute(select(AuthSession.__table__)).mappings().one()
        assert session["token_hash"] == service.digest(token) and session["token_hash"] != token
    assert auth_client.get("/api/v1/auth/me").json() == response.json()
    assert auth_client.get("/api/v1/users/me").json() == response.json()
    assert len(auth_client.get("/api/v1/auth/sessions").json()) == 1
    header = response.headers.get_list("set-cookie")
    assert len(header) == 2
    assert all(
        "HttpOnly" in value and "SameSite=lax" in value and "Path=/" in value for value in header
    )
    assert all("Domain=" not in value for value in header)


def test_unknown_email_and_wrong_password_have_identical_errors(auth_client):
    register(auth_client)
    wrong = login(auth_client, password="Incorrect-Safe!2026")
    unknown = login(auth_client, email="missing@example.com")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["error"] == unknown.json()["error"]
    assert not wrong.headers.get("set-cookie") and not unknown.headers.get("set-cookie")


@pytest.mark.parametrize(
    "path",
    [
        "/auth/me",
        "/auth/sessions",
        "/users/me",
        "/companion/sessions",
        "/companion/companions",
        "/applications",
        "/memory",
        "/wallet",
    ],
)
def test_anonymous_private_access_is_401(auth_client, path):
    assert auth_client.get("/api/v1" + path).status_code == 401


def test_logout_revokes_captured_cookie(auth_client, auth_database):
    register(auth_client)
    login(auth_client)
    saved = dict(auth_client.cookies)
    assert post(auth_client, "logout").status_code == 204
    assert not auth_client.cookies.get("weibiye_session")
    auth_client.cookies.update(saved)
    auth_client.app.state.auth_store.values.clear()
    assert auth_client.get("/api/v1/auth/me").status_code == 401
    with auth_database[0].connect() as db:
        assert db.scalar(select(AuthSession.revoked_at)) is not None


def test_server_side_expiry_and_disabled_account(auth_client, auth_database, monkeypatch):
    register(auth_client)
    response = login(auth_client)
    user_id = UUID(response.json()["id"])
    future = service.now() + timedelta(days=2)
    with monkeypatch.context() as patch:
        patch.setattr(service, "now", lambda: future)
        assert auth_client.get("/api/v1/auth/me").status_code == 401
    with auth_database[0].begin() as db:
        db.execute(update(User).where(User.id == user_id).values(status="disabled"))
    assert auth_client.get("/api/v1/auth/me").status_code == 401
    auth_client.cookies.clear()
    assert login(auth_client).status_code == 401


def test_csrf_origin_header_cookie_and_session_binding(auth_client):
    register(auth_client)
    login(auth_client)
    assert auth_client.post("/api/v1/auth/logout").status_code == 403
    token = csrf(auth_client)
    assert (
        auth_client.post(
            "/api/v1/auth/logout", headers={**token, "Origin": "https://testserver.evil"}
        ).status_code
        == 403
    )
    assert (
        auth_client.post(
            "/api/v1/auth/logout", headers={**token, "Sec-Fetch-Site": "cross-site"}
        ).status_code
        == 403
    )
    assert (
        auth_client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "x" * 43}).status_code
        == 403
    )
    assert auth_client.get("/api/v1/auth/me").status_code == 200
    anonymous = "a" * 43
    auth_client.cookies.set("weibiye_csrf", anonymous, domain="testserver.local", path="/")
    assert (
        auth_client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": anonymous}).status_code
        == 403
    )


def test_login_and_register_require_bootstrap_csrf_and_origin(auth_client):
    assert (
        auth_client.post(
            "/api/v1/auth/login", json={"email": "x@example.com", "password": PASSWORD}
        ).status_code
        == 403
    )
    headers = csrf(auth_client)
    auth_client.headers.pop("Origin")
    assert (
        auth_client.post(
            "/api/v1/auth/login",
            json={"email": "x@example.com", "password": PASSWORD},
            headers=headers,
        ).status_code
        == 403
    )


def test_login_and_registration_rate_limits(auth_client):
    auth_client.app.state.settings.login_account_limit = 2
    for _ in range(2):
        assert login(auth_client, email="unknown@example.com").status_code == 401
    assert login(auth_client, email="unknown@example.com").status_code == 429
    auth_client.app.state.settings.login_ip_limit = 1
    assert login(auth_client, email="another@example.com").status_code == 429
    auth_client.app.state.settings.register_ip_limit = 1
    assert register(auth_client).status_code == 202
    assert register(auth_client, email="second@example.com").status_code == 429


def test_session_rotation_revoke_and_logout_all(auth_client):
    register(auth_client)
    login(auth_client)
    old = dict(auth_client.cookies)
    login(auth_client)
    latest = dict(auth_client.cookies)
    assert old["weibiye_session"] != latest["weibiye_session"]
    auth_client.cookies.clear()
    auth_client.cookies.update(old)
    assert auth_client.get("/api/v1/auth/me").status_code == 401
    auth_client.cookies.clear()
    auth_client.cookies.update(latest)
    session_id = auth_client.get("/api/v1/auth/sessions").json()[0]["id"]
    assert (
        auth_client.delete(
            f"/api/v1/auth/sessions/{uuid4()}", headers=csrf(auth_client)
        ).status_code
        == 404
    )
    assert (
        auth_client.delete(
            f"/api/v1/auth/sessions/{session_id}", headers=csrf(auth_client)
        ).status_code
        == 204
    )
    assert auth_client.get("/api/v1/auth/me").status_code == 401
    login(auth_client)
    assert post(auth_client, "logout-all").status_code == 204
    assert auth_client.get("/api/v1/auth/me").status_code == 401


def test_email_verification_is_single_use_and_required_when_configured(auth_client):
    register(auth_client)
    auth_client.app.state.settings.require_verified_email = True
    assert login(auth_client).status_code == 401
    token = auth_client.app.state.mailer.messages[0].token
    assert post(auth_client, "verify-email", {"token": token}).status_code == 200
    assert post(auth_client, "verify-email", {"token": token}).status_code == 400
    response = login(auth_client)
    assert response.status_code == 200 and response.json()["email_verified"]


def test_session_survives_application_restart_without_cache_authority(auth_client, auth_database):
    register(auth_client)
    login(auth_client)
    with TestClient(
        create_app(auth_database[1]),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as restarted:
        restarted.cookies.update(dict(auth_client.cookies))
        assert restarted.get("/api/v1/auth/me").status_code == 200


def test_production_secure_cookie_and_https_policy(auth_database):
    _, base = auth_database
    with pytest.raises(ValidationError):
        Settings(environment="production", demo_enabled=False, rate_limit_backend="redis")
    settings = Settings(
        environment="production",
        database_url=base.database_url,
        redis_url=base.redis_url,
        cors_origins=["https://weibiye.test"],
        frontend_origin="https://weibiye.test",
        cookie_secure=True,
        require_verified_email=True,
        demo_enabled=False,
        rate_limit_backend="redis",
        auth_store_backend="redis",
    )
    # This isolated HTTPS transport exercises production cookie flags, substituting only Redis.
    from app.modules.auth.store import AuthStore

    with TestClient(
        create_app(settings),
        base_url="https://weibiye.test",
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "https://weibiye.test"},
    ) as client:
        client.app.state.auth_store = AuthStore()
        register(client)
        assert (
            post(
                client, "verify-email", {"token": client.app.state.mailer.messages[0].token}
            ).status_code
            == 200
        )
        response = login(client)
        assert response.status_code == 200
        assert all(
            "Secure" in value
            and "HttpOnly" in value
            and "SameSite=lax" in value
            and "__Host-weibiye_" in value
            for value in response.headers.get_list("set-cookie")
        )
        assert client.get("http://weibiye.test/api/v1/auth/csrf").status_code == 400


def test_private_resources_are_owner_filtered_even_for_admin(auth_client, auth_database):
    register(auth_client)
    first = login(auth_client).json()
    cookie_a = dict(auth_client.cookies)
    auth_client.cookies.clear()
    register(auth_client, email="second@example.com")
    second = login(auth_client, email="second@example.com").json()
    cookie_b = dict(auth_client.cookies)
    ids = {}
    with auth_database[0].begin() as db:
        for user in (first, second):
            uid = UUID(user["id"])
            companion, conversation, message, application, memory, wallet, transaction = [
                uuid4() for _ in range(7)
            ]
            db.execute(
                AICompanion.__table__.insert().values(
                    id=companion, owner_id=uid, name=user["email"], persona="private"
                )
            )
            db.execute(
                ChatSession.__table__.insert().values(
                    id=conversation, owner_id=uid, companion_id=companion, title="private"
                )
            )
            db.execute(
                ChatMessage.__table__.insert().values(
                    id=message,
                    owner_id=uid,
                    session_id=conversation,
                    sequence=0,
                    role="user",
                    content="private",
                    provider="mock",
                )
            )
            db.execute(
                JobApplication.__table__.insert().values(
                    id=application, owner_id=uid, company="private", position="private"
                )
            )
            db.execute(
                Memory.__table__.insert().values(
                    id=memory, owner_id=uid, content="private", consent_granted_at=datetime.now(UTC)
                )
            )
            db.execute(Wallet.__table__.insert().values(id=wallet, owner_id=uid))
            db.execute(
                WalletTransaction.__table__.insert().values(
                    id=transaction,
                    wallet_id=wallet,
                    kind="grant",
                    delta=1,
                    balance_after=1,
                    idempotency_key=str(transaction),
                    request_fingerprint="a" * 64,
                )
            )
            ids[user["id"]] = {
                "companion": companion,
                "conversation": conversation,
                "application": application,
                "memory": memory,
                "wallet": wallet,
            }
    # DB role must never grant cross-owner access to private resources.
    with auth_database[0].begin() as db:
        db.execute(update(User).where(User.id == UUID(first["id"])).values(role="admin"))
    auth_client.cookies.clear()
    auth_client.cookies.update(cookie_a)
    own, other = ids[first["id"]], ids[second["id"]]
    paths = {
        "companion": "/companion/companions",
        "conversation": "/companion/sessions",
        "application": "/applications",
        "memory": "/memory",
        "wallet": "/wallet",
    }
    for kind, path in paths.items():
        own_response = auth_client.get(f"/api/v1{path}/{own[kind]}")
        # A legacy memory timestamp is not an explicit P4 grant. The compatibility
        # route must fail closed even for its owner; P4 management is tested separately.
        assert own_response.status_code == (404 if kind == "memory" else 200)
        foreign = auth_client.get(f"/api/v1{path}/{other[kind]}")
        missing = auth_client.get(f"/api/v1{path}/{uuid4()}")
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json()["error"] == missing.json()["error"]
        if kind != "wallet":
            listing = auth_client.get(f"/api/v1{path}?user_id={second['id']}").json()
            if kind == "conversation":
                listing = listing["items"]
            assert [row["id"] for row in listing] == ([] if kind == "memory" else [str(own[kind])])
    for suffix in ("", "/messages"):
        assert (
            auth_client.get(
                f"/api/v1/companion/sessions/{other['conversation']}{suffix}"
            ).status_code
            == 404
        )
    assert auth_client.get(f"/api/v1/wallet/{other['wallet']}/transactions").status_code == 404
    foreign_session = auth_client.get("/api/v1/auth/sessions").json()[0]["id"]
    auth_client.cookies.clear()
    auth_client.cookies.update(cookie_b)
    assert (
        auth_client.delete(
            f"/api/v1/auth/sessions/{foreign_session}", headers=csrf(auth_client)
        ).status_code
        == 404
    )


def test_auth_store_failure_fails_closed_without_secret_disclosure(auth_client):
    from redis.exceptions import ConnectionError

    from app.modules.auth.store import AuthStore

    class Unavailable:
        async def eval(self, *args):
            raise ConnectionError("private-cache-password=should-not-leak")

    auth_client.app.state.auth_store = AuthStore(Unavailable())
    response = auth_client.get("/api/v1/auth/csrf")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AUTH_STORE_UNAVAILABLE"
    assert "should-not-leak" not in response.text


def test_auth_database_failure_has_safe_dependency_error(auth_client):
    from sqlalchemy.exc import OperationalError

    register(auth_client)
    login(auth_client)

    def unavailable():
        raise OperationalError("private-query", {}, Exception("private-password"))

    auth_client.app.state.session_factory = unavailable
    response = auth_client.get("/api/v1/auth/me")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DATABASE_UNAVAILABLE"
    assert "private" not in response.text


def test_expired_verification_token_cannot_verify_email(auth_client, monkeypatch):
    register(auth_client)
    token = auth_client.app.state.mailer.messages[0].token
    future = service.now() + timedelta(days=2)
    monkeypatch.setattr(service, "now", lambda: future)
    assert post(auth_client, "verify-email", {"token": token}).status_code == 400
