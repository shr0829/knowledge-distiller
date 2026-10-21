from __future__ import annotations

import pytest

from library_companion.learning import Learning, error_upper
from library_companion.models import ProjectInput
from library_companion.service import Service
from library_companion.store import Store, encode, now, uid


@pytest.fixture
def learner(tmp_path):
    root, vault = tmp_path / "project", tmp_path / "vault"
    root.mkdir()
    vault.mkdir()
    store = Store(tmp_path / "state")
    project = Service(store).create_project(ProjectInput(name="Learning", root=str(root), vault=str(vault),
                                                        min_samples=20, min_sessions=3, max_error=.2))
    return Learning(store), project


def session_ids(partition, count, prefix="session"):
    result, index = [], 0
    while len(result) < count:
        session = f"{prefix}-{index}"
        if Learning.partition(session) == partition:
            result.append(session)
        index += 1
    return result


def proposal(learning, project, session, **changes):
    value = {"title": "Durable", "content": "A confirmed conclusion.", "source": "Exact source quotation.",
             "kind": "knowledge", "target": "Library/Durable.md", "tags": [], "links": [],
             "recommended_action": "save", "uncertain": False, "risk_flags": [], "synthetic": False, **changes}
    identifier = uid()
    learning.store.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)",
                           (identifier, project["id"], session, uid(), "pending", 1, now(), encode(value)))
    return learning.store.proposal(identifier)


def feedback(learning, item, *, action="save", actor="human", synthetic=False, result=None, **edits):
    data = {"actor": actor, "synthetic": synthetic, "original": item,
            "final": {key: item.get(key) for key in ("title", "content", "target", "tags", "links")} | edits,
            "action": action, "result": result or ("discarded" if action == "discard" else "applied"),
            "reason": "Human review", "created_at": now()}
    identifier = uid()
    learning.store.execute("INSERT INTO feedback VALUES(?,?,?,?,?,?)",
                           (identifier, item["id"], item["project_id"], item["session_id"], now(), encode(data)))
    return learning.store.query("SELECT * FROM feedback WHERE id=?", (identifier,))[0]


def prepared_policy(learning, project):
    for session in session_ids("train", 5):
        feedback(learning, proposal(learning, project, session))
    for session in session_ids("holdout", 20):
        feedback(learning, proposal(learning, project, session))
    return learning.learn(project["id"])


def prospective(learning, project, count=20):
    rows = []
    for session in session_ids("holdout", count, prefix="prospective"):
        item = proposal(learning, project, session)
        learning.record_prediction(item["id"])
        rows.append(feedback(learning, learning.store.proposal(item["id"])))
    return rows


def test_wilson_uses_independent_sessions_and_no_data_is_not_success():
    assert error_upper(0, 0) == 1
    assert error_upper(0, 5) > .2
    assert error_upper(0, 300) < .01
    assert error_upper(1, 20) > error_upper(0, 20)


def test_only_human_successful_real_feedback_enters_training(learner):
    learning, project = learner
    for index, changes in enumerate([
        {"actor": "policy"}, {"synthetic": True}, {"action": "defer"}, {"result": "failed"}, {}
    ]):
        feedback(learning, proposal(learning, project, f"sample-{index}"), **changes)
    policy = learning.learn(project["id"])
    assert policy["feedback_count"] == 1
    assert policy["status"] == "shadow"
    with pytest.raises(ValueError, match="No scope"):
        learning.activate(policy["id"])
    assert learning.status(project["id"])["authorization_scopes"] == []


def test_learned_correction_improves_recommendation_and_holdout_stays_separate(learner):
    learning, project = learner
    training_session = session_ids("train", 1)[0]
    held_session = session_ids("holdout", 1)[0]
    original = proposal(learning, project, training_session)
    feedback(learning, original, content="Human corrected the condition.", target="Library/Correct.md")
    held = proposal(learning, project, held_session)
    held_feedback = feedback(learning, held, content="A distinct held-out correction.")
    policy = learning.learn(project["id"])
    prediction = learning.recommend(project["id"], original)
    assert prediction["content"] == "Human corrected the condition."
    assert prediction["target"] == "Library/Correct.md"
    assert held_feedback["id"] not in policy["train_ids"]
    assert not set(policy["train_sessions"]) & set(policy["holdout_sessions"])
    assert policy["evaluation"]["holdout"]["agreement"] == 0
    assert Learning.partition(held_session) == "holdout"


def test_many_rows_same_session_cannot_pass_confidence_gate(learner):
    learning, project = learner
    for session in session_ids("train", 3):
        feedback(learning, proposal(learning, project, session))
    for _ in range(100):
        feedback(learning, proposal(learning, project, session_ids("holdout", 1)[0]))
    policy = learning.learn(project["id"])
    learning.authorize(project["id"], "knowledge", "save", True)
    assert policy["evaluation"]["holdout"]["sessions"] == 1
    assert policy["evaluation"]["holdout"]["error_upper_95"] > .2
    with pytest.raises(ValueError, match="No scope"):
        learning.activate(policy["id"])


def test_promotion_requires_separate_authorization_and_prospective_shadow(learner):
    learning, project = learner
    policy = prepared_policy(learning, project)
    assert policy["evaluation"]["holdout"]["passed"]
    learning.authorize(project["id"], "knowledge", "save", True)
    with pytest.raises(ValueError, match="No scope"):
        learning.activate(policy["id"])
    prospective(learning, project)
    learning.authorize(project["id"], "knowledge", "save", False)
    with pytest.raises(ValueError, match="No scope"):
        learning.activate(policy["id"])
    learning.authorize(project["id"], "knowledge", "save", True)
    active = learning.activate(policy["id"])
    assert active["status"] == "active"
    assert active["activated_scopes"] == ["knowledge:save"]
    item = proposal(learning, project, "fresh-execution")
    assert learning.can_automate(project["id"], item)["allowed"] is True
    learning.authorize(project["id"], "knowledge", "save", False)
    assert learning.can_automate(project["id"], item)["allowed"] is False
    with pytest.raises(ValueError, match="discard"):
        learning.authorize(project["id"], "knowledge", "discard", True)


def test_on_feedback_auto_promotes_gated_policy_then_correction_downgrades(learner):
    learning, project = learner
    policy = prepared_policy(learning, project)
    learning.authorize(project["id"], "knowledge", "save", True)
    rows = prospective(learning, project)
    processed = learning.on_feedback(project["id"], rows[-1])
    assert processed["promoted_policy_id"] == policy["id"]
    assert learning._policy(policy["id"])["status"] == "active"
    item = proposal(learning, project, "human-correction")
    learning.record_prediction(item["id"])
    corrected = feedback(learning, learning.store.proposal(item["id"]), content="Important missing condition.")
    assert learning.on_feedback(project["id"], corrected)["corrected"]
    assert learning._policy(policy["id"])["status"] == "downgraded"
    assert learning.status(project["id"])["authorization_scopes"][0]["enabled"] == 1
    assert learning.on_feedback(project["id"], corrected)["duplicate"]


def test_undo_removes_acceptance_and_config_change_denies_execution(learner):
    learning, project = learner
    policy = prepared_policy(learning, project)
    prospective(learning, project)
    learning.authorize(project["id"], "knowledge", "save", True)
    learning.activate(policy["id"])
    item = proposal(learning, project, "post-activation")
    assert learning.can_automate(project["id"], item)["allowed"]
    learning.store.set_meta("model_settings", {"enabled": True, "model": "changed"})
    assert not learning.can_automate(project["id"], item)["allowed"]
    feedback(learning, item)
    count = len(learning._examples(project["id"]))
    undone = feedback(learning, item, action="undo", result="undone")
    learning.on_feedback(project["id"], undone)
    assert len(learning._examples(project["id"])) == count - 1


def test_startup_replay_applies_missed_correction_before_claiming_processed(learner):
    learning, project = learner
    policy = prepared_policy(learning, project)
    prospective(learning, project)
    learning.authorize(project["id"], "knowledge", "save", True)
    learning.activate(policy["id"])
    # Mark old callbacks handled before simulating a service stop between the
    # persisted correction and its learning callback.
    learning.reconcile_feedback(project["id"])
    active = next((p for p in learning.policies(project["id"]) if p["status"] == "active"), None)
    assert active is not None
    item = proposal(learning, project, "interrupted-callback")
    learning.record_prediction(item["id"])
    feedback(learning, learning.store.proposal(item["id"]), action="undo", result="undone")
    restarted = Learning(Store(learning.store.home))
    assert restarted.reconcile_feedback(project["id"])["reconciled"] == 1
    assert not any(p["status"] == "active" for p in restarted.policies(project["id"]))
    assert restarted.reconcile_feedback(project["id"])["reconciled"] == 0


@pytest.mark.asyncio
async def test_optimizer_requires_explicit_learning_consent_and_cannot_publish(learner):
    learning, project = learner
    prepared_policy(learning, project)

    class Optimizer:
        async def optimize(self, prompt, examples):
            assert "Human review" in examples
            return "Require each extracted conclusion to retain its conditions and exact evidence."

    with pytest.raises(ValueError, match="explicitly enabled"):
        await learning.optimize_prompt(project["id"], Optimizer())
    learning.store.set_meta("model_settings", {"enabled": True, "learning_enabled": True, "model": "external-test"})
    candidate = await learning.optimize_prompt(project["id"], Optimizer())
    assert candidate["model_evaluation_required"] is True
    assert candidate["prompt_diff"]["before"] != candidate["prompt_diff"]["after"]
    learning.authorize(project["id"], "knowledge", "save", True)
    with pytest.raises(ValueError, match="generated-content"):
        learning.activate(candidate["id"])
