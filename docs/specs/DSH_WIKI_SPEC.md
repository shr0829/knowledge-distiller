# 知序 · LLM Wiki 设计（v2 增量改造）

> 状态：**已实施（2026-10-21，插件 `dsh-llm-wiki` v0.3.0）**。实施中的偏差与决策记在
> `libary/dsh-plugin/docs/DECISIONS.md` 的 D17–D22；验收映射在 `libary/dsh-plugin/docs/ACCEPTANCE.md` 的 v2 段。
> 前置：`docs/DSH_PLUGIN_SPEC.md`（v1，M0–M4 已实现并通过 32 项单测）+ `docs/DSH_PLUGIN_PROMPT.md`。
> 本文只写**增量**：v1 里没提或要改的部分。与 v1 冲突处标 **【改】**；v1 未变的部分沿用，不再重复。
> 取舍原则沿 v1：不编造宿主 API、视觉只用 `--dsw-*`、L1 不可变、人工审核是唯一写入闸门、Markdown 是真相层。

---

## 1. 为什么改

v1 的三层结构（L1 原始 → L2 跨源材料 → L3 抽象）解决了「可溯源」，但有一个结构性问题：**知识在查询时才成形**。

- 每次检索都是从 L1/L2 现场拼答案，拼完即散，下一页还要重拼；
- L3 抽象是「记录行」而不是「可读的一页」，人没法像读笔记一样读它，也没法在它上面继续长；
- 跨来源的合并、矛盾、演进没有落点——`edges` 只有四种关系，没有「同一主张的旧版/新版」。

2026 年出现的一批 *LLM Wiki* 实践给出的解法和我们几乎正交：**把合成从「查询时」挪到「摄入时」**——新来源进来就地编译进一份持续维护的 Markdown 页面群，查询只读页面。它们的共识是：维护成本降到接近零，是因为写入路径上有 agent + 明确的页面 schema；放弃了「原文只读 + 每次重拼」的洁癖。

本设计把这两条合并：**保留 v1 的 L1 不可变与人工闸门，把 L3 从「记录」升级为「页面」，并在 L2→L3 之间加一层真正的编译流水线。**

---

## 2. 借鉴来源与机制映射

| # | 来源 | 核心机制（原文口径） | 本设计吸收什么 | 不吸收什么 |
|---|---|---|---|---|
| 1 | Karpathy《LLM Wiki》gist（2026-04，5000+ star） | 三层 raw / wiki / schema；**ingest 一次触达 10–15 页**并把操作追加到 log；query 先读 `index.md` 再钻取，答案可回写成页；lint 查矛盾、过期、孤儿页、缺页、缺交叉引用 | `index.md` + `log.md` + 页面 schema；ingest 触达多页；lint 六项；「compile not retrieve」 | 不引入 `qmd`（BM25+向量）二进制，沿用 FTS5 |
| 2 | `cobusgreyling/llm-wiki` | 参考实现：`raw/`、`wiki/{index.md,log.md,synthesis.md,entities/,concepts/,sources/,answers/}`、`templates/`、`AGENTS.md`；ops: ingest / query / lint / ingest-status | 目录布局、模板化页面、`answers/` 回写、ops 状态机 | 不用其 prompt 文案 |
| 3 | `jackwener/llm-wiki` | 工具本身不调 LLM；`search`(BM25+向量) / `graph`(communities, hubs, orphans, **wanted pages**) / `status` / `sync`(mtime+sha256) | **wanted pages**（被引用但不存在的页）、hub/orphan 指标、sync 指纹口径 | 不做社区检测（v1 已定不做聚类） |
| 4 | `Ekgardt/llm-wiki` v5.0.0 | hooks 捕获会话 → `raw/sessions/<date>/`；夜间编译 → `notes/<slug>.md`，**每条引用回原文校验**；12 个任务型工具统一 envelope（schema 版本 + freshness + evidence quality + warnings）；SQLite `synchronous=FULL`；队列 at-least-once 幂等；Markdown 事务 + undo；证据图可重建 | 统一响应 envelope（含 freshness / evidence）；编译幂等 + undo；证据图派生 | 不做「12 个工具」那么宽的 surface，按需给 6–8 个 |
| 5 | `ivkond/llm-memory` | Markdown + Git 为真相；`log/<agent>/raw/*.md` 带 entry_id / source digest / 处理时间戳 | 处理时间戳三件套（ingested/compiled/linted） | 不用 Git 做版本（v1 用 revision） |
| 6 | Ben Holmes（Building LLM Wikis） | raw → skill 编译；每个 wiki 一个独立 schema 文件 | 「每个库一份 schema/约定」的思路，落到 `<vault>/.llm-wiki/schema.md` | 不引入独立 CLI |
| 7 | mem0 v3 | `add()` = 抽取 → **去重**（哈希）→ 存储（批量嵌入）；**ADD-only**，不做 UPDATE/DELETE；异步任务状态可轮询 | ADD-only 语义（L1 已满足）、异步 job 状态可查（jobs 表已有）、**写入即去重** | 不要其向量库 |
| 8 | Graphiti / Zep（arXiv 2501.13956） | 三个子图：Episode(原文) / Semantic(实体+边) / Community；**双时态**：`t_valid,t_invalid`（事实时间）+ `t'_created,t'_expired`（记录时间）；矛盾时旧边失效不删除，支持 as-of 查询；写入 8 步流水线（取上下文→抽节点→消歧→抽边→失效旧边→写情节边→摘要社区） | **claims 双时态表**、失效不删、as-of 查询、边消歧 | 不做社区子图（无嵌入模型） |
| 9 | A-MEM（arXiv 2502.12110） | Zettelkasten 式笔记 `{content, keywords, tags, context, embedding, links}`；链接由嵌入 top-k 候选 + LLM 确认；**记忆演化**：新笔记反过来更新邻居的 context/tags | 「新页写完后，回写邻居页的 related/context」——但改成**追加 + 留痕**，不直接覆盖 | 不做嵌入索引 |
| 10 | ACE（arXiv 2510.04618） | 不微调，维护一份结构化「playbook」：条目带稳定 id + helpful/harmful 计数；Generator→Reflector→**Curator** 用**增量 delta（ADD/UPDATE/REMOVE）**改 playbook，确定性合并去重，避免 brevity bias / context collapse | L3 候选的**差分更新**与**稳定 id**、计数反馈、剪枝；差分不喂整本 | 不做在线自适应（我们是离线+人工闸门） |

---

## 3. 目标架构

```
                       ┌──────────────────────── DSH 宿主进程 ────────────────────────┐
 会话事件 ──capture──▶ │  L1 sources（不可变，sha256 去重，触发器拒改）                  │
                       │        │                                                     │
                       │        ▼  编译（compile）                                    │
                       │  ┌──────────────┐   产出 patch（可审）                        │
                       │  │  assembler   │◀── index.md（页面目录：标题+摘要+标签）        │
                       │  └──────┬───────┘                                             │
                       │         │ patch[]: {op: add|update|contradict|link, page, …}   │
                       │         ▼                                                     │
                       │  L2 extractions ──人工审核闸门（唯一写入）──▶ 落页               │
                       │         │                                     │               │
                       │         ▼                                     ▼               │
                       │  L3 页面（Markdown 真相层）  ◀──渲染/回填──  SQLite 派生索引     │
                       │   concepts/ decisions/ entities/ answers/ timeline/ index/ log  │
                       │         │                                                    │
                       │         ├── claims（双时态主张，失效不删）                      │
                       │         ├── links（页间 wikilink 图）                          │
                       │         └── lint_findings（矛盾/过期/孤儿/缺页/缺引用/缺口）     │
                       │                        │                                      │
                       │   检索：index-first → BM25 → 图扩展 → 组装 → ≤8 条/≤24KB        │
                       └───────────────────────────────────────────────────────────────┘
```

一句话的职责划分：

- **L1**：证据，只增不改（v1 已实现，不动）。
- **L2**：跨来源材料 + 编译产出的**补丁**（页面 diff），仍然是「待审对象」。
- **L3**：**页面**。Markdown 文件是真相，SQLite 只存索引、版本、claim、链接、lint 结果、待审补丁。
- **claims**：页面里的句子级主张，带双时态，负责「同一件事的旧说法/新说法」。
- **lint**：定期在页面群上找矛盾、过期、孤立、缺页、缺引用、缺口，产出可审的修复建议。

### 3.1 页面类型与目录（在 v1 §11 布局上扩展）

```
<vault>/Library/<项目名>/Projects/<project_id>/
  index.md              # 页面目录：每页一行「标题 — 一句话摘要 — 标签」，编译前必读
  log.md                # 追加式操作日志（grep 友好）
  concepts/<slug>.md
  decisions/<slug>.md
  entities/<slug>.md    # 【新】人/项目/系统/概念实体
  answers/<slug>.md     # 【新】值得留档的检索答案
  timeline.md           # 【新】该项目的时间线（由 claims 的有效期生成）
  .llm-wiki/schema.md   # 【新】该库的页面约定（人类可改）
```

`Library/索引.md` 保留为跨项目总索引（v1 已有）。

### 3.2 页面 schema（frontmatter 增量）

```yaml
---
title: 转炉 TSC 碳温预测的评估口径
project: BaoSteel
project_id: 70a11510e813
kind: decision            # concept | decision | entity | answer | timeline | index
status: approved          # candidate | approved | discarded | deferred | stale
revision: 3
wiki_id: 01J9Z…           # 页面稳定 id（ULID）
sources: [01J9A…, 01J9B…] # L1 source id 列表（证据入口）
claims: [01J9C…, 01J9D…]  # 本页承载的 claim id
related: ["[[碳命中容差]]", "[[联合命中率]]"]
tags: [评估, 命中率]
updated: 2026-10-21T07:12:00Z
compiled_from: { extraction: 01J9E…, fingerprint: 3f9c… }
---

正文。每段紧跟证据锚点，锚点必须是 sources 里某条内容的逐字片段：

碳命中容差 ±50 raw（≈±0.05%），温度 ±12℃。^[01J9A:quote="±50 raw（≈±0.05%）"]
联合命中单列，不取分区百分比的平均。^[01J9B:quote="合并只按命中数 / 有效炉数"]
```

**【改】v1 的 `zhixu_id` 字段改名为 `wiki_id`**（本插件已改名 `dsh-llm-wiki`）。已落库的旧笔记由迁移脚本改写。

**引用校验（沿用 v1 并加强）**：`^[srcId:quote="…"]` 里的 `quote` 必须能在该 source 的 `content` 里逐字找到，否则该段不落页、记 `lint_findings(kind='broken-quote')`、整页 `status=candidate`。这比 v1「丢弃该引用」更严格：**引用坏了就是页坏了**，不静默降级。

### 3.3 `index.md` 的生成与读取

- 生成：每次页面**落页成功后**重算（不是每次编译）。每行固定格式，便于人读和模型读：
  ```
  - [决策] 评估口径 — 碳命中/温度/联合命中的容差与合并规则 — #评估 #命中率 — r3 — 2026-10-21
  ```
- 规模上限：超过 **120 页**时按 `project_id` 拆成 `index/<project_id>.md`，主索引只留项目行（Karpathy 的 ~100 sources 界线）。
- 读取：编译器每次都读 index（受 token 预算约束，见 §5.3），**不扫全库**。

### 3.4 `log.md` 与 `ops` 表

```markdown
## [2026-10-21] ingest | 转炉 TSC 碳温预测评估口径
- 新页 concepts/碳命中容差.md
- 更新 decisions/评估口径.md（r3）：第 2 段加入联合命中口径，旧说法 ↓ 失效
- 失效 claim 01J9C（"联合命中按分区加权"）
```

`ops` 表存同一份结构化数据（`id, kind, target_layer, target_id, payload, created_at`），UI 的「记录」视图直接读它。**log.md 是给人 grep 的，`ops` 是给程序用的**——两者由同一次事务写。

---

## 4. 数据模型增量（`migrations` → v2）

```sql
-- 页面：L3 的实体化。Markdown 是真相，这里只存指针与检索用字段。
CREATE TABLE pages (
  id            TEXT PRIMARY KEY,          -- ULID，即 frontmatter wiki_id
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('concept','decision','entity','answer','timeline','index')),
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  path          TEXT NOT NULL,             -- 相对 vault 的路径
  status        TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','approved','discarded','deferred','stale')),
  revision      INTEGER NOT NULL DEFAULT 1,
  summary       TEXT NOT NULL DEFAULT '',  -- 一句话摘要（写进 index）
  tags          TEXT NOT NULL DEFAULT '[]',-- JSON 数组
  content_sha256 TEXT NOT NULL DEFAULT '',
  ingested_at   TEXT NOT NULL,
  compiled_at   TEXT,
  linted_at     TEXT,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX ux_pages_path ON pages(path);
CREATE UNIQUE INDEX ux_pages_project_slug ON pages(project_id, kind, slug);

-- 主张：句子级、双时态（Graphiti 口径，时间是 ISO-8601 文本）
CREATE TABLE claims (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES pages(id),
  subject      TEXT NOT NULL,              -- 规范化主语（实体 id 或 slug）
  predicate    TEXT NOT NULL,              -- 规范化谓词（受控词表）
  object       TEXT NOT NULL DEFAULT '',   -- 规范化宾语（可空：纯陈述）
  statement    TEXT NOT NULL,              -- 原句（逐字，来自页面正文）
  confidence   REAL NOT NULL DEFAULT 0.5,
  t_valid      TEXT NOT NULL,              -- 事实何时开始有效
  t_invalid    TEXT,                       -- 事实何时不再有效（NULL=仍然有效）
  t_created    TEXT NOT NULL,              -- 这条记录何时被写入
  t_expired    TEXT,                       -- 这条记录何时被取代（NULL=现行）
  superseded_by TEXT REFERENCES claims(id),-- 被哪条新 claim 取代
  source_ids   TEXT NOT NULL DEFAULT '[]',
  CHECK (t_invalid IS NULL OR t_valid <= t_invalid),
  CHECK (t_expired IS NULL OR t_created <= t_expired)
);
CREATE INDEX ix_claims_page ON claims(page_id);
CREATE INDEX ix_claims_spo ON claims(subject, predicate, object);
CREATE INDEX ix_claims_valid ON claims(t_valid, t_invalid);

-- 页间链接：从 Markdown 的 [[wikilink]] 与证据锚点解析出来，可整表重建
CREATE TABLE links (
  from_page TEXT NOT NULL REFERENCES pages(id),
  to_page   TEXT NOT NULL REFERENCES pages(id),
  kind      TEXT NOT NULL CHECK (kind IN ('related','evidence','contradicts','extends')),
  weight    REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (from_page, to_page, kind)
);
CREATE UNIQUE INDEX ux_links ON links(from_page, to_page, kind);

-- lint 结果：一次运行一组，可清空重算
CREATE TABLE lint_findings (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  kind        TEXT NOT NULL
              CHECK (kind IN ('contradiction','stale','orphan','missing-page','missing-link','broken-quote','gap')),
  page_id     TEXT,
  claim_id    TEXT,
  detail      TEXT NOT NULL,
  suggestion  TEXT NOT NULL DEFAULT '',
  severity    TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','error')),
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_lint_kind ON lint_findings(kind, severity);

-- 补丁（编译产出、待审）：把 v1 的 L2 extraction 扩成「页面差分」
CREATE TABLE patches (
  id          TEXT PRIMARY KEY,
  page_id     TEXT,                        -- 新页为 NULL
  project_id  TEXT NOT NULL,
  base_revision INTEGER,                   -- 若为 update，基线页版本
  ops         TEXT NOT NULL,               -- JSON: [{op:'add'|'update'|'contradict'|'link'|'retire', …}]
  status      TEXT NOT NULL DEFAULT 'candidate'
              CHECK (status IN ('candidate','approved','discarded','deferred')),
  fingerprint TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT 'rules',
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE UNIQUE INDEX ux_patches_fingerprint ON patches(fingerprint);

-- 页面访问反馈（ACE 的 helpful/harmful），驱动后续剪枝与排序
CREATE TABLE page_feedback (
  id        TEXT PRIMARY KEY,
  page_id   TEXT NOT NULL REFERENCES pages(id),
  verdict   TEXT NOT NULL CHECK (verdict IN ('useful','irrelevant','wrong')),
  note      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
```

**【改】`abstractions` 表退役**：v1 的 L3 记录由 `pages` 取代。迁移期保留只读：`abstractions` 行按 `kind` 映射为 `pages(kind=concept|decision)`，`citations` 转成页面证据锚点，`edges` 转成 `links`。迁移完 `abstractions` 标 `deprecated`（不删，fsck 不查）。

**【改】`extractions` 表定位收窄**：只保留「编译窗口」与「候选补丁来源」两列用途，正文内容移入 `patches.ops`。新增 `patches` 后，`extractions.status` 的四个态与 `patches.status` 语义一致，UI 队列按 `patches` 走。

---

## 5. 流水线

六个阶段，全部走 `jobs` 表记录（v1 已有），失败可重入：

```
capture → compile → gates(人审) → apply(落页) → link/lint → index/feedback
```

### 5.1 compile（L1+L2 → 补丁）

输入：一批待编译的 L2（默认 12 条，v1 口径）+ 相关 `pages` 的**当前正文**（由 index 选页）+ `schema.md`。

步骤：

1. **选页**：读 `index.md`，按标题/标签/摘要与 L2 关键词做粗匹配（BM25 即可），选 **≤6 页**作为更新候选；实体候选另算。
2. **抽候选**：对每个窗口，产出
   ```json
   { "page": { "kind": "decision", "slug": "评估口径", "title": "…", "summary": "…", "tags": ["评估"] },
     "ops": [
       { "op": "add", "section": "判定标准", "text": "…", "quotes": [{"source_id": "…", "quote": "…"}] },
       { "op": "update", "section": "合并规则", "old": "…", "text": "…", "quotes": […] },
       { "op": "contradict", "claim_id": "01J9C…", "text": "…", "quotes": […] },
       { "op": "link", "to": "[[碳命中容差]]", "kind": "related" }
     ] }
   ```
3. **quote 校验**：每个 quote 必须在该 source 正文里逐字命中（`content.includes`），否则整条 op 标记 `broken-quote` 并降级为「待补引用」，不进入可应用状态。
4. **去重**：指纹 `sha1(project_id | 排序后引用 source 的 sha256 | page_id | base_revision)`；同指纹已有 patch 直接跳过（v1 的幂等口径）。正文相似度用 shingle 去重（12 字滑窗，Jaccard > 0.9 视为重复），防「同一件事写三遍」。
5. **预算**：单轮输入 ≤ 8K、输出 ≤ 2K token（v1 口径）；超限按 L2 条数减半重试一次，再超限则只出 `add` 单条。
6. **降级**：模型不可用时只生成**目录级补丁**（新页标题 + 首段 + 引用），`status=candidate`、`model='rules'`，并在面板顶部常驻 `未配置模型 · 提炼已降级为规则模式`（v1 已有）。

### 5.2 gates（人工审核）—— 唯一写入闸门（不变）

队列单元从「一条 L2」改为「一个 patch」，审核视图要能**并排 diff**：左侧当前页正文（含段号），右侧补丁 op 列表；J/K 选 patch，A 接受/D 丢弃/S 延后/E 编辑，Enter 看证据原文，Esc 返回。

- 接受 patch ⇒ 事务内：写 `pages`（新页或 revision+1）、写 `claims`（新 claim + 被取代的旧 claim `t_invalid`/`t_expired`/`superseded_by`）、写 `links`、写 `reviews`、写 `writes`（`review_id` 必填，v1 不变量）。
- 编辑后接受 ⇒ `reviews.after` 存人改后的正文（v1 已有）。
- **禁止批量接受**（v1 的 autoWrite 永不允许，这里进一步：一次只接受一个 patch）。
- 3 秒撤销：撤销走 `apply` 的补偿事务（删本次 pages 版本、回滚 claim 失效、删 links/writes），不是简单删除状态字段。

### 5.3 lint（六项，对齐 Karpathy 的清单）

| kind | 判据 | 建议动作 |
|---|---|---|
| `contradiction` | 同 `(subject,predicate)` 两条 claim 有效区间重叠且 `object` 不同 | 「确认哪条成立：A 保留、B 失效」 |
| `stale` | 现行 claim 的 `t_valid` 早于配置的 `staleAfterDays`（默认 180），且项目近期有更新 | 「复查来源是否有新版本」 |
| `orphan` | `pages` 里无任何 `links` 进/出的页（index/log/timeline 除外） | 「补 related 链接或并入相邻页」 |
| `missing-page` | 正文里 `[[目标]]` 存在但 `pages` 无该 slug | 「新建该页（wanted page）」+ 一键生成候选 |
| `missing-link` | 两个页面共现同一实体/关键词 ≥3 次却没有 wikilink | 「建议加 related 链接」 |
| `broken-quote` | 证据锚点的 quote 在 source 里找不到 | 「标为待补引用，或删该段」 |

lint 是**只读**的：产出 `lint_findings` 与「候选补丁」，修复仍要人审。`gap`（数据缺口）第一版只报「某 kind 缺失」，即 index 里没有 decisions 却出现多个「决定」类 L2。

### 5.4 检索（index-first，v1 §10 的演进）

```
归一化 → index 粗筛（≤6 页候选） → FTS5 BM25（页面正文 + claims） → 图扩展 1 跳
      → 组装（页正文摘段 + 证据链 L1 + 反向链接） → 截断 8 条 / 24KB
```

- 排序：`score = 0.55*text + 0.2*recency + 0.15*centrality + 0.10*feedback`，权重存 `policies`（v1 只有前三项，**新增 feedback 项**；`page_feedback` 的 useful/wrong 按拉普拉斯平滑转成 [0,1]）。
- 返回体（统一 envelope，借 Ekgardt v5）：
  ```json
  { "ok": true, "schema": 2, "query": "…", "mode": "index+fts",
    "freshness": { "compiledAt": "…", "pendingPatches": 3, "stalePages": 1 },
    "evidence": { "quotes": 12, "verified": 12 },
    "results": [ { "pageId": "…", "path": "…", "title": "…", "kind": "decision",
                   "excerpt": "…", "score": 0.83, "scoreParts": {…},
                   "citations": [ {"sourceId": "…", "locator": "…", "quote": "…"} ] } ],
    "truncated": false, "bytes": 9123 }
  ```
- as-of 查询：`POST /api-llm-wiki/search {q, asOf:"2026-09-01"}` ⇒ 只用 `t_valid <= asOf AND (t_invalid IS NULL OR t_invalid > asOf)` 的 claim 渲染（Graphiti 的时间旅行查询，v1 没有）。

### 5.5 link / index / feedback

- `link`：从页面正文解析 `[[…]]` 与证据锚点，重建 `links`（整表可重建、幂等）。
- `index`：落页后重算 `index.md`（§3.3）。
- `feedback`：检索结果上的 useful/irrelevant/wrong 按钮写 `page_feedback`，影响 `feedback` 分项；`wrong` 同时生成 `lint_findings(kind='contradiction', severity='error')` 提示复核。

---

## 6. 与 v1 的差异清单（实施时逐条改）

| # | v1 | v2 | 理由 |
|---|---|---|---|
| 1 | L3 = `abstractions` 记录 | L3 = `pages` 页面（Markdown 真相） | 让人能读、能长、能 diff |
| 2 | 提炼产出 L2 记录 | 提炼产出 `patches`（页面差分） | 审核对象变成「一页怎么变」 |
| 3 | 无 claim / 无时态 | `claims` 双时态 | 矛盾与演进要落点，as-of 查询 |
| 4 | `edges` 四种关系 | `links` + 从 Markdown 解析、可整表重建 | 页面群已有真链接，不必另存 |
| 5 | 检索从 L1/L2 拼 | index-first + 页面正文 + 反向链接 | 减少重复拼装、结果更稳 |
| 6 | 无 lint | 六项 lint + `lint_findings` | 页面群不 lint 会慢慢烂 |
| 7 | 排序三项 | 加 `feedback` 项（0.10），总数仍 1 | 人的有用/无用反馈要能影响排序 |
| 8 | UI 五视图 | 六视图（审核队列/页面/检索/记录/lint/设置），`process` 并入「页面」 | 页面浏览变成主场景 |
| 9 | 页面类型 concept/decision | 增 entity / answer / timeline / index | 实体页与答案回写是 wiki 的关键件 |
| 10 | `zhixu_id` | `wiki_id` | 插件改名 `dsh-llm-wiki` |

---

## 7. UI 增量

- **页面视图**（新主场景）：三栏——左页面树（按 kind 分组 + 搜索框）、中阅读区（Markdown 渲染 + 证据锚点可点开原文）、右证据/反向链接/claim 时间线。
- **审核视图**：从「列表 + 单条详情」改为「patch diff」（§5.2）。
- **lint 视图**：按 severity 分组，一条 finding → 一键生成修复 patch（进审核队列，仍要人审）。
- **检索视图**：结果卡片显示 `freshness`（有多少待编译补丁、多少 stale 页）；as-of 时间滑块。
- 键盘沿用 v1（J/K/A/D/S/E/Enter/Esc），页面视图加 `G` 跳索引、`B` 反向链接、`[` `]` 上/下一页。
- 视觉仍只用 `--dsw-*`（14 个 token，见 DECISIONS D8）。

---

## 8. 里程碑（在 v1 的 M0–M4 之后）

| 里程碑 | 内容 | 验收（可测） |
|---|---|---|
| **M5 页面骨架** | `pages`/`links` 表 + 渲染器 + 页面视图 + index.md 生成 + 迁移 `abstractions`→`pages` | 迁移后页面数 = 原 abstractions 数；`index.md` 行数与页面数一致；空库渲染不崩 |
| **M6 编译补丁** | `patches` 表 + compile（选页/抽候选/quote 校验/去重/预算）+ 审核 diff + apply 事务 + 3 秒撤销 | 同一批 L2 重跑不产新 patch；坏 quote 的 op 不可应用；撤销后 pages/claims/links/writes 全部回滚 |
| **M7 主张与时间** | `claims` 双时态 + 矛盾检测 + claim 失效 + as-of 检索 | 制造两条冲突 claim → lint 报 contradiction；as-of 查询返回旧值；失效 claim 仍在表里 |
| **M8 lint 与反馈** | 六项 lint + `lint_findings` + 修复建议 patch + `page_feedback` 影响排序 | 孤儿页/缺页/缺引用各造一例被报出；feedback=wrong 使该页下次排序下降 |
| **M9 实体与答案** | entity 页、answer 回写（检索结果一键存成页）、timeline.md 由 claims 生成 | 检索答案落页后出现在 index；timeline 与 claim 有效期一致 |

排序理由：M5 先把「页面」立起来（否则后面全挂在记录上），M6 再接编译（最重的逻辑），M7 处理时态（独立性最强），M8/M9 是增值件。

---

## 9. 风险与未决

| 风险 | 处理 |
|---|---|
| 编译 token 成本（每次触达 6 页） | 预算硬上限 + 只读 index 摘要 + 按批减半；`jobs` 里记 token 估算 |
| 页面膨胀 | 每页正文 ≤ 12KB；`update` 优先于 `add`；超过 40 段的页触发「拆页」候选补丁（人审） |
| 中文 slug | 沿用 v1 `slugOf`（保留汉字，去标点，截 40 字符），重名加 `-2` |
| 人改页面导致冲突 | 沿用 v1：`notes.content_sha256` 不一致即停写并报 conflict；M6 起冲突对象变成 `pages.revision` |
| 规则模式质量 | 明确「规则模式只出目录级补丁」，不假装能编译正文；面板常驻降级提示（v1 已有） |
| 双时态口径 | `t_valid` 由人/模型给事实时间，默认取 source 的 `created_at`；`t_created` 取写入时刻，两者不混用 |

**待你确认的三件事**（确认后才动代码）：

1. **页面即真相层**：L3 从记录改成 Markdown 页面，`abstractions` 表退役（数据迁移，不删表）。同意吗？
2. **审核粒度**：从「一条 L2」改成「一个页面补丁」，且一次只能接受一个 patch（禁止批量）。同意吗？
3. **是否引入 claim 双时态**：这是 M7 的独立大件（Graphiti 口径），不做也能有页面群；做则检索支持 as-of。先做还是延后？

---

## 10. 附：与 v1 文档的关系

- `docs/DSH_PLUGIN_SPEC.md` v1 继续有效，作为 M0–M4 的已实现基线；本文件是 v2 增量，实施时逐条改 v1 并保留「改了什么、为什么」。
- 已实现的模块与本文的对应：`lib/pipeline.mjs`（→ §5.1 compile 的规则模式子集）、`lib/review.mjs`（→ §5.2 闸门）、`lib/vault.mjs`（→ §3.2/§3.3 渲染与索引）、`lib/retrieval.mjs`（→ §5.4 的 v1 版本）、`lib/fsck.mjs`（→ §5.3 lint 的一部分：不可变/引用/fts 漂移）。
- 全部决策追加到 `docs/DECISIONS.md`（D16 起）。
