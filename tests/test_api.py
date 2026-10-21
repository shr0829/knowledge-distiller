import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from library_companion.api import create_app
from library_companion.integration import generate
from library_companion.mcp_server import create_mcp
from library_companion.store import Store


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "state")) as client:
        yield client


def authenticate(client):
    response = client.get("/api/session", headers={"X-Library-Reviewer": client.app.state.bootstrap_token})
    assert response.status_code == 200
    return {"X-Library-Token": response.json()["csrf_token"]}


def test_browser_security_boundary(client):
    assert client.post("/api/demo").status_code == 403
    assert client.get("/api/session").status_code == 403
    assert client.get("/api/state").status_code == 403
    assert client.get("/api/state", headers={"Host": "hostile.example"}).status_code == 403
    assert client.get("/api/session", headers={"Origin": "https://hostile.example"}).status_code == 403
    assert client.get("/api/state", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    headers = authenticate(client)
    assert client.post("/api/demo", headers=headers).status_code == 200


def test_review_write_and_undo_through_http(client):
    headers = authenticate(client)
    project = client.post("/api/demo", headers=headers).json()
    state = client.get("/api/state").json()
    assert len(state["proposals"]) == 3
    proposal = next(p for p in state["proposals"] if p["recommended_action"] == "save" and not p["uncertain"])
    request = {"revision": proposal["revision"], "action": "save"}
    assert client.post(f"/api/proposals/{proposal['id']}/review", headers=headers, json=request).status_code == 400
    preview = client.post(f"/api/proposals/{proposal['id']}/preview", headers=headers, json=request)
    assert preview.status_code == 200, preview.text
    request["preview_token"] = preview.json()["preview_token"]
    approved = client.post(f"/api/proposals/{proposal['id']}/review", headers=headers, json=request)
    assert approved.status_code == 200, approved.text
    target = Path(project["vault"]) / preview.json()["target"]
    assert target.exists()
    assert "合成示例" in target.read_text(encoding="utf-8")
    persisted = client.get("/api/state").json()
    assert proposal["content"] in persisted["writes"][0]["after"]
    assert persisted["feedback"][0]["decision"]["action"] == "save"
    write_id = approved.json()["write"]["id"]
    assert client.post(f"/api/writes/{write_id}/undo", headers=headers).status_code == 200
    assert not target.exists()
    assert client.get(f"/api/projects/{project['id']}/notes").status_code == 200


def test_stale_preview_is_rejected(client):
    headers = authenticate(client)
    project = client.post("/api/demo", headers=headers).json()
    proposal = next(p for p in client.get("/api/state").json()["proposals"] if p["recommended_action"] == "update")
    request = {"revision": 1, "action": "update"}
    preview = client.post(f"/api/proposals/{proposal['id']}/preview", headers=headers, json=request).json()
    target = Path(project["vault"]) / proposal["target"]
    original = target.read_text(encoding="utf-8") + "\n人工新增内容\n"
    target.write_text(original, encoding="utf-8")
    request["preview_token"] = preview["preview_token"]
    response = client.post(f"/api/proposals/{proposal['id']}/review", headers=headers, json=request)
    assert response.status_code == 409
    assert target.read_text(encoding="utf-8") == original
    refreshed = client.post(f"/api/proposals/{proposal['id']}/refresh", headers=headers, json={"revision": 1})
    assert refreshed.status_code == 200
    assert refreshed.json()["revision"] == 2


def test_defer_does_not_train_and_model_settings_require_explicit_enable(client):
    headers = authenticate(client)
    client.post("/api/demo", headers=headers)
    state = client.get("/api/state").json()
    assert state["settings"]["enabled"] is False
    proposal = state["proposals"][0]
    response = client.post(f"/api/proposals/{proposal['id']}/review", headers=headers,
                           json={"revision": 1, "action": "defer"})
    assert response.status_code == 200
    assert client.get("/api/state").json()["feedback"] == []
    bad = {**state["settings"], "enabled": True, "model": "test", "endpoint": "http://remote.example/v1"}
    assert client.put("/api/settings", headers=headers, json=bad).status_code == 400
    assert client.get("/api/settings").json()["enabled"] is False


def test_capture_can_be_revoked_and_session_can_refresh(client):
    headers = authenticate(client)
    project = client.post("/api/demo", headers=headers).json()
    assert client.get("/api/session").status_code == 200
    headers = authenticate(client)
    response = client.put(f"/api/projects/{project['id']}/capture", headers=headers, json={"enabled": True})
    assert response.status_code == 200
    assert response.json()["capture_enabled"] is True
    response = client.put(f"/api/projects/{project['id']}/capture", headers=headers, json={"enabled": False})
    assert response.status_code == 200
    assert response.json()["capture_enabled"] is False


@pytest.mark.asyncio
async def test_mcp_has_no_approval_or_undo_tools(tmp_path):
    server = create_mcp(Store(tmp_path))
    names = {tool.name for tool in await server.list_tools()}
    assert {"submit_proposals", "search_notes", "request_review", "list_pending_reviews"} <= names
    assert not names & {"review", "approve", "undo", "activate", "authorize", "write", "delete"}


def test_generated_integration_uses_exact_interpreter_and_home(tmp_path):
    store = Store(tmp_path / "with spaces 状态")
    result = generate(store, tmp_path / "integration")
    assert result["status"] == "generated_not_installed"
    config = json.loads((Path(result["plugin"]) / ".mcp.json").read_text(encoding="utf-8"))
    server = config["mcpServers"]["library-companion"]
    assert Path(server["command"]).exists()
    assert str(store.home) in server["args"]
    assert Path(result["mcp_config"]).is_file()


@pytest.mark.asyncio
async def test_failed_planning_does_not_block_following_captured_event(tmp_path):
    from library_companion.controller import Controller
    from library_companion.models import ProjectInput
    from library_companion.store import encode, now

    vault = tmp_path / "vault"
    vault.mkdir()
    store = Store(tmp_path / "state")
    controller = Controller(store)
    project = controller.service.create_project(ProjectInput(name="queue", root=str(vault), vault=str(vault)))
    store.set_meta("model_settings", {"enabled": True})
    for event_id, links in [("invalid", ["Library/Missing"]), ("valid", [])]:
        data = {"candidates": [{"title": event_id, "content": "Captured conclusion", "source": "Original evidence", "links": links}]}
        store.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?)", (
            event_id, project["id"], "session", event_id, "extracted", now(), encode(data)))
    results = await controller.process_queue()
    assert len(results) == 1
    statuses = {r["id"]: r["status"] for r in store.query("SELECT id,status FROM events")}
    assert statuses == {"invalid": "planning_error", "valid": "submitted"}
    assert len(store.proposal_list()) == 1
