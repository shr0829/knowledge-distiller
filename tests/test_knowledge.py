import json
from pathlib import Path

import pytest

from library_companion.knowledge import CHUNK, Knowledge, knowledge_dir, project_notes
from library_companion.models import ProjectInput, Review
from library_companion.retrieval import Retrieval
from library_companion.service import Service
from library_companion.store import Store


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / 'state')
    service = Service(store)
    projects = []
    for name in ('alpha', 'beta'):
        root, vault = tmp_path / name, tmp_path / (name + '-vault')
        root.mkdir()
        vault.mkdir()
        projects.append(service.create_project(ProjectInput(name=name, root=str(root), vault=str(vault))))
    return store, service, Knowledge(store), projects


def item(sid, **changes):
    return {'title': 'A decision', 'content': 'Use immutable evidence.', 'source': 'immutable evidence',
            'source_ids': [sid], 'target': None, **changes}


def apply(service, proposal):
    review = Review(revision=proposal['revision'], action=proposal['recommended_action'])
    preview = service.preview(proposal['id'], review)
    return service.review(proposal['id'], review.model_copy(update={'preview_token': preview['preview_token']}))


def test_source_versions_shrink_and_deleted_files(setup):
    _, _, knowledge, (a, _) = setup
    path = Path(a['root']) / 'readme.md'
    path.write_text('a' * (CHUNK + 10), encoding='utf-8')
    assert knowledge.scan(a['id'], history=False)['new_versions'] == 2
    original = knowledge.sources(a['id'])
    path.write_text('new evidence', encoding='utf-8')
    knowledge.scan(a['id'], history=False)
    assert len(knowledge.sources(a['id'])) == 1
    assert knowledge.source(original[1]['id'])['content'] == 'a' * 10
    assert not knowledge.source(original[1]['id'])['active']
    path.unlink()
    knowledge.scan(a['id'], history=False)
    assert not knowledge.sources(a['id'])
    assert len(knowledge.sources(a['id'], active=False)) == 3


def test_search_projection_does_not_rewrite_unchanged_windows_text(setup):
    store, _, knowledge, (a, _) = setup
    original = 'Heading\r\nEvidence\r\n'
    sid = knowledge.record(a['id'], 'windows.txt', 'file', original)
    retrieval = Retrieval(store)
    projected = retrieval.project(a['id'])
    path = Path(projected['raw']) / (sid + '.md')
    first = path.stat().st_mtime_ns
    retrieval.project(a['id'])
    assert path.stat().st_mtime_ns == first
    assert b'\r' not in path.read_bytes()
    assert knowledge.source(sid)['content'] == original


def test_source_excluded_project_and_fast_tail_retirement(setup, tmp_path):
    store, service, knowledge, (a, _) = setup
    nested = Path(a['root']) / 'splash'
    nested.mkdir()
    (nested / 'private.md').write_text('separate project', encoding='utf-8')
    from library_companion.store import encode
    data = {k: v for k, v in a.items() if k != 'id'}
    data['source_excluded_dirs'] = ['splash']
    store.execute('UPDATE projects SET data=? WHERE id=?', (encode(data), a['id']))
    assert knowledge._owner(nested) is None
    report = knowledge.scan(a['id'], history=False)
    assert report['files'] == 0 and report['eligible_files'] == 0
    first = knowledge._record_parts(a['id'], 'x_%.md', 'file', 'a' * (CHUNK + 2))
    knowledge._record_parts(a['id'], 'x_other.md', 'file', 'unrelated')
    knowledge._record_parts(a['id'], 'x_%.md', 'file', 'short')
    assert not knowledge.source(first[-1])['active']
    assert any(s['locator'] == 'x_other.md#part=1' for s in knowledge.sources(a['id']))


def test_histories_route_by_cwd_and_exclude_hidden_messages(setup, tmp_path):
    _, _, knowledge, (a, b) = setup
    history = tmp_path / 'sessions'
    history.mkdir()
    for project in (a, b):
        records = [
            {'type': 'session_meta', 'payload': {'id': project['id'], 'cwd': project['root']}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': project['name']}]}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'developer', 'content': [{'type': 'input_text', 'text': 'secret-system'}]}},
            {'type': 'response_item', 'payload': {'type': 'reasoning', 'summary': 'hidden-reasoning'}},
        ]
        (history / (project['id'] + '.jsonl')).write_text('\n'.join(json.dumps(r) for r in records), encoding='utf-8')
    report = knowledge.scan(a['id'], files=False, history_roots=[str(history)])
    assert report['sessions'] == 1
    text = knowledge.sources(a['id'])[0]['content']
    assert 'alpha' in text and 'beta' not in text and 'secret-system' not in text and 'hidden-reasoning' not in text
    assert not knowledge.sources(b['id'])


def test_build_pins_evidence_review_and_partial_coverage(setup):
    store, service, knowledge, (a, b) = setup
    sid = knowledge.record(a['id'], 'decision.md', 'file', 'Prefer immutable evidence.')
    extra = knowledge.record(a['id'], 'other.md', 'file', 'Unrelated facts.')
    foreign = knowledge.record(b['id'], 'beta.md', 'file', 'immutable evidence')
    with pytest.raises(ValueError):
        knowledge.prepare(a['id'], [foreign])
    build = knowledge.prepare(a['id'], [sid, extra])
    knowledge.record(a['id'], 'decision.md', 'file', 'Changed after build preparation.')
    with pytest.raises(ValueError, match='exact'):
        knowledge.submit(build['id'], [item(sid, source='invented quote')])
    with pytest.raises(ValueError, match='pinned'):
        knowledge.submit(build['id'], [item(foreign)])
    proposals = knowledge.submit(build['id'], [item(sid)])
    p = proposals[0]
    assert p['target'].startswith(knowledge_dir(a) + '/')
    assert p['status'] == 'pending'
    assert not list(Path(a['vault']).rglob('*.md'))
    assert knowledge.submit(build['id'], []) == proposals
    assert extra not in knowledge._handled(a['id'])
    assert store.query('SELECT source_id FROM knowledge_evidence')[0]['source_id'] == sid
    apply(service, p)
    assert 'immutable evidence' in (Path(a['vault']) / p['target']).read_text(encoding='utf-8')


def test_duplicate_submission_is_atomic(setup):
    store, _, knowledge, (a, _) = setup
    sid = knowledge.record(a['id'], 'source', 'file', 'immutable evidence')
    build = knowledge.prepare(a['id'])
    with pytest.raises(ValueError, match='Duplicate'):
        knowledge.submit(build['id'], [item(sid), item(sid)])
    assert store.proposal_list() == []


@pytest.mark.parametrize('shared', [False, True])
def test_cross_project_links_appear_only_after_review(setup, shared):
    store, service, knowledge, (a, b) = setup
    if shared:
        b = service.create_project(ProjectInput(name='gamma', root=b['root'], vault=a['vault']))
    target = knowledge_dir(b) + '/concepts/reference.md'
    destination = Path(b['vault']) / target
    destination.parent.mkdir(parents=True)
    destination.write_text('# Reference\n\nimmutable evidence', encoding='utf-8')
    assert target not in {n['path'] for n in project_notes(store, a)}
    sid = knowledge.record(a['id'], 'source', 'file', 'immutable evidence')
    build = knowledge.prepare(a['id'])
    with pytest.raises(ValueError, match='namespace'):
        knowledge.submit(build['id'], [item(sid, target=target)])
    proposal = knowledge.submit(build['id'], [item(sid, related_notes=[{'project_id': b['id'], 'path': target}])])[0]
    assert not knowledge.graph()['edges']
    apply(service, proposal)
    assert any(e['kind'] == 'reviewed_relation' for e in knowledge.graph()['edges'])
    body = (Path(a['vault']) / proposal['target']).read_text(encoding='utf-8')
    assert ('[[' + target.removesuffix('.md') + ']]' in body) if shared else ('obsidian://open?' in body)


def test_retrieval_provider_failure_and_trusted_hydration(setup, monkeypatch):
    store, _, knowledge, (a, b) = setup
    sid = knowledge.record(a['id'], 'readme', 'file', 'immutable evidence')
    knowledge.record(b['id'], 'other', 'file', 'immutable evidence other project')
    retrieval = Retrieval(store)
    retrieval.project(a['id'])
    store.set_meta('retrieval:' + a['id'], {'qmd': {'status': 'ready', 'mode': 'fulltext'}})
    monkeypatch.setattr(retrieval, '_run', lambda *args, **kw: json.dumps([
        {'file': 'qmd://raw-test/' + sid + '.md', 'content': 'untrusted external text'},
        {'file': 'unknown.md', 'content': 'wrong project'},
    ]))
    result = retrieval.search('immutable', [a['id']], engine='qmd')
    assert len(result['hits']) == 1
    assert result['hits'][0]['content'] == 'immutable evidence'
    assert result['hits'][0]['engines'] == ['local', 'qmd']
    def fail(*args, **kwargs):
        raise ValueError('engine unavailable')
    monkeypatch.setattr(retrieval, '_run', fail)
    failed = retrieval.search('immutable', [a['id']], engine='qmd')
    assert failed['warnings'] and failed['hits'][0]['engines'] == ['local']


@pytest.mark.asyncio
async def test_agent_server_has_no_approval_transport(setup):
    from library_companion.mcp_server import create_mcp
    store, *_ = setup
    server = create_mcp(store, include_sidebar=False)
    names = {t.name for t in await server.list_tools()}
    assert {'prepare_knowledge_build', 'submit_knowledge_build', 'search_knowledge'} <= names
    assert 'library_ui_request' not in names and 'open_library' not in names


def test_claudian_history_has_unique_vault_owner(setup):
    _, service, knowledge, (a, b) = setup
    assert knowledge._owner(Path(a['vault'])) == a['id']
    service.create_project(ProjectInput(name='shared', root=b['root'], vault=a['vault']))
    assert knowledge._owner(Path(a['vault'])) is None


def test_provider_install_preserves_settings_and_is_repeatable(setup):
    from library_companion.integration import install_knowledge_integration
    store, _, _, (a, _) = setup
    vault = Path(a['vault'])
    config = vault / '.mcp.json'
    config.write_text(json.dumps({'mcpServers': {'existing': {'command': 'local-server'}}}), encoding='utf-8')
    (vault / 'AGENTS.md').write_text('# Existing instructions\nKeep this.\n', encoding='utf-8')
    result = install_knowledge_integration(store, a['id'])
    install_knowledge_integration(store, a['id'])
    parsed = json.loads(config.read_text(encoding='utf-8'))
    assert parsed['mcpServers']['existing']['command'] == 'local-server'
    assert '--agent-only' in parsed['mcpServers']['library-knowledge']['args']
    instructions = (vault / 'AGENTS.md').read_text(encoding='utf-8')
    assert instructions.startswith('# Existing instructions\nKeep this.')
    assert instructions.count('<!-- library-knowledge:start -->') == 1
    assert (Path(result['directory']) / 'before-install' / '.mcp.json').exists()


def test_http_build_search_and_source_scope(setup):
    from fastapi.testclient import TestClient

    from library_companion.api import create_app
    store, _, knowledge, (a, b) = setup
    sid = knowledge.record(a['id'], 'source', 'file', 'immutable evidence')
    other = knowledge.record(b['id'], 'other', 'file', 'other project facts')
    with TestClient(create_app(store.home)) as client:
        assert client.get('/api/sources/' + sid).status_code == 403
        session = client.get('/api/session', headers={'X-Library-Reviewer': client.app.state.bootstrap_token})
        headers = {'X-Library-Token': session.json()['csrf_token']}
        assert client.get('/api/sources/' + sid).json()['content'] == 'immutable evidence'
        invalid = client.post(f"/api/projects/{a['id']}/builds", json={'source_ids': [other]}, headers=headers)
        assert invalid.status_code == 400
        build = client.post(f"/api/projects/{a['id']}/builds", json={'source_ids': [sid]}, headers=headers).json()
        submitted = client.post(f"/api/builds/{build['id']}/submit", json={'candidates': [item(sid)]}, headers=headers)
        assert submitted.status_code == 200 and submitted.json()[0]['status'] == 'pending'
        results = client.post('/api/knowledge/search', json={'query': 'immutable', 'project_ids': [a['id']], 'engine': 'local'}, headers=headers)
        assert len(results.json()['hits']) == 1


def test_shared_vault_instructions_require_explicit_project(setup):
    from library_companion.integration import install_knowledge_integration
    store, service, _, (a, b) = setup
    shared = service.create_project(ProjectInput(name='shared', root=b['root'], vault=a['vault']))
    install_knowledge_integration(store, a['id'])
    text = (Path(a['vault']) / 'AGENTS.md').read_text(encoding='utf-8')
    assert 'Shared vault project selection' in text
    assert a['id'] in text and shared['id'] in text
    assert knowledge_dir(shared) in text


def test_failed_semantic_index_preserves_fulltext(setup, monkeypatch):
    store, _, knowledge, (a, _) = setup
    knowledge.record(a['id'], 'source', 'file', 'immutable evidence')
    retrieval = Retrieval(store)
    def run(engine, args, *unused, **kwargs):
        if args[0] == 'embed':
            raise ValueError('Model download failed')
        return ''
    monkeypatch.setattr(retrieval, '_run', run)
    result = retrieval.index(a['id'], 'qmd', semantic=True)['qmd']
    assert result['status'] == 'ready' and result['mode'] == 'fulltext'
    assert 'Model download failed' in result['diagnostics']['semantic_error']


def test_qmd_partial_embedding_zero_exit_is_not_hybrid(setup, monkeypatch):
    store, _, knowledge, (a, _) = setup
    knowledge.record(a['id'], 'source', 'file', 'immutable evidence')
    retrieval = Retrieval(store)
    monkeypatch.setattr(retrieval, '_run', lambda *args, **kwargs: 'Done')
    monkeypatch.setattr(retrieval, 'reindex_qmd', lambda *args: {})
    monkeypatch.setattr(retrieval, 'qmd_health', lambda *args: {'documents': 1, 'semantic_documents': 1, 'pending': 1, 'chunks': 2})
    result = retrieval.index(a['id'], 'qmd', semantic=True)['qmd']
    assert result['mode'] == 'fulltext'
    assert result['diagnostics']['pending'] == 1
    monkeypatch.setattr(retrieval, 'qmd_health', lambda *args: {'documents': 1, 'semantic_documents': 1, 'pending': 0, 'chunks': 3})
    assert retrieval.index(a['id'], 'qmd', semantic=True)['qmd']['mode'] == 'hybrid'


def test_source_paging_filters_all_sources_and_never_returns_bodies(setup):
    _, _, knowledge, (a, _) = setup
    knowledge._record_parts(a['id'], 'many_parts.md', 'file', 'x' * (CHUNK * 103))
    overview = knowledge.overview(a['id'])
    assert overview['source_total'] == 103
    assert len(overview['sources']) == 100
    assert all('content' not in s for s in overview['sources'])
    page = knowledge.source_page(a['id'], offset=100)
    assert len(page['sources']) == 3 and page['next_offset'] is None
    assert not set(s['id'] for s in page['sources']) & set(s['id'] for s in overview['sources'])
    assert knowledge.source_page(a['id'], query='%')['total'] == 0
    assert knowledge.source_page(a['id'], query='parts.md')['total'] == 103


def test_semantic_document_excerpts_retain_original_evidence(setup):
    store, _, knowledge, (a, _) = setup
    content = 'BEGIN evidence ' + ('numeric table ' * 2500) + ' END evidence'
    ids = knowledge._record_parts(a['id'], 'table.csv', 'file', content)
    retrieval = Retrieval(store)
    semantic = retrieval.semantic_project(a['id'])
    assert semantic['documents'] == 1
    projected = Path(semantic['path']) / (ids[0] + '.md')
    body = projected.read_text(encoding='utf-8')
    assert 'BEGIN evidence' in body and 'END evidence' in body
    assert len(body) < 1500
    assert ''.join(knowledge.source(s)['content'] for s in ids) == content


def test_ohs_zero_exit_does_not_imply_success(setup, monkeypatch):
    store, _, _, (a, _) = setup
    path = Path(a['vault']) / 'Library/test.md'
    path.parent.mkdir()
    path.write_text('# Test', encoding='utf-8')
    retrieval = Retrieval(store)
    monkeypatch.setattr(retrieval, '_run', lambda *args, **kwargs: json.dumps({'total': 0}))
    result = retrieval.index(a['id'], 'ohs')['ohs']
    assert result['status'] == 'error'
