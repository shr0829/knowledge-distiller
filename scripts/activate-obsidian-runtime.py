"""Install an official downloaded app archive using Obsidian's updater location."""

import gzip
import hashlib
import os
from pathlib import Path

source = Path('work/knowledge-integration/obsidian-1.14.4.asar.gz')
target = Path(os.environ['APPDATA']) / 'obsidian/obsidian-1.14.4.asar'
target.parent.mkdir(parents=True, exist_ok=True)
content = gzip.decompress(source.read_bytes())
target.write_bytes(content)
print('Obsidian runtime archive:', len(content), hashlib.sha256(content).hexdigest())
