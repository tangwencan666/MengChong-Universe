import asyncio
import json
import os
import subprocess
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from auth_helpers import csrf, login, post, register
from pydantic import ValidationError
from sqlalchemy import select, update

from app.core.config import Settings
from app.modules.auth import service
from app.modules.auth.mail import MockMailSender
from app.modules.auth.mock_mailbox import read_mailbox
from app.modules.auth.models import PasswordReset
from app.modules.users.models import User

NEW_PASSWORD = "Recovered-Local-Safe!2026"
ROOT = Path(__file__).resolve().parents[2]


def latest(client, purpose):
    return next(
        message
        for message in reversed(client.app.state.mailer.messages)
        if message.purpose == purpose
    )


def request_reset(client, email="first@example.com"):
    return post(client, "forgot-password", {"email": email})


def reset(client, token, password=NEW_PASSWORD):
    return post(client, "reset-password", {"token": token, "password": password})


def test_resend_generic_response_and_superseded_links(auth_client):
    register(auth_client)
    original = latest(auth_client, "verification").token
    response = post(auth_client, "resend-verification", {"email": "FIRST@example.com"})
    replacement = latest(auth_client, "verification").token
    unknown = post(auth_client, "resend-verification", {"email": "missing@example.com"})
    assert response.status_code == unknown.status_code == 202
    assert response.json() == unknown.json()
    assert original != replacement
    assert post(auth_client, "verify-email", {"token": original}).status_code == 400
    assert post(auth_client, "verify-email", {"token": replacement}).status_code == 200
    count = len(auth_client.app.state.mailer.messages)
    verified = post(auth_client, "resend-verification", {"email": "first@example.com"})
    assert verified.json() == unknown.json() and len(auth_client.app.state.mailer.messages) == count


def test_forgot_response_does_not_enumerate_unknown_or_disabled_accounts(
    auth_client, auth_database
):
    register(auth_client)
    known = request_reset(auth_client)
    assert latest(auth_client, "password_reset").token not in known.text
    count = len(auth_client.app.state.mailer.messages)
    unknown = request_reset(auth_client, "missing@example.com")
    with auth_database[0].begin() as db:
        db.execute(update(User).values(status="disabled"))
    disabled = request_reset(auth_client)
    assert known.status_code == unknown.status_code == disabled.status_code == 202
    assert known.json() == unknown.json() == disabled.json()
    assert len(auth_client.app.state.mailer.messages) == count


def test_reset_changes_password_hashes_token_and_never_logs_in(auth_client, auth_database):
    register(auth_client)
    assert login(auth_client).status_code == 200
    assert request_reset(auth_client).status_code == 202
    token = latest(auth_client, "password_reset").token
    with auth_database[0].connect() as db:
        row = db.execute(select(PasswordReset.__table__)).mappings().one()
        assert row["token_hash"] == service.digest(token) and row["token_hash"] != token
    response = reset(auth_client, token)
    assert response.status_code == 200 and not auth_client.cookies.get("weibiye_session")
    assert auth_client.get("/api/v1/auth/me").status_code == 401
    assert login(auth_client).status_code == 401
    assert login(auth_client, password=NEW_PASSWORD).status_code == 200
    assert reset(auth_client, token).status_code == 400
    assert latest(auth_client, "password_changed").token == ""
    with auth_database[0].connect() as db:
        hashed = db.scalar(select(User.password_hash))
        assert hashed.startswith("$argon2id$") and service.PASSWORD_HASHER.verify(
            hashed, NEW_PASSWORD
        )
        assert db.scalar(select(PasswordReset.consumed_at)) is not None


def test_reset_revokes_all_old_sessions_even_if_cache_hints_are_lost(auth_client):
    register(auth_client)
    login(auth_client)
    first = dict(auth_client.cookies)
    auth_client.cookies.clear()
    login(auth_client)
    second = dict(auth_client.cookies)
    assert len(auth_client.get("/api/v1/auth/sessions").json()) == 2
    request_reset(auth_client)
    assert reset(auth_client, latest(auth_client, "password_reset").token).status_code == 200
    auth_client.app.state.auth_store.values.clear()
    for saved in (first, second):
        auth_client.cookies.clear()
        auth_client.cookies.update(saved)
        assert auth_client.get("/api/v1/auth/me").status_code == 401


def test_reset_token_authority_is_bound_to_its_user_not_the_callers_cookie(auth_client):
    register(auth_client)
    login(auth_client)
    first = dict(auth_client.cookies)
    auth_client.cookies.clear()
    register(auth_client, email="second@example.com")
    second = login(auth_client, email="second@example.com").json()
    second_cookies = dict(auth_client.cookies)
    request_reset(auth_client)
    assert reset(auth_client, latest(auth_client, "password_reset").token).status_code == 200
    auth_client.cookies.update(second_cookies)
    assert auth_client.get("/api/v1/auth/me").json()["id"] == second["id"]
    auth_client.cookies.clear()
    auth_client.cookies.update(first)
    assert auth_client.get("/api/v1/auth/me").status_code == 401
    auth_client.cookies.clear()
    assert login(auth_client, email="second@example.com").status_code == 200
    auth_client.cookies.clear()
    assert login(auth_client, password=NEW_PASSWORD).status_code == 200


def test_repeated_request_supersedes_reset_and_password_reset_invalidates_verification(auth_client):
    register(auth_client)
    verification = latest(auth_client, "verification").token
    request_reset(auth_client)
    first = latest(auth_client, "password_reset").token
    request_reset(auth_client)
    second = latest(auth_client, "password_reset").token
    assert reset(auth_client, first).status_code == 400
    assert reset(auth_client, second).status_code == 200
    assert post(auth_client, "verify-email", {"token": verification}).status_code == 400


def test_recovery_purposes_cannot_be_swapped(auth_client):
    register(auth_client)
    verification = latest(auth_client, "verification").token
    request_reset(auth_client)
    recovery = latest(auth_client, "password_reset").token
    assert reset(auth_client, verification).status_code == 400
    assert post(auth_client, "verify-email", {"token": recovery}).status_code == 400


@pytest.mark.parametrize("kind", ["expired", "unknown", "disabled"])
def test_invalid_reset_does_not_change_password(auth_client, auth_database, monkeypatch, kind):
    register(auth_client)
    request_reset(auth_client)
    token = latest(auth_client, "password_reset").token
    with auth_database[0].connect() as db:
        original = db.scalar(select(User.password_hash))
    if kind == "unknown":
        token = "z" * 43
    if kind == "expired":
        future = service.now() + timedelta(hours=2)
        monkeypatch.setattr(service, "now", lambda: future)
    if kind == "disabled":
        with auth_database[0].begin() as db:
            db.execute(update(User).values(status="disabled"))
    response = reset(auth_client, token)
    assert response.status_code == 400 and token not in response.text
    with auth_database[0].connect() as db:
        assert db.scalar(select(User.password_hash)) == original


@pytest.mark.parametrize("password", ["weak", "alllowercasepassword", "password123!"])
def test_reset_enforces_the_registration_password_policy(auth_client, password):
    register(auth_client)
    request_reset(auth_client)
    token = latest(auth_client, "password_reset").token
    response = reset(auth_client, token, password)
    assert response.status_code == 422 and password not in response.text
    assert reset(auth_client, token).status_code == 200


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("forgot-password", {"email": "first@example.com"}),
        ("resend-verification", {"email": "first@example.com"}),
        ("reset-password", {"token": "x" * 43, "password": NEW_PASSWORD}),
    ],
)
def test_all_recovery_mutations_require_csrf_and_trusted_origin(auth_client, endpoint, payload):
    assert auth_client.post(f"/api/v1/auth/{endpoint}", json=payload).status_code == 403
    headers = {**csrf(auth_client), "Origin": "https://untrusted.invalid"}
    assert (
        auth_client.post(f"/api/v1/auth/{endpoint}", json=payload, headers=headers).status_code
        == 403
    )


def test_recovery_rate_limits_known_and_unknown_accounts_and_rejects_extra_fields(auth_client):
    auth_client.app.state.settings.recovery_account_limit = 1
    assert request_reset(auth_client, "unknown@example.com").status_code == 202
    assert request_reset(auth_client, "unknown@example.com").status_code == 429
    auth_client.app.state.settings.recovery_ip_limit = 2
    assert request_reset(auth_client, "other@example.com").status_code == 429
    assert (
        post(
            auth_client, "forgot-password", {"email": "x@example.com", "user_id": str(uuid4())}
        ).status_code
        == 422
    )


def test_verified_email_policy_applies_to_recovery(auth_client):
    register(auth_client)
    auth_client.app.state.settings.require_verified_email = True
    before = len(auth_client.app.state.mailer.messages)
    assert request_reset(auth_client).status_code == 202
    assert len(auth_client.app.state.mailer.messages) == before
    token = latest(auth_client, "verification").token
    assert post(auth_client, "verify-email", {"token": token}).status_code == 200
    assert request_reset(auth_client).status_code == 202
    assert latest(auth_client, "password_reset").token


def test_delivery_failure_has_a_generic_response_and_does_not_undo_a_reset(
    auth_client, monkeypatch
):
    register(auth_client)

    async def fail(**values):
        raise RuntimeError("private-provider-credential")

    original = auth_client.app.state.mailer.send_password_reset
    monkeypatch.setattr(auth_client.app.state.mailer, "send_password_reset", fail)
    known = request_reset(auth_client)
    unknown = request_reset(auth_client, "missing@example.com")
    assert known.json() == unknown.json() and known.status_code == unknown.status_code == 202
    assert "private-provider" not in known.text
    monkeypatch.setattr(auth_client.app.state.mailer, "send_password_reset", original)
    request_reset(auth_client)
    token = latest(auth_client, "password_reset").token
    monkeypatch.setattr(auth_client.app.state.mailer, "send_password_changed", fail)
    assert reset(auth_client, token).status_code == 200
    assert login(auth_client, password=NEW_PASSWORD).status_code == 200


def test_private_file_mock_mail_and_cli_do_not_expose_tokens_by_default():
    directory = ROOT / ".verification/p25/mailbox-unit" / uuid4().hex
    mailer = MockMailSender(origin="http://127.0.0.1:35174", outbox_dir=directory)
    token = "a" * 43
    asyncio.run(mailer.send_password_reset(recipient="mock@example.com", token=token))
    messages = read_mailbox(directory)
    assert len(messages) == 1 and messages[0]["link"].endswith("#token=" + token)
    file = next(directory.rglob("*.json"))
    if os.name != "nt":
        assert file.stat().st_mode & 0o077 == 0
        assert file.parent.stat().st_mode & 0o077 == 0
    ignored = subprocess.run(["git", "check-ignore", str(file)], cwd=ROOT, capture_output=True)
    assert ignored.returncode == 0
    listing = subprocess.run(
        [
            str(ROOT / "backend/.venv/Scripts/python.exe")
            if os.name == "nt"
            else str(ROOT / "backend/.venv/bin/python"),
            "-B",
            str(ROOT / "backend/scripts/mock_mailbox.py"),
            "list",
            "--directory",
            str(directory),
        ],
        cwd=ROOT / "backend",
        capture_output=True,
        check=True,
    )
    assert token.encode() not in listing.stdout and b'"link"' not in listing.stdout
    assert json.loads(listing.stdout)[0]["purpose"] == "password_reset"


def test_mock_mail_is_confined_to_project_and_not_available_in_production():
    forbidden = ROOT / "docs/forbidden-mailbox"
    with pytest.raises(ValueError):
        MockMailSender(outbox_dir=forbidden)
    with pytest.raises(ValueError):
        read_mailbox(forbidden)
    with pytest.raises(ValidationError):
        Settings(mock_mail_dir=forbidden)
    with pytest.raises(ValidationError):
        Settings(environment="production", mock_mail_dir=ROOT / ".verification/mock-mail")
    with pytest.raises(ValidationError):
        Settings(frontend_origin="https://safe.invalid/path?token=bad")


def test_email_link_origin_is_fixed_and_not_taken_from_the_request_host(auth_client):
    register(auth_client)
    auth_client.headers["Host"] = "attacker.invalid"
    assert request_reset(auth_client).status_code == 202
    link = latest(auth_client, "password_reset").link
    assert link.startswith(
        auth_client.app.state.settings.frontend_origin + "/reset-password#token="
    )
    assert "attacker.invalid" not in link
