"""Run bounded fine-index batches; repeat to resume without replacing evidence."""
import argparse
import json
import sys

from library_companion.retrieval import Retrieval
from library_companion.store import Store

parser = argparse.ArgumentParser()
parser.add_argument('project', help='Configured project name or ID')
parser.add_argument('--batches', type=int, default=1)
parser.add_argument('--batch-size', type=int, default=100)
parser.add_argument('--fulltext-only', action='store_true')
options = parser.parse_args()
sys.stdout.reconfigure(encoding='utf-8')
store = Store()
matches = [p for p in store.projects() if options.project in {p['id'], p['name']}]
if len(matches) != 1:
    raise ValueError('Select one configured project by its exact name or ID')
retrieval = Retrieval(store)
for batch in range(max(1, options.batches)):
    result = retrieval.index_chunks(matches[0]['id'], options.batch_size, not options.fulltext_only)
    print(json.dumps({'project': matches[0]['name'], 'batch': batch + 1, **result},
                     ensure_ascii=False), flush=True)
    if result['status'] == 'complete' or (options.fulltext_only and result['complete']):
        break
