from __future__ import annotations

import base64
import difflib
import secrets
from pathlib import Path

from .models import Candidate, ProjectInput, Review, Submission
from .store import Store, encode, now, uid
from .vault import BLOCKED, MAX_NOTE_BYTES, Vault, clean_title, digest, relative_parts


def _packed(raw: bytes | None) -> str | None:
    return base64.b64encode(raw).decode("ascii") if raw is not None else None


def _unpacked(value: str | None) -> bytes | None:
    return base64.b64decode(value) if value is not None else None


def _text(raw: bytes | None) -> str:
    return raw.decode("utf-8-sig") if raw is not None else ""


def _escaped(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("<", "&lt;").replace(">", "&gt;")


def _request(review: Review) -> dict:
    return review.model_dump(exclude={"preview_token", "reason"})


def _diff(before: str, after: str, target: str) -> str:
    return "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                        fromfile=f"a/{target}", tofile=f"b/{target}"))


class Service:
    """Core persistence boundary. Only trusted adapters may call human review/undo.

    The filesystem lock coordinates this service. External editors do not share it;
    the final hash checks narrow but cannot remove the external-writer race.
    """

    def __init__(self, store: Store):
        self.store = store
        with store.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS previews_proposal ON previews(proposal_id)")

    def create_project(self, value: ProjectInput) -> dict:
        data = value.model_dump()
        vault_path = Path(data["vault"]).expanduser()
        root_path = Path(data["root"]).expanduser()
        if not vault_path.is_absolute() or not root_path.is_absolute():
            raise ValueError("Project and vault paths must be absolute")
        if not root_path.is_dir() or not vault_path.is_dir():
            raise ValueError("Project root and vault must already exist")
        data["root"] = str(root_path.resolve(strict=True))
        data["vault"] = str(vault_path.resolve(strict=True))
        for key in ("writable_dirs", "excluded_dirs", "source_excluded_dirs"):
            directories = []
            for item in data[key]:
                parts = relative_parts(item, directory=True, allow_hidden=key == "excluded_dirs")
                if key == "writable_dirs" and any(p.casefold() in BLOCKED for p in parts):
                    raise ValueError("Protected directories cannot be writable")
                directories.append("/".join(parts))
            data[key] = list(dict.fromkeys(directories))
        project_id = uid()
        data["created_at"] = now()
        project = {"id": project_id, **data}
        vault = Vault(project, self.store.home)
        for directory in data["writable_dirs"]:
            vault.resolve(directory + "/path-validation.md", write=True)
        self.store.execute("INSERT INTO projects VALUES(?,?)", (project_id, encode(data)))
        return project

    def _vault(self, project_id: str) -> Vault:
        return Vault(self.store.project(project_id), self.store.home)

    def _render(self, proposal_id: str, session_id: str, candidate: dict, before: bytes | None) -> bytes:
        title = _escaped(candidate["title"])
        heading = "#" if before is None else "##"
        content = f"{heading} {title}\n\n{candidate['content'].rstrip()}\n"
        if candidate["uncertain"]:
            content += "\n> 证据状态：待验证。\n"
        if candidate["tags"]:
            content += "\n" + " ".join("#" + tag for tag in candidate["tags"]) + "\n"
        if candidate["links"]:
            content += "\n关联：" + " · ".join("[[" + link + "]]" for link in candidate["links"]) + "\n"
        content += "\n### 来源\n\n" + "\n".join("> " + _escaped(line) for line in candidate["source"].splitlines())
        content += f"\n\n<!-- library-companion proposal={proposal_id} session={_escaped(session_id)} -->\n"
        if before is None:
            return content.encode("utf-8")
        newline = "\r\n" if b"\r\n" in before else "\n"
        addition = ("" if before.endswith((b"\n\n", b"\r\n\r\n")) else newline if before.endswith(b"\n") else newline * 2)
        # Existing bytes (including BOM and CRLF) are an unchanged prefix.
        after = before + (addition + content.replace("\n", newline)).encode("utf-8")
        if len(after) > MAX_NOTE_BYTES:
            raise ValueError("Resulting note exceeds one megabyte; choose another target")
        return after

    def _candidate(self, proposal: dict, review: Review) -> dict:
        value = {key: proposal[key] for key in Candidate.model_fields}
        for key in ("title", "content", "target", "links", "tags"):
            if getattr(review, key) is not None:
                value[key] = getattr(review, key)
        return Candidate.model_validate(value).model_dump()

    def submit(self, value: Submission) -> list[dict]:
        project = self.store.project(value.project_id)
        vault = Vault(project, self.store.home)
        result = []
        with vault.lock():
            pending = []
            seen = {}
            for model in value.candidates:
                candidate = model.model_dump()
                fingerprint = digest(encode(candidate))
                if fingerprint in seen:
                    continue
                seen[fingerprint] = True
                existing = self.store.query("SELECT id FROM proposals WHERE project_id=? AND session_id=? AND fingerprint=?",
                                            (value.project_id, value.session_id, fingerprint))
                if existing:
                    result.append(existing[0]["id"])
                    continue
                proposal_id = uid()
                target = candidate["target"]
                matches = vault.search(candidate["title"], 5)
                exact = [note for note in matches if note["title"].casefold() == candidate["title"].casefold()]
                if target is None:
                    target = exact[0]["path"] if len(exact) == 1 else project["writable_dirs"][0] + "/" + clean_title(candidate["title"]) + ".md"
                target = vault.canonical(target, write=True)
                candidate["target"] = target
                vault.validate_links(candidate["links"], target, candidate["content"])
                before = vault.read_bytes(target)
                action = "update" if before is not None else "save"
                duplicate = bool(before is not None and candidate["content"].strip() in _text(before))
                if duplicate:
                    action = "discard"
                after = before if duplicate else self._render(proposal_id, value.session_id, candidate, before)
                risks = ["uncertain_evidence"] if candidate["uncertain"] else []
                data = {**candidate, "candidate": candidate, "recommended_action": action,
                        "rationale": "目标笔记已包含相同正文，建议丢弃重复候选。" if duplicate else
                                     "找到同主题笔记，建议保留原文并追加已核实内容。" if before is not None else "未找到相同主题的笔记，建议新建。",
                        "base_hash": digest(before), "before": _text(before), "after": _text(after),
                        "diff": _diff(_text(before), _text(after), target), "risk_flags": risks,
                        "before_snapshot": _packed(before), "policy_version": "assisted-v1",
                        "evidence_status": "uncertain" if candidate["uncertain"] else "source_provided",
                        "synthetic": project.get("synthetic", False)}
                pending.append((proposal_id, value.project_id, value.session_id, fingerprint, "pending", 1, now(), encode(data)))
                result.append(proposal_id)
            with self.store.connection() as db:
                for row in pending:
                    db.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)", row)
        return [self.store.proposal(identifier) for identifier in result]

    def _settle_proposal(self, proposal_id: str, vault: Vault) -> dict:
        """Reconcile journaled effects before accepting any replacement review.

        Caller holds the vault lock; recovery finalizes observed effects and
        aborts unperformed writes without mutating the filesystem.
        """
        rows = self.store.query(
            "SELECT * FROM writes WHERE proposal_id=? AND status IN ('prepared','undo_prepared') ORDER BY created_at",
            (proposal_id,),
        )
        for row in rows:
            self._recover_row(row, vault)
        return self.store.proposal(proposal_id)

    def _check_revision(self, proposal: dict, revision: int):
        if proposal["revision"] != revision:
            raise ValueError("Conflict: proposal revision changed; load and preview the latest revision")
        if proposal["status"] not in {"pending", "deferred", "conflict"}:
            raise ValueError("Proposal is already resolved")

    def preview(self, proposal_id: str, review: Review) -> dict:
        proposal = self.store.proposal(proposal_id)
        vault = self._vault(proposal["project_id"])
        with vault.lock():
            proposal = self._settle_proposal(proposal_id, vault)
            self._check_revision(proposal, review.revision)
            if review.action not in {"save", "update"}:
                return {"proposal_id": proposal_id, "revision": proposal["revision"], "action": review.action,
                        "before": proposal["before"], "after": proposal["before"], "diff": "", "target": proposal["target"]}
            candidate = self._candidate(proposal, review)
            target = vault.canonical(candidate["target"], write=True)
            candidate["target"] = target
            before = vault.read_bytes(target)
            if target.casefold() == proposal["target"].casefold() and digest(before) != proposal["base_hash"]:
                raise ValueError("Conflict: note changed since submission; refresh this proposal before previewing")
            if review.action == "save" and before is not None:
                raise ValueError("Save requires an absent target; use update to append to an existing note")
            if review.action == "update" and before is None:
                raise ValueError("Update requires an existing target; use save for a new note")
            vault.validate_links(candidate["links"], target, candidate["content"])
            after = self._render(proposal_id, proposal["session_id"], candidate, before)
            token = secrets.token_urlsafe(32)
            data = {"proposal_id": proposal_id, "revision": proposal["revision"], "action": review.action,
                    "target": target, "base_hash": digest(before), "after_hash": digest(after),
                    "before": _text(before), "after": _text(after), "diff": _diff(_text(before), _text(after), target),
                    "candidate": candidate, "request": _request(review),
                    "before_snapshot": _packed(before), "after_snapshot": _packed(after),
                    "risk_flags": proposal["risk_flags"]}
            self.store.execute("INSERT INTO previews VALUES(?,?,?,?)", (token, proposal_id, now(), encode(data)))
            return {key: val for key, val in data.items() if key not in {"request", "before_snapshot", "after_snapshot"}} | {"preview_token": token}

    def refresh(self, proposal_id: str, revision: int) -> dict:
        proposal = self.store.proposal(proposal_id)
        vault = self._vault(proposal["project_id"])
        with vault.lock():
            proposal = self._settle_proposal(proposal_id, vault)
            self._check_revision(proposal, revision)
            before = vault.read_bytes(proposal["target"])
            candidate = {key: proposal[key] for key in Candidate.model_fields}
            vault.validate_links(candidate["links"], candidate["target"], candidate["content"])
            after = self._render(proposal_id, proposal["session_id"], candidate, before)
            fields = {key: val for key, val in proposal.items() if key not in {"id", "project_id", "session_id", "fingerprint", "status", "revision", "created_at"}}
            fields.update(base_hash=digest(before), before=_text(before), after=_text(after),
                          before_snapshot=_packed(before), diff=_diff(_text(before), _text(after), candidate["target"]),
                          recommended_action="save" if before is None else "update")
            self.store.execute("UPDATE proposals SET revision=revision+1,status='pending',data=? WHERE id=? AND revision=?",
                               (encode(fields), proposal_id, revision))
            self.store.execute("DELETE FROM previews WHERE proposal_id=?", (proposal_id,))
        return self.store.proposal(proposal_id)

    def _feedback(self, proposal: dict, final: dict, *, action: str, reason: str, result: str, write_id=None) -> dict:
        return {"actor": "human", "human": True, "original": proposal, "final": final,
                "action": action, "reason": reason, "result": result, "write_id": write_id,
                "synthetic": proposal.get("synthetic", False), "policy_version": proposal.get("policy_version"),
                "content_changed": final.get("content") != proposal["content"],
                "target_changed": final.get("target") != proposal["target"],
                "links_changed": final.get("links") != proposal["links"], "created_at": now()}

    def _notify_feedback(self, project_id: str, feedback: dict):
        try:
            from .learning import Learning
        except ImportError:
            return
        Learning(self.store).on_feedback(project_id, feedback)

    def _finalize_write(self, row: dict):
        data = row["data"]
        proposal = self.store.proposal(row["proposal_id"])
        feedback = data.get("feedback")
        with self.store.connection() as db:
            db.execute("UPDATE writes SET status='applied',data=? WHERE id=?", (encode(data), row["id"]))
            db.execute("UPDATE proposals SET status='applied' WHERE id=?", (row["proposal_id"],))
            if feedback:
                db.execute("INSERT OR IGNORE INTO feedback VALUES(?,?,?,?,?,?)",
                           (data["feedback_id"], row["proposal_id"], row["project_id"], proposal["session_id"], now(), encode(feedback)))
            db.execute("DELETE FROM previews WHERE proposal_id=?", (row["proposal_id"],))
            db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       ("knowledge_changed:" + row["project_id"], encode(now())))
        if feedback:
            self._notify_feedback(row["project_id"], feedback)
        from .retrieval import Retrieval
        from .vault import Vault
        vault = Vault(self.store.project(row['project_id']), self.store.home)
        content = vault.read(data['target'])
        if content is not None:
            Retrieval(self.store).catalog_note(row['project_id'],
                {'path': data['target'], 'title': Path(data['target']).stem,
                 'hash': vault.hash(data['target']), 'content': content})

    def review(self, proposal_id: str, review: Review, actor="human") -> dict:
        if actor != "human":
            raise PermissionError("Only the trusted human review boundary can approve a proposal")
        proposal = self.store.proposal(proposal_id)
        vault = self._vault(proposal["project_id"])
        with vault.lock():
            proposal = self._settle_proposal(proposal_id, vault)
            previous = self.store.query("SELECT * FROM writes WHERE proposal_id=? ORDER BY created_at DESC", (proposal_id,))
            if previous and previous[0]["data"].get("preview_token") == review.preview_token and review.preview_token:
                row = previous[0]
                if row["data"].get("review") != review.model_dump():
                    raise ValueError("Conflict: idempotent retry must match the original review exactly")
                if row["status"] in {"applied", "undone"}:
                    return {"proposal": proposal, "write": row, "idempotent": True}
                if row["status"] == "prepared":
                    recovered = self._recover_row(row, vault)
                    if recovered["status"] == "applied":
                        return {"proposal": self.store.proposal(proposal_id), "write": recovered, "idempotent": True}
            self._check_revision(proposal, review.revision)
            if review.action == "defer":
                self.store.execute("UPDATE proposals SET status='deferred',revision=revision+1 WHERE id=?", (proposal_id,))
                self.store.execute("DELETE FROM previews WHERE proposal_id=?", (proposal_id,))
                return {"proposal": self.store.proposal(proposal_id), "write": None}
            if review.action == "discard":
                final = self._candidate(proposal, review) | {"action": "discard"}
                feedback = self._feedback(proposal, final, action="discard", reason=review.reason, result="discarded")
                with self.store.connection() as db:
                    db.execute("UPDATE proposals SET status='discarded' WHERE id=?", (proposal_id,))
                    db.execute("INSERT INTO feedback VALUES(?,?,?,?,?,?)",
                               (uid(), proposal_id, proposal["project_id"], proposal["session_id"], now(), encode(feedback)))
                    db.execute("DELETE FROM previews WHERE proposal_id=?", (proposal_id,))
                self._notify_feedback(proposal["project_id"], feedback)
                return {"proposal": self.store.proposal(proposal_id), "write": None}
            previews = self.store.query("SELECT * FROM previews WHERE id=? AND proposal_id=?", (review.preview_token, proposal_id))
            if not previews:
                raise ValueError("An exact preview_token is required before approval")
            preview = previews[0]["data"]
            if preview["request"] != _request(review) or preview["revision"] != proposal["revision"]:
                raise ValueError("Conflict: review changed after preview; preview the new content and target")
            return self._apply_preview(proposal, review, preview, vault)

    def _apply_preview(self, proposal: dict, review: Review, preview: dict, vault: Vault,
                       *, actor="human", authorization=None) -> dict:
        target = preview["target"]
        if vault.hash(target) != preview["base_hash"]:
            raise ValueError("Conflict: target changed after preview; refresh and preview again")
        vault.validate_links(preview["candidate"]["links"], target, preview["candidate"]["content"])
        write_id = uid()
        final = preview["candidate"] | {"action": review.action}
        feedback = self._feedback(proposal, final, action=review.action, reason=review.reason,
                                  result="applied", write_id=write_id) if actor == "human" else None
        journal = {"target": target, "before_snapshot": preview["before_snapshot"],
                   "after_snapshot": preview["after_snapshot"], "before_hash": preview["base_hash"],
                   "after_hash": preview["after_hash"], "created_note": preview["before_snapshot"] is None,
                   "preview_token": review.preview_token, "review": review.model_dump(),
                   "feedback": feedback, "feedback_id": uid() if feedback else None,
                   "revision": review.revision, "actor": actor, "authorization": authorization, "final": final}
        self.store.execute("INSERT INTO writes VALUES(?,?,?,?,?,?)",
                           (write_id, proposal["id"], proposal["project_id"], "prepared", now(), encode(journal)))
        row = self.store.query("SELECT * FROM writes WHERE id=?", (write_id,))[0]
        vault.write(target, _unpacked(journal["after_snapshot"]), journal["before_hash"])
        self._finalize_write(row)
        return {"proposal": self.store.proposal(proposal["id"]),
                "write": self.store.query("SELECT * FROM writes WHERE id=?", (write_id,))[0]}

    def execute_authorized(self, proposal_id: str, policy_id: str) -> dict:
        """Execute only a separately human-authorized, currently passing policy scope.

        This never creates human feedback. The policy, scope and target hashes are
        checked again inside the same vault lock immediately before journaling.
        """
        from .learning import Learning

        proposal = self.store.proposal(proposal_id)
        previous = self.store.query("SELECT * FROM writes WHERE proposal_id=? ORDER BY created_at DESC", (proposal_id,))
        if previous and previous[0]["status"] in {"applied", "undone"}:
            journal = previous[0]["data"]
            if journal.get("actor") == "policy" and (journal.get("authorization") or {}).get("policy_id") == policy_id:
                return {"proposal": proposal, "write": previous[0], "idempotent": True}
        learning = Learning(self.store)
        verdict = learning.can_automate(proposal["project_id"], proposal)
        if not verdict.get("allowed") or verdict.get("policy_id") != policy_id:
            raise PermissionError("Automation is not authorized: " + verdict.get("reason", "policy changed"))
        review = Review(revision=proposal["revision"], action=proposal["recommended_action"])
        rendered = self.preview(proposal_id, review)
        review = review.model_copy(update={"preview_token": rendered["preview_token"]})
        vault = self._vault(proposal["project_id"])
        with vault.lock():
            proposal = self._settle_proposal(proposal_id, vault)
            self._check_revision(proposal, review.revision)
            verdict = learning.can_automate(proposal["project_id"], proposal)
            if not verdict.get("allowed") or verdict.get("policy_id") != policy_id:
                raise PermissionError("Automation authorization changed before execution")
            rows = self.store.query("SELECT * FROM previews WHERE id=? AND proposal_id=?", (review.preview_token, proposal_id))
            if not rows:
                raise ValueError("Automation preview expired; replan before execution")
            preview = rows[0]["data"]
            if preview["revision"] != proposal["revision"] or preview["request"] != _request(review):
                raise ValueError("Automation proposal changed before execution")
            authorization = {"scope": f"{proposal['project_id']}:{proposal['kind']}:{review.action}",
                             "policy_id": policy_id, "policy_version": verdict["policy_version"], "checked_at": now()}
            return self._apply_preview(proposal, review, preview, vault, actor="policy", authorization=authorization)

    def _recover_row(self, row: dict, vault: Vault) -> dict:
        data = row["data"]
        current = vault.hash(data["target"])
        if row["status"] == "prepared":
            if current == data["after_hash"]:
                self._finalize_write(row)
            elif current == data["before_hash"]:
                # Approval exists in the journal but restart does not silently retry a filesystem mutation.
                self.store.execute("UPDATE writes SET status='aborted' WHERE id=?", (row["id"],))
                self.store.execute("UPDATE proposals SET status='pending' WHERE id=?", (row["proposal_id"],))
            else:
                self.store.execute("UPDATE writes SET status='conflict' WHERE id=?", (row["id"],))
                self.store.execute("UPDATE proposals SET status='conflict' WHERE id=?", (row["proposal_id"],))
        elif row["status"] == "undo_prepared":
            if current == data["before_hash"]:
                self._finalize_undo(row)
            elif current == data["after_hash"]:
                self.store.execute("UPDATE writes SET status='applied' WHERE id=?", (row["id"],))
            else:
                self.store.execute("UPDATE writes SET status='undo_conflict' WHERE id=?", (row["id"],))
        return self.store.query("SELECT * FROM writes WHERE id=?", (row["id"],))[0]

    def recover(self) -> list[dict]:
        results = []
        for row in self.store.query("SELECT * FROM writes WHERE status IN ('prepared','undo_prepared') ORDER BY created_at"):
            try:
                vault = self._vault(row["project_id"])
                with vault.lock():
                    row = self.store.query("SELECT * FROM writes WHERE id=?", (row["id"],))[0]
                    if row["status"] in {"prepared", "undo_prepared"}:
                        results.append(self._recover_row(row, vault))
            except (ValueError, OSError) as exc:
                results.append({"id": row["id"], "status": "recovery_error", "error": str(exc)})
        return results

    def _finalize_undo(self, row: dict):
        data = row["data"]
        proposal = self.store.proposal(row["proposal_id"])
        feedback = data["undo_feedback"]
        with self.store.connection() as db:
            db.execute("UPDATE writes SET status='undone',data=? WHERE id=?", (encode(data), row["id"]))
            db.execute("UPDATE proposals SET status='undone' WHERE id=?", (row["proposal_id"],))
            db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       ("knowledge_changed:" + row["project_id"], encode(now())))
            db.execute("INSERT OR IGNORE INTO feedback VALUES(?,?,?,?,?,?)",
                       (data["undo_feedback_id"], row["proposal_id"], row["project_id"], proposal["session_id"], now(), encode(feedback)))
        self._notify_feedback(row["project_id"], feedback)
        from .retrieval import Retrieval
        Retrieval(self.store).refresh_note_catalog(row["project_id"])

    def undo(self, write_id: str) -> dict:
        rows = self.store.query("SELECT * FROM writes WHERE id=?", (write_id,))
        if not rows:
            raise ValueError("Write does not exist")
        row = rows[0]
        vault = self._vault(row["project_id"])
        with vault.lock():
            row = self.store.query("SELECT * FROM writes WHERE id=?", (write_id,))[0]
            if row["status"] == "undone":
                return row | {"idempotent": True}
            if row["status"] not in {"applied", "undo_conflict"}:
                raise ValueError("Only an applied write can be undone")
            data = row["data"]
            current = vault.read_bytes(data["target"])
            before = _unpacked(data["before_snapshot"])
            if digest(current) != data["after_hash"]:
                return {"id": write_id, "status": "conflict", "requires_review": True, "target": data["target"],
                        "error": "Note has subsequent edits; no files were changed", "before": _text(current),
                        "after": _text(before), "diff": _diff(_text(current), _text(before), data["target"])}
            proposal = self.store.proposal(row["proposal_id"])
            data["undo_feedback_id"] = uid()
            data["undo_feedback"] = self._feedback(proposal, data.get("final") or data["feedback"]["final"], action="undo", reason="Human undid an applied write", result="undone", write_id=write_id)
            self.store.execute("UPDATE writes SET status='undo_prepared',data=? WHERE id=?", (encode(data), write_id))
            row["data"] = data
            if data["created_note"]:
                vault.delete_created(data["target"], data["after_hash"])
            else:
                vault.write(data["target"], before, data["after_hash"])
            self._finalize_undo(row)
            return self.store.query("SELECT * FROM writes WHERE id=?", (write_id,))[0]

    def get_project_context(self, project_id: str, query="") -> dict:
        project = self.store.project(project_id)
        pending = [p for p in self.store.proposal_list(project_id) if p["status"] in {"pending", "deferred", "conflict"}]
        return {"project": project, "pending_count": len(pending), "pending": pending[:8],
                "notes": self.search(project_id, query) if query else []}

    def search(self, project_id: str, query: str, limit=8) -> list[dict]:
        return self._vault(project_id).search(query, limit)

    def status(self, proposal_id: str) -> dict:
        return {"proposal": self.store.proposal(proposal_id),
                "writes": self.store.query("SELECT * FROM writes WHERE proposal_id=? ORDER BY created_at", (proposal_id,))}
