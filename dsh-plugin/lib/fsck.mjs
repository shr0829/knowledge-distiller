// lib/fsck.mjs — 不变量复核（spec §7 / §15 验收）。
//
// 只读检查，不改数据：面板「设置 → 自检」和测试都用它。每条 issue 带 code，
// 便于以后做「一键修复」时按 code 分派。
import fs from 'node:fs'
import path from 'node:path'
import { all, get } from './db.mjs'
import { nowIso, sha256Hex } from './ids.mjs'
import { ftsCount } from './indexer.mjs'

export const CHECK_CODES = Object.freeze({
  IMMUTABLE_TRIGGER: 'immutable-trigger',
  APPROVED_WITHOUT_CITATION: 'approved-without-citation',
  FTS_DRIFT: 'fts-drift',
  ORPHAN_WRITE: 'orphan-write',
  DANGLING_EDGE: 'dangling-edge',
  EXTERNAL_EDIT: 'external-edit',
  MISSING_NOTE_FILE: 'missing-note-file',
})

/**
 * @param {object} db
 * @param {{vaultPath?: string}} options
 */
export function fsck(db, { vaultPath = null } = {}) {
  const issues = []
  const push = (code, detail, extra = {}) => issues.push({ code, detail, ...extra })

  // 1. L1 不可变的两个触发器必须在（建库时由 schema 保证，这里防手工改库）
  const triggers = all(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sources'")
  const names = new Set(triggers.map((row) => row.name))
  for (const required of ['sources_immutable', 'sources_no_delete']) {
    if (!names.has(required)) push(CHECK_CODES.IMMUTABLE_TRIGGER, `缺少触发器 ${required}，L1 可能被改写`)
  }

  // 2. approved 的 L2/L3 至少一条 citations
  for (const [layer, table] of [['L2', 'extractions'], ['L3', 'abstractions']]) {
    const rows = all(
      db,
      `SELECT t.id, t.title FROM ${table} t
        WHERE t.status = 'approved'
          AND NOT EXISTS (SELECT 1 FROM citations c WHERE c.from_layer = ? AND c.from_id = t.id)`,
      [layer],
    )
    for (const row of rows) {
      push(CHECK_CODES.APPROVED_WITHOUT_CITATION, `${layer} 已采纳但没有任何引用：${row.title}`, { layer, id: row.id })
    }
  }

  // 3. FTS 行数应与「参与索引的文档数」一致（可整表重建，所以漂移可修）
  const expectedSources = Number(get(db, 'SELECT COUNT(*) AS n FROM sources WHERE deleted_at IS NULL').n)
  const expectedL2 = Number(get(db, "SELECT COUNT(*) AS n FROM extractions WHERE status <> 'discarded'").n)
  // L3 的真相层在 v2 已从 abstractions 搬到 pages（页面），索引对象跟着换
  const expectedL3 = Number(get(db, 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL').n)
  const indexed = ftsCount(db)
  const expected = expectedSources + expectedL2 + expectedL3
  if (indexed !== expected) {
    push(CHECK_CODES.FTS_DRIFT, `FTS 有 ${indexed} 行，正文应索引 ${expected} 行（可用 /api-llm-wiki/fsck 的 rebuild 重建）`, {
      indexed,
      expected,
    })
  }

  // 4. writes 必须挂在真实 reviews 上
  const orphanWrites = all(
    db,
    `SELECT w.id, w.path FROM writes w LEFT JOIN reviews r ON r.id = w.review_id WHERE r.id IS NULL`,
  )
  for (const row of orphanWrites) {
    push(CHECK_CODES.ORPHAN_WRITE, `写入记录没有对应审核（${row.path}）`, { id: row.id })
  }

  // 5. edges 不能指向不存在的节点
  const danglingEdges = all(
    db,
    `SELECT e.id, e.from_layer, e.from_id, e.to_layer, e.to_id FROM edges e
      WHERE (e.from_layer = 'L1' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = e.from_id))
         OR (e.from_layer = 'L2' AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.id = e.from_id))
         OR (e.from_layer = 'L3' AND NOT EXISTS (SELECT 1 FROM abstractions a WHERE a.id = e.from_id))
         OR (e.to_layer = 'L1' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = e.to_id))
         OR (e.to_layer = 'L2' AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.id = e.to_id))
         OR (e.to_layer = 'L3' AND NOT EXISTS (SELECT 1 FROM abstractions a WHERE a.id = e.to_id))`,
  )
  for (const row of danglingEdges) {
    push(CHECK_CODES.DANGLING_EDGE, `边指向不存在的节点：${row.from_layer}:${row.from_id} → ${row.to_layer}:${row.to_id}`, { id: row.id })
  }

  // 6. vault 侧：文件被外部改过 / 文件消失（只报不修——真相层归人管）
  if (vaultPath) {
    const root = path.resolve(String(vaultPath))
    const latest = all(
      db,
      `SELECT n.path, n.content_sha256 FROM notes n
         JOIN (SELECT path, MAX(revision) AS rev FROM notes GROUP BY path) l
           ON l.path = n.path AND l.rev = n.revision`,
    )
    for (const row of latest) {
      const full = path.join(root, String(row.path).split('/').join(path.sep))
      if (!fs.existsSync(full)) {
        push(CHECK_CODES.MISSING_NOTE_FILE, `笔记本体不在了：${row.path}`, { path: row.path })
        continue
      }
      let text = ''
      try { text = fs.readFileSync(full, 'utf8') } catch { continue }
      if (sha256Hex(text) !== row.content_sha256) {
        push(CHECK_CODES.EXTERNAL_EDIT, `文件在 vault 外被改过，下次写入会拒绝：${row.path}`, { path: row.path })
      }
    }
  }

  const counts = {
    sources: expectedSources,
    extractions: expectedL2,
    abstractions: expectedL3,
    fts: indexed,
    notes: Number(get(db, 'SELECT COUNT(*) AS n FROM notes').n),
    writes: Number(get(db, 'SELECT COUNT(*) AS n FROM writes').n),
    edges: Number(get(db, 'SELECT COUNT(*) AS n FROM edges').n),
  }
  return { ok: issues.length === 0, issues, counts, checkedAt: nowIso() }
}
