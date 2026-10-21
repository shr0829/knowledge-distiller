import json

import pytest

from library_companion.knowledge import Knowledge, knowledge_dir
from library_companion.models import ProjectInput, Review
from library_companion.pipeline import Pipeline, PipelineSettings
from library_companion.retrieval import Retrieval
from library_companion.service import Service
from library_companion.store import Store


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / 'state')
    service = Service(store)
    vault = tmp_path / 'vault'
    vault.mkdir()
    projects = []
    for name in ('alpha', 'beta'):
        root = tmp_path / name
        root.mkdir()
        projects.append(service.create_project(ProjectInput(name=name, root=str(root), vault=str(vault),
                                                           writable_dirs=['Library/' + name])))
    return store, service, Knowledge(store), projects


def test_resumable_scan_and_encoding(setup, monkeypatch):
    from pathlib import Path

    import library_companion.knowledge as module
    store, _, knowledge, (a, _) = setup
    root = Path(a['root'])
    for i in range(5):
        (root / f'{i}.md').write_text(f'content {i}', encoding='utf-8')
    (root / 'utf16.txt').write_text('中文材料', encoding='utf-16')
    monkeypatch.setattr(module, 'SCAN_FILES', 2)
    first = knowledge.scan(a['id'], history=False)
    assert first['truncated'] and first['cursor']['offset'] == 2
    assert knowledge.scan(a['id'], history=False)['cursor']['offset'] == 4
    final = knowledge.scan(a['id'], history=False)
    assert not final['truncated'] and len(knowledge.sources(a['id'])) == 6
    assert any(s['content'] == '中文材料' for s in knowledge.sources(a['id']))
    assert knowledge.scan(a['id'], history=False)['unchanged_files'] == 2
    assert store.meta('scan_cursor:' + a['id'])['offset'] == 2


@pytest.mark.asyncio
async def test_compilation_requires_model_and_preserves_review(setup):
    store, _, knowledge, (a, _) = setup
    source = knowledge.record(a['id'], 'readme', 'file', 'durable evidence')
    build = knowledge.prepare(a['id'], [source])
    pipeline = Pipeline(store)
    with pytest.raises(ValueError, match='disabled'):
        await pipeline.compile(build['id'])
    class Model:
        async def extract(self, text, policy_prompt=''):
            assert source in text
            return {'candidates': [{'title': 'Decision', 'content': 'durable evidence',
                                     'source': 'durable evidence', 'source_ids': [source]}]}
    result = await pipeline.compile(build['id'], Model())
    assert result['status'] == 'submitted'
    assert store.proposal(result['proposal_ids'][0])['status'] == 'pending'
    assert knowledge.overview(a['id'])['builds'][0]['review_progress'] == {'pending': 1}
    assert not knowledge.overview(a['id'])['builds'][0]['review_complete']
    assert await pipeline.compile(build['id']) == result


@pytest.mark.asyncio
async def test_failed_build_retry_and_reserved_sources(setup):
    store, _, knowledge, (a, _) = setup
    sid = knowledge.record(a['id'], 'readme', 'file', 'durable evidence')
    build = knowledge.prepare(a['id'])
    with pytest.raises(ValueError, match='No new'):
        knowledge.prepare(a['id'])
    class Model:
        async def extract(self, *args, **kwargs):
            return {'candidates': [{'title': 'Wrong', 'content': 'wrong', 'source': 'invented', 'source_ids': [sid]}]}
    pipeline = Pipeline(store)
    failed = await pipeline.compile(build['id'], Model())
    assert failed['status'] == 'error' and failed['attempts'] == 1
    with pytest.raises(ValueError, match='explicitly retry'):
        await pipeline.compile(build['id'], Model())
    assert (await pipeline.compile(build['id'], Model(), retry=True))['attempts'] == 2
    assert not store.proposal_list()


def test_cross_project_evidence_returns_historical_snapshots(setup):
    store, service, knowledge, (a, b) = setup
    ids, paths = [], []
    for p in (a, b):
        sid = knowledge.record(p['id'], 'original', 'file', p['name'] + ' evidence')
        build = knowledge.prepare(p['id'], [sid])
        candidate = {'title': p['name'], 'content': p['name'] + ' knowledge',
                     'source': p['name'] + ' evidence', 'source_ids': [sid]}
        if paths:
            candidate['related_notes'] = [{'project_id': a['id'], 'path': paths[0]}]
        proposal = knowledge.submit(build['id'], [candidate])[0]
        review = Review(revision=proposal['revision'], action=proposal['recommended_action'])
        preview = service.preview(proposal['id'], review)
        service.review(proposal['id'], review.model_copy(update={'preview_token': preview['preview_token']}))
        paths.append(proposal['target'])
        ids.append(sid)
    knowledge.record(a['id'], 'original', 'file', 'changed evidence')
    evidence = knowledge.note_evidence(b['id'], paths[1])
    assert evidence['related'][0]['evidence'][0]['sources'][0]['id'] == ids[0]
    assert not evidence['related'][0]['evidence'][0]['sources'][0]['active']
    assert evidence['related'][0]['evidence'][0]['sources'][0]['content'] == 'alpha evidence'
    assert paths[1].startswith(knowledge_dir(b))
    assert any(e['kind'] == 'reviewed_relation' for e in knowledge.graph()['edges'])
    assert knowledge.overview(b['id'])['builds'][0]['review_complete']


def test_index_staleness_after_source_change(setup, monkeypatch):
    store, _, knowledge, (a, _) = setup
    retrieval = Retrieval(store)
    monkeypatch.setattr(retrieval, '_run', lambda *args, **kwargs: '')
    knowledge.record(a['id'], 'file', 'file', 'original')
    retrieval.index(a['id'], 'qmd')
    assert not retrieval.project_status(a['id'])['qmd']['stale']
    knowledge.record(a['id'], 'file', 'file', 'updated')
    assert retrieval.project_status(a['id'])['qmd']['stale']


def test_auto_collection_prepares_without_model(setup):
    from pathlib import Path
    store, _, knowledge, (a, _) = setup
    (Path(a['root']) / 'source.md').write_text('new source', encoding='utf-8')
    pipeline = Pipeline(store)
    pipeline.configure(a['id'], PipelineSettings(enabled=True, auto_index=False))
    result = pipeline.collect(a['id'])
    assert pipeline.layers.context(result['layer_job_id'])['status'] == 'needs_model'
    assert not store.query('SELECT id FROM builds')
    assert not store.proposal_list()
    assert json.dumps(pipeline.status(a['id']))


def test_evidence_follows_reviewed_target_and_detects_manual_edits(setup):
    from pathlib import Path
    store, service, knowledge, (a, _) = setup
    sid = knowledge.record(a['id'], 'source', 'file', 'evidence')
    build = knowledge.prepare(a['id'], [sid])
    proposal = knowledge.submit(build['id'], [{'title': 'note', 'content': 'knowledge',
                                              'source': 'evidence', 'source_ids': [sid]}])[0]
    target = knowledge_dir(a) + '/concepts/renamed.md'
    review = Review(revision=proposal['revision'], action='save', target=target)
    preview = service.preview(proposal['id'], review)
    service.review(proposal['id'], review.model_copy(update={'preview_token': preview['preview_token']}))
    assert knowledge.note_evidence(a['id'], target)['evidence'][0]['sources'][0]['id'] == sid
    (Path(a['vault']) / target).write_text('Manually changed', encoding='utf-8')
    assert knowledge.note_evidence(a['id'], target)['modified_after_review']


def test_local_ohs_discards_stored_remote_defaults(setup, monkeypatch):
    import sqlite3
    from pathlib import Path
    store, _, _, (a, _) = setup
    retrieval = Retrieval(store)
    folder = retrieval.root / a['id'] / 'knowledge'
    folder.mkdir(parents=True)
    database = folder / '.obsidian-hybrid-search.db'
    db = sqlite3.connect(database)
    db.execute('CREATE TABLE settings(key TEXT,value TEXT)')
    db.execute("INSERT INTO settings VALUES('api_base_url','https://remote.invalid')")
    db.commit()
    db.close()
    monkeypatch.setattr(retrieval, 'command', lambda engine: ['node', 'ohs.js'])
    def run(*args, **kwargs):
        assert 'OPENAI_API_KEY' not in kwargs['env']
        assert 'OPENAI_BASE_URL' not in kwargs['env']
        assert kwargs['env']['LOCAL_EMBEDDING_MODEL'] == 'Xenova/multilingual-e5-small'
        class Result:
            returncode = 0
            stdout = '{}'
        return Result()
    monkeypatch.setattr('library_companion.retrieval.subprocess.run', run)
    retrieval._run('ohs', ['status'], a['id'])
    db = sqlite3.connect(database)
    assert not db.execute('SELECT * FROM settings').fetchall()
    db.close()
    assert Path(database).exists()
