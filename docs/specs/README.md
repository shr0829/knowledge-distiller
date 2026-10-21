# DSH 插件设计文档（仓库内副本）

本目录是「知序 / LLM Wiki」DSH 插件设计与施工文档在**仓库内的副本**，便于在 GitHub 上直接阅读；
写这些文档的地方在工作区的 `docs/`（不在本仓库内），两边冲突时以工作区版本为准，改动请同步。

| 文件 | 内容 |
| --- | --- |
| `DSH_PLUGIN_SPEC.md` | v1 规格：采集 / 提炼 / 审核 / 写入，M0–M4（已实现） |
| `DSH_WIKI_SPEC.md` | v2 设计：页面 / 编译补丁 / 主张双时态 / lint，M5–M9（已实现） |
| `DSH_PLUGIN_PROMPT.md` | 施工要求与纪律（不编造宿主 API、每里程碑跑通再进下一个） |
| `research/dsh-plugin-server.md` | 宿主侧 API 调研（服务、事件、数据库、路由） |
| `research/dsh-plugin-client.md` | 浏览器侧 API 调研（槽位、模块加载器、主题 token） |

实现与验收：

- 代码与目录说明：`../../dsh-plugin/README.md`
- 决策记录（含与规格的冲突与调和）：`../../dsh-plugin/docs/DECISIONS.md`
- 验收对照表：`../../dsh-plugin/docs/ACCEPTANCE.md`
