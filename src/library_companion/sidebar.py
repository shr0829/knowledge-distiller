"""Codex sidebar MCP App; UI-only tools reuse the HTTP review validation boundary.

The host must enforce MCP Apps visibility=app. This is a trusted local adapter,
not a privilege boundary against another process running as the same OS user.
"""

import base64
import re
from pathlib import Path

import httpx
from mcp.types import Icon, ToolAnnotations

from .api import create_app
from .runtime import build_id

UI_URI = "ui://library-companion/workbench-" + build_id() + ".html"
UI_META = {"ui": {"resourceUri": UI_URI, "visibility": ["app"]}}
ROOT = Path(__file__).resolve().parents[2]
ROUTES = {
    "GET": r"/(state|runtime|settings|projects/[a-f0-9]+/(notes|learning|knowledge|memory|pipeline)|sources/[a-f0-9]+|builds/[a-f0-9]+|proposals/[a-f0-9]+/evidence|knowledge/graph|retrieval/status)",
    "POST": r"/(projects|demo|proposals|proposals/[a-f0-9]+/(preview|review|refresh)|writes/[a-f0-9]+/undo|projects/[a-f0-9]+/(learn|optimize|authorization|sources/scan|builds|retrieval/(index|chunks)|integration|pipeline/run)|builds/[a-f0-9]+/(submit|compile)|knowledge/(search|sources|evidence)|policies/[a-f0-9]+/(activate|rollback)|events/[a-f0-9]+/extract)",
    "PUT": r"/(settings|projects/[a-f0-9]+/(capture|pipeline))",
}


class SidebarBridge:
    def __init__(self, home):
        self.app = create_app(home)

    async def request(self, path: str, method: str = "GET", body: dict | None = None) -> dict:
        if method not in ROUTES or not re.fullmatch(ROUTES[method], path):
            raise ValueError("Unsupported sidebar operation")
        # In-process only: no listener, no URL supplied by the client, no tokens
        # exposed to the UI or agent. All existing request/preview checks apply.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                     base_url="http://localhost") as client:
            session = await client.get("/api/session", headers={
                "X-Library-Reviewer": self.app.state.bootstrap_token,
            })
            csrf = session.json()["csrf_token"]
            response = await client.request(method, "/api" + path, json=body,
                                            headers={"X-Library-Token": csrf})
            return {"status": response.status_code, "body": response.json()}


def register_sidebar(server, store):
    bridge = SidebarBridge(store.home)
    icon_path = ROOT / "plugin" / "assets" / "icon.svg"
    icons = []
    if icon_path.exists():
        src = "data:image/svg+xml;base64," + base64.b64encode(icon_path.read_bytes()).decode("ascii")
        icons = [Icon(src=src, mimeType="image/svg+xml")]

    @server.tool(name="open_library", title="知序", icons=icons,
                 annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False),
                 meta={**UI_META, "openai/ui": {"entrypoints": [{"type": "global"}]}})
    def open_library() -> dict:
        """Open the local knowledge review workbench from the Codex sidebar."""
        return {"ready": True, "project_count": len(store.projects())}

    @server.resource(UI_URI, name="知序工作台", mime_type="text/html;profile=mcp-app",
                     meta={"ui": {"prefersBorder": False, "csp": {
                         "connectDomains": [], "resourceDomains": [],
                     }}})
    def workbench() -> str:
        path = ROOT / "frontend" / "dist-mcp" / "index.html"
        if not path.is_file():
            raise ValueError("Sidebar UI is not built. Run npm run build in frontend.")
        return path.read_text(encoding="utf-8")

    @server.tool(name="library_ui_read", title="读取知序面板", meta=UI_META,
                 annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    async def library_ui_read(path: str) -> dict:
        """UI-only read of workbench state. No write operations accepted."""
        return await bridge.request(path)

    @server.tool(name="library_ui_request", title="知序界面操作", meta=UI_META,
                 annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
    async def library_ui_request(path: str, method: str = "GET", body: dict | None = None) -> dict:
        """UI-only operations. The MCP host must not expose this tool to the model."""
        if method == "GET":
            raise ValueError("Use library_ui_read for reads")
        return await bridge.request(path, method, body)
