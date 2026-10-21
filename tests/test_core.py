from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from library_companion.models import Candidate, ProjectInput, Review, Submission
from library_companion.service import Service
from library_companion.store import Store
from library_companion.vault import Vault, digest


@pytest.fixture
def core(tmp_path):
    root = tmp_path / "project"
    vault = tmp_path / "vault"
    root.mkdir()
    vault.mkdir()
    service = Service(Store(tmp_path / "state"))
    project = service.create_project(ProjectInput(name="测试项目", root=str(root), vault=str(vault)))
    return service, project, vault


def submit(core, **changes):
    service, project, _ = core
    candidate = Candidate(**({"title": "中文知识", "content": "有依据的结论。", "source": "会话第 3 轮明确作出的决策。"} | changes))
    return service.submit(Submission(project_id=project["id"], session_id="session-1", candidates=[candidate]))[0]


def approve(service, proposal, **changes):
    review = Review(revision=proposal["revision"], action=changes.pop("action", proposal["recommended_action"]), **changes)
    preview = service.preview(proposal["id"], review)
    return service.review(proposal["id"], review.model_copy(update={"preview_token": preview["preview_token"]}))


def test_proposal_waits_and_feedback_is_only_human(core):
    service, _, vault = core
    proposal = submit(core)
    assert proposal["status"] == "pending"
    assert list(vault.rglob("*.md")) == []
    assert service.store.query("SELECT * FROM feedback") == []
    with pytest.raises(PermissionError):
        service.review(proposal["id"], Review(revision=1, action="save"), actor="agent")
    deferred = service.review(proposal["id"], Review(revision=1, action="defer"))
    assert deferred["proposal"]["revision"] == 2
    assert service.store.query("SELECT * FROM feedback") == []
    with pytest.raises(ValueError, match="revision"):
        service.preview(proposal["id"], Review(revision=1, action="save"))


def test_submit_dedup_survives_restart(core):
    service, project, _ = core
    first = submit(core)
    second = submit(core)
    assert first["id"] == second["id"]
    restarted = Service(Store(service.store.home))
    candidate = Candidate(title=first["title"], content=first["content"], source=first["source"])
    assert restarted.submit(Submission(project_id=project["id"], session_id="session-1", candidates=[candidate]))[0]["id"] == first["id"]


def test_preview_bound_to_all_edits_and_target(core):
    service, _, vault = core
    proposal = submit(core)
    review = Review(revision=1, action="save")
    preview = service.preview(proposal["id"], review)
    for changed in ({"content": "Different"}, {"target": "Library/other.md"}, {"title": "New"}, {"tags": ["new"]}):
        with pytest.raises(ValueError, match="changed after preview"):
            service.review(proposal["id"], review.model_copy(update={"preview_token": preview["preview_token"], **changed}))
    assert list(vault.rglob("*.md")) == []
    approved = service.review(proposal["id"], review.model_copy(update={"preview_token": preview["preview_token"]}))
    assert approved["proposal"]["status"] == "applied"
    assert len(service.store.query("SELECT * FROM feedback")) == 1
    repeated = service.review(proposal["id"], review.model_copy(update={"preview_token": preview["preview_token"]}))
    assert repeated["idempotent"] is True
    assert len(service.store.query("SELECT * FROM writes")) == 1


def test_hash_captured_at_submission_and_refresh_requires_new_revision(core):
    service, _, vault = core
    path = vault / "Library/existing.md"
    path.parent.mkdir()
    path.write_text("# Original\n", encoding="utf-8")
    proposal = submit(core, target="Library/existing.md")
    path.write_text("# External edit\n", encoding="utf-8")
    with pytest.raises(ValueError, match="changed since submission"):
        service.preview(proposal["id"], Review(revision=1, action="update"))
    refreshed = service.refresh(proposal["id"], 1)
    assert refreshed["revision"] == 2
    with pytest.raises(ValueError, match="revision"):
        service.preview(proposal["id"], Review(revision=1, action="update"))
    approve(service, refreshed)
    assert path.read_text(encoding="utf-8").startswith("# External edit\n")


def test_update_preserves_original_bytes_and_undo_exactly_restores(core):
    service, _, vault = core
    path = vault / "Library/原笔记.md"
    path.parent.mkdir()
    original = b"\xef\xbb\xbf# Original\r\n\r\n" + "既有内容。".encode("utf-8")
    path.write_bytes(original)
    proposal = submit(core, target="Library/原笔记.md")
    written = approve(service, proposal)
    assert path.read_bytes().startswith(original)
    result = service.undo(written["write"]["id"])
    assert result["status"] == "undone"
    assert path.read_bytes() == original
    assert len(service.store.query("SELECT * FROM feedback")) == 2


def test_undo_new_note_and_conflicting_edit(core):
    service, _, vault = core
    proposal = submit(core)
    written = approve(service, proposal)
    path = vault / proposal["target"]
    path.write_bytes(path.read_bytes() + "\n用户补充".encode("utf-8"))
    changed = path.read_bytes()
    result = service.undo(written["write"]["id"])
    assert result["status"] == "conflict" and result["requires_review"]
    assert result["diff"]
    assert path.read_bytes() == changed
    second = submit(core, title="Other")
    applied = approve(service, second)
    assert (vault / second["target"]).exists()
    assert service.undo(applied["write"]["id"])["status"] == "undone"
    assert not (vault / second["target"]).exists()
    assert service.undo(applied["write"]["id"])["idempotent"]


def test_changed_target_has_its_own_hash_bound_to_preview(core):
    service, _, vault = core
    proposal = submit(core)
    path = vault / "Library/alternate.md"
    path.parent.mkdir()
    path.write_text("# Alternate\n", encoding="utf-8")
    review = Review(revision=1, action="update", target="Library/alternate.md")
    preview = service.preview(proposal["id"], review)
    path.write_text("external edit", encoding="utf-8")
    with pytest.raises(ValueError, match="changed after preview"):
        service.review(proposal["id"], review.model_copy(update={"preview_token": preview["preview_token"]}))
    assert path.read_text(encoding="utf-8") == "external edit"


@pytest.mark.parametrize("path", ["../outside.md", "/abs.md", "C:/outside.md", "Library/../bad.md", "Library//bad.md",
    "Library/./bad.md", "Library/bad.md:stream", "Library/bad.md.", "Library/bad.md ", "Library/NUL.md",
    "Library/COM¹.md", "Library/.obsidian/foo.md", "Library/foo\x00.md", "Library/a\"b.md", "Library/file.txt",
    "Other/no.md", "\\\\?\\C:\\outside.md", "Library/node_modules/bad.md"])
def test_windows_path_bypasses_rejected(core, path):
    service, project, _ = core
    with pytest.raises(ValueError):
        Vault(project, service.store.home).resolve(path, write=True)


def test_junction_escape_and_hardlinks_rejected(core, tmp_path):
    service, project, vault = core
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "escape.md").write_text("private", encoding="utf-8")
    (vault / "Library").mkdir()
    link = vault / "Library/link"
    try:
        os.symlink(outside, link, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            pytest.skip("symlink unavailable")
        import subprocess
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
    with pytest.raises(ValueError, match="Symlinks and junctions"):
        Vault(project, service.store.home).read("Library/link/escape.md")
    os.link(outside / "escape.md", vault / "Library/hard.md")
    with pytest.raises(ValueError, match="Hard-linked"):
        Vault(project, service.store.home).read("Library/hard.md")


def test_link_and_tag_validation(core):
    with pytest.raises(ValidationError):
        Candidate(title="ok", content="ok", source="ok", tags=["x\nscript"])
    with pytest.raises(ValidationError):
        Candidate(title="bad\nheading", content="ok", source="ok")
    with pytest.raises(ValueError, match="Missing or ambiguous"):
        submit(core, content="正文 [[missing]]")
    service, _, vault = core
    (vault / "Library").mkdir()
    (vault / "Library/目标.md").write_text("# 目标", encoding="utf-8")
    proposal = submit(core, links=["目标"], content="详见 [[Library/目标|示例]]。")
    assert approve(service, proposal)["write"]["status"] == "applied"


def test_crash_after_write_is_finalized_once(core, monkeypatch):
    service, _, vault = core
    proposal = submit(core)
    def crash(_row):
        raise RuntimeError("crash after filesystem write")
    monkeypatch.setattr(service, "_finalize_write", crash)
    with pytest.raises(RuntimeError, match="crash"):
        approve(service, proposal)
    assert (vault / proposal["target"]).exists()
    assert service.store.query("SELECT * FROM writes")[0]["status"] == "prepared"
    assert service.store.query("SELECT * FROM feedback") == []
    restarted = Service(Store(service.store.home))
    assert restarted.recover()[0]["status"] == "applied"
    assert restarted.recover() == []
    assert len(service.store.query("SELECT * FROM feedback")) == 1


def test_crash_before_write_returns_pending_without_automatic_mutation(core, monkeypatch):
    service, _, vault = core
    proposal = submit(core)
    def crash(*args):
        raise OSError("simulated locked file")
    monkeypatch.setattr(Vault, "write", crash)
    with pytest.raises(OSError):
        approve(service, proposal)
    assert service.recover()[0]["status"] == "aborted"
    assert list(vault.rglob("*.md")) == []
    assert service.store.proposal(proposal["id"])["status"] == "pending"
    assert service.store.query("SELECT * FROM feedback") == []


def test_concurrent_duplicate_reviews_write_once(core):
    service, _, _ = core
    proposal = submit(core)
    review = Review(revision=1, action="save")
    preview = service.preview(proposal["id"], review)
    approved = review.model_copy(update={"preview_token": preview["preview_token"]})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: Service(Store(service.store.home)).review(proposal["id"], approved), range(2)))
    assert all(r["write"]["status"] == "applied" for r in results)
    assert len(service.store.query("SELECT * FROM writes")) == 1
    assert len(service.store.query("SELECT * FROM feedback")) == 1


def test_discard_is_feedback_but_does_not_delete_notes(core):
    service, _, vault = core
    (vault / "Library").mkdir()
    path = vault / "Library/existing.md"
    path.write_text("Keep me", encoding="utf-8")
    proposal = submit(core, target="Library/existing.md")
    service.review(proposal["id"], Review(revision=1, action="discard", reason="暂时无长期价值"))
    assert path.read_text(encoding="utf-8") == "Keep me"
    assert service.store.query("SELECT * FROM feedback")[0]["data"]["action"] == "discard"


def test_chinese_search_and_case_canonicalization(core):
    service, project, vault = core
    (vault / "Library").mkdir()
    (vault / "Library/中文测试.MD").write_text("# 科研决策\n\n记录知识整理方法。", encoding="utf-8")
    result = service.search(project["id"], "知识整理")
    assert result and result[0]["path"] == "Library/中文测试.MD"
    assert Vault(project, service.store.home).canonical("library/中文测试.md", write=True) == "Library/中文测试.MD"
    assert digest(None) != digest(b"")


def test_duplicate_candidates_in_single_batch_are_deduplicated(core):
    service, project, _ = core
    candidate = Candidate(title="One", content="Body", source="Evidence")
    result = service.submit(Submission(project_id=project["id"], session_id="s", candidates=[candidate, candidate]))
    assert len(result) == 1
    assert len(service.store.proposal_list()) == 1


def test_idempotent_retry_cannot_change_the_approved_request(core):
    service, _, _ = core
    proposal = submit(core)
    review = Review(revision=1, action="save")
    preview = service.preview(proposal["id"], review)
    reviewed = review.model_copy(update={"preview_token": preview["preview_token"]})
    service.review(proposal["id"], reviewed)
    with pytest.raises(ValueError, match="idempotent retry"):
        service.review(proposal["id"], reviewed.model_copy(update={"content": "different"}))


def test_automation_requires_current_explicit_authorization(core):
    service, _, vault = core
    proposal = submit(core)
    with pytest.raises(PermissionError, match="not authorized"):
        service.execute_authorized(proposal["id"], "invented-policy")
    assert list(vault.rglob("*.md")) == []
    assert service.store.query("SELECT * FROM feedback") == []


def test_automation_rechecks_authorization_inside_write_lock(core, monkeypatch):
    from library_companion.learning import Learning

    service, _, vault = core
    proposal = submit(core)
    calls = []
    def decide(self, project_id, value):
        calls.append(value["id"])
        return {"allowed": len(calls) == 1, "policy_id": "approved-policy", "policy_version": 1}
    monkeypatch.setattr(Learning, "can_automate", decide)
    with pytest.raises(PermissionError, match="changed before execution"):
        service.execute_authorized(proposal["id"], "approved-policy")
    assert len(calls) == 2
    assert list(vault.rglob("*.md")) == []
    assert service.store.query("SELECT * FROM writes") == []


def test_authorized_write_never_becomes_human_training_example(core, monkeypatch):
    from library_companion.learning import Learning

    service, _, vault = core
    proposal = submit(core)
    monkeypatch.setattr(Learning, "can_automate", lambda *_: {
        "allowed": True, "policy_id": "approved-policy", "policy_version": 3})
    result = service.execute_authorized(proposal["id"], "approved-policy")
    assert result["write"]["status"] == "applied"
    assert result["write"]["data"]["actor"] == "policy"
    assert result["write"]["data"]["authorization"]["policy_id"] == "approved-policy"
    assert service.store.query("SELECT * FROM feedback") == []
    assert service.execute_authorized(proposal["id"], "approved-policy")["idempotent"]
    assert service.undo(result["write"]["id"])["status"] == "undone"
    assert not (vault / proposal["target"]).exists()
    feedback = service.store.query("SELECT * FROM feedback")
    assert len(feedback) == 1 and feedback[0]["data"]["action"] == "undo"
    assert Learning(service.store)._examples(proposal["project_id"]) == []


def test_crashed_automatic_write_recovery_does_not_create_human_feedback(core, monkeypatch):
    from library_companion.learning import Learning

    service, _, _ = core
    proposal = submit(core)
    monkeypatch.setattr(Learning, "can_automate", lambda *_: {
        "allowed": True, "policy_id": "approved-policy", "policy_version": 1})
    monkeypatch.setattr(service, "_finalize_write", lambda _: (_ for _ in ()).throw(RuntimeError("crash")))
    with pytest.raises(RuntimeError):
        service.execute_authorized(proposal["id"], "approved-policy")
    assert Service(Store(service.store.home)).recover()[0]["status"] == "applied"
    assert service.store.query("SELECT * FROM feedback") == []


def test_undo_crash_is_recovered_exactly_once(core, monkeypatch):
    service, _, vault = core
    proposal = submit(core)
    written = approve(service, proposal)
    monkeypatch.setattr(service, "_finalize_undo", lambda _: (_ for _ in ()).throw(RuntimeError("crash")))
    with pytest.raises(RuntimeError):
        service.undo(written["write"]["id"])
    assert not (vault / proposal["target"]).exists()
    restarted = Service(Store(service.store.home))
    assert restarted.recover()[0]["status"] == "undone"
    assert restarted.recover() == []
    assert len(service.store.query("SELECT * FROM feedback")) == 2


def test_batch_validation_failure_does_not_leave_partial_proposals(core):
    service, project, _ = core
    valid = Candidate(title="Good", content="body", source="evidence")
    invalid = Candidate(title="Bad", content="body", source="evidence", target="../outside.md")
    with pytest.raises(ValueError):
        service.submit(Submission(project_id=project["id"], session_id="s", candidates=[valid, invalid]))
    assert service.store.proposal_list() == []


def test_redirected_vault_root_cannot_expand_existing_scope(core, tmp_path):
    service, project, vault = core
    moved = tmp_path / "original-vault"
    vault.rename(moved)
    outside = tmp_path / "unexpected-vault"
    outside.mkdir()
    try:
        os.symlink(outside, vault, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            pytest.skip("symlink unavailable")
        import subprocess
        subprocess.run(["cmd", "/c", "mklink", "/J", str(vault), str(outside)], check=True, capture_output=True)
    with pytest.raises(ValueError, match="root was redirected"):
        Vault(project, service.store.home)
    assert list(outside.iterdir()) == []


def test_journal_is_reconciled_before_a_changed_target_can_write_again(core, monkeypatch):
    service, _, vault = core
    proposal = submit(core)
    original_finalize = service._finalize_write
    monkeypatch.setattr(service, "_finalize_write", lambda _: (_ for _ in ()).throw(RuntimeError("crash")))
    with pytest.raises(RuntimeError):
        approve(service, proposal)
    monkeypatch.setattr(service, "_finalize_write", original_finalize)
    with pytest.raises(ValueError, match="already resolved"):
        service.preview(proposal["id"], Review(revision=1, action="save", target="Library/retry-other-target.md"))
    assert service.store.proposal(proposal["id"])["status"] == "applied"
    assert len(service.store.query("SELECT * FROM feedback")) == 1
    assert len(service.store.query("SELECT * FROM writes")) == 1
    assert not (vault / "Library/retry-other-target.md").exists()


def test_unperformed_journal_can_be_replanned_without_implicit_write(core, monkeypatch):
    service, _, vault = core
    proposal = submit(core)
    original_write = Vault.write
    monkeypatch.setattr(Vault, "write", lambda *_: (_ for _ in ()).throw(OSError("locked")))
    with pytest.raises(OSError):
        approve(service, proposal)
    monkeypatch.setattr(Vault, "write", original_write)
    preview = service.preview(proposal["id"], Review(revision=1, action="save", target="Library/new-target.md"))
    assert preview["target"] == "Library/new-target.md"
    assert service.store.query("SELECT * FROM writes")[0]["status"] == "aborted"
    assert list(vault.rglob("*.md")) == []


def test_append_size_limit_cannot_leave_an_unreadable_committed_note(core):
    service, _, vault = core
    (vault / "Library").mkdir()
    path = vault / "Library/full.md"
    original = b"# Near size limit\n" + b"x" * 999_950
    path.write_bytes(original)
    with pytest.raises(ValueError, match="Resulting note exceeds"):
        submit(core, target="Library/full.md")
    assert path.read_bytes() == original
    assert service.store.proposal_list() == []
    assert service.store.query("SELECT * FROM writes") == []
