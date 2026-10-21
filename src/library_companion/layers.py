"""Read-only originals -> automatic cross-source materials -> reviewed abstractions.

Jobs pin input windows; results and citations are immutable. A completed empty
job records examined windows, not fictitious knowledge or blanket file coverage.
"""

from __future__ import annotations

from collections import defaultdict, deque

import portalocker
from pydantic import BaseModel, ConfigDict, Field

from .knowledge import Knowledge, knowledge_dir, unpack
from .models import Candidate, Kind, Submission, clean_text
from .store import Store, encode, now
from .vault import clean_title, digest

RECIPE = 'cross-source-v1'


class Citation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_id: str
    quote: str = Field(min_length=1, max_length=4000)


class Material(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=24000)
    kind: Kind = 'knowledge'
    uncertain: bool = False
    citations: list[Citation] = Field(min_length=1, max_length=20)
    derived_from: list[str] = Field(default_factory=list, max_length=8)


class Abstraction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=24000)
    kind: Kind = 'knowledge'
    uncertain: bool = False
    extraction_ids: list[str] = Field(min_length=1, max_length=20)


class Layers:
    def __init__(self, store: Store):
        self.store = store
        self.knowledge = Knowledge(store)

    def _lock(self, key: str):
        folder = self.store.home / 'locks'
        folder.mkdir(exist_ok=True)
        return portalocker.Lock(str(folder / ('layers-' + digest(key)[:32] + '.lock')), timeout=5)

    def _row(self, table: str, identifier: str) -> dict:
        if table not in {'synthesis_jobs', 'extractions', 'abstractions'}:
            raise ValueError('Invalid layer')
        rows = self.store.query(f'SELECT * FROM {table} WHERE id=?', (identifier,))
        if not rows:
            raise ValueError('Layer record does not exist')
        return unpack(rows[0])

    def extraction(self, identifier: str) -> dict:
        return self._row('extractions', identifier)

    def abstraction(self, identifier: str) -> dict:
        record = self._row('abstractions', identifier)
        if record.get('proposal_id'):
            record['status'] = self.store.proposal(record['proposal_id'])['status']
        return record

    def jobs(self, project_id: str) -> list[dict]:
        self.store.project(project_id)
        return [unpack(r) for r in self.store.query(
            'SELECT * FROM synthesis_jobs WHERE project_id=? ORDER BY created_at,id', (project_id,))]

    def _coverage(self, project_id: str, reserve=True) -> dict[str, int]:
        spans = defaultdict(list)
        for job in self.jobs(project_id):
            if job['phase'] != 'extraction' or job['status'] == 'error':
                continue
            if not reserve and job['status'] != 'completed':
                continue
            for window in job.get('windows', []):
                spans[window['source_id']].append((window['start_char'], window['end_char']))
        ends = {}
        for sid, parts in spans.items():
            end = 0
            for start, stop in sorted(parts):
                if start > end:
                    break
                end = max(end, stop)
            ends[sid] = end
        return ends

    def source_progress(self, project_id: str) -> dict[str, int]:
        return self._coverage(project_id, reserve=False)

    def latest_materials(self, project_id: str, limit=100) -> list[dict]:
        self.store.project(project_id)
        rows = self.store.query(
            """SELECT * FROM extractions e WHERE project_id=? AND NOT EXISTS (
                SELECT 1 FROM extractions next,json_each(next.data,'$.derived_from') parent
                WHERE next.project_id=e.project_id AND parent.value=e.id)
                ORDER BY created_at DESC,id LIMIT ?""", (project_id, limit))
        return [unpack(r) for r in rows]

    def overview(self, project_id: str) -> dict:
        self.store.project(project_id)
        progress = self.source_progress(project_id)
        sources = self.store.query(
            "SELECT id,length(json_extract(data,'$.content')) AS chars FROM sources WHERE project_id=? AND active=1",
            (project_id,))
        return {'extractions': self.latest_materials(project_id),
                'abstractions': [self.abstraction(r['id']) for r in self.store.query(
                    'SELECT * FROM abstractions WHERE project_id=? ORDER BY created_at DESC LIMIT 100', (project_id,))],
                'jobs': self.jobs(project_id)[-100:],
                'processed_sources': sum(progress.get(s['id'], 0) >= s['chars'] for s in sources),
                'pending_sources': sum(progress.get(s['id'], 0) < s['chars'] for s in sources)}

    def prepare(self, project_id: str, source_ids: list[str] | None = None, limit=8) -> dict:
        self.store.project(project_id)
        if not 1 <= limit <= 20:
            raise ValueError('Choose between 1 and 20 input windows')
        with self._lock('prepare:' + project_id):
            return self._prepare(project_id, source_ids, limit)

    def _prepare(self, project_id, source_ids, limit):
        reserved = self._coverage(project_id)
        rows = self.store.query(
            """SELECT id,locator,kind,revision,length(json_extract(data,'$.content')) AS chars,
                COALESCE(json_extract(data,'$.origin'),locator) AS origin
                FROM sources WHERE project_id=? AND active=1 ORDER BY locator,created_at""", (project_id,))
        if source_ids is not None:
            requested = set(source_ids)
            if not requested or len(requested) > limit:
                raise ValueError('Explicit sources must fit the input window limit')
            if not requested.issubset({s['id'] for s in rows}):
                raise ValueError('Selected source is absent, inactive or belongs to another project')
            rows = [s for s in rows if s['id'] in requested]
        rows = [s for s in rows if reserved.get(s['id'], 0) < s['chars']]
        # Round-robin origins and kinds, instead of consuming every part of the
        # first alphabetic file before reaching a conversation or another file.
        groups = defaultdict(deque)
        for source in rows:
            groups[(source['kind'], source['origin'])].append(source)
        kinds = defaultdict(deque)
        for key in sorted(groups):
            kinds[key[0]].append(key)
        selected = []
        while kinds and len(selected) < limit:
            for kind in list(kinds):
                key = kinds[kind].popleft()
                selected.append(groups[key].popleft())
                if groups[key]:
                    kinds[kind].append(key)
                if not kinds[kind]:
                    del kinds[kind]
                if len(selected) == limit:
                    break
        if not selected:
            raise ValueError('No new source windows to synthesize')
        bound = self.store.meta('model_settings', {}).get('max_input_chars', 16000)
        if bound < 8000:
            raise ValueError('Cross-source extraction requires max_input_chars of at least 8000')
        per_source = max(100, (bound - 6000) // len(selected))
        windows = [{'source_id': s['id'], 'start_char': reserved.get(s['id'], 0),
                    'end_char': min(s['chars'], reserved.get(s['id'], 0) + per_source)} for s in selected]
        previous = self.latest_materials(project_id, 6)
        data = {'phase': 'extraction', 'recipe': RECIPE, 'windows': windows,
                'source_ids': [s['id'] for s in selected], 'extraction_ids': [e['id'] for e in previous],
                'result_ids': [], 'proposal_ids': [], 'attempts': 0}
        return self._create_job(project_id, data)

    def _create_job(self, project_id, data):
        identifier = digest(encode([project_id, data]))
        self.store.execute('INSERT OR IGNORE INTO synthesis_jobs VALUES(?,?,?,?,?)',
                           (identifier, project_id, 'needs_model', now(), encode(data)))
        return self.context(identifier)

    def prepare_abstraction(self, project_id: str, extraction_ids: list[str] | None = None, limit=8) -> dict:
        self.store.project(project_id)
        if not 1 <= limit <= 20:
            raise ValueError('Choose between 1 and 20 extractions')
        with self._lock('prepare:' + project_id):
            used = {e for job in self.jobs(project_id) if job['phase'] == 'abstraction' and job['status'] != 'error'
                    for e in job['extraction_ids']}
            if extraction_ids is None:
                # One new material can be compared with earlier materials again.
                available = self.latest_materials(project_id, 100)
                fresh = [e for e in available if e['id'] not in used]
                if not fresh:
                    raise ValueError('No new materials to abstract')
                chosen = fresh[:limit]
                chosen += [e for e in available if e not in chosen][:limit - len(chosen)]
            else:
                if not extraction_ids or len(set(extraction_ids)) > limit:
                    raise ValueError('Choose a nonempty bounded set of extractions')
                chosen = [self.extraction(e) for e in dict.fromkeys(extraction_ids)]
            if any(e['project_id'] != project_id or e['status'] != 'ready' for e in chosen):
                raise ValueError('Extraction is absent or belongs to another project')
            bound = self.store.meta('model_settings', {}).get('max_input_chars', 16000)
            bounded, size = [], 0
            for material in chosen:
                cost = len(encode({k: material[k] for k in ('id', 'title', 'content', 'uncertain')})) + 2
                if size + cost > bound - 4000:
                    if extraction_ids is not None or not bounded:
                        raise ValueError('Full abstraction materials exceed model input bound; increase max_input_chars')
                    break
                bounded.append(material)
                size += cost
            chosen = bounded
            data = {'phase': 'abstraction', 'recipe': RECIPE, 'windows': [], 'source_ids': [],
                    'extraction_ids': [e['id'] for e in chosen], 'result_ids': [], 'proposal_ids': [], 'attempts': 0}
            return self._create_job(project_id, data)

    def context(self, job_id: str) -> dict:
        job = self._row('synthesis_jobs', job_id)
        sources = []
        for window in job['windows']:
            source = self.knowledge.source(window['source_id'])
            sources.append({k: source[k] for k in ('id', 'locator', 'revision', 'kind')} | {
                'origin': source.get('origin', source['locator']), **window,
                'content': source['content'][window['start_char']:window['end_char']]})
        return job | {'sources': sources, 'extractions': [self.extraction(e) for e in job['extraction_ids']]}

    def payload(self, job_id: str) -> dict:
        job = self.context(job_id)
        if job['phase'] == 'extraction':
            return {'phase': 'extraction', 'project_id': job['project_id'], 'sources': job['sources'],
                    'previous_materials': [{'id': e['id'], 'title': e['title'], 'content': e['content'][:500],
                                            'uncertain': e['uncertain']} for e in job['extractions']]}
        return {'phase': 'abstraction', 'project_id': job['project_id'],
                'extractions': [{'id': e['id'], 'title': e['title'], 'content': e['content'],
                                 'uncertain': e['uncertain']} for e in job['extractions']]}

    def submit(self, job_id: str, items: list[dict]) -> list[dict]:
        with self._lock('job:' + job_id):
            job = self.context(job_id)
            table = 'extractions' if job['phase'] == 'extraction' else 'abstractions'
            if job['status'] == 'completed':
                return [self._row(table, i) for i in job['result_ids']]
            if not isinstance(items, list) or len(items) > 8:
                raise ValueError('Return a list of at most 8 synthesized results')
            results = (self._materials(job, items) if job['phase'] == 'extraction'
                       else self._abstract(job, items))
            data = {k: v for k, v in job.items() if k not in {'id', 'project_id', 'status', 'created_at', 'sources', 'extractions'}}
            data.update(result_ids=[r['id'] for r in results], completed_at=now(),
                        proposal_ids=[r['proposal_id'] for r in results if 'proposal_id' in r])
            with self.store.connection() as db:
                for result in results:
                    db.execute(f'INSERT OR IGNORE INTO {table} VALUES(?,?,?,?,?)',
                               (result['id'], job['project_id'], result['status'], now(), encode(result)))
                    if table == 'extractions':
                        db.executemany('INSERT OR IGNORE INTO extraction_evidence VALUES(?,?)',
                                       [(result['id'], c['source_id']) for c in result['citations']])
                    else:
                        db.executemany('INSERT OR IGNORE INTO abstraction_extractions VALUES(?,?)',
                                       [(result['id'], e) for e in result['extraction_ids']])
                        db.executemany('INSERT OR IGNORE INTO knowledge_evidence VALUES(?,?)',
                                       [(result['proposal_id'], c['source_id']) for c in result['citations']])
                db.execute("UPDATE synthesis_jobs SET status='completed',data=? WHERE id=?", (encode(data), job_id))
            return [self._row(table, r['id']) for r in results]

    def _materials(self, job, items):
        sources = {s['id']: s for s in job['sources']}
        previous = {e['id']: e for e in job['extractions']}
        available_origins = {s['origin'] for s in job['sources']}
        for extraction in previous.values():
            available_origins.update(c['origin'] for c in extraction['citations'])
        results = []
        for item in items:
            value = Material.model_validate(item).model_dump()
            clean_text(value['content'])
            if not set(value['derived_from']).issubset(previous):
                raise ValueError('Prior material must be pinned by this job')
            citations = []
            for citation in value['citations']:
                source = sources.get(citation['source_id'])
                if not source or citation['quote'] not in source['content'] or not citation['quote'].strip():
                    raise ValueError('Every citation must quote its own pinned source window exactly')
                start = source['start_char'] + source['content'].index(citation['quote'])
                citations.append(citation | {'start_char': start, 'end_char': start + len(citation['quote']),
                                            'locator': source['locator'], 'revision': source['revision'],
                                            'origin': source['origin']})
            for identifier in value['derived_from']:
                citations.extend(previous[identifier]['citations'])
                value['uncertain'] |= previous[identifier]['uncertain']
            citations = list({encode(c): c for c in citations}.values())
            origins = {c['origin'] for c in citations}
            if len(available_origins) > 1 and len(origins) < 2:
                raise ValueError('Cross-source materials must synthesize at least two distinct files or conversations')
            # Reuse Candidate's title/control-character rules without accepting
            # file targets or links in this automatic, internal material layer.
            Candidate(title=value['title'], content=value['content'], source=value['citations'][0]['quote'])
            value.update(citations=citations, source_ids=sorted({c['source_id'] for c in citations}),
                         scope='cross_source' if len(origins) > 1 else 'single_source', job_id=job['id'], status='ready')
            value['id'] = digest(encode([job['id'], value]))
            results.append(value)
        self._unique(results)
        return results

    def _abstract(self, job, items):
        from .service import Service

        pinned = {e['id']: e for e in job['extractions']}
        project = self.store.project(job['project_id'])
        values, candidates = [], []
        for item in items:
            value = Abstraction.model_validate(item).model_dump()
            value['extraction_ids'] = list(dict.fromkeys(value['extraction_ids']))
            if not set(value['extraction_ids']).issubset(pinned):
                raise ValueError('Abstraction must cite only pinned second-layer materials')
            evidence = []
            for identifier in value['extraction_ids']:
                material = pinned[identifier]
                evidence.extend(material['citations'])
                value['uncertain'] |= material['uncertain']
            evidence = list({encode(c): c for c in evidence}.values())
            source = '\n\n'.join('extraction:' + i for i in value['extraction_ids'])
            source += '\n\n' + '\n\n'.join(c['quote'] + '\nsource:' + c['source_id']
                + f" | {c['locator']} | sha256:{c['revision']} | chars:{c['start_char']}:{c['end_char']}" for c in evidence)
            target = knowledge_dir(project) + '/abstractions/' + clean_title(value['title']) + '.md'
            candidate = Candidate(**{k: value[k] for k in ('title', 'content', 'kind', 'uncertain')},
                                  source=source, target=target)
            value.update(citations=evidence, source_ids=sorted({c['source_id'] for c in evidence}),
                         job_id=job['id'], status='pending')
            value['id'] = digest(encode([job['id'], value]))
            values.append(value)
            candidates.append(candidate)
        self._unique(values)
        if candidates:
            proposals = Service(self.store).submit(Submission(project_id=project['id'],
                session_id='abstraction:' + job['id'], candidates=candidates))
            for value, proposal in zip(values, proposals, strict=True):
                value['proposal_id'] = proposal['id']
        return values

    @staticmethod
    def _unique(results):
        if len({r['id'] for r in results}) != len(results):
            raise ValueError('Duplicate results in one layer submission')

    def trace(self, identifier: str, layer='abstraction') -> dict:
        if layer == 'extraction':
            record = self.extraction(identifier)
            materials = [record]
        elif layer == 'abstraction':
            record = self.abstraction(identifier)
            materials = [self.extraction(e) for e in record['extraction_ids']]
        else:
            raise ValueError('Trace layer must be extraction or abstraction')
        sources = {c['source_id']: self.knowledge.source(c['source_id']) for e in materials for c in e['citations']}
        return {'layer': layer, 'record': record, 'extractions': materials, 'sources': list(sources.values())}

    def proposal_trace(self, proposal_id: str) -> list[dict]:
        return [self.trace(r['id']) for r in self.store.query(
            "SELECT id FROM abstractions WHERE json_extract(data,'$.proposal_id')=?", (proposal_id,))]
