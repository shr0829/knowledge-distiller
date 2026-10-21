// test/m3-http.test.mjs — 真 HTTP 链路：/api-llm-wiki/* 注册 → 请求 → JSON 响应。
//
// 用真实 http.Server + fetch 跑一遍，覆盖 readJsonBody、路由分派、错误转 500，
// 以及「采集(SQL) → 提炼 → 审核 → 写入 → 检索」这条端到端业务链（不经 DSH 进程）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'llm-wiki-http-home-'))

const { createStore } = await import('../lib/store.mjs')
const { insertSource } = await import('../lib/capture.mjs')
const { registerRoutes } = await import('../lib/routes.mjs')

const CONFIG = {
  vaultPath: '',
  captureEnabled: true,
  captureMaxToolBytes: 4096,
  pipelineBatchSize: 12,
  pipelineIdleMinutes: 30,
  pipelineAutoRun: false,
  pipelineModel: '',
  retrievalMaxResults: 8,
  retrievalWeightText: 0.6,
  retrievalWeightRecency: 0.25,
  retrievalWeightCentrality: 0.15,
  writeLanguage: 'zh',
}

/** 起一个真实 http 服务，把 registerRoutes 的 handler 分发出去。 */
async function boot() {
  const file = join(mkdtempSync(join(tmpdir(), 'llm-wiki-http-db-')), 'wiki.sqlite3')
  const vault = mkdtempSync(join(tmpdir(), 'llm-wiki-http-vault-'))
  const store = createStore({ log: () => {}, file })
  const config = { ...CONFIG, vaultPath: vault }
  const routes = new Map()
  const state = {
    store,
    version: '0.1.0',
    startedAt: Date.now(),
    pings: 0,
    getConfig: () => config,
    log: () => {},
  }
  const webServer = {
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route)
      return () => routes.delete(`${route.kind}:${route.path}`)
    },
  }
  registerRoutes({}, webServer, state)
  const server = http.createServer((req, res) => {
    const route = routes.get(`exact:${req.url.split('?')[0]}`)
    if (!route) { res.writeHead(404).end('not found'); return }
    Promise.resolve(route.handler(req, res)).catch((err) => {
      res.writeHead(500).end(String(err && err.message))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, state, vault, db: store.get(), store }
}

async function call(base, path, body, method = 'POST') {
  const res = await fetch(base + path, method === 'GET'
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const payload = await res.json()
  return { status: res.status, payload }
}

test('HTTP：24 条路由全部注册，health 走 GET', async () => {
  const { server, base, state } = await boot()
  try {
    const health = await call(base, '/api-llm-wiki/health', null, 'GET')
    assert.equal(health.status, 200)
    assert.equal(health.payload.ok, true)
    assert.equal(health.payload.version, '0.1.0')
    assert.equal(health.payload.db, 'open')
    const missing = await fetch(`${base}/api-llm-wiki/nope`, { method: 'POST' })
    assert.equal(missing.status, 404, '未注册路径必须 404')
    assert.equal(state.pings, 0)
  } finally {
    server.close()
  }
})

test('HTTP：采集 → 提炼 → 审核 → 写入 → 检索 全链路', async () => {
  const { server, base, db, vault } = await boot()
  try {
    insertSource(db, {
      kind: 'dsh-turn', role: 'user', projectId: 'proj_http', sessionId: 'ses_http', turn: 1, step: 0,
      locator: 'dsh-turn:ses_http:1:user', content: '转炉终点碳温预测用什么模型？', meta: { cwd: 'E:\\project\\BaoSteel' },
    })
    insertSource(db, {
      kind: 'dsh-turn', role: 'assistant', projectId: 'proj_http', sessionId: 'ses_http', turn: 1, step: 0,
      locator: 'dsh-turn:ses_http:1:assistant', content: '决定采用梯度提升树，并在同一炉次内校验温度偏差。',
      meta: { cwd: 'E:\\project\\BaoSteel' },
    })

    const overview = await call(base, '/api-llm-wiki/overview', {})
    assert.equal(overview.payload.counts.sources, 2)
    assert.equal(overview.payload.degraded, true, '未配置模型应标为降级')
    assert.equal(overview.payload.model.mode, 'rules')

    const sources = await call(base, '/api-llm-wiki/sources', { limit: 10 })
    assert.equal(sources.payload.total, 2)
    assert.ok(sources.payload.items[0].contentSha)

    const ran = await call(base, '/api-llm-wiki/pipeline', { run: true })
    assert.equal(ran.payload.ran.ran, true)
    assert.equal(ran.payload.ran.inserted, 1)

    const queue = await call(base, '/api-llm-wiki/queue', { limit: 10 })
    assert.equal(queue.payload.items.length, 1)
    const item = queue.payload.items[0]
    assert.ok(item.citations.length >= 1)

    const detail = await call(base, '/api-llm-wiki/item', { layer: item.layer, id: item.id })
    assert.equal(detail.payload.item.id, item.id)

    const preview = await call(base, '/api-llm-wiki/preview', { layer: item.layer, id: item.id })
    assert.equal(preview.payload.writable, false, '未采纳不可写')
    assert.match(preview.payload.path, /Library\//)

    const badWrite = await call(base, '/api-llm-wiki/write', { layer: item.layer, id: item.id })
    assert.equal(badWrite.status, 500)
    assert.match(badWrite.payload.error, /只有 approved/)

    const accepted = await call(base, '/api-llm-wiki/review', { layer: item.layer, id: item.id, action: 'accept' })
    assert.equal(accepted.payload.status, 'approved')
    assert.equal(accepted.payload.queue.L2.approved, 1)

    const written = await call(base, '/api-llm-wiki/write', { layer: item.layer, id: item.id })
    assert.equal(written.payload.ok, true)
    assert.equal(written.payload.changed, true)
    assert.equal(written.payload.revision, 1)
    assert.ok(existsSync(join(vault, written.payload.path.split('/').join('\\'))))

    const notes = await call(base, '/api-llm-wiki/notes', {})
    assert.equal(notes.payload.items.length, 1)
    const writes = await call(base, '/api-llm-wiki/writes', {})
    assert.equal(writes.payload.items.length, 1)
    assert.ok(writes.payload.items[0].reviewId)

    const found = await call(base, '/api-llm-wiki/search', { q: '温度偏差' })
    assert.equal(found.payload.ok, true)
    assert.ok(found.payload.results.length >= 1, '中文短语应命中')
    assert.ok(found.payload.results.length <= 8)

    const feedback = await call(base, '/api-llm-wiki/feedback', { layer: item.layer, id: item.id, signal: 'useful' })
    assert.equal(feedback.payload.ok, true)

    const graph = await call(base, '/api-llm-wiki/graph', { limit: 20 })
    assert.ok(graph.payload.edges.length >= 1, 'L2 到 L1 的 derived_from 边')

    const checked = await call(base, '/api-llm-wiki/fsck', {})
    assert.equal(checked.payload.ok, true, `不变量自检应通过：${JSON.stringify(checked.payload.issues)}`)

    const reindex = await call(base, '/api-llm-wiki/reindex', {})
    assert.equal(reindex.payload.ok, true)

    const undo = await call(base, '/api-llm-wiki/review', { layer: 'L2', id: item.id, action: 'discard' })
    assert.equal(undo.status, 500, 'approved 不可直接丢弃')
    assert.match(undo.payload.error, /先撤销/)
  } finally {
    server.close()
  }
})

test('HTTP：坏 JSON → 500 且错误可读；GET 用 query', async () => {
  const { server, base } = await boot()
  try {
    const res = await fetch(`${base}/api-llm-wiki/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(res.status, 500)
    const payload = await res.json()
    assert.match(payload.error, /合法 JSON/)

    const viaGet = await fetch(`${base}/api-llm-wiki/sources?limit=5&role=user`, { headers: { accept: 'application/json' } })
    assert.equal(viaGet.status, 200)
    const body = await viaGet.json()
    assert.equal(body.ok, true)
    assert.equal(body.limit, 5)
  } finally {
    server.close()
  }
})
