# LLM Wiki 插件 · 验收对照表

规格：`../../../docs/DSH_PLUGIN_SPEC.md` §15（11 条）。本表把每条验收落到**可重跑的测试**与
**线上检查步骤**，避免「看起来能用」当验收。

跑测试：

```powershell
cd E:\project\04-知识库与工具链\libary\dsh-plugin
node scripts/check-syntax.mjs      # 语法 + 禁用 @ts-ignore 等逃生舱
node --test test/*.test.mjs        # 32 项
node scripts/live-check.mjs        # 对正在运行的 DSH 做只读自检（加 ZHIXU_WRITE=1 才走写路径）
```

---

## 1. `pnpm test` 全绿，且无 `any` / `@ts-ignore`

- **测试**：全部 32 项（`test/m0|m1|m2|m3-client|m3-http.test.mjs`）。
- **机制**：`scripts/check-syntax.mjs` 对 `lib/`、`test/`、`scripts/` 逐个 `node --check`，
  并 grep `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`，命中即失败（决策 D1：纯 JS，
  「无 any」退化为「不加类型逃生舱」）。
- **未用 pnpm 的原因**：本包无构建步骤、无运行时依赖（决策 D1/D6），用 Node 内置
  `node --test` 即可；`package.json` 的 `scripts.test` 也指向它，`pnpm test` 同样成立。

## 2. 采集：sha256 校验一致 + 触发器拒绝改删

- **测试**：`m1.test.mjs`「采集：一轮对话落 4 条 L1…sha256 与内容一致」、
  「L1 不可变：UPDATE / DELETE 都被触发器拒绝」。
- **断言**：用户 / 助手 / 工具 / 汇总 4 条 L1；每条 `content_sha256 === sha256(content)`；
  `UPDATE sources` 与 `DELETE FROM sources` 都抛 `sources are immutable`；唯一例外是
  `deleted_at` 从 NULL 变非空（决策 D10）。

## 3. 去重：同一轮重放不新增行

- **测试**：`m1.test.mjs`「去重：同一事件重放不新增行」。
- **机制**：`ux_sources_locator(locator, content_sha256)` + `INSERT OR IGNORE`。

## 4. 引用逐字校验：quote 必须能在 L1 原文里找到

- **测试**：`m2.test.mjs`「提炼：一轮对话产出一条 L2 候选，引用逐字命中原文，重跑幂等」、
  「不变量：…fsck 报得很准」。
- **机制**：`pipeline.mjs` 落库前用 `content.includes(quote)` 校验；不命中就丢引用并在
  `uncertain` 上记 1；`fsck` 另有一条「approved 无引用」检查（spec §7 不变量）。

## 5. 审核闸门：未审核时 `writes` 为空

- **测试**：`m2.test.mjs`「审核闸门：未采纳不得写入…」。
- **断言**：对 `candidate` 直接 `vault.write` 抛「未采纳」；`writes` 计数保持 0；
  采纳后才出现 1 条 `writes`，且 `writes.review_id` 指向真实 `reviews` 行（外键，
  spec §7 要求必填）。

## 6. 写入幂等：revision 1 → 2 而不是 1 → 1 → 2

- **测试**：`m2.test.mjs`「审核闸门：…采纳后 vault 落文件且只增 revision」。
- **机制**：`vault.compareText()` 比较前抹掉 `updated:` 与 `revision:` 两行（决策 D13），
  内容没变就 `changed:false`，不涨 revision；旧内容进 `notes` 表，不另存 `r2` 文件。

## 7. 外部改动：sha256 对不上就拒绝写入

- **测试**：`m2.test.mjs`「外部改动：sha256 对不上就拒绝写入并记为 conflict」。
- **机制**：写前比对 `notes.content_sha256` 与磁盘实际哈希；不一致就停止写入，
  `writes.error='conflict'`，面板在「知识加工」里给出冲突路径。

## 8. 中文检索：短语命中，≤8 条，总字节 ≤24KB

- **测试**：`m1.test.mjs`「检索：中文短语命中 L1…」、`m3-http.test.mjs`「全链路」。
- **机制**：`text.normalizeQuery()`（全角转半角、小写、去标点）→ `text.ftsQuery()`
  （中文 bigram、英文整词）→ FTS5 `MATCH` → 图扩展 1 跳 → `0.6/0.25/0.15` 打分 →
  截断到 8 条 / 24576 字节并置 `truncated`。
- **断言**：结果 `results.length ≤ 8`、`bytes ≤ 24576`、`truncated` 为布尔、
  每条带 `components{text,recency,centrality}` 与 `evidence`。

## 9. 降级：没配模型也能采集/检索/审核/写入

- **测试**：`m0.test.mjs`「overview 反映库计数与降级状态（未配模型 ⇒ rules 模式）」、
  `m2.test.mjs` 全部用例都在规则模式下跑通。
- **机制**：`pipelineModel` 为空 ⇒ `model.mode='rules'`、`degraded=true`；面板顶部常驻
  「未配置模型 · 提炼已降级为规则模式」；不因缺模型而跳过任何写入路径（决策 D11）。

## 10. 视觉：深浅色都用宿主 token，无硬编码颜色

- **测试**：`m3-client.test.mjs`「样式只用 --dsw-* token，且无 iframe / shadow DOM」。
- **机制**：扫描 `lib/client.js` 源码，出现 `#rrggbb` / `rgb()` / `hsl()` 即失败；
  颜色只允许 `var(--dsw-…)`（决策 D7/D8，token 清单来自 `client/Theme.listTokens`）。
- **人工对照**：浅色 / 深色各截一张图看对比度（决策 D8 已把状态色配成
  `state-*` + `bg-base` 文字对）。

## 11. 卸载后 DSH 正常启动

- **步骤**：
  ```powershell
  dsh plugin --profile desktop remove dsh-llm-wiki
  ```
  或 `plugin_manager({ action: 'remove_bundle', target: 'dsh-llm-wiki' })`。
- **要求**：DSH 能正常启动；`$DSH_HOME/llm-wiki/wiki.sqlite3` 与 vault 里的 Markdown
  **保留不动**（数据是用户的，插件只提供写入通道）。重装后数据仍在（插件不删数据）。

---

## 线上检查（重启 DSH 后手动过一遍）

| # | 检查 | 期望 |
| --- | --- | --- |
| L1 | `GET /api-llm-wiki/health` | `200`，`db:"open"`，`vaultPath` 为设置里的路径 |
| L2 | 侧栏 | 出现「Wiki」图标；有未读数时带角标 |
| L3 | 点开面板 | 五视图二级导航，默认停在「审核队列」 |
| L4 | 随便聊两轮 | 「记录」里出现刚才的 user / assistant / tool L1，sha256 与内容一致 |
| L5 | 「知识加工」→ 手动跑一轮 | 生成 L2 候选（规则模式，`uncertain=1`） |
| L6 | 「审核队列」按 `A` | 队列自动推进，顶部出现 5 秒撤销条；「记录」的写入表出现 1 条 |
| L7 | vault | `<vault>/Library/<项目>/Projects/<project_id>/concepts/<slug>.md` 出现文件 |
| L8 | 「检索」输入中文短语 | 命中条数 ≤8，L3 在前带证据链，三路分值可见 |
| L9 | 手改 vault 里那个 md 再写一次 | 面板报 conflict，不覆盖人类的手改 |
| L10 | 设置页 | `autoWrite` 只读且写着「永不允许打开」；`llm-wiki` 命名空间下可改 vault 路径等 |

> 冲突之后的出口是 **`POST /api-llm-wiki/resolve`（面板「知识加工」里的「接受我这版」按钮，
> 决策 D15）**：把人的手改登记成新的 revision，文件一个字节都不动，插件从这一版继续写。

---

# v2 验收（页面 / 补丁 / 主张 / lint）

规格见 `../../docs/specs/DSH_WIKI_SPEC.md` §8。每一条都能落到具体测试名或线上步骤。

| # | 验收 | 落在哪 |
| --- | --- | --- |
| V1 | schema v2 六张表建好，旧库迁移后 `migrations` 记到 2 | `m5.test.mjs`「schema v2 六张表」/「abstractions 迁移到 pages」 |
| V2 | 页面 Markdown 有 frontmatter（title/project/kind/status/revision/wiki_id/sources/related/updated）与 `## 出处` | `m5.test.mjs`「渲染 frontmatter 与出处」 |
| V3 | 只增 revision：同一内容再写一次 `changed:false` 不涨号 | `m5.test.mjs`「写文件三态」 |
| V4 | 在 vault 外手改文件 → 拒绝写入、记 conflict、文件不被覆盖；`rebaseline` 后 revision+1 且回填正文 | `m5.test.mjs`「写文件三态」后半段 |
| V5 | 编译产出补丁，每条 op 的 quote 必须是原文逐字片段；复跑按指纹去重 | `m6.test.mjs`「编译产补丁 + 复跑 + 指纹去重」/「quote 校验」 |
| V6 | 相似正文不重复建页（shingle 相似度 > 0.9 跳过），同 kind 已有页面走 update 且带 `baseRevision` | `m6.test.mjs`「相似度去重」/「同 kind 走 update」 |
| V7 | 主张按「主语 + 谓语 + 宾语」拆出，矛盾只在与有效期重叠时成立 | `m7.test.mjs`「切句规则」/「矛盾检测」/「时态序列不重叠不算矛盾」 |
| V8 | 双时态 as-of：同一个问题在 2026-03 答旧值、2026-08 答新值；新主张落地把旧主张 `t_invalid` 置位但保留历史 | `m7.test.mjs`「as-of 双时态」/「自动失效」；`m10-api.test.mjs`「as-of 时点」 |
| V9 | 补丁闸门：未采纳的补丁不写任何文件；`writes.review_id` 必填；已应用的补丁不能直接丢弃（先撤销） | `m8.test.mjs`「接受补丁」/「丢弃延后」；`m10-api.test.mjs`「闸门只收三种动作」 |
| V10 | 撤销先恢复旧主张再删新主张（顺序反了会丢掉历史），正文回到补丁前 | `m8.test.mjs`「撤销后旧主张复活」 |
| V11 | 体检七类都能报：矛盾 / 过时 / 孤岛 / 缺页 / 缺链 / 坏引用 / 缺口 | `m9-lint.test.mjs` 全部 7 项 |
| V12 | 检索 index-first：页面在前、原文字段在后，条数 ≤8、总字节 ≤24KB，四路分值可见 | `m10-api.test.mjs`「v2 全链路」/`m1.test.mjs`「中文检索命中」 |
| V13 | 降级常驻提示：未配置模型时 `model.mode='rules'`，面板顶部显示「未配置模型 · 提炼已降级为规则模式」 | `m10-api.test.mjs`「v2 全链路」（断言 `model.mode`）；线上 L9 |
| V14 | 反馈影响排序：`useful` 后该页 `feedback` 分值上升 | `m10-api.test.mjs`「全链路」的 `/page-feedback` 段 |
| V15 | 卸载后 DSH 正常启动，库与 vault 原样保留 | 同 v1 第 11 条 |

## v2 线上检查表（`scripts/live-check.mjs` + 面板）

| # | 检查 | 期望 |
| --- | --- | --- |
| W1 | `GET /api-llm-wiki/health` | `version:"0.3.0"`、`db:"open"` |
| W2 | `POST /api-llm-wiki/wiki-overview` | `model.mode:"rules"`、`patches.candidate` 有数、`pendingSources` 有数 |
| W3 | `POST /api-llm-wiki/compile` | `inserted ≥ 1`，op 只有 `add/update/claim/link` 四种 |
| W4 | `POST /api-llm-wiki/patch` | `id` 为 ULID，`ops` 数组里 `quotes` 每条 `verified:true` |
| W5 | 面板「审核队列」按 `A` 采纳 | 文件落到 `Library/<项目>/Projects/<project_id>/concepts/`，页面 `revision:1` |
| W6 | `POST /api-llm-wiki/page` | `claims` 与 `citations` 都非空（证据锚点已落库） |
| W7 | `POST /api-llm-wiki/wiki-search` 带与不带 `asOf` | 都不超过 8 条 / 24KB；`asOf` 落在主张出生前时 `claims` 为空 |
| W8 | `POST /api-llm-wiki/ask` | `degraded:true`（规则模式）、`sources` 有出处、正文含 `## 出处` |
| W9 | `POST /api-llm-wiki/lint` | 七类计数齐全（可以全 0），结果写进 `lint_findings` |
| W10 | `GET /api-llm-wiki/fsck` | `ok:true`、`issues:[]`（含 L3 = pages 的 FTS 行数校验） |

