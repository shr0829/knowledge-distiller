# LLM Wiki 插件开发决策记录

规格与实现冲突时，**先改规格再改代码**，并把决策记在这里（spec §19 纪律）。

> **改名（2026-10-21）**：插件从 `dsh-plugin-zhixu` 改名为 **`dsh-llm-wiki`**，以对齐
> 2026 年那批 LLM Wiki 实现的命名；中文产品名当时叫「知序」，2026-10-21 按用户要求改为「Wiki」。随之改动的标识符：
> patch id / 设置命名空间 / panel id `zhixu` → `llm-wiki`；服务名 `llmWiki`；路由前缀
> `/api-llm-wiki`；数据目录 `$DSH_HOME/llm-wiki/`；库文件 `wiki.sqlite3`；CSS 类前缀
> `zx-` → `lw-`；frontmatter 字段 `zhixu_id` → `wiki_id`。旧库不丢：`paths.migrateLegacyData()`
> 首次打开时从 `$DSH_HOME/zhixu/` 复制库文件，旧目录原样保留以便回退（D16）。

---

## D1 · 用纯 JS（无构建步骤），不用 tsdown + TypeScript

- **规格原文**：§6.2 清单不含构建脚本；§19「官方模板在 `decoration/`，纯 JS、无构建步骤」；
  验收要求「无 any / @ts-ignore」。
- **决策**：宿主半与浏览器半都手写 `*.mjs` / `*.js`，不引入 tsdown、不产出 `dist/`。
- **理由**：① 官方最简插件模板就是纯 JS；② 已装第三方插件（dsh-chat-import / dsh-btw /
  dshmarket）在 profile 里分发的是**已构建产物**，但它们的源码构建链不是运行前提；
  ③ 避免新增构建依赖与网络安装；④「无 any」在纯 JS 下退化为「不加 `@ts-ignore`、不用
  隐式 any 写法」，由 `node --check` + 单测保证。
- **代价**：没有类型检查。用 JSDoc 关键签名 + `node --test` 的单测补。

## D2 · Config 字段扁平化（不进嵌套对象）

- **规格原文**：§13 给出嵌套形状 `capture{p...}` / `pipeline{...}` / `retrieval{...}` / `write{...}`。
- **决策**：`Config` 用扁平键（`captureMaxToolBytes`、`pipelineBatchSize`、
  `retrievalWeightText`…），`lib/config.mjs` 的 `readConfig()` 归一成 `DEFAULTS` 同形状对象。
- **理由**：宿主只把 **`.volatile()` 的叶子字段**投影成设置表单；嵌套对象的 volatile 投影
  未经实测（不编造宿主行为）。扁平键已被 dsh-chat-import 在条目模型下验证可编辑。
- **待办**：若后续实测嵌套 volatile 可用，可改回嵌套并同步本节。

## D3 · 设置命名空间 = patch 条目 id = `llm-wiki`

- **依据**：spec §6.5「设置命名空间 = patch 条目 id」。`cordis.patch.yml` 里
  `id: llm-wiki`，`name: dsh-llm-wiki`。

## D4 · 可选服务一律 `ctx.inject([...], cb)` 惰性注册

- **硬依赖只有 `tools`**（`export const inject = ['tools']`）。
- `webServer` / `settings` / `skills` 都是可选且晚挂载的服务：web 组合的服务插件在本插件
  `apply()` 之后才发布 `webServer`，`apply` 时 `ctx.get('webServer')` 为空。放进 `inject`
  会让插件在 headless / CI 冒烟里整体不激活。

## D5 · 浏览器半 → 宿主的唯一数据通道是 `/api-llm-wiki/*`

- **依据**：spec §17 已决；客户端实测没有内置 RPC 通道给第三方面板用（dshmarket 只
  `fetch` 外网）。同源 fetch 不需要认证头。
- 宿主同时 `ctx.provide('llmWiki', …)` 供其它插件调用（进程内）。

## D6 · 数据库驱动用 `node:sqlite` 的 `DatabaseSync`（已实测）

- 探测脚本 `scripts/probe-sqlite.mjs`：sqlite **3.53.1**，`ENABLE_FTS5` 已编入，
  `CREATE VIRTUAL TABLE … USING fts5(...)` 成功。
- 同步 API ⇒ **单次事务不得跨 `await`**：采集同步写库（spec §8「同步写库、异步提炼、写库不阻塞会话」）。

## D7 · 视觉只用宿主 `--dsw-*` token，样式由客户端自己注入一段 `<style>`

- 浏览器半没有 CSS Modules / 构建步骤，也没有 shadow DOM（spec §6.4）。`apply()` 里
  `ensureStyles()` 往 `document.head` 插一段带 `id="llm-wiki-styles"` 的样式，全部取值
  走 `var(--dsw-*)`（字号用宿主复合简写 `font: var(--dsw-font-s-14)`）。
- 深浅色由 token 自动跟随，不做插件内主题判断。
- 单测 `test/m3-client.test.mjs` 直接扫源码：出现硬编码色值（`#rrggbb` / `rgb(a)`）就失败。

## D8 · 状态色只用 `--dsw-alias-state-*`，主色用 `--dsw-alias-brand-primary`

- **依据**：`cordis_inspect_query(client/Theme.listTokens)` 实测只暴露 14 个 token：
  `bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-overlay` / `border-l1` / `border-l2` /
  `brand-primary` / `label-primary` / `label-secondary` / `state-error-primary` /
  `state-idle-primary` / `state-success-primary` / `state-warn-primary` / `specific-sidebar-fill`。
- **决策**：成功/警告/错误点与边框用 `state-*`；主按钮底 `brand-primary` + 文字 `bg-base`
  （同色系对比对）。`--dsw-font-*` / `--dsw-radius-*` 不在该清单里，一律带兜底值
  `var(--dsw-font-s-14, 14px/20px system-ui, sans-serif)`，缺 token 时仍能读。
- **后果**：面板在任意主题下不出现「看不见的字」（对比对来自宿主 token 的配对）。

## D9 · 宿主没有「会话结束」事件：用 `turn/end` + 5s 去抖写汇总快照

- **依据**：`SessionEventMap` 实测只有 `turn/start|end`、`step/start|end`、`message` 系列、
  `tool/call|result`、`request/*`、`session/end-seed`，**没有 session/end**。
- **决策**：`capture.mjs` 在 `turn/end` 后挂 5 秒去抖定时器，期间没有新事件就写一条
  `meta.role='summary'` 的 L1 快照（spec §8 要求「会话结束 5s 内出现该轮记录」）。
  新事件到来就重排定时器。

## D10 · 软删除是 `sources` 不可变触发器的唯一例外

- **规格冲突**：§7 同时要求 `sources_immutable BEFORE UPDATE … RAISE(ABORT)` 与
  `sources.deleted_at`（软删除）。
- **决策**：触发器条件写成「`deleted_at` 从 NULL 变为非 NULL，且其余列全部不变」才放行；
  `DELETE` 一律 `RAISE(ABORT,'sources are immutable')`。`fsck` 单测断言触发器仍在。
- **理由**：保留两条不变量（不可改内容、不可物理删除），只给「标记删除」留一条窄缝。

## D11 · 提炼不走宿主模型网关，一律规则模式（模型位预留）

- **依据**：`cordis_inspect_query(host/Service.list)` 全量服务目录里没有公开的 LLM 调用服务；
  只有 `agentLoop.createAgent` 这类需要完整会话上下文的东西。
- **决策**：`pipeline.mjs` 只实现规则模式（标题 + 首段 + 引用逐字校验），产出 L2 候选
  一律 `uncertain=1`，不做 L3。`pipelineModel` 配置位保留，面板顶部常驻
  「未配置模型 · 提炼已降级为规则模式」（spec §9 允许的降级路径）。
- **待办**：若宿主后续暴露模型网关，接在 `pipeline.mjs` 的 `extract` 处，不动其它层。

## D12 · 已采纳（approved）的记录不能直接丢弃，必须先撤销

- **依据**：spec §11「写入只增 revision」+ §7「writes.review_id 必填」。approve 之后
  可能已经写进 vault，直接 discard 会让笔记失去依据。
- **决策**：`decide()` 对 `status='approved'` 的 `discard` 抛错，提示先撤销这次采纳。
  撤销（`undoLast`）删除最近一条 review 并把状态回退，之后可重新裁定。

## D13 · 幂等比较抹掉 `updated` 与 `revision` 两个 frontmatter 字段

- **问题**：写入内容含 `updated: <时间戳>` 与 `revision: n`，两者每次渲染都不同，
  直接比 sha256 会导致「内容没变也涨 revision」。
- **决策**：`vault.compareText()` 在比较前把这两个字段替换成占位符；磁盘上仍写真实值，
  `notes.content_sha256` 存真实文件哈希（外部改动检测用它）。
- **测试**：`test/m2.test.mjs`「采纳后 vault 落文件且只增 revision」连写两次断言 `changed:false`。

## D14 · 同一进程内重新 apply 时，先收掉上一份路由；跨版本仍需重启 DSH

- **现象**：开发期用 bundle 开关让宿主重新 apply 新代码后，`/api-llm-wiki/health` 仍返回旧实例的
  内容（旧 handler 还挂在 `webServer` 上，重复注册同一路径会抛 `duplicate route`）。
- **决策**：`routes.mjs` 用模块级 `currentDispose` 记住上一次 `registerRoutes()` 的释放函数，
  下次注册前先调用它；其余路径的注册继续用 per-route try/catch，一条失败不影响别的。
- **边界**：模块级状态只覆盖**同一模块实例**。首次 apply 之后代码变了（老实例的模块图里还没有
  这段逻辑），旧 handler 依然留着——这种跨版本情形必须重启 DSH。README 的验证顺序按重启写。

## D15 · 冲突的出口是「接受人类改动」（`POST /api-llm-wiki/resolve`）

- **问题**：`notes.content_sha256` 与磁盘不一致时插件永久停写（这是对的），但用户需要一条
  「我就是要保留我改的这版」的通道，否则该笔记再也不会更新。
- **决策**：`vault.rebaselineNote()` 把磁盘现状**登记成新的 revision**（人的手改也占号），
  文件内容一个字节都不动；随后插件写入从这一版继续 `revision + 1`。
- **不变量**：仍然「不覆盖人的手改」「旧内容进 notes 表」「writes.review_id 必填」。文件被人删掉时
  清掉 notes 指针，下次写入当新文件从 1 开始。

## D16 · 改名 `dsh-llm-wiki`，旧数据目录复制迁移、不删旧目录

- **动机**：命名对齐 2026 年的 LLM Wiki 实践（`llm-wiki` / `llm-memory` / `project-wiki` 一类），
  让「这是什么」在包名上就成立；中文产品名「知序」不变（2026-10-21 用户要求改为「Wiki」，见 D23）。
- **改动面**：包名、patch id（= 设置命名空间）、panel id、服务名 `llmWiki`、路由前缀
  `/api-llm-wiki`、CSS 类前缀 `lw-`、frontmatter 字段 `zhixu_id` → `wiki_id`。
- **迁移**：`paths.migrateLegacyData()` 在首次需要库文件时，把 `$DSH_HOME/zhixu/*.sqlite3*`
  复制成 `$DSH_HOME/llm-wiki/wiki.sqlite3*`；**旧目录原样保留**，回退只需卸新包装回旧包。
- **踩到的坑**：批量改名把标识符 `zhixuId` 改成了 `llm-wikiId`（非法 JS 标识符），
  `node --check` 抓出；改名脚本必须先处理字符串再处理标识符，或改完必跑语法检查 + 单测。
  另一个坑：服务名改 `llmWiki` 后，单测仍断言 `'llm-wiki'`，需同步（测试也是代码）。

## D17 · v2 的真相层是页面（`pages`），`abstractions` 退役但不删表

- **问题**：v1 的 L3 是 `abstractions` 行（数据库里的一条记录），v2 的 L3 是 vault 里的 Markdown 页面。
  两套并存会让「哪边是真相」模糊。
- **决策**：`pages` 成为 L3 唯一真相层；`abstractions` 表保留（不删，避免破坏旧库），
  由 `lib/migrate-v2.mjs` 一次性转成页面并复制 citations；`indexer.rebuildFts()` 的 L3 段
  改为索引 `pages`。`review.mjs` 的 L3 路径保留给「页面补丁」复用 `reviews` 表
  （`target_layer='L3'`，`target_id` 是补丁 id）。
- **判定标准**：任何「L3 内容」查询都读 `pages`；只有迁移脚本读 `abstractions`。

## D18 · 编译只对「有语义的窗口」出手，运行期噪声在编译阶段剥掉

- **实测的噪声**：规则模式一开始把工具调用窗口也编成页面，产出了「工具：read」这种页面；
  assistant 消息里还带着 `<environment_context>` / `cwd` 这类运行期前缀。
- **决策**：`compiler.pendingSources()` 只取 `kind IN ('dsh-turn','manual')`（工具调用与汇总快照
  不进编译窗口，只作为证据可被引用）；`compiler.sanitizeText()` 在生成标题/摘要时剥掉
  `<environment_context>…</environment_context>` 块以及以 `cwd:` / `Filesystem sandbox` 开头的行。
- **不变量**：**只剥编译产物，不动 L1**（L1 必须保持会话原文，sha256 才是可验证的）。

## D19 · 证据锚点对所有内容 op 落库，旧补丁重编译失效

- **问题**：`add/update` 的补丁也有 `quotes`，但 v1 的 `acceptPatch()` 只把 L2 的引用写进
  `citations`，页面因此没有逐字凭据（`lintBrokenQuotes` 永远查不到东西、检索的 `evidence` 永远为空）。
- **决策**：`accept.mjs` 的 `acceptPatch()` 在事务内对所有内容 op 的 `quotes` 重新校验
  「是 `sources.content` 的逐字子串」，通过的写 `citations(from_layer='PAGE', to_layer='L1')`；
  不通过的丢弃并在返回值里报 `droppedQuotes`。为了让旧补丁也带上锚点，
  编译指纹算法变更（从 `ops` 的 md5 改为 `pageId + op 列表 + quotes` 的 md5），旧补丁重编译时指纹不同。
- **教训**：`citations.from_layer` 的 CHECK 原先只允许 `L2/L3`，v2 需要 `PAGE`；
  旧库用 `db.allowPageCitations()` 重建表迁移（`CREATE TABLE new → INSERT SELECT → DROP → RENAME`）。

## D20 · `fsck` 的 FTS 期望行数按 `pages` 算，不再按 `abstractions`

- **问题**：v2 把 L3 索引进 `pages` 之后，`fsck` 仍拿 `abstractions` 的行数当期望值，
  于是每次线上都是 `fts-drift`，而且 rebuild 也修不好（rebuild 索引的是 pages）。
- **决策**：`fsck` 的 `expectedL3` 改为 `SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL`。
- **教训**：凡是「真相层搬家」，所有按数量校验的不变量（fsck、计数、索引）都要同步，
  否则漂移类告警会变成永久噪声，掩盖真正的漂移。

## D21 · `ask` 的 `degraded` 与 `insufficient` 是两件事

- **问题**：v2 的 `ask` 一开始把 `degraded` 定义成「没命中页面」，同一字段在 `overview`
  里却是「没配模型」，面板徽标因此会说反话。
- **决策**：`degraded` 一律表示「没配模型、由规则拼装」（`modelInfo(state).degraded`），
  「没命中任何页面」改用 `insufficient`；`wiki-overview` 也返回 `model:{mode,model,degraded}`。
- **边界**：宿主没有公开的 LLM 服务（D11），所以 `pipelineModel` 配了也走不到模型调用；
  一旦宿主提供 LLM 服务，`modelInfo` 是唯一需要改的地方。

## D22 · 应用补丁必须有 vault 路径（没有就不写文件、只动库）

- **问题**：`acceptPatch()` 早期在 `vaultPath` 为空时仍返回成功，页面的 `revision` 却停在 0，
  出现「库里有 approved 页、磁盘上没有文件」的假成功。
- **决策**：`wiki-api.patchReview` 的 accept 分支要求 `state.getConfig().vaultPath` 非空，
  否则直接报错「未配置 vault 路径，无法写入 Markdown（先到设置里填 vaultPath）」；
  `acceptPatch()` 拿到路径后必须返回 `file:{path,revision,bytes}` 并用它更新 `pages.path`。
- **不变量**：`writes.review_id` 必填、页面 `revision ≥ 1`、Markdown 才是真相层。

## D23 · 显示名「知序」→「Wiki」，数据路径不动

- **动机**：用户要求（2026-10-21）。面板标题、侧栏入口、README/验收/决策文档标题、
  包描述、生成的 `index.md` 标题统一改成「Wiki」/「LLM Wiki」。
- **不动的东西**：**磁盘路径与标识符一律不动**——vault 仍是 `E:/files/知序知识库`、
  数据目录仍是 `$DSH_HOME/llm-wiki/`、包名仍是 `dsh-llm-wiki`、路由仍是 `/api-llm-wiki/*`、
  patch id / panel id 仍是 `llm-wiki`。理由：显示名是给人看的，改它零成本可逆；路径改名会让
  已有笔记、配置、旧库全部失联，属于数据迁移而不是改名。
- **若确实要改 vault 目录**：先把设置里的 `vaultPath` 指向新目录并把旧目录整体移动，再删空目录；
  不要用改名脚本碰数据。

