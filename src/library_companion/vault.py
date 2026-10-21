from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
from pathlib import Path

import portalocker

BLOCKED = {".obsidian", ".git", ".library", "node_modules"}
MAX_NOTE_BYTES = 1_000_000
RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$", re.I)


def digest(value: str | bytes | None) -> str:
    raw = b"\0ABSENT" if value is None else value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(raw).hexdigest()


def clean_title(title: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\[\]#]', "-", title).strip(" .")
    if not value or RESERVED.match(value):
        value = "Note-" + digest(title)[:8]
    return value[:100].rstrip(" .")


def terms(text: str) -> set[str]:
    result = set(re.findall(r"[a-z0-9_]{2,}", text.lower()))
    for segment in re.findall(r"[\u4e00-\u9fff]+", text):
        result.update(segment[i:i + 2] for i in range(max(1, len(segment) - 1)))
    return result


def similarity(a: str, b: str) -> float:
    left, right = terms(a), terms(b)
    return len(left & right) / max(1, len(left | right))


def relative_parts(path: str, *, directory=False, allow_hidden=False) -> tuple[str, ...]:
    raw = path.replace("\\", "/")
    parts = tuple(raw.split("/"))
    if not parts or any(not p or p in {".", ".."} for p in parts):
        raise ValueError("Invalid relative note path")
    if any(p.rstrip(" .") != p or RESERVED.match(p)
           or (p.startswith(".") and not allow_hidden)
           or re.search(r'[<>:"|?*\x00-\x1f\x7f]', p) for p in parts):
        raise ValueError("Unsafe Windows note path")
    if not directory and not parts[-1].lower().endswith(".md"):
        raise ValueError("Only Markdown notes are accessible")
    return parts


def _reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & 0x400)


class Vault:
    def __init__(self, project: dict, home: Path):
        self.project = project
        configured_root = Path(project["vault"])
        self.root = configured_root.resolve(strict=True)
        if configured_root != self.root:
            raise ValueError("Configured vault root was redirected; reconnect the project before accessing it")
        if not self.root.is_dir():
            raise ValueError("Vault must be an existing directory")
        self.home = Path(home)

    def resolve(self, path: str, write=False) -> Path:
        parts = relative_parts(path)
        lowered = tuple(p.casefold() for p in parts)
        if any(p in BLOCKED for p in lowered):
            raise ValueError("Excluded note path")
        for exclusion in self.project.get("excluded_dirs", []):
            excluded = tuple(p.casefold() for p in relative_parts(exclusion, directory=True, allow_hidden=True))
            if lowered[:len(excluded)] == excluded:
                raise ValueError("Excluded note path")
        if write:
            allowed = [tuple(p.casefold() for p in relative_parts(d, directory=True))
                       for d in self.project["writable_dirs"]]
            if not any(lowered[:len(prefix)] == prefix and len(lowered) > len(prefix) for prefix in allowed):
                raise ValueError("Note is outside approved writable directories")
        target = self.root
        for part in parts:
            if target.exists() and target.is_dir():
                # Match Windows casing even on POSIX test/development hosts; ambiguity fails closed.
                matches = [p for p in target.iterdir() if p.name.casefold() == part.casefold()]
                if len(matches) > 1:
                    raise ValueError("Ambiguous path casing")
                target = matches[0] if matches else target / part
            else:
                target = target / part
            if _reparse(target):
                raise ValueError("Symlinks and junctions are not permitted inside a vault path")
            if not target.resolve().is_relative_to(self.root):
                raise ValueError("Path escapes the vault")
        actual_parts = tuple(p.casefold() for p in target.resolve().relative_to(self.root).parts)
        if any(p in BLOCKED or p.startswith(".") for p in actual_parts):
            raise ValueError("Excluded canonical note path")
        for exclusion in self.project.get("excluded_dirs", []):
            prefix = tuple(p.casefold() for p in relative_parts(exclusion, directory=True, allow_hidden=True))
            if actual_parts[:len(prefix)] == prefix:
                raise ValueError("Excluded canonical note path")
        if write and not any(actual_parts[:len(prefix)] == prefix and len(actual_parts) > len(prefix) for prefix in allowed):
            raise ValueError("Canonical note is outside approved writable directories")
        if target.exists():
            if not target.is_file():
                raise ValueError("Note path must point to a regular file")
            if target.stat().st_nlink > 1:
                raise ValueError("Hard-linked notes are not permitted")
        return target

    def canonical(self, path: str, write=False) -> str:
        return self.resolve(path, write=write).relative_to(self.root).as_posix()

    def read_bytes(self, path: str) -> bytes | None:
        target = self.resolve(path)
        if not target.exists():
            return None
        if target.stat().st_size > MAX_NOTE_BYTES:
            raise ValueError("Note exceeds one megabyte")
        return target.read_bytes()

    def read(self, path: str) -> str | None:
        raw = self.read_bytes(path)
        return raw.decode("utf-8-sig") if raw is not None else None

    def hash(self, path: str) -> str:
        return digest(self.read_bytes(path))

    def notes(self) -> list[dict]:
        result = []
        # os.walk is bounded and never traverses a symlink or Windows junction.
        for directory, dirs, files in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d.casefold() not in BLOCKED and not d.startswith(".")
                             and not _reparse(Path(directory) / d))
            for filename in sorted(files):
                if not filename.lower().endswith(".md"):
                    continue
                if len(result) >= 5000:
                    return result
                target = Path(directory) / filename
                path = target.relative_to(self.root).as_posix()
                try:
                    raw = self.read_bytes(path)
                    if raw is None:
                        continue
                    content = raw.decode("utf-8-sig")
                except (ValueError, OSError, UnicodeError):
                    continue
                title = re.search(r"^#\s+(.+)$", content, re.M)
                result.append({"path": path, "title": title.group(1) if title else target.stem,
                               "content": content, "hash": digest(raw),
                               "links": re.findall(r"\[\[([^\]|#]+)(?:[^\]]*)\]\]", content)})
        return result

    def search(self, query: str, limit=8) -> list[dict]:
        if not query.strip():
            return []
        ranked = []
        for note in self.notes():
            score = similarity(query, note["title"]) * 0.7 + similarity(query, note["content"]) * 0.3
            if query.casefold() in (note["title"] + note["content"]).casefold():
                score += 0.5
            if score > 0:
                ranked.append({**note, "score": round(score, 4)})
        return sorted(ranked, key=lambda n: (-n["score"], n["path"]))[:max(1, min(50, limit))]

    def validate_links(self, links: list[str], target: str, content=""):
        embedded = re.findall(r"\[\[([^\]]*)\]\]", content)
        for value in embedded:
            if any(c in value for c in "\r\n"):
                raise ValueError("Invalid wiki link in content")
        body_links = [value.split("|", 1)[0].split("#", 1)[0] for value in embedded]
        if "![[" in content:
            raise ValueError("Embedded attachments are not supported in proposed content")
        if content.count("[[") != len(embedded):
            raise ValueError("Malformed wiki link in content")
        notes = self.notes()
        for link in list(links) + body_links:
            if not link or any(c in link for c in "[]|\n\r#"):
                raise ValueError("Invalid wiki link")
            note_path = link if link.casefold().endswith(".md") else link + ".md"
            relative_parts(note_path)
            candidate = note_path[:-3].replace("\\", "/").casefold()
            matches = [n for n in notes if n["path"][:-3].casefold() == candidate
                       or ("/" not in candidate and Path(n["path"]).stem.casefold() == candidate)]
            if len(matches) != 1:
                raise ValueError(f"Missing or ambiguous link target: {link}")
            if matches[0]["path"].casefold() == target.casefold():
                raise ValueError("Self-links are not permitted")

    def lock(self):
        directory = self.home / "locks"
        directory.mkdir(parents=True, exist_ok=True)
        return portalocker.Lock(str(directory / f"{digest(str(self.root).casefold())}.lock"), timeout=15)

    def write(self, path: str, content: str | bytes, expected_hash: str):
        raw = content.encode("utf-8") if isinstance(content, str) else content
        if len(raw) > MAX_NOTE_BYTES:
            raise ValueError("Resulting note exceeds one megabyte; choose another target")
        target = self.resolve(path, write=True)
        if self.hash(path) != expected_hash:
            raise ValueError("Conflict: note changed after the proposal was prepared")
        target.parent.mkdir(parents=True, exist_ok=True)
        target = self.resolve(path, write=True)
        fd, temporary = tempfile.mkstemp(prefix=".library-write-", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            if self.hash(path) != expected_hash:
                raise ValueError("Conflict: note changed while preparing the write")
            self.resolve(path, write=True)
            if expected_hash == digest(None):
                # Linking a complete sibling temp file publishes the full note atomically and cannot clobber.
                if os.name == "nt":
                    os.rename(temporary, target)
                else:
                    os.link(temporary, target)
            else:
                for attempt in range(3):
                    try:
                        os.replace(temporary, target)
                        break
                    except PermissionError:
                        if attempt == 2:
                            raise
                        time.sleep(0.05 * (attempt + 1))
                        self.resolve(path, write=True)
                        if self.hash(path) != expected_hash:
                            raise ValueError("Conflict: note changed while retrying the write") from None
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        if self.hash(path) != digest(raw):
            raise ValueError("Conflict: write verification failed")

    def delete_created(self, path: str, expected_hash: str):
        target = self.resolve(path, write=True)
        if self.hash(path) != expected_hash:
            raise ValueError("Conflict: note changed after this write; undo requires a new review")
        target.unlink()
