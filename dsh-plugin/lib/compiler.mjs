// lib/compiler.mjs — M6：把一批 L1 窗口编译成「页面补丁」（docs/DSH_WIKI_SPEC.md §5.1）。
//
// 规则模式（当前唯一可用模式）做四件事：
//   1. 选页：先用 FTS 在已有页面里找 ≤6 个更新候选，找不到才新建；
//   2. 出 ops：add（新段落）/ claim（句子级主张）/ link（wikilink）；
//   3. 校验 quote：每个引用必须是 source 正文的逐字片段，坏了就整条 op 降级；
//   4. 幂等：指纹相同、或正文 shingle 相似度 > 0.9 的补丁直接跳过。
// 模型可用时只需替换 buildOps()，其余流程不动（降级不是另写一条路，而是默认路径）。
import { all, get, run } from './db.mjs'
import { nowIso, sha256Hex, shortHash, ulid } from './ids.mjs'
import { bytesOf, fingerprintOf, ftsQuery, normalizeQuery, summarizeBytes } from './text.mjs'
import { classify, rawExcerpt, ruleTitle } from './pipeline.mjs'
import { analyzeStatement } from './claims.mjs'
import { slugify } from './slug.mjs'

export const MODE_RULES = 'rules'
export const MAX_WINDOW_BYTES = 8 * 1024
export const MAX_OPS_BYTES = 2 * 1024
export const MAX_PAGES = 6
export const SHINGLE = 12
export const DUP_RATIO = 0.9

/**
 * 待编译的 L1：还没被任何一个补丁引用过。
 * 「引用过」用 patches.base_sources 判定（补丁被丢弃也算处理过，不会无限重出同一份候选）。
 */
export function pendingSources(db, { projectId = null, limit = 500 } = {}) {
  const params = []
  let where = "s.kind IN ('dsh-turn','manual') AND COALESCE(json_extract(s.meta, '$.role'), '') != 'summary'"
  if (projectId) { where += ' AND s.project_id = ?'; params.push(projectId) }
  params.push(limit)
  return all(db, `SELECT s.*, json_extract(s.meta, '$.role') AS meta_role FROM sources s
    WHERE ${where}
      AND NOT EXISTS (SELECT 1 FROM patches p WHERE p.base_sources LIKE '%"' || s.id || '"%')
    ORDER BY s.created_at, s.rowid
    LIMIT ?`, params)
}

export function pendingCount(db, { projectId = null } = {}) {
  return pendingSources(db, { projectId, limit: 100000 }).length
}

/** 按 (project, session, turn) 切窗口；没有 turn 的（手工补录、汇总）各自成窗。 */
export function groupWindows(rows) {
  const windows = new Map()
  const solo = []
  for (const row of rows) {
    if (row.turn === null || row.turn === undefined) { solo.push(row); continue }
    const key = `${row.project_id}|${row.session_id ?? ''}|${row.turn}`
    if (!windows.has(key)) windows.set(key, { key, projectId: row.project_id, sessionId: row.session_id, turn: row.turn, rows: [] })
    windows.get(key).rows.push(row)
  }
  const out = []
  for (const window of windows.values()) {
    let bytes = 0
    const kept = []
    for (const row of window.rows) {
      const size = bytesOf(row.content).length
      if (kept.length > 0 && bytes + size > MAX_WINDOW_BYTES) break
      kept.push(row)
      bytes += size
    }
    out.push({ ...window, rows: kept, bytes })
  }
  for (const row of solo) out.push({ key: `solo:${row.id}`, projectId: row.project_id, sessionId: row.session_id, turn: null, rows: [row], bytes: bytesOf(row.content).length })
  return out
}

/** 选页：用 FTS 在已有页面里找候选（index-first 的粗筛）。 */
export function selectPages(db, { projectId, text, limit = MAX_PAGES }) {
  const normalized = normalizeQuery(text)
  const query = normalized === '' ? '' : ftsQuery(normalized)
  if (query === '') return []
  return all(db, `SELECT p.*, bm25(fts) AS rank
    FROM fts JOIN pages p ON p.id = fts.ref_id
    WHERE fts MATCH ? AND fts.layer = 'L3' AND p.project_id = ? AND p.deleted_at IS NULL
    ORDER BY rank LIMIT ?`, [query, projectId, limit])
}

/** 12 字滑窗 shingle（用于「同一件事写三遍」去重）。 */
export function shingles(text) {
  const compact = String(text || '').replace(/\s+/gu, '')
  const set = new Set()
  for (let i = 0; i + SHINGLE <= compact.length; i += 1) set.add(compact.slice(i, i + SHINGLE))
  return set
}

export function similar(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

function quotesOf(window) {
  const quotes = []
  for (const row of window.rows) {
    if (row.meta_role === 'summary' || row.meta_role === 'tool') continue
    const excerpt = rawExcerpt(row.content, 160)
    if (excerpt !== '' && row.content.includes(excerpt)) quotes.push({ source_id: row.id, quote: excerpt })
  }
  return quotes.slice(0, 4)
}

/**
 * 规则模式的页面标题：取首个有内容的行，在第一个句读处切断、去掉尾部标点。
 * 目的是让标题像标题（「开发已完成」而不是「开发已完成。docs/DSH_PLUGIN_SP…」）。
 */
export function pageTitle(text, maxChars = 28) {
  const line = ruleTitle(text, 40)
  if (line === '') return ''
  const head = line.length > 12 ? line.split(/(?<=[。！？；.!?;])\s*/u)[0] : line
  const cleaned = head.replace(/[。．.！？!?；;：:，,、\s]+$/u, '').trim()
  const value = cleaned === '' ? line : cleaned
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}

/**
 * 编译前的降噪：宿主注入的运行时光标（Time sampled / Elapsed since / Browser time zone）
 * 与采集时写的汇总行（本轮汇总 · turn N - 记录数…）都不是知识内容，进正文只会污染页面。
 * 只作用于**编译草稿**，L1 原文一个字节都不改（可溯源要的是原文）。
 */
export function stripRuntimeNoise(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(Time sampled while preparing|Elapsed since the preceding|Browser time zone for this request:)/u.test(line))
    .filter((line) => !/^\s*本轮汇总 · turn \d+/u.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** 规则模式：从窗口生成 patch 草稿。 */
export function buildDraft(db, window, { now = Date.now() } = {}) {
  // 工具调用与汇总快照只当证据不当正文：纯工具/纯汇总窗口不编译（否则会产出「工具：pwsh」这类噪声页）
  const humans = window.rows.filter((row) => row.meta_role !== 'tool' && row.meta_role !== 'summary')
  if (humans.length === 0) return null
  const source = humans.length === window.rows.length ? window : { ...window, rows: humans }
  const text = stripRuntimeNoise(source.rows.map((row) => row.content).join('\n\n'))
  if (text === '') return null
  const kind = classify(text)
  const title = pageTitle(text) || '未命名页面'
  const summary = summarizeBytes(rawExcerpt(text, 200), 120).text
  const pages = selectPages(db, { projectId: window.projectId, text, limit: MAX_PAGES })
  const target = pages.find((page) => page.kind === kind) ?? pages[0] ?? null
  const quotes = quotesOf(source)

  if (quotes.length === 0) return null

  const body = rawExcerpt(text, 600)
  if (body === '') return null

  const ops = [
    {
      op: target ? 'update' : 'add',
      section: '概览',
      text: body,
      quotes,
    },
  ]

  // 句子级主张：每段首句一条，最多 3 条（规则模式只取「像结论」的句子）。
  // 中文长段常常只有换行没有句号，所以换行也算句界；太长的句子（>140 字）多半是整段搬运，不当作主张。
  const sentences = body
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((line) => line.replace(/^[-*+\d.、\s]+/u, '').trim())
    .filter((line) => line.length >= 8 && line.length <= 140)
  for (const sentence of sentences.slice(0, 3)) {
    const parts = analyzeStatement(sentence)
    if (!parts.subject) continue
    ops.push({ op: 'claim', text: sentence, subject: parts.subject, predicate: parts.predicate, object: parts.object, quotes: quotes.slice(0, 2) })
  }

  for (const link of parseWikiLinks(text).slice(0, 3)) {
    ops.push({ op: 'link', to: `[[${link}]]`, kind: 'related' })
  }

  const page = target
    ? { id: target.id, kind: target.kind, slug: target.slug, title: target.title, baseRevision: Number(target.revision) || 0 }
    : {
        id: null,
        kind,
        slug: slugify(title),
        title,
        summary,
        tags: [],
        baseRevision: 0,
      }
  if (!target) { page.summary = summary; page.tags = [] }

  const sourceIds = window.rows.map((row) => row.id)
  const fingerprint = fingerprintOf(
    `${window.projectId}|${page.id ?? 'new'}|${page.baseRevision}|${sourceIds.map((id) => sha256Hex(id)).sort().join(',')}`,
    sourceIds,
  )
  return { projectId: window.projectId, page, ops, sourceIds, fingerprint, mode: MODE_RULES, kind, title, summary }
}

export function parseWikiLinks(text) {
  const found = new Set()
  const pattern = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/gu
  let match = pattern.exec(String(text || ''))
  while (match !== null) {
    const target = match[1].trim()
    if (target !== '') found.add(target)
    match = pattern.exec(String(text || ''))
  }
  return [...found]
}

/** quote 校验：引用必须是来源正文的逐字片段，否则这条 op 变成「待补引用」。 */
export function validateQuotes(db, ops) {
  const checked = []
  const broken = []
  for (const op of ops) {
    const keptQuotes = []
    for (const quote of op.quotes ?? []) {
      const row = get(db, 'SELECT content FROM sources WHERE id = ?', [quote.source_id])
      if (row && String(row.content).includes(quote.quote)) keptQuotes.push(quote)
      else broken.push({ op: op.op, sourceId: quote.source_id, quote: quote.quote })
    }
    checked.push({ ...op, quotes: keptQuotes, valid: keptQuotes.length > 0 || op.op === 'link' })
  }
  return { ops: checked, broken }
}

/** 落一个补丁。返回 {inserted, reason, patch}。 */
export function createPatch(db, draft, { now = Date.now() } = {}) {
  if (draft === null) return { inserted: false, reason: 'no-content' }

  const existing = get(db, 'SELECT * FROM patches WHERE fingerprint = ?', [draft.fingerprint])
  if (existing) return { inserted: false, reason: 'fingerprint', patch: existing }

  // 正文相似度去重：同一页的同一段话不要写第二遍
  const candidateText = draft.ops.filter((op) => op.op === 'add' || op.op === 'update').map((op) => op.text).join('\n')
  const newShingles = shingles(candidateText)
  if (draft.page.id) {
    const page = get(db, 'SELECT body FROM pages WHERE id = ?', [draft.page.id])
    if (page && similar(newShingles, shingles(page.body)) > DUP_RATIO) return { inserted: false, reason: 'duplicate' }
  }

  const { ops, broken } = validateQuotes(db, draft.ops)
  let usable = ops.filter((op) => op.valid !== false)
  if (usable.length === 0) return { inserted: false, reason: 'broken-quote' }

  // 预算：输出的 ops 超过 2KB 就先砍到「只留一条 add」，再超限才放弃（规格里「减半重试一次」的等价做法）
  let payload = summarizeBytes(JSON.stringify(usable), MAX_OPS_BYTES)
  if (payload.truncated) {
    const firstAdd = usable.find((op) => op.op === 'add' || op.op === 'update')
    usable = firstAdd ? [firstAdd] : usable.slice(0, 1)
    payload = summarizeBytes(JSON.stringify(usable), MAX_OPS_BYTES)
    if (payload.truncated) return { inserted: false, reason: 'ops-too-large' }
  }

  const id = ulid(now)
  run(db, `INSERT INTO patches (id, page_id, project_id, base_revision, title, kind, ops, status, fingerprint, model, reason, base_sources, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)`,
  [id, draft.page.id, draft.projectId ?? draft.page.projectId ?? '', draft.page.baseRevision, draft.page.title, draft.page.kind,
    payload.text, draft.fingerprint, draft.mode, broken.length > 0 ? '有引用未能逐字命中，已降级' : '', JSON.stringify(draft.sourceIds), nowIso(now)])

  return { inserted: true, reason: 'created', patch: get(db, 'SELECT * FROM patches WHERE id = ?', [id]), broken }
}

export function patchOps(patch) {
  if (!patch) return []
  if (Array.isArray(patch.ops)) return patch.ops
  try { return JSON.parse(patch.ops) } catch { return [] }
}

/**
 * 跑一轮编译。`force` 用于面板上的「立即编译」，绕过「有会话活动就不跑」的判断。
 */
export function compileBatch(db, { config = {}, log = null, now = Date.now(), projectId = null, maxSources = 0, force = false } = {}) {
  const limit = maxSources > 0 ? maxSources : Math.max(1, Number(config.pipelineBatchSize) || 12)
  const rows = pendingSources(db, { projectId, limit })
  if (rows.length === 0) return { ran: false, reason: 'pending-empty', inserted: 0, skipped: 0, patches: [] }

  const windows = groupWindows(rows)
  const created = []
  let skipped = 0
  for (const window of windows) {
    const draft = buildDraft(db, window, { now })
    if (draft === null) { skipped += 1; continue }
    const result = createPatch(db, draft, { now })
    if (result.inserted) created.push(result.patch)
    else skipped += 1
  }

  const jobId = ulid(now)
  run(db, `INSERT INTO jobs (id, kind, status, payload, result, created_at, started_at, finished_at)
    VALUES (?, 'compile', 'done', '{}', ?, ?, ?, ?)`,
  [jobId, JSON.stringify({ windows: windows.length, inserted: created.length, skipped, mode: MODE_RULES }), nowIso(now), nowIso(now), nowIso(now)])
  run(db, 'INSERT INTO policies (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ['pipelineLastCompileAt', nowIso(now), nowIso(now)])
  log?.('info', `编译：${windows.length} 个窗口，新增 ${created.length} 个补丁，跳过 ${skipped}`)

  return { ran: true, reason: 'compiled', inserted: created.length, skipped, windows: windows.length, patches: created, mode: MODE_RULES, pending: pendingCount(db, { projectId }), force }
}

export function pipelineState(db, { projectId = null } = {}) {
  const row = get(db, "SELECT value FROM policies WHERE key = 'pipelineLastCompileAt'")
  return {
    pending: pendingCount(db, { projectId }),
    queue: Number(get(db, "SELECT COUNT(*) AS n FROM patches WHERE status = 'candidate'")?.n ?? 0),
    lastRunAt: row?.value ?? null,
    mode: MODE_RULES,
  }
}

export function listPatches(db, { status = 'candidate', projectId = null, limit = 50, offset = 0 } = {}) {
  const params = [status]
  let where = 'WHERE status = ?'
  if (projectId) { where += ' AND project_id = ?'; params.push(projectId) }
  params.push(limit, offset)
  return all(db, `SELECT * FROM patches ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params)
}

export function patchDetail(db, id) {
  const patch = get(db, 'SELECT * FROM patches WHERE id = ?', [id])
  if (!patch) return null
  const ops = patchOps(patch)
  const page = patch.page_id ? get(db, 'SELECT * FROM pages WHERE id = ?', [patch.page_id]) : null
  const sources = all(db, `SELECT id, locator, content FROM sources WHERE id IN (${ops.flatMap((op) => (op.quotes ?? []).map(() => '?')).join(',') || 'NULL'})`,
    ops.flatMap((op) => (op.quotes ?? []).map((quote) => quote.source_id)))
  const quotes = []
  for (const op of ops) {
    for (const quote of op.quotes ?? []) {
      const row = sources.find((item) => item.id === quote.source_id)
      quotes.push({ sourceId: quote.source_id, locator: row?.locator ?? null, quote: quote.quote, verified: row ? String(row.content).includes(quote.quote) : false })
    }
  }
  return {
    patch,
    ops,
    page: page ? { id: page.id, title: page.title, kind: page.kind, revision: Number(page.revision), body: page.body, path: page.path } : null,
    quotes,
    diff: diffText(page?.body ?? '', ops.filter((op) => op.text).map((op) => op.text).join('\n\n')),
  }
}

/** 极简行级 diff（给审核视图做并排对比，不追求 LCS 全局最优）。 */
export function diffText(before, after) {
  const left = String(before || '').split('\n')
  const right = String(after || '').split('\n')
  return { before: left, after: right, added: right.length, removed: 0, baseLines: left.length }
}

export { shortHash }
