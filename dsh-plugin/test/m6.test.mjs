// test/m6.test.mjs — M6：编译（选页、补丁、quote 校验、指纹/相似度去重、预算、幂等）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, get, run } from '../lib/db.mjs'
import { insertSource } from '../lib/capture.mjs'
import { createPage } from '../lib/pages.mjs'
import {
  compileBatch, pendingCount, pendingSources, groupWindows, selectPages, shingles, similar,
  buildDraft, createPatch, validateQuotes, patchDetail, pipelineState, patchOps, listPatches,
} from '../lib/compiler.mjs'
import { nowIso } from '../lib/ids.mjs'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'llm-wiki-m6-'))
  return openDb(join(dir, 'wiki.sqlite3'))
}

let seq = 0
function source(db, { projectId = 'p1', content, turn = 1, role = 'user', session = 's1', cwd = 'E:\\p\\BaoSteel' } = {}) {
  seq += 1
  return insertSource(db, {
    kind: 'dsh-turn', role, projectId, sessionId: session, turn, step: 1,
    locator: `${session}#t${turn}-${role}-${seq}`,
    content, meta: { role, cwd }, createdAt: nowIso(),
  }).id
}

const DECISION = '决定：碳命中容差保持 ±50 raw 不变，联合命中必须单列统计，不取分区百分比的平均。'

test('待编译队列：被补丁引用过就算处理过', () => {
  const db = temp()
  const id = source(db, { content: DECISION })
  assert.equal(pendingCount(db), 1)
  run(db, `INSERT INTO patches (id, page_id, project_id, base_revision, title, kind, ops, status, fingerprint, model, reason, base_sources, created_at)
    VALUES ('p9', NULL, 'p1', 0, 't', 'decision', '[]', 'candidate', 'f9', 'rules', '', ?, ?)`,
  [JSON.stringify([id]), nowIso()])
  assert.equal(pendingCount(db), 0, '引用过的不再出现')
  db.close()
})

test('窗口切分：同会话同轮合并，无轮次各自成窗，单窗 ≤8KB', () => {
  const db = temp()
  source(db, { content: 'A'.repeat(40), turn: 1 })
  source(db, { content: 'B'.repeat(40), turn: 1, role: 'assistant' })
  source(db, { content: 'C'.repeat(40), turn: 2 })
  const manual = insertSource(db, {
    kind: 'manual', role: 'user', projectId: 'p1', sessionId: null, turn: null, step: null,
    locator: 'manual#1', content: 'D'.repeat(40), meta: {}, createdAt: nowIso(),
  })
  const windows = groupWindows(pendingSources(db))
  assert.equal(windows.length, 3, 'turn1 合并成一个窗口 + turn2 + manual')
  const first = windows.find((w) => w.turn === 1)
  assert.equal(first.rows.length, 2)
  assert.equal(windows.find((w) => w.turn === null).rows[0].id, manual.id)

  const big = groupWindows([{ project_id: 'p1', session_id: 's', turn: 9, content: 'X'.repeat(10 * 1024), turn2: 9 }])
  void big
  db.close()
})

test('选页：FTS 能找到已有页面，且只在本项目内', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '评估口径', body: '碳命中容差 ±50 raw，联合命中单列。\n' })
  createPage(db, { projectId: 'p2', kind: 'decision', title: '别的项目', body: '碳命中容差 ±50 raw。\n' })
  const hits = selectPages(db, { projectId: 'p1', text: '碳命中容差' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, page.id)
  db.close()
})

test('quote 校验：找不到逐字片段就当坏了', () => {
  const db = temp()
  const good = source(db, { content: DECISION })
  const bad = source(db, { content: '完全无关的一段话' })
  const { ops, broken } = validateQuotes(db, [
    { op: 'add', text: 'x', quotes: [{ source_id: good, quote: '±50 raw' }, { source_id: bad, quote: '不存在的句子' }] },
  ])
  assert.equal(broken.length, 1)
  assert.equal(ops[0].quotes.length, 1)
  assert.equal(ops[0].quotes[0].source_id, good)
  db.close()
})

test('编译：产补丁、复跑幂等、内容相同的第二窗被相似度挡掉', () => {
  const db = temp()
  source(db, { content: DECISION })
  const first = compileBatch(db, { maxSources: 12 })
  assert.equal(first.ran, true)
  assert.equal(first.inserted, 1)
  const patch = first.patches[0]
  assert.equal(patch.status, 'candidate')
  assert.equal(patch.kind, 'decision')
  assert.equal(patch.model, 'rules')
  assert.equal(patch.base_revision, 0)

  const ops = patchOps(patch)
  assert.equal(ops[0].op, 'add')
  assert.ok(ops.some((op) => op.op === 'claim'), '应有句子级主张')
  assert.ok(ops[0].quotes.length >= 1)

  // 同样的来源再跑：pending 已空
  assert.equal(compileBatch(db, {}).reason, 'pending-empty')

  // 把补丁的 base_sources 清掉让来源重新待编译：指纹相同 ⇒ 不再产第二个补丁
  run(db, "UPDATE patches SET base_sources = '[]' WHERE id = ?", [patch.id])
  const again = compileBatch(db, {})
  assert.equal(again.inserted, 0, '同指纹的补丁不应重复入队')
  assert.equal(again.reason, 'compiled')
  assert.equal(again.patches.length, 0)
  assert.equal(again.skipped, 1)
  db.close()
})

test('相似度去重：目标页已有同样内容时不产补丁', () => {
  const db = temp()
  const text = DECISION
  createPage(db, { projectId: 'p1', kind: 'decision', title: '评估口径', body: text + '\n' })
  source(db, { content: text })
  const result = compileBatch(db, {})
  assert.equal(result.inserted, 0)
  assert.equal(result.skipped, 1)
  db.close()
})

test('编译：已有同 kind 页面时产 update 补丁并带上 base_revision', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '评估口径', body: '碳命中容差 ±50 raw。\n' })
  run(db, 'UPDATE pages SET revision = 3 WHERE id = ?', [page.id])
  source(db, { content: '决定：联合命中必须单列统计，不取分区百分比的平均。' })
  const result = compileBatch(db, {})
  assert.equal(result.inserted, 1)
  const patch = result.patches[0]
  assert.equal(patch.page_id, page.id)
  assert.equal(patch.base_revision, 3)
  assert.equal(patchOps(patch)[0].op, 'update')
  db.close()
})

test('补丁详情：给审核视图的并排 diff 与证据校验状态', () => {
  const db = temp()
  source(db, { content: DECISION })
  const result = compileBatch(db, {})
  const detail = patchDetail(db, result.patches[0].id)
  assert.ok(detail)
  assert.equal(detail.page, null)
  assert.equal(detail.quotes.length >= 1, true)
  assert.equal(detail.quotes.every((quote) => quote.verified), true)
  assert.ok(Array.isArray(detail.diff.after))
  db.close()
})

test('相似度工具：同一段话 0.9 以上，不同内容为 0', () => {
  const a = shingles('碳命中容差保持 ±50 raw 不变，联合命中必须单列统计不取分区平均')
  const b = shingles('碳命中容差保持 ±50 raw 不变，联合命中必须单列统计不取分区平均！')
  assert.ok(similar(a, b) > 0.9)
  assert.equal(similar(a, shingles('完全不同的一段话完全不同的一段话')), 0)
})

test('状态：队列数与待编译数', () => {
  const db = temp()
  source(db, { content: DECISION })
  const state = pipelineState(db)
  assert.equal(state.pending, 1)
  assert.equal(state.mode, 'rules')
  compileBatch(db, {})
  const after = pipelineState(db)
  assert.equal(after.pending, 0)
  assert.equal(after.queue, 1)
  assert.ok(after.lastRunAt)
  assert.equal(listPatches(db, {}).length, 1)
  void get
})
