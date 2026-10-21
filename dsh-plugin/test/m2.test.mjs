// test/m2.test.mjs — M2 验收：提炼（规则模式 / quote 校验 / 幂等）、审核闸门、
// vault 只增 revision、外部改动拒绝、fsck 不变量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'llm-wiki-m2-home-'))

const { createStore } = await import('../lib/store.mjs')
const { insertSource } = await import('../lib/capture.mjs')
const { runPipeline, pendingSources, pendingCount, ruleTitle, classify } = await import('../lib/pipeline.mjs')
const { queue, decide, approvalOf, undoLast, loadTarget, citationCount } = await import('../lib/review.mjs')
const { writeNote, rebaselineNote, rebuildIndex, listNotes, ensureVault } = await import('../lib/vault.mjs')
const { fsck } = await import('../lib/fsck.mjs')
const { all, get, run } = await import('../lib/db.mjs')
const { sha256Hex } = await import('../lib/ids.mjs')

const noop = () => {}
const CONFIG = {
  pipelineBatchSize: 12,
  pipelineIdleMinutes: 30,
  pipelineAutoRun: true,
  pipelineModel: '',
  vaultPath: '',
  writeLanguage: 'zh',
}

function makeRig() {
  const file = join(mkdtempSync(join(tmpdir(), 'llm-wiki-m2-db-')), 'wiki.sqlite3')
  const vault = mkdtempSync(join(tmpdir(), 'llm-wiki-vault-'))
  const store = createStore({ log: noop, file })
  return { db: store.get(), store, vault, config: { ...CONFIG, vaultPath: vault } }
}

/** 铺一轮对话所需的 L1（借 insertSource，不经过事件流，跑得快）。 */
function seedTurn(db, { projectId = 'proj_a', sessionId = 'ses_1', turn = 1, user, assistant }) {
  const ids = []
  ids.push(insertSource(db, {
    kind: 'dsh-turn',
    role: 'user',
    projectId,
    sessionId,
    turn,
    step: 0,
    locator: `dsh-turn:${sessionId}:${turn}:user`,
    content: user,
    meta: { cwd: 'E:\\project\\BaoSteel', role: 'user' },
  }).id)
  if (assistant) {
    ids.push(insertSource(db, {
      kind: 'dsh-turn',
      role: 'assistant',
      projectId,
      sessionId,
      turn,
      step: 0,
      locator: `dsh-turn:${sessionId}:${turn}:assistant`,
      content: assistant,
      meta: { cwd: 'E:\\project\\BaoSteel', role: 'assistant' },
    }).id)
  }
  return ids
}

test('提炼：一轮对话产出一条 L2 候选，引用逐字命中原文，重跑幂等', () => {
  const { db, config } = makeRig()
  seedTurn(db, {
    user: '转炉终点碳温预测用什么模型？',
    assistant: '决定采用梯度提升树，配合炉次校验；温度容差 ±12℃。',
  })
  assert.equal(pendingCount(db), 2)

  const first = runPipeline(db, { config, log: noop })
  assert.equal(first.ran, true)
  assert.equal(first.inserted, 1, `应新增 1 条 L2，实际 ${first.inserted}`)

  const rows = all(db, "SELECT id, title, content, kind, status, uncertain, fingerprint FROM extractions")
  assert.equal(rows.length, 1)
  const l2 = rows[0]
  assert.equal(l2.status, 'candidate')
  assert.equal(l2.uncertain, 1, '规则模式产出一律标 uncertain')
  assert.equal(l2.kind, 'decision', '含「决定/采用」应归为 decision')
  assert.ok(l2.title.length > 0)

  // quote 必须是原文逐字片段
  const citations = all(db, 'SELECT to_id, quote FROM citations WHERE from_layer = ? AND from_id = ?', ['L2', l2.id])
  assert.ok(citations.length >= 2, `应有至少两条引用，实际 ${citations.length}`)
  for (const citation of citations) {
    const source = get(db, 'SELECT content FROM sources WHERE id = ?', [citation.to_id])
    assert.ok(source, '引用必须指向真实 L1')
    assert.ok(String(source.content).includes(citation.quote), `quote 必须是原文子串：${citation.quote.slice(0, 20)}`)
  }
  // derived_from 边同时建立，供图扩展使用
  const edges = all(db, "SELECT * FROM edges WHERE from_layer = 'L2' AND kind = 'derived_from'")
  assert.equal(edges.length, citations.length)

  // 幂等：同一批 L1 再跑不会重复产出
  assert.equal(pendingCount(db), 0, '被引用的 L1 不再 pending')
  const second = runPipeline(db, { config, log: noop })
  assert.equal(second.ran, false)
  assert.equal(second.reason, 'nothing-pending')
  assert.equal(all(db, 'SELECT id FROM extractions').length, 1)
})

test('提炼：标题/分类的规则口径', () => {
  assert.equal(ruleTitle('## 标题一行\n正文'), '标题一行')
  assert.equal(ruleTitle('- **加粗** 开头'), '加粗 开头')
  assert.equal(ruleTitle(''), '')
  assert.equal(classify('决定改用方案 A'), 'decision')
  assert.equal(classify('记录一下今天的观察'), 'concept')
})

test('审核闸门：未采纳不得写入；采纳后 vault 落文件且只增 revision', () => {
  const { db, vault, config } = makeRig()
  seedTurn(db, { user: '为什么温度模型要单独校验炉次？', assistant: '决定加一层炉次校验，避免跨炉次泄漏。' })
  runPipeline(db, { config, log: noop })
  const l2 = get(db, 'SELECT * FROM extractions LIMIT 1')
  assert.ok(l2)

  // 未审核 → 拒绝
  assert.throws(() => writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault }), /只有 approved/, '未采纳必须拒绝写入')

  // 无审核凭据 → 即便强改状态也拒绝（writes.review_id 是硬约束）
  run(db, "UPDATE extractions SET status = 'approved' WHERE id = ?", [l2.id])
  assert.equal(approvalOf(db, 'L2', l2.id), null)
  assert.throws(() => writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault }), /审核凭据/, '缺 review_id 必须拒绝')
  run(db, "UPDATE extractions SET status = 'candidate' WHERE id = ?", [l2.id])

  const accepted = decide(db, { layer: 'L2', id: l2.id, action: 'accept' })
  assert.equal(accepted.status, 'approved')
  assert.ok(accepted.reviewId, 'accept 必须留下 reviews 行')
  assert.ok(approvalOf(db, 'L2', l2.id), '写入凭据来自 accept')

  const first = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(first.revision, 1)
  const full = join(vault, first.path.split('/').join('\\'))
  assert.ok(existsSync(full), `文件应存在：${full}`)
  const text = readFileSync(full, 'utf8')
  assert.match(text, /^---\ntitle: /)
  assert.match(text, /project_id: proj_a/)
  assert.match(text, /kind: decision/)
  assert.match(text, /revision: 1/)
  assert.match(text, /## 出处/)
  assert.match(text, /BaoSteel|proj_a/)

  // 幂等：内容没变不涨 revision、不写文件
  const again = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
  assert.equal(again.revision, 1)
  assert.equal(all(db, 'SELECT id FROM notes').length, 1)

  // 修订：edit 改正文 → revision 2，旧内容留在 notes 且被 superseded_by 指向新行
  decide(db, { layer: 'L2', id: l2.id, action: 'edit', after: { content: '决定加一层炉次校验（补充：按班次再切一刀）。' } })
  const second = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(second.ok, true)
  assert.equal(second.changed, true)
  assert.equal(second.revision, 2, '内容变化必须 revision+1')

  const notes = all(db, 'SELECT revision, content, superseded_by FROM notes ORDER BY revision')
  assert.equal(notes.length, 2)
  assert.equal(notes[0].superseded_by, get(db, 'SELECT id FROM notes WHERE revision = 2').id, '旧 revision 必须有 superseded_by')
  assert.equal(notes[1].revision, 2)
  // 磁盘上只有一份文件（不另存 r2 文件）
  assert.equal(listNotes(db).length, 1, '同一条笔记只有一行路径')
  assert.match(readFileSync(full, 'utf8'), /revision: 2/)

  // 写入记录都挂在 review 上
  const writes = all(db, 'SELECT review_id, error FROM writes')
  assert.equal(writes.length, 2)
  for (const row of writes) {
    assert.ok(row.review_id, 'writes.review_id 不能为空')
    assert.equal(row.error, null)
    assert.ok(get(db, 'SELECT id FROM reviews WHERE id = ?', [row.review_id]))
  }

  // 索引重算
  const index = rebuildIndex(db, { vaultPath: vault })
  assert.equal(index.ok, true)
  assert.ok(existsSync(join(vault, 'Library', '索引.md')))
  assert.match(readFileSync(join(vault, 'Library', '索引.md'), 'utf8'), /## BaoSteel/)
})

test('外部改动：sha256 对不上就拒绝写入并记为 conflict', () => {
  const { db, vault, config } = makeRig()
  seedTurn(db, { user: '把结论写进笔记', assistant: '决定先记一条待办。' })
  runPipeline(db, { config, log: noop })
  const l2 = get(db, 'SELECT * FROM extractions LIMIT 1')
  decide(db, { layer: 'L2', id: l2.id, action: 'accept' })
  const first = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(first.ok, true)

  const full = join(vault, first.path.split('/').join('\\'))
  writeFileSync(full, `${readFileSync(full, 'utf8')}\n\n手工加的一段。\n`, 'utf8')

  const conflicted = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(conflicted.ok, false)
  assert.equal(conflicted.conflict, true)
  const bad = get(db, "SELECT error FROM writes WHERE error LIKE 'conflict%'")
  assert.ok(bad, '冲突必须记进 writes.error')
  // 文件没被覆盖
  assert.match(readFileSync(full, 'utf8'), /手工加的一段/)
  // fsck 能独立发现外部改动
  const checked = fsck(db, { vaultPath: vault })
  assert.equal(checked.ok, false)
  assert.ok(checked.issues.some((item) => item.code === 'external-edit'))
})

test('解决冲突：接受人类改动后基于人的版本继续只增 revision', () => {
  const { db, vault, config } = makeRig()
  seedTurn(db, { user: '把结论写进笔记', assistant: '决定先记一条待办。' })
  runPipeline(db, { config, log: noop })
  const l2 = get(db, 'SELECT * FROM extractions LIMIT 1')
  decide(db, { layer: 'L2', id: l2.id, action: 'accept' })
  const first = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(first.ok, true)

  const full = join(vault, first.path.split('/').join('\\'))
  writeFileSync(full, `${readFileSync(full, 'utf8')}\n\n人的补充说明。\n`, 'utf8')
  assert.equal(writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault }).conflict, true)

  // 接受人类改动：不碰文件内容，把磁盘现状登记成一个新的 revision
  const before = readFileSync(full, 'utf8')
  const resolved = rebaselineNote(db, { path: first.path, vaultPath: vault })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.reset, true)
  assert.equal(resolved.revision, 2, '人的手改也占一个 revision')
  assert.equal(readFileSync(full, 'utf8'), before, '解决冲突不写文件')
  assert.equal(fsck(db, { vaultPath: vault }).ok, true, '解决后 fsck 应当没意见')

  // 再写一次：插件正文与磁盘不同 → 正常涨 revision，人的那版留在历史里
  const again = writeNote(db, { layer: 'L2', id: l2.id, vaultPath: vault })
  assert.equal(again.ok, true)
  assert.equal(again.changed, true)
  assert.equal(again.revision, 3)
  const history = get(db, 'SELECT content FROM notes WHERE path = ? AND revision = 2', [first.path])
  assert.match(history.content, /人的补充说明/, '人的那一版必须留在 notes 历史里')
})

test('不变量：L1 不可改、无引用不得采纳、fsck 报得很准', () => {
  const { db, vault, config } = makeRig()
  seedTurn(db, { user: '记录一个待验证的假设', assistant: '先不下结论。' })

  // L1 不可变
  const source = get(db, 'SELECT id FROM sources LIMIT 1')
  assert.throws(() => run(db, "UPDATE sources SET content = 'tampered' WHERE id = ?", [source.id]), /sources are immutable/)
  assert.throws(() => run(db, 'DELETE FROM sources WHERE id = ?', [source.id]), /sources are immutable/)
  // 软删除是唯一允许的 UPDATE
  run(db, 'UPDATE sources SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), source.id])
  assert.ok(get(db, 'SELECT deleted_at FROM sources WHERE id = ?', [source.id]).deleted_at)

  // 造一条没有引用的 approved（模拟绕过闸门的数据损坏）→ accept 应被拒，fsck 应报
  runPipeline(db, { config, log: noop })
  const l2 = get(db, 'SELECT * FROM extractions LIMIT 1')
  run(db, "DELETE FROM citations WHERE from_layer = 'L2' AND from_id = ?", [l2.id])
  assert.equal(citationCount(db, 'L2', l2.id), 0)
  assert.throws(() => decide(db, { layer: 'L2', id: l2.id, action: 'accept' }), /没有任何引用/)
  run(db, "UPDATE extractions SET status = 'approved' WHERE id = ?", [l2.id])
  const checked = fsck(db, { vaultPath: vault })
  assert.ok(checked.issues.some((item) => item.code === 'approved-without-citation'))
  // 触发器仍在
  assert.ok(!checked.issues.some((item) => item.code === 'immutable-trigger'))
})

test('审核队列与撤销：裁定后自动出队，撤销能回退状态', () => {
  const { db, config } = makeRig()
  seedTurn(db, { user: '问题一', assistant: '回答一。' })
  seedTurn(db, { user: '问题二', assistant: '回答二。', turn: 2 })
  runPipeline(db, { config, log: noop })

  const listed = queue(db, { status: 'candidate' })
  assert.equal(listed.items.length, 2)
  assert.equal(listed.counts.L2.candidate, 2)
  const target = listed.items[0]

  decide(db, { layer: target.layer, id: target.id, action: 'discard' })
  const after = queue(db, { status: 'candidate' })
  assert.equal(after.items.length, 1, '裁定过的应从候选队列消失')
  assert.equal(after.counts.L2.discarded, 1)

  // 丢弃不可再采纳
  assert.throws(() => decide(db, { layer: target.layer, id: target.id, action: 'accept' }), /已丢弃/)

  // 撤销：回到 candidate
  const undone = undoLast(db, { layer: target.layer, id: target.id })
  assert.equal(undone.status, 'candidate')
  assert.equal(loadTarget(db, target.layer, target.id).status, 'candidate')
  assert.equal(queue(db, { status: 'candidate' }).items.length, 2)
})

test('vault 路径白名单：拒绝写出 vault 之外', async () => {
  const { assertInside } = await import('../lib/vault.mjs')
  const vault = ensureVault(mkdtempSync(join(tmpdir(), 'llm-wiki-guard-')))
  assert.ok(assertInside(vault, join(vault, 'Library', 'a.md')))
  assert.throws(() => assertInside(vault, join(vault, '..', 'escape.md')), /vault 之外/)
})
