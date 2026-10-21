# 给新会话的可粘贴 Prompt

> 用法：新开会话 → 选「创造模式」→ 把下面 `=====` 之间的内容整段贴入 → 确认工作目录为 `E:\project\04-知识库与工具链`。
> 配套规格：`docs/DSH_PLUGIN_SPEC.md`（必读，本 prompt 只是入口）

=====

我要把「知序」知识库做成一个 **DSH 原生插件**（不是旁挂的 Python 服务）。这是新建项目，请按 `E:\project\04-知识库与工具链\docs\DSH_PLUGIN_SPEC.md` 施工。

**开工前必读（按顺序）**

1. `docs/DSH_PLUGIN_SPEC.md` —— 完整规格：架构、SQLite schema、采集契约、三层提炼流水线、检索、写入契约、UI 规格、验收标准、里程碑、槽位参考、开发循环。
2. `docs/research/dsh-plugin-server.md` —— 服务端插件机制（550 行，字段/API 都带源码行号）：bundle 判据 `dsh.bundle.patch`、profile 布局、`ctx.tools.register` / `ctx.webServer.register` / `ctx.provide`/`Config.volatile()`。
3. `docs/research/dsh-plugin-client.md` —— 客户端机制：`exports["./client"]` + `dsh.client.platform`、`window.__ModuleLoader__` 的 CJS 工厂产物、99 个 slot、`sidebar.panellist` + `main` 的整页模式、CSS Modules + `--dsw-*` 变量（无 shadow DOM）。
4. `libary/docs/DSH_DESIGN_TOKENS.md` —— 视觉 token 全表。
5. `libary/frontend/src/theme.css`、`ui.tsx`、`icons.tsx` —— 已实现的 token 镜像与组件基元，复用但**把颜色变量改回宿主 `--dsw-*`**。

**先答三个未决问题**（答案写回 `docs/DSH_PLUGIN_SPEC.md` §17，再动代码）

1. 会话事件粒度：能否拿到"会话结束"事件，还是只有逐条消息回调？
2. 两个 profile（desktop / web）是否共享同一份 `zhixu.sqlite3`？
3. 客户端面板取数：`/api-zhixu` 路由是否受 CSRF/鉴权影响，需不需要 token？

**施工顺序（严格按里程碑，每个里程碑跑通再进下一个）**

- **M0 骨架**：从官方模板 `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/` 起步，改成 `libary/dsh-plugin/`；`sidebar.panellist` 出图标、`main` 出空页、`settings.section` 出设置项；`dsh plugin --profile desktop add <本地路径>` 装上，确认日志 `applied` 且面板可切换。**这一步只求"面板出现"，不写业务逻辑。**
- **M1 采集 + 检索**：订阅会话事件 → L1 快照落库（含不可变触发器）→ FTS5 bigram 检索 → `zhixu_search` 工具 + `/api-zhixu/search` 路由。
- **M2 提炼 + 审核 + 写入**：L1→L2→L3 两段流水线 → 候选 → 审核队列（键盘 A/D/S/E）→ vault Markdown 写入（只增 revision，冲突即停）。
- **M3 图谱 + 反馈**：edges 构建、1 跳图扩展、反馈信号、索引页。
- **M4 发布**：pack、安装文档、迁移脚本、卸载验证。

**硬约束**

- 视觉只用宿主 `--dsw-*` 变量，禁止写死颜色/圆角/字号；深浅色跟随宿主；不用 iframe，不做 shadow DOM。
- 插件不持有任何模型密钥，模型调用一律走宿主网关。
- `sources`（L1）不可变，纠错靠新增行；任何写 vault 必须经过 `reviews` 记录。
- 人工审核是唯一写入闸门，不提供"全自动写入"。
- Markdown 是真相层，SQLite 是派生索引层，索引必须可整份重建。
- 设置默认值必须写在 `Config` 的 `.default()` 上（patch 整体替换 config，不深合并）。
- TypeScript 严格模式，不用 `any`、不用 `@ts-ignore`。
- 不迁移旧的 Python 代码，只读参考语义；旧服务上线后停写。

**验收**

逐条执行 `docs/DSH_PLUGIN_SPEC.md` §15 的 11 条验收标准，全绿才算完成。视觉验收额外要求：深浅色各截一张界面图，逐项对照 token 表，不得出现表外颜色与圆角。

**纪律**

- 不编造 DSH API。字段名/函数名必须来自两份 research 文档或实际解包验证（解包器在 `.tmp-asar\asar.cjs`，用法 `node asar.cjs list|extract <asar> '<regex>' [outdir]`）；拿不准就写"未找到"并变成待验步骤。
- 每完成一个里程碑，先跑通、截图、记已知缺陷，再进下一个；不要一口气写完再调。
- 遇到与规格冲突的现实（例如插件机制不支持某个设计），**先改规格再改代码**，并在规格里留一条决策记录与理由。

=====

## 附：三个关键结论（省得重新踩）

1. 插件不是"丢一个目录"，而是 **profile 里的 pnpm 包**：`~/.dsh/profiles/desktop/` 的 `package.json`（`dependencies` + 有序 `dsh.profile.bundles`）+ `cordis.patch.yml`（配置）+ `node_modules`。bundle 的唯一判据是 `dsh.bundle.patch`。
2. 整页面板 = `sidebar.panellist` 出图标（`id`）+ `main` 出整页（`key` 同 id），这是官方 Plugins 页同款模式；`ctx.slots.inject` 惰性注册，不要直接 `register`。
3. 视觉要"像原生"，必须继承 `--dsw-*` 变量（挂在根元素，普通 DOM 自然继承）；`libary/frontend/src/theme.css` 用的是自有命名，迁移时要映射回去。
