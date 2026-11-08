from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def test_ci_configuration_and_scope():
    # BaseLoader preserves GitHub's YAML 1.2 'on' key as a string.
    workflow = yaml.load(
        (ROOT / ".github/workflows/weibiye-ci.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    assert workflow["permissions"] == {"contents": "read"}
    assert set(workflow["on"]) == {"push", "pull_request", "workflow_dispatch"}
    assert set(workflow["jobs"]) == {"frontend", "backend"}
    backend = workflow["jobs"]["backend"]
    assert set(backend["services"]) == {"postgres", "redis"}
    assert backend["env"]["WEIBIYE_REAL_LLM_ENABLED"] == "false"
    commands = [step["run"] for step in backend["steps"] if "run" in step]
    assert "uv run pytest -q" in commands and "uv run alembic check" in commands
    for name, job in workflow["jobs"].items():
        assert job["defaults"]["run"]["working-directory"] == name
        assert (ROOT / job["defaults"]["run"]["working-directory"]).is_dir()
        for step in job["steps"]:
            if "working-directory" in step:
                assert (ROOT / step["working-directory"]).resolve().is_relative_to(ROOT)
                assert (ROOT / step["working-directory"]).is_dir()
    frontend_steps = workflow["jobs"]["frontend"]["steps"]
    setup_node = next(
        step for step in frontend_steps if step.get("uses", "").startswith("actions/setup-node@")
    )
    assert setup_node["with"]["cache-dependency-path"] == "frontend/package-lock.json"


def test_compose_is_isolated_and_local_only():
    compose = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
    assert compose["name"] == "weibiye"
    assert set(compose["services"]) == {"postgres", "redis", "migrate", "backend", "frontend"}
    for service in compose["services"].values():
        for binding in service.get("ports", []):
            assert binding.startswith("127.0.0.1:")
    assert compose["services"]["backend"]["environment"]["WEIBIYE_REAL_LLM_ENABLED"] == "false"
