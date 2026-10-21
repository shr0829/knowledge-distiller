// lib/claims.mjs — 句子级主张与双时态（docs/DSH_WIKI_SPEC.md §3、§5.4；口径取自 Graphiti）。
//
// 双时态（bi-temporal）两组时间，语义不同、不许混用：
//   · 事实时间  t_valid / t_invalid —— 这件事在现实里何时成立（默认取来源的 created_at）
//   · 记录时间  t_created / t_expired —— 这条记录何时被写入 / 何时被取代（写入时刻）
// 矛盾的处理是「旧主张失效、不删」：写 t_invalid + t_expired + superseded_by，
// 于是历史查询（as-of）仍能读回旧说法，而当前视图只看到新说法。
import { all, get, run } from './db.mjs'
import { nowIso, ulid } from './ids.mjs'

export const PREDICATES = Object.freeze(['is', 'must', 'not', 'uses', 'states'])

/** 实体名规范化：去 wikilink 包装、去标点、折叠空白、ASCII 小写。 */
export function normalizeEntity(text) {
  const raw = String(text ?? '')
    .replace(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/gu, '$1')
    .replace(/[\s\u3000]+/gu, ' ')
    .replace(/^[\s"'“”‘’「」『』()（）[\]【】]+|[\s"'“”‘’「」『』()（）[\]【】]+$/gu, '')
    .replace(/[。；;，,：:！!？?]+$/gu, '')
    .trim()
  const lowered = raw.replace(/[A-Z]/gu, (ch) => ch.toLowerCase())
  return lowered.slice(0, 60)
}

const COPULA = /(?:意味着|等于|采用|使用|改用|选用|选择|是|为|即)/u
const MARKER_TAIL = /(?:意味着|等于|采用|使用|改用|选用|选择|是|为|即)([^。；;！!？?]+)/u

/** 从一句陈述里切出 (subject, predicate, object)。规则优先、可解释；模型可用时替换这一层。 */
export function analyzeStatement(text) {
  const original = String(text ?? '').replace(/\s+/gu, ' ').trim()
  // 括号注释（如「±50 raw（≈±0.05%）」）不参与拆句：它只是补充说明，会把实体名切碎。
  const statement = original.replace(/（[^）]*）|\([^)]*\)/gu, '').replace(/\s+/gu, ' ').trim()
  const clause = statement.split(/[，。；、,;:：!?！？]/u)[0] || statement
  let predicate = 'states'
  if (/(?:不|禁止|永不|不得|不允许|不再)/u.test(statement)) predicate = 'not'
  else if (/(?:应|必须|需要|要求)/u.test(statement)) predicate = 'must'
  else if (/(?:采用|使用|改用|选用|选择)/u.test(statement)) predicate = 'uses'
  else if (/(?:是|为|等于|即|意味着)/u.test(statement)) predicate = 'is'

  // 「X 是/采用 Y」这类判断句：主语取系词之前，宾语取之后。
  // 主语必须是实体而不是整句，否则同一实体的两条说法会因为主语文本不同而永远不算矛盾。
  let subject = normalizeEntity(clause)
  let object = ''
  if (predicate === 'is' || predicate === 'uses') {
    const head = statement.split(COPULA)[0]
    const tail = statement.match(MARKER_TAIL)
    if (head && normalizeEntity(head)) subject = normalizeEntity(head)
    if (tail) object = normalizeEntity(tail[1])
  }
  return { subject, predicate, object, statement: original }
}

export function addClaim(db, { pageId, patchId = null, statement, sourceIds = [], tValid = null, tInvalid = null, tCreated = null, confidence = 0.5 }) {
  const parts = analyzeStatement(statement)
  if (!parts.subject) throw new Error('主张没有主语，拒绝写入')
  const now = nowIso()
  const id = ulid()
  run(db, `INSERT INTO claims (id, page_id, patch_id, subject, predicate, object, statement, confidence, t_valid, t_invalid, t_created, t_expired, superseded_by, source_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  [id, pageId, patchId, parts.subject, parts.predicate, parts.object, parts.statement, confidence, tValid ?? now, tInvalid, tCreated ?? now, JSON.stringify(sourceIds)])
  return get(db, 'SELECT * FROM claims WHERE id = ?', [id])
}

export function claimsOfPage(db, pageId) {
  return all(db, 'SELECT * FROM claims WHERE page_id = ? ORDER BY t_created DESC', [pageId])
}

/** 现行主张：既没被取代、也没失效。 */
export function liveClaims(db, { projectId = null } = {}) {
  const sql = `SELECT c.*, p.project_id AS projectId, p.title AS pageTitle
    FROM claims c JOIN pages p ON p.id = c.page_id
    WHERE c.t_invalid IS NULL AND c.t_expired IS NULL AND p.deleted_at IS NULL
    ${projectId ? 'AND p.project_id = ?' : ''}
    ORDER BY c.t_valid DESC`
  return all(db, sql, projectId ? [projectId] : [])
}

/**
 * as-of 查询：只要「事实时间在 asOf 那一刻有效」的主张，无论记录时间。
 * 用于「去年九月时我们的口径是什么」这类回溯。
 */
export function claimsAsOf(db, { asOf, projectId = null }) {
  const sql = `SELECT c.*, p.project_id AS projectId, p.title AS pageTitle
    FROM claims c JOIN pages p ON p.id = c.page_id
    WHERE c.t_valid <= ? AND (c.t_invalid IS NULL OR c.t_invalid > ?) AND p.deleted_at IS NULL
    ${projectId ? 'AND p.project_id = ?' : ''}
    ORDER BY c.t_valid DESC`
  const params = [asOf, asOf]
  if (projectId) params.push(projectId)
  return all(db, sql, params)
}

/**
 * 矛盾：同项目、同 (subject, predicate)、有效期重叠、object 不同、两条都还活着。
 * 返回成对的候选，交给 lint 呈报（不自动裁决——裁决是人的事）。
 */
export function findContradictions(db, { projectId = null } = {}) {
  const rows = liveClaims(db, { projectId })
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.projectId}\u0000${row.subject}\u0000${row.predicate}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const pairs = []
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]
        const b = list[j]
        if (a.object === b.object) continue
        if (overlaps(a, b)) pairs.push({ a, b, subject: a.subject, predicate: a.predicate })
      }
    }
  }
  return pairs
}

/** 半开区间 [tValid, tInvalid) 是否重叠：首尾相接（旧失效 = 新生效）不算重叠。 */
function overlaps(a, b) {
  const aEnd = a.t_invalid ?? null
  const bEnd = b.t_invalid ?? null
  const aBeforeBEnd = bEnd === null || a.t_valid < bEnd
  const bBeforeAEnd = aEnd === null || b.t_valid < aEnd
  return aBeforeBEnd && bBeforeAEnd
}

/**
 * 让一条主张失效（被取代）。tInvalid 是「事实停止成立」的时刻，默认取新主张的 t_valid，
 * 这样两条在时间轴上首尾相接、不留重叠。
 */
export function retireClaim(db, { id, tInvalid = null, supersededBy = null, tExpired = null }) {
  const claim = get(db, 'SELECT * FROM claims WHERE id = ?', [id])
  if (!claim) throw new Error(`主张不存在：${id}`)
  const invalid = tInvalid ?? nowIso()
  run(db, 'UPDATE claims SET t_invalid = ?, t_expired = ?, superseded_by = ? WHERE id = ?', [
    invalid,
    tExpired ?? nowIso(),
    supersededBy ?? claim.superseded_by ?? null,
    id,
  ])
  return get(db, 'SELECT * FROM claims WHERE id = ?', [id])
}

/** 写入一条新主张时，把同 (subject, predicate) 且 object 不同的现行主张自动失效。 */
export function supersedeConflicts(db, { claim, patchId = null }) {
  if (!claim.object) return []
  const rows = all(db, `SELECT c.* FROM claims c JOIN pages p ON p.id = c.page_id
    WHERE p.project_id = (SELECT project_id FROM pages WHERE id = ?)
      AND c.subject = ? AND c.predicate = ? AND c.object != ? AND c.object != ''
      AND c.t_invalid IS NULL AND c.t_expired IS NULL AND c.id != ?`,
  [claim.page_id, claim.subject, claim.predicate, claim.object, claim.id])
  const retired = []
  for (const row of rows) {
    retired.push(retireClaim(db, { id: row.id, tInvalid: claim.t_valid, supersededBy: claim.id }))
  }
  void patchId
  return retired
}

/** 删除一批主张（仅供撤销使用：撤销要真正回滚，而不是留一堆假历史）。 */
export function deleteClaimsOfPatch(db, patchId) {
  if (!patchId) throw new Error('删主张必须给 patchId：不允许无差别删除')
  const rows = all(db, 'SELECT id FROM claims WHERE patch_id = ?', [patchId])
  for (const row of rows) run(db, 'DELETE FROM claims WHERE id = ?', [row.id])
  return rows.length
}

export function restoreClaimsRetiredBy(db, patchId) {
  if (!patchId) throw new Error('恢复主张必须给 patchId：不允许无差别恢复')
  const rows = all(db, 'SELECT id FROM claims WHERE superseded_by IN (SELECT id FROM claims WHERE patch_id = ?)', [patchId])
  for (const row of rows) run(db, 'UPDATE claims SET t_invalid = NULL, t_expired = NULL, superseded_by = NULL WHERE id = ?', [row.id])
  return rows.length
}

export function claimCounts(db, { projectId = null } = {}) {
  const params = projectId ? [projectId] : []
  const where = projectId ? 'WHERE p.project_id = ?' : ''
  const row = get(db, `SELECT COUNT(*) AS n,
      SUM(CASE WHEN c.t_invalid IS NULL AND c.t_expired IS NULL THEN 1 ELSE 0 END) AS live
    FROM claims c JOIN pages p ON p.id = c.page_id ${where}`, params)
  return { total: Number(row?.n ?? 0), live: Number(row?.live ?? 0) }
}
