// lib/indexer.mjs — FTS 索引维护与图谱辅助（spec §7：fts / edges 可整表重建且幂等）。
//
// 核心问题：FTS5 的 unicode61 分词器把连续汉字当成一个整词，所以「炉次」搜不到
// 「转炉次温度」。解决办法是索引端与查询端用同一套 bigram 切法（text.ftsTokens）：
// 索引里存 "转炉 炉次 次温 温度"，查询也切 "炉次 次温" ⇒ 词元相等即可命中。
import { ftsBody, ftsTokens, normalizeQuery } from './text.mjs'
import { run, all, get } from './db.mjs'
import { ulid, nowIso } from './ids.mjs'

/** 写/覆盖一条 fts 记录（同 layer + ref_id 先删后插，保证幂等）。 */
export function indexDoc(db, { layer, refId, title, body }) {
  run(db, 'DELETE FROM fts WHERE layer = ? AND ref_id = ?', [layer, refId])
  run(db, 'INSERT INTO fts (layer, ref_id, title, body) VALUES (?, ?, ?, ?)', [
    layer,
    refId,
    ftsBody(title, 200),
    ftsBody(body, 20000),
  ])
}

export function unindexDoc(db, { layer, refId }) {
  run(db, 'DELETE FROM fts WHERE layer = ? AND ref_id = ?', [layer, refId])
}

/** L1 记录的索引标题：角色 + 首个非空行（FTS 只用于检索，标题不落 L1）。 */
export function l1Title(role, content) {
  const firstLine = String(content ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') || ''
  const clipped = Array.from(firstLine).slice(0, 60).join('')
  return `[${role || 'note'}] ${clipped}`
}

/** 整表重建（幂等：先清空再按真相表全量写入）。 */
export function rebuildFts(db) {
  run(db, 'DELETE FROM fts')
  const counts = { L1: 0, L2: 0, L3: 0 }
  for (const row of all(db, 'SELECT id, role, content FROM sources WHERE deleted_at IS NULL ORDER BY created_at')) {
    indexDoc(db, { layer: 'L1', refId: row.id, title: l1Title(row.role, row.content), body: row.content })
    counts.L1 += 1
  }
  for (const row of all(db, "SELECT id, title, content FROM extractions WHERE status <> 'discarded'")) {
    indexDoc(db, { layer: 'L2', refId: row.id, title: row.title, body: row.content })
    counts.L2 += 1
  }
  for (const row of all(db, "SELECT id, title, body, summary FROM pages WHERE deleted_at IS NULL")) {
    indexDoc(db, { layer: 'L3', refId: row.id, title: row.title, body: `${row.summary ?? ''}\n${row.body ?? ''}` })
    counts.L3 += 1
  }
  return counts
}

/** 为一批 token 计算 FTS 命中（bm25 越小越相关）。 */
export function matchFts(db, query) {
  const tokens = ftsTokens(normalizeQuery(query))
  if (tokens.length === 0) return { tokens, rows: [] }
  const expression = tokens.slice(0, 32).map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
  const rows = all(
    db,
    'SELECT layer, ref_id AS refId, bm25(fts) AS rank FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 200',
    [expression],
  )
  return { tokens, rows }
}

/**
 * 写入一条边（重复即忽略）。图谱由 L2/L3 的 derived_from 关系构成。
 * 只有 derived_from 参与检索扩展（spec §10：derived_from 双向、extends 单向）。
 */
export function addEdge(db, { fromLayer, fromId, toLayer, toId, kind, weight = 1 }) {
  const result = run(
    db,
    `INSERT OR IGNORE INTO edges (id, from_layer, from_id, to_layer, to_id, kind, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), fromLayer, fromId, toLayer, toId, kind, weight, nowIso()],
  )
  return Number(result.changes) > 0
}

/** 一个节点的图谱中心度（连线数）。 */
export function centralityOf(db, layer, id) {
  const row = get(
    db,
    `SELECT COUNT(*) AS n FROM edges
      WHERE (from_layer = ? AND from_id = ?) OR (to_layer = ? AND to_id = ?)`,
    [layer, id, layer, id],
  )
  return row ? Number(row.n) : 0
}

/** 批量中心度（避免 N 次查询）。 */
export function centralityMap(db) {
  const map = new Map()
  for (const row of all(db, 'SELECT from_layer AS l, from_id AS i FROM edges')) {
    const key = `${row.l}:${row.i}`
    map.set(key, (map.get(key) || 0) + 1)
  }
  for (const row of all(db, 'SELECT to_layer AS l, to_id AS i FROM edges')) {
    const key = `${row.l}:${row.i}`
    map.set(key, (map.get(key) || 0) + 1)
  }
  return map
}

/** 1 跳邻接（derived_from 双向；extends 只从 L3 指向更晚的 L3）。 */
export function neighboursOf(db, layer, id) {
  const rows = all(
    db,
    `SELECT from_layer, from_id, to_layer, to_id, kind FROM edges
      WHERE kind = 'derived_from' AND ((from_layer = ? AND from_id = ?) OR (to_layer = ? AND to_id = ?))`,
    [layer, id, layer, id],
  )
  const out = []
  for (const row of rows) {
    if (row.from_layer === layer && row.from_id === id) out.push({ layer: row.to_layer, id: row.to_id, kind: row.kind })
    else out.push({ layer: row.from_layer, id: row.from_id, kind: row.kind })
  }
  return out
}

/** 统计 fts 行数（fsck 与面板诊断用）。 */
export function ftsCount(db) {
  const row = get(db, 'SELECT COUNT(*) AS n FROM fts')
  return row ? Number(row.n) : 0
}
