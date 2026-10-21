# 知序 DSH 插件 · 开发规格（SPEC）

> 版本 v1 · 2026-10-21 · 作者：主会话（含两份子代理调研）
> 配套文件：`docs/DSH_PLUGIN_PROMPT.md`（可直接粘贴给新会话）、`libary/docs/DSH_DESIGN_TOKENS.md`（视觉 token 全表）、`docs/research/dsh-plugin-server.md`（服务端机制，550 行带源码行号）、`docs/research/dsh-plugin-client.md`（客户端机制，536 行带源码行号）
> 状态：规格 v1。插件机制部分已用真实第三方插件（`dsh-chat-import`）与宿主源码双向核对；仍标 **【待确认】** 的三条见 §17。

---

## 1 一句话定位

把「知序」从一个旁挂的 Python 服务，做成 **DSH 的原生插件**：会话即采集、审核即入库、知识即插件的一部分。

## 2 为什么必须做成插件（而不是继续旁挂服务）

旧形态的三个结构性缺陷，全部来自"旁挂"：

1. **采集靠外部触发**。Python 服务只能等 Obsidian 插件或 Codex 会话把内容推过来，DSH 里的对话本身采不到，等于最重要的语料在盲区。
2. **模型密钥在插件外**。提炼要调用大模型，旧方案自己管 key；而在 DSH 里，模型网关是宿主能力，插件不该、也不能绕过它。
3. **交互要跨应用**。审核界面在浏览器、语料在 Obsidian、对话在 DSH，一个动作要跨三个窗口。做成插件后，左栏多一个「知序」图标，点开就是整页审核与检索，脱离上下文的成本降到零。

因此插件的价值主张不是"把界面搬进去"，而是**把采集入口、模型通道、审核动作三件事收进同一个进程边界**。

## 3 目标 / 非目标

### 3.1 目标（本期必须做到）

| 编号 | 目标 | 可验证的判据 |
| --- | --- | --- |
| G1 | 会话即采集：DSH 会话的每一轮（用户消息、助手回复、工具调用摘要）自动成为 L1 原始快照 | 会话结束 5s 内，`sources` 表出现该轮记录，`content_sha256` 与原文一致 |
| G2 | L1 不可变：任何提炼产物都不能改写 L1 | 对 L1 做 UPDATE/DELETE 被数据库触发器拒绝 |
| G3 | 提炼走宿主模型网关：插件不持有任何模型密钥 | 插件代码与配置里 grep 不到 `api_key`/`sk-` |
| G4 | 三层加工链：L1 原始 → L2 抽取（跨来源材料）→ L3 抽象（原则/决策/经验） | 每条 L3 能通过 `trace` 命令回放到具体 L2 与 L1 引用 |
| G5 | 人工审核是唯一的写入闸门 | 未经审核的候选不会出现在 vault；`writes` 表每条都可回溯到 `reviews` |
| G6 | 写入 Obsidian 兼容 Markdown，不丢历史 | 同一概念二次写入后路径不变、`revision` 递增，旧内容在 `notes` 表可回溯 |
| G7 | 界面完全沿用 DSH 原生视觉 | 深浅色切换跟随宿主；无自定义品牌色；与 DSH 侧栏并排时无违和 |
| G8 | 无模型时可降级运行 | 关闭模型后仍可采集、检索、手工录入与审核 |

### 3.2 非目标（本期明确不做）

- **不做云同步**。知识库是本机文件 + 本机 SQLite，多设备靠 git 手工同步。
- **不做多人协作**。审核状态是单用户语义，不做冲突合并。
- **不做全自动写入**。任何自动化的终点都是"候选"，落盘必须过一次人工确认（可批量，不可跳过）。
- **不重做向量检索**。沿用既有 qmd/ohs 混合检索思路，但向量索引退为可选增强；主检索是 FTS5 + 图扩展。
- **不保留旧前端**。`libary/frontend/` 的六个页面不迁移、不兼容，只复用视觉层（见 §20）。

## 4 用户场景

**S1 收工后批量审核。** 一天下来积累了 40 条候选。左栏「知序」图标带角标 40，点开整页进入审核视图，键盘 `A` 接受 / `D` 丢弃 / `S` 暂缓 / `E` 编辑，列表逐条推进；接受后自动写入 vault，右上角 Toast 显示"已写入 12 篇"。

**S2 追问"我当时为什么这么定"。** 在 DSH 里问助手某设计取舍的来由。助手调用插件暴露的检索工具，返回 L3 决策记录 + 其引用的 L2 材料 + 原始对话片段（带会话链接），三层证据在同一条回复里。

**S3 换项目不串味。** 正在做 B 项目，检索不应把 A 项目的笔记混进来。项目归属由采集时的 workspace 路径推导，检索默认按当前项目过滤，跨项目需显式开关。

## 5 总体架构

```
DSH 宿主进程
├─ 会话 / Agent ──事件流──┐
│                         ▼
├─ dsh-plugin-zhixu（本插件）
│   ├─ capture/    订阅会话事件 → 切分 → 快照落库（L1，不可变）
│   ├─ pipeline/   L1 → 抽取(L2) → 抽象(L3)，产出候选
│   ├─ review/     候选 → 人工裁定 → 写入任务
│   ├─ vault/      写入 Obsidian 兼容 Markdown（只增 revision）
│   ├─ retrieval/  FTS5 + 邻接表图扩展 + 可选向量增强
│   ├─ ui/         主视图整页（React，宿主 --dsw-* token）
│   └─ store/      SQLite（单文件，迁移脚本内嵌）
│
├─ 宿主模型网关（不持有密钥）
└─ Agent 工具：zhixu_search / zhixu_capture / zhixu_pending

外部：Obsidian vault（Markdown 真相层）+ zhixu.sqlite3（派生索引层）
```

**关键分层原则**：Markdown 是知识的**真相层**，SQLite 是**派生索引层**。索引可以整份删除重建（`zhixu reindex`），笔记不能。

## 6 DSH 插件契约

### 6.1 包形态与目录

```
libary/dsh-plugin/                 # 新目录，与现有 python 后端并列，不互相依赖
├─ package.json                    # 插件清单（字段见 6.2）
├─ cordis.patch.yml                # 本插件自带 loader 入口（insert 一行）
├─ tsdown.config.ts                # 双产物：Host 半 → lib/index.mjs，浏览器半 → lib/client.js
├─ src/
│  ├─ index.ts                     # Host 入口：apply(ctx, config) / inject / Config
│  ├─ capture/  pipeline/  review/  vault/  retrieval/  store/
│  └─ shared/                      # 两端共用的类型与常量
├─ client/                         # 浏览器半源码（React 19 + CSS Modules）
│  ├─ index.tsx                    # apply(ctx) 里注册 slot
│  └─ views/                       # 审核 / 加工 / 检索 / 记录 / 设置
├─ locale/{zh,en}.json             # meta.title / description 等
├─ icon.svg
├─ migrations/                     # 001_init.sql 起，按序应用（打包进 lib，不依赖外部文件）
├─ lib/                            # 构建产物（index.mjs + client.js），随包发布
└─ tests/                          # 单测 + 端到端（临时 vault + 临时 db）
```

构建一次产出两个文件，插件侧不需要 vite：**Host 半与浏览器半共用一个 npm 包**，靠 `exports["./client"]` 区分。

### 6.2 清单字段（已用真实第三方插件核对，来源：`~/.dsh/profiles/desktop/node_modules/dsh-chat-import/package.json`）

```jsonc
{
  "name": "dsh-plugin-zhixu",
  "type": "module",
  "main": "./lib/index.mjs",
  "exports": {
    ".": "./lib/index.mjs",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "icon": "assets/zhixu.svg",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },      // 本插件自带 loader patch
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale"] }
  },
  "peerDependencies": {                                 // 宿主内置包必须是 peer，不打包
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh": ">=0.1.5-rc.1",
    "@deepseek-ai/dsh-client-locale": ">=0.1.0-rc.6",
    "@deepseek-ai/dsh-tools": ">=0.1.0-rc.6 <0.3.0",
    "@deepseek-ai/schemastery": ">=3.0.0",
    "react": ">=18.0.0"
  },
  "engines": { "node": ">=22.13" }
}
```

插件自带的 `cordis.patch.yml` 只需一行（条目 id 即配置命名空间）：

```yaml
- insert:
    - id: zhixu
      name: dsh-plugin-zhixu
```

### 6.3 服务端职责（`lib/index.mjs`）

真实入口形状（已与 `dsh-chat-import` 和宿主 `host-plugin.md` 双向核对）：

```js
import z from '@deepseek-ai/schemastery'

export const name = 'zhixu'
export const inject = ['tools']                 // 必需服务：缺了插件起不来
export const Config = z.object({                // 只有 .volatile() 字段会出现在设置表单
  capture: z.boolean().default(true).volatile(),
  vaultPath: z.string().default('E:\\files\\知序知识库').volatile(),
})

export function apply(ctx, config) {
  ctx.tools.register({                          // Agent 工具：注册即为 system-prompt schema
    name: 'zhixu_search',
    description: '在知序知识库里检索三层知识（L3 原则/决策 → L2 材料 → L1 原文）',
    parameters: { query: { type: 'string', required: true }, limit: { type: 'integer' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) { return search(args.query, { signal: exec.signal }) },
  })

  ctx.inject(['webServer'], (w) => w.webServer.register({   // 面板取数的 HTTP 路由
    kind: 'prefix', path: '/api-zhixu',
    handler: (req, res) => handleApi(req, res),
  }))

  ctx.provide('zhixu', Object.freeze({ search, capture, pending }))  // 供其它插件消费
  ctx.effect(() => /* 订阅会话事件 + 定时提炼 */)
}
```

- 三条注册线：`ctx.tools.register`（Agent 工具，返回 disposer）、`ctx.webServer.register`（HTTP，返回 disposer）、`ctx.provide`（对外服务）；设置项走 `Config` + `.volatile()`
- `ctx.effect(fn)` 的清理函数在卸载时执行 —— 数据库句柄、事件订阅、定时器一律挂在 `ctx.effect` 上
- 采集依赖宿主会话事件，**服务名与事件名需在 M0 实测确认**（见 §17 未决 1）

### 6.4 客户端职责（`lib/client.js`）

客户端产物**不是 ESM**，而是宿主用 `<script>` 加载的 CJS 工厂：`window.__ModuleLoader__.load({ id, factory(require){…} })`，由 tsdown 构建。插件侧只需产出 `lib/client.js`，不必为每个插件配 vite；`package.json` 侧需要 `exports["./client"]` + `dsh.client.platform: "web"`。

UI 贡献**唯一入口是 slot**，且 slot 必须已被某个已挂载 entry 的 `children` 表声明，否则 `register` 直接抛 `slot "X" is not declared`。

```js
// 1) 左侧栏图标入口（list/root，必须有 id）
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register({ name: 'sidebar.panellist', id: 'zhixu', order: 20, label: '知序' }, IconButton))

// 2) 整页主视图（keyed/root，key 与上面的 id 相同）
ctx.slots.inject('main', () =>
  ctx.slots.register({ name: 'main', key: 'zhixu', locale: 'zhixu' }, ZhixuPage))

// 3) 侧栏底部快捷入口 + 设置分组 + Toast
ctx.slots.inject('sidebar.footer.action', () =>
  ctx.slots.register({ name: 'sidebar.footer.action', id: 'zhixu.quick' }, QuickAction))
ctx.slots.inject('settings.section', () =>
  ctx.slots.register({ name: 'settings.section', id: 'zhixu', order: 42 }, SettingsSection))
ctx.slots.inject('shell.overlay', () =>
  ctx.slots.register({ name: 'shell.overlay', id: 'zhixu.toast' }, ToastHost))
```

- **永远用 `ctx.slots.inject` 惰性注册**，直接 `slots.register` 依赖 apply 期槽已声明，时序不保证
- 程序化跳转用 `ctx.layout.selectPanel('zhixu')`
- 主题：颜色/圆角/间距一律取宿主变量 `--dsw-*`（`--dsw-alias-*`、`--dsw-radius-*`），**不要写死颜色**；`ctx.theme` 提供 `getTheme/setTheme/overrideTokens` 与 `theme/change` 事件
- 样式隔离靠 CSS Modules 哈希类名 + 变量继承（**没有 shadow DOM**），样式经 `<style data-plugin="<pkg>">` 注入 head
- 硬限制：不替换 app root、不往 `document.body` 追加应用、**不用 iframe**（iframe 拿不到宿主 token 与 locale）、不读改其它组件 DOM
- 客户端不碰数据库：走 `/api-zhixu` 路由或 `ctx.get('zhixu')`

### 6.5 安装与分发（已核对真实布局）

DSH 的插件不是"丢一个目录"，而是 **profile 里的 pnpm 包**：

```
~/.dsh/profiles/desktop/            # 当前生效的 profile（另有 web profile）
├─ package.json                     # dependencies + dsh.profile.bundles 追加包名
├─ cordis.patch.yml                 # 用户级 patch：条目 id / name / config / disabled
├─ cordis.yml                       # 根条目表，永远是 []，不要手改
├─ pnpm-workspace.yaml              # nodeLinker: hoisted
├─ node_modules/<插件名>/           # 实际安装位置
├─ .plugin-manager/                 # 宿主插件管理器状态与日志
└─ .dsh-market/                     # market 插件：discovery-compatibility-v1.json、log.ndjson
```

- 安装 = 在 profile 里 `pnpm add dsh-plugin-zhixu` + 往 `dsh.profile.bundles` 追加包名（**顺序有意义**）；配置写在 `cordis.patch.yml` 的对应条目
- **bundle 的唯一标记是 `dsh.bundle.patch`**：少了它，包只是普通依赖，`listBundles` 报 `not-bundle`，不会进插件表
- 配置合成顺序：bundles → `cordis.patch.yml` → `--patch`。**patch 替换整行 `config`，不深合并** —— 所以默认值必须写在 `Config` 的 `.default()` 里，不能指望靠 patch 合并
- 设置项命名空间 = patch 里的**条目 `id`**（如 `zhixu`）；写成带前缀会被拒（409）
- 重启语义：新增 bundle 在开启 HMR 的 profile 里可热激活；**替换已装包必须重启**；只改 `.volatile()` 字段值不需 remount
- 也可以 `dshmarket`（插件市场）分发，清单需带 `icon`、`description`、`keywords: ["dsh-plugin"]`
- 开发期：在 profile 里指向本地包；客户端改动走 HMR（需同仓 `pnpm run dev:web`）
- 数据目录：`<DSH 用户数据目录>/zhixu/`，内含 `zhixu.sqlite3`、`logs/`、`exports/`
- vault 路径由设置项指定，默认沿用 `E:\files\知序知识库`

## 7 数据模型

单文件 SQLite。所有时间戳为 ISO-8601 UTC 字符串；所有 id 为 26 位 ULID 文本（可按时间排序）。

**驱动**：用 Node 内置 `node:sqlite`（`DatabaseSync`），与 `dsh-chat-import` 同款 —— 零原生编译、免 node-gyp。两点注意：(1) 只有同步 API，单次事务不得跨 `await`，长查询前让出一轮事件循环；(2) **FTS5 是否编入需在 M1 用 `pragma compile_options` 实测**，若内置版本没带 FTS5，退路是自带 `better-sqlite3` 或改用倒排表 + bigram 手写索引。

```sql
-- L1 原始快照：只增不改
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'dsh-turn' | 'dsh-tool' | 'file' | 'manual'
  locator       TEXT NOT NULL,          -- 'session:<sid>#turn:<n>' / 绝对路径
  title         TEXT,
  content       TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  chars         INTEGER NOT NULL,
  captured_at   TEXT NOT NULL,
  meta          TEXT,                   -- JSON：model / workspace / tool_name 等
  deleted_at    TEXT                    -- 仅标记，不物理删除
);
CREATE UNIQUE INDEX ux_sources_locator ON sources(locator, content_sha256);
CREATE TRIGGER sources_immutable BEFORE UPDATE ON sources
WHEN OLD.content IS NOT NEW.content OR OLD.locator IS NOT NEW.locator
BEGIN SELECT RAISE(ABORT, 'sources are immutable'); END;

-- L2 抽取：从若干 L1 材料中抽出的、可复用的事实/片段
CREATE TABLE extractions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'candidate',  -- candidate|approved|discarded|deferred
  uncertain   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- L3 抽象：跨 L2 归纳出的原则/决策/经验/偏好/假设
CREATE TABLE abstractions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- principle|decision|experience|preference|hypothesis|task
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'candidate',
  created_at  TEXT NOT NULL
);

-- 溯源边：L3→L2→L1，带引用原文
CREATE TABLE citations (
  id            TEXT PRIMARY KEY,
  from_layer    TEXT NOT NULL,   -- 'abstraction'|'extraction'
  from_id       TEXT NOT NULL,
  to_layer      TEXT NOT NULL,   -- 'extraction'|'source'
  to_id         TEXT NOT NULL,
  quote         TEXT,            -- 原文片段，审核时展示
  span_start    INTEGER,
  span_end      INTEGER
);
CREATE INDEX ix_citations_from ON citations(from_layer, from_id);
CREATE INDEX ix_citations_to   ON citations(to_layer, to_id);

-- 笔记目录（vault 的镜像索引，重建时可整表重算）
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  path         TEXT NOT NULL,       -- 相对 vault 根
  title        TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  written_at   TEXT NOT NULL,
  superseded_by TEXT
);
CREATE UNIQUE INDEX ux_notes_path_rev ON notes(path, revision);

-- 审核与写入：两道闸门分开记，任何写入都可回溯到一次裁定
CREATE TABLE reviews (
  id           TEXT PRIMARY KEY,
  target_layer TEXT NOT NULL,       -- 'extraction'|'abstraction'
  target_id    TEXT NOT NULL,
  action       TEXT NOT NULL,       -- accept|discard|defer|edit
  before       TEXT, after TEXT,
  reviewed_at  TEXT NOT NULL
);
CREATE TABLE writes (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL REFERENCES reviews(id),
  note_id     TEXT,
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  written_at  TEXT NOT NULL,
  error       TEXT
);

-- 知识图谱：邻接表（不用图数据库；DERIVED from citations/notes）
CREATE TABLE edges (
  src_id TEXT NOT NULL, src_layer TEXT NOT NULL,
  dst_id TEXT NOT NULL, dst_layer TEXT NOT NULL,
  kind   TEXT NOT NULL,             -- derived_from|contradicts|extends|same_topic
  PRIMARY KEY (src_id, dst_id, kind)
);
CREATE INDEX ix_edges_dst ON edges(dst_id);

-- 全文索引（中文按 unicode61 + 二元切分，见 §10）
CREATE VIRTUAL TABLE fts USING fts5(
  doc_id UNINDEXED, layer UNINDEXED, project_id UNINDEXED,
  title, body, tokenize='unicode61'
);

-- 策略、反馈、任务、设置
CREATE TABLE policies (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE feedback (id TEXT PRIMARY KEY, target_layer TEXT, target_id TEXT, signal TEXT, note TEXT, created_at TEXT);
CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT, status TEXT, payload TEXT, attempts INTEGER DEFAULT 0, error TEXT, created_at TEXT, finished_at TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

**不变量（用测试锁死）**

1. `sources` 行内容不可变；纠错靠新增行 + `deleted_at` 标记。
2. 任何 `writes` 必须有 `review_id`，禁止绕过审核直接写 vault。
3. `notes` 的 `path` 与 `revision` 单调递增；旧 revision 永不删除。
4. `edges` / `fts` 是派生物，`reindex` 可整表重建且结果幂等。
5. 每条 `approved` 的 L2/L3 至少有一条 `citations`（否则视为脏数据，`fsck` 报错）。

## 8 采集契约

### 8.1 采集什么

| 事件 | 落库层 | 说明 |
| --- | --- | --- |
| 用户消息 | `kind='dsh-turn'`，`meta.role='user'` | 原文完整保留 |
| 助手最终回复 | `kind='dsh-turn'`，`meta.role='assistant'` | 只存最终内容，不存流式增量 |
| 工具调用 | `kind='dsh-tool'` | 只存工具名 + 参数摘要 + 结果摘要（上限 4KB），避免把大文件读入塞进快照 |
| 会话结束 | 一条汇总快照 `kind='dsh-turn'`，`meta.role='summary'` | 便于检索定位到"整段会话" |

**不采**：模型思考过程、系统提示词、密钥、路径中 `.env` 的内容。命中屏蔽词的内容整轮跳过，并记一条 `policy` 日志。

### 8.2 切分规则

- 单轮 ≤ 8KB 原文直存；> 8KB 按 Markdown 标题切段，段间用 `locator#part=n` 区分。
- 同一会话同一轮重复采集时，靠 `ux_sources_locator` 去重。
- 采集在会话事件回调里**同步写库、异步提炼**，写库不得阻塞会话。

### 8.3 项目归属

`project_id = sha1(规范化 workspace 路径)[:12]`；路径取会话的 `cwd`。无 `cwd` 的会话归入 `manual` 项目，可在审核时改归属。

## 9 提炼流水线

### 9.1 三段式

```
L1 原始快照 ──抽取──→ L2 材料（事实/片段/代码决策） ──抽象──→ L3 原则/决策/经验
   (自动)              (自动，产出候选)                    (自动，产出候选)
                              └──────── 人工审核 ←─────────────┘
                                          │
                                  写入 vault（只增 revision）
```

### 9.2 触发时机

- **增量**：每积累 N 条新 L1（默认 12）或距上次提炼超过 30 分钟且空闲，跑一轮。
- **手动**：命令面板「立即提炼」。
- **禁止**：会话进行中跑提炼（会与事件回调抢锁）。

### 9.3 提示词与预算

- 抽取：把一批 L1 摘要 + 标题喂给模型，产出结构化 JSON（`title/content/kind/uncertain/citations[{source_id, quote}]`），要求 `quote` 为原文逐字片段；落库后逐条校验（`quote` 必须能在对应 `sources.content` 中找到，找不到则丢弃该引用并把该条标 `uncertain=1`）。
- 抽象：把一批已存在的 L2 + 同项目 L3 标题喂给模型，产出"新增/合并/修订"三类动作；修订必须指向既有 L3 id。
- 预算：单轮抽取 ≤ 8K tokens 输入、≤ 2K 输出；超限按条数减半重试一次，仍超则跳过并记 job error。
- 幂等：同一批 L1 用 `(project_id, content_sha256 集合)` 记指纹，重复运行命中指纹直接跳过。

### 9.4 降级

模型不可用（未配置/配额耗尽/超时）：

- 采集、检索、手工录入、审核、写入全部照常。
- 提炼退化为规则模式：只按"标题 + 首段"生成 L2 候选（`uncertain=1`），不做 L3 抽象。
- 面板顶部显示一条常驻提示：`未配置模型 · 提炼已降级为规则模式`。

## 10 检索

### 10.1 主路径

1. 查询归一（去标点、全角转半角、英文小写）。
2. FTS5 匹配：中文没有分词器，采用**二元切分**（`unicode61` + 查询串与正文同时做 bigram 处理），短语命中优先。
3. 图扩展：命中节点沿 `edges` 扩 1 跳（`derived_from` 双向、`extends` 单向），取 top-k 邻居。
4. 组装：L3 结果在前，附带其 L2 与 L1 证据链；L1 原文单独成组。
5. 截断：返回上限 8 条、总字节 ≤ 24KB，超出按分数截断并标记 `truncated:true`。

### 10.2 排序

`score = 0.6*text + 0.25*recency + 0.15*centrality`，其中 `centrality` 为图入度归一化。权重存 `policies` 表，可调不可硬编码。

### 10.3 可选增强

配置了向量索引时，加一路召回并与 FTS 结果做 RRF 融合（k=60）。向量索引缺失不报错，只记 warning。

## 11 写入契约

### 11.1 文件布局

```
<vault>/
├─ Library/
│  ├─ <项目名>/
│  │  ├─ Projects/<project_id>/concepts/<slug>.md
│  │  └─ Projects/<project_id>/decisions/<slug>.md
│  └─ 索引.md                       # 自动生成的入口页
└─ .obsidian/                       # 不触碰
```

### 11.2 Frontmatter

```yaml
---
title: 决策：向量索引退为可选增强
project: 知序知识库
project_id: a1b2c3d4e5f6
kind: decision
status: published
revision: 2
zhixu_id: 01JABCDEF...
sources: ["src_01J...", "src_01J..."]
related: ["[[知识图谱用邻接表而非图数据库]]"]
updated: 2026-10-21T05:12:00Z
---
```

### 11.3 规则

- **只增**：内容变化时 `revision+1`。**决策：原地更新文件 + 旧内容进 `notes` 表历史**（Obsidian 用户期望路径稳定），而不是另存 `slug---r2.md`。冲突时（文件被外部改动、sha256 与库不一致）停止写入，标记 `conflict`，在面板里提示人工处理。
- 关联：`related` 用 wikilink，目标笔记必须存在，否则不入 `related`（避免红链）。
- 原子写：临时文件 + rename，失败回滚。
- 摘要页：`索引.md` 每次写入后重算（纯派生）。

## 12 UI 规格

### 12.1 形态

**左侧栏图标入口 + 主视图整页**（DSH 官方的 "app in app" 模式，与内置的 Plugins 页、任务页同构）：

- `sidebar.panellist` 注册图标（`id='zhixu'`），带未读数
- `main` 槽用 `key='zhixu'` 注册整页组件，用户点图标即切换到知序整页（`ctx.layout.selectPanel('zhixu')` 可程序化跳转）
- 五视图在页内用左侧二级导航切换（**不用 React Router**，选中态放自己的 store，宿主不提供 URL 路由）
- 备选（二期）：`sidebar.right.pane.tab` 做一个窄版「待审 N 条」就地面板，方便边聊边审

### 12.2 五个视图

| 视图 | 作用 | 主要元素 |
| --- | --- | --- |
| 审核队列（默认） | 逐条裁定候选 | 顶部进度 `12 / 40`、候选卡片（标题/正文/引用原文/来源会话链接）、底部动作条 `接受 A` `丢弃 D` `暂缓 S` `编辑 E`、批量模式复选框 |
| 知识加工 | 看三层结构与状态 | 层切换（L1/L2/L3）、列表 + 详情、`重建索引`、`跑一轮提炼`、流水线状态（队列长度、上次运行、失败原因） |
| 检索 | 查知识 | 输入框 + 项目过滤 + 层过滤，结果按 L3/L2/L1 分组，每条显示证据链折叠 |
| 记录 | 审计 | 写入记录、审核记录、失败与冲突，按时间倒序，可导出 CSV |
| 设置 | 策略与路径 | vault 路径、采集开关与屏蔽词、提炼阈值、检索权重、模型降级提示 |

### 12.3 关键交互

- 键盘优先：`J/K` 上下移动，`A/D/S/E` 裁定，`Enter` 展开证据，`Esc` 返回列表。
- 裁定后自动推进到下一条并提供 3 秒「撤销」提示，撤销即回滚该条 review。
- 空状态不写"暂无数据"，写下一步该做什么（如「今天还没有新会话，在 DSH 里聊两轮就会出现在这里」）。
- 加载中：骨架屏（3 行灰条），不用转圈。
- 错误：面板内联一条可复制的错误块，附「重试」与「打开日志」。

### 12.4 视觉

沿用 `libary/docs/DSH_DESIGN_TOKENS.md` 记录的宿主设计平台 token。硬性要求：

- **颜色/圆角/间距一律用宿主 CSS 变量 `--dsw-*`**（如 `var(--dsw-alias-bg-base)`、`var(--dsw-alias-label-secondary)`、`var(--dsw-radius-sm)`），插件不自己定义色板 —— 写死颜色在明暗切换时必然失效。
- `libary/frontend/src/theme.css` 是宿主 token 的**镜像**（内部用 `--n-*` / `--ds-*` 自有命名），迁移时要么把选择器里的变量换成 `--dsw-*`，要么写成 `var(--dsw-alias-bg-base, var(--ds-bg-base))` 的兜底形式。
- 圆角、行高、字号全部取 token，不写字面值。
- 深浅色跟随宿主，不提供独立主题开关。
- 图标用 DSH 同款线性图标，不引第三方图标包。

## 13 设置与策略

```jsonc
{
  "vaultPath": "E:\\files\\知序知识库",
  "capture": { "enabled": true, "maxToolBytes": 4096, "blocklist": ["*.env", "*secret*"] },
  "pipeline": { "batchSize": 12, "idleMinutes": 30, "autoRun": true, "model": "default" },
  "retrieval": { "weights": { "text": 0.6, "recency": 0.25, "centrality": 0.15 }, "maxResults": 8 },
  "write": { "layout": "concepts", "language": "zh" }
}
```

策略（`policies` 表）与设置（`settings` 表）分开：设置是用户偏好，策略是插件行为开关（如 `autoWrite=false` 永远不允许自动写入）。

设置项的落地约束（已核对）：`Config` 里只有带 `.volatile()` 的字段才会渲染成表单控件；patch 会**整体替换** `config` 而不深合并，因此所有默认值必须写在 `.default()` 上。

## 14 安全与隐私

- 不存模型密钥；模型调用一律走宿主网关。
- **插件 Host 代码在 DSH 主进程内运行，不受 workspace 沙箱约束**：这意味着插件能读写任意路径。因此 (a) 安装动作要求完整文件权限，(b) 插件自身要对所有路径做白名单校验，(c) 不在插件里执行来自笔记内容的代码。
- 采集默认开启，但提供全局开关与项目级排除。
- 屏蔽词命中即跳过，且跳过事件本身进日志（可审"为什么这条没被采"）。
- 数据库与日志不进 git（`.gitignore` 已有 `.library/`、`work/` 规则，需加 `*.sqlite3`、`logs/`）。
- vault 写入只在该项目子目录内，路径穿越校验（`path.relative` 必须不以 `..` 开头）。

## 15 验收标准

按顺序全绿才算完成：

1. `pnpm test` 全绿；新增代码无 `any`、无 `@ts-ignore`。
2. 采集：跑一段真实会话，`sources` 行数 = 回合数，`content_sha256` 校验通过；改 `sources.content` 被触发器拒绝。
3. 去重：同一轮重复触发采集，行数不增。
4. 提炼：给定 12 条 L1，产出的每条 L2 的 `citations.quote` 都能在原文中找到；构造一条假 quote，该引用被丢弃。
5. 审核闸门：未经审核时 `writes` 表为空；审核通过后 vault 出现文件且 frontmatter 完整。
6. 写入幂等：同一笔记连写两次，`revision` 从 1 到 2，文件只有一个，历史留在 `notes`。
7. 外部冲突：手工改 vault 文件再触发写入，写入被拒绝并标 `conflict`。
8. 检索：中文短语查询能命中（验证 bigram 方案），返回 ≤ 8 条且字节 ≤ 24KB。
9. 降级：清空模型配置后，采集/检索/审核/写入仍可用，面板出现降级提示。
10. 视觉：深浅色各截一张面板图，逐项对照 `libary/docs/DSH_DESIGN_TOKENS.md`，无自定义颜色与圆角。
11. 卸载：删除插件目录后 DSH 正常启动，数据目录保留。

## 16 里程碑

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| M0 骨架 | 包结构、清单字段验证、服务注册、空面板、设置项 | DSH 里能看到「知序」面板与设置分组，`pnpm build` 通过 |
| M1 采集 + 检索 | 事件订阅、快照落库、FTS5 + bigram、`zhixu_search` 工具 | 验收 2/3/8 |
| M2 提炼 + 审核 + 写入 | 两段流水线、候选、审核队列、vault 写入、`zhixu_pending` | 验收 4/5/6/7 |
| M3 图谱 + 反馈 | edges 构建、1 跳扩展、反馈信号、索引页 | 图谱视图可用 |
| M4 发布 | pack、安装文档、迁移脚本、卸载验证 | 验收 9/10/11 |

## 17 风险与未决

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 【已确认】会话事件的具体服务名与事件名 | — | 已解：`ctx.on('session/event')`，事件名为 `user/message`、`assistant/message`、`tool/call|result`、`turn/end`（见 §17 未决 1） |
| 会话事件里拿不到完整助手回复 | 采集残缺 | 已解：`assistant/message` 的 `data.message.content` 含完整文本块；流式时按 `data.stream` 追加，`data.interrupted` 立即收尾 |
| 中文 FTS5 无分词器，bigram 召回质量未知 | 检索不准 | 已用 bigram（`text.ftsTokens`）+ 无命中退 LIKE 合并；评测集（20 条真实查询）待补 |
| 【已确认】模型网关的调用方式与预算控制不明确 | 提炼不可控 | 已解：宿主**没有**公开的 LLM 调用服务（`host/Service.list` 全量目录核实），提炼一律走规则模式并标 `uncertain=1`，面板常驻降级提示（规格 §9 允许） |
| 旧 Python 后端与新插件双写同一 vault | 数据打架 | 插件上线即禁用旧服务的写入（保留只读导出） |

**未决问题（开发第一轮必须先答）**

1. ~~会话事件的可用粒度~~ **已答（2026-10-21，实测 `cordis_inspect_query` host/Event）**：
   宿主**没有**"会话结束"事件。`SessionEventMap` 只有 `turn/start|end`、`step/start|end`、
   `user/message`、`assistant/message`、`tool/call|result`、`system/message`、
   `developer/message`、`request/header|context`、`session/end-seed`。订阅方式为
   `ctx.on('session/event', (session, event) => …)`（post-commit、fire-and-forget）。
   ⇒ `capture` 采用**流式写入 + 收尾快照**：消息到达即同步落 L1；`turn/end` 起 5 秒去抖，
   期间无新事件再写一条 `meta.role='summary'` 快照（与 §8 "会话结束 5s 内出现该轮记录"等价）。
   助手文本取自 `assistant/message` 的 `data.message.content` 中 `type==='text'` 的块。
2. ~~面板取数通道~~ **已定**：服务端用 `ctx.webServer.register({kind:'prefix', path:'/api-zhixu'})` 暴露同构 REST（与旧 `api.py` 对齐），面板用 fetch 取数；同时 `ctx.provide('zhixu')` 供其它插件直调。
3. ~~用户数据目录与多 profile 语义~~ **已答**：数据目录一律 `$DSH_HOME/zhixu/zhixu.sqlite3`
   （`$DSH_HOME` 缺省 `~/.dsh`，由宿主注入环境变量），**不跟随 profile 目录**，因此
   `desktop` 与 `web` 两个 profile 共享同一份库——与"知识库是用户的、不是某个前端形态的"
   一致。代价：两个 profile 同时运行会争同一份 SQLite（已开 WAL + `busy_timeout=5000`，
   且写事务是同步短事务）。如需隔离，把 `$DSH_HOME` 指到不同目录即可。

## 18 附：DSH 槽位参考（实测 99 个 slot 中与本次相关的）

| 界面位置 | slot | kind / scope | options |
| --- | --- | --- | --- |
| 整页主视图 | `main` | keyed / root | `key` |
| 左侧栏面板图标 | `sidebar.panellist` | list / root | `id`、`order`、`label` |
| 侧栏底部动作 | `sidebar.footer.action` | list / root | `id`、`order`、`label` |
| 设置页整组 | `settings.section` | list / root | `id`、`order`、`label` |
| 设置页单行 | `settings.general.item` | list / root | `id`、`order`、`label` |
| Plugins 设置 tab | `settings.plugins.tab` / `plugins.tab` | list / root | `id`、`order`、`label` |
| 全窗浮层（modal/toast） | `shell.overlay` | list / root | `id` |
| Toast | `workspace.toast` | keyed / root | `key` |
| 右栏 tab（窄版就地面板） | `sidebar.right.pane.tab` | keyed / session | `key` |
| 输入框下方 | `conversation.composer.dock` | list / session | `id` |

- 四种 kind：`single`（同优先级唯一）、`keyed`（必须 `key`）、`list`（必须 `id`）、`chain`（必须 `select`）
- **没有状态栏类槽位**；常驻状态只能落在 `sidebar.footer.action`、`shell.bottom`、`shell.leading`
- 完整目录（含每个 slot 的 summary、声明者源码行号）：`.tmp-asar\x\slots.json`

**选用原则**：主界面 `sidebar.panellist` + `main`；提示用 `shell.overlay`/`workspace.toast`；设置用 `settings.section`；不要在 `conversation.*` 里插桩（聊天正文属宿主领域）。

## 19 开发循环

- 官方模板（不在 npm 上，随内置 skill 发布）：`dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/`，含 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/{en,zh}.json`、`icon.svg` —— 直接拿来改，比自己搭省半天。
- 没有 `create-dsh-plugin` 脚手架。
- 装进 profile：`dsh plugin --profile desktop add <path|pkg>`（或 `plugin_manager` 工具的 `install_bundle`，target 传包绝对目录），等价于在 profile 里 `pnpm add` + `dsh.profile.bundles` 追加。
- 客户端改动走 HMR（`dsh-client-hmr`）；Host 半替换已装包需重启。
- 本地验证顺序：`node --check index.js` → 在 DSH 看 `applied` 日志 → 面板出现 → 再写业务。

## 20 可复用的既有资产

| 资产 | 位置 | 用法 |
| --- | --- | --- |
| 视觉 token 全表 | `libary/docs/DSH_DESIGN_TOKENS.md` | 查值；实现时以宿主 `--dsw-*` 变量为准 |
| token 镜像 | `libary/frontend/src/theme.css` | 复制后把 `--ds-*`/`--n-*` 改名/兜底成 `--dsw-*` |
| 组件基元 | `libary/frontend/src/ui.tsx`（Fluent 兼容 shim：Button/Input/Card/Badge/Tabs/Dialog…） | 复制后改为插件内私有组件 |
| 图标 | `libary/frontend/src/icons.tsx` | 直接复制 |
| 旧后端可参考的模块 | `libary/src/library_companion/{capture,layers,pipeline,vault,retrieval,store}.py` | 只读参考语义，**不迁移代码** |
| 插件机制底稿 | `docs/research/dsh-plugin-server.md`、`docs/research/dsh-plugin-client.md` | 字段/API 存疑时先查这两份 |

---

### 附：与旧方案的关系

旧 Python 服务（`libary/src/library_companion/`）保留为只读参考与导出工具，插件上线后不再参与写入。`state.sqlite3` 已于 2026-10-21 清零，新库从零开始，正好按本规格重建 schema。
