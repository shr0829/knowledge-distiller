# DSH 客户端/前端插件机制（研究底稿）

> 日期：2026-10-21
> 目标：给"第三方 UI 插件规格文档"提供事实基础。
> 方法：只读解包 `E:\software\dsh\resources\app.asar`（单文件，182,794,869 字节）。`app.asar.unpacked` 只含 node-pty 等原生模块，**不含**前端代码。
> 解包工具（工作目录 `E:\project\04-知识库与工具链\.tmp-asar`）：
> - `node asar.cjs list <asar> <正则>`：列成员。
> - `node extract2.cjs <asar> <正则> <dest> [stripPrefix]`：保目录结构抽取。
> - `node hits.cjs <pkg> <needle> [before] [after] [max]`、`node slice.cjs <pkg> <a> <z>`、`node countneedle.cjs <needle>`：在压缩后的 bundle 里定位原文。
>
> 证据分级：**【源码】**= 读到实现代码；**【文档】**= 包内 README 或内置 skill 的规范性描述；**【未找到】**= 在包内确实没找到。
> 已抽出的内容在 `E:\project\04-知识库与工具链\.tmp-asar\x\`：`pkgs\`（62 个 `dsh-client-*` 包的 `lib/client.js` + README）、`manifests\`（304 个 `@deepseek-ai/*` 的 package.json）、`web\`（前端产物）、`skills\`（内置插件开发 skill 与模板）、`slots.json`（99 个 slot 的结构化目录）。

---

## 0 结论速览

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 客户端入口字段 | `package.json` 的 `exports["./client"]`（必需，字符串或 `{default}`）+ `dsh.client`（`platform` 必填，`inject` / `external` / `immediately` 可选） | `dsh-client-modules/lib/index.js:172-182`【源码】 |
| 产物形态 | **不是 ESM**。普通 `<script src>` 加载的 CJS 工厂包装：`window.__ModuleLoader__.load({ id, factory(require){…} })`，`require` 由浏览器模块表解析；tsdown 构建，代码分割编译为 `require.async("./client.<name>.js")` | 62 个 `lib/client.js` 首行；`dsh-client-modules/README.md`【源码+文档】 |
| 是否需要 vite/每插件构建配置 | 不需要。bundle 只要求 `pnpm run build` 产出 `lib/client.js`；"no per-plugin wiring"（构建配置统一在 DSH 仓库侧，第三方包只需产出该文件） | `dsh-client-modules/README.md:30,54`【文档】 |
| `dsh-client-*` 约定 | 是**命名倾向**而非硬规则：78 个包声明 `dsh.client`，其中 62 个以 `dsh-client-` 开头；16 个不是（如 `dsh-api-gateway`、`dsh-cordis-client-runner`） | `x/manifests/*/package.json` 扫描【源码】 |
| 前端加载入口 | `window.__ModuleLoader__`（Host 注入的 queue 门面）+ `window.__DSH_BOOT__`（boot 图）+ 可选 `window.__DSH_TRANSPORT__`；**没有** `window.__DSH_PLUGIN__` | 全仓 grep 0 命中；`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`【源码】 |
| 插件清单字段 | `__DSH_BOOT__ = { rev, release:{version,commit}, entries:[{id,url,rev,inject?,external?}], batches:[{phase,url,rev,entries}] }` | `dsh-client-modules/lib/client.js:108-160` `parseBootManifest`【源码】 |
| UI 贡献 API | 唯一入口是 **slot**：`ctx.slots.register(options, Component)`，以及 `ctx.slots.inject(slotKey, () => ctx.slots.register(...))` | `dsh-cordis-client-runner/lib/client.js:1362-1396`【源码】 |
| slot 数量 | **99 个**，四种 kind（`single` / `keyed` / `list` / `chain`） | `x/slots.json`【源码】 |
| 能否嵌入完整自定义 React 面板 | **能**。`main` 是 keyed slot，`key` 即侧栏面板 id，整页由插件渲染（内置 Plugins 页就是这样做的） | `dsh-client-ui-plugin-manager/lib/client.js` @620125【源码】 |
| 样式隔离 | **没有 shadow DOM**（全仓 `attachShadow` 0 命中）。用的是构建期 CSS Modules 短哈希类名 + 主题 CSS 变量 `--dsw-*` | 各 `lib/client.js`；`references/practices.md`【源码+文档】 |
| 官方脚手架 | **【未找到】** 没有 `create-dsh-plugin`、没有 `@deepseek-ai/dsh-plugin-template`。唯一模板是内置 skill 里的 `templates/decoration/` | `x/skills/.../cordis-plugin-development/templates/`【源码】 |
| 市场 / 安装 | 没有第三方市场服务；有官方"按需目录"页面（`dsh-client-ui-plugin-market`）与 `dsh plugin --profile <p> add <pkg>`、`plugin_manager` 工具 | `dsh-plugin-manager/README.md:75`；`dsh/lib/bin.js:48`【文档+源码】 |

---

## 1 包结构：一个客户端插件长什么样

### 1.1 package.json 的三个层次

以官方模板 `x/skills/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json` 为例【源码】：

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

三层含义：

1. `exports["."]` → Host 半（cordis 插件，`export function apply(ctx) {}` 即可为空壳）。
2. `exports["./client"]` → **浏览器半**，就是被 `/plugins` 路由直接当静态文件发出去的那个 `client.js`。
3. `dsh.bundle.patch` → 声明"往组合树里插一行"的 patch 文件（3 行 YAML）：

```yaml
# templates/decoration/cordis.patch.yml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

另有两个可选导出：`exports["./locale/*.json"]`（Settings → Plugins 列表里的 `meta.title` / `meta.description` 文案）与 `exports["./icon"]`（列表图标）【源码，模板同目录 `locale/en.json`、`icon.svg`】。

### 1.2 `dsh.client` 到底有哪几个字段

Host 侧解析器在 `dsh-client-modules/lib/index.js:61-75`（`parseDshClient`），只认四个字段【源码】：

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `platform` | `string` | 是 | 无枚举校验，但只有 `"web"` 会被收纳；别的值该包被跳过（`index.js:733`） |
| `inject` | `string[]` | 否 | 激活顺序（拓扑提示），**不产生模块依赖** |
| `external` | `string[]` | 否 | 只允许"非基线"精确请求，见 1.5 |
| `immediately` | `boolean` | 否 | 页面启动时预取该 bundle（否则首次 import 才拉） |

错误文案示例：`client-modules: <pkg> dsh.client.platform must be a string`。

实测分布（`x/manifests` 全量扫描）：`{"inject":[],"platform":"web","immediately":true}` 与 `{"external":[...],"inject":[...],"platform":"web"}` 两种典型形态；全部 78 个声明者的 `platform` 都是 `"web"`。

### 1.3 客户端入口解析规则

`dsh-client-modules/lib/index.js:172-182`【源码】：

- 只认 `exports["./client"]`；可以是字符串，也可以是 `{ default: string }`。
- 条件导出可用（如 `dsh-api-gateway` 的 `{ "./client": { "types":…, "node": "./lib/client.node.js", "browser": "./lib/client.browser.js", "default": "./lib/client.browser.js" } }`），解析器取 `default`。
- 缺失即抛：`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。
- `<id>/client` 与裸包名解析到**同一份 exports**：`stripClientSuffix`，`lib/client.js:98-100`，注释原文 *"a plugin bundle IS its package's client half"*。

### 1.4 产物形态：CJS 工厂 + 经典 script

`x/pkgs/dsh-client-ui-plugin-manager/lib/client.js` 第 1 行起【源码】：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(expor…
```

要点：

- **不是 ESM**：没有 `export`/`import` 语句，是被当普通脚本 `<script src>` 执行的（注入行 kind `script-src`，见 2.1）。
- `require(spec)` 从浏览器**静态模块表**取模块；`require.async(spec)` 走代码分割（`dsh-client-modules/lib/client.js` @38621 定义：`require.async = async (spec) => { … }`，相对路径 `./client.<name>.js` 变成 revisioned 的 `/plugins/<id>/client.<name>.js?rev=…`）。
- 官方构建链是 **tsdown**：README 原文 *"A source `import()` split by tsdown compiles to `require.async("./client.<name>.js")`"*（`dsh-client-modules/README.md`，What the browser loads 段）【文档】。
- 构建产物必须存在：*"the host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch; a missing bundle fails activation loudly"*。缺失时 Host 抛 `client bundles not found; <CLIENT_BUNDLE_BUILD_INSTRUCTION>`【源码，`lib/index.js`】。
- 体积参考：`dsh-client-ui-plugin-manager/lib/client.js` 单文件 622 KB（含全部 UI + i18n）。

### 1.5 浏览器模块表（基线）

前端 bundle `dsh-web-frontend/dist/index.html` 只引用 `assets/index-CN7NIWNw.js`；该 bundle 内 `SZ()` 定义的静态模块表正好 12 项【源码】：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, zod, @tanstack/react-virtual,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

- 插件 `require('react')` 拿的就是这一份，**不要自带/重复安装 React**（`ui-plugin.md`：*"React comes from the browser module table"*）【文档】。
- 想请求非基线模块，必须写进 `dsh.client.external`，且 Composition 会拒绝畸形请求、缺供应商、自请求、同步环：`client-modules: module graph cycle A -> B`、`client-modules: "X" requests module "Y" that answers itself`【源码，`lib/index.js`】。
- 但 `practices.md` 明确规定：**业务代码不要 require 别的 Harness Client 包**（如 `@deepseek-ai/dsh-client-ui-primitives`），`dsh.client.inject` 只表达顺序（见 4.3）【文档】。

---

## 2 加载链路：从 index.html 到 mount

### 2.1 Host 往页面里注入了什么

前端 `index.html` 是纯静态壳（`<div id="root">` + 一个 module script），**HTML 里没有 `__DSH_BOOT__`**；它由 Host 的 index 注入机制逐行塞进去【源码，`dsh-client-modules/lib/index.js`】：

```js
ctx.on("webserver/index-inject", (table) => table.push(...bootInjections(this.composed)))
```

`bootInjections(graph)` 生成 5 行（顺序即执行顺序）：

| 行 | 内容 |
| --- | --- |
| `{kind:"script", placement:"head", text: queue}` | 定义 `window.__ModuleLoader__ = { mode:"queue", pendingQueue, load(registration), create(options) }` |
| `{kind:"script-preload", src}` | application 批 combo（预取） |
| `{kind:"script-src", placement:"head", src}` | bootstrap 批（只有 `@deepseek-ai/dsh-client-modules` 自己） |
| `{kind:"global", name:"__DSH_BOOT__", value:graph}` | boot 图（`<` 被转义） |
| … | 另有 `{kind:"style"}`、`{kind:"html"}` 供其它插件用；未知 kind 抛 `web boot: unknown index injection row` |

`create(options)` 在队列里找 `@deepseek-ai/dsh-client-modules` 的 registration，缺了就抛：`client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`。

### 2.2 `__DSH_BOOT__` 精确 schema

`dsh-client-modules/lib/client.js:108-160`（`parseBootManifest`）【源码】：

```ts
{
  rev: string,
  release: { version: string, commit?: string },
  entries: [{ id, url, rev, inject?: string[], external?: string[] }],
  batches: [{ phase: "bootstrap" | "application", url, rev, entries: string[] }]
}
```

对应报错原文（说明这些字段是强校验）：`client-modules: window.__DSH_BOOT__ is missing or not an object`、`boot manifest rev must be a string`、`boot manifest entries must be an array`、`boot manifest entry "X" must carry string id/url/rev`、`duplicate graph entry "X"`、`boot manifest batch phase must be "bootstrap" or "application"`、`boot manifest entry "X" belongs to more than one batch`。

归一化后有两个视图：`manifest.modules`（带 `url`/`rev`）与 `manifest.plugins`（`{id, inject, immediately}`，只用于预取）。

**没有 `__DSH_PLUGIN__`**：在 62 个客户端 bundle 与 940 KB 的前端 bundle 里 grep 均 0 命中【未找到】。所谓"注册表"就是 `__ModuleLoader__` 的 queue + `dsh-client-modules` 维护的 `Map<id, module>`。

### 2.3 启动顺序（`web boot`）

前端 bundle 内启动类（`index-CN7NIWNw.js`）【源码】：

1. `await globalThis.__DSH_BOOT_READY__?.promise`；
2. 取 `globalThis.__ModuleLoader__`，缺失即报 `web boot: window.__ModuleLoader__ bootstrap facade is missing`；
3. 取可选 `globalThis.__DSH_TRANSPORT__`（Electron 传 `{ownsHost:true, streamBaseUrl}`，Web 由 Host 注入）；
4. `modules.create({ boot: __DSH_BOOT__, staticModules: SZ(), … })`；
5. 预取 `manifest.plugins.filter(p => p.immediately)`；
6. `await modules.entries.start(loader, manifest)`；有失败则聚合报 `web boot: N entries did not activate`；
7. `ctx.uiRenderer.mount(container)`。

`dsh-client-ui-renderer/README.md`【文档】：`mount` 安装 slot renderer、hydrate `[data-dsh-boot]`、返回卸载 disposer，并且**执行唯一一次** `renderSlot('root')`；*"The first application frame waits for every client entry"*；slot 渲染没有 Suspense、没有逐 entry 懒加载。

启动期 UI 是 `data-dsh-boot` / `data-dsh-boot-spinner` 的占位（文案 "Loading plugins…"、"Failed to load plugins"）。

### 2.4 `/plugins` 路由与 combo

- 前缀路由：`const PLUGIN_ROUTE = "/plugins"`，`webServer.register({ kind:"prefix", path: PLUGIN_ROUTE, handler: this.serveBundle })`；Electron 的 shell-owned carrier 用 `fetchBundle(request)` 走同一响应【源码】。
- combo URL：`/plugins/??<id>/client.js,<id2>/client.js&rev=<12hex>`；浏览器引用去前导 `/`；`MAX_COMBO_URL_BYTES = 3 * 1024`；缓存头 `public, max-age=31536000, immutable`。
- 失败与重试：一个 combo 的 `<script>` 加载失败会再请求一次；成功加载但没注册到行则**不重放**（批量脚本按顺序注册，重放会撞重复注册）；之后每个仍缺失的行单独走单资源 combo，所以"一个失败批最多每缺失行 3 次请求"。
- **惰性**：combo 只注册 factory，模块体在首次 import/materialize 时才执行。

### 2.5 release 与热更新（`dsh-client-hmr`）

- 图里带 `release: { version: <包版本>, commit: <构建时固化的 commit> }`（当前产物是 `0.2.1-rc.2` / `332895e`），两个字段都相等才算同一 release。
- Host 换了 release 时页面**什么都不应用**：`console.warn('client-modules: Host release changed from … to …; plugin updates pause until this page reloads')`，并把状态发到 `ctx.modules.entries.releaseChange`；只能刷页面。
- bootstrap 批不可替换：`client-modules: replacing bootstrap module X requires a page reload`。
- HMR 传输是 SSE：`dsh-client-hmr` 客户端 `const EVENTS_ROUTE = "/plugins/events"`，用 `fetch(..., {headers:{accept:"text/event-stream"}})` + `EventSourceParserStream`；帧类型 `graph`（整图快照 → `entries.sync`）与 `rebuilt`（`{id, rev}` → `entries.reload`）。错误文案：`client-hmr: invalid event frame: …`、`client-hmr: /plugins/events closed; client graph changes stop until the page reloads`。
- Host 侧配置项 `pollIntervalMs` 默认 `500`；开发循环用 `pnpm run dev:web`（`--no-serve` 只挂 watcher）。
- README 明确：*"Web transport only — Electron installation and backend restart handling do not use this SSE path"*。

---

## 3 贡献 UI 的注册 API（真实函数名与签名）

### 3.1 两层：`SlotCore`（注册表）与 `ctx.slots`（服务）

第一层是 `dsh-client-ui-slots` 里的 `SlotCore`（该类被内联进前端 bundle，asar 里没有独立包）：

```js
// 前端 bundle，导出模块
SI = Object.freeze({ SlotCore: $I, SlotOwnershipError: bI, StaleAuthorizationError: kI, resolveSlotLabel: CI, standardHookPropName: xI })
xI = (e) => `use${e[0].toUpperCase()}${e.slice(1)}`
CI = (e) => typeof e == "function" ? e() : e
```

第二层是 DSH 暴露给插件的 cordis 服务 `ctx.slots`。它的类型目录在 `dsh-cordis-client-runner/lib/client.js:1362-1396`（`SERVICE_API` 的 `slots` 项）【源码】，只有三个方法：

```ts
declare readonly register: SlotCore['register']
// 注释：必须是原型方法，cordis service proxy 才能把 this.ctx 绑到调用者的 ctx，
// 从而把 effect 归属与卸载级联挂到调用者 fiber。

declare readonly registerFactory: RegisterFactory
// (options, component) => () => void

inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
// 原文：Install an effect for each declaration lifetime of a slot. The callback runs
// synchronously when the declaration already exists; otherwise it runs inside the
// declaring register() call after the declaration is committed. Collapse disposes the
// effect and a later declaration runs it again.
```

（同一服务还有 `provideRoot({ hooks })`、`subscribe`、`entries`、`snapshot` 等，来自 `SlotCore` 原型。）

### 3.2 `register(options, Component)` 的签名

`SlotCore.register` 在 `dsh-cordis-client-runner/lib/client.js` 的类型目录里是三个重载（原文摘录，已去掉最长的泛型约束）【源码】：

```ts
register<K extends keyof SlotMap & string, …>(
  options: BaseOptions<K, EntryKey, D, H, M, N> & { inject?: undefined },
  component: SlotComponent<ComposedProps<…>>
): () => void

register<K extends keyof SlotMap & string, I extends object, …>(
  options: BaseOptions<K, EntryKey, D, H, M, N> & { inject: (...args: InjectParams<K, H>) => I },
  component: SlotComponent<ComposedProps<…, I, …>>
): () => void

register(options: ErasedOptions, component: unknown): () => void
```

`SlotComponent<P> = (props: P) => ReactNode`。

实际可用的 `options` 字段（由内置插件的真实调用点归纳，均为【源码】）：

| 字段 | 说明 |
| --- | --- |
| `name` | **必填**，目标 slot 的 key（必须先被声明，见 3.3） |
| `id` | `list` kind 必填，同一 slot 内去重键 |
| `key` | `keyed` kind 必填（如 `main` 用侧栏 panel id） |
| `select` | `chain` kind 必填，`(owner) => unknown \| null` |
| `order` | `list` 内的次序（`priority` 相同时用） |
| `priority` | 遮蔽用；**低者先渲染**（`single` 里同 priority 只能一个） |
| `label` | `string \| (() => string)`，侧栏/设置项显示名 |
| `locale` | 该 entry 的 i18n 命名空间（`label` 里 `t()` 用它） |
| `store` | 该 entry 私有 store：`{ getSnapshot, subscribe, create, actions }` 或 `createXxxStore` 工厂 |
| `inject` | `(...args) => props`，把 store 的 actions / 服务折叠成组件 props |
| `children` | 子槽声明表 `{ "<slot>": { kind, scope } }`（决定谁能往你这里注册） |
| `registrant` | 诊断署名，默认 `fiber.name` |

返回 **disposer**（`() => void`）。同时该注册被 `ctx.effect` 绑定，fiber 卸载时级联回收。

### 3.3 四种 kind 与"必须先声明"规则

`register` 的第一件事【源码，`SlotCore.register`】：

```js
const r = this.records.get(e.name);
if (!r?.spec) throw new Error(`slot "${e.name}" is not declared (a parent entry's children table must declare it)`);
```

即：**slot 必须由某个已挂载的 entry 的 `children` 表（或内置 root）声明过，否则注册直接抛错**。kind 语义：

| kind | 约束 | 报错原文 |
| --- | --- | --- |
| `single` | 同 priority 只能有一个 | `single slot "X" already has a registration at priority N (registered by …) — register at a different priority to shadow it (lowest renders)` |
| `keyed` | 必须 `options.key` | 按 key 去重 |
| `list` | 必须 `options.id` | 按 id 去重 |
| `chain` | 必须 `options.select` | `entriesOfSlot` 返回全部，由拥有者做选举 |

排序：`list` 先 `priority` 再 `order`；其余只按 `priority`，低者先渲染。渲染期崩溃的 entry 会 `abdicate`（让位，不再参与渲染），并在 console 打 `slot entry crashed in '<slot>'`。

### 3.4 99 个 slot 里跟"贡献界面"相关的那批

完整目录见 `.tmp-asar\x\slots.json`（含每个 slot 的 `summary` / `optNames` / `standardProps` / `declaredBy` / 上游源码行号）。关键项：

| 界面位置 | slot | kind / scope | 需要的 options |
| --- | --- | --- | --- |
| 整页主视图 | `main` | keyed / root | `key`（= 侧栏 panel id） |
| 左侧栏面板图标 | `sidebar.panellist` | list / root | `id`, `order?`, `label?` |
| 侧栏底部动作（设置旁） | `sidebar.footer.action` | list / root | `id`, `order?`, `label?` |
| 设置页（新增一页） | `settings.section` | list / root | `id`, `order?`, `label?` |
| 设置页里的一行（不必整页） | `settings.general.item` | list / root | `id`, `order?`, `label?` |
| Plugins 设置里的新 tab | `settings.plugins.tab` | list / root | `id`, `order?`, `label?` |
| Plugins 页（管理页）内的 tab | `plugins.tab` | list / root | `id`, `order?`, `label?` |
| 全窗浮层（modal/toast） | `shell.overlay` | list / root | `id`, `order?`, `label?` |
| 底部整条（三列之下） | `shell.bottom` | single / root | 无 |
| 左上角窗体装饰位 | `shell.leading` | single / root | 无 |
| 会话输入框下方 | `conversation.composer.dock` | list / session | `id`, `order?`, `label?` |
| 会话输入框上方 | `conversation.composer.bar` | single / session-maybe | 无 |
| 右侧栏 tab | `sidebar.right.pane.tab` | keyed / session | `key` |
| Toast | `workspace.toast` | keyed / root | `key` |

**状态栏：未找到。** 99 个 slot 里没有 status-bar 类 key；需要"常驻状态条"只能落在 `shell.leading` / `sidebar.footer.action` / `shell.bottom` 之一【未找到】。

每个 slot 的 `standardProps` 是一串 selector hooks，由 renderer 统一注入（如 `useRemoteAccess`、`useResource`、`useWorkspaces`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useSessionAccess`、`useWorkspaceAccess`；session 域另有 `useChat`、`useConversation`、`useInput`、`inputActions`、`sessionId`、`useProjection`、`useAccess`、`useTrajectory`）。hook 名由 `standardHookPropName('panelInfo') → 'usePanelInfo'` 生成。

### 3.5 真实注册代码（三处，可直接对照）

**(a) 声明 `root` 并挂载框架** — `dsh-client-ui-layout/lib/client.js:624` 起【源码】：

```js
const layout = new LayoutController(instance.actions, (id) => ctx.slots.entries("main").some((entry) => entry.options.key === id), {
  getSnapshot: () => instance.getSnapshot().panelInfo,
  subscribe: (listener) => instance.subscribe(listener)
});
const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } });
const disposeService = ctx.reflect.provide("layout", layout);
const disposeRegistration = ctx.slots.register({
  name: "root",
  locale: "common",
  children: {
    "sidebar":        { kind: "single", scope: "root" },
    "main":           { kind: "keyed",  scope: "root" },
    "rightbar":       { kind: "single", scope: "root" },
    "shell.bottom":   { kind: "single", scope: "root" },
    "shell.overlay":  { kind: "list",   scope: "root" },
    "shell.leading":  { kind: "single", scope: "root" }
  },
  store
}, AppFrame);
```

**(b) 一个完整自定义主面板（内置 Plugins 页）** — `dsh-client-ui-plugin-manager/lib/client.js:4411` 起（`ctx.slots.inject("main", function* () {`，`register` 在 4418 行）【源码】：

```js
ctx.slots.inject("main", function* () {
  const handle = createNavigationStore(), instance = handle.create();
  const store = { ...handle, create: () => instance };
  yield ctx.slots.register({
    name: "main",
    key: PANEL_ID,                  // "plugins"，与侧栏 entry 的 id 相同
    locale: NS,                     // "pluginManager"
    store,
    inject: () => face,
    children: {
      "plugins.add.actions":  { kind: "list",  scope: "root" },
      "plugins.tab":          { kind: "list",  scope: "root" },
      "plugins.item":         { kind: "list",  scope: "root" },
      "plugins.bundle.activation": { kind: "keyed", scope: "root" },
      "plugins.bundle.config":     { kind: "keyed", scope: "root" },
      "plugins.row.config":        { kind: "keyed", scope: "root" },
      "plugins.detail.actions":    { kind: "list",  scope: "root" },
      "plugins.detail.badge":      { kind: "list",  scope: "root" },
      "plugins.detail.section":    { kind: "list",  scope: "root" }
    }
  }, PluginManagerPage);
  …
});
```

配套的侧栏入口（同文件第 4478 行，`apply()` 内）【源码】：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,       // 与上面 main 的 key 一致，点击后切到该页
  order: 0,
  label: () => t("panel"),
  locale: NS          // NS = "pluginManager"，先 ctx.locale.register(NS, { zh, en })
}, PluginsPanelIcon));
```

点击行为由 sidebar 负责：`onClick: () => { selectPanel(id); }`（`dsh-client-ui-sidebar/lib/client.js:185`），最终走 `ctx.layout.selectPanel(id)`（同文件 480 行）。

**(c) 设置页里加一行** — `dsh-client-ui-theme/lib/client.js:2047`（`font-size` 行在 2055）【源码】：

```js
ctx.slots.inject("settings.general.item", () => ctx.slots.register({
  name: "settings.general.item",
  id: "appearance",
  order: 10,
  store,
  locale: SETTINGS_NS,        // "settings.theme"
  inject: injected            // (actions) => props
}, AppearanceRow));
```

### 3.6 命令面板 / 斜杠命令：是"命令"，不是 palette

`dsh-client-ui-commands/lib/client.js` 提供 `ctx.commandUi`（服务类 `CommandUiRuntime extends Service`，`static inject = ["inputTriggers","sessions","remote","remote.commands"]`）【源码】：

```js
// 构造期：注册 "/" 触发源
ctx.effect(() => inputTriggers.registerSource({
  trigger: "/", name: "command", candidates, onPick, matchSpace, matchClaim, matchEnter, warm
}), "command: slash source");

register(contribution)   // → this.ctx.effect(…, "command.register()")
decorate(decoration)     // 给 Host 命令挂"裸调用"装饰
dismiss(name)
popupFor(actx)
```

`contribution` 字段（`client.js:1545-1562`）：`{ name, available(session), label?(), description?(), icon?, ui }`。冲突报错：`ui-commands: duplicate contribution for /<name>`、`ui-commands: contribution /<name> collides with a host command`。Host 命令目录来自 RPC：`ctx.remote.commands.list(sessionId)` / `ctx.remote.commands.execute(sessionId, line, attachments)`，事件 `commands/change`。

**注意**：这是**聊天输入框的斜杠命令**，不是 VSCode 那种全局 command palette；**没有**通用 palette 贡献 API【未找到】。`registerCommand` 在 bundle 里命中的是 Lexical 编辑器内部方法，与插件无关。

### 3.7 其它插件会用到、但不属于 slots 的服务

`dsh-cordis-client-runner/lib/client.js` 的 `SERVICE_API`（行 1110–2431）只登记 8 个：`layout`、`locale`、`sessions`、`slots`、`theme`、`timer`、`uiWorkspace`、`workspaces`。常用签名：

```ts
// layout（行 1127-1168）
selectPanel(panelId: MainPanelId | null): void
beginNavigation(): AbortSignal
toggleSidebar(): void
openRightbar(track: boolean, fullscreen: boolean): void
closeRightbar(): void

// 其它（真实调用点归纳）
ctx.locale.register(namespace, { zh, en })   // ui-plugin-manager apply()
ctx.shortcuts.register({ id, label, aliases, defaults, regions, modals, resolve })  // ui-layout
ctx.reflect.provide("layout", layout)        // 提供/覆盖服务
ctx.effect(fn, label)                        // 资源与清理，返回 disposer
```

`commands` / `settings` / `sidebar` **不在**这个服务目录里：它们是插件内部实现，第三方只能通过 slot 贡献，不能直接调。

---

## 4 能嵌入"完整自定义 React 面板"吗？

### 4.1 能，而且是官方自己在用

`main`（keyed / root，summary: *"Central panel selected by sidebar entry id"*）的 occupant 就是整页组件。内置三例：`ConversationPanel`（key `conversation`）、`PluginManagerPage`（key `plugins`）、`TaskManagerPage`（`dsh-client-ui-schedule`）。渲染侧：`renderSlot("main", {}, { entryKey: usePanelInfo(info => info.activePanelId) ?? "conversation" })`（`dsh-client-ui-layout/lib/client.js:119`）【源码】。

因此"完整自定义面板"的做法就是：

1. `ctx.slots.inject("sidebar.panellist", …)` 加一个入口（`id = my-panel`）；
2. `ctx.slots.inject("main", …)` 用 `key: "my-panel"` 注册整页组件；
3. 需要的话在自己的 `children` 表里开子槽，供别的插件扩展；
4. 面板内的路由/选中态放在自己的 store 里（不用 React Router，也没有 URL 路由 API）。

`ctx.layout.selectPanel("my-panel")` 可程序化跳转；未注册时抛 `layout.selectPanel: main panel "X" is not registered`。

### 4.2 限制（都是硬限制，出处为 `references/practices.md` / `ui-plugin.md`）【文档】

- 不要替换 app root，不要往 `document.body` 追加第二个应用：*"Do not replace the app root or append a second application to `document.body`"*。
- **不要 iframe**：*"Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`."*
- 不要读/改别的插件的 DOM 或样式来估算位置；不要写自己组件之外的 DOM。
- 优先选"已经分配了空间"的 slot（如 `conversation.composer.dock`），只有浮层才用 `shell.overlay`。
- factory 必须无副作用；样式、定时器、监听器等资源在 `apply` 里用 `ctx.effect`/`ctx.on` 注册并返回清理函数。
- 组件抛错只清空你自己那格，并打 `slot entry crashed in '<slot>'`；不要指望"崩溃边界"之外的兜底。

### 4.3 样式隔离方式：CSS Modules 哈希类名 + 主题变量（无 shadow DOM）

全仓证据【源码】：

- 62 个 `lib/client.js` 中 grep `attachShadow|shadowRoot|createPortal` → **0 命中**；前端 bundle 同样 0 命中。
- 类名是构建期 CSS Modules 生成的短哈希：`DuqLHW_controls`、`_2H3hWW_root`、`d99neW_main`。
- 样式以 `<style>` 注入 `document.head`，并带标记以便 HMR 精确移除、避免重复：`tag.dataset.plugin = "<pkg>"`、`tag.dataset.pluginCss = "<pkg>/<File>.module.css"`，去重选择器 `style[data-plugin-css="<pkg>/<file>.css"]`。
- 颜色/圆角/间距一律走 CSS 变量：`var(--dsw-radius-sm)`、`var(--dsw-alias-label-secondary)`、`var(--dsw-alias-interactive-bg-hover)`、`var(--dsw-specific-sidebar-fill)` 等；`Theme` 服务（`ctx.theme`）管 `getTheme` / `setTheme` / `overrideTokens` 与 `theme/change` 事件。
- 规范原文：*"Style with the theme tokens that `cordis_inspect_query` `Theme` lists (`--dsw-alias-*`); literal colors are for artwork only."*

结论：**隔离靠命名空间 + 变量，不靠 shadow DOM**。自定义面板要"像原生"，必须继承 `--dsw-*` 变量（它们挂在根元素上，普通 DOM 自然继承）；硬编码颜色会在亮/暗切换时失效。

---

## 5 模板 / 脚手架 / 市场 / 安装

### 5.1 没有脚手架包

- `@deepseek-ai/dsh-plugin-template`、`create-dsh-plugin`、`dsh-create-*`：304 个 `@deepseek-ai` 包的 manifest 扫描结果里 **0 命中**【未找到】。
- 唯一官方模板是**内置 skill 的模板目录**（随 `dsh-agent-preset` 发布，不在 npm 上）：
  `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/`，含 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/en.json`、`icon.svg`。
- 另有 `templates/mcp/`（MCP bundle 模板，无 client 半）。

### 5.2 安装通道（三条，同一后端）

1. **`plugin_manager` 工具**（agent 内）：`action: install_bundle`，`target` 传包**绝对目录**（开发态）或 npm spec；它负责写 profile 的 `package.json` / `cordis.patch.yml` 并跑 pnpm。**禁止手工写 profile**（SKILL.md 明文）。
2. **CLI**：`dsh plugin --profile <name> add <package>` —— 直接转发给 profile 目录里的 pnpm（`dsh/lib/bin.js:48,116-120`，错误文案 `error: plugin needs pnpm arguments to forward (e.g. add <package>)`）。`dsh <name>` 是 `dsh --profile <name>` 的简写。
3. **Web 界面**：左侧栏 **Plugins** 页（`dsh-client-ui-plugin-manager`）；Settings 里的 Plugin 列表只读。

安装 spec 形态（`dsh-plugin-manager/README.md:44`）【文档】：registry `name@version`（发布版用 `package@<running DSH version>`）、`file:`/`link:` 绝对路径（开发态）、git 地址、tarball URL。启用/停用走 profile 的 `package.json` → `dsh.profile.bundles` 有序列表；单插件启停走 `cordis.patch.yml` 的 `disabled`。

### 5.3 "插件市场"是什么

- 没有第三方市场服务，也没有 registry 搜索 API 给插件用。
- 有的是官方 **on-demand catalog**：`listBundles` 里带 `official` / `availability` / `installed` / `installTarget` 的条目，界面在 `dsh-client-ui-plugin-market`（对应 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`）。
- 安装时先 `inspect(spec)`（`pnpm view`）再 `installBundle`；失败码 `invalid-spec | already-installed | not-found | not-a-package | not-a-bundle | network | unknown`。
- 版本闸门：`engines.dsh` 或 DSH peer 依赖不满足 → `incompatible-version`；豁免写在 profile 的 `compatibility.json`（`plugin_manager` 的 `list_version_exemptions` / `set_version_exemption`，需 `acceptRisk: true`）。

### 5.4 开发循环

```
pnpm install && pnpm run build        # 必须产出每个包的 lib/client.js
dsh --profile <name> --dump-config    # 看合成后的树
pnpm run dev:web                      # HMR：SSE /plugins/events + 500ms 轮询
```

调试 API 用内置自省：`cordis_inspect_list` / `cordis_inspect_query`（`Slots.listSubTree`、`Config.listConfigs`、`Theme` 等）；`ctx.slots.snapshot(root)` 返回的节点形状与 `cordis_inspect` 消费的结构一致。

---

## 6 客户端插件最小骨架

以下 5 个文件即可跑起来（**整页自定义面板**版，覆盖最多的能力面）。与官方 decoration 模板同构，只把目标 slot 换成 `main` + `sidebar.panellist`。

### 6.1 目录

```
my-panel/
├─ package.json
├─ cordis.patch.yml
├─ index.js          # Host 半（空实现即可）
├─ client.js         # 浏览器半
└─ locale/en.json    # 可选：Plugins 列表文案
```

### 6.2 `package.json`

```json
{
  "name": "@local/my-panel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-layout"] }
  }
}
```

### 6.3 `cordis.patch.yml`

```yaml
- insert:
    - id: my-panel
      name: '@local/my-panel'
```

### 6.4 `index.js`（Host 半）

```js
export function apply() {}
```

### 6.5 `client.js`（浏览器半，全文）

```js
window.__ModuleLoader__.load({
  id: '@local/my-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'my-panel';

    function PanelIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6, fill: 'currentColor' }));
    }

    function Panel() {
      return h('div', { style: { padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
        h('h1', null, 'Hello from my-panel'));
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        // 侧栏入口：id 必须与 main 的 key 相同
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: 'My Panel'
        }, PanelIcon));

        // 整页主面板
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID
        }, Panel));
      }
    };
  }
});
```

### 6.6 说明（写规格文档时可直接引用）

- `window.__ModuleLoader__.load({ id, factory })` 是**唯一**的注册入口，`id` 必须等于包名（或 `<包名>/client`）。
- `factory` 必须无副作用，只返回 `{ inject, apply }`；`inject` 是**客户端服务名数组**（`slots`、`layout`、`theme`、`locale`…），不是 npm 包名。
- `apply(ctx)` 里所有注册都用 `ctx.slots.inject(parentSlot, () => ctx.slots.register(...))` 包一层；父 slot 还没声明时回调延后到声明那一刻执行。
- 组件 props 由 renderer 注入（`usePanelInfo` 等）；不要自己 `createRoot`，不要 `document.body.appendChild`。
- 需要跨插件扩展时，在自己的 `register` 里加 `children: { 'my-panel.toolbar': { kind: 'list', scope: 'root' } }`，别人就能 `ctx.slots.inject('my-panel.toolbar', …)`。
- 需要 i18n：`ctx.locale.register('myPanel', { zh, en })`，然后在 `register` 里写 `locale: 'myPanel'`、`label: () => t('title')`。

---

## 7 证据索引（可直接复查）

| 事实 | 文件 | 位置 |
| --- | --- | --- |
| `dsh.client` 四字段校验 | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js` | 61-75 |
| `exports["./client"]` 解析、`<id>/client` 归一 | 同上 | 98-100, 172-182 |
| combo URL / 缓存 / 重试 / 注入行 | 同上（`bootInjections`、`comboUrl`、`PLUGIN_ROUTE`） | 全文 |
| `__DSH_BOOT__` schema 与校验 | `…/dsh-client-modules/lib/client.js` | 108-160 |
| `require.async` 定义 | 同上 | @38621 |
| 浏览器模块表 12 项 | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（`SZ()`） | — |
| `web boot` 启动流程、`__DSH_TRANSPORT__` | 同上（`TZ`） | — |
| index 注入行 kind | 同上（`PZ`） | — |
| `SlotCore` 全方法 | 同上（`$I`，offset 485031–494300，切片 `x/slotcore.txt`） | — |
| `ctx.slots` 三方法 + 注释 | `…/dsh-cordis-client-runner/lib/client.js` | 1362-1396 |
| `layout` / `theme` 服务 | 同上 | 1127-1168 |
| 99 个 slot 目录（含上游源码行号） | `.tmp-asar/x/slots.json` | — |
| `root` 声明与 children 表 | `…/dsh-client-ui-layout/lib/client.js` | 624 |
| `main` 渲染（entryKey） | 同上 | 119 |
| 整页面板真实注册 | `…/dsh-client-ui-plugin-manager/lib/client.js` | 4411 / 4418 |
| 侧栏入口真实注册 | 同上 | 4478 |
| 设置行真实注册 | `…/dsh-client-ui-theme/lib/client.js` | 2047, 2055 |
| 斜杠命令服务 | `…/dsh-client-ui-commands/lib/client.js` | `CommandUiRuntime` |
| HMR SSE 与帧 | `…/dsh-client-hmr/lib/client.js` | 199, 235 |
| 官方 UI 规则 | `…/dsh-agent-preset/skills/cordis-plugin-development/references/{ui-plugin,practices,verification}.md` | — |
| 官方模板 | `…/cordis-plugin-development/templates/decoration/*` | — |
| 安装 spec / CLI / 版本闸门 | `…/dsh-plugin-manager/README.md` | 44, 48-52, 71-75 |
| CLI `plugin` 子命令 | `…/dsh/lib/bin.js` | 48, 116-120 |

---

## 8 未找到 / 不确定（写规格时按"未定义"处理）

1. **`window.__DSH_PLUGIN__`**：【未找到】。全局注册表是 `window.__ModuleLoader__` + `__DSH_BOOT__`。
2. **状态栏 slot**：【未找到】。没有 status-bar 贡献位，最近的替代是 `shell.leading` / `sidebar.footer.action` / `shell.bottom`。
3. **命令面板（command palette）贡献 API**：【未找到】。只有聊天输入的斜杠命令（`ctx.commandUi.register`）。
4. **全局路由 / URL**：【未找到】。主视图切换靠 `ctx.layout.selectPanel(id)` + 插件自己的 store，不写 URL。
5. **shadow DOM 隔离**：【未找到】，且规范明确建议不用 iframe；隔离手段只有命名空间 + `--dsw-*` 变量。
6. **官方脚手架 / `create-dsh-plugin`**：【未找到】。模板只有 skill 里的 `templates/decoration/`。
7. **第三方可用的 market API**：【未找到】。只有官方 on-demand catalog（`listBundles` 的 `official`/`installTarget`）。
8. **`BaseOptions` 的完整类型声明**：【未找到】（`dsh-client-ui-slots` 的 `.d.ts` 未随 asar 发布，只在 `dsh-cordis-client-runner` 的类型目录里以 `BaseOptions<K,…>` 引用出现）。字段清单见 3.2，来自真实调用点归纳，不是官方声明。
9. **`dsh.client.platform` 的取值枚举**：【不确定】。代码只校验 `string`，实际全部为 `"web"`，其它值被静默跳过。
