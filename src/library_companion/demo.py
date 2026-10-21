"""An isolated, visibly synthetic vault. Never seed a user-configured vault."""

from .models import Candidate, ProjectInput, Submission
from .store import Store


def seed_demo(store: Store, service) -> dict:
    for project in store.projects():
        if project.get("synthetic") and project.get("name") == "示例知识库 · 合成数据":
            return project
    vault = store.home / "demo-vault"
    library = vault / "Library"
    library.mkdir(parents=True, exist_ok=True)
    examples = {
        "知识整理原则.md": "# 知识整理原则\n\n> 合成示例，非真实会话。\n\n笔记保留结论、成立条件和来源。\n\n相关：[[Library/审核与反馈]]\n",
        "审核与反馈.md": "# 审核与反馈\n\n> 合成示例，非真实会话。\n\n人工确认与自动写入授权分别管理。\n",
    }
    for name, content in examples.items():
        path = library / name
        if not path.exists():
            path.write_text(content, encoding="utf-8")
    project = service.create_project(ProjectInput(
        name="示例知识库 · 合成数据", root=str(vault), vault=str(vault), synthetic=True,
        capture_enabled=False,
    ))
    service.submit(Submission(project_id=project["id"], session_id="synthetic-demo-001", candidates=[
        Candidate(title="会话知识的保留边界", kind="decision",
                  content="保留可复用的结论、适用条件和证据；临时命令输出仅作为来源，不单独建立知识笔记。",
                  source="【合成示例】用于演示审核和写入操作，不来自真实 Codex 会话。",
                  tags=["整理方法"], links=["Library/知识整理原则"]),
        Candidate(title="知识整理原则", kind="knowledge", target="Library/知识整理原则.md",
                  content="已审核内容发生变化时，应重新展示差异并再次确认。自动化按项目、类型与操作单独授权。",
                  source="【合成示例】一次模拟设计讨论中的补充结论。", tags=["知识管理"]),
        Candidate(title="暂定的自动化假设", kind="hypothesis", uncertain=True,
                  content="增加审核样本可能减少整理误差；需要跨会话留出评估后再判断。",
                  source="【合成示例】未经过实验验证的设想。", tags=["待验证"]),
    ]))
    return project
