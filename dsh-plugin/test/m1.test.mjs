// test/m1.test.mjs — M1 验收：采集（sha256 / 去重 / 切段 / 脱敏）、L1 不可变、检索。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import paths.mjs 之前设置，DSH_HOME 决定库文件位置
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'llm-wiki-m1-'))

const { createStore } = await import('../lib/store.mjs')
const { createCapture } = await import('../lib/capture.mjs')
const { search } = await import('../lib/retrieval.mjs')
const { all, get, exec } = await import('../lib/db.mjs')
const { sha256Hex, projectIdOf } = await import('../lib/ids.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noop = () => {}

function makeRig(overrides = {}) {
  // 每个用例独立库文件：L1 有唯一索引与不可变触发器，共库会互相污染
  const file = join(mkdtempSync(join(tmpdir(), 'llm-wiki-db-')), 'wiki.sqlite3')
  const store = createStore({ log: noop, file })
  const db = store.get()
  const config = { captureEnabled: true, captureMaxToolBytes: 4096, captureBlocklist: '', ...overrides }
  const capture = createCapture({
    getDb: () => db,
    getConfig: () => config,
    log: noop,
    summaryDebounceMs: 10,
  })
  return { store, db, capture, config }
}

const session = { id: 'ses_test', header: { cwd: 'E:\\project\\BaoSteel' } }

test('采集：一轮对话落 4 条 L1（user/assistant/tool/summary），sha256 与内容一致', async () => {
  const { db, capture } = makeRig()
  capture.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  capture.onEvent(session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '帮我看看转炉温度补偿的策略' }] },
  })
  capture.onEvent(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '温度补偿用线性回归，配合炉次校验。' }] } },
  })
  capture.onEvent(session, { type: 'step/end', data: { turn: 1, step: 0 } })
  capture.onEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.md"}' } })
  capture.onEvent(session, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] } },
  })
  capture.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(120)

  const rows = all(db, 'SELECT kind, role, content, content_sha256, project_id FROM sources ORDER BY created_at, role')
  assert.equal(rows.length, 4, `应写入 4 条，实际 ${rows.length}`)
  const roles = rows.map((row) => row.role).sort()
  assert.deepEqual(roles, ['assistant', 'summary', 'tool', 'user'])
  for (const row of rows) assert.equal(row.content_sha256, sha256Hex(row.content))
  for (const row of rows) assert.equal(row.project_id, projectIdOf('E:\\project\\BaoSteel'))

  const tool = rows.find((row) => row.role === 'tool')
  assert.match(tool.content, /工具：read/)
  assert.match(tool.content, /参数摘要：/)
  assert.match(tool.content, /结果摘要：/)

  const summary = rows.find((row) => row.role === 'summary')
  assert.match(summary.content, /本轮汇总/)

  capture.dispose()
})

test('去重：同一事件重放不新增行', async () => {
  const { db, capture } = makeRig()
  const event = { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '重复的消息内容' }] } }
  capture.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  capture.onEvent(session, event)
  capture.onEvent(session, event)
  capture.onEvent(session, event)
  const n = get(db, 'SELECT COUNT(*) AS n FROM sources')
  assert.equal(Number(n.n), 1)
  capture.dispose()
})

test('L1 不可变：UPDATE / DELETE 都被触发器拒绝', async () => {
  const { db, capture } = makeRig()
  capture.onEvent(session, { type: 'turn/start', data: { turn: 3 } })
  capture.onEvent(session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '不可变测试' }] } })
  const row = get(db, 'SELECT id FROM sources LIMIT 1')
  assert.ok(row)
  assert.throws(() => exec(db, `UPDATE sources SET content = '改过' WHERE id = '${row.id}'`), /immutable/)
  assert.throws(() => exec(db, `DELETE FROM sources WHERE id = '${row.id}'`), /immutable/)
  // 软删除是唯一允许的更新
  exec(db, `UPDATE sources SET deleted_at = '2026-10-21T00:00:00.000Z' WHERE id = '${row.id}'`)
  const after = get(db, 'SELECT deleted_at FROM sources WHERE id = ?', [row.id])
  assert.equal(after.deleted_at, '2026-10-21T00:00:00.000Z')
  capture.dispose()
})

test('超长消息按 Markdown 标题切段，locator 带 #part=n', async () => {
  const { db, capture } = makeRig()
  const section = '# 小节\n' + '温度补偿细节说明。'.repeat(120) + '\n'
  const longText = '# 开头\n' + section.repeat(6)
  capture.onEvent(session, { type: 'turn/start', data: { turn: 4 } })
  capture.onEvent(session, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: longText }] } })
  const rows = all(db, 'SELECT locator, part FROM sources ORDER BY part')
  assert.ok(rows.length > 1, `应切段，实际 ${rows.length} 段`)
  assert.equal(rows[0].part, 0)
  assert.match(rows[0].locator, /#part=0$/)
  assert.match(rows[1].locator, /#part=1$/)
  capture.dispose()
})

test('密钥特征被改写成 [REDACTED] 后才落库', async () => {
  const { db, capture } = makeRig()
  capture.onEvent(session, { type: 'turn/start', data: { turn: 5 } })
  capture.onEvent(session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '我的 key 是 sk-abcdefghijklmnopqrstuvwx，别外传' }] },
  })
  const row = get(db, 'SELECT content, meta FROM sources LIMIT 1')
  assert.doesNotMatch(row.content, /sk-abcdefghijklmnopqrstuvwx/)
  assert.match(row.content, /\[REDACTED:\d+\]/)
  assert.match(row.meta, /"redacted":1/)
  capture.dispose()
})

test('工具黑名单：captureBlocklist 命中的工具不采集', async () => {
  const { db, capture } = makeRig({ captureBlocklist: 'write,edit' })
  capture.onEvent(session, { type: 'turn/start', data: { turn: 6 } })
  capture.onEvent(session, { type: 'tool/call', data: { turn: 6, step: 0, callId: 'w1', name: 'write', arguments: '{}' } })
  capture.onEvent(session, {
    type: 'tool/result',
    data: { turn: 6, step: 0, message: { role: 'tool', toolCallId: 'w1', content: [{ type: 'text', text: 'ok' }] } },
  })
  const n = get(db, 'SELECT COUNT(*) AS n FROM sources')
  assert.equal(Number(n.n), 0)
  capture.dispose()
})

test('检索：中文短语命中 L1，结果带上分组与截断标志', async () => {
  const { db, capture } = makeRig()
  capture.onEvent(session, { type: 'turn/start', data: { turn: 7 } })
  capture.onEvent(session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '转炉温度补偿怎么做？炉次校验要注意什么？' }] },
  })
  capture.onEvent(session, {
    type: 'assistant/message',
    data: { turn: 7, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '温度补偿的关键是先做炉次校验，再做 delta 拟合。' }] } },
  })
  capture.onEvent(session, { type: 'step/end', data: { turn: 7, step: 0 } })

  const hit = search(db, '温度补偿', {})
  assert.ok(hit.total >= 1, '应至少命中一条')
  assert.ok(hit.total <= 8, '默认最多 8 条')
  assert.ok(hit.bytes <= 24 * 1024, '默认不超过 24KB')
  assert.equal(hit.mode, 'fts')
  assert.ok(hit.results.every((item) => item.layer === 'L1'))

  const miss = search(db, 'zzzz-不存在的词', {})
  assert.equal(miss.total, 0)
  capture.dispose()
})
