from pathlib import Path

import pytest

from library_companion.knowledge import Knowledge
from library_companion.layers import Layers
from library_companion.models import ProjectInput, Review
from library_companion.pipeline import Pipeline, PipelineSettings
from library_companion.service import Service
from library_companion.store import Store


def _system(tmp_path):
    store = Store(tmp_path / 'state')
    service = Service(store)
    root, vault = tmp_path / 'project', tmp_path / 'vault'
    root.mkdir()
    vault.mkdir()
    project = service.create_project(ProjectInput(name='layers', root=str(root), vault=str(vault)))
    return store, project


def test_cross_source_materials_leave_raw_snapshots_unchanged(tmp_path):
    store, project = _system(tmp_path)
    knowledge = Knowledge(store)
    first = knowledge.record(project['id'], 'notes/alpha.md', 'file', 'Alpha decision is to keep the API local.')
    second = knowledge.record(project['id'], 'sessions/one.jsonl', 'conversation', 'The team agreed to keep the API local.')
    before = {sid: knowledge.source(sid) for sid in (first, second)}
    layers = Layers(store)

    job = layers.prepare(project['id'], [first, second], limit=2)
    pinned = {s['id']: s for s in layers.context(job['id'])['sources']}
    materials = layers.submit(job['id'], [{
        'title': 'Local API decision',
        'content': 'The team chose a local API and recorded the decision consistently across the project file and session.',
        'kind': 'decision',
        'citations': [
            {'source_id': first, 'quote': pinned[first]['content']},
            {'source_id': second, 'quote': pinned[second]['content']},
        ],
    }])

    material = materials[0]
    assert material['status'] == 'ready'
    assert material['scope'] == 'cross_source'
    assert {row['source_id'] for row in store.query(
        'SELECT source_id FROM extraction_evidence WHERE extraction_id=?', (material['id'],))} == {first, second}
    assert {sid: knowledge.source(sid) for sid in (first, second)} == before
    assert not store.proposal_list(project['id'])


def test_abstraction_traces_through_material_to_raw_source(tmp_path):
    store, project = _system(tmp_path)
    knowledge = Knowledge(store)
    first = knowledge.record(project['id'], 'a.md', 'file', 'Use a small local model for private drafts.')
    second = knowledge.record(project['id'], 'b.md', 'file', 'Keep private drafts on the local machine.')
    layers = Layers(store)
    job = layers.prepare(project['id'], [first, second], limit=2)
    pinned = {s['id']: s for s in layers.context(job['id'])['sources']}
    material = layers.submit(job['id'], [{
        'title': 'Private drafts stay local',
        'content': 'Private drafts should remain on the local machine.',
        'citations': [
            {'source_id': first, 'quote': pinned[first]['content']},
            {'source_id': second, 'quote': pinned[second]['content']},
        ],
    }])[0]

    abstraction_job = layers.prepare_abstraction(project['id'], [material['id']])
    abstraction = layers.submit(abstraction_job['id'], [{
        'title': 'Privacy boundary',
        'content': 'Drafting is intentionally local when the content is private.',
        'kind': 'knowledge',
        'extraction_ids': [material['id']],
    }])[0]
    assert abstraction['status'] == 'pending'
    assert abstraction['proposal_id']
    trace = layers.trace(abstraction['id'])
    assert trace['record']['extraction_ids'] == [material['id']]
    assert {source['id'] for source in trace['sources']} == {first, second}
    assert Path(project['vault']).exists()
    assert not list(Path(project['vault']).rglob('Privacy boundary.md'))
    proposal = store.proposal(abstraction['proposal_id'])
    service = Service(store)
    review = Review(revision=proposal['revision'], action=proposal['recommended_action'])
    preview = service.preview(proposal['id'], review)
    service.review(proposal['id'], review.model_copy(update={'preview_token': preview['preview_token']}))
    knowledge.record(project['id'], 'a.md', 'file', 'The original file changed later.')
    evidence = knowledge.note_evidence(project['id'], proposal['target'])
    assert evidence['evidence'][0]['layers'][0]['record']['id'] == abstraction['id']
    assert layers.abstraction(abstraction['id'])['status'] == 'applied'
    assert any(s['id'] == first and not s['active'] for s in layers.trace(abstraction['id'])['sources'])


def test_windows_resume_without_marking_an_entire_source_processed(tmp_path):
    store, project = _system(tmp_path)
    sid = Knowledge(store).record(project['id'], 'large.md', 'file', 'word ' * 8000)
    layers = Layers(store)
    first = layers.prepare(project['id'])
    assert first['windows'][0]['end_char'] < 40000
    assert layers.source_progress(project['id']) == {}
    layers.submit(first['id'], [])
    assert layers.overview(project['id'])['pending_sources'] == 1
    second = layers.prepare(project['id'])
    assert second['windows'][0]['start_char'] == first['windows'][0]['end_char']
    assert layers.submit(first['id'], []) == []
    assert layers.source_progress(project['id'])[sid] == first['windows'][0]['end_char']


def test_materials_reject_fabricated_quotes_and_foreign_ids(tmp_path):
    store, project = _system(tmp_path)
    sid = Knowledge(store).record(project['id'], 'a.md', 'file', 'Original evidence.')
    layers = Layers(store)
    job = layers.prepare(project['id'])
    for citation in ({'source_id': sid, 'quote': 'Invented evidence.'},
                     {'source_id': 'foreign', 'quote': 'Original evidence.'}):
        with pytest.raises(ValueError, match='pinned source window'):
            layers.submit(job['id'], [{'title': 'Bad', 'content': 'Claim', 'citations': [citation]}])
    assert not store.query('SELECT id FROM extractions')
    assert layers.context(job['id'])['status'] == 'needs_model'


@pytest.mark.asyncio
async def test_background_pipeline_automatically_stores_cross_source_materials(tmp_path, monkeypatch):
    import json

    store, project = _system(tmp_path)
    root = Path(project['root'])
    for name in ('a.md', 'b.md'):
        (root / name).write_text('Keep the API local.', encoding='utf-8')
    before = {path.name: path.read_bytes() for path in root.iterdir()}
    store.set_meta('model_settings', {'enabled': True})

    class Model:
        async def extract(self, text, policy_prompt=''):
            pytest.fail('Layer jobs must use their own extraction format')

        async def extract_layer(self, text, policy_prompt=''):
            payload = json.loads(text)
            assert 'never one summary per source' in policy_prompt
            assert len(payload['sources']) == 2
            return {'materials': [{'title': 'Local API', 'content': 'Both documents specify a local API.',
                                  'citations': [{'source_id': s['id'], 'quote': s['content']}
                                                for s in payload['sources']]}]}

    monkeypatch.setattr('library_companion.capture.configured_model', lambda store: Model())
    pipeline = Pipeline(store)
    pipeline.configure(project['id'], PipelineSettings(enabled=True, auto_index=False))
    await pipeline.tick()
    overview = pipeline.layers.overview(project['id'])
    assert len(overview['extractions']) == 1
    assert overview['jobs'][0]['status'] == 'completed'
    assert overview['pending_sources'] == 0
    assert not store.query('SELECT id FROM builds')
    assert not store.proposal_list()
    assert before == {path.name: path.read_bytes() for path in root.iterdir()}


def test_layer_http_routes_and_empty_result(tmp_path):
    from fastapi.testclient import TestClient

    from library_companion.api import create_app

    store, project = _system(tmp_path)
    Knowledge(store).record(project['id'], 'a.md', 'file', 'No reusable facts.')
    app = create_app(store.home)
    with TestClient(app) as client:
        session = client.get('/api/session', headers={'X-Library-Reviewer': app.state.bootstrap_token})
        headers = {'X-Library-Token': session.json()['csrf_token']}
        response = client.post(f"/api/projects/{project['id']}/extractions", json={}, headers=headers)
        assert response.status_code == 200
        job = response.json()
        assert client.get('/api/layer-jobs/' + job['id']).json()['phase'] == 'extraction'
        submitted = client.post('/api/extractions/' + job['id'] + '/submit', json={'candidates': []}, headers=headers)
        assert submitted.status_code == 200 and submitted.json() == []
        assert client.get(f"/api/projects/{project['id']}/layers").json()['processed_sources'] == 1
