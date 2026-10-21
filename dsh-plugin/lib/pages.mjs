// lib/pages.mjs — v2 的 L3「页面」层（docs/DSH_WIKI_SPEC.md §3）。
//
// 职责边界：
//   · 页面元数据与正文快照 → pages 表；Markdown 文件才是真相，pages.body 是最后一次写入的快照；
//   · 页间链接 → links 表，从正文里的 [[wikilink]] 解析，可整表重建；
//   · 索引 → <项目目录>/index.md，每次页面落页后重算（不是每次编译）；
//   · 写入 vault 复用 v1 的不变量：review_id 必填、revision 只增、旧内容进 notes 表、原子写、冲突停写。
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { all, get, run, tx } from './db.mjs'
import { nowIso, sha256Hex, ulid } from './ids.mjs'
import { bytesOf } from './text.mjs'
import { slugify, uniqueSlug } from './slug.mjs'
import { assertInside, compareText, renderNote } from './vault.mjs'
import { indexDoc, unindexDoc } from './indexer.mjs'

/** 页面类型 → vault 子目录（timeline/index 直接放项目根）。 */
export const KIND_DIR = Object.freeze({
  concept: 'concepts',
  decision: 'decisions',
  entity: 'entities',
  answer: 'answers',
  timeline: '',
  index: '',
})

export const PAGE_STATUSES = Object.freeze(['candidate', 'approved', 'discarded', 'deferred', 'stale'])

export function dirOf(kind) {
  return KIND_DIR[kind] ?? 'concepts'
}

/** 页面在 vault 里的相对路径。 */
export function relPathOf({ projectName, projectId, kind, slug }) {
  const dir = dirOf(kind)
  const file = dir === '' ? `${slug}.md` : `${dir}/${slug}.md`
  return `Library/${projectName}/Projects/${projectId}/${file}`
}

/** 项目名：沿用 v1 口径（sources.meta.cwd 末段），无则用 project_id。 */
export function projectNameOf(db, projectId) {
  const rows = all(db, 'SELECT meta FROM sources WHERE project_id = ? LIMIT 5', [projectId])
  for (const row of rows) {
    let meta = null
    try { meta = JSON.parse(row.meta || '{}') } catch { meta = null }
    const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : ''
    if (!cwd) continue
    const base = cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).pop()
    if (base) return base
  }
  return projectId || 'manual'
}

// ------------------------------------------------------------------ 读
export function getPage(db, id) {
  return get(db, 'SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL', [id]) ?? null
}

export function findPage(db, { projectId, slug, kind = null }) {
  if (kind) return get(db, 'SELECT * FROM pages WHERE project_id = ? AND kind = ? AND slug = ? AND deleted_at IS NULL', [projectId, kind, slug]) ?? null
  return get(db, 'SELECT * FROM pages WHERE project_id = ? AND slug = ? AND deleted_at IS NULL', [projectId, slug]) ?? null
}

export function pageByPath(db, relPath) {
  return get(db, 'SELECT * FROM pages WHERE path = ? AND deleted_at IS NULL', [relPath]) ?? null
}

export function listPages(db, { projectId = null, kind = null, status = null, q = '', limit = 50, offset = 0 } = {}) {
  const where = ['deleted_at IS NULL']
  const params = []
  if (projectId) { where.push('project_id = ?'); params.push(projectId) }
  if (kind) { where.push('kind = ?'); params.push(kind) }
  if (status) { where.push('status = ?'); params.push(status) }
  if (q) { where.push('(title LIKE ? OR summary LIKE ? OR body LIKE ?)'); const like = `%${q}%`; params.push(like, like, like) }
  const clause = where.join(' AND ')
  const total = Number(get(db, `SELECT COUNT(*) AS n FROM pages WHERE ${clause}`, params)?.n ?? 0)
  const rows = all(db, `SELECT id, project_id AS projectId, kind, slug, title, path, status, revision, summary, tags,
      content_sha256 AS contentSha, ingested_at AS ingestedAt, compiled_at AS compiledAt, linted_at AS lintedAt
    FROM pages WHERE ${clause} ORDER BY compiled_at DESC, ingested_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset])
  return { items: rows.map(decorate), total }
}

function decorate(row) {
  if (!row) return null
  let tags = []
  try { tags = JSON.parse(row.tags || '[]') } catch { tags = [] }
  return { ...row, tags: Array.isArray(tags) ? tags : [] }
}

export function countPages(db, { projectId = null } = {}) {
  const sql = projectId
    ? 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND project_id = ?'
    : 'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL'
  return Number(get(db, sql, projectId ? [projectId] : [])?.n ?? 0)
}

/** 页面的完整视图：正文、主张、证据、反向链接、同项目其它页（供 UI 侧栏）。 */
export function pageDetail(db, id) {
  const page = getPage(db, id)
  if (!page) return null
  const claims = all(db, 'SELECT * FROM claims WHERE page_id = ? ORDER BY t_created DESC', [id])
  const citations = all(db, `SELECT c.*, s.locator AS sourceLocator, s.content AS sourceContent
    FROM citations c LEFT JOIN sources s ON s.id = c.to_id WHERE c.from_layer = 'L3' AND c.from_id = ?`, [id])
  const backlinks = all(db, `SELECT p.id, p.title, p.path, l.kind FROM links l JOIN pages p ON p.id = l.from_page
    WHERE l.to_page = ? AND p.deleted_at IS NULL`, [id])
  const outbound = all(db, `SELECT p.id, p.title, p.path, l.kind FROM links l JOIN pages p ON p.id = l.to_page
    WHERE l.from_page = ? AND p.deleted_at IS NULL`, [id])
  const feedback = all(db, 'SELECT verdict, COUNT(*) AS n FROM page_feedback WHERE page_id = ? GROUP BY verdict', [id])
  return {
    page: decorate(page),
    claims: claims.map((c) => ({ ...c, sourceIds: parseIds(c.source_ids) })),
    citations: citations.map((c) => ({
      id: c.id, sourceId: c.to_id, locator: c.sourceLocator ?? c.to_id, quote: c.quote,
      spanStart: c.span_start, spanEnd: c.span_end,
    })),
    backlinks,
    outbound,
    feedback: Object.fromEntries(feedback.map((row) => [row.verdict, Number(row.n)])),
  }
}

function parseIds(raw) {
  try {
    const value = JSON.parse(raw || '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

// ------------------------------------------------------------------ 写元数据（不落文件）
/**
 * 新建页面。revision=0 表示「还没写进 vault」；真正落盘时会涨到 1。
 * slug 在 (project_id, kind) 内唯一，冲突自动加序号。
 */
export function createPage(db, { projectId, kind = 'concept', title, summary = '', tags = [], body = '', status = 'candidate', patchId = null, now = nowIso() }) {
  const name = String(title || '').trim() || '未命名页面'
  const taken = new Set(all(db, 'SELECT slug FROM pages WHERE project_id = ? AND kind = ?', [projectId, kind]).map((row) => row.slug))
  const slug = uniqueSlug(slugify(name), taken)
  const relPath = relPathOf({ projectName: projectNameOf(db, projectId), projectId, kind, slug })
  const id = ulid()
  run(db, `INSERT INTO pages (id, project_id, kind, slug, title, path, status, revision, summary, tags, body, content_sha256, ingested_at, last_patch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '', ?, ?)`,
  [id, projectId, kind, slug, name, relPath, status, String(summary || '').slice(0, 200), JSON.stringify(Array.isArray(tags) ? tags : []), String(body || ''), now, patchId])
  indexPage(db, getPage(db, id))
  return getPage(db, id)
}

/** 把页面写进 FTS（L3 层）。标题与摘要、正文都进，检索才有东西可命中。 */
export function indexPage(db, page) {
  if (!page) return
  indexDoc(db, { layer: 'L3', refId: page.id, title: page.title, body: `${page.summary ?? ''}\n${page.body ?? ''}` })
}

/** 更新元数据（正文由 applyPatch 统一处理，这里不碰 revision）。 */
export function updatePageMeta(db, id, { title = null, summary = null, tags = null, status = null }) {
  const page = getPage(db, id)
  if (!page) throw new Error(`页面不存在：${id}`)
  run(db, 'UPDATE pages SET title = ?, summary = ?, tags = ?, status = ? WHERE id = ?', [
    title ?? page.title,
    summary ?? page.summary,
    tags === null ? page.tags : JSON.stringify(tags),
    status ?? page.status,
    id,
  ])
  return getPage(db, id)
}

// ------------------------------------------------------------------ 渲染
/**
 * 渲染页面 Markdown。frontmatter 沿用 v1 的字段与顺序（便于 compareText 做幂等比较），
 * 正文是 pages.body，出处由 citations 生成。
 */
export function renderPageMarkdown(db, page, { revision = null, related = null, status = null } = {}) {
  const citations = all(db, `SELECT c.quote, s.locator FROM citations c LEFT JOIN sources s ON s.id = c.to_id
    WHERE c.from_layer = 'L3' AND c.from_id = ? ORDER BY c.created_at`, [page.id])
  const sourceIds = [...new Set(citations.map((row) => row.to_id ?? row.sourceId).filter(Boolean))]
  const links = related ?? all(db, 'SELECT p.title FROM links l JOIN pages p ON p.id = l.to_page WHERE l.from_page = ? AND l.kind = ? ORDER BY p.title', [page.id, 'related'])
  return renderNote({
    title: page.title,
    project: projectNameOf(db, page.project_id),
    projectId: page.project_id,
    kind: page.kind,
    status: status ?? page.status,
    revision: revision ?? Math.max(1, Number(page.revision) || 1),
    wikiId: page.id,
    sources: sourceIds.length > 0 ? sourceIds : parseIds(page.sources),
    related: links.map((row) => row.title),
    updated: nowIso(),
    body: page.body,
    citations: citations.map((row) => ({ locator: row.locator, quote: row.quote })),
  })
}

/** 正文里解析 [[wikilink]]（页面标题）。 */
export function parseLinks(body) {
  const found = new Set()
  const text = String(body || '')
  const pattern = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/gu
  let match = pattern.exec(text)
  while (match !== null) {
    const target = match[1].trim()
    if (target !== '') found.add(target)
    match = pattern.exec(text)
  }
  return [...found]
}

/**
 * 重建某个页面的出边（幂等）：把正文里能解析到同项目页面的 wikilink 写成 links.related；
 * 解析不到的目标留在正文里（lint 会报 missing-page）。
 */
export function syncLinks(db, pageId) {
  const page = getPage(db, pageId)
  if (!page) return { linked: 0, missing: [] }
  const missing = []
  const targets = []
  for (const title of parseLinks(page.body)) {
    const target = get(db, `SELECT id FROM pages WHERE project_id = ? AND (title = ? OR slug = ?) AND deleted_at IS NULL AND id != ?`,
      [page.project_id, title, slugify(title), pageId])
    if (!target) { missing.push(title); continue }
    targets.push(target.id)
  }
  run(db, 'DELETE FROM links WHERE from_page = ? AND kind = ?', [pageId, 'related'])
  const seen = new Set()
  for (const toId of targets) {
    if (seen.has(toId)) continue
    seen.add(toId)
    run(db, 'INSERT OR IGNORE INTO links (from_page, to_page, kind, weight) VALUES (?, ?, ?, 1)', [pageId, toId, 'related'])
  }
  return { linked: seen.size, missing }
}

export function deleteLinksOf(db, pageId) {
  run(db, 'DELETE FROM links WHERE from_page = ? OR to_page = ?', [pageId, pageId])
}

// ------------------------------------------------------------------ 索引
/** 项目目录下的 index.md：每页一行「[kind] 标题 — 摘要 — #标签 — r版本 — 日期」。 */
export function rebuildProjectIndex(db, { vaultPath, projectId, now = nowIso() }) {
  const projectName = projectNameOf(db, projectId)
  const dirRel = `Library/${projectName}/Projects/${projectId}`
  const dirAbs = assertInside(vaultPath, path.join(vaultPath, dirRel))
  mkdirSync(dirAbs, { recursive: true })
  const rows = all(db, `SELECT title, kind, summary, tags, revision, compiled_at, path FROM pages
    WHERE project_id = ? AND deleted_at IS NULL AND status != 'discarded'
    ORDER BY kind, title`, [projectId])
  const lines = [`# ${projectName} · 知识库索引`, '', `> 由 dsh-llm-wiki 生成，不要手改（改页面内容即可，索引会重算）。共 ${rows.length} 页。`, '']
  const byKind = new Map()
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, [])
    byKind.get(row.kind).push(row)
  }
  const label = { concept: '概念', decision: '决策', entity: '实体', answer: '问答', timeline: '时间线', index: '索引' }
  for (const [kind, list] of byKind) {
    lines.push(`## ${label[kind] ?? kind}`, '')
    for (const row of list) {
      const tags = parseIds(row.tags).map((tag) => `#${tag}`).join(' ')
      const when = String(row.compiled_at ?? '').slice(0, 10)
      lines.push(`- [${kind}] [${row.title}](${encodeURI(row.path.split('/').pop())}) — ${row.summary || '（无摘要）'}${tags ? ' — ' + tags : ''} — r${row.revision} — ${when}`)
    }
    lines.push('')
  }
  const text = lines.join('\n')
  const file = assertInside(vaultPath, path.join(dirAbs, 'index.md'))
  const tmp = path.join(dirAbs, `.index.${process.pid}.${ulid()}.tmp`)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
  return { ok: true, path: `${dirRel}/index.md`, pages: rows.length, bytes: bytesOf(text) }
}

/** 全库索引：项目 → 页面数。 */
export function rebuildLibraryIndex(db, { vaultPath, now = nowIso() }) {
  const rows = all(db, `SELECT project_id AS projectId, COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND status != 'discarded' GROUP BY project_id ORDER BY n DESC`)
  const lines = ['# LLM Wiki 知识库', '', '> 由 dsh-llm-wiki 生成。每个项目一个子目录，项目内 index.md 列页面。', '']
  for (const row of rows) {
    const name = projectNameOf(db, row.projectId)
    lines.push(`- [[${name}]] — ${Number(row.n)} 页 — \`${row.projectId}\``)
  }
  lines.push('')
  const dirAbs = assertInside(vaultPath, path.join(vaultPath, 'Library'))
  mkdirSync(dirAbs, { recursive: true })
  const file = assertInside(vaultPath, path.join(dirAbs, '索引.md'))
  const text = lines.join('\n')
  const tmp = path.join(dirAbs, `.index.${process.pid}.${ulid()}.tmp`)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
  return { ok: true, path: 'Library/索引.md', projects: rows.length }
}

// ------------------------------------------------------------------ 写文件（唯一写入路径）
/**
 * 把页面写进 vault。必须带 reviewId（审核闸门）；幂等：内容没变则不涨 revision。
 * 冲突：磁盘内容与 pages.content_sha256 不一致 ⇒ 停写并记 writes.error，等人工 resolve。
 */
export function writePageFile(db, { pageId, vaultPath, reviewId, now = Date.now() }) {
  if (!reviewId) throw new Error('写入必须带 reviewId：没有人工审核就没有写入')
  const page = getPage(db, pageId)
  if (!page) throw new Error(`页面不存在：${pageId}`)
  const revision = Math.max(1, Number(page.revision) + 1)
  // 写入成功即视为通过审核：渲染时就用「写完之后的状态」，否则同一个页面连写两次会因
  // status 从 candidate 变成 approved 而永远「看起来变了」。
  const nextStatus = page.status === 'candidate' ? 'approved' : page.status
  const text = renderPageMarkdown(db, page, { revision, status: nextStatus })
  const abs = assertInside(vaultPath, path.join(vaultPath, page.path))
  const dir = path.dirname(abs)
  mkdirSync(dir, { recursive: true })
  const sha = sha256Hex(text)

  let existing = null
  try { existing = readFileSync(abs, 'utf8') } catch { existing = null }

  // 幂等：抹掉 updated/revision 后内容一致 ⇒ 不写、不涨版本
  if (existing !== null && page.content_sha256 && compareText(existing) === compareText(text) && page.revision > 0) {
    run(db, `INSERT INTO writes (id, review_id, path, bytes, revision, error, created_at) VALUES (?, ?, ?, 0, ?, NULL, ?)`,
      [ulid(), reviewId, page.path, page.revision, nowIso(now)])
    return { ok: true, changed: false, path: page.path, revision: Number(page.revision), bytes: bytesOf(existing), writeId: null }
  }
  // 冲突：文件被外部改过（或我们的快照丢了）
  if (existing !== null && page.content_sha256 && sha256Hex(existing) !== page.content_sha256) {
    const message = 'conflict: 文件在 vault 外被改动过，已停止写入（用 /api-llm-wiki/resolve 接受人的改动）'
    run(db, `INSERT INTO writes (id, review_id, path, bytes, revision, error, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [ulid(), reviewId, page.path, page.revision, message, nowIso(now)])
    return { ok: false, conflict: true, path: page.path, error: message }
  }

  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${ulid()}.tmp`)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, abs)

  const writeId = ulid()
  tx(db, () => {
    const previous = get(db, 'SELECT * FROM notes WHERE path = ? ORDER BY revision DESC LIMIT 1', [page.path])
    run(db, `INSERT INTO notes (id, path, revision, content, content_sha256, created_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [ulid(), page.path, revision, text, sha, nowIso(now)])
    if (previous) run(db, 'UPDATE notes SET superseded_by = ? WHERE id = ?', [writeId, previous.id])
    run(db, 'UPDATE pages SET revision = ?, content_sha256 = ?, status = ?, compiled_at = ? WHERE id = ?',
      [revision, sha, nextStatus, nowIso(now), page.id])
    run(db, 'INSERT INTO writes (id, review_id, path, bytes, revision, error, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      [writeId, reviewId, page.path, bytesOf(text), revision, nowIso(now)])
    indexPage(db, getPage(db, page.id))
  })
  return { ok: true, changed: true, path: page.path, revision, bytes: bytesOf(text), writeId }
}

/** 把磁盘现状登记成新版本（接受人的改动），文件一个字节都不动。 */
export function rebaselinePage(db, { pageId, vaultPath, now = nowIso() }) {
  const page = getPage(db, pageId)
  if (!page) throw new Error(`页面不存在：${pageId}`)
  const abs = assertInside(vaultPath, path.join(vaultPath, page.path))
  if (!existsSync(abs)) {
    run(db, 'UPDATE pages SET content_sha256 = ? WHERE id = ?', ['', pageId])
    return { ok: true, missing: true, path: page.path }
  }
  const text = readFileSync(abs, 'utf8')
  const revision = Math.max(1, Number(page.revision) + 1)
  const sha = sha256Hex(text)
  tx(db, () => {
    run(db, 'INSERT INTO notes (id, path, revision, content, content_sha256, created_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      [ulid(), page.path, revision, text, sha, now])
    run(db, 'UPDATE pages SET revision = ?, content_sha256 = ?, body = ? WHERE id = ?',
      [revision, sha, stripFrontmatter(text), pageId])
    indexPage(db, getPage(db, pageId))
  })
  return { ok: true, changed: true, path: page.path, revision, bytes: bytesOf(text) }
}

/** 去掉 frontmatter 与标题行，取出正文（用于把外部改动收回到 pages.body）。 */
export function stripFrontmatter(text) {
  const source = String(text || '')
  const parts = source.split(/^---$/mu)
  const body = parts.length >= 3 ? parts.slice(2).join('---') : source
  return body.replace(/^\s*#\s+.*$/mu, '').trim()
}

export function pageStats(db, { projectId = null } = {}) {
  const params = projectId ? [projectId] : []
  const where = projectId ? 'WHERE deleted_at IS NULL AND project_id = ?' : 'WHERE deleted_at IS NULL'
  const row = get(db, `SELECT COUNT(*) AS n,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
      SUM(CASE WHEN revision = 0 THEN 1 ELSE 0 END) AS unwritten
    FROM pages ${where}`, params)
  return {
    total: Number(row?.n ?? 0),
    approved: Number(row?.approved ?? 0),
    candidate: Number(row?.candidate ?? 0),
    unwritten: Number(row?.unwritten ?? 0),
  }
}
