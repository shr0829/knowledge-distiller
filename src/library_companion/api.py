"""Loopback review UI. Agent-facing MCP deliberately exposes no approvals."""

import asyncio
import base64
import contextlib
import hmac
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .controller import Controller
from .demo import seed_demo
from .models import Kind, ModelSettings, ProjectInput, Review, Submission
from .runtime import runtime_info
from .store import Store
from .vault import Vault

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "testserver"}


def flatten(rows):
    return [{k: v for k, v in row.items() if k != "data"} | row.get("data", {}) for row in rows]


class Authorization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    action: str
    enabled: bool


class Revision(BaseModel):
    revision: int


class CaptureSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class SourceScan(BaseModel):
    files: bool = True
    history: bool = True
    history_roots: list[str] | None = Field(default=None, max_length=20)
    restart: bool = False


class BuildInput(BaseModel):
    source_ids: list[str] | None = Field(default=None, max_length=20)
    limit: int = Field(default=8, ge=1, le=20)


class ExtractionInput(BaseModel):
    source_ids: list[str] | None = Field(default=None, max_length=20)
    limit: int = Field(default=8, ge=1, le=20)


class AbstractionInput(BaseModel):
    extraction_ids: list[str] | None = Field(default=None, max_length=20)
    limit: int = Field(default=8, ge=1, le=20)


class KnowledgeSearch(BaseModel):
    query: str = Field(max_length=1000)
    project_ids: list[str] | None = Field(default=None, max_length=30)
    layer: str = 'all'
    engine: str = 'auto'
    limit: int = Field(default=12, ge=1, le=40)
    candidate_limit: int = Field(default=40, ge=1, le=160)
    read_limit: int = Field(default=12, ge=0, le=40)
    max_bytes: int = Field(default=36000, ge=0, le=256000)
    per_hit_bytes: int = Field(default=6000, ge=0, le=24000)


class SourcePage(BaseModel):
    project_id: str
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=500)
    query: str = Field(default='', max_length=1000)


class IndexInput(BaseModel):
    engine: str = 'all'
    semantic: bool = False


class BuildCandidates(BaseModel):
    candidates: list[dict] = Field(min_length=1, max_length=20)


class LayerCandidates(BaseModel):
    candidates: list[dict] = Field(default_factory=list, max_length=8)


def create_app(home: Path | None = None, frontend: Path | None = None) -> FastAPI:
    store = Store(home)
    controller = Controller(store)
    service, learning = controller.service, controller.learning
    sessions: dict[str, tuple[str, float]] = {}
    assets = (frontend or Path(__file__).resolve().parents[2] / "frontend" / "dist").resolve()

    @asynccontextmanager
    async def lifespan(app):
        service.recover()
        learning.reconcile_feedback()
        async def worker():
            from .pipeline import Pipeline
            pipeline = Pipeline(store)
            while True:
                await controller.process_queue()
                await pipeline.tick()
                await asyncio.sleep(15)
        task = asyncio.create_task(worker())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="Library Companion", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.controller = controller
    app.state.bootstrap_token = secrets.token_urlsafe(32)

    @app.middleware("http")
    async def local_boundary(request: Request, call_next):
        try:
            hostname = urlsplit("http://" + request.headers.get("host", "")).hostname
            content_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return JSONResponse({"detail": "Malformed request headers"}, status_code=400)
        if hostname not in LOCAL_HOSTS:
            return JSONResponse({"detail": "Only loopback hosts are allowed"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != str(request.base_url).rstrip("/"):
            return JSONResponse({"detail": "Cross-origin access is not permitted"}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Cross-site access is not permitted"}, status_code=403)
        entry = sessions.get(request.cookies.get("library_session", ""))
        valid_session = bool(entry and entry[1] >= time.monotonic())
        if request.url.path.startswith("/api/") and request.url.path not in {"/api/session", "/api/health"} and not valid_session:
            return JSONResponse({"detail": "请使用启动脚本打开审核面板；直接访问地址没有审核权限。"}, status_code=403)
        if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
            token = request.headers.get("x-library-token", "")
            if not valid_session or not hmac.compare_digest(entry[0], token):
                return JSONResponse({"detail": "Review session expired; reload the page"}, status_code=403)
            if content_length > 2_000_000 or content_length < 0:
                return JSONResponse({"detail": "Request body too large"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
        )
        return response

    @app.exception_handler(ValueError)
    async def value_error(request, exc):
        message = str(exc)
        code = 409 if any(word in message.lower() for word in ["conflict", "revision", "changed", "stale"]) else 400
        return JSONResponse({"detail": message}, status_code=code)

    @app.exception_handler(PermissionError)
    async def permission_error(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=403)

    @app.exception_handler(OSError)
    async def file_error(request, exc):
        return JSONResponse({"detail": "文件操作失败，请检查路径、文件占用和访问权限。"}, status_code=409)

    @app.get("/api/session")
    def session(request: Request, response: Response):
        for key, item in list(sessions.items()):
            if item[1] < time.monotonic():
                sessions.pop(key, None)
        previous = sessions.get(request.cookies.get("library_session", ""))
        if not previous and not hmac.compare_digest(request.headers.get("x-library-reviewer", ""), app.state.bootstrap_token):
            raise HTTPException(status_code=403, detail="请通过启动脚本打开面板，获取本次运行的审核会话。")
        cookie, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        sessions[cookie] = (csrf, time.monotonic() + 8 * 3600)
        response.set_cookie("library_session", cookie, httponly=True, samesite="strict", max_age=8 * 3600)
        return {"csrf_token": csrf}

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/api/runtime")
    def runtime():
        return runtime_info()

    @app.get("/api/state")
    def state():
        proposals = store.proposal_list()
        writes = flatten(store.query("SELECT * FROM writes ORDER BY created_at DESC"))
        for entry in writes:
            for field in ("before", "after"):
                snapshot = entry.get(field + "_snapshot")
                entry[field] = base64.b64decode(snapshot).decode("utf-8-sig") if snapshot is not None else ""
        feedback = flatten(store.query("SELECT * FROM feedback ORDER BY created_at DESC"))
        for entry in feedback:
            entry["decision"] = {**entry.get("final", {}), "action": entry.get("action")}
        projects = store.projects()
        learning_status = {p["id"]: learning.status(p["id"]) for p in projects}
        for project in projects:
            project["authorizations"] = learning_status[project["id"]]["authorization_scopes"]
        return {
            "preferred_project_id": store.meta("preferred_project_id"),
            "projects": projects, "proposals": proposals, "writes": writes,
            "feedback": feedback, "policies": learning.policies(),
            "events": flatten(store.query("SELECT * FROM events ORDER BY created_at DESC LIMIT 100")),
            "settings": store.meta("model_settings", ModelSettings().model_dump()),
            "stats": {"pending": sum(p["status"] in {"pending", "deferred"} for p in proposals),
                      "writes": len(writes), "feedback": len(feedback), "projects": len(store.projects())},
            "learning": learning_status,
        }

    @app.post("/api/projects")
    def project(value: ProjectInput):
        return service.create_project(value)

    from .knowledge import Knowledge
    from .layers import Layers
    from .retrieval import Retrieval
    knowledge, layers, retrieval = Knowledge(store), Layers(store), Retrieval(store)
    from .pipeline import Pipeline, PipelineSettings
    pipeline = Pipeline(store)

    @app.get('/api/projects/{project_id}/knowledge')
    def knowledge_overview(project_id: str):
        return knowledge.overview(project_id)

    @app.post('/api/knowledge/sources')
    def source_page(value: SourcePage):
        return knowledge.source_page(value.project_id, offset=value.offset, limit=value.limit, query=value.query)

    @app.get('/api/projects/{project_id}/memory')
    def knowledge_memory(project_id: str):
        return knowledge.memory(project_id)

    @app.get('/api/sources/{source_id}')
    def source_snapshot(source_id: str):
        return knowledge.source(source_id)

    @app.get('/api/proposals/{proposal_id}/evidence')
    def proposal_evidence(proposal_id: str):
        return knowledge.proposal_evidence(proposal_id)

    class NoteEvidence(BaseModel):
        project_id: str
        path: str = Field(max_length=500)

    @app.post('/api/knowledge/evidence')
    def note_evidence(value: NoteEvidence):
        return knowledge.note_evidence(value.project_id, value.path)

    @app.get('/api/projects/{project_id}/pipeline')
    def pipeline_status(project_id: str):
        return pipeline.status(project_id)

    @app.get('/api/projects/{project_id}/layers')
    def layer_status(project_id: str):
        return layers.overview(project_id)

    @app.put('/api/projects/{project_id}/pipeline')
    def pipeline_setting(project_id: str, value: PipelineSettings):
        return pipeline.configure(project_id, value)

    @app.post('/api/projects/{project_id}/pipeline/run')
    def pipeline_run(project_id: str):
        return pipeline.collect(project_id)

    @app.post('/api/builds/{build_id}/compile')
    async def compile_build(build_id: str):
        return await pipeline.compile(build_id, retry=True)

    @app.post('/api/layer-jobs/{job_id}/compile')
    async def compile_layer(job_id: str):
        return await pipeline.compile_layer(job_id, retry=True)

    @app.get('/api/layer-jobs/{job_id}')
    def layer_job(job_id: str):
        return layers.context(job_id)

    @app.post('/api/projects/{project_id}/sources/scan')
    def source_scan(project_id: str, value: SourceScan):
        return knowledge.scan(project_id, **value.model_dump())

    @app.post('/api/projects/{project_id}/builds')
    def prepare_build(project_id: str, value: BuildInput):
        return knowledge.prepare(project_id, **value.model_dump())

    @app.get('/api/builds/{build_id}')
    def build_context(build_id: str):
        return knowledge.context(build_id)

    @app.post('/api/builds/{build_id}/submit')
    def submit_build(build_id: str, value: BuildCandidates):
        return knowledge.submit(build_id, value.candidates)

    @app.post('/api/projects/{project_id}/extractions')
    def prepare_extraction(project_id: str, value: ExtractionInput):
        return layers.prepare(project_id, **value.model_dump())

    @app.get('/api/extractions/{extraction_id}')
    def extraction_context(extraction_id: str):
        return layers.context(extraction_id)

    @app.post('/api/extractions/{extraction_id}/submit')
    def submit_extraction(extraction_id: str, value: LayerCandidates):
        return layers.submit(extraction_id, value.candidates)

    @app.post('/api/projects/{project_id}/abstractions')
    def prepare_abstraction(project_id: str, value: AbstractionInput):
        return layers.prepare_abstraction(project_id, **value.model_dump())

    @app.get('/api/abstractions/{abstraction_id}')
    def abstraction_context(abstraction_id: str):
        return layers.context(abstraction_id)

    @app.post('/api/abstractions/{abstraction_id}/submit')
    def submit_abstraction(abstraction_id: str, value: LayerCandidates):
        return layers.submit(abstraction_id, value.candidates)

    @app.get('/api/layers/{layer}/{identifier}/trace')
    def layer_trace(layer: str, identifier: str):
        return layers.trace(identifier, layer)

    @app.post('/api/knowledge/search')
    def search_knowledge(value: KnowledgeSearch):
        return retrieval.search(**value.model_dump())

    @app.get('/api/knowledge/graph')
    def knowledge_graph():
        return knowledge.graph()

    @app.get('/api/retrieval/status')
    def retrieval_status():
        return retrieval.status()

    @app.post('/api/projects/{project_id}/retrieval/index')
    def retrieval_index(project_id: str, value: IndexInput):
        return retrieval.index(project_id, **value.model_dump())

    class FineIndex(BaseModel):
        batch_size: int = Field(default=100, ge=1, le=1000)
        semantic: bool = True

    @app.post('/api/projects/{project_id}/retrieval/chunks')
    def retrieval_chunks(project_id: str, value: FineIndex):
        return retrieval.index_chunks(project_id, **value.model_dump())

    @app.post('/api/projects/{project_id}/integration')
    def knowledge_integration(project_id: str):
        from .integration import generate_knowledge_integration
        return generate_knowledge_integration(store, project_id)

    @app.put("/api/projects/{project_id}/capture")
    def capture_setting(project_id: str, value: CaptureSetting):
        from .store import encode
        project = store.project(project_id)
        project.pop("id")
        project["capture_enabled"] = value.enabled
        store.execute("UPDATE projects SET data=? WHERE id=?", (encode(project), project_id))
        return {"id": project_id, **project}

    @app.post("/api/demo")
    def demo():
        return seed_demo(store, service)

    @app.post("/api/proposals")
    def submit(value: Submission):
        return controller.submit(value)

    @app.post("/api/proposals/{proposal_id}/preview")
    def preview(proposal_id: str, value: Review):
        return service.preview(proposal_id, value)

    @app.post("/api/proposals/{proposal_id}/review")
    def review(proposal_id: str, value: Review):
        return controller.review(proposal_id, value)

    @app.post("/api/proposals/{proposal_id}/refresh")
    def refresh(proposal_id: str, value: Revision):
        return service.refresh(proposal_id, value.revision)

    @app.post("/api/writes/{write_id}/undo")
    def undo(write_id: str):
        return service.undo(write_id)

    @app.get("/api/projects/{project_id}/notes")
    def notes(project_id: str):
        items = Vault(store.project(project_id), store.home).notes()
        edges = []
        for note in items:
            for link in note["links"]:
                matches = [n for n in items if n["path"].removesuffix(".md") == link.removesuffix(".md")
                           or Path(n["path"]).stem == link]
                if len(matches) == 1:
                    edges.append({"source": note["path"], "target": matches[0]["path"]})
        return {"notes": items, "nodes": [{"id": n["path"], "label": n["title"]} for n in items], "edges": edges}

    @app.get("/api/projects/{project_id}/learning")
    def learning_status(project_id: str):
        return learning.status(project_id)

    @app.post("/api/projects/{project_id}/learn")
    def learn(project_id: str):
        return learning.learn(project_id)

    @app.post("/api/projects/{project_id}/optimize")
    async def optimize(project_id: str):
        return await learning.optimize_prompt(project_id)

    @app.post("/api/policies/{policy_id}/activate")
    def activate(policy_id: str):
        return learning.activate(policy_id)

    @app.post("/api/policies/{policy_id}/rollback")
    def rollback(policy_id: str):
        return learning.rollback(policy_id)

    @app.post("/api/projects/{project_id}/authorization")
    def authorize(project_id: str, value: Authorization):
        return learning.authorize(project_id, value.kind, value.action, value.enabled)

    @app.get("/api/settings")
    def settings():
        return store.meta("model_settings", ModelSettings().model_dump())

    @app.put("/api/settings")
    def update_settings(value: ModelSettings):
        if value.enabled and not value.model.strip():
            raise ValueError("启用后台模型前需要填写模型名称")
        parsed = urlsplit(value.endpoint)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("模型地址必须是不含凭据的 HTTP(S) URL")
        if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("远程模型必须使用 HTTPS")
        if not value.key_env.isidentifier():
            raise ValueError("密钥字段仅填写环境变量名称")
        store.set_meta("model_settings", value.model_dump())
        return value

    @app.post("/api/events/{event_id}/extract")
    async def extract(event_id: str):
        return await controller.extract(event_id)

    @app.get("/{path:path}")
    def frontend_file(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Unknown API endpoint")
        requested = (assets / (path or "index.html")).resolve()
        if not requested.is_relative_to(assets):
            raise HTTPException(status_code=404, detail="Not found")
        if requested.is_file():
            return FileResponse(requested)
        if "." not in Path(path).name and (assets / "index.html").exists():
            return FileResponse(assets / "index.html")
        raise HTTPException(status_code=404, detail="前端尚未构建，请在 frontend 目录运行 npm run build")

    return app
