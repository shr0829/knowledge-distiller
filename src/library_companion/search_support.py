"""Inverted-index recall and bounded, versioned body access."""
from __future__ import annotations

import re
import sqlite3
from collections import OrderedDict
from contextlib import closing

from .store import Store

CJK = re.compile(r'[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+')


def normalize(text: str) -> str:
    return CJK.sub(lambda m: ' ' + ' '.join(m[0]) + ' ', text)


def match_query(query: str) -> str:
    # Queries are data, never raw FTS syntax. Preserve phrases and allow partial
    # natural-language recall. Bigrams are useful for unsegmented Chinese.
    terms = []
    for token in re.findall(r'[\w]+', query.casefold())[:16]:
        if CJK.fullmatch(token) and len(token) > 3:
            terms.append(normalize(token))
            terms.extend(normalize(token[i:i + 2]) for i in range(0, len(token) - 1, 2))
        else:
            terms.append(normalize(token))
    terms = list(dict.fromkeys(terms))[:32]
    return ' OR '.join('"' + term.replace('"', '""') + '"' for term in terms)


def index_source(db, source_id: str, locator: str, project_id: str, content: str):
    row = db.execute('SELECT rowid FROM sources WHERE id=?', (source_id,)).fetchone()
    db.execute('DELETE FROM source_fts WHERE rowid=?', (row[0],))
    db.execute('INSERT INTO source_fts(rowid,locator,body,scope) VALUES(?,?,?,?)',
               (row[0], normalize(locator), normalize(content), project_id))


def source_candidates(store: Store, query: str, project_id: str, limit: int) -> list[dict]:
    expression = match_query(query)
    if not expression:
        return []
    scoped = 'scope : "' + project_id + '" AND ({locator body} : (' + expression + '))'
    with store.connection() as db:
        return [dict(row) for row in db.execute(
            """SELECT s.id,s.project_id,s.locator AS path,s.locator AS title,s.revision,
                      'raw' AS layer,bm25(source_fts) AS rank
               FROM source_fts JOIN sources s ON s.rowid=source_fts.rowid
               WHERE source_fts MATCH ? AND s.active=1 AND s.project_id=?
               ORDER BY rank LIMIT ?""", (scoped, project_id, limit))]


def qmd_lexical_candidates(store: Store, query: str, project_id: str, limit: int,
                           prefix='raw-') -> list[dict]:
    """Use the existing full raw index, returning no indexed bodies."""
    path = store.home / 'retrieval/cache/qmd/index.sqlite'
    expression = match_query(query)
    if not path.is_file() or not expression:
        return []
    collection = prefix + project_id
    scoped = 'filepath : "' + collection + '" AND ({title body} : (' + expression + '))'
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=20)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            """SELECT d.path,bm25(documents_fts,1.5,4.0,1.0) AS rank
               FROM documents_fts JOIN documents d ON d.id=documents_fts.rowid
               WHERE documents_fts MATCH ? AND d.collection=? AND d.active=1
               ORDER BY rank LIMIT ?""", (scoped, collection, limit)).fetchall()
    ids = [r['path'].removesuffix('.md') for r in rows
           if re.fullmatch(r'[a-f0-9]{64}\.md', r['path'])]
    if not ids:
        return []
    if prefix == 'fine-':
        metadata = {r['id']: r for r in store.query(
            f"""SELECT c.*,s.locator AS path,s.locator AS title,'raw' AS layer
                FROM retrieval_chunks c JOIN sources s ON s.id=c.source_id AND s.active=1
                WHERE c.project_id=? AND c.id IN ({','.join('?' for _ in ids)})""",
            (project_id, *ids))}
        return [{**metadata[sid], 'fine': True} for sid in ids if sid in metadata]
    metadata = {r['id']: r for r in store.query(
        f"""SELECT id,project_id,locator AS path,locator AS title,revision,'raw' AS layer
            FROM sources WHERE project_id=? AND active=1 AND id IN ({','.join('?' for _ in ids)})""",
        (project_id, *ids))}
    return [metadata[sid] for sid in ids if sid in metadata]


class ByteCache:
    def __init__(self, capacity=32 * 1024 * 1024):
        self.capacity, self.bytes = capacity, 0
        self.entries = OrderedDict()

    def get(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return None
        self.entries.move_to_end(key)
        return entry[0]

    def put(self, key, text: str):
        weight = len(text.encode('utf-8')) + len(repr(key).encode('utf-8')) + 256
        if key in self.entries:
            self.bytes -= self.entries.pop(key)[1]
        if weight > self.capacity:
            return
        while self.entries and self.bytes + weight > self.capacity:
            self.bytes -= self.entries.popitem(last=False)[1][1]
        self.entries[key] = (text, weight)
        self.bytes += weight


def clip_bytes(text: str, maximum: int) -> str:
    return text.encode('utf-8')[:max(0, maximum)].decode('utf-8', errors='ignore')


def natural_blocks(content: str, maximum=1800, overlap=160) -> list[dict]:
    """Ranges reference an immutable storage snapshot; no evidence is rewritten."""
    if not 0 <= overlap < maximum:
        raise ValueError('Invalid block overlap')
    blocks, start = [], 0
    headings = list(re.finditer(r'(?m)^(?:#{1,6}\s+|(?:async\s+)?def\s+|class\s+|function\s+|(?:user|assistant):)', content))
    while start < len(content):
        end = min(len(content), start + maximum)
        if end < len(content):
            lower = start + maximum // 2
            boundaries = [m.start() for m in headings if lower <= m.start() <= end]
            paragraph = content.rfind('\n\n', lower, end)
            newline = content.rfind('\n', lower, end)
            boundary = max([*boundaries, paragraph, newline])
            if boundary >= lower:
                end = boundary
        parent = next((m for m in reversed(headings) if m.start() <= start), None)
        line_end = content.find('\n', parent.start()) if parent else -1
        section = content[parent.start():line_end if line_end >= 0 else len(content)] if parent else ''
        blocks.append({'start': start, 'end': end, 'section': section[:200],
                       'line_start': content.count('\n', 0, start) + 1,
                       'line_end': content.count('\n', 0, end) + 1})
        if end == len(content):
            break
        start = max(start + 1, end - overlap)
    return blocks
