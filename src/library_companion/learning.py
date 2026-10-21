"""Human-example policies, held-out evaluation, and separate execution grants.

The learner can only change recommendations.  A policy never changes filesystem
permissions or grants itself execution rights.  Confidence is computed over
sessions (one error makes the entire session an error), not correlated rows.
"""

from __future__ import annotations

import hashlib
import math
from collections import defaultdict

from .store import Store, encode, now, uid
from .vault import similarity

KINDS = {"knowledge", "decision", "experience", "preference", "task", "hypothesis"}
ACTIONS = {"save", "update", "discard"}
FIELDS = ("title", "content", "target", "tags", "links")


def error_upper(errors: int, sessions: int) -> float:
    """One-sided 95% Wilson upper error bound; no data means no assurance."""
    if sessions <= 0:
        return 1.0
    z = 1.6448536269514722
    p = errors / sessions
    return (p + z*z / (2*sessions) + z*math.sqrt(p*(1-p)/sessions + z*z/(4*sessions*sessions))) / (1+z*z/sessions)


def _hash(value) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def _flat(row: dict) -> dict:
    return {**{k: v for k, v in row.items() if k != "data"}, **row.get("data", {})}


def _decision(candidate: dict, action=None) -> dict:
    return {key: candidate.get(key, [] if key in {"tags", "links"} else None) for key in FIELDS} | {
        "action": action or candidate.get("action") or candidate.get("recommended_action", "save")
    }


def _matches(prediction: dict, example: dict) -> bool:
    final = _decision(example.get("final", {}), example.get("action"))
    # Discard decisions do not write title/body/target; all write dimensions count.
    return prediction["action"] == final["action"] and (
        final["action"] == "discard" or all(prediction.get(k) == final.get(k) for k in FIELDS)
    )


class Learning:
    def __init__(self, store: Store):
        self.store = store
        with store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS authorization_scopes(
                    project_id TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
                    enabled INTEGER NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(project_id,kind,action));
                CREATE TABLE IF NOT EXISTS shadow_predictions(
                    proposal_id TEXT NOT NULL, policy_id TEXT NOT NULL,
                    project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(proposal_id,policy_id));
                CREATE TABLE IF NOT EXISTS learning_observations(
                    fingerprint TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL);
            """)

    def policies(self, project_id=None) -> list[dict]:
        return [_flat(r) for r in self.store.query(
            "SELECT * FROM policies WHERE (? IS NULL OR project_id=?) ORDER BY created_at DESC",
            (project_id, project_id))]

    def _policy(self, policy_id: str) -> dict:
        rows = self.store.query("SELECT * FROM policies WHERE id=?", (policy_id,))
        if not rows:
            raise ValueError("Policy does not exist")
        return _flat(rows[0])

    def _fingerprint(self, project: dict) -> str:
        settings = self.store.meta("model_settings", {})
        return _hash({"project": {k: project.get(k) for k in (
            "root", "vault", "writable_dirs", "excluded_dirs", "min_samples", "min_sessions", "max_error")},
            "model": {k: settings.get(k) for k in ("enabled", "endpoint", "model", "learning_enabled")},
            "algorithm": "human-cases-v1"})

    def _examples(self, project_id: str) -> list[dict]:
        # Undo removes the earlier acceptance from both training and evaluation.
        rows = [_flat(r) for r in self.store.query(
            "SELECT * FROM feedback WHERE project_id=? ORDER BY created_at,id", (project_id,))]
        undone = {r.get("proposal_id", r.get("original", {}).get("id")) for r in rows if r.get("action") == "undo"}
        result, seen = [], set()
        for row in reversed(rows):
            original = row.get("original", {})
            proposal_id = row.get("proposal_id", original.get("id"))
            if proposal_id in seen or proposal_id in undone:
                continue
            if row.get("actor") != "human" or row.get("synthetic") or original.get("synthetic"):
                continue
            if row.get("action") not in ACTIONS or row.get("result") not in {"applied", "discarded"}:
                continue
            if not original.get("source") or not row.get("session_id", original.get("session_id")):
                continue
            seen.add(proposal_id)
            row["session_id"] = row.get("session_id", original.get("session_id"))
            result.append(row)
        return list(reversed(result))

    @staticmethod
    def partition(session_id: str) -> str:
        # Stable across policy versions: held-out sessions can never become training.
        return "holdout" if int(hashlib.sha256(session_id.encode()).hexdigest(), 16) % 4 == 0 else "train"

    def _predict(self, policy: dict, candidate: dict, default_action="save") -> dict:
        prediction = _decision(candidate, candidate.get("recommended_action", default_action))
        kind = candidate.get("kind", "knowledge")
        evidence = "baseline"
        cases = [c for c in policy.get("examples", []) if c["kind"] == kind]
        exact = [c for c in cases if c["original"]["title"] == candidate.get("title")
                 and c["original"]["content"] == candidate.get("content")]
        if exact:
            decisions = {_hash(c["final"]) for c in exact}
            if len(decisions) == 1:
                prediction = dict(exact[-1]["final"])
                evidence = "exact_human_correction"
        else:
            neighbors = [c for c in cases if similarity(
                c["original"]["title"] + " " + c["original"]["content"],
                candidate.get("title", "") + " " + candidate.get("content", "")) >= .65]
            if len(neighbors) >= 3 and len({c["session_id"] for c in neighbors}) >= 2:
                actions = {c["final"]["action"] for c in neighbors}
                if len(actions) == 1:
                    prediction["action"] = actions.pop()
                    evidence = "similar_human_examples"
            rule = policy.get("rules", {}).get(kind)
            if evidence == "baseline" and rule and prediction["action"] == rule["action"]:
                evidence = "confirmed_kind_rule"
        return {**prediction, "kind": kind, "policy_id": policy["id"],
                "policy_version": policy.get("version", 1), "evidence": evidence,
                "created_at": now(), "reason": "依据本项目真实人工案例；新内容与修改仍接受完整维度评测。"}

    def recommend(self, project_id: str, candidate: dict, default_action="save") -> dict:
        policies = [p for p in self.policies(project_id) if p["status"] in {"shadow", "active"}]
        if not policies:
            return {**_decision(candidate, candidate.get("recommended_action", default_action)),
                    "kind": candidate.get("kind", "knowledge"), "policy_id": None,
                    "policy_version": "assisted-v1", "evidence": "baseline", "reason": "尚无通过验证的人工案例策略。"}
        active = next((p for p in policies if p["status"] == "active"), policies[0])
        return self._predict(active, candidate, default_action)

    def _metrics(self, items: list[tuple[dict, dict]], project: dict) -> dict:
        by_session = defaultdict(list)
        dimensions = {field: 0 for field in ("action", *FIELDS)}
        for prediction, row in items:
            by_session[row["session_id"]].append(_matches(prediction, row))
            final = _decision(row["final"], row["action"])
            for field in dimensions:
                dimensions[field] += int(prediction.get(field) == final.get(field))
        errors = sum(not all(values) for values in by_session.values())
        bound = error_upper(errors, len(by_session))
        blockers = []
        if len(items) < project.get("min_samples", 50):
            blockers.append("真实人工样本不足")
        if len(by_session) < project.get("min_sessions", 5):
            blockers.append("独立会话不足")
        if bound > project.get("max_error", .05):
            blockers.append("会话级单侧 95% 错误上界高于项目风险阈值")
        return {"samples": len(items), "sessions": len(by_session), "session_errors": errors,
                "error_upper_95": bound, "agreement": sum(_matches(p, r) for p, r in items) / len(items) if items else None,
                "dimensions": {k: v / len(items) if items else None for k, v in dimensions.items()},
                "passed": not blockers, "blockers": blockers}

    def _evaluate(self, policy: dict, examples: list[dict] | None = None) -> dict:
        project = self.store.project(policy["project_id"])
        examples = self._examples(project["id"]) if examples is None else examples
        frozen = set(policy["holdout_ids"])
        holdout = [r for r in examples if r["id"] in frozen]
        training_sessions = set(policy["train_sessions"])
        evaluation_sessions = set(policy["holdout_sessions"])
        predictions = self.store.query("SELECT * FROM shadow_predictions WHERE policy_id=?", (policy["id"],))
        by_proposal = {r["proposal_id"]: r for r in predictions}
        shadow = []
        for row in examples:
            prior = by_proposal.get(row.get("proposal_id", row.get("original", {}).get("id")))
            if not prior or row["session_id"] in training_sessions | evaluation_sessions:
                continue
            if prior["created_at"] >= row["created_at"]:
                continue
            if prior["data"].get("revision") != row.get("original", {}).get("revision"):
                continue
            shadow.append((prior["data"]["prediction"], row))
        scopes = {}
        held_predictions = [(self._predict(policy, row["original"]), row) for row in holdout]
        for kind in sorted(KINDS):
            for action in sorted(ACTIONS):
                pairs = [(p, r) for p, r in held_predictions if p["kind"] == kind and p["action"] == action]
                selected = [r for p, r in pairs]
                held = self._metrics(pairs, project)
                live = self._metrics([(p, r) for p, r in shadow if p["kind"] == kind and p["action"] == action], project)
                if selected or live["samples"] or kind in policy["rules"]:
                    blockers = list(dict.fromkeys(held["blockers"] + live["blockers"]))
                    baseline = self._metrics([(_decision(r["original"]), r) for r in selected], project)
                    if held["session_errors"] > baseline["session_errors"]:
                        blockers.append("候选策略在留出会话上的错误多于原始建议")
                    if policy.get("model_evaluation_required"):
                        blockers.append("模型提示词修改尚无独立生成质量评测，禁止自动发布")
                    if action == "discard":
                        blockers.append("尚未独立评测被过滤内容召回率，禁止自动丢弃")
                    scopes[f"{kind}:{action}"] = {"holdout": held, "shadow": live, "baseline": baseline,
                                                  "passed": not blockers, "blockers": blockers}
        return {"scopes": scopes, "holdout": self._metrics(held_predictions, project),
            "shadow": self._metrics(shadow, project), "filtered_recall": None,
            "independence": "Training, frozen holdout, and prospective shadow use disjoint sessions."}

    def learn(self, project_id: str, use_model=False) -> dict:
        if use_model:
            raise ValueError("Use optimize_prompt for the explicitly configured optional LangMem adapter")
        project = self.store.project(project_id)
        examples = [] if project.get("synthetic") else self._examples(project_id)
        train = [r for r in examples if self.partition(r["session_id"]) == "train"]
        held = [r for r in examples if self.partition(r["session_id"]) == "holdout"]
        versions = self.policies(project_id)
        data_hash = _hash([r["id"] for r in examples])
        if (versions and versions[0].get("data_hash") == data_hash
                and versions[0].get("config_fingerprint") == self._fingerprint(project)):
            return versions[0]
        rules = {}
        cases = []
        for row in train[-1000:]:
            original = row["original"]
            cases.append({"feedback_id": row["id"], "session_id": row["session_id"],
                          "kind": original.get("kind", "knowledge"), "original": _decision(original),
                          "final": _decision(row["final"], row["action"]), "reason": row.get("reason", "")[:1000]})
        for kind in KINDS:
            chosen = [r for r in cases if r["kind"] == kind]
            if len(chosen) >= 3 and len({r["session_id"] for r in chosen}) >= 2:
                actions = {r["final"]["action"] for r in chosen}
                if len(actions) == 1:
                    action = actions.pop()
                    rules[kind] = {"action": action, "samples": len(chosen),
                                   "text": f"本项目 {kind} 类的 {len(chosen)} 个人工案例一致选择 {action}；正文、目标与链接须保持评测。"}
        policy_id = uid()
        data = {"version": max([p.get("version", 0) for p in versions], default=0)+1,
                "parent_id": versions[0]["id"] if versions else None, "rules": rules, "examples": cases,
                "train_ids": [r["id"] for r in train], "holdout_ids": [r["id"] for r in held],
                "train_sessions": sorted({r["session_id"] for r in train}),
                "holdout_sessions": sorted({r["session_id"] for r in held}),
                "data_hash": data_hash, "config_fingerprint": self._fingerprint(project),
                "training_samples": len(train), "feedback_count": len(examples), "algorithm": "human-cases-v1",
                "prompt": "提炼有来源的长期知识，保留不确定性，参考本项目人工规则与案例；不改变授权。",
                "limitations": ["被过滤内容召回率尚无独立标注，因此不自动丢弃。", "新策略必须积累独立前瞻影子样本。"]}
        policy = {"id": policy_id, "project_id": project_id, **data}
        data["evaluation"] = self._evaluate(policy, examples)
        data["metrics"] = data["evaluation"]["holdout"]
        self.store.execute("INSERT INTO policies VALUES(?,?,?,?,?)", (policy_id, project_id, "shadow", now(), encode(data)))
        return self._policy(policy_id)

    def record_prediction(self, proposal_id: str) -> dict:
        proposal = self.store.proposal(proposal_id)
        # Record all shadow versions, including a newer challenger while active is retained.
        for policy in self.policies(proposal["project_id"]):
            if policy["status"] not in {"shadow", "active"}:
                continue
            prediction = self._predict(policy, proposal)
            self.store.execute("INSERT OR IGNORE INTO shadow_predictions VALUES(?,?,?,?,?,?)",
                               (proposal_id, policy["id"], proposal["project_id"], proposal["session_id"], now(),
                                encode({"revision": proposal["revision"], "prediction": prediction})))
        chosen = self.recommend(proposal["project_id"], proposal)
        rows = self.store.query("SELECT data FROM proposals WHERE id=?", (proposal_id,))
        data = rows[0]["data"]
        data["policy_prediction"] = chosen
        if chosen["policy_id"]:
            data["policy_id"] = chosen["policy_id"]
            data["policy_version"] = chosen["policy_version"]
        self.store.execute("UPDATE proposals SET data=? WHERE id=? AND revision=?", (encode(data), proposal_id, proposal["revision"]))
        return chosen

    def authorize(self, project_id: str, kind: str, action: str, enabled: bool) -> dict:
        project = self.store.project(project_id)
        if kind not in KINDS or action not in ACTIONS:
            raise ValueError("Unknown authorization scope")
        if action == "discard" and enabled:
            raise ValueError("Automatic discard is blocked until filtered-content recall is independently evaluated")
        data = {"writable_dirs": project["writable_dirs"], "vault": project["vault"], "actor": "human",
                "scope_fingerprint": self._fingerprint(project)}
        self.store.execute("INSERT OR REPLACE INTO authorization_scopes VALUES(?,?,?,?,?,?)",
                           (project_id, kind, action, int(enabled), now(), encode(data)))
        return {"project_id": project_id, "kind": kind, "action": action, "enabled": bool(enabled), **data}

    def _authorized(self, project: dict, kind: str, action: str) -> bool:
        rows = self.store.query("SELECT * FROM authorization_scopes WHERE project_id=? AND kind=? AND action=?",
                                (project["id"], kind, action))
        return bool(rows and rows[0]["enabled"] and rows[0]["data"].get("scope_fingerprint") == self._fingerprint(project))

    def activate(self, policy_id: str) -> dict:
        policy = self._policy(policy_id)
        project = self.store.project(policy["project_id"])
        if policy["status"] in {"rolled_back", "downgraded"}:
            raise ValueError("A withdrawn policy cannot be reactivated; learn and validate a new version")
        if policy.get("model_evaluation_required"):
            raise ValueError("Changed model prompts require independent generated-content evaluation before activation")
        if project.get("synthetic") or policy["config_fingerprint"] != self._fingerprint(project):
            raise ValueError("Policy configuration changed or project is synthetic; reevaluation is required")
        report = self._evaluate(policy)
        active = next((p for p in self.policies(project["id"]) if p["status"] == "active" and p["id"] != policy_id), None)
        if active:
            heldout = [r for r in self._examples(project["id"]) if r["id"] in set(policy["holdout_ids"])]
            previous_errors = sum(not _matches(self._predict(active, r["original"]), r) for r in heldout)
            candidate_errors = sum(not _matches(self._predict(policy, r["original"]), r) for r in heldout)
            if candidate_errors > previous_errors:
                raise ValueError("Candidate policy regresses against the active version on the same independent holdout")
        allowed = [scope for scope, value in report["scopes"].items() if value["passed"]
                   and self._authorized(project, *scope.split(":"))]
        if not allowed:
            raise ValueError("No scope has explicit authorization and passing independent holdout + prospective shadow evaluation")
        data = {k: v for k, v in policy.items() if k not in {"id", "project_id", "status", "created_at"}}
        data.update(evaluation=report, activated_scopes=allowed, activated_at=now())
        with self.store.connection() as db:
            db.execute("UPDATE policies SET status='superseded' WHERE project_id=? AND status='active'", (project["id"],))
            db.execute("UPDATE policies SET status='active',data=? WHERE id=?", (encode(data), policy_id))
        return self._policy(policy_id)

    def rollback(self, policy_id: str) -> dict:
        policy = self._policy(policy_id)
        data = {k: v for k, v in policy.items() if k not in {"id", "project_id", "status", "created_at"}}
        data["withdrawn_at"] = now()
        self.store.execute("UPDATE policies SET status='rolled_back',data=? WHERE id=?", (encode(data), policy_id))
        return self._policy(policy_id)

    def can_automate(self, project_id: str, proposal: dict) -> dict:
        project = self.store.project(project_id)
        active = next((p for p in self.policies(project_id) if p["status"] == "active"), None)
        denied = {"allowed": False, "policy_id": active["id"] if active else None}
        if not active or proposal.get("project_id") != project_id:
            return {**denied, "reason": "尚无已发布且匹配项目的策略"}
        if active.get("model_evaluation_required"):
            return {**denied, "reason": "模型提示词缺少独立生成质量评测"}
        prediction = self._predict(active, proposal)
        action, kind = prediction["action"], prediction["kind"]
        if action not in {"save", "update"} or proposal.get("synthetic") or project.get("synthetic"):
            return {**denied, "reason": "自动丢弃与演示数据执行被禁用"}
        if active["config_fingerprint"] != self._fingerprint(project) or not self._authorized(project, kind, action):
            return {**denied, "reason": "执行授权缺失、已撤回或配置已改变"}
        if f"{kind}:{action}" not in active.get("activated_scopes", []):
            return {**denied, "reason": "当前策略尚未发布此内容类型与操作的执行范围"}
        if proposal.get("uncertain") or proposal.get("risk_flags") or not proposal.get("source"):
            return {**denied, "reason": "不确定内容、风险标记或缺失来源需要人工审核"}
        if prediction["evidence"] == "baseline" or _decision(proposal) != {k: prediction[k] for k in ("action", *FIELDS)}:
            return {**denied, "reason": "策略改变了待写入内容或缺少人工案例支持，需要重新预览"}
        report = self._evaluate(active)
        scope = report["scopes"].get(f"{kind}:{action}", {})
        if not scope.get("passed"):
            return {**denied, "reason": "此内容类型与操作尚未通过独立质量门槛"}
        return {"allowed": True, "policy_id": active["id"], "policy_version": active["version"],
                "reason": "独立评测通过且命中明确人工授权范围", "prediction": prediction}

    def on_feedback(self, project_id: str, feedback: dict) -> dict:
        value = _flat(feedback)
        if value.get("actor") != "human" or value.get("synthetic"):
            return {"processed": False}
        fingerprint = _hash([project_id, value.get("original", {}).get("id"), value.get("action"),
                             value.get("created_at"), value.get("final")])
        original = value.get("original", {})
        prediction = original.get("policy_prediction") or _decision(original)
        corrected = value.get("action") == "undo" or not _matches(prediction, value)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            inserted = db.execute("INSERT OR IGNORE INTO learning_observations VALUES(?,?,?)",
                                  (fingerprint, project_id, now())).rowcount
            if not inserted:
                return {"processed": False, "duplicate": True}
            if corrected:
                # The durable processed marker and safety downgrade commit
                # together, including replay after an interrupted callback.
                db.execute("UPDATE policies SET status='downgraded' WHERE project_id=? AND status='active'", (project_id,))
        promoted = None
        # Explicit scope grants authorize gradual publication only after all
        # quality gates pass. A correction never triggers immediate replacement.
        if not corrected:
            active = next((p for p in self.policies(project_id) if p["status"] == "active"), None)
            for candidate in self.policies(project_id):
                if candidate["status"] != "shadow" or candidate.get("model_evaluation_required"):
                    continue
                if active and candidate["version"] <= active["version"]:
                    continue
                try:
                    promoted = self.activate(candidate["id"])["id"]
                    break
                except ValueError:
                    continue
        examples = self._examples(project_id)
        policies = self.policies(project_id)
        previous_count = policies[0].get("feedback_count", 0) if policies else 0
        created = None
        if len(examples) >= 6 and len(examples) - previous_count >= 10:
            created = self.learn(project_id)["id"]
        return {"processed": True, "corrected": corrected, "new_policy_id": created, "promoted_policy_id": promoted}

    def reconcile_feedback(self, project_id=None) -> dict:
        """Replay persisted human decisions after a stopped review callback."""
        rows = self.store.query(
            "SELECT * FROM feedback WHERE (? IS NULL OR project_id=?) ORDER BY created_at,id",
            (project_id, project_id))
        results = [self.on_feedback(row["project_id"], row) for row in rows]
        return {"inspected": len(rows), "reconciled": sum(bool(r.get("processed")) for r in results)}

    def status(self, project_id: str) -> dict:
        project = self.store.project(project_id)
        policies = self.policies(project_id)
        examples = self._examples(project_id)
        scopes = [_flat(r) for r in self.store.query("SELECT * FROM authorization_scopes WHERE project_id=?", (project_id,))]
        current = next((p for p in policies if p["status"] == "active"), policies[0] if policies else None)
        return {"project_id": project_id, "mode": "AUTO_LIMITED" if current and current["status"] == "active" else "SHADOW" if current and current["status"] == "shadow" else "ASSISTED",
                "policies": policies, "authorization_scopes": scopes, "human_samples": len(examples),
                "human_sessions": len({example["session_id"] for example in examples}),
                "evaluation": self._evaluate(current) if current else None,
                "max_error": project.get("max_error", .05), "automatic_discard_enabled": False}

    async def optimize_prompt(self, project_id: str, adapter=None) -> dict:
        """Optional LangMem suggestion; never activation or authorization.

        The adapter is injectable for offline tests. A changed extraction prompt
        starts a new shadow version and cannot reuse an old policy's proof.
        """
        from .capture import configured_model, redact

        settings = self.store.meta("model_settings", {})
        if not settings.get("enabled") or not settings.get("learning_enabled"):
            raise ValueError("Model access and learning must both be explicitly enabled")
        policy = self.learn(project_id)
        training = [{"original": c["original"], "final": c["final"], "feedback": c["reason"]}
                    for c in policy["examples"][-20:]]
        if not training:
            raise ValueError("No genuine human training examples")
        model = adapter or configured_model(self.store, learning=True)
        if adapter:
            prompt = await adapter.optimize(policy["prompt"], redact(encode(training)))
        else:
            prompt = await model.optimize(policy["prompt"], redact(encode(training)))
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= 8000:
            raise ValueError("Optimizer returned an invalid prompt")
        data = {k: v for k, v in policy.items() if k not in {"id", "project_id", "status", "created_at"}}
        new_id = uid()
        data.update(parent_id=policy["id"], version=max(p["version"] for p in self.policies(project_id))+1,
                    prompt=prompt, algorithm="langmem-prompt-shadow", model_evaluation_required=True,
                    train_ids=policy["train_ids"], holdout_ids=[], holdout_sessions=[],
                    prompt_diff={"before": policy["prompt"], "after": prompt}, activated_scopes=[])
        candidate = {"id": new_id, "project_id": project_id, **data}
        data["evaluation"] = self._evaluate(candidate)
        self.store.execute("INSERT INTO policies VALUES(?,?,?,?,?)", (new_id, project_id, "shadow", now(), encode(data)))
        return self._policy(new_id)
