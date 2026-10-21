from pathlib import Path

import pytest

from library_companion.chunk_index import ChunkIndex
from library_companion.knowledge import Knowledge
from library_companion.models import ProjectInput
from library_companion.retrieval import Retrieval
from library_companion.search_support import ByteCache, natural_blocks
from library_companion.service import Service
from library_companion.store import Store


@pytest.fixture
def system(tmp_path):
    store = Store(tmp_path / 'state')
    root, vault = tmp_path / 'root', tmp_path / 'vault'
    root.mkdir()
    vault.mkdir()
    project = Service(store).create_project(ProjectInput(name='alpha', root=str(root), vault=str(vault)))
    return store, Knowledge(store), Retrieval(store), project


def test_recall_is_independent_of_body_budget_and_never_traverses_sources(system, monkeypatch):
    store, knowledge, retrieval, project = system
    for index in range(12):
        knowledge.record(project['id'], f'doc-{index}.md', 'file', 'Internal evidence ' + 'x' * 12000)
    monkeypatch.setattr(knowledge, 'sources', lambda *a: pytest.fail('full source traversal'))
    monkeypatch.setattr('library_companion.retrieval.project_notes', lambda *a: pytest.fail('note traversal'))
    old_meta = store.meta
    def meta(key, *args):
        assert not key.startswith('projection:')
        return old_meta(key, *args)
    monkeypatch.setattr(store, 'meta', meta)
    metadata = retrieval.search('Internal', [project['id']], 'raw', 'local', limit=8, read_limit=0)
    hydrated = retrieval.search('Internal', [project['id']], 'raw', 'local', limit=8,
                                read_limit=3, max_bytes=500, per_hit_bytes=200)
    assert [h['id'] for h in metadata['hits']] == [h['id'] for h in hydrated['hits']]
    assert all(h['content'] == '' for h in metadata['hits'])
    assert hydrated['metrics']['bodies_read'] == 3
    assert hydrated['metrics']['returned_bytes'] <= 500
    assert hydrated['metrics']['candidates'] >= 8


def test_versioned_cache_rejects_retired_source_and_keeps_position(system):
    _, knowledge, retrieval, project = system
    previous = knowledge.record(project['id'], 'decision.md', 'file', 'evidence old')
    first = retrieval.search('evidence', [project['id']], 'raw', 'local')
    repeat = retrieval.search('evidence', [project['id']], 'raw', 'local')
    assert repeat['metrics']['cache_hits'] == 1
    assert repeat['hits'][0]['position'] == first['hits'][0]['position']
    current = knowledge.record(project['id'], 'decision.md', 'file', 'evidence new')
    updated = retrieval.search('evidence', [project['id']], 'raw', 'local')
    assert updated['hits'][0]['source_id'] == current != previous
    assert updated['hits'][0]['content'] == 'evidence new'
    assert updated['metrics']['cache_hits'] == 0


def test_byte_cache_obeys_capacity_for_large_entries():
    cache = ByteCache(600)
    cache.put('a', '中' * 50)
    cache.put('b', 'y' * 50)
    assert cache.bytes <= 600 and cache.get('a') is None
    cache.put('large', 'x' * 1000)
    assert cache.get('large') is None
    assert cache.get('b') == 'y' * 50


def test_structural_blocks_cover_interior_with_overlap_and_versioned_offsets(system):
    store, knowledge, _, project = system
    content = '# Intro\n\n' + 'irrelevant\n' * 900 + '\n# Critical\n\nRareInteriorEvidence\n' + 'tail\n' * 700
    sid = knowledge.record(project['id'], 'long.md', 'file', content)
    blocks = natural_blocks(content)
    assert blocks[0]['start'] == 0 and blocks[-1]['end'] == len(content)
    assert max(b['end'] - b['start'] for b in blocks) <= 1800
    assert all(a['end'] >= b['start'] for a, b in zip(blocks, blocks[1:]))
    chunks = ChunkIndex(store)
    prepared = chunks.prepare(project['id'], 1)
    assert prepared['complete']
    assert chunks.prepare(project['id'], 1)['new_parts'] == 0
    found = next(row for row in store.query('SELECT * FROM retrieval_chunks')
                 if 'RareInteriorEvidence' in content[row['start_char']:row['end_char']])
    read = chunks.read(project['id'], found['id'], neighbors=1)
    assert 'RareInteriorEvidence' in read['content']
    assert read['content'] == content[read['position']['start']:read['position']['end']]
    assert read['source_id'] == sid
    with pytest.raises(ValueError):
        chunks.read('wrong-project', found['id'])
    knowledge.record(project['id'], 'long.md', 'file', 'replacement')
    with pytest.raises(ValueError):
        chunks.read(project['id'], found['id'])
    chunks.prepare(project['id'], 1)
    assert not (Path(prepared['path']) / (found['id'] + '.md')).exists()


def test_fts_covers_cold_interior_text_and_scopes_projects(system, tmp_path):
    store, knowledge, retrieval, project = system
    text = 'unrelated ' * 800 + '关键证据藏在正文内部' + ' trailer' * 800
    sid = knowledge.record(project['id'], 'large.txt', 'file', text)
    other_root, other_vault = tmp_path / 'other', tmp_path / 'other-vault'
    other_root.mkdir()
    other_vault.mkdir()
    other = Service(store).create_project(ProjectInput(name='beta', root=str(other_root), vault=str(other_vault)))
    knowledge.record(other['id'], 'other.txt', 'file', '关键证据藏在正文内部')
    result = retrieval.search('关键证据', [project['id']], 'raw', 'local')
    assert len(result['hits']) == 1
    assert result['hits'][0]['source_id'] == sid
    assert '关键证据' in result['hits'][0]['content']
    assert result['hits'][0]['position']['start'] > 0


def test_note_catalog_is_maintained_outside_queries_and_reads_are_bounded(system):
    _, _, retrieval, project = system
    path = Path(project['vault']) / project['writable_dirs'][0] / 'large.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('# Knowledge evidence\n\n' + '中' * 10000, encoding='utf-8')
    retrieval.refresh_note_catalog(project['id'])
    result = retrieval.search('Knowledge', [project['id']], 'knowledge', 'local',
                              max_bytes=100, per_hit_bytes=100)
    assert len(result['hits']) == 1 and result['metrics']['returned_bytes'] <= 100
    assert not result['warnings']
    path.write_text('# Knowledge evidence changed', encoding='utf-8')
    changed = retrieval.search('Knowledge', [project['id']], 'knowledge', 'local', max_bytes=100)
    assert changed['warnings'] and 'changed' in changed['hits'][0]['content']


def test_raw_and_fine_recall_merge_into_one_source_with_fine_position(system, monkeypatch):
    import json
    store, knowledge, retrieval, project = system
    sid = knowledge.record(project['id'], 'evidence.md', 'file', 'irrelevant ' * 300 + '\nInterior evidence')
    ChunkIndex(store).prepare(project['id'])
    blocks = store.query('SELECT id,start_char FROM retrieval_chunks ORDER BY start_char DESC')
    block_id = blocks[0]['id']
    store.set_meta('retrieval:' + project['id'], {'qmd': {
        'status': 'ready', 'mode': 'hybrid', 'fingerprint_schema': 2,
        'fingerprint': retrieval.fingerprint(project['id'], 'qmd')}})
    store.set_meta('fine-retrieval:' + project['id'], {'semantic_ready': True})
    def recall(engine, args, *unused, **kwargs):
        identifier = block_id if args[1].startswith('fine-') else sid
        return json.dumps({'results': [{'file': identifier + '.md'}], 'metrics': {'vectors_compared': 1}})
    monkeypatch.setattr(retrieval, '_run', recall)
    result = retrieval.search('Interior', [project['id']], 'raw', 'qmd', 8)
    assert len(result['hits']) == 1
    hit = result['hits'][0]
    assert hit['source_id'] == sid and hit['id'] == block_id
    assert hit['fine'] and hit['position']['start'] == blocks[0]['start_char']
    assert 'Interior evidence' in hit['content']


def test_fine_index_resumes_pending_vectors_before_preparing_new_sources(system, monkeypatch):
    store, knowledge, retrieval, project = system
    knowledge.record(project['id'], 'one.md', 'file', 'first evidence')
    knowledge.record(project['id'], 'two.md', 'file', 'second evidence')
    ChunkIndex(store).prepare(project['id'], 1)
    store.set_meta('qmd-fine-collection:' + project['id'], True)
    health = iter([{'pending': 1}, {'pending': 0, 'semantic_documents': 1}])
    monkeypatch.setattr(retrieval, 'qmd_health', lambda *args: next(health))
    monkeypatch.setattr(retrieval, '_run', lambda *args, **kwargs: '')
    monkeypatch.setattr(retrieval, 'reindex_qmd', lambda *args: {})
    result = retrieval.index_chunks(project['id'], batch_size=100)
    assert result['new_parts'] == 0 and result['prepared_parts'] == 1
    assert result['status'] == 'partial' and result['semantic_ready']


def test_knowledge_index_never_reads_or_rewrites_raw_projection(system, monkeypatch):
    import json
    store, knowledge, retrieval, project = system
    sid = knowledge.record(project['id'], 'large.csv', 'file', 'raw evidence ' * 1000)
    store.set_meta('projection:' + project['id'], {sid + '.md': sid})
    note = Path(project['vault']) / project['writable_dirs'][0] / 'note.md'
    note.parent.mkdir(parents=True, exist_ok=True)
    note.write_text('# Evidence', encoding='utf-8')
    original = retrieval._write_projection
    written = []

    def write(path, content):
        assert 'raw' not in path.relative_to(retrieval.root).parts
        written.append(path)
        original(path, content)

    monkeypatch.setattr(retrieval, '_write_projection', write)
    monkeypatch.setattr(retrieval, '_run', lambda *a, **kw: json.dumps(
        {'total': 1, 'embedding_dim': 384, 'failed_chunks': 0}))
    result = retrieval.index(project['id'], 'ohs')['ohs']
    assert result['status'] == 'ready' and result['mode'] == 'hybrid'
    assert len(written) == 1
    assert not (retrieval.root / project['id'] / 'raw').exists()
    assert store.meta('projection:' + project['id']) == {sid + '.md': sid}
