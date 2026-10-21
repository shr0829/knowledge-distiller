"""Create an independent, real Obsidian vault without demonstration feedback."""

import json
from pathlib import Path

from .models import ProjectInput
from .service import Service
from .store import Store


def create_vault(store: Store, vault: Path, root: Path, name: str = "知序知识库") -> dict:
    if not vault.is_absolute() or not root.is_absolute() or not root.is_dir():
        raise ValueError("Vault and existing project root must be absolute paths")
    vault, root = vault.resolve(), root.resolve()
    for project in store.projects():
        if project["vault"] == str(vault) and project["root"] == str(root) and not project["synthetic"]:
            store.set_meta("preferred_project_id", project["id"])
            return project
    if vault.exists():
        raise ValueError("New vault directory already exists; connect it through project settings instead")
    vault.mkdir(parents=True)
    (vault / ".obsidian").mkdir()
    (vault / "Library").mkdir()
    (vault / ".obsidian" / "app.json").write_text(json.dumps({
        "alwaysUpdateLinks": True, "newFileLocation": "folder", "newFileFolderPath": "Library",
    }, indent=2), encoding="utf-8")
    (vault / "Library" / "欢迎使用知序.md").write_text(
        "# 欢迎使用知序\n\n这是独立的正式 Obsidian 知识库。\n\n"
        "在 Codex 的知序面板中审核候选知识，查看差异后确认保存或更新。\n"
        "笔记使用标准 Markdown；可以直接用 Obsidian 打开这个文件夹。\n\n"
        "本页是建库说明，不属于会话提案或学习样本。\n", encoding="utf-8")
    project = Service(store).create_project(ProjectInput(
        name=name, vault=str(vault), root=str(root), capture_enabled=True, synthetic=False,
    ))
    store.set_meta("preferred_project_id", project["id"])
    return project
