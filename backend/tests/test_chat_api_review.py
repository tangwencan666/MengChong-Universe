"""Contract and query-count regressions from the P3 final review."""

from uuid import uuid4

from sqlalchemy import event
from test_chat import PREFIX, command, create_session, identity, send
from test_chat import chat_client as chat_client
from test_chat import chat_database as chat_database  # noqa: F401


def test_active_retry_rejects_new_key_but_replays_the_original_key(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    original = send(chat_client, session["id"])
    gen_path = f"/sessions/{session['id']}/generations/{original['generation']['id']}"
    assert command(chat_client, "POST", gen_path + "/cancel", {}).status_code == 200
    key, body = str(uuid4()), {"retry_of_generation_id": original["generation"]["id"]}
    path = f"/sessions/{session['id']}/generations"
    first = command(chat_client, "POST", path, body, key=key)
    replay = command(chat_client, "POST", path, body, key=key)
    assert first.status_code == replay.status_code == 202
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["generation"]["id"] == first.json()["generation"]["id"]
    blocked = command(chat_client, "POST", path, body, key=str(uuid4()))
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "RETRY_NOT_ALLOWED"


def test_session_page_fetches_active_generations_in_one_query(chat_client):
    identity(chat_client)
    sessions = [create_session(chat_client, title=f"会话 {i}") for i in range(8)]
    active = send(chat_client, sessions[2]["id"])
    statements = []

    def observed(connection, cursor, statement, parameters, context, executemany):
        if "FROM chat_generations" in statement:
            statements.append(statement)

    engine = chat_client.app.state.engine.sync_engine
    event.listen(engine, "before_cursor_execute", observed)
    try:
        response = chat_client.get(PREFIX + "/sessions?limit=100")
    finally:
        event.remove(engine, "before_cursor_execute", observed)
    assert response.status_code == 200
    rows = response.json()["items"]
    assert len(rows) == 8 and len(statements) == 1
    for row in rows:
        if row["id"] == sessions[2]["id"]:
            assert row["active_generation"]["id"] == active["generation"]["id"]
        else:
            assert row["active_generation"] is None


def test_openapi_documents_all_success_dtos_and_private_sse(chat_client):
    document = chat_client.app.openapi()
    paths = document["paths"]
    expected = [
        ("post", "/sessions", "201", "SessionCreated"),
        ("get", "/sessions", "200", "SessionPage"),
        ("get", "/sessions/{session_id}", "200", "SessionView"),
        ("patch", "/sessions/{session_id}", "200", "SessionView"),
        ("get", "/sessions/{session_id}/messages", "200", "MessagePage"),
        ("post", "/sessions/{session_id}/messages", "202", "GenerationAccepted"),
        ("post", "/sessions/{session_id}/generations", "202", "GenerationAccepted"),
        ("get", "/sessions/{session_id}/generations/{generation_id}", "200", "GenerationSnapshot"),
        (
            "post",
            "/sessions/{session_id}/generations/{generation_id}/cancel",
            "200",
            "GenerationResult",
        ),
        (
            "post",
            "/sessions/{session_id}/generations/{generation_id}/cancel",
            "202",
            "GenerationResult",
        ),
        ("get", "/preferences", "200", "PreferencesView"),
        ("patch", "/preferences", "200", "PreferencesView"),
        ("get", "/recent-topic", "200", "RecentTopicView"),
    ]
    for method, path, status, model in expected:
        schema = paths[PREFIX + path][method]["responses"][status]["content"]["application/json"][
            "schema"
        ]
        # Auth also has SessionView; FastAPI qualifies colliding component names.
        definition = document["components"]["schemas"][schema["$ref"].rsplit("/", 1)[1]]
        assert definition["title"] == model
        if model == "SessionView":
            assert {"companion_id", "version", "active_generation"} <= set(definition["properties"])
    for method, path in (
        ("delete", "/sessions/{session_id}"),
        ("post", "/sessions/{session_id}/topic-dismissals"),
    ):
        assert "content" not in paths[PREFIX + path][method]["responses"]["204"]
    for method, path in (
        ("get", "/sessions/{session_id}/generations/{generation_id}/events"),
        ("post", "/demo/stream"),
    ):
        content = paths[PREFIX + path][method]["responses"]["200"]["content"]
        assert set(content) == {"text/event-stream"}


def test_read_only_infrastructure_configuration_never_starts_generation_jobs():
    from tests.integration.test_local_infrastructure import settings_for

    settings = settings_for("sqlite+aiosqlite:///:memory:", "redis://127.0.0.1:1/0")
    assert settings.chat_runner_enabled is False
    assert settings.llm_provider == "mock" and settings.real_llm_enabled is False
