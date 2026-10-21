// lib/index.mjs — LLM Wiki（llm-wiki）DSH 插件宿主入口。
//
// 形状照 spec §6.3：具名导出 name / inject / Config / apply，没有 default。
// 硬依赖只有 tools；webServer / settings / skills 都是可选且晚挂载的宿主服务，
// 一律在 apply 内经 ctx.inject 按需注册（headless / CI 冒烟时回调永不执行，apply 不失败）。
//
// 采集走 ctx.on('session/event', …)：宿主在事件提交后同步广播（post-commit append feed），
// 我们在回调里同步写 SQLite，不 await、不阻塞会话（spec §8）。
// 提炼由定时器在「无会话活动」时空闲触发，绝不赶在会话进行中跑（spec §9）。
import { Config, readConfig } from './config.mjs'
import { registerRoutes } from './routes.mjs'
import { createStore } from './store.mjs'
import { createCapture } from './capture.mjs'
import { handlers } from './api.mjs'
import { compileBatch, pendingCount, pipelineState } from './compiler.mjs'
import { runLint } from './lint.mjs'
import { fsck } from './fsck.mjs'

const VERSION = '0.3.0'
/** 提炼巡检间隔：够短能及时，够长不至于空转。 */
const TICK_MS = 60 * 1000
/** 距最近一次会话事件不足这么久就认为「会话进行中」，不提炼。 */
const BUSY_MS = 60 * 1000
/** 体检间隔：一天一次够了，lint 是给「闲下来复盘」用的，不是实时功能。 */
const LINT_EVERY_MS = 24 * 60 * 60 * 1000

export const name = 'llm-wiki'
export const inject = ['tools']

export function apply(ctx, config) {
  const state = {
    version: VERSION,
    startedAt: Date.now(),
    pings: 0,
    clientHello: null,
    clientEvents: [],
    store: null,
    capture: null,
    getConfig: () => readConfig(config),
  }

  // 日志：cordis logger 由宿主提供，缺失时退 console（不因日志失败打断插件）。
  const log = (level, message, extra) => {
    const line = `[llm-wiki] ${message}`
    try {
      const fn = ctx.logger && ctx.logger[level]
      if (typeof fn === 'function') {
        if (extra === undefined) fn.call(ctx.logger, line)
        else fn.call(ctx.logger, line, extra)
        return
      }
    } catch { /* 落到 console */ }
    if (level === 'error') console.error(line, extra ?? '')
    else if (level === 'warn') console.warn(line, extra ?? '')
    else console.log(line, extra ?? '')
  }
  state.log = log

  // ---- 数据库：启动时试开一次，失败降级（后续调用会重试）
  state.store = createStore({ log })
  try {
    const db = state.store.get()
    if (state.getConfig() && state.store.getPolicy('fsckOnStart', 'true') === 'true') {
      const checked = fsck(db, { vaultPath: state.getConfig().vaultPath })
      if (checked.ok) log('info', `启动自检通过（L1 ${checked.counts.sources} 条 / L2 ${checked.counts.extractions} 条）`)
      else log('warn', `启动自检发现 ${checked.issues.length} 个问题：${checked.issues.slice(0, 3).map((item) => item.code).join(', ')}`)
    }
  } catch (err) {
    log('error', '数据库不可用，面板将进入降级态：' + errorText(err))
  }

  // ---- 采集：每个 session/event 同步落 L1
  state.capture = createCapture({
    getDb: () => state.store.get(),
    getConfig: state.getConfig,
    log,
  })
  try {
    const off = ctx.on('session/event', (session, event) => {
      state.capture.onEvent(session, event)
    })
    if (typeof off === 'function') {
      ctx.effect(() => () => {
        try { off() } catch { /* 解绑失败不打断卸载 */ }
      })
    }
    log('info', '已订阅 session/event（采集开启）')
  } catch (err) {
    log('error', '订阅 session/event 失败：' + errorText(err))
  }

  // ---- 浏览器侧的 /api-llm-wiki/* 数据通道（spec §17 已定：路由 + ctx.provide 双通道）。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = registerRoutes(ctx, webCtx.webServer, state)
      log('info', '面板路由已挂载：/api-llm-wiki/*')
      if (typeof dispose === 'function') ctx.effect(() => dispose)
    } catch (err) {
      log('error', '面板路由挂载失败：' + errorText(err))
    }
  })

  // ---- 提炼调度：每 TICK_MS 巡检一次，只在「空闲 + 到量或超时」时跑（spec §9）
  let ticking = false
  let lastLintAt = 0
  const tick = () => {
    if (ticking) return
    ticking = true
    try {
      const cfg = state.getConfig()
      if (cfg.pipelineAutoRun === false) return
      const db = state.store.get()
      const pending = pendingCount(db)
      if (pending === 0) return
      const lastEvent = state.capture ? state.capture.lastActivity() : 0
      if (lastEvent > 0 && Date.now() - lastEvent < BUSY_MS) return
      const pipelineUh = pipelineState(db, { config: cfg })
      const byCount = pending >= Number(cfg.pipelineBatchSize || pipelineUh.batchSize || 12)
      const lastRun = pipelineUh.lastRunAt ? Date.parse(pipelineUh.lastRunAt) : 0
      const byIdle = Number.isFinite(lastRun)
        && (lastRun === 0 || Date.now() - lastRun > Number(cfg.pipelineIdleMinutes || 30) * 60 * 1000)
      if (!byCount && !byIdle) return
      const result = compileBatch(db, { config: cfg, log })
      log('info', `编译一轮：${result.inserted} 个补丁（窗口 ${result.windows}，待编译 ${result.pending}）`)
      // 体检跟随编译：有新东西进队列才值得跑一次（最多一天一次）
      if (result.inserted > 0 && Date.now() - lastLintAt > LINT_EVERY_MS) {
        lastLintAt = Date.now()
        const checked = runLint(db)
        const brief = Object.entries(checked.byKind).filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join(' / ')
        log('info', `体检一轮：${checked.total} 条发现${brief ? `（${brief}）` : ''}`)
      }
    } catch (err) {
      log('warn', '提炼巡检跳过：' + errorText(err))
    } finally {
      ticking = false
    }
  }
  const timer = setInterval(tick, TICK_MS)
  if (timer && typeof timer.unref === 'function') timer.unref()
  const firstCheck = setTimeout(tick, 20 * 1000)
  if (firstCheck && typeof firstCheck.unref === 'function') firstCheck.unref()

  // 卸载时释放定时器与数据库句柄（session/event 的解绑在 ctx.effect 里）。
  ctx.effect(() => () => {
    try { clearInterval(timer) } catch { /* 忽略 */ }
    try { clearTimeout(firstCheck) } catch { /* 忽略 */ }
    try { state.capture?.dispose() } catch { /* 忽略 */ }
    try { state.store?.close() } catch { /* 忽略 */ }
  })

  // 给其它插件复用的宿主服务。
  if (typeof ctx.provide === 'function') {
    ctx.provide('llmWiki', Object.freeze({
      version: VERSION,
      status: () => ({
        version: VERSION,
        uptimeMs: Date.now() - state.startedAt,
        vaultPath: state.getConfig().vaultPath,
        captureEnabled: state.getConfig().captureEnabled,
        db: state.store.isOpen() ? 'open' : 'pending',
      }),
      search: (query, options) => handlers.search(state, { q: query, ...(options || {}) }),
      wikiSearch: (query, options) => handlers.wikiSearch(state, { q: query, ...(options || {}) }),
      ask: (body) => handlers.ask(state, body || {}),
      pages: (options) => handlers.pages(state, options || {}),
      page: (id, options) => handlers.page(state, { id, ...(options || {}) }),
      compile: (options) => handlers.compile(state, options || {}),
      lint: (options) => handlers.lint(state, options || {}),
      queue: (options) => handlers.queue(state, options || {}),
      review: (body) => handlers.review(state, body || {}),
      write: (body) => handlers.write(state, body || {}),
      pipeline: (body) => handlers.pipeline(state, body || {}),
      wikiOverview: () => handlers.wikiOverview(state),
      overview: () => handlers.overview(state),
    }))
  }

  log('info', `已加载 v${VERSION}（vault=${state.getConfig().vaultPath}）`)
}

export function errorText(err) {
  return String((err && err.message) || err)
}

export { Config }
