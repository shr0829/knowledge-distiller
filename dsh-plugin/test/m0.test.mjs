// test/m0.test.mjs — M0 冒烟：不依赖 DSH 进程，用假 ctx 跑 apply() 与路由。
//
// 目的：在装进 profile、重启宿主之前，先证明宿主半的加载与路由形状是对的。
// 运行：node --test "test/m0.test.mjs"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import paths.mjs 之前设置：健康检查会真的开库，别写进用户的 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'llm-wiki-m0-'))

const { apply, name, inject, Config, errorText } = await import('../lib/index.mjs')
const { readConfig, DEFAULTS } = await import('../lib/config.mjs')
const { ROUTES } = await import('../lib/routes.mjs')

/** 假宿主：只实现本插件用到的那几个面。 */
function fakeHost() {
  const routes = []
  const provided = new Map()
  const logs = []
  const listeners = new Map()
  const disposers = []
  const ws = {
    routes,
    register(route) {
      if (routes.some((r) => r.kind === route.kind && r.path === route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    injections: [],
    inject(deps, cb) {
      ctx.injections.push(deps)
      // 模拟「服务可用时回调执行」
      cb({ webServer: ws })
    },
    provide(key, value) {
      provided.set(key, value)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const list = listeners.get(event) || []
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    get() {
      return undefined
    },
  }
  return { ctx, routes, provided, logs, listeners, disposers }
}

/** 假 req/res：req 是 async iterable，res 收集 writeHead/end。 */
function makeReq(bodyObj, url = '/') {
  const text = bodyObj === undefined ? '' : JSON.stringify(bodyObj)
  const req = {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text, 'utf8')
    },
  }
  return req
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(chunk) {
      res.body += chunk ? String(chunk) : ''
    },
  }
  return res
}

async function callRoute(route, body) {
  const res = makeRes()
  await route.handler(makeReq(body), res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

test('入口导出形状符合 spec §6.3', () => {
  assert.equal(name, 'llm-wiki')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  // Config 在宿主里由 schemastery 提供；纯 node 下解析不到时是 undefined（不抛）
  assert.ok(Config === undefined || typeof Config === 'object')
  assert.equal(errorText(new Error('x')), 'x')
})

test('apply() 注册全部 /api-llm-wiki 路由、订阅采集、provide llmWiki 服务', () => {
  const { ctx, routes, provided, logs, listeners, disposers } = fakeHost()
  apply(ctx, {})
  const paths = routes.map((r) => r.path).sort()
  assert.deepEqual(paths, ROUTES.map(([path]) => path).sort())
  assert.ok(routes.every((r) => r.kind === 'exact'))
  assert.ok(provided.has('llmWiki'))
  assert.ok(listeners.has('session/event'), '应订阅 session/event 做采集')
  assert.ok(logs.some(([, line]) => String(line).includes('已加载')))
  assert.ok(logs.some(([, line]) => String(line).includes('已订阅 session/event')))
  // 卸载钩子必须注册（采集定时器 + 数据库句柄）
  assert.ok(disposers.length >= 2)
})

test('health 返回 ok + 默认 vault + 库已打开', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const route = routes.find((r) => r.path === '/api-llm-wiki/health')
  const { status, json } = await callRoute(route, undefined)
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.vaultPath, DEFAULTS.vaultPath)
  assert.equal(json.db, 'open')
  assert.ok(json.capture && typeof json.capture.sessions === 'number')
})

test('ping / client-hello 记账并回心跳', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const ping = routes.find((r) => r.path === '/api-llm-wiki/ping')
  const hello = routes.find((r) => r.path === '/api-llm-wiki/client-hello')

  const p1 = await callRoute(ping, { from: 'sidebar' })
  assert.equal(p1.status, 200)
  assert.equal(p1.json.pings, 1)

  const c1 = await callRoute(hello, { platform: 'web' })
  assert.equal(c1.status, 200)
  assert.equal(c1.json.ok, true)
  assert.equal(c1.json.pings, 1)
})

test('overview 反映库计数与降级状态（未配模型 ⇒ rules 模式）', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const route = routes.find((r) => r.path === '/api-llm-wiki/overview')
  const { status, json } = await callRoute(route, {})
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.counts.sources, 0)
  assert.equal(json.model.mode, 'rules')
  assert.equal(json.degraded, true)
  assert.ok(Array.isArray(json.projects))
})

test('空查询的检索直接返回空结果，不建表达式', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const route = routes.find((r) => r.path === '/api-llm-wiki/search')
  const { status, json } = await callRoute(route, { q: '   ' })
  assert.equal(status, 200)
  assert.equal(json.empty, true)
  assert.equal(json.total, 0)
})

test('policies：autoWrite 永不允许打开', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const route = routes.find((r) => r.path === '/api-llm-wiki/policies')
  const bad = await callRoute(route, { key: 'autoWrite', value: true })
  assert.equal(bad.status, 500)
  assert.match(bad.json.error, /autoWrite/)
  const good = await callRoute(route, { key: 'autoRunPipeline', value: false })
  assert.equal(good.status, 200)
  assert.equal(good.json.policies.autoRunPipeline, 'false')
})

test('坏 JSON 请求体 → 500 且带 error', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const route = routes.find((r) => r.path === '/api-llm-wiki/ping')
  const req = {
    method: 'POST',
    url: '/api-llm-wiki/ping',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{not json') },
  }
  const res = makeRes()
  await route.handler(req, res)
  assert.equal(res.statusCode, 500)
  assert.match(JSON.parse(res.body).error, /合法 JSON/)
})

test('readConfig 用默认值兜底并夹取越界数值', () => {
  const out = readConfig(undefined)
  assert.equal(out.vaultPath, DEFAULTS.vaultPath)
  assert.equal(out.pipelineBatchSize, 12)

  const weird = readConfig({ pipelineBatchSize: 9999, retrievalMaxResults: 0, captureEnabled: false })
  assert.equal(weird.pipelineBatchSize, 64)
  assert.equal(weird.retrievalMaxResults, 1)
  assert.equal(weird.captureEnabled, false)
})
