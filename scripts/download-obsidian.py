"""Download the official release asset in resumable ranges and verify its digest."""
import concurrent.futures
import hashlib
import json
import time
from pathlib import Path

import httpx

api = "https://api.github.com/repos/obsidianmd/obsidian-releases/releases"
root = Path("work/knowledge-integration")
with httpx.Client(follow_redirects=True, timeout=60) as client:
    release = client.get(api + "/latest").raise_for_status().json()
    asset = next(a for a in release["assets"] if a["name"].startswith("Obsidian-") and a["name"].endswith(".exe"))
    redirect = client.get(asset["url"] + "?download=parallel", headers={"Accept": "application/octet-stream"},
                          follow_redirects=False)
    assert redirect.status_code == 302
    location = redirect.headers["location"]

parts = root / ("download-" + release["tag_name"])
parts.mkdir(exist_ok=True)
size = asset["size"]
chunk = 4 * 1024 * 1024


def fetch(index):
    start, end = index * chunk, min(size, (index + 1) * chunk) - 1
    path = parts / f"{index:04}.part"
    if path.is_file() and path.stat().st_size == end - start + 1:
        return index
    for attempt in range(6):
        try:
            with httpx.Client(timeout=180, follow_redirects=True) as client:
                response = client.get(location, headers={"Range": f"bytes={start}-{end}"})
                response.raise_for_status()
                if response.status_code != 206 or len(response.content) != end - start + 1:
                    raise ValueError("Server did not honor the byte range")
                path.write_bytes(response.content)
                return index
        except (httpx.HTTPError, ValueError):
            if attempt == 5:
                raise
            time.sleep(1)


total = (size + chunk - 1) // chunk
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    futures = [pool.submit(fetch, i) for i in range(total)]
    for completed, task in enumerate(concurrent.futures.as_completed(futures), 1):
        task.result()
        print(json.dumps({"downloaded_parts": completed, "total_parts": total}), flush=True)

target = root / asset["name"]
with target.open("wb") as output:
    for i in range(total):
        output.write((parts / f"{i:04}.part").read_bytes())
actual = hashlib.sha256(target.read_bytes()).hexdigest()
assert "sha256:" + actual == asset["digest"]
receipt = {"tag": release["tag_name"], "published_at": release["published_at"],
           "name": asset["name"], "size": size, "sha256": actual, "verified": True}
(root / "obsidian-download.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
print(json.dumps(receipt), flush=True)
