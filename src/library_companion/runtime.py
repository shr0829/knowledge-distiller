"""Build identity shared by the HTTP workbench and MCP resource."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_REVISION = hashlib.sha256(b''.join(
    p.read_bytes() for p in sorted((ROOT / 'src/library_companion').glob('*.py'))
)).hexdigest()[:12]


def build_id() -> str:
    path = ROOT / 'frontend/build-info.json'
    if path.is_file():
        return json.loads(path.read_text(encoding='utf-8'))['build_id']
    return 'unbuilt'


def runtime_info() -> dict:
    return {'build_id': build_id(), 'process_id': os.getpid(),
            'backend_revision': BACKEND_REVISION}
