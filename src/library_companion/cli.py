import argparse
import json
import sys
from pathlib import Path

from .store import Store


def parser():
    result = argparse.ArgumentParser(prog="library", description="本地 Codex × Obsidian 知识整理工作台")
    result.add_argument("--home", type=Path, default=None, help="状态目录，默认 .library 或 LIBRARY_HOME")
    sub = result.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="启动本地审核界面")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--demo", action="store_true", help="创建独立合成示例库")
    serve.add_argument("--open", action="store_true", help="在默认浏览器打开带审核权限的面板")
    mcp = sub.add_parser("mcp", help="启动 stdio MCP 门面")
    mcp.add_argument('--agent-only', action='store_true', help='不注册界面审批工具，适合 Claudian 等客户端')
    scan = sub.add_parser('scan', help='采集项目文件和匹配项目的历史对话')
    scan.add_argument('project_id')
    scan.add_argument('--no-history', action='store_true')
    scan.add_argument('--restart', action='store_true', help='从头重新检查，忽略本轮续扫位置')
    build = sub.add_parser('build', help='准备带来源版本的知识加工任务')
    build.add_argument('project_id')
    compile_build = sub.add_parser('compile', help='用已配置后台模型提炼任务并提交审核')
    compile_build.add_argument('build_id')
    compile_build.add_argument('--retry', action='store_true')
    pipeline = sub.add_parser('pipeline', help='执行一次持续采集、加工准备与索引更新')
    pipeline.add_argument('project_id')
    search = sub.add_parser('search', help='跨项目检索原始材料与知识')
    search.add_argument('query')
    search.add_argument('--project', action='append')
    search.add_argument('--layer', choices=['all', 'raw', 'knowledge'], default='all')
    index = sub.add_parser('index', help='更新 QMD / OHS 索引')
    index.add_argument('project_id')
    index.add_argument('--engine', choices=['all', 'qmd', 'ohs'], default='all')
    index.add_argument('--semantic', action='store_true')
    connect = sub.add_parser('knowledge-integration', help='生成 Claudian / Codex / Claude 的接入配置')
    connect.add_argument('project_id')
    connect.add_argument('--install', action='store_true', help='将配置合并到 Vault，保留原设置并备份')
    sub.add_parser("demo", help="创建独立合成示例库")
    sub.add_parser("status", help="显示队列和项目摘要")
    sub.add_parser("recover", help="恢复未完成的写入日志")
    new_vault = sub.add_parser("create-vault", help="新建独立正式 Obsidian 库并连接当前项目")
    new_vault.add_argument("--vault", type=Path, required=True)
    new_vault.add_argument("--root", type=Path, required=True)
    new_vault.add_argument("--name", default="知序知识库")
    sub.add_parser("hook", help="从 stdin 读取 Codex 生命周期事件")
    capture = sub.add_parser("capture", help="手动导入一个明确选择的事件 JSON")
    capture.add_argument("event", type=Path)
    sub.add_parser("worker", help="处理已启用模型的捕获队列一次")
    config = sub.add_parser("integration", help="生成当前路径的 MCP 配置和插件副本")
    config.add_argument("--output", type=Path, default=Path(".library/integration"))
    return result


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parser().parse_args(argv)
    store = Store(args.home)
    if args.command in {'scan', 'build', 'search', 'index', 'knowledge-integration', 'compile', 'pipeline'}:
        from .integration import generate_knowledge_integration, install_knowledge_integration
        from .knowledge import Knowledge
        from .retrieval import Retrieval
        if args.command == 'scan':
            emit(Knowledge(store).scan(args.project_id, history=not args.no_history, restart=args.restart))
        elif args.command in {'compile', 'pipeline'}:
            import asyncio

            from .pipeline import Pipeline
            pipeline = Pipeline(store)
            emit(asyncio.run(pipeline.compile(args.build_id, retry=args.retry)) if args.command == 'compile'
                 else pipeline.collect(args.project_id))
        elif args.command == 'build':
            emit(Knowledge(store).prepare(args.project_id))
        elif args.command == 'search':
            emit(Retrieval(store).search(args.query, args.project, args.layer))
        elif args.command == 'index':
            emit(Retrieval(store).index(args.project_id, args.engine, args.semantic))
        else:
            emit((install_knowledge_integration if args.install else generate_knowledge_integration)(store, args.project_id))
        return
    if args.command == "create-vault":
        from .setup_vault import create_vault
        emit(create_vault(store, args.vault, args.root, args.name))
        return
    if args.command == "mcp":
        from .mcp_server import create_mcp
        create_mcp(store, include_sidebar=not args.agent_only).run(transport="stdio")
        return
    if args.command in {"hook", "capture"}:
        from .capture import capture_event
        try:
            raw = sys.stdin.read(2_000_001) if args.command == "hook" else args.event.read_text(encoding="utf-8-sig")
            if len(raw) > 2_000_000:
                raise ValueError("Hook payload exceeds input limit")
            payload = json.loads(raw)
            captured = capture_event(store, payload)
            if args.command == "capture":
                emit(captured)
            elif captured.get("request_continuation"):
                emit({"decision": "block", "reason": (
                    "Library Companion 已捕获本轮知识来源。请读取已启用项目的 capture events，"
                    "提炼有依据的候选，通过 submit_proposals 提交，并向用户展示 request_review 返回的审核入口。"
                    "这不是写入授权。不要重复触发本流程。"
                )})
            elif captured.get("context"):
                emit({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": captured["context"]}})
            else:
                emit({})
        except (ValueError, OSError) as exc:
            if args.command == "capture":
                raise
            # Hook errors must not break the user's coding session or leak transcripts.
            print(f"Library capture deferred: {type(exc).__name__}", file=sys.stderr)
            emit({})
        return
    if args.command == "integration":
        from .integration import generate
        emit(generate(store, args.output))
        return
    if args.command == "worker":
        import asyncio

        from .controller import Controller
        worker = Controller(store)
        rows = store.query("SELECT id FROM events WHERE status IN ('queued','extracted','needs_agent','extracting') ORDER BY created_at LIMIT 20")
        emit([asyncio.run(worker.extract(row["id"])) for row in rows])
        return
    from .controller import Controller
    controller = Controller(store)
    if args.command == "demo":
        from .demo import seed_demo
        emit(seed_demo(store, controller.service))
    elif args.command == "status":
        emit({"home": str(store.home), "projects": store.projects(),
              "proposals": len(store.proposal_list()), "settings_enabled": store.meta("model_settings", {}).get("enabled", False)})
    elif args.command == "recover":
        emit(controller.service.recover())
    elif args.command == "serve":
        import uvicorn

        from .api import create_app
        from .demo import seed_demo
        if args.demo:
            seed_demo(store, controller.service)
        store.set_meta("review_url", f"http://127.0.0.1:{args.port}")
        app = create_app(store.home)
        if args.open:
            import threading
            import webbrowser
            url = f"http://127.0.0.1:{args.port}/#review-token={app.state.bootstrap_token}"
            threading.Timer(1.5, webbrowser.open, args=[url]).start()
        uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
