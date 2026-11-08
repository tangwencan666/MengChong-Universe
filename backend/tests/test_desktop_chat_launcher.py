"""Read-only launcher policy and identity binding; no network or real credentials."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr

from app.core.config import Settings
from scripts import desktop_chat as launcher


def settings(**changes):
    return Settings(
        **(
            {
                "database_url": SecretStr(
                    "postgresql+psycopg://test:fixture@127.0.0.1:25433/"
                    "weibiye_desktop_local_" + "a" * 32
                ),
                "redis_url": SecretStr("redis://127.0.0.1:26380/0"),
            }
            | changes
        )
    )


def identity():
    return {
        "database": "weibiye_desktop_local_" + "a" * 32,
        "database_port": 25433,
        "cluster": "synthetic-cluster-only",
        "redis_port": 26380,
        "redis_db": 0,
        "redis_run_id": "b" * 40,
    }


def test_default_shared_database_or_implicit_selection_is_rejected_before_connecting():
    for options, environ in [
        (settings(), {}),
        (
            settings(database_url="postgresql+psycopg://x:y@127.0.0.1:25433/weibiye"),
            {"WEIBIYE_DATABASE_URL": "present"},
        ),
        (
            settings(database_url="sqlite+aiosqlite:///:memory:"),
            {"WEIBIYE_DATABASE_URL": "present"},
        ),
        (settings(redis_url="redis://remote.invalid:6379/0"), {"WEIBIYE_DATABASE_URL": "present"}),
    ]:
        with pytest.raises(launcher.StartupBlocked):
            launcher.endpoints(options, environ)
    database, cache = launcher.endpoints(settings(), {"WEIBIYE_DATABASE_URL": "present"})
    assert database.host == cache.hostname == "127.0.0.1"


def test_preparation_never_overwrites_a_target_and_credentials_are_not_saved(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "OUT", tmp_path)
    first = launcher.prepare_target(identity(), 38336, 35336)
    original = first.read_bytes()
    second = launcher.prepare_target(identity(), 38336, 35336)
    assert first != second and first.read_bytes() == original
    assert launcher.load_target(first)["schema"] == launcher.SCHEMA
    assert all(word not in original.decode() for word in ["password", "api_key", "fixture@"])


@pytest.mark.parametrize("key", launcher.IDENTITY_FIELDS)
def test_every_database_and_redis_identity_field_is_bound(key):
    target = identity()
    changed = dict(target) | {key: "changed"}
    with pytest.raises(launcher.StartupBlocked):
        launcher.verify_target(target, changed)


def test_expired_target_or_shared_service_port_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "OUT", tmp_path)
    with pytest.raises(launcher.StartupBlocked):
        launcher.prepare_target(identity(), 25433, 35336)
    target = launcher.prepare_target(identity(), 38336, 35336)
    with pytest.raises(launcher.StartupBlocked):
        launcher.load_target(target, now=datetime.now(UTC) + timedelta(days=2))


@pytest.mark.asyncio
async def test_scoped_cache_rewrites_only_keys_and_requires_expiring_writes():
    cache = SimpleNamespace(
        get=AsyncMock(), set=AsyncMock(), eval=AsyncMock(), zrem=AsyncMock(), ping=AsyncMock()
    )
    scoped = launcher.ScopedRedis(cache, "owned:")
    await scoped.get("auth")
    cache.get.assert_awaited_once_with("owned:auth")
    await scoped.eval("script", 2, "first", "second", "arg")
    cache.eval.assert_awaited_once_with("script", 2, "owned:first", "owned:second", "arg")
    await scoped.set("auth", "value", ex=30)
    cache.set.assert_awaited_once_with("owned:auth", "value", ex=30)
    with pytest.raises(launcher.StartupBlocked):
        await scoped.set("auth", "value")
    await scoped.zrem("stream", "member")
    cache.zrem.assert_awaited_once_with("owned:stream", "member")


def test_launch_preflight_sanitizes_failures_without_model_or_database_activity(
    monkeypatch, capsys
):
    monkeypatch.setattr(launcher, "Settings", lambda: settings())
    assert launcher.main([]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "DESKTOP_CHAT_STARTUP_BLOCKED"
    assert result["model_requests"] == 0
    assert "fixture" not in json.dumps(result)


def test_config_only_check_does_not_probe_or_expose_credentials(monkeypatch, capsys):
    monkeypatch.setattr(
        launcher, "Settings", lambda: settings(deepseek_api_key=SecretStr("synthetic-key"))
    )
    monkeypatch.setattr(
        launcher, "probe", lambda *args: pytest.fail("Config-only must not connect")
    )
    assert launcher.main(["--check-config"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["key_visible"] and not result["dependencies_checked"]
    assert result["model_requests_made_by_check"] == 0
    assert "synthetic-key" not in json.dumps(result)
