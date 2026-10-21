"""Application orchestration shared by HTTP, MCP and CLI."""

from .models import Submission
from .store import Store, encode


class Controller:
    def __init__(self, store: Store):
        from .learning import Learning
        from .service import Service

        self.store = store
        self.service = Service(store)
        self.learning = Learning(store)

    def submit(self, submission: Submission) -> list[dict]:
        proposals = self.service.submit(submission)
        for proposal in proposals:
            if proposal["status"] != "pending":
                continue
            self.learning.record_prediction(proposal["id"])
            proposal = self.store.proposal(proposal["id"])
            verdict = self.learning.can_automate(submission.project_id, proposal)
            if isinstance(verdict, dict) and verdict.get("allowed"):
                try:
                    self.service.execute_authorized(proposal["id"], verdict["policy_id"])
                except (ValueError, PermissionError, OSError):
                    # A denied scope or conflict remains visible in the human queue.
                    pass
        return [self.store.proposal(p["id"]) for p in proposals]

    def review(self, proposal_id, review):
        return self.service.review(proposal_id, review, actor="human")

    async def extract(self, event_id):
        from .capture import extract_event, mark_submitted

        result = await extract_event(self.store, event_id)
        if result.get("status") == "extracted":
            proposals = self.submit(Submission(
                project_id=result["project_id"], session_id=result["session_id"], candidates=result["candidates"]
            )) if result.get("candidates") else []
            mark_submitted(self.store, event_id, [p["id"] for p in proposals])
            result["proposals"] = proposals
            result["status"] = "submitted"
        return result

    async def process_queue(self):
        if not self.store.meta("model_settings", {}).get("enabled"):
            return []
        rows = self.store.query(
            "SELECT id FROM events WHERE status IN ('queued','extracted','needs_agent','extracting') ORDER BY created_at LIMIT 5")
        results = []
        for row in rows:
            try:
                results.append(await self.extract(row["id"]))
            except (ValueError, PermissionError, OSError) as error:
                self.store.set_meta("worker_error", {"event_id": row["id"], "type": type(error).__name__})
                records = self.store.query("SELECT data FROM events WHERE id=?", (row["id"],))
                if records:
                    data = records[0]["data"] | {"last_error": "提案规划失败，请检查目标路径、关联链接或文件访问权限。"}
                    self.store.execute("UPDATE events SET status='planning_error',data=? WHERE id=?",
                                       (encode(data), row["id"]))
        return results
