"""Save quality comparisons without storing source text."""
import json
import sys
from pathlib import Path

from library_companion.retrieval import Retrieval
from library_companion.store import Store

sys.stdout.reconfigure(encoding='utf-8')
store, retrieval = Store(), Retrieval(Store())
before = json.loads(Path('work/retrieval-optimization/before.json').read_text(encoding='utf-8'))
rows = []
for old in before['results'][::2]:
    project = next(p for p in store.projects() if p['name'] == old['project'])
    result = retrieval.search(old['question'], [project['id']], 'raw', 'local', 40, read_limit=0)
    winners = [h.get('source_id', h['id']) for h in result['hits']]
    preserved = len(set(old['hits']) & set(winners))
    rows.append({'project': old['project'], 'query': old['question'],
                 'baseline_hits_at_8': len(old['hits']),
                 'baseline_preserved_in_new_at_8': len(set(old['hits']) & set(winners[:8])),
                 'baseline_preserved_in_new_at_40': preserved,
                 'new_candidates_at_40': len(winners),
                 'baseline_preservation_at_40': preserved / max(1, len(old['hits']))})
Path('work/retrieval-optimization/ranking-comparison.json').write_text(
    json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(rows, ensure_ascii=False))
