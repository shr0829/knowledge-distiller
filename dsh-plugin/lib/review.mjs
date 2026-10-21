// lib/review.mjs — 审核闸门（spec §G5 / §7 reviews / §11 writes.review_id 必填）。
//
// 设计要点：
//   · 这是**唯一**能让 L2/L3 变成 approved 的入口，也是唯一能产出写入凭据的地方。
//   · 每次裁定都留一条 reviews 行（before/after 存 JSON 快照），写入时凭 review_id 记账，
//     所以「没有审核就没有写入」在数据库层面也成立（writes.review_id 外键）。
//   · 引用校验在 accept 时做：approved 的 L2/L3 至少一条 citations（spec §7 不变量）。
import { all, get, run as runSql, tx } from './db.mjs'
import { ulid, nowIso } from './ids.mjs'
import { indexDoc, unindexDoc } from './indexer.mjs'

const TABLES = { L2: 'extractions', L3: 'abstractions' }
export const ACTIONS = new Set(['accept', 'discard', 'defer', 'edit'])
export const LAYERS = new Set(['L2', 'L3'])

export function tableOf(layer) {
  const table = TABLES[layer]
  if (!table) throw new Error(`未知层：${layer}（只支持 L2 / L3）`)
  return table
}

export function loadTarget(db, layer, id) {
  return get(db, `SELECT * FROM ${tableOf(layer)} WHERE id = ?`, [id])
}

export function citationCount(db, layer, id) {
  const row = get(db, 'SELECT COUNT(*) AS n FROM citations WHERE from_layer = ? AND from_id = ?', [layer, id])
  return row ? Number(row.n) : 0
}

function parseIds(raw) {
  if (Array.isArray(raw)) return raw
  try {
    const value = JSON.parse(raw || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/** 审核队列（面板「审核队列」视图的数据源）。 */
export function queue(db, { layer = null, status = 'candidate', projectId = null, limit = 50, offset = 0 } = {}) {
  const layers = layer ? [layer] : ['L2', 'L3']
  const out = []
  for (const current of layers) {
    tableOf(current)
    const where = ['status = ?']
    const params = [status]
    if (projectId) { where.push('project_id = ?'); params.push(projectId) }
    // L3 的来源靠 citations 反查（abstractions 表没有 source_ids 列），这里统一成空数组
    const extra = current === 'L2' ? 'source_ids AS sourceIds, model' : "'[]' AS sourceIds, NULL AS model"
    const rows = all(
      db,
      `SELECT id, project_id AS projectId, title, content, kind, status, uncertain,
              ${extra}, created_at AS createdAt, updated_at AS updatedAt, decided_at AS decidedAt
         FROM ${TABLES[current]} WHERE ${where.join(' AND ')}
       ORDER BY uncertain ASC, created_at ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    for (const row of rows) {
      out.push({
        ...row,
        layer: current,
        sourceIds: parseIds(row.sourceIds),
        citations: citationsOf(db, current, row.id),
      })
    }
  }
  // 跨层统一按「不确定优先、先后到先审」排
  out.sort((a, b) => (a.uncertain - b.uncertain) || String(a.createdAt).localeCompare(String(b.createdAt)))
  return { items: out.slice(0, limit), counts: queueCounts(db, { projectId }) }
}

export function queueCounts(db, { projectId = null } = {}) {
  const counts = {}
  for (const layer of ['L2', 'L3']) {
    const params = []
    let filter = ''
    if (projectId) { filter = 'AND project_id = ?'; params.push(projectId) }
    const row = all(
      db,
      `SELECT status, COUNT(*) AS n FROM ${TABLES[layer]} WHERE 1 = 1 ${filter} GROUP BY status`,
      params,
    )
    counts[layer] = Object.fromEntries(row.map((item) => [item.status, Number(item.n)]))
  }
  return counts
}

/** 某条 L2/L3 的引用（证据链）。 */
export function citationsOf(db, layer, id) {
  const rows = all(
    db,
    `SELECT c.id, c.to_id AS sourceId, c.quote, c.span_start AS spanStart, c.span_end AS spanEnd,
            s.locator, s.role, s.project_id AS projectId, s.session_id AS sessionId, s.turn,
            substr(s.content, 1, 400) AS excerpt
       FROM citations c LEFT JOIN sources s ON s.id = c.to_id
      WHERE c.from_layer = ? AND c.from_id = ?
      ORDER BY c.created_at, c.id`,
    [layer, id],
  )
  return rows
}

/**
 * 裁定一条候选。action ∈ accept|discard|defer|edit。
 * `after` 只在 edit 时使用（{ title?, content?, kind? }）。
 */
export function decide(db, { layer, id, action, after = null, actor = 'human', now = Date.now() }) {
  if (!LAYERS.has(layer)) throw new Error(`未知层：${layer}`)
  if (!ACTIONS.has(action)) throw new Error(`未知动作：${action}`)
  const table = tableOf(layer)
  const row = loadTarget(db, layer, id)
  if (!row) throw new Error(`找不到 ${layer} 记录：${id}`)

  if (action === 'edit' && (!after || typeof after !== 'object')) {
    throw new Error('edit 必须带 after 补丁')
  }
  if (action !== 'edit' && row.status === 'approved' && action === 'accept') {
    throw new Error('这条已经是 approved，无需重复采纳')
  }
  if (row.status === 'discarded' && action !== 'defer') {
    throw new Error('已丢弃的记录不能再裁定（如需恢复请重新提炼）')
  }
  // 已采纳的可能已经写进 vault：直接丢弃会让笔记失去凭据，要求先撤销
  if (row.status === 'approved' && action === 'discard') {
    throw new Error('已采纳的记录不能直接丢弃：先撤销这次采纳，再重新裁定')
  }
  // 不变量：approved 的 L2/L3 必须至少一条 citations
  if (action === 'accept' && citationCount(db, layer, id) === 0) {
    throw new Error('这条没有任何引用，不能采纳：先补一条 quote 能对上的引用，或把它丢弃')
  }

  const before = JSON.stringify({ title: row.title, content: row.content, kind: row.kind, status: row.status })
  const status = action === 'accept' ? 'approved' : action === 'discard' ? 'discarded' : action === 'defer' ? 'deferred' : row.status
  const patch = action === 'edit' ? normalizeEdit(after, row) : null
  const ts = nowIso(new Date(now))

  return tx(db, () => {
    if (patch) {
      runSql(
        db,
        `UPDATE ${table} SET title = ?, content = ?, kind = ?, updated_at = ? WHERE id = ?`,
        [patch.title, patch.content, patch.kind, ts, id],
      )
      indexDoc(db, { layer, refId: id, title: patch.title, body: patch.content })
    } else {
      runSql(db, `UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ?`, [status, ts, id])
    }
    if (status === 'approved') runSql(db, `UPDATE ${table} SET decided_at = ? WHERE id = ?`, [ts, id])
    const reviewId = ulid(now)
    runSql(
      db,
      `INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [reviewId, layer, id, action, before, patch ? JSON.stringify(patch) : null, actor, ts],
    )
    return { reviewId, layer, id, action, status: patch ? row.status : status, changed: patch }
  })
}

function normalizeEdit(after, row) {
  const title = typeof after.title === 'string' && after.title.trim() !== '' ? String(after.title).trim() : row.title
  const content = typeof after.content === 'string' && after.content.trim() !== '' ? String(after.content) : row.content
  const kind = typeof after.kind === 'string' && after.kind.trim() !== '' ? String(after.kind).trim() : row.kind
  if (title === row.title && content === row.content && kind === row.kind) {
    throw new Error('edit 的内容与原记录相同，没有需要保存的修改')
  }
  return { title, content, kind }
}

/** 某条记录的裁定历史（面板详情里的时间线）。 */
export function history(db, layer, id, limit = 20) {
  return all(
    db,
    `SELECT id, action, before, after, actor, created_at AS createdAt
       FROM reviews WHERE target_layer = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?`,
    [layer, id, limit],
  )
}

/**
 * 找到「这张写入凭据」对应的 review：必须是 accept 或 edit。
 * 没有它就不能写 vault（spec §11 / §7 writes.review_id）。
 */
export function approvalOf(db, layer, id) {
  const row = get(
    db,
    `SELECT id, action, created_at FROM reviews
      WHERE target_layer = ? AND target_id = ? AND action IN ('accept','edit')
      ORDER BY created_at DESC LIMIT 1`,
    [layer, id],
  )
  return row || null
}

/** 撤销最近一次裁定（面板里 3 秒撤销窗口用；只回退状态，不删历史）。 */
export function undoLast(db, { layer, id, now = Date.now() }) {
  const last = get(
    db,
    `SELECT id, action, before, created_at FROM reviews
      WHERE target_layer = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1`,
    [layer, id],
  )
  if (!last) throw new Error('这条还没有裁定记录，无法撤销')
  let snapshot = null
  try { snapshot = JSON.parse(last.before || 'null') } catch { snapshot = null }
  const ts = nowIso(new Date(now))
  const table = tableOf(layer)
  return tx(db, () => {
    runSql(db, 'DELETE FROM reviews WHERE id = ?', [last.id])
    if (snapshot) {
      runSql(
        db,
        `UPDATE ${table} SET title = ?, content = ?, kind = ?, status = ?, updated_at = ? WHERE id = ?`,
        [snapshot.title, snapshot.content, snapshot.kind, snapshot.status || 'candidate', ts, id],
      )
      indexDoc(db, { layer, refId: id, title: snapshot.title, body: snapshot.content })
    } else {
      runSql(db, `UPDATE ${table} SET status = 'candidate', updated_at = ? WHERE id = ?`, [ts, id])
    }
    // 撤销后若已写入过 vault，写入记录保留（历史不可抹），但状态回退会让它变成「待再审」
    return { undone: last.id, action: last.action, status: snapshot ? snapshot.status : 'candidate' }
  })
}

/** 丢弃后按需把 FTS 里那一行摘掉（保持 fts 与正文一致）。 */
export function dropFromIndex(db, layer, id) {
  unindexDoc(db, { layer, refId: id })
}
