# LLM Wiki（DSH 原生插件 `dsh-llm-wiki`）

把「会话即采集」的知识库做成 DSH 原生插件：采集入口、编译流水线、审核动作全部收在
DSH 同一进程内，不再需要旁挂的 Python 服务。名字里的 `llm-wiki` 取自 2026 年那批
「摄入时编译、查询时只读页面」的知识库实践（见 `../../docs/DSH_WIKI_SPEC.md` 的谱系表）。

- 规格：`../../docs/DSH_PLUGIN_SPEC.md`（v1：采集 / 提炼 / 审核 / 写入，已实现）
- 现行设计：`../../docs/DSH_WIKI_SPEC.md`（v2：页面 / 补丁 / 主张双时态 / lint，已实现）
- 施工要求：`../../docs/DSH_PLUGIN_PROMPT.md`
- 技术调研：`../../docs/research/dsh-plugin-server.md`、`../../docs/research/dsh-plugin-client.md`
- 与旧 Python 后端（`../src/library_companion/`）**并列、互不依赖**，不迁移其代码。

## 目录

```
dsh-plugin/
  package.json          插件清单（dsh.bundle.patch 是 bundle 的唯一标记）
  cordis.patch.yml      patch 条目：id=llm-wiki（= 设置命名空间），name=dsh-llm-wiki
  lib/
    index.mjs           宿主入口：name / inject / Config / apply（采集订阅、编译巡检、路由挂载）
    config.mjs          条目 Config（schemastery，全部 .volatile()）+ 默认值归一
    paths.mjs           $DSH_HOME/llm-wiki 数据目录、默认 vault、旧目录迁移
    schema.mjs          v1 十三张表 + v2 六张表（pages/claims/links/patches/lint_findings/page_feedback）
    db.mjs              node:sqlite 封装（WAL、事务、迁移、policies、计数）
    ids.mjs             ULID / ISO 时间 / sha256 / 项目 id
    text.mjs            字节安全截断、Markdown 切段、查询归一、FTS 查询构造
    store.mjs           懒开库 + 出错降级
    capture.mjs         session/event → L1（去重、切段、密钥遮蔽、汇总快照）
    pipeline.mjs        v1 L1 → L2 提炼（规则模式、quote 校验、幂等指纹）
    slug.mjs            文件名 slug（保留汉字，冲突加序号）
    migrate-v2.mjs      v1 abstractions → v2 pages 的一次性迁移（幂等、不删旧表）
    pages.mjs           页面 CRUD、Markdown 渲染、只增 revision 落盘、冲突与 rebaseline、索引重算
    claims.mjs          主张拆句（主语/谓语/宾语）、双时态（t_valid/t_invalid、t_created/t_expired）、矛盾失效
    compiler.mjs        编译：L1 窗口 → 页面补丁（规则模式、quote 逐字校验、指纹/相似度去重）
    apply.mjs           补丁闸门：合并正文、落 claim、证据锚点、撤销（先恢复再删）
    lint.mjs            体检七类：矛盾 / 过时 / 孤岛 / 缺页 / 缺链 / 坏引用 / 缺口
    retrieval.mjs       归一 → FTS5 → 图扩展 → 打分（text/recency/centrality/feedback）→ 截断；index-first 检索
    review.mjs          v1 审核闸门（L2 的 accept/discard/defer/edit + 撤销）
    vault.mjs           v1 Markdown 写入（只增 revision、冲突检测、原子写）
    indexer.mjs         FTS 行同步（L1/L2/L3=pages）、中心度、整表重建
    fsck.mjs            不变量自检（触发器在、approved 有引用、FTS 行数、外部改动）
    api.mjs             v1 业务处理（/api-llm-wiki/*，与 HTTP 解耦便于单测）
    wiki-api.mjs        v2 业务处理（页面/补丁/检索/问答/体检/反馈）
    routes.mjs          /api-llm-wiki/* JSON 路由（裸 Node http handler，v1+v2 共 44 条）
    client.js           浏览器半（CJS 工厂）：sidebar.panellist + main 整页，六视图
  test/                 node --test：m0（骨架）、m1（采集/检索/库）、m2（v1 提炼/审核/写入）、
                        m3-client（浏览器半协议与纯函数）、m3-http（v1 真 HTTP 全链路）、
                        m5（页面/链接/写入幂等）、m6（编译产补丁）、m7（主张与双时态）、
                        m8（补丁闸门与撤销）、m9-lint（体检）、m10-api（v2 全链路 HTTP）
  docs/DECISIONS.md     开发决策记录（与规格冲突时先改规格再改代码）
  docs/ACCEPTANCE.md    验收清单 → 对应测试 / 线上检查步骤
  scripts/live-check.mjs 对运行中的 DSH 做自检（只读；LLM_WIKI_WRITE=1 才走写路径）
```

## 数据落点

| 内容 | 路径 |
| --- | --- |
| 数据库 | `$DSH_HOME/llm-wiki/wiki.sqlite3`（缺省 `~/.dsh/llm-wiki/`） |
| 日志 | `$DSH_HOME/llm-wiki/logs/` |
| Markdown vault | 默认 `E:/files/知序知识库`（目录名沿用旧名以免已有笔记失联，可在设置里改） |

数据库与日志**不进 git**。SQLite 是索引与状态，Markdown 才是真相层：页面的 `revision`
只增，磁盘上的文件被外部改动过就停止写入并记 `conflict`。

## 面板

侧栏图标「Wiki」（有未读数时带角标）→ 整页 `main[key=llm-wiki]`，页内左侧二级导航六视图：

1. **审核队列**（默认）：待审补丁列表 + 补丁详情（逐条改动 + 证据锚点）。键盘 J/K 上下、
   A 采纳、D 丢弃、S 暂缓、E 编辑、W 写入、Enter 展开证据、Esc 返回；裁定后 5 秒内可撤销。
   采纳即落 Markdown（`Library/<项目>/Projects/<project_id>/<concepts|decisions>/<slug>.md`）。
2. **知识加工**：页面/主张/补丁/待编译计数、立即编译、关系边表；未配模型时常驻降级提示。
3. **检索**：index-first（先页面、后原文），显示四路分值与证据链，可点「有用 / 不相关」。
4. **问答**：一句话提问，答案按页面拼接并附出处；没命中页面时给下一步建议。
5. **记录**：L1 列表（过滤 + 翻页）与手工补录。
6. **设置**：只读配置、策略闸门（autoWrite 永远只读）、不变量自检 / 重建 FTS / 重算索引。

## 开发与验证

```powershell
# 全量语法检查（含「禁用 @ts-ignore 等逃生舱」）
node scripts/check-syntax.mjs

# 单测（75 项）
node --test test/*.test.mjs

# 只跑 v2 真 HTTP 全链路
node --test test/m10-api.test.mjs

# 对正在运行的 DSH 做自检（LLM_WIKI_WRITE=1 才走写路径）
node scripts/live-check.mjs

# 装进 desktop profile（本包在 workspace 内，不要手写 profile 的 package.json）
dsh plugin --profile desktop add E:\project\04-知识库与工具链\libary\dsh-plugin
```

Host 代码改动需要重新 apply（`plugin_manager` 的 set_bundle 关再开，或重启 DSH）；
`lib/client.js` 走客户端 HMR（宿主重新下发 bundle），但只有在 `pnpm run dev:web` 同时运行时
才免刷新，否则刷新页面一次。

验证顺序：`node scripts/check-syntax.mjs` → `node --test test/*.test.mjs` 全绿 →
宿主日志出现 `[llm-wiki] 已加载` → `node scripts/live-check.mjs` 全绿 →
侧栏出现「Wiki」入口 → 六个视图都有数据（见 `docs/ACCEPTANCE.md` 的线上检查表）。

## 状态

- [x] M0 骨架（包结构 / 清单 / 服务注册 / 空面板 / 设置项）
- [x] M1 采集 + 检索
- [x] M2 提炼 + 审核 + 写入（v1 三层链，保留为 L2 通道）
- [x] M3 图谱 + 反馈
- [x] M4 发布（文档、验收清单、版本 0.2.0）
- [x] M5 页面骨架（pages/links、Markdown 渲染、只增 revision、index.md）
- [x] M6 编译补丁（L1 窗口 → op 列表、quote 逐字校验、指纹/相似度去重、闸门）
- [x] M7 主张与双时态（claims、矛盾检测、as-of 检索、撤销恢复）
- [x] M8 lint 与反馈（七类体检、页面反馈、排名权重）
- [x] M9 实体与问答（entities/answers 页类型、index-first 检索、问答拼装、面板六视图，版本 0.3.0）
