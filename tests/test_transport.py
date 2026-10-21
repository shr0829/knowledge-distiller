import json
import os
import sys

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@pytest.mark.asyncio
async def test_real_stdio_handshake_and_readonly_boundary(tmp_path):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "library_companion", "--home", str(tmp_path / "mcp state"), "mcp"],
        env=env,
    )
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            assert initialized.serverInfo.name == "Library Companion"
            tools = await session.list_tools()
            assert "submit_proposals" in {t.name for t in tools.tools}
            assert "review" not in {t.name for t in tools.tools}
            sidebar = next(t for t in tools.tools if t.name == "open_library")
            assert sidebar.meta["openai/ui"]["entrypoints"][0]["type"] == "global"
            assert next(t for t in tools.tools if t.name == "library_ui_request").meta["ui"]["visibility"] == ["app"]
            result = await session.call_tool("get_project_context", {})
            assert not result.isError
            assert json.loads(result.content[0].text) == {"projects": []}


@pytest.mark.asyncio
async def test_claudian_agent_only_stdio(tmp_path):
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "library_companion", "--home", str(tmp_path / "agent-state"), "mcp", "--agent-only"],
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
            names = {t.name for t in listed.tools}
            assert {"search_knowledge", "prepare_knowledge_build", "submit_knowledge_build"} <= names
            assert "library_ui_request" not in names
            response = await session.call_tool("search_knowledge", {"query": "test", "engine": "local"})
            assert not response.isError
            assert json.loads(response.content[0].text)["hits"] == []
