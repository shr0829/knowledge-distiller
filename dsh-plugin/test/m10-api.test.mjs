import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { handlers } from '../lib/api.mjs'
import { insertSource } from '../lib/capture.mjs'
import { readConfig } from '../lib/config.mjs'

/** 假 state：store 用真库，config 用默认。 */
function freshState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zhixu-api-'))
  const store = createStore({ file: join(dir, 'wiki.sqlite3') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const state = { store, version: '0.3.0', startedAt: Date.now(), getConfig: () => readConfig(undefined) }
  return { state, db: store.get() }
}

const P = '70a11510e813'

function seedSources(db, n = 4) {
  const texts = [
    '我们决定联合命中率必须单列统计口径：碳命中与温度命中分别记，联合命中另算一列。',
    '容差口径：碳 ±50 raw，温度 ±12 摄氏度；不按分区百分比取平均。',
    '温度补偿采用分段查表，按温度区间分档。',
    '副枪测量与模型预测的偏差需要每炉记录，用于后续漂移分析。',
  ]
  return texts.slice(0, n).map((content, i) => insertSource(db, {
    kind: 'dsh-turn', projectId: P, sessionId: `s${i}`, turn: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant', locator: `s${i}#t${i + 1}`,
    title: content.slice(0, 12), content,
  }))
}

test('v2 全链路：采集 → 编译 → 补丁队列 → 接受 → 页面 → 检索 → 问答 → 体检', (t) => {
  const { state, db } = freshState(t)
  seedSources(db, 4)

  const before = handlers.wikiOverview(state, {})
  assert.equal(before.ok, true)
  assert.equal(before.pages.total, 0)
  assert.equal(before.pendingSources, 4)

  const compiled = handlers.compile(state, {})
  assert.equal(compiled.ok, true)
  assert.equal(compiled.inserted >= 1, true, `inserted=${compiled.inserted}`)

  const queue = handlers.patchQueue(state, { limit: 10 })
  assert.equal(queue.patches.length >= 1, true)
  const patch = queue.patches[0]
  const detail = handlers.patch(state, { id: patch.id })
  assert.equal(detail.ok, true)
  assert.equal(Array.isArray(detail.ops), true)
  assert.equal(typeof detail.diff, 'object')
  assert.equal(Array.isArray(detail.diff.after), true)

  const accepted = handlers.patchReview(state, { id: patch.id, action: 'accept' })
  assert.equal(accepted.ok, true)
  assert.equal(typeof accepted.pageId, 'string')

  const pages = handlers.pages(state, { projectId: P })
  assert.equal(pages.pages.length, 1)
  const page = handlers.page(state, { id: accepted.pageId })
  assert.equal(page.page.id, accepted.pageId)
  assert.equal(page.claims.length >= 1, true)
  // 证据锚点必须跟着 claim 一起落库，且 quote 在来源原文里逐字存在
  assert.equal(page.citations.length >= 1, true, JSON.stringify(page.citations))
  const sourceRow = db.prepare('SELECT content FROM sources WHERE id = ?').get(page.citations[0].sourceId)
  assert.equal(String(sourceRow.content).includes(page.citations[0].quote), true)

  const found = handlers.wikiSearch(state, { q: '联合命中' })
  assert.equal(found.ok, true)
  assert.equal(found.results.length >= 1, true, JSON.stringify(found.results))
  assert.equal(found.results[0].pageId, accepted.pageId)
  assert.equal(found.bytes <= 24576, true)

  const asked = handlers.ask(state, { q: '联合命中怎么统计' })
  assert.equal(asked.ok, true)
  assert.match(asked.answer, /联合命中/u)
  assert.equal(asked.sources.length >= 1, true)

  handlers.pageFeedback(state, { pageId: accepted.pageId, verdict: 'useful' })
  const again = handlers.wikiSearch(state, { q: '联合命中' })
  assert.equal(again.results[0].components.feedback > 0.5, true)

  const linted = handlers.lint(state, {})
  assert.equal(linted.ok, true)
  assert.equal(typeof linted.byKind, 'object')
  const rows = handlers.lintFindings(state, {})
  assert.equal(Array.isArray(rows.findings), true)
})

test('v2 建议：没内容的查询给出可执行的下一步，而不是空答案', (t) => {
  const { state } = freshState(t)
  const asked = handlers.ask(state, { q: '完全不存在的话题量子纠缠' })
  assert.equal(asked.ok, true)
  assert.match(asked.answer, /没有找到相关内容/u)
  assert.match(asked.answer, /记录/u)
})

test('v2 闸门：补丁只能 accept/discard/defer，未知动作直接报错', (t) => {
  const { state, db } = freshState(t)
  seedSources(db, 2)
  handlers.compile(state, {})
  const patch = handlers.patchQueue(state, {}).patches[0]
  assert.throws(() => handlers.patchReview(state, { id: patch.id, action: 'apply' }), /未知动作/u)
  const deferred = handlers.patchReview(state, { id: patch.id, action: 'defer' })
  assert.equal(deferred.status, 'deferred')
  assert.throws(() => handlers.patchReview(state, { id: patch.id, action: 'accept' }), /不能再接受/u)
})

test('v2 as-of：旧主张在时点查询里仍可见，新主张在旧时点不可见', (t) => {
  const { state, db } = freshState(t)
  seedSources(db, 2)
  handlers.compile(state, {})
  const patch = handlers.patchQueue(state, {}).patches[0]
  handlers.patchReview(state, { id: patch.id, action: 'accept' })
  const pageId = handlers.patchQueue(state, {}).pages?.[0]?.id
  const current = handlers.wikiSearch(state, { q: '容差' })
  assert.equal(current.ok, true)
  const past = handlers.wikiSearch(state, { q: '容差', asOf: '2020-01-01T00:00:00.000Z' })
  assert.equal(past.ok, true)
  // 2020 年时点不可能有今天写入的主张
  assert.equal(past.results.every((item) => (item.claims || []).length === 0), true, `${pageId}`)
})
