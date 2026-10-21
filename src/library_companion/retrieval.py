"""Local QMD/OHS adapters over disposable, project-scoped projections."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from contextlib import closing
from pathlib import Path

import portalocker
import yaml

from .knowledge import Knowledge, project_notes
from .search_support import ByteCache, clip_bytes, normalize
from .store import Store, now
from .vault import digest


class Retrieval:
    def __init__(self, store: Store):
        self.store = store
        self.knowledge = Knowledge(store)
        self.root = store.home / 'retrieval'
        self.body_cache = ByteCache()

    @staticmethod
    def _write_projection(target: Path, content: str):
        # Normalize only the disposable search copy. Windows newline expansion
        # otherwise turns source CRLF into CRCRLF and rewrites unchanged files.
        content = content.replace('\r\n', '\n').replace('\r', '\n')
        if not target.is_file() or target.read_text(encoding='utf-8') != content:
            target.write_text(content, encoding='utf-8', newline='\n')

    def command(self, engine: str) -> list[str]:
        packages = self.store.home / 'search-runtime' / 'node_modules'
        script = packages / ('@tobilu/qmd/dist/cli/qmd.js' if engine == 'qmd' else 'obsidian-hybrid-search/dist/src/cli.js')
        node = shutil.which('node')
        if not node or not script.is_file():
            raise ValueError(f'{engine} is not installed; install the pinned search-runtime dependencies')
        return [node, str(script)]

    def _run(self, engine: str, args: list[str], project_id: str, *, timeout=45) -> str:
        env = os.environ.copy()
        # Upstream may select a remote embedding provider when an ambient key is
        # present. These adapters deliberately use local models only.
        for key in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_EMBEDDING_MODEL', 'INDEX_PATH'):
            env.pop(key, None)
        env.update(QMD_CONFIG_DIR=str(self.root / 'qmd-config'), XDG_CACHE_HOME=str(self.root / 'cache'),
                   OBSIDIAN_VAULT_PATH=str(self.root / project_id / 'knowledge'), NO_COLOR='1',
                   OBSIDIAN_RESPECT_GITIGNORE='false', OBSIDIAN_INCLUDE_PATTERNS='',
                   OBSIDIAN_IGNORE_PATTERNS='.obsidian/**,*.canvas')
        embedding = self.root / 'cache/qmd/models/embeddinggemma-300M-Q8_0.gguf'
        if engine == 'qmd' and embedding.is_file():
            env['QMD_EMBED_MODEL'] = str(embedding)
        if engine == 'ohs':
            # Upstream restores a previous API endpoint from its disposable DB.
            # Remove that default as well as ambient credentials to enforce local mode.
            database = self.root / project_id / 'knowledge/.obsidian-hybrid-search.db'
            if database.is_file():
                with closing(sqlite3.connect(database)) as db:
                    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").fetchone():
                        db.execute("DELETE FROM settings WHERE key IN ('api_base_url','api_model')")
                        db.commit()
            env['LOCAL_EMBEDDING_MODEL'] = 'Xenova/multilingual-e5-small'
        try:
            # Explicit index selection prevents discovery of a project-supplied
            # .qmd configuration (which may contain update hooks).
            if engine == 'qmd' and args[0] == '__candidates__':
                root = Path(__file__).resolve().parents[2]
                command = [self.command(engine)[0], str(root / 'scripts/qmd-candidates.mjs'),
                           str(self.store.home / 'search-runtime/node_modules/@tobilu/qmd/dist/store.js'),
                           str(self.root / 'cache/qmd/index.sqlite'), str(embedding), *args[1:]]
            else:
                command_args = ['--index', 'index', *args] if engine == 'qmd' else args
                command = self.command(engine) + command_args
            result = subprocess.run(command, capture_output=True, text=True,
                                    encoding='utf-8', errors='replace', timeout=timeout, env=env,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except subprocess.TimeoutExpired as exc:
            raise ValueError(f'{engine} exceeded {timeout}s; local model download or indexing may be incomplete') from exc
        if result.returncode:
            raise ValueError(f'{engine}: ' + (result.stderr or result.stdout)[-1200:])
        return result.stdout

    def status(self) -> dict:
        result = {}
        for engine in ('qmd', 'ohs'):
            try:
                command = self.command(engine)
                installed = True
            except ValueError:
                installed, command = False, []
            result[engine] = {'installed': installed, 'command': command,
                              'purpose': '原始材料混合检索' if engine == 'qmd' else '知识页、双链与语义检索'}
        result['projects'] = {p['id']: self.project_status(p['id']) for p in self.store.projects()}
        result['fine_projects'] = {p['id']: self.store.meta('fine-retrieval:' + p['id'], {})
                                   for p in self.store.projects()}
        return result

    def qmd_health(self, project_id: str, semantic_collection: str | None = None) -> dict:
        root = Path(__file__).resolve().parents[2]
        module = self.store.home / 'search-runtime/node_modules/@tobilu/qmd/dist/store.js'
        model = self.root / 'cache/qmd/models/embeddinggemma-300M-Q8_0.gguf'
        result = subprocess.run(
            [self.command('qmd')[0], str(root / 'scripts/qmd-health.mjs'), str(module),
             str(self.root / 'cache/qmd/index.sqlite'), 'raw-' + project_id, str(model),
             semantic_collection or 'raw-' + project_id],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=45,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode:
            raise ValueError('QMD embedding verification failed: ' + result.stderr[-500:])
        return json.loads(result.stdout)

    def reindex_qmd(self, project_id: str, collection: str, folder: str):
        root = Path(__file__).resolve().parents[2]
        database = self.root / 'cache/qmd/index.sqlite'
        collection_path = Path(folder)
        current_paths = None
        if collection.startswith('raw-'):
            current_paths = {
                row['id'] + '.md' for row in self.store.query(
                    'SELECT id FROM sources WHERE project_id=? AND active=1',
                    (project_id,))
            }
        elif collection_path.is_dir():
            current_paths = {path.name for path in collection_path.glob('*.md')}
        if current_paths is not None and database.is_file():
            with closing(sqlite3.connect(database)) as db:
                existing = {
                    row[0] for row in db.execute(
                        'SELECT path FROM documents WHERE collection=? AND active=1',
                        (collection,))
                }
            manifest = self.root / 'cache/qmd' / (
                'manifest-' + project_id + '-' + digest(collection)[:12] + '.json')
            manifest.write_text(json.dumps({
                'upsert': sorted(current_paths - existing),
                'remove': sorted(existing - current_paths),
            }, ensure_ascii=False), encoding='utf-8')
            try:
                result = subprocess.run(
                    [self.command('qmd')[0], str(root / 'scripts/qmd-incremental.mjs'),
                     str(self.store.home / 'search-runtime/node_modules/@tobilu/qmd/dist/store.js'),
                     str(database), collection, str(collection_path), str(manifest)],
                    capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=900,
                    creationflags=subprocess.CREATE_NO_WINDOW)
            finally:
                manifest.unlink(missing_ok=True)
        else:
            result = subprocess.run(
                [self.command('qmd')[0], str(root / 'scripts/qmd-reindex.mjs'),
                 str(self.store.home / 'search-runtime/node_modules/@tobilu/qmd/dist/store.js'),
                 str(database), collection, folder],
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=1800,
                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise ValueError('QMD reindex failed: ' + result.stderr[-800:])
        return json.loads(result.stdout)

    def semantic_project(self, project_id: str) -> dict:
        """Bounded excerpts per source document; complete raw text remains in BM25."""
        folder = self.root / project_id / 'semantic'
        folder.mkdir(parents=True, exist_ok=True)
        mapping, group = {}, []

        def write_group():
            if not group:
                return
            first, middle, last = group[0], group[len(group) // 2], group[-1]
            content = ('# ' + first['origin'] + '\n\n来源片段数: ' + str(len(group))
                       + '\n\n[开头摘录]\n' + first['excerpt']
                       + '\n\n[中部摘录]\n' + middle['excerpt']
                       + '\n\n[结尾摘录]\n' + last['tail'])
            filename = first['id'] + '.md'
            target = folder / filename
            self._write_projection(target, content)
            mapping[filename] = first['id']

        with self.store.connection() as db:
            rows = db.execute(
                """SELECT id,COALESCE(json_extract(data,'$.origin'),locator) AS origin,
                   substr(json_extract(data,'$.content'),1,350) AS excerpt,
                   substr(json_extract(data,'$.content'),-250) AS tail
                   FROM sources WHERE project_id=? AND active=1
                   ORDER BY origin,json_extract(data,'$.part'),id""", (project_id,))
            for row in rows:
                row = dict(row)
                if group and group[0]['origin'] != row['origin']:
                    write_group()
                    group = []
                group.append(row)
            write_group()
        for path in folder.glob('*.md'):
            if path.name not in mapping and len(path.stem) == 64:
                path.unlink()
        return {'path': str(folder), 'documents': len(mapping)}

    def refresh_raw_projection(self, project_id: str) -> dict:
        """Refresh only new/retired source files in an existing raw projection."""
        folder = self.root / project_id / 'raw'
        folder.mkdir(parents=True, exist_ok=True)
        existing = {path.name for path in folder.glob('*.md') if len(path.stem) == 64}
        active_ids = {
            row['id'] for row in self.store.query(
                'SELECT id FROM sources WHERE project_id=? AND active=1', (project_id,))
        }
        for source_id in sorted(active_ids - {name[:-3] for name in existing}):
            source = self.knowledge.source(source_id)
            target = folder / (source_id + '.md')
            self._write_projection(
                target, '# ' + source['locator'] + '\n\n' + source['content'])
        for name in existing - {source_id + '.md' for source_id in active_ids}:
            (folder / name).unlink(missing_ok=True)
        return {'raw': str(folder), 'sources': len(active_ids)}

    def fingerprint(self, project_id: str, engine: str) -> str:
        key = ('raw_changed:' if engine == 'qmd' else 'knowledge_changed:') + project_id
        return digest(json.dumps({'schema': 2, 'generation': self.store.meta(key, '')}))

    def project_status(self, project_id: str) -> dict:
        result = self.store.meta('retrieval:' + project_id, {})
        for name, status in result.items():
            if status.get('fingerprint_schema') == 2:
                status['stale'] = status.get('fingerprint') != self.fingerprint(project_id, name)
            else:
                # Existing manifests used a full ID hash. A legacy index can
                # still be checked against its build timestamp without scanning.
                changed = self.store.meta(('raw_changed:' if name == 'qmd' else 'knowledge_changed:')
                                          + project_id, '')
                status['stale'] = bool(changed and changed > status.get('indexed_at', ''))
        return result

    def project(self, project_id: str, *, include_raw=True) -> dict:
        project = self.store.project(project_id)
        folder = self.root / project_id
        raw, knowledge = folder / 'raw', folder / 'knowledge'
        if include_raw:
            raw.mkdir(parents=True, exist_ok=True)
        knowledge.mkdir(parents=True, exist_ok=True)
        mapping = {}
        if include_raw:
            with self.store.connection() as db:
                for source in db.execute(
                        "SELECT id,locator,json_extract(data,'$.content') AS content "
                        "FROM sources WHERE project_id=? AND active=1 ORDER BY id", (project_id,)):
                    filename = source['id'] + '.md'
                    content = '# ' + source['locator'] + '\n\n' + source['content']
                    target = raw / filename
                    self._write_projection(target, content)
                    mapping[filename] = source['id']
            # Only generated files under this exact projection are removed.
            for path in raw.glob('*.md'):
                if path.name not in mapping and len(path.stem) == 64:
                    path.unlink()
        note_paths = set()
        for note in project_notes(self.store, project):
            target = knowledge / note['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            self._write_projection(target, note['content'])
            note_paths.add(note['path'])
            self.catalog_note(project_id, note)
        for path in knowledge.rglob('*.md'):
            if path.relative_to(knowledge).as_posix() not in note_paths:
                path.unlink()
        with self.store.connection() as db:
            for row in db.execute('SELECT rowid,path FROM note_catalog WHERE project_id=?', (project_id,)):
                if row['path'] not in note_paths:
                    db.execute('DELETE FROM note_fts WHERE rowid=?', (row['rowid'],))
                    db.execute('DELETE FROM note_catalog WHERE rowid=?', (row['rowid'],))
        if include_raw:
            self.store.set_meta('projection:' + project_id, mapping)
        return {'raw': str(raw), 'knowledge': str(knowledge), 'sources': len(mapping), 'notes': len(note_paths)}

    def catalog_note(self, project_id: str, note: dict):
        from .vault import Vault
        path = Vault(self.store.project(project_id), self.store.home).resolve(note['path'])
        if path.is_file():
            stat = path.stat()
            self.store.set_meta('note-signature:' + project_id + ':' + note['path'],
                                [stat.st_mtime_ns, stat.st_size])
        with self.store.connection() as db:
            previous = db.execute('SELECT rowid,revision FROM note_catalog WHERE project_id=? AND path=?',
                                  (project_id, note['path'])).fetchone()
            if previous and previous['revision'] == note['hash']:
                return
            db.execute("""INSERT INTO note_catalog VALUES(?,?,?,?)
                          ON CONFLICT(project_id,path) DO UPDATE SET title=excluded.title,revision=excluded.revision""",
                       (project_id, note['path'], note['title'], note['hash']))
            row = db.execute('SELECT rowid FROM note_catalog WHERE project_id=? AND path=?',
                             (project_id, note['path'])).fetchone()
            db.execute('DELETE FROM note_fts WHERE rowid=?', (row[0],))
            db.execute('INSERT INTO note_fts(rowid,locator,body,scope) VALUES(?,?,?,?)',
                       (row[0], normalize(note['title'] + ' ' + note['path']), normalize(note['content']), project_id))
        self.store.set_meta('knowledge_changed:' + project_id, now())

    def refresh_note_catalog(self, project_id: str) -> dict:
        """Maintenance operation; queries never enumerate vault contents."""
        notes = project_notes(self.store, self.store.project(project_id))
        for note in notes:
            self.catalog_note(project_id, note)
        paths = {n['path'] for n in notes}
        with self.store.connection() as db:
            for row in db.execute('SELECT rowid,path FROM note_catalog WHERE project_id=?', (project_id,)):
                if row['path'] not in paths:
                    db.execute('DELETE FROM note_fts WHERE rowid=?', (row['rowid'],))
                    db.execute('DELETE FROM note_catalog WHERE rowid=?', (row['rowid'],))
                    db.execute('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                               ('knowledge_changed:' + project_id, json.dumps(now())))
        return {'notes': len(notes)}

    def index_chunks(self, project_id: str, batch_size=100, semantic=True) -> dict:
        """Bounded, resumable fine-grained coverage. Never replace the raw index."""
        from .chunk_index import ChunkIndex
        locks = self.store.home / 'locks'
        locks.mkdir(exist_ok=True)
        with portalocker.Lock(str(locks / 'retrieval.lock'), timeout=5):
            raw_fingerprint = self.fingerprint(project_id, 'qmd')
            collection = 'fine-' + project_id
            marker = 'qmd-fine-collection:' + project_id
            # Resume an unfinished embedding batch before adding more blocks.
            # This is build-time health work, never a query-time global scan.
            pending = self.qmd_health(project_id, collection).get('pending', 0) if self.store.meta(marker) and semantic else 0
            coverage = ChunkIndex(self.store).prepare(project_id, 0 if pending else batch_size)
            if not self.store.meta(marker):
                self._run('qmd', ['collection', 'add', coverage['path'], '--name', collection],
                          project_id, timeout=900)
                self.store.set_meta(marker, True)
            else:
                self.reindex_qmd(project_id, collection, coverage['path'])
            diagnostics = {}
            if semantic:
                self._run('qmd', ['embed', '-c', collection, '--timeout', '2',
                                  '--max-docs-per-batch', '32', '--max-batch-mb', '16'],
                          project_id, timeout=180)
                diagnostics = self.qmd_health(project_id, collection)
            complete = (coverage['complete'] and semantic and diagnostics.get('pending') == 0
                        and diagnostics.get('semantic_documents') == coverage['blocks'])
            status = {**coverage, 'diagnostics': diagnostics, 'indexed_at': now(),
                      'status': 'complete' if complete else 'partial',
                      'semantic_ready': bool(semantic and diagnostics.get('pending') == 0),
                      'fingerprint': raw_fingerprint}
            self.store.set_meta('fine-retrieval:' + project_id, status)
            return status

    def index(self, project_id: str, engine='all', semantic=False) -> dict:
        if engine not in {'qmd', 'ohs', 'all'}:
            raise ValueError('Unknown search engine')
        locks = self.store.home / 'locks'
        locks.mkdir(exist_ok=True)
        with portalocker.Lock(str(locks / 'retrieval.lock'), timeout=5):
            result = self.store.meta('retrieval:' + project_id, {})
            raw_fingerprint = self.fingerprint(project_id, 'qmd')
            qmd_current = (result.get('qmd', {}).get('status') == 'ready'
                           and not self.project_status(project_id).get('qmd', {}).get('stale')
                           and self.store.meta('qmd-collection:' + project_id))
            embedding = self.root / 'cache/qmd/models/embeddinggemma-300M-Q8_0.gguf'
            config_path = self.root / 'qmd-config/index.yml'
            if embedding.is_file() and config_path.is_file():
                config = yaml.safe_load(config_path.read_text(encoding='utf-8')) or {}
                if config.setdefault('models', {}).get('embed') != str(embedding):
                    config['models']['embed'] = str(embedding)
                    config_path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding='utf-8')
            if engine == 'qmd' and qmd_current:
                projection = {'sources': result['qmd']['documents']}
            elif engine == 'qmd' and self.store.meta('qmd-collection:' + project_id):
                # Existing large collections are refreshed by source ID, so a
                # stale marker does not force a full正文投影 rewrite.
                projection = self.refresh_raw_projection(project_id)
            else:
                projection = self.project(project_id, include_raw=engine != 'ohs')
            for name in ('qmd', 'ohs'):
                if engine not in {name, 'all'}:
                    continue
                try:
                    diagnostics = {}
                    mode = 'hybrid' if semantic else 'fulltext'
                    if name == 'qmd':
                        collection = 'raw-' + project_id
                        if not self.store.meta('qmd-collection:' + project_id):
                            self._run(name, ['collection', 'add', projection['raw'], '--name', collection], project_id, timeout=900)
                            self.store.set_meta('qmd-collection:' + project_id, True)
                        elif not qmd_current:
                            self.reindex_qmd(project_id, collection, projection['raw'])
                        if semantic:
                            try:
                                semantic_projection = self.semantic_project(project_id)
                                semantic_collection = 'semantic-' + project_id
                                if not self.store.meta('qmd-semantic-collection:' + project_id):
                                    self._run(name, ['collection', 'add', semantic_projection['path'],
                                                     '--name', semantic_collection], project_id, timeout=900)
                                    self.store.set_meta('qmd-semantic-collection:' + project_id, True)
                                else:
                                    self.reindex_qmd(project_id, semantic_collection, semantic_projection['path'])
                                self._run(name, ['embed', '-c', semantic_collection, '--timeout', '8',
                                                 '--max-docs-per-batch', '32', '--max-batch-mb', '16'],
                                          project_id, timeout=540)
                                diagnostics = self.qmd_health(project_id, semantic_collection)
                                diagnostics['semantic_scope'] = 'source-document-excerpts'
                                if diagnostics['documents'] != projection['sources'] or diagnostics['pending']:
                                    mode = 'fulltext'
                                    diagnostics['semantic_error'] = (
                                        f"Semantic indexing incomplete: {diagnostics['pending']} documents remain; "
                                        "rerun semantic indexing to resume.")
                                elif diagnostics['semantic_documents'] != semantic_projection['documents']:
                                    raise ValueError('Semantic source document count does not match projection')
                            except (ValueError, OSError) as exc:
                                mode = 'fulltext'
                                diagnostics['semantic_error'] = str(exc)
                    else:
                        database = self.root / project_id / 'knowledge/.obsidian-hybrid-search.db'
                        force = False
                        if database.is_file():
                            with closing(sqlite3.connect(database)) as db:
                                stored = db.execute("SELECT value FROM settings WHERE key='embedding_model'").fetchone()
                                force = bool(stored and stored[0] != 'local:Xenova/multilingual-e5-small')
                        if force:
                            # Upstream --force unlinks an open DB on Windows.
                            # This is our disposable projection only.
                            for suffix in ('', '-wal', '-shm'):
                                sidecar = Path(str(database) + suffix)
                                if sidecar.is_file():
                                    sidecar.unlink()
                        self._run(name, ['reindex'], project_id, timeout=600)
                        diagnostics = json.loads(self._run(name, ['status'], project_id))
                        if diagnostics.get('total', 0) != projection['notes']:
                            raise ValueError('Hybrid Search did not index all projected knowledge pages; check local embedding model availability (Hugging Face) and native dependencies')
                        if projection['notes'] == 0:
                            mode = 'empty'
                        elif diagnostics.get('embedding_dim') and not diagnostics.get('failed_chunks'):
                            mode = 'hybrid'
                        else:
                            raise ValueError('Hybrid Search embeddings incomplete; inspect failed chunks before retrying')
                    result[name] = {'status': 'ready', 'indexed_at': now(),
                                    'mode': mode, 'diagnostics': diagnostics,
                                    'documents': projection['sources'] if name == 'qmd' else projection['notes'],
                                    'fingerprint_schema': 2,
                                    'fingerprint': raw_fingerprint if name == 'qmd' else self.fingerprint(project_id, name)}
                except (ValueError, OSError) as exc:
                    result[name] = {'status': 'error', 'error': str(exc), 'checked_at': now()}
            self.store.set_meta('retrieval:' + project_id, result)
            return result

    def search(self, query: str, project_ids: list[str] | None = None, layer='all', engine='auto', limit=12,
               candidate_limit=40, read_limit=12, max_bytes=36000, per_hit_bytes=6000) -> dict:
        if layer not in {'all', 'raw', 'knowledge'} or engine not in {'auto', 'local', 'qmd', 'ohs'}:
            raise ValueError('Invalid retrieval layer or engine')
        query = query.strip()[:1000]
        if not query:
            return {'hits': [], 'engines': [], 'warnings': []}
        limit = max(1, min(limit, 40))
        candidate_limit = max(limit, min(candidate_limit, 160))
        read_limit = max(0, min(read_limit, limit))
        max_bytes, per_hit_bytes = max(0, min(max_bytes, 256000)), max(0, min(per_hit_bytes, 24000))
        started = time.perf_counter()
        ids = project_ids if project_ids is not None else [p['id'] for p in self.store.projects() if not p.get('synthetic')]
        if not ids:
            return {'hits': [], 'engines': [], 'warnings': []}
        for identifier in ids:
            self.store.project(identifier)
        local = self.knowledge.local_search(query, ids, layer, candidate_limit)
        lists = [[h for h in local if h['project_id'] == identifier
                  and h.get('channel', 'notes') == channel] for identifier in ids
                 for channel in ('notes', 'raw-incremental', 'raw-fulltext', 'fine-fulltext')]
        warnings, used, provider_metrics = [], ['local'], []
        for identifier in ids:
            project = self.store.project(identifier)
            status = self.project_status(identifier)
            for name in ('qmd', 'ohs'):
                if engine not in {'auto', name} or (name == 'qmd' and layer == 'knowledge') or (name == 'ohs' and layer == 'raw'):
                    continue
                if status.get(name, {}).get('status') != 'ready':
                    warnings.append(f"{project['name']}: {name} 尚未完成索引，使用本地检索。")
                    continue
                if status[name].get('stale'):
                    warnings.append(f"{project['name']}: {name} 索引已过期，请更新索引。")
                if status[name].get('mode') == 'empty':
                    continue
                try:
                    if name == 'qmd':
                        collection = ('semantic-' if status[name].get('diagnostics', {}).get('semantic_scope')
                                      == 'source-document-excerpts' else 'raw-') + identifier
                        output = self._run(name, ['__candidates__', collection, str(candidate_limit),
                                                 status[name]['mode'], query], identifier, timeout=90)
                    else:
                        output = self._run(name, ['--json', '--limit', str(candidate_limit), '--snippet-length', '0',
                                                 '--mode', status[name].get('mode', 'fulltext'), '--', query], identifier)
                    payload = json.loads(output)
                    if isinstance(payload, dict) and payload.get('metrics'):
                        provider_metrics.append({'project_id': identifier, 'engine': name,
                                                 **payload['metrics']})
                    rows = payload if isinstance(payload, list) else payload.get('results', [])
                    if name == 'qmd':
                        fine = self.store.meta('fine-retrieval:' + identifier, {})
                        if fine.get('semantic_ready'):
                            fine_payload = json.loads(self._run(
                                'qmd', ['__candidates__', 'fine-' + identifier, str(candidate_limit),
                                        'hybrid', query], identifier, timeout=90))
                            fine_rows = fine_payload.get('results', []) if isinstance(fine_payload, dict) else fine_payload
                            if isinstance(fine_payload, dict) and fine_payload.get('metrics'):
                                provider_metrics.append({'project_id': identifier, 'engine': name,
                                                         'scope': 'fine', **fine_payload['metrics']})
                            rows.extend({**r, 'fine': True} for r in fine_rows)
                    hits = []
                    for row in rows:
                        path = row.get('path') or row.get('file') or row.get('filepath', '')
                        if name == 'qmd':
                            sid = path.replace('\\', '/').rsplit('/', 1)[-1].removesuffix('.md')
                            if not re.fullmatch(r'[a-f0-9]{64}', sid):
                                continue
                            if row.get('fine'):
                                from .chunk_index import ChunkIndex
                                metadata = ChunkIndex(self.store).metadata(identifier, sid)
                                if metadata:
                                    hits.append({**metadata, 'id': sid, 'layer': 'raw', 'engine': name,
                                                 'fine': True, 'project_id': identifier,
                                                 'project': project['name']})
                                continue
                            metadata = self.store.query(
                                """SELECT id,locator AS path,locator AS title,revision FROM sources
                                   WHERE id=? AND project_id=? AND active=1""", (sid, identifier))
                            if not metadata:
                                continue
                            hit = {**metadata[0], 'layer': 'raw', 'chunk_pos': row.get('chunkPos')}
                        else:
                            path = path.replace('\\', '/')
                            metadata = self.store.query(
                                'SELECT path,title,revision FROM note_catalog WHERE project_id=? AND path=?',
                                (identifier, path))
                            if not metadata:
                                continue
                            hit = {**metadata[0], 'id': identifier + ':' + path, 'layer': 'knowledge'}
                        hits.append({**hit, 'engine': name, 'project_id': identifier, 'project': project['name']})
                    if name == 'qmd':
                        lists.extend([[h for h in hits if not h.get('fine')],
                                      [h for h in hits if h.get('fine')]])
                    else:
                        lists.append(hits)
                    used.append(name)
                except (ValueError, OSError, TypeError) as exc:
                    warnings.append(f'{name}: {exc}')
        # Reciprocal-rank fusion avoids comparing incompatible engine scores.
        merged = {}
        for hits in lists:
            seen_in_channel = set()
            for rank, hit in enumerate(hits, 1):
                # A raw part and its fine blocks are the same evidence address.
                # Keep the best block window rather than repeating the source.
                identity = (hit['project_id'], hit['layer'], hit.get('source_id', hit['id']))
                if identity in seen_in_channel:
                    continue
                seen_in_channel.add(identity)
                entry = merged.setdefault(identity, {**hit, 'score': 0.0, 'engines': []})
                if hit.get('fine') and not entry.get('fine'):
                    score, engine_names = entry['score'], entry['engines']
                    entry.update(hit)
                    entry['score'], entry['engines'] = score, engine_names
                entry['score'] += 1 / (60 + rank)
                if hit['engine'] not in entry['engines']:
                    entry['engines'].append(hit['engine'])
        hits = sorted(merged.values(), key=lambda h: (-h['score'], h['id']))[:limit]
        read_count, used_bytes, cache_hits = 0, 0, 0
        for hit in hits:
            hit['content'], hit['body_loaded'] = '', False
            hit['source_id'] = hit.get('source_id', hit['id']) if hit['layer'] == 'raw' else None
            if read_count >= read_limit or used_bytes >= max_bytes:
                continue
            budget = min(per_hit_bytes, max_bytes - used_bytes)
            if budget <= 0:
                continue
            key = (hit['id'], hit['revision'], query, budget)
            body = self.body_cache.get(key) if hit['layer'] == 'raw' else None
            if body is not None:
                cache_hits += 1
                cached = json.loads(body)
                body = cached['body']
                if cached.get('position'):
                    hit['position'] = cached['position']
            elif hit.get('fine'):
                from .chunk_index import ChunkIndex
                block = ChunkIndex(self.store).read(hit['project_id'], hit['id'],
                                                   max_chars=min(3000, budget))
                body = clip_bytes(block['content'], budget)
                hit['position'] = {**block['position'], 'end': block['position']['start'] + len(body)}
                self.body_cache.put(key, json.dumps({'body': body, 'position': hit['position']}))
            elif hit['layer'] == 'raw':
                with self.store.connection() as db:
                    # Only bounded text crosses the persistence boundary.
                    row = db.execute(
                        """WITH selected AS (SELECT json_extract(data,'$.content') AS body FROM sources
                           WHERE id=? AND project_id=? AND active=1)
                           SELECT substr(body,MAX(1,instr(lower(body),lower(?))-500),?) AS excerpt,
                                  MAX(0,instr(lower(body),lower(?))-501) AS start
                           FROM selected""",
                        (hit['id'], hit['project_id'], query, min(3000, budget), query)).fetchone()
                if row is None:
                    continue
                body = clip_bytes(row['excerpt'], budget)
                hit['position'] = {'source_id': hit['id'], 'start': row['start'],
                                   'end': row['start'] + len(body), 'unit': 'snapshot-character'}
                self.body_cache.put(key, json.dumps({'body': body, 'position': hit['position']}))
            else:
                from .vault import Vault
                vault = Vault(self.store.project(hit['project_id']), self.store.home)
                target = vault.resolve(hit['path'])
                if not target.is_file():
                    continue
                signature = self.store.meta('note-signature:' + hit['project_id'] + ':' + hit['path'])
                stat = target.stat()
                if signature != [stat.st_mtime_ns, stat.st_size]:
                    warnings.append(f"{hit['project']}: 命中笔记的文件状态已有变化，请更新索引。")
                    self.store.set_meta('knowledge_changed:' + hit['project_id'], now())
                with target.open('rb') as stream:
                    raw = stream.read(budget)
                body = clip_bytes(raw.decode('utf-8-sig', errors='ignore'), budget)
            hit['content'], hit['body_loaded'] = body, True
            used_bytes += len(body.encode('utf-8'))
            read_count += 1
        return {'hits': hits, 'engines': list(dict.fromkeys(used)), 'warnings': warnings,
                'metrics': {'candidates': sum(map(len, lists)), 'unique_candidates': len(merged),
                            'bodies_read': read_count - cache_hits, 'bodies_loaded': read_count,
                            'cache_hits': cache_hits, 'returned_bytes': used_bytes,
                            'max_bytes': max_bytes, 'candidate_limit': candidate_limit,
                            'read_limit': read_limit, 'providers': provider_metrics,
                            'seconds': time.perf_counter() - started}}
