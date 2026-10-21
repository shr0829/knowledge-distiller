// lib/lint.mjs — M8：六项体检（docs/DSH_WIKI_SPEC.md §5.3）。
//
// lint 只读：产出 lint_findings 与建议动作，修复仍要人审（可以一键生成候选补丁，但不自动应用）。
import { all, get, run } from './db.mjs'
import { nowIso, ulid } from './ids.mjs'
import { findContradictions } from './claims.mjs'
import { parseLinks } from './pages.mjs'
import { slugify } from './slug.mjs'

export const KINDS = Object.freeze(['contradiction', 'stale', 'orphan', 'missing-page', 'missing-link', 'broken-quote', 'gap'])
export const DEFAULT_STALE_DAYS = 180

function finding(kind, { pageId = null, claimId = null, detail, suggestion = '', severity = 'warn' }) {
  return { kind, pageId, claimId, detail, suggestion, severity }
}

/** 矛盾：同 (subject, predicate) 有效区间重叠而 object 不同。 */
export function lintContradictions(db, { projectId = null } = {}) {
  return findContradictions(db, { projectId }).map((pair) => finding('contradiction', {
    pageId: pair.a.page_id,
    claimId: pair.a.id,
    detail: `「${pair.subject}」有两种说法：「${pair.a.object}」与「${pair.b.object}」`,
    suggestion: '确认哪条成立：保留一条、另一条标失效（撤销可回滚）',
    severity: 'error',
  }))
}

/** 过时：现行 claim 的事实时间早于 N 天，且项目近期有更新的来源。 */
export function lintStale(db, { projectId = null, staleAfterDays = DEFAULT_STALE_DAYS, now = Date.now() } = {}) {
  const cutoff = new Date(now - staleAfterDays * 86400000).toISOString()
  const params = [cutoff]
  let where = ''
  if (projectId) { where = 'AND p.project_id = ?'; params.push(projectId) }
  const rows = all(db, `SELECT c.*, p.project_id AS projectId, p.title AS pageTitle
    FROM claims c JOIN pages p ON p.id = c.page_id
    WHERE c.t_invalid IS NULL AND c.t_expired IS NULL AND c.t_valid < ? AND p.deleted_at IS NULL ${where}`, params)
  const out = []
  for (const row of rows) {
    const fresh = get(db, `SELECT COUNT(*) AS n FROM sources s
      WHERE s.project_id = ? AND s.created_at > ? AND s.deleted_at IS NULL`, [row.projectId, row.t_valid])
    if (Number(fresh?.n ?? 0) === 0) continue
    out.push(finding('stale', {
      pageId: row.page_id,
      claimId: row.id,
      detail: `「${row.statement}」的事实时间早于 ${staleAfterDays} 天，而该项目之后又有新来源`,
      suggestion: '复查来源是否有新版本；确认后更新或标失效',
    }))
  }
  return out
}

/** 孤页：没有任何 links 进/出的页面（index/timeline 类不算）。 */
export function lintOrphans(db) {
  const rows = all(db, `SELECT p.* FROM pages p
    WHERE p.deleted_at IS NULL AND p.kind NOT IN ('index','timeline')
      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page = p.id OR l.to_page = p.id)`)
  return rows.map((row) => finding('orphan', {
    pageId: row.id,
    detail: `页面「${row.title}」没有任何链接进出`,
    suggestion: '补 related 链接，或并入相邻页面',
    severity: 'info',
  }))
}

/** 缺页：正文里的 [[目标]] 没有对应页面（wanted page）。 */
export function lintMissingPages(db) {
  const out = []
  for (const page of all(db, 'SELECT id, project_id AS projectId, title, body FROM pages WHERE deleted_at IS NULL')) {
    for (const title of parseLinks(page.body)) {
      const target = get(db, `SELECT id FROM pages WHERE project_id = ? AND (title = ? OR slug = ?) AND deleted_at IS NULL`,
        [page.projectId, title, slugify(title)])
      if (target) continue
      out.push(finding('missing-page', {
        pageId: page.id,
        detail: `「${page.title}」引用了不存在的页面「${title}」`,
        suggestion: '新建这个页面（wanted page），或删掉链接',
        severity: 'info',
      }))
    }
  }
  return out
}

/** 中文 bigram 集合：比整段匹配更能说明「两页在说同一件事」。 */
function bigrams(text) {
  const out = new Set()
  const runs = String(text || '').match(/[\u4e00-\u9fa5]{2,}/gu) ?? []
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

/** 缺链：两页共现同一实体/关键词多次却没有 wikilink。 */
export function lintMissingLinks(db, { minShared = 3, projectId = null } = {}) {
  const params = []
  let where = ''
  if (projectId) { where = 'AND p.project_id = ?'; params.push(projectId) }
  const out = []
  for (const page of all(db, `SELECT p.* FROM pages p WHERE p.deleted_at IS NULL ${where}`, params)) {
    const tokens = bigrams(`${page.title} ${page.summary} ${page.body}`.slice(0, 4000))
    if (tokens.size === 0) continue
    const others = all(db, `SELECT id, title, summary FROM pages WHERE deleted_at IS NULL AND id <> ? AND project_id = ?`, [page.id, page.project_id])
    for (const other of others) {
      const otherTokens = bigrams(`${other.title} ${other.summary}`)
      let shared = 0
      for (const token of tokens) if (otherTokens.has(token)) shared += 1
      if (shared < minShared) continue
      const linked = get(db, 'SELECT 1 AS hit FROM links WHERE from_page = ? AND to_page = ?', [page.id, other.id])
      if (linked) continue
      out.push(finding('missing-link', {
        pageId: page.id,
        detail: `「${page.title}」与「${other.title}」共享 ${shared} 个词，却没有链接`,
        suggestion: `在正文里加 [[${other.title}]]`,
        severity: 'info',
      }))
    }
  }
  return out
}

/** 坏引用：证据锚点的 quote 在来源里找不到。 */
export function lintBrokenQuotes(db) {
  const rows = all(db, `SELECT c.id, c.from_id AS pageId, c.to_id AS sourceId, c.quote, s.content, p.title
    FROM citations c JOIN pages p ON p.id = c.from_id LEFT JOIN sources s ON s.id = c.to_id`)
  const out = []
  for (const row of rows) {
    if (row.content && String(row.content).includes(row.quote)) continue
    out.push(finding('broken-quote', {
      pageId: row.pageId,
      detail: `「${row.title}」的引用「${String(row.quote).slice(0, 40)}」在来源里找不到`,
      suggestion: '标为待补引用，或删掉该段',
      severity: 'error',
    }))
  }
  return out
}

/** 缺口：某 kind 一页都没有，但待编译队列里已经有这类内容。 */
export function lintGaps(db) {
  const kinds = ['decision', 'concept', 'entity', 'answer']
  const out = []
  for (const kind of kinds) {
    const pages = get(db, 'SELECT COUNT(*) AS n FROM pages WHERE kind = ? AND deleted_at IS NULL', [kind])
    if (Number(pages?.n ?? 0) > 0) continue
    const pending = get(db, `SELECT COUNT(*) AS n FROM patches WHERE status = 'candidate' AND kind = ?`, [kind])
    if (Number(pending?.n ?? 0) === 0) continue
    out.push(finding('gap', {
      detail: `还没有任何 ${kind} 页面，但队列里有 ${pending.n} 个 ${kind} 补丁`,
      suggestion: '先接受其中一个补丁，把这个类型立起来',
      severity: 'info',
    }))
  }
  return out
}

/** 跑一轮体检：写 lint_findings（同一 run_id 一批），返回汇总。 */
export function runLint(db, { projectId = null, staleAfterDays = DEFAULT_STALE_DAYS, now = Date.now(), keepRun = true } = {}) {
  const runId = ulid(now)
  const findings = [
    ...lintContradictions(db, { projectId }),
    ...lintStale(db, { projectId, staleAfterDays, now }),
    ...lintOrphans(db),
    ...lintMissingPages(db),
    ...lintMissingLinks(db, { projectId }),
    ...lintBrokenQuotes(db),
    ...lintGaps(db),
  ]
  if (keepRun) {
    for (const item of findings) {
      run(db, `INSERT INTO lint_findings (id, run_id, kind, page_id, claim_id, detail, suggestion, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ulid(now), runId, item.kind, item.pageId, item.claimId, item.detail, item.suggestion, item.severity, nowIso(now)])
    }
  }
  const byKind = {}
  for (const kind of KINDS) byKind[kind] = findings.filter((item) => item.kind === kind).length
  return {
    runId,
    total: findings.length,
    byKind,
    findings: findings.map((item) => ({ ...item, id: ulid(now) })),
    checkedAt: nowIso(now),
  }
}

export function findings(db, { runId = null, kind = null, limit = 100 } = {}) {
  const params = []
  let where = 'WHERE 1 = 1'
  if (runId) { where += ' AND run_id = ?'; params.push(runId) }
  if (kind) { where += ' AND kind = ?'; params.push(kind) }
  params.push(limit)
  return all(db, `SELECT * FROM lint_findings ${where} ORDER BY created_at DESC LIMIT ?`, params)
}

export function latestRun(db) {
  const row = get(db, 'SELECT run_id, MAX(created_at) AS at FROM lint_findings')
  if (!row?.run_id) return null
  return { runId: row.run_id, at: row.at }
}
