# Library Companion

本地运行的 Codex × Obsidian 知识审核工具。会话知识进入候选队列，用户预览差异后保存、追加更新、丢弃或暂缓；每次写入可追溯并撤销。反馈学习和自动执行授权分别管理。

## 启动

要求 Windows、Python 3.12+、uv、Node.js 22.12+（或 20.19.x）及 npm。已在此目录安装 Python 和前端依赖。

```powershell
cd E:\project\libary
.\start.ps1 -Demo
```

启动脚本会同步锁定依赖、在缺少构建时编译界面，并在默认浏览器打开本次审核会话。界面服务只监听 `127.0.0.1:8765`。停止服务用终端的 `Ctrl+C`。

首次启动 `-Demo` 创建 `.library/demo-vault` 独立示例库，所有示例都标为合成数据，不能用于升级自动化。省略 `-Demo` 则使用已有配置或空项目列表。

也可分别运行：

```powershell
uv sync --locked
cd frontend
npm ci
npm run build
cd ..
uv run library serve --demo --open
```

独立网页的审核链接带一次启动凭证，前端建立 HttpOnly 会话后移除地址中的凭证。直接输入无凭证地址不能取得审核权限；重启服务后用启动脚本重新打开。Codex 侧边栏通过 MCP Apps 通道连接，不依赖 HTTP 端口。模型可见工具只读或提交候选；人工审核操作仅通过标记为 `visibility: ["app"]` 的界面工具提供，由 MCP 宿主隔离模型调用。

## 使用

1. 先在示例库试用：编辑标题/正文/目标/标签/链接，生成差异预览，再确认写入。
2. “写入记录”查看原文与结果，撤销单次写入。笔记有后续编辑时只显示反向差异，不覆盖后续内容。
3. “项目与设置”填写实际项目目录、Obsidian 库路径和允许写入的相对目录。项目与 Vault 根目录必须已经存在；允许写入的子目录可在保存时创建。配置项目即指定此项目的捕获范围，也可随时关闭捕获。
4. 生成并接入下面的 Codex 插件。Obsidian 无需保持打开；写入的是普通 UTF-8 Markdown，关系使用 `[[内部链接]]`。
5. “反馈与学习”查看有效人工案例、候选策略和独立评估。自动化开关只授权所选项目、类型和操作；样本不足时仍然人工审核。

更新采用**保留原文并追加知识片段**，不自动替换旧结论。丢弃仅关闭候选，不删除既有笔记。仅撤销由本系统新建且此后未被修改的笔记时会删除该新文件。

## Codex 接入

```powershell
uv run library integration
# 安装前先在 frontend 运行 npm ci 和 npm run build
codex plugin marketplace add E:\project\libary\.library\integration
codex plugin add library-companion@zhixu-local
```

命令生成当前机器准确解释器和状态目录的配置：

- `.library/integration/plugin/`：插件 manifest、整理 Skill、MCP 配置与 Windows hooks。
- `.library/integration/codex-mcp.toml`：可检查的单独 stdio MCP 配置片段。

生成操作不会修改全局 Codex 配置；随后的 marketplace add / plugin add 会安装并启用插件。选择完整插件或单独 MCP 其中一种接入方式，避免重复挂载同一服务。安装后重新打开 Codex，使其发现新的全局侧边栏入口“知序”。如主导航折叠了插件入口，请在更多入口中查找。hooks 的信任由 Codex 管理，首次提示时检查后启用；程序不绕过信任检查。若全局 CLI 无法解析桌面配置，使用桌面应用配套的 CLI。

插件的 `open_library` 声明 `openai/ui.entrypoints: [{type: "global"}]`，资源地址为 `ui://library-companion/workbench.html`。前端构建同时生成网页和单文件 MCP App。侧边栏操作复用 HTTP 路由的输入验证、精确预览、日志与撤销规则，凭证不发送给模型或网页。MCP 服务启动后也运行队列处理，不要求独立网页服务常驻。

新建独立正式库（目录须尚不存在）：

```powershell
uv run library create-vault --vault E:\files\知序知识库 --root E:\project\libary
```

已在本机连接 `E:\files\知序知识库`，默认写入目录为 `Library`，捕获范围为 `E:\project\libary`。此库与演示库分开，无合成反馈；模型调用仍需单独配置。在 Obsidian 中选择“打开文件夹作为仓库”即可使用。

接入后可调用 `$library-companion:review 整理本次会话`。工具会检索已有主题，提交候选并返回审核面板入口。`Stop` hook 在启用项目内捕获新增消息、达到阈值时请求继续一次整理；`stop_hook_active`、去重和冷却限制防止循环。`SessionStart` 返回待审提示，`PreCompact` 和 `SessionEnd` 只做短时入队。

不扫描全部历史会话。只处理 hook 明确给出的 transcript 和已启用项目映射，或用户明确选择的输入文件。解析器识别 Codex `response_item.payload` 的用户/助手可见文字；未知格式、损坏输入、超过限额的输入在事件队列显示为异常。

## 模型和学习

当前 Codex 可以直接提炼并通过 MCP 提交候选，无需后台 API。后台模型默认关闭，不读取或复制 Codex 登录凭据。

如需脱离当前聊天自动处理队列，在设置中显式选择兼容端点和模型、密钥环境变量名称、输入输出上限与日调用预算，并启用模型调用。密钥只从运行服务进程的环境变量读取；不填入项目、Vault 或 hook。远程调用会发送经过筛选和尽力脱敏的内容；脱敏不能保证移除所有敏感信息。

服务启用模型后每 15 秒处理待提炼队列。网络失败和预算耗尽保留来源，不无限重试。也可手动执行 `uv run library worker` 处理一次。目标笔记在提交或预览后发生变化时会停止写入；模型未引用捕获内容中的原文时会拒绝提案。来源使用已捕获的队列快照，不重新核对后续变化的 transcript。

学习分为：

- 人工案例与规则：按项目检索修改前后内容，记录动作、正文、目标、标签和链接差异。
- 留出验证：训练和验证按会话隔离，保留固定留出范围；评估所有写入字段。
- 前瞻影子验证：策略先记录预测，后对照新会话中真实人工操作。
- 限定自动化：独立验证、影子验证和会话级错误上界都达标，且具有单独授权，才允许执行对应类别。纠正或撤销会降级策略。

默认至少 50 个样本、5 个会话只是最低条件，不代表一定通过。默认风险阈值要求会话级单侧 95% 错误上界不超过 5%，通常需要更多独立会话。合成样本、暂缓和无人审核的自动输出不能作为正确训练样本。

可选 LangMem 依赖：`uv sync --extra learning`。启用模型辅助学习后，优化器仅产生候选提示词。**提示词变更目前没有端到端模型独立验证器，不能自动发布**；自动发布功能只适用于通过现有评估的案例规则策略。被过滤内容召回率尚未完成独立标注，故不开放自动丢弃。

## 数据与恢复

- `.library/state.sqlite3`：项目、提案、反馈、策略、队列、写入日志与原文快照。
- `.library/demo-vault/`：可在 Obsidian 中打开的合成示例库。
- `LIBRARY_HOME` 或 `library --home <path>`：更换状态目录；界面、MCP、hooks 必须使用同一目录。

服务启动时对未完成日志核对磁盘内容：已经完成的写入补登记，未写入的回到待审，不明变化标记冲突。也可运行 `uv run library recover`。

程序内部锁可以协调本系统的写入，不能锁住 Obsidian 或其他编辑器。写前哈希检查和原子文件替换缩小竞态窗口，不提供跨进程全局事务。批量操作按项登记，部分失败不会伪装成整批成功。

本机审核能力凭证防止普通未授权 HTTP 请求审批，但无法约束具有任意本地代码执行或数据库访问权限的进程；部署环境仍需保持本机用户边界。正式运行前应备份真实 Vault。

## 验证和开发

```powershell
uv run pytest -q
uv run ruff check src tests
cd frontend
npm run build
npm run lint
```

测试涵盖路径越界、Windows 目录规范化、审批内容绑定、重复提交、并发写入、文件冲突、原始字节恢复、崩溃日志恢复、捕获脱敏与格式异常、学习隔离和真实 stdio MCP 握手。人工审核界面另做实际浏览器联调。

实现采用 Python/FastAPI/SQLite、React/Fluent UI 和 MCP Python SDK。项目知识加工支持来源版本、增量任务和跨项目关联；检索接入 QMD 与 Obsidian Hybrid Search，并保留本地词项回退。语义能力取决于本地模型和索引是否就绪。LangGraph 尚未用于运行路径，持久化审核与恢复直接使用 SQLite 状态机。

## 项目知识库与 Claudian

“项目知识加工”页面可采集项目文本文件和按工作目录匹配的 Codex / Claude 历史对话。原始来源以只读快照保存；自动管线跨文件、跨会话生成第二层材料，不为每个来源单独写提炼笔记；第三层在这些材料之上生成更抽象的原则、模型或经验，并继承证据链回到原始快照，最后进入原有审核队列。旧的逐批 `builds` 入口仍保留用于显式维护。不同项目使用独立知识目录；同 Vault 用双链，跨 Vault 用 Obsidian 链接。

完整架构、操作流程、范围限制和 Claudian 接入说明见 `docs/PROJECT_KNOWLEDGE_ARCHITECTURE.md`。搜索依赖锁定在 `search-runtime/`，Windows 安装使用 `scripts/install-search.ps1`。`uv run library knowledge-integration <项目ID> --install` 可合并 Vault 的 Provider 配置并备份原文件。插件文件安装、Provider 信任和实际对话连通是不同状态，须分别核验。
