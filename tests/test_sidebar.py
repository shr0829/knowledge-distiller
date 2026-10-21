import json
from pathlib import Path

import pytest

from library_companion.mcp_server import create_mcp
from library_companion.setup_vault import create_vault
from library_companion.sidebar import UI_URI, SidebarBridge
from library_companion.store import Store


def test_real_vault_is_independent_and_idempotent(tmp_path):
    store = Store(tmp_path / "state")
    vault = tmp_path / "正式库"
    project = create_vault(store, vault, tmp_path)
    assert not project["synthetic"]
    assert project["capture_enabled"]
    assert (vault / ".obsidian" / "app.json").is_file()
    assert (vault / "Library" / "欢迎使用知序.md").is_file()
    assert store.meta("preferred_project_id") == project["id"]
    assert not store.proposal_list()
    assert not store.query("SELECT * FROM feedback")
    assert create_vault(store, vault, tmp_path)["id"] == project["id"]


def test_creation_never_overwrites_existing_folder(tmp_path):
    vault = tmp_path / "existing"
    vault.mkdir()
    note = vault / "mine.md"
    note.write_text("my note", encoding="utf-8")
    with pytest.raises(ValueError, match="already exists"):
        create_vault(Store(tmp_path / "state"), vault, tmp_path)
    assert note.read_text() == "my note"
    assert not (vault / ".obsidian").exists()


async def test_sidebar_declaration_and_model_boundary(tmp_path):
    server = create_mcp(Store(tmp_path))
    tools = {tool.name: tool for tool in await server.list_tools()}
    assert tools["open_library"].meta["openai/ui"]["entrypoints"] == [{"type": "global"}]
    assert tools["open_library"].meta["ui"]["resourceUri"] == UI_URI
    for name in ("open_library", "library_ui_read", "library_ui_request"):
        assert tools[name].meta["ui"]["visibility"] == ["app"]
    assert tools["library_ui_read"].annotations.readOnlyHint
    assert "ui" not in (tools["submit_proposals"].meta or {})
    resources = await server.list_resources()
    resource = next(r for r in resources if str(r.uri) == UI_URI)
    assert resource.mimeType == "text/html;profile=mcp-app"


async def test_sidebar_runtime_and_build_identity(tmp_path):
    from library_companion.runtime import build_id
    bridge = SidebarBridge(tmp_path / "state")
    result = await bridge.request("/runtime")
    assert result["status"] == 200
    assert result["body"]["build_id"] == build_id()
    assert len(result["body"]["backend_revision"]) == 12
    assert build_id() in UI_URI


async def test_sidebar_roundtrip_preserves_preview_and_undo(tmp_path):
    bridge = SidebarBridge(tmp_path / "state")
    demo = await bridge.request("/demo", "POST")
    state = (await bridge.request("/state"))["body"]
    proposal = next(p for p in state["proposals"] if p["recommended_action"] == "save" and not p["uncertain"])
    path = f"/proposals/{proposal['id']}"
    review = {"revision": proposal["revision"], "action": "save"}
    assert (await bridge.request(path + "/review", "POST", review))["status"] == 400
    preview = (await bridge.request(path + "/preview", "POST", review))["body"]
    result = await bridge.request(path + "/review", "POST", {**review, "preview_token": preview["preview_token"]})
    assert result["status"] == 200
    target = Path(demo["body"]["vault"]) / preview["target"]
    assert target.is_file()
    write_id = result["body"]["write"]["id"]
    assert (await bridge.request(f"/writes/{write_id}/undo", "POST"))["status"] == 200
    assert not target.exists()
    # The bridge cannot access arbitrary URLs, files, bootstrap/session or methods.
    for path, method in [("http://evil.example", "GET"), ("/session", "GET"),
                         ("/../secret", "GET"), ("/state?url=http://evil.example", "GET"),
                         ("/settings", "DELETE")]:
        with pytest.raises(ValueError, match="Unsupported"):
            await bridge.request(path, method)
    assert "csrf_token" not in json.dumps(state)
