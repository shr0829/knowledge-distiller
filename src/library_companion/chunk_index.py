"""Resumable structural retrieval blocks, separate from immutable storage parts."""
from __future__ import annotations

from .search_support import natural_blocks
from .store import Store, now
from .vault import digest

RECIPE = 'natural-1800-overlap160-v1'


class ChunkIndex:
    def __init__(self, store: Store):
        self.store = store

    def prepare(self, project_id: str, batch_size=100) -> dict:
        self.store.project(project_id)
        folder = self.store.home / 'retrieval' / project_id / 'fine'
        folder.mkdir(parents=True, exist_ok=True)
        # Seek through unprocessed immutable IDs. The committed manifest is the
        # cursor, so interrupted batches are safe to repeat.
        rows = self.store.query(
            """SELECT s.id,s.revision,s.locator,s.data FROM sources s
               LEFT JOIN retrieval_chunk_sources m ON m.source_id=s.id AND m.recipe=?
               WHERE s.project_id=? AND s.active=1 AND m.source_id IS NULL
               ORDER BY s.id LIMIT ?""", (RECIPE, project_id, max(0, min(batch_size, 1000))))
        for source in rows:
            content = source['data']['content']
            blocks = natural_blocks(content)
            manifest = []
            for block in blocks:
                identifier = digest(f"{source['id']}:{RECIPE}:{block['start']}:{block['end']}")
                target = folder / (identifier + '.md')
                # Title and parent are embedding context; immutable evidence is
                # addressed using the manifest's offsets, never this projection.
                body = '# ' + source['locator'] + '\n' + block['section'] + '\n\n' + content[block['start']:block['end']]
                if not target.is_file() or target.read_text(encoding='utf-8') != body:
                    target.write_text(body, encoding='utf-8', newline='\n')
                manifest.append((identifier, project_id, source['id'], source['revision'],
                                 source['data'].get('origin', source['locator']),
                                 block['start'], block['end'], block['line_start'], block['line_end'],
                                 block['section'], RECIPE))
            with self.store.connection() as db:
                db.executemany('INSERT OR REPLACE INTO retrieval_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)', manifest)
                db.execute('INSERT OR REPLACE INTO retrieval_chunk_sources VALUES(?,?,?,?)',
                           (source['id'], project_id, RECIPE, now()))
        with self.store.connection() as db:
            # Retirement is indexed metadata work, performed only during build.
            inactive = db.execute(
                """SELECT c.id FROM retrieval_chunks c JOIN sources s ON s.id=c.source_id
                   WHERE c.project_id=? AND (s.active=0 OR c.recipe<>?)""", (project_id, RECIPE)).fetchall()
            for row in inactive:
                target = folder / (row['id'] + '.md')
                if target.is_file():
                    target.unlink()
            db.execute("""DELETE FROM retrieval_chunks WHERE project_id=? AND
                          (recipe<>? OR source_id IN (SELECT id FROM sources WHERE active=0 AND project_id=?))""",
                       (project_id, RECIPE, project_id))
            total = db.execute('SELECT count(*) FROM sources WHERE project_id=? AND active=1',
                               (project_id,)).fetchone()[0]
            prepared = db.execute(
                """SELECT count(*) FROM retrieval_chunk_sources m JOIN sources s ON s.id=m.source_id
                   WHERE m.project_id=? AND m.recipe=? AND s.active=1""", (project_id, RECIPE)).fetchone()[0]
            count = db.execute('SELECT count(*) FROM retrieval_chunks WHERE project_id=? AND recipe=?',
                               (project_id, RECIPE)).fetchone()[0]
        return {'path': str(folder), 'recipe': RECIPE, 'storage_parts': total,
                'prepared_parts': prepared, 'new_parts': len(rows), 'blocks': count,
                'complete': prepared == total}

    def metadata(self, project_id: str, block_id: str) -> dict | None:
        rows = self.store.query(
            """SELECT c.*,s.locator AS path,s.locator AS title FROM retrieval_chunks c
               JOIN sources s ON s.id=c.source_id AND s.active=1
               WHERE c.id=? AND c.project_id=?""", (block_id, project_id))
        return rows[0] if rows else None

    def read(self, project_id: str, block_id: str, max_chars=3000, neighbors=0) -> dict:
        """Expand within this pinned storage part, without loading its full body."""
        meta = self.metadata(project_id, block_id)
        if not meta:
            raise ValueError('Active retrieval block does not exist in this project')
        neighbors = max(0, min(neighbors, 2))
        start, end = meta['start_char'], meta['end_char']
        if neighbors:
            with self.store.connection() as db:
                ranges = db.execute(
                    """SELECT start_char,end_char FROM retrieval_chunks WHERE source_id=? AND recipe=?
                       AND start_char>=? AND start_char<=? ORDER BY start_char""",
                    (meta['source_id'], meta['recipe'], max(0, start - neighbors * 1800),
                     start + neighbors * 1800)).fetchall()
            start = min([start, *[r['start_char'] for r in ranges]])
            end = max([end, *[r['end_char'] for r in ranges]])
        bound = max(0, min(max_chars, 12000))
        expanded_start, expanded_end = start, end
        if meta['end_char'] - meta['start_char'] <= bound:
            # Neighbor expansion may not displace the actual matching block.
            start = max(start, meta['end_char'] - bound)
        else:
            start = meta['start_char']
        end = min(end, start + bound)
        with self.store.connection() as db:
            body = db.execute(
                """SELECT substr(json_extract(data,'$.content'),?,?) FROM sources
                   WHERE id=? AND project_id=? AND active=1""",
                (start + 1, end - start, meta['source_id'], project_id)).fetchone()
        if body is None:
            raise ValueError('Source retired during block read')
        return {**meta, 'content': body[0], 'position': {'start': start, 'end': end,
                'unit': 'snapshot-character'},
                'truncated': start > expanded_start or end < expanded_end}
