import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { addClaim } from '../lib/claims.mjs'
import { createPage, syncLinks } from '../lib/pages.mjs'
import { runLint, findings } from '../lib/lint.mjs'
import { insertSource } from '../lib/capture.mjs'

function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zhixu-lint-'))
  const store = createStore({ file: join(dir, 'wiki.sqlite3') })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store.get()
}

test('矛盾：同 subject+predicate 区间重叠而 object 不同', (t) => {
  const db = freshDb(t)
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '命中口径', body: '# x\n' })
  addClaim(db, { pageId: page.id, statement: '联合命中 是 单列统计', tValid: '2026-01-01T00:00:00.000Z' })
  addClaim(db, { pageId: page.id, statement: '联合命中 是 并入碳温', tValid: '2026-02-01T00:00:00.000Z' })
  const result = runLint(db)
  assert.equal(result.byKind.contradiction, 1)
  assert.match(result.findings[0].detail, /两种说法/u)
})

test('矛盾：不重叠的时态序列不算矛盾', (t) => {
  const db = freshDb(t)
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '口径演进', body: '# x\n' })
  addClaim(db, { pageId: page.id, statement: '口径 是 旧', tValid: '2026-01-01T00:00:00.000Z', tInvalid: '2026-02-01T00:00:00.000Z' })
  addClaim(db, { pageId: page.id, statement: '口径 是 新', tValid: '2026-02-01T00:00:00.000Z' })
  const result = runLint(db)
  assert.equal(result.byKind.contradiction, 0)
})

test('过时：claim 的事实时间旧且项目之后有新来源', (t) => {
  const db = freshDb(t)
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '旧结论', body: '# x\n' })
  addClaim(db, { pageId: page.id, statement: '容差 是 ±30', tValid: '2025-01-01T00:00:00.000Z' })
  insertSource(db, {
    kind: 'dsh-turn', projectId: 'p1', sessionId: 's', turn: 1, role: 'user',
    locator: 's#1', title: '新来源', content: '后来容差改成 ±50。',
  })
  const result = runLint(db, { now: Date.parse('2026-10-21T00:00:00.000Z') })
  assert.equal(result.byKind.stale, 1)
  assert.match(result.findings.find((f) => f.kind === 'stale').detail, /新来源/u)
})

test('孤页 / 缺页 / 缺链 三种结构问题', (t) => {
  const db = freshDb(t)
  const lonely = createPage(db, {
    projectId: 'p1', kind: 'concept', title: '温度补偿', summary: '温度补偿模型按温度区间查表',
    body: '## 概览\n\n温度补偿模型按温度区间查表。\n',
  })
  const hub = createPage(db, {
    projectId: 'p1', kind: 'concept', title: '转炉终点碳温',
    summary: '终点碳温依赖温度补偿模型与吹炼氧耗关系',
    body: '## 概览\n\n终点碳温预测依赖温度补偿模型与吹炼氧耗关系，见 [[转炉副枪]]。\n',
  })
  syncLinks(db, hub.id)
  const result = runLint(db)
  assert.equal(result.byKind['missing-page'], 1)
  // 缺链按页面方向报（A→B、B→A 各一条），只要认定这两页该互链即可
  assert.equal(result.byKind['missing-link'] >= 1, true)
  assert.equal(result.findings.some((f) => f.kind === 'orphan'), true)
  assert.equal(lonely.id !== hub.id, true)
})

test('坏引用：quote 在来源里找不到', (t) => {
  const db = freshDb(t)
  const source = insertSource(db, {
    kind: 'dsh-turn', projectId: 'p1', sessionId: 's', turn: 1, role: 'user',
    locator: 's#1', title: '口径', content: '联合命中必须单列统计。',
  })
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '口径', body: '# x\n' })
  db.prepare(`INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, span_start, span_end, created_at)
    VALUES ('c1', 'PAGE', ?, 'L1', ?, '单列统计口径', 0, 5, '2026-01-01T00:00:00.000Z')`).run(page.id, source.id)
  const result = runLint(db)
  assert.equal(result.byKind['broken-quote'], 1)
})

test('缺口：某 kind 还没有页面，但队列里有该 kind 的补丁', (t) => {
  const db = freshDb(t)
  db.prepare(`INSERT INTO patches (id, project_id, title, kind, ops, status, fingerprint, created_at)
    VALUES ('p1', 'p1', '副枪', 'entity', '[]', 'candidate', 'fp-1', '2026-01-01T00:00:00.000Z')`).run()
  const result = runLint(db)
  assert.equal(result.byKind.gap, 1)
})

test('runLint 落 lint_findings，可按 run 取回', (t) => {
  const db = freshDb(t)
  createPage(db, { projectId: 'p1', kind: 'concept', title: '孤岛', body: '# x\n' })
  const first = runLint(db)
  const rows = findings(db, { runId: first.runId })
  assert.equal(rows.length, first.total)
  assert.equal(rows.every((row) => typeof row.kind === 'string'), true, `${rows.length}`)
})
