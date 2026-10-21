// test/m8.test.mjs — M8：审核闸门 + 应用补丁 + 撤销补偿（页面/主张/链接/写入同一事务）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, all, get, run } from '../lib/db.mjs'
import { insertSource } from '../lib/capture.mjs'
import { compileBatch } from '../lib/compiler.mjs'
import { createPage, getPage, pageDetail } from '../lib/pages.mjs'
import { acceptPatch, discardPatch, deferPatch, undoAccept, mergeOps, queueCounts } from '../lib/apply.mjs'
import { liveClaims } from '../lib/claims.mjs'
import { nowIso } from '../lib/ids.mjs'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'llm-wiki-m8-'))
  return { db: openDb(join(dir, 'wiki.sqlite3')), vault: join(dir, 'vault') }
}

let seq = 0
function source(db, { content, projectId = 'p1', turn = 1 }) {
  seq += 1
  return insertSource(db, {
    kind: 'dsh-turn', role: 'user', projectId, sessionId: 's1', turn, step: 1,
    locator: `s1#t${turn}-${seq}`, content, meta: { role: 'user', cwd: 'E:\\p\\BaoSteel' }, createdAt: nowIso(),
  }).id
}

const TEXT = '决定：碳命中容差保持 ±50 raw 不变，联合命中必须单列统计。温度容差 ±12℃ 不变。'

test('合并 ops：add 追加小节、update 覆盖同名小节、claim 汇总成要点', () => {
  const first = mergeOps('', [{ op: 'add', section: '判定标准', text: '容差 ±50 raw。' }])
  assert.match(first.body, /## 判定标准/u)
  assert.match(first.body, /容差 ±50 raw/u)

  const second = mergeOps(first.body, [
    { op: 'update', section: '判定标准', text: '容差 ±50 raw（≈±0.05%）。' },
    { op: 'claim', text: '联合命中必须单列。' },
  ])
  assert.match(second.body, /≈±0\.05%/u)
  assert.equal(second.body.includes('容差 ±50 raw。'), false, '旧文字被同小节覆盖')
  assert.match(second.body, /## 要点/u)
  assert.equal(second.claims.length, 1)
})

test('接受补丁：新页 + claims + links + review 同事务，带上 vault 时落文件', () => {
  const { db, vault } = temp()
  source(db, { content: TEXT })
  const compiled = compileBatch(db, {})
  const patch = compiled.patches[0]

  const accepted = acceptPatch(db, { patchId: patch.id, vaultPath: vault })
  assert.equal(accepted.ok, true)
  assert.ok(accepted.pageId)

  const page = getPage(db, accepted.pageId)
  assert.equal(page.status, 'approved', '接受后页面是 approved')
  assert.equal(page.revision, 1, '落文件后 revision=1')
  assert.match(page.body, /容差/u)

  const claims = liveClaims(db, { projectId: 'p1' })
  assert.ok(claims.length >= 1, '应写入句子级主张')
  assert.equal(get(db, 'SELECT status FROM patches WHERE id = ?', [patch.id]).status, 'approved')

  const review = get(db, "SELECT * FROM reviews WHERE target_layer = 'L3' AND target_id = ? AND action = 'accept'", [patch.id])
  assert.ok(review)
  const writes = all(db, 'SELECT * FROM writes WHERE review_id = ?', [review.id])
  assert.equal(writes.length, 1, '文件写入挂在这次的 review 上')
  assert.ok(existsSync(join(vault, page.path)))
  assert.match(readFileSync(join(vault, page.path), 'utf8'), /wiki_id: /u)
  db.close()
})

test('接受补丁：已有页面走 update，revision 只增', async () => {
  const { db, vault } = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '联合命中口径', body: '## 判定标准\n\n旧口径。\n' })
  run(db, 'INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['r0', 'L3', page.id, 'accept', '{}', '{}', 'test', nowIso()])
  // 先落一版文件，让 revision=1
  const { writePageFile } = await import('../lib/pages.mjs')
  writePageFile(db, { pageId: page.id, vaultPath: vault, reviewId: 'r0' })

  source(db, { content: '决定：联合命中必须单列统计，不取分区百分比的平均。' })
  const compiled = compileBatch(db, {})
  const accepted = acceptPatch(db, { patchId: compiled.patches[0].id, vaultPath: vault })
  assert.equal(accepted.pageId, page.id, '应落在已有页面上')
  const after = getPage(db, page.id)
  assert.equal(after.revision, 2)
  assert.match(after.body, /联合命中必须单列/u)
  db.close()
})

test('丢弃与延后：只改补丁状态，不动页面；已应用的不能直接丢弃', () => {
  const { db } = temp()
  source(db, { content: TEXT })
  const compiled = compileBatch(db, {})
  const patchId = compiled.patches[0].id

  assert.equal(deferPatch(db, { patchId }).status, 'deferred')
  run(db, "UPDATE patches SET status = 'candidate' WHERE id = ?", [patchId])
  assert.equal(discardPatch(db, { patchId }).status, 'discarded')
  run(db, "UPDATE patches SET status = 'candidate' WHERE id = ?", [patchId])

  acceptPatch(db, { patchId })
  assert.throws(() => discardPatch(db, { patchId }), /先撤销/u)
  db.close()
})

test('撤销：删本次 claim、回滚正文、补丁回 candidate', () => {
  const { db, vault } = temp()
  source(db, { content: TEXT })
  const compiled = compileBatch(db, {})
  const patchId = compiled.patches[0].id
  const accepted = acceptPatch(db, { patchId, vaultPath: vault })
  assert.ok(liveClaims(db, { projectId: 'p1' }).length >= 1)

  const undone = undoAccept(db, { reviewId: accepted.reviewId, vaultPath: vault })
  assert.equal(undone.patchId, patchId)
  assert.ok(undone.removedClaims >= 1)
  assert.equal(liveClaims(db, { projectId: 'p1' }).length, 0, '主张被撤回')
  assert.equal(get(db, 'SELECT status FROM patches WHERE id = ?', [patchId]).status, 'candidate')
  assert.equal(all(db, 'SELECT * FROM writes WHERE review_id = ?', [accepted.reviewId]).length, 0, '写入记录作为补偿被删')
  db.close()
})

test('撤销后旧主张复活（被挤掉的 claim 回来了）', () => {
  const { db } = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'concept', title: '温度补偿' })
  run(db, "INSERT INTO claims (id, page_id, patch_id, subject, predicate, object, statement, confidence, t_valid, t_created, source_ids) VALUES ('c-old', ?, NULL, '温度补偿', 'is', '线性', '温度补偿是 线性', 0.5, ?, ?, '[]')",
    [page.id, nowIso(), nowIso()])

  source(db, { content: '温度补偿是 分段，按温度区间查表。' })
  const compiled = compileBatch(db, {})
  const patch = compiled.patches[0]
  // 保证这条补丁打在同一页上
  run(db, 'UPDATE patches SET page_id = ? WHERE id = ?', [page.id, patch.id])
  acceptPatch(db, { patchId: patch.id })
  const liveAfter = liveClaims(db, { projectId: 'p1' })
  assert.equal(liveAfter.some((claim) => String(claim.object).startsWith('分段')), true)
  const old = get(db, 'SELECT * FROM claims WHERE id = ?', ['c-old'])
  assert.ok(old.t_invalid, '旧主张被标失效')

  const review = get(db, "SELECT * FROM reviews WHERE target_id = ? AND action = 'accept'", [patch.id])
  undoAccept(db, { reviewId: review.id })
  assert.equal(get(db, 'SELECT t_invalid FROM claims WHERE id = ?', ['c-old']).t_invalid, null, '撤销后旧主张恢复有效')
  db.close()
})

test('队列计数与页面详情', () => {
  const { db } = temp()
  source(db, { content: TEXT })
  const compiled = compileBatch(db, {})
  assert.deepEqual(queueCounts(db), { candidate: 1, approved: 0, discarded: 0, deferred: 0 })
  acceptPatch(db, { patchId: compiled.patches[0].id })
  assert.equal(queueCounts(db).approved, 1)
  const page = all(db, 'SELECT id FROM pages')[0]
  const detail = pageDetail(db, page.id)
  assert.ok(Array.isArray(detail.claims))
  db.close()
})
