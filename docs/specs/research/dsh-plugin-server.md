# DSH 服务端插件机制（研究底稿）

> 日期：2026-10-21
> 方法：只读解包 `E:\software\dsh\resources\app.asar`（单文件，约 182MB）读取第一方源码与 README；同时以本机运行中的 profile `C:\Users\s1215\.dsh\profiles\desktop` 做实证（已安装的第三方插件源码可直接读）。
> 证据分级：【源码】= 读到实现代码；【文档】= 包内 README / 内置 skill 的规范性描述；【未找到】= 未在包内找到对应实现或字段。
> 解包工具：`cd 'E:\project\04-知识库与工具链\.tmp-asar'; node asar.cjs extract 'E:\software\dsh\resources\app.asar' '<正则>' '<目标目录>'`（提取后路径用 `__` 扁平化）。

---

## 0 结论速览

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 插件是什么 | 一个 npm 包 + 一个 cordis patch 文件（声明"往组合树里插一行"） | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`【文档】 |
| manifest 字段 | `dsh.bundle.patch`（必需，声明 bundle）、`dsh.client`（可选，浏览器层）、顶层 `icon`、`exports["./locale/*.json"]` | 同上 + 本机 `dsh-chat-import/package.json`【源码】 |
| 入口导出 | `export function apply(ctx, config)` + 可选 `export const inject` / `export const Config` / `export const name`；或 default export 一个 `Service` 子类。两者不可混用 | `host-plugin.md`；`@deepseek-ai/dsh-agent-tool-presentation/lib/index.js`【源码】 |
| 插件清单文件 | 不是 `dsh.yml`，不是 `config.json`。是 profile 目录下的 `package.json` + `cordis.yml`（恒为 `[]`）+ `cordis.patch.yml` | 本机 profile【源码】 |
| 安装位置 | `%USERPROFILE%\.dsh\profiles\<profile>\node_modules`（pnpm，`nodeLinker: hoisted`）。**没有** `%APPDATA%\dsh\plugins` | 本机 profile【源码】 |
| 注册 HTTP 路由 | `ctx.webServer.register({ kind: 'exact'\|'prefix', path, handler(req,res) })`，返回 disposer；服务名 `webServer`，由 `@deepseek-ai/dsh-host-webserver` 提供 | README 第 59-67 行；`dsh-chat-import/lib/panel.mjs` 实测调用【源码】 |
| 注册工具 | `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`，返回 disposer | `dsh-chat-import/lib/toolkit.mjs:280`、`lib/tools.mjs`【源码】 |
| 注册配置项 | 入口 `export const Config`，字段加 `.volatile()` 才会出现在设置面板表单里 | `dsh-chat-import/lib/import-prefs.mjs`；`@deepseek-ai/dsh-settings` README【源码+文档】 |
| 服务发现 | `ctx.provide(name, value)` 提供；`inject = ['a','b']` 静态声明或 `ctx.inject(['a'], ctx => …)` 延迟挂载；`ctx.get('a')` 取 | `dsh-chat-import/lib/chat-import-service.mjs:121-161`【源码】 |
| 改了要不要重启 | 新装 bundle 可由 HMR 直接激活；替换已装包 / 无 HMR 的 profile 要重启 | `host-plugin.md`；`dsh-plugin-manager` README【文档】 |

---

## 1 加载链路：从 profile 到 cordis fiber

### 1.1 DSH_HOME 与 profile 布局【源码】

本机实际目录：

```
C:\Users\s1215\.dsh\
├─ .credentials.yaml
├─ AGENTS.md
├─ attachments\  cache\  dsh-chat-import\  dsh-market\  dsh-runtimes\
├─ llm-deepseek\  sessions\  storages\  whale-audio\  whale-roles\
└─ profiles\
   ├─ desktop\      ← 当前会话运行在 desktop（$env:DSH_PROFILE=desktop）
   │  ├─ package.json          # 依赖 + dsh.profile.bundles
   │  ├─ cordis.yml            # 内容恒为 []（见下）
   │  ├─ cordis.patch.yml      # 用户 patch 层
   │  ├─ pnpm-workspace.yaml   # nodeLinker: hoisted / autoInstallPeers: false
   │  ├─ pnpm-lock.yaml
   │  ├─ node_modules\         # pnpm 装的第三方插件
   │  ├─ .plugin-manager\logs\operation-*\pnpm.log
   │  └─ .dsh-market\
   └─ web\
```

`profiles\desktop\cordis.yml` 全文（这就是全部的"配置文件"）：

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

**合成顺序（重要）**：`package.json` 的 `dsh.profile.bundles`（按数组顺序）→ profile 的 `cordis.patch.yml` → 命令行 `--patch` 覆盖层。后面的层可以禁用、改配置、追加行；**patch 替换整行的 `config`，不做深合并**（`@deepseek-ai/dsh-base/cordis.patch.yml` 顶部注释 + `dsh-web-app/README.md` 第 105 行）。

### 1.2 唯一入口是 cordis-plugin-loader 的 Entry【源码】

`dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/index.ts`

- `export class Loader extends EntryTree`，以服务名 `loader` 注册：`ctx.reflect.provide('loader', this, this[Service.check])`。
- `unwrapExports(exports)`：`exports.default ?? exports`，遇到 `__esModule` 再取一层 `.default`（index.ts:201-208）。**所以 ESM `export default`、CJS `module.exports`、ESM 具名导出混装的包都能加载**。
- 事件：监听 `internal/config`（配置变更，支持 `!!js` 插值 `interpolate`）、`internal/update`（把 patch 层写回并 `tree.write()`）、`internal/plugin`（插件自行 dispose → 把该行 `disabled` 置 true 写回）。

`dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts`

- 一行的全部字段（`EntryOptions`，entry.ts:10-23）：

```ts
interface EntryOptions {
  id?: string        // 稳定 id，设置命名空间、patch 定向都用它
  name?: string      // 模块 specifier（包名/路径），即 import 的目标
  config?: any       // 交给插件的 config
  group?: string     // 分组，用于树形展示
  disabled?: boolean // 禁用；支持 !!js 表达式（disabledOf → isJsExpr/evaluate）
  inject?: Inject    // 行的 inject（一般由插件导出提供）
}
```

- 加载实现（entry.ts:223-238）：

```ts
async _init() {
  const plugin = await this.tree.import(this.options.name, /* baseUrl */)
  this._plugin = this.tree.loader.unwrapExports(plugin)
  await this.ctx.registry.plugin(this._plugin, this.options.config, this.getOuterStack())
}
```

- **热更新细粒度**：`equalExceptVolatile` 判定"只有 `.volatile()` 字段变了"时不 remount，只提交 volatile 值并 emit `loader/volatile-update`（entry.ts:142-197）。这就是设置面板改开关不用重启的实现基础。

### 1.3 cordis 4.x 的核心 API【源码】

`dsh/node_modules/@deepseek-ai/cordis/src/registry.ts`

```ts
// 插件三种形态
Plugin.Function    = (ctx: Context, config: T) => any
Plugin.Constructor = new (ctx: Context, config: T) => any
Plugin.Object      = { apply(ctx: Context, config: T): any }

// 元数据
interface Plugin.Base {
  name?: string
  Config?: StandardSchemaV1   // standard-schema 校验器（schemastery / zod 都符合）
  inject?: Inject
  provide?: string | string[]
  intercept?: Dict<boolean>
}
type Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }

ctx.plugin(plugin, ...args): Fiber & PromiseLike<Fiber>   // registry.ts:316
ctx.inject(deps, callback)                                 // registry.ts:300-302
// 就是 ctx.plugin({ inject: deps, apply: callback, name: callback.name })
```

无效形态会直接抛：`invalid plugin, expect function or object with an "apply" method, received <type>`（`isApplicable` 判 `typeof apply === 'function'`，registry.ts:8-10）。

`dsh/node_modules/@deepseek-ai/cordis/src/service.ts`

```ts
abstract class Service<T = never> {
  constructor(protected ctx: Context, name: string) {
    const self = this
    self.ctx.reflect.provide(name, self, this[symbols.check])  // 随所属 fiber 卸载自动注销
  }
  // 符号协议：init / check / config / invoke / extend / tracker / resolveConfig
}
```

`Service` 子类的配置由 `[symbols.resolveConfig](base?, head?)` 合并祖先 `ctx.intercept()` 的配置（插件有 `Config.merge` 用它，否则 `Object.assign` 浅合并）。

`dsh/node_modules/@deepseek-ai/cordis/src/context.ts`：`Context` 是 Proxy，暴露 `root`、`events`、`logger`、`reflect`、`registry`，方法有 `extend(meta)`、`isolate(name, label?)`、`intercept(name, config)`。

**生命周期**：一切资源注册都返回/接受 disposer，挂在当前 fiber 上；fiber 卸载时按其所属上下文逆序 dispose。已卸载上下文上建 effect 会抛 `cannot create effect on inactive context`（`fiber.ts` 的 `INACTIVE_EFFECT`）。所以**插件里不要手写 `setInterval`/`process.on`，用 `ctx.effect()` / `ctx.on()` 返回的 cleanup**（`host-plugin.md` 明写）。

---

## 2 插件包结构

### 2.1 最小 manifest（第一方 skill 给的模板）【文档】

`dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

- `dsh.bundle.patch` 是 **bundle 的唯一标记**：没有它，装了也只是一个普通依赖，`plugin_manager` 会报 `not-bundle`，profile 不会加载它。
- `patch` 可以是字符串，也可以是**数组**（按顺序应用）。`dsh-web-app` 的 bundle 就是多 patch："each `presets/<id>.patch.yml` inserts one shipped preset declaration, applied in the order `dsh.bundle.patch` lists them"（`dsh-web-app/README.md:101`）【文档】。
- `files` 字段在本地目录安装（`link:`）时**不过滤**，但发布到 registry 后必须写全，否则运行期缺文件。

### 2.2 一个真实第三方插件的 manifest（本机已装）【源码】

`C:\Users\s1215\.dsh\profiles\desktop\node_modules\dsh-chat-import\package.json`（节选）：

```json
{
  "name": "dsh-chat-import",
  "version": "0.26.2",
  "type": "module",
  "main": "./lib/index.mjs",
  "types": "./lib/index.d.ts",
  "icon": "assets/import.svg",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.mjs" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale"],
      "platform": "web"
    }
  },
  "peerDependencies": {
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

其 `cordis.patch.yml` 只有三行：

```yaml
- insert:
    - id: import-claude
      name: dsh-chat-import
```

### 2.3 字段清单

| 字段 | 必需 | 作用 | 证据 |
| --- | --- | --- | --- |
| `name` / `version` | 是 | npm 包名；profile 的 dependencies 里出现这个名字 | npm 惯例 |
| `type: "module"` | 建议 | 第一方与三方插件全是 ESM | 全部样本 |
| `main` + `exports["."]` | 是 | loader `tree.import(options.name)` 的解析目标 | `entry.ts:223` |
| `dsh.bundle.patch` | 是（要成为 bundle） | 指向本包的 cordis patch 文件，字符串或数组 | `host-plugin.md` |
| `dsh.client` | 可选 | 浏览器侧注入：`{ platform: "web", inject: [...], immediately?: true, external?: [...] }` | `dsh-chat-import`、`dsh-api-job-controller`、`templates/decoration/package.json` |
| `icon` | 可选 | 顶层字符串，相对 manifest；SVG/PNG/JPEG/WebP，≤256KiB，必须在包内 | `host-plugin.md` |
| `locale/en.json`、`locale/zh.json` | 可选 | `{"meta":{"title":…,"description":…}}`，插件列表显示名；`exports` 需含 `"./locale/*.json"` | `host-plugin.md`；`@deepseek-ai/dsh-agent-tool-presentation` 即此结构 |
| `peerDependencies` | 是 | `@deepseek-ai/cordis`、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 等；**不要**把 host 包塞进 dependencies | 三个样本一致 |
| `engines.node` | 建议 | 本机 DSH 要求 `>=22.13` | `dsh-chat-import` |

**第一方包不在 profile 的 node_modules 里**：`@deepseek-ai/*` 从 dsh 安装目录解析（`app.asar` 内的 `dsh/node_modules/`）。这印证了 skill 里那句"shipped packages resolve from the dsh installation"，也是为什么第三方包对 host 包只能写 peerDependencies。

### 2.4 入口导出形状

第一方规范原文（`host-plugin.md`）给了两条互斥路线：

```js
// 路线 A：函数式（最常用）
export function apply(ctx, config) { /* 注册一切资源，全部挂在 ctx 的 effect 上 */ }
export const inject = ['tools']        // 可选：必需服务，缺一则不激活
export const Config = z.object({ ... })// 可选：配置 schema，激活时校验
export const name = 'my-plugin'        // 可选：cordis 插件名（诊断/树展示用）

// 路线 B：Service 子类
export default class MyService extends Service { ... }
```

**不能混用**（例如既 default export class，又 export apply）。真实样本 `@deepseek-ai/dsh-agent-tool-presentation/lib/index.js` 全文：

```js
import z from "@deepseek-ai/schemastery";
const name = "tool-presentation";
const inject = ["tools"];
const Config = z.object({ mode: z.union(["native", "ptc"]).required() });
function apply(ctx, config) {
  if (config.mode === "native") { ctx.tools.presentAs("native"); return }
  ctx.inject(["ptcRuntime"], (runtimeCtx) => { runtimeCtx.tools.presentAs(config.mode) })
}
export { Config, apply, inject, name };
```

它演示了两个关键写法：**必需服务写 `inject`，可选/晚挂载服务用 `ctx.inject([...], cb)` 在 `apply` 内延迟等待**。

`@deepseek-ai/dsh-brand` 是纯类型包（只有 `src/index.ts` 的 interface，没有 apply、没有 ctx），不适合当运行时样本——这一点容易误判。

---

## 3 三条注册主线

### 3.1 (a) 注册 HTTP 路由 / API 端点

DSH 里"对外端点"分两层，不要混淆：

**第一层：给浏览器页面用的普通 HTTP 路由 —— `ctx.webServer`**

提供者：`@deepseek-ai/dsh-host-webserver`（row id `webserver`，见 `dsh-web-app/cordis.patch.yml:179-180`）。它就是一个 `node:http`（配了 `tls` 则 `node:https`）的命名路由表，**不懂任何 harness 概念、也不发文件**。

`peek7\…dsh-host-webserver__README.md:59-67`【文档】：

> `register(route)` adds a named `exact` or `prefix` HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both return a disposer that removes the registration. A duplicate path within either table throws … HTTP matching is exact over the whole table, then longest prefix, then the fallback handler.

第三方实测写法（`dsh-chat-import/lib/panel.mjs`）【源码】：

```js
function jsonRoute(path, handle) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      let status, payload
      try { [status, payload] = await handle(req) }
      catch (err) { status = 500; payload = { ok: false, error: String(err?.message || err) } }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    },
  }
}

export function registerPanelRoutes(ctx, ws, registryDir) {
  ws.register(jsonRoute('/api-import/sessions', async (req) => { /* … */ }))
  ws.register(jsonRoute('/api-import/import', async (req) => { /* … */ }))
  // …
}
```

挂载点在入口里，且**必须当可选服务处理**（`lib/index.mjs`）【源码】：

```js
ctx.inject(['webServer'], (webCtx) => {
  registerPanelRoutes(ctx, webCtx.webServer, registryDir)
})
```

`webServer` 服务可用成员（README 第 39/57/61-67 行）：`register(route)`、`registerUpgrade(route)`、`registerFallback(handler)`（全表唯一）、`collectIndexInjections()`、`renderIndex(html)`、`tapIndex(transform)`、`applyIndexTaps(html)`、`port`、`protocol`（`'http:'`/`'https:'`）、`getOrigin()`；事件 `webserver/index-inject`。重复路径直接抛错（路由是组合级契约）。

**第二层：类型化 RPC（Host ↔ Client 的 `/api`）—— Typert，不是手写路由**

`@deepseek-ai/dsh-api-gateway` README【文档】：Host 侧提供 `ctx.typertGateway`，client 侧提供 `ctx.remote`；业务服务继承 `TypertRemoteService` 并用 `@Remote` / `@RemoteScope` 标注方法（装饰器来自 `dsh-typert-protocol`），或 `bindTypertRemote()`；`@Remote({ mode: 'stream' })` 返回 `Iterable`/`AsyncIterable`；取消感知方法把 `signal: AbortSignal` 声明在最后一个参数。Gateway 在 Connection 的 `/api` FetchHandler 上挂受信拦截器，未认领的请求 404；流走 `/api/remote.mux` WebSocket；`streamInboxBytes` 默认 262144，`websocketHeartbeatIntervalMs` 默认 2000ms；错误码 `gateway/uplink-overflow`、`gateway/protocol`、`gateway/input-invalid`、`gateway/peer-disposed`、`gateway/cancelled`、`gateway/invocations-unavailable`。

结论：**想给"自己的页面"开端点，用 `ctx.webServer.register`；想让 Client 通过类型化通道调 Host 方法，走 Typert（照抄 `dsh-api-job-controller` 的 `dsh.client.external + inject` 声明）。没有"随手 `app.get('/x')`"这种 Express 式 API。**

> 形态注意：host-webserver README 第 12 行说明它"serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge"。本机 desktop profile 的 GUI 实际走 `http://127.0.0.1:59631`，第三方 `/api-import/*` 路由在此形态下可达；但**别把核心能力只押在 webServer 路由上**——headless / CI / 纯 Electron 形态下该服务缺席，`apply` 仍须正常。

### 3.2 (b) 注册 Agent 工具

服务：`ctx.tools`（`@deepseek-ai/dsh-tools`）。核心就一句 `ctx.tools.register(definition)`，返回 cordis effect disposer（注销时同时触发 `tools/change` 重新投影 schema）。

第一方 README 的最小样例【文档】：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'read_text',
  description: 'Read one UTF-8 text file.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute path.' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

第三方实测（`dsh-chat-import/lib/toolkit.mjs:280-312`，`lib/tools.mjs`）【源码】：

```js
return defineTool({
  name: 'import_chat',
  description: '…',
  parameters: {
    format: { type: 'string', required: true, enum: CHAT_FORMATS.map(([f]) => f), description: '…' },
    path:   { type: 'string', description: '…' },
    // …
  },
  output: {
    schema: IMPORT_OUTPUT_SCHEMA,
    render: (args, value) => renderImportResult(args, value, specOf(args.format)),
  },
  async execute(args) { … },
})
```

```js
// 注册门面：ctx.tools.register 的返回值就是 disposer，可开关
disposers = defs.map((def) => ctx.tools.register(def))
```

参数 DSL 支持 `string` / `number` / `integer` / `boolean` / `null` / `array` / `object` / `json` / `oneOf`；`required` 默认 false；注册后**自动进入 system-prompt 的工具 schema**。

其它同服务能力（`dsh-tools` README）【文档】：`ctx.tools.restrict(filter)`、`ctx.tools.guard(guard)`、`ctx.tools.get(name, scope)`、`ctx.tools.schemas(scope)`、`ctx.tools.presentAs('native' | 'ptc')`；事件链 `tools/pre-execute`（allow/deny/ask）→ guards → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`；`ptc` 模式只把 `run_code` 暴露给模型。

### 3.3 (c) 注册配置项（设置面板可见）

三个条件同时成立，设置页才出现你的表单：

1. 入口 `export const Config`（standard-schema 校验器，通常 `@deepseek-ai/schemastery` 的 `z.object`，也接受 zod）；
2. 字段带 **`.volatile()`**；
3. 该行有唯一可寻址的 `id`（即 `cordis.patch.yml` 里的 `id`）。

`@deepseek-ai/dsh-settings` README【文档】："Forms expose only volatile fields from active, uniquely addressed profile entries"；表单按 profile entry id 识别插件；写入持久化到当前 profile 的 cordis patch；重置恢复 profile override 之下的值（含 schema 默认值）。自定义页面用 `configure({ auto: false }, ctx.fiber)` 注册（放在 effect 内，可先 `ctx.inject(['settings'], …)`）；`autoGenerate` 默认 true 但没有内置 client 用它。

第三方实测（`dsh-chat-import/lib/import-prefs.mjs`）【源码】：

```js
// 条目模型：命名空间 = profile 里本插件条目的 id，schema = 入口导出的 Config
export const Config = supportsVolatile(Schema)
  ? Schema.object({
      importSystemPrompt: Schema.boolean().default(true).volatile(),
      injectTools: Schema.any().default('minimal').volatile(),
      sidebarButton: Schema.boolean().default(true).volatile(),
    })
  : undefined
```

两个坑（该文件注释里写明）：

- **`Config` 必须由插件入口导出**，loader 靠它把该行登记为"可配置"；只 `ctx.settings.register()` 的老模型已经过时。
- **entry id 的取法**：loader 把 `ctx.fiber.entry.id` 报成 `"<kind>:<id>"`（如 `insert:import-claude`），而设置服务只按裸 `id` 建索引——写成带前缀会 409 `settings-conflict`；取最后一个 `:` 之后的部分即可。
- 该目录若解析不到 `@deepseek-ai/schemastery`，`Config = undefined` 即"设置里不出现本条目"，插件其余功能照常——这是可选的正确姿势，不要因此抛错。

内置样本 `@deepseek-ai/dsh-api-job-controller/package.json` 展示了同时要浏览器层时的写法【源码】：

```json
"dsh": {
  "client": {
    "external": ["@deepseek-ai/dsh-api-gateway/client"],
    "inject": ["@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-connection"],
    "platform": "web"
  }
}
```

---

## 4 第三方插件怎么被加载 / 安装

### 4.1 安装位置与"配置文件"（实证）

| 你以为的 | 实际的 |
| --- | --- |
| `%APPDATA%\dsh\plugins` | **不存在**（`%APPDATA%` 下无 dsh/deepseek 目录） |
| `dsh\plugins\`（安装目录内） | **不用**；`E:\software\dsh` 只读，profile 才有写权限 |
| `dsh.yml` | **不存在**；`dsh` 根目录下没有任何 `*.yml` |
| `config.json` | **不存在**；配置是 YAML 层的 `cordis.patch.yml` |

真实位置：`%USERPROFILE%\.dsh\profiles\<profile>\`
- 依赖声明：`package.json` 的 `dependencies`（版本/来源）
- 启用声明：`package.json` 的 `dsh.profile.bundles`（**有序**，后加的排后面，顺序影响配置优先级）
- 配置：`cordis.patch.yml`（用户 patch 层，`- id: … name: … config: …` / `disabled: true`）
- 代码：`node_modules\<pkg>`（pnpm，`nodeLinker: hoisted`，`autoInstallPeers: false`）
- 日志：`.plugin-manager\logs\operation-*\pnpm.log`（pnpm 原始输出）
- 兼容豁免：`compatibility.json`（与 `package.json`、`cordis.patch.yml` 同级）

### 4.2 正规安装路径：`plugin_manager` 工具 / 插件页

`cordis-plugin-development/SKILL.md`【文档】：
- 安装：`plugin_manager` 的 `action: install_bundle`，`target` 传**绝对包目录**（本地开发）或 registry spec / git / tarball；安装进当前 profile，**对所有会话生效并跨重启**。
- 禁止：手写 profile 的 `package.json` / `cordis.patch.yml`；在 profile 目录跑 pnpm。
- 其它动作：`list_plugins`、`list_bundles`、`set_plugin`、`set_bundle`、`remove_bundle`。
- `application` 字段是判据：`applied` 才算生效；`failed` / `overridden` / `restart-required` 语义不同（`restart-required` 还带 `restartReason: 'no-hmr' | 'package-moved' | …`）。
- 校验：`dsh --profile "$DSH_PROFILE" --dump-config` 打印合成后的树；`DSH_PROFILE` / `DSH_PROFILE_DIR` 环境变量在任何 shell 里可见。

`@deepseek-ai/dsh-plugin-manager` README【文档】补充的硬事实：
- 一切工具动作要求 `danger-full-access` 或该次调用的审批；**插件 Host 代码在进程内运行、不受 workspace 沙箱约束**——这是权限模型上必须写进文档的一条。
- 注册表顺序：`options.registry` → 配置的 `registry` → `fallbackRegistries`（默认 `['https://registry.npmmirror.com/']`）；私有 registry 单独问、不会回落到公共。
- 安装前检查：本地路径读其 `package.json`，registry spec 用 `pnpm view` 拿 `engines` / `peerDependencies`；**DSH 版本不满足直接拒绝**（错误码 `incompatible-version`，带 `name`/`version`/`runtimeVersion`/`requirements`），此时不下载、不跑构建脚本。
- 版本不兼容的豁免：`compatibility.json` 里按 `package@version → 精确 DSH 运行时版本列表` 授权，须 `acceptRisk: true`；CLI 为 `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <ver> --accept-risk`。
- 失败恢复：pnpm 或 bundle 校验失败 → 还原 `package.json` + `pnpm-lock.yaml` 快照；已下载文件可能残留。
- 卸载顺序：从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → `pnpm remove` → 发布解析表。

### 4.3 什么时候要重启

| 场景 | 结果 |
| --- | --- |
| 新装一个 bundle（HMR 开着的 profile） | 直接激活，`applied` |
| 替换/升级已安装的包 | 必须重启（模块代际要换）：无 HMR 时 `restart-required` + `restartReason: 'no-hmr'` |
| 只改 `cordis.patch.yml`（HMR 开着） | 重新组合，不重启 |
| 只改 `.volatile()` 字段的值 | 不 remount，`loader/volatile-update` |
| 改的是 `file:` / `link:` 本地目录里的代码 | 必须重启（README：linked packages "rebuilding and restarting remain necessary"） |
| profile 是 startup-only（无 HMR） | 安装/启用/成功移除都只发布解析表，等重启 |

`dsh-base/cordis.patch.yml` 里的 `hmr` 行 `config.root: []` 决定监听根；`disabled: !!js "!ctx.get('profileContext')"` 这种写法让 `plugin-manager`、`hmr`、`config-editor`、`settings` 只在 profile 启动时启用【源码】。

### 4.4 探测逻辑（"能不能被当成插件"）

loader 侧只有一条判据：`options.name` 能否 `import` 成功，且导出能被 `unwrapExports` 归一成"函数或带 `apply` 的对象"（否则抛 `invalid plugin…`）。**bundle 判据在 plugin-manager 侧**：包的 `package.json` 必须有 `dsh.bundle.patch`，否则 `listBundles` 报 `not-bundle`（未选中的普通依赖直接不列）。

`listBundles` 还会标 `official`（安装目录自带或按需目录项）、`optional`（launcher 的 `OPTIONAL_BUNDLES`：随包发布但默认关闭、不可卸载）、`availability: readable | missing`、`installed`（profile 是否声明依赖）——**`installed` 不代表能加载**，`enabled` 也只是保存的选择。

---

## 5 插件与服务如何互相发现

### 5.1 三种写法

```js
// 1) 静态声明必需服务：缺一个就不激活（不报错，只是 pending）
export const inject = ['sessionPersistence', 'fs', 'tools']

// 2) 延迟挂载可选服务：服务稍后可用时执行回调，回调拿到新 ctx
ctx.inject(['webServer'], (webCtx) => { /* … */ })

// 3) 直接取（同步；不存在得到 undefined）
const svc = ctx.get('chatImport')
```

`ctx.inject(deps, cb)` 与 `ctx.plugin({ inject: deps, apply: cb })` 等价（`registry.ts:300-302`）。

### 5.2 提供服务

```js
export function registerChatImportService(ctx) {
  if (typeof ctx.provide !== 'function') return          // 老/裁剪版宿主的防御
  const service = Object.freeze({ importPath, importAll, resumeSummary, /* … */ })
  ctx.provide(SERVICE_NAME, service)                      // SERVICE_NAME = 'chatImport'
}
```

`dsh-chat-import/lib/chat-import-service.mjs:121-161`【源码】。`ctx.provide(name, value)` 是宿主 `ReflectService` 的入口，读取侧用 `ctx.get(name)`（`dsh-chat-import/lib/index.mjs` 注释里即写"apply 时 `ctx.get('webServer')` 为空"，故路由必须 `ctx.inject` 延迟挂载）。两个方法都与当前 fiber 绑定：fiber 卸载，服务自动消失（`Service` 构造函数里 `ctx.reflect.provide` 同理，见 `cordis/src/service.ts`）。

### 5.3 第一方服务名（写文档时可直接引用）

从 `dsh-base/cordis.patch.yml` 的行 id 与第三方代码用法看得到的服务名（非穷举）：
`loader`、`tools`、`webServer`、`web`、`session`、`sessionPersistence`、`fs`、`commands`、`skills`、`settings`、`workspaceRegistry`、`agents`、`typert`/`typertGateway`、`jobs`、`llm`、`authorization`、`pluginManager`、`hmr`。

取服务前先评估"缺了会怎样"：`dsh-chat-import` 的选择是——`sessionPersistence`/`fs`/`tools` 写进 `inject`（缺了根本没法工作），`webServer`/`skills`/`commands`/`settings` 全部走 `ctx.inject`，于是 headless / CI 里插件照常激活，只是没有面板和命令。

---

## 6 插件最小骨架（可直接落盘）

```
dsh-plugin-zhixu/
├─ package.json
├─ cordis.patch.yml
├─ index.js
├─ locale/en.json        # 可选：列表显示名
└─ assets/icon.svg       # 可选：≤256KiB
```

`package.json`

```json
{
  "name": "dsh-plugin-zhixu",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0",
    "@deepseek-ai/schemastery": "^3.0.0"
  },
  "engines": { "node": ">=22.13" }
}
```

`cordis.patch.yml`

```yaml
- insert:
    - id: zhixu
      name: dsh-plugin-zhixu
      config:
        capture: true
```

`index.js`

```js
import z from '@deepseek-ai/schemastery'

export const name = 'zhixu'
export const inject = ['tools']              // 必需服务

export const Config = z.object({
  capture: z.boolean().default(true).volatile(),   // volatile → 设置面板可改、免重启
})

export function apply(ctx, config) {
  // (b) Agent 工具
  const disposeTool = ctx.tools.register({
    name: 'zhixu_search',
    description: '在本地知识库中检索。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词' },
      limit: { type: 'integer', description: '返回条数，默认 8' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      return search(args.query, { signal: exec.signal, limit: args.limit ?? 8 })
    },
  })

  // (a) HTTP 路由（可选服务，晚挂载）
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'exact',
      path: '/api-zhixu/ping',
      handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') },
    })
  })

  // (5) 对外提供服务
  ctx.provide('zhixu', Object.freeze({ search }))

  // 需要自己收尾的资源一律挂 effect
  ctx.effect(() => () => { /* disposeTool 由 fiber 自动调用，无需手写 */ })
}
```

自检清单：

1. `dsh --profile "$DSH_PROFILE" --dump-config` 能看到 `id: zhixu` 那一行；
2. `plugin_manager` `listBundles` 里能看到本包（且有 `meta.title` 时列表显示中文名）；
3. 设置页出现 `capture` 开关，改了不重启即生效；
4. 工具出现在模型工具表里，`zhixu_search` 可调用；
5. 停用（`disabled: true` 或 `set_plugin`）后工具与路由同时消失，进程不残留句柄。

---

## 7 未找到 / 未验证

- **`%APPDATA%\dsh\plugins`、`dsh\plugins\`、`dsh.yml`、`config.json`**：全部【未找到】。DSH 没有这套传统配置文件布局，别在规格文档里写。
- **独立的"Fetch route 注册"服务（除 Typert 与 webServer 之外）**：未找到。`webServer` 的 `registerFallback` 只让一个处理器占全表，`/api` 由 Connection + Typert gateway 认领；普通 REST 端点的唯一开放口就是 `ctx.webServer.register`。
- **`@deepseek-ai/dsh-api-job-controller` 的实现代码**：只读了 manifest（`lib/index.js` 14215B 未细读），其 Remote 方法的真实标注写法建议下一次直接读该文件确认。
- **`ctx.get` / `ctx.provide` 的确切实现**：来自 `cordis/src/reflect.ts`（未逐行读），本稿依据的是第三方代码的实际调用与 `Service` 构造函数里的 `ctx.reflect.provide`。
- **`dsh-host-webserver` 的 `route` 对象是否还有除 `kind`/`path`/`handler` 之外的字段**（如 `methods`）：README 只提到三种注册函数，`panel.mjs` 只用 `kind`/`path`/`handler` 且自行判断 `req.method`；如需限定方法建议在 handler 内判断。
- **HMR 对 `link:` 目录源码的监听粒度**：README 只说"rebuilding and restarting remain necessary"，未给目录级结论。

---

## 8 证据索引（文件 → 关键位置）

| 路径 | 内容 |
| --- | --- |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md` | bundle 创作流程、`plugin_manager` 动作、profile 环境变量、知识来源优先级 |
| `…/cordis-plugin-development/references/host-plugin.md` | 最小 manifest、两种入口形态、locale/icon、安装与启用语义 |
| `…/cordis-plugin-development/references/practices.md` | 扩展点强弱、`tools/pre-execute` 的 `ask`、session 事件约束、性能与 UI token |
| `…/cordis-plugin-development/templates/decoration/{package.json,index.js,cordis.patch.yml}` | 最小可跑模板（含 `dsh.client`） |
| `app.asar/dsh/node_modules/@deepseek-ai/cordis/src/registry.ts` | `Plugin.Function/Constructor/Object`、`Plugin.Base`、`ctx.plugin`（316）、`ctx.inject`（300-302）、`isApplicable`（8-10） |
| `app.asar/dsh/node_modules/@deepseek-ai/cordis/src/service.ts` | `Service` 构造即 `ctx.reflect.provide`、`resolveConfig` 合并规则 |
| `app.asar/dsh/node_modules/@deepseek-ai/cordis/src/context.ts` | `Context` 代理、`extend`/`isolate`/`intercept` |
| `app.asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/index.ts` | `Loader` 服务名、`unwrapExports`（201-208）、`internal/config|update|plugin` |
| `app.asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts` | `EntryOptions`（10-23）、`_init` import+plugin（223-238）、volatile 免 remount（142-197） |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` | 529 行 base 组合；`disabled: !!js` 用法；行字段只有 id/name/disabled/config |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` | `webserver` 行（179-180）→ `@deepseek-ai/dsh-host-webserver` |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-host-webserver/README.md` | `register`/`registerUpgrade`/`registerFallback`、`port`/`protocol`/`getOrigin`、匹配顺序 |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/README.md` | `defineTool` 样例、参数 DSL、`restrict/guard/presentAs`、事件流水线 |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-settings/README.md` | 只暴露 `.volatile()` 字段、按 entry id 识别、`configure({auto:false})` |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md` | install/remove/inspect 语义、registry 顺序、兼容性检查、`restartReason` |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/README.md` | Typert RPC、`@Remote`、`/api/remote.mux`、gateway 错误码 |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-tool-presentation/lib/index.js` | 47 行完整函数式插件样本 |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-brand/src/index.ts` | 反例：纯类型包，无 apply |
| `C:\Users\s1215\.dsh\profiles\desktop\package.json` | `dsh.profile.bundles` 实际顺序 |
| `C:\Users\s1215\.dsh\profiles\desktop\cordis.yml` | 恒为 `[]` + 合成顺序注释 |
| `C:\Users\s1215\.dsh\profiles\desktop\cordis.patch.yml` | 用户 patch 层真实写法 |
| `…\node_modules\dsh-chat-import\package.json` | 三方 bundle manifest 全字段 |
| `…\dsh-chat-import\lib\index.mjs` | `name`/`inject`/`apply`、`ctx.inject(['webServer'])`/`['skills']` 延迟挂载 |
| `…\dsh-chat-import\lib\panel.mjs` | `ws.register({kind:'exact', path, handler})` 实测 |
| `…\dsh-chat-import\lib\tools.mjs` / `toolkit.mjs` | `ctx.tools.register` 返回 disposer；`defineTool` 真实参数 |
| `…\dsh-chat-import\lib\import-prefs.mjs` | `Config` + `.volatile()`、entry id `kind:id` 与 409 `settings-conflict` |
| `…\dsh-chat-import\lib\chat-import-service.mjs` | `ctx.provide('chatImport', …)` 对外服务 |
