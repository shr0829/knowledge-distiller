"""Download public local model artifacts without uploading vault content."""

import hashlib
import os
import sys
from pathlib import Path

import httpx

sys.stdout.reconfigure(encoding='utf-8')
base = 'https://hf-mirror.com'
root = Path.home() / '.cache/huggingface/Xenova/multilingual-e5-small'
files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
         'onnx/model_quantized.onnx']
with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(60, read=60)) as client:
    for filename in files:
        destination = root / filename
        if destination.exists() and destination.stat().st_size > 0:
            print('Cached:', filename, flush=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_suffix(destination.suffix + '.partial')
        with client.stream('GET', base + '/Xenova/multilingual-e5-small/resolve/main/' + filename) as response:
            response.raise_for_status()
            expected = int(response.headers.get('content-length', 0))
            written = 0
            with partial.open('wb') as output:
                for chunk in response.iter_bytes():
                    output.write(chunk)
                    written += len(chunk)
            if expected and written != expected:
                raise ValueError('Incomplete model download')
        os.replace(partial, destination)
        print(filename, written, 'sha256=' + hashlib.sha256(destination.read_bytes()).hexdigest(), flush=True)
    if '--qmd' in sys.argv:
        destination = Path('.library/retrieval/cache/qmd/models/embeddinggemma-300M-Q8_0.gguf').resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            partial = destination.with_suffix('.gguf.partial')
            with client.stream('GET', base + '/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf') as response:
                response.raise_for_status()
                written = 0
                with partial.open('wb') as output:
                    for chunk in response.iter_bytes():
                        output.write(chunk)
                        written += len(chunk)
                expected = int(response.headers.get('content-length', 0))
                if expected and written != expected:
                    raise ValueError('Incomplete QMD model download')
            os.replace(partial, destination)
            print('QMD embedding model', written, flush=True)
