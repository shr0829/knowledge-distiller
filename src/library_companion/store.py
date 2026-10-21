import contextlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def uid() -> str:
    return uuid.uuid4().hex


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Store:
    def __init__(self, home: Path | None = None):
        self.home = (home or Path(os.environ.get("LIBRARY_HOME", ".library"))).resolve()
        self.home.mkdir(parents=True, exist_ok=True)
        self.path = self.home / "state.sqlite3"
        if sqlite3.sqlite_version_info < (3, 43, 0):
            raise RuntimeError('SQLite 3.43+ is required for the contentless search index; upgrade the Python runtime')
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS proposals(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL,
                    UNIQUE(project_id,session_id,fingerprint));
                CREATE TABLE IF NOT EXISTS feedback(
                    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, project_id TEXT NOT NULL,
                    session_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS policies(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS writes(
                    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, project_id TEXT NOT NULL,
                    status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS proposals_project ON proposals(project_id,status);
                CREATE INDEX IF NOT EXISTS feedback_project ON feedback(project_id);
                CREATE TABLE IF NOT EXISTS sources(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, locator TEXT NOT NULL,
                    kind TEXT NOT NULL, revision TEXT NOT NULL, active INTEGER NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL,
                    UNIQUE(project_id,locator,revision));
                CREATE INDEX IF NOT EXISTS sources_project ON sources(project_id,active);
                CREATE TABLE IF NOT EXISTS builds(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS knowledge_evidence(
                    proposal_id TEXT NOT NULL, source_id TEXT NOT NULL,
                    PRIMARY KEY(proposal_id,source_id));
                CREATE TABLE IF NOT EXISTS knowledge_relations(
                    proposal_id TEXT NOT NULL, project_id TEXT NOT NULL,
                    target_project_id TEXT NOT NULL, target_path TEXT NOT NULL,
                    UNIQUE(proposal_id,target_project_id,target_path));
                CREATE TABLE IF NOT EXISTS extractions(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS extractions_project ON extractions(project_id,status,created_at);
                CREATE TABLE IF NOT EXISTS synthesis_jobs(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS synthesis_jobs_project ON synthesis_jobs(project_id,status,created_at);
                CREATE TABLE IF NOT EXISTS extraction_evidence(
                    extraction_id TEXT NOT NULL, source_id TEXT NOT NULL,
                    PRIMARY KEY(extraction_id,source_id));
                CREATE TABLE IF NOT EXISTS abstractions(
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS abstractions_project ON abstractions(project_id,status,created_at);
                CREATE TABLE IF NOT EXISTS abstraction_extractions(
                    abstraction_id TEXT NOT NULL, extraction_id TEXT NOT NULL,
                    PRIMARY KEY(abstraction_id,extraction_id));
                CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
                    locator,body,scope,content='',contentless_delete=1);
                CREATE TABLE IF NOT EXISTS note_catalog(
                    project_id TEXT NOT NULL,path TEXT NOT NULL,title TEXT NOT NULL,
                    revision TEXT NOT NULL,PRIMARY KEY(project_id,path));
                CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
                    locator,body,scope,content='',contentless_delete=1);
                CREATE TABLE IF NOT EXISTS retrieval_chunk_sources(
                    source_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,
                    recipe TEXT NOT NULL,prepared_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS chunk_sources_project ON retrieval_chunk_sources(project_id,recipe);
                CREATE TABLE IF NOT EXISTS retrieval_chunks(
                    id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_id TEXT NOT NULL,
                    revision TEXT NOT NULL,origin TEXT NOT NULL,
                    start_char INTEGER NOT NULL,end_char INTEGER NOT NULL,
                    line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,
                    section TEXT NOT NULL,recipe TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS chunks_source ON retrieval_chunks(source_id,recipe,start_char);
                CREATE INDEX IF NOT EXISTS chunks_project ON retrieval_chunks(project_id,recipe);
            """)

    @contextlib.contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=20000")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def query(self, sql: str, args=()) -> list[dict]:
        with self.connection() as db:
            rows = [dict(row) for row in db.execute(sql, args).fetchall()]
        for row in rows:
            if "data" in row:
                row["data"] = json.loads(row["data"])
        return rows

    def execute(self, sql: str, args=()):
        with self.connection() as db:
            return db.execute(sql, args).rowcount

    def meta(self, key: str, default=None):
        with self.connection() as db:
            row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_meta(self, key: str, value):
        self.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, encode(value)))

    def project(self, project_id: str) -> dict:
        rows = self.query("SELECT * FROM projects WHERE id=?", (project_id,))
        if not rows:
            raise ValueError("Project does not exist")
        return {"id": rows[0]["id"], **rows[0]["data"]}

    def projects(self) -> list[dict]:
        return [{"id": r["id"], **r["data"]} for r in self.query("SELECT * FROM projects")]

    def proposal(self, proposal_id: str) -> dict:
        rows = self.query("SELECT * FROM proposals WHERE id=?", (proposal_id,))
        if not rows:
            raise ValueError("Proposal does not exist")
        row = rows[0]
        return {k: v for k, v in row.items() if k != "data"} | row["data"]

    def proposal_list(self, project_id=None) -> list[dict]:
        rows = self.query(
            "SELECT id FROM proposals WHERE (? IS NULL OR project_id=?) ORDER BY created_at DESC",
            (project_id, project_id),
        )
        return [self.proposal(r["id"]) for r in rows]
