from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from library_companion.capture import (
    BudgetExceeded,
    ConfiguredModel,
    capture_event,
    extract_event,
    mark_submitted,
    parse_transcript,
    redact,
)
from library_companion.models import ProjectInput, Submission
from library_companion.service import Service
from library_companion.store import Store, encode


@pytest.fixture
def capture(tmp_path):
    root, vault = tmp_path / "project", tmp_path / "vault"
    root.mkdir()
    vault.mkdir()
    store = Store(tmp_path / "state")
    project = Service(store).create_project(ProjectInput(name="Capture", root=str(root), vault=str(vault)))
    return store, project, root


def record(role, text, **fields):
    return encode({"type": "response_item", "payload": {"type": "message", "role": role,
        "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}], **fields}})


def payload(root, transcript, **fields):
    return {"cwd": str(root), "session_id": "capture-session", "hook_event_name": "Stop",
            "transcript": transcript, **fields}


def test_parser_only_captures_visible_messages_and_redacts():
    raw = "\n".join([
        record("system", "SYSTEM SECRET"), record("developer", "DEVELOPER SECRET"),
        record("assistant", "HIDDEN REASONING", channel="analysis"),
        encode({"type": "response_item", "payload": {"type": "function_call_output", "output": "TOOL SECRET"}}),
        record("user", "api_key=very-secret contact test@example.com"),
        record("assistant", "The durable conclusion.", channel="final"),
    ])
    parsed = parse_transcript(raw)
    assert parsed["status"] == "queued"
    assert len(parsed["messages"]) == 2
    text = encode(parsed)
    assert "SECRET" not in text and "HIDDEN REASONING" not in text and "very-secret" not in text
    assert "test@example.com" not in text and "REDACTED" in text


def test_malformed_unknown_and_oversized_are_visible():
    assert parse_transcript("not json")["status"] == "malformed"
    assert parse_transcript(encode({"new_unrecognized_format": True}))["status"] == "unknown_format"
    assert parse_transcript(record("assistant", "x" * 100001))["status"] == "oversized"
    assert parse_transcript(record("developer", "ignored"))["status"] == "empty"


def test_capture_incremental_idempotency_and_stop_loop(capture):
    store, project, root = capture
    first = record("user", "question") + "\n" + record("assistant", "Durable conclusion. " * 12)
    event = capture_event(store, payload(root, first))
    assert event["request_continuation"] is True
    duplicate = capture_event(store, payload(root, first, hook_event_name="PreCompact"))
    assert duplicate["event_id"] == event["event_id"] and not duplicate["request_continuation"]
    second = first + "\n" + record("assistant", "Another durable conclusion. " * 12)
    next_event = capture_event(store, payload(root, second, stop_hook_active=True))
    assert next_event["messages"] == 1 and not next_event["request_continuation"]
    assert len(store.query("SELECT * FROM events")) == 2


def test_capture_parallel_same_source_single_event(capture):
    store, _, root = capture
    data = payload(root, record("assistant", "Durable concurrent source. " * 6))
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: capture_event(Store(store.home), data), range(4)))
    assert len({r["event_id"] for r in results}) == 1
    assert len(store.query("SELECT * FROM events")) == 1


def test_disabled_child_mapping_does_not_fall_back_to_parent(capture):
    store, project, root = capture
    child = root / "excluded-project"
    child.mkdir()
    Service(store).create_project(ProjectInput(name="disabled", root=str(child), vault=project["vault"], capture_enabled=False))
    assert capture_event(store, payload(child, record("assistant", "private")))["status"] == "disabled"
    assert store.query("SELECT * FROM events") == []
    with pytest.raises(ValueError, match="does not match"):
        capture_event(store, payload(root, record("assistant", "private"), project_id="wrong"))


@pytest.mark.asyncio
async def test_extraction_disabled_and_replay_preserves_candidates(capture):
    store, project, root = capture
    event = capture_event(store, payload(root, record("assistant", "Verified conclusion.")))
    disabled = await extract_event(store, event["event_id"])
    assert disabled["status"] == "needs_agent"

    class Adapter:
        calls = 0

        async def extract(self, text, policy_prompt=""):
            self.calls += 1
            return {"candidates": [{"title": "Verified", "content": "Verified conclusion.", "source": "Verified conclusion."}]}

    model = Adapter()
    result = await extract_event(store, event["event_id"], model)
    assert result["status"] == "extracted"
    replay = await extract_event(Store(store.home), event["event_id"], model)
    assert replay["candidates"] == result["candidates"] and model.calls == 1
    proposals = Service(store).submit(Submission(project_id=project["id"], session_id="capture-session", candidates=result["candidates"]))
    mark_submitted(store, event["event_id"], [p["id"] for p in proposals])
    assert (await extract_event(store, event["event_id"], model))["status"] == "submitted"


@pytest.mark.asyncio
async def test_concurrent_extraction_claim_and_bad_source(capture):
    store, _, root = capture
    event = capture_event(store, payload(root, record("assistant", "Real source.")))
    started, finish = asyncio.Event(), asyncio.Event()

    class Adapter:
        async def extract(self, text, policy_prompt=""):
            started.set()
            await finish.wait()
            return {"candidates": [{"title": "Bad", "content": "invented", "source": "invented"}]}

    task = asyncio.create_task(extract_event(store, event["event_id"], Adapter()))
    await started.wait()
    second = await extract_event(store, event["event_id"], Adapter())
    assert second["status"] == "extracting"
    finish.set()
    assert (await task)["status"] == "model_error"
    row = store.query("SELECT * FROM events WHERE id=?", (event["event_id"],))[0]
    assert row["data"]["attempts"] == 1


@pytest.mark.asyncio
async def test_filtered_content_is_retained_for_audit_not_repeated_forever(capture):
    store, _, root = capture
    event = capture_event(store, payload(root, record("user", "Temporary command output.")))

    class Adapter:
        async def extract(self, text, policy_prompt=""):
            return {"candidates": []}

    result = await extract_event(store, event["event_id"], Adapter())
    assert result["status"] == "filtered"
    row = store.query("SELECT * FROM events WHERE id=?", (event["event_id"],))[0]
    assert row["data"]["requires_filtered_audit"]
    assert row["data"]["messages"][0]["content"] == "Temporary command output."
    assert (await extract_event(store, event["event_id"], Adapter()))["status"] == "filtered"


@pytest.mark.asyncio
async def test_expired_claim_at_retry_limit_leaves_worker_queue(capture):
    store, _, root = capture
    event = capture_event(store, payload(root, record("assistant", "Durable source.")))
    row = store.query("SELECT * FROM events WHERE id=?", (event["event_id"],))[0]
    data = row["data"] | {"attempts": 3, "claim_time": 0}
    store.execute("UPDATE events SET status='extracting',data=? WHERE id=?", (encode(data), event["event_id"]))

    class NeverCalled:
        async def extract(self, *args, **kwargs):
            raise AssertionError("Exhausted retry must never call a model")

    result = await extract_event(store, event["event_id"], NeverCalled())
    assert result["status"] == "model_error"
    assert store.query("SELECT status FROM events WHERE id=?", (event["event_id"],))[0]["status"] == "model_error"
    assert store.query("SELECT id FROM events WHERE status IN ('queued','extracting','extracted','needs_agent')") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["queued", "extracted", "extracting"])
async def test_disabling_project_retires_existing_worker_queue(capture, status):
    store, project, root = capture
    event = capture_event(store, payload(root, record("assistant", "Durable source.")))
    store.execute("UPDATE events SET status=? WHERE id=?", (status, event["event_id"]))
    data = store.query("SELECT * FROM projects WHERE id=?", (project["id"],))[0]["data"]
    data["capture_enabled"] = False
    store.execute("UPDATE projects SET data=? WHERE id=?", (encode(data), project["id"]))
    result = await extract_event(store, event["event_id"])
    assert result["status"] == "capture_disabled"
    assert store.query("SELECT status FROM events WHERE id=?", (event["event_id"],))[0]["status"] == "capture_disabled"
    assert store.query("SELECT id FROM events WHERE status IN ('queued','extracting','extracted','needs_agent')") == []


@pytest.mark.asyncio
async def test_planning_retry_reuses_cached_candidates_without_model(capture):
    store, _, root = capture
    event = capture_event(store, payload(root, record("assistant", "Durable source.")))
    row = store.query("SELECT * FROM events WHERE id=?", (event["event_id"],))[0]
    candidates = [{"title": "Durable", "content": "Durable source.", "source": "Durable source."}]
    data = row["data"] | {"candidates": candidates, "attempts": 3}
    store.execute("UPDATE events SET status='planning_error',data=? WHERE id=?", (encode(data), event["event_id"]))
    result = await extract_event(store, event["event_id"])
    assert result["candidates"] == candidates
    assert result["status"] == "extracted"
    assert store.query("SELECT status FROM events WHERE id=?", (event["event_id"],))[0]["status"] == "extracted"


@pytest.mark.asyncio
async def test_model_input_budget_and_remote_endpoint_requirements(capture):
    store, _, _ = capture
    store.set_meta("model_settings", {"enabled": True, "model": "local", "max_input_chars": 1000, "daily_calls": 1})
    model = ConfiguredModel(store)
    with pytest.raises(ValueError, match="Complete model prompt"):
        await model.extract("a" * 900)
    assert store.query("SELECT * FROM meta WHERE key LIKE 'model_budget:%'") == []
    model.reserve()
    with pytest.raises(BudgetExceeded):
        ConfiguredModel(store).reserve()
    store.set_meta("model_settings", {"enabled": True, "model": "remote", "endpoint": "http://example.com/v1"})
    with pytest.raises(ValueError, match="HTTPS"):
        ConfiguredModel(store)


def test_redaction_preserves_valid_json_candidate_text():
    data = {"source": 'password="secret"', "content": "api_key=abcdef", "tags": []}
    redacted = {k: redact(v) if isinstance(v, str) else v for k, v in data.items()}
    assert json.loads(encode(redacted)) == redacted
    assert "secret" not in encode(redacted) and "abcdef" not in encode(redacted)
