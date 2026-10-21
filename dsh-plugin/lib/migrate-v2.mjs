// lib/migrate-v2.mjs — v1 → v2 数据迁移：L3「记录」变「页面」。
//
// 只做数据搬迁，不建表（DDL 在 schema.mjs 的 SCHEMA_V2_SQL 里，靠 IF NOT EXISTS 幂等）。
// 幂等性由两重保证：
//   1. migrations 表里没有 id=2 的行时才会跑；
//   2. 每条搬迁都带 `WHERE NOT EXISTS (SELECT 1 FROM pages …)`，重复跑不会造重复页。
// v1 的 abstractions 表**不删**，只读保留，方便回退。
import { run } from './db.mjs'
import { nowIso, ulid } from './ids.mjs'
import { slugify, uniqueSlug } from './slug.mjs'

/** v1 的 abstractions.kind → v2 的 pages.kind。 */
export const KIND_MAP = Object.freeze({
  decision: 'decision',
  principle: 'concept',
  experience: 'concept',
  preference: 'concept',
  hypothesis: 'concept',
  task: 'concept',
})

const KIND_DIR = Object.freeze({
  concept: 'concepts',
  decision: 'decisions',
  entity: 'entities',
  answer: 'answers',
  timeline: '',
  index: '',
})

/** 项目名：取该项目任一 source 的 meta.cwd 末段，否则用 project_id。 */
export function projectNameOf(db, projectId) {
  const list = db.prepare('SELECT meta FROM sources WHERE project_id = ? LIMIT 5').all(projectId)
  for (const row of list) {
    let meta = null
    try { meta = JSON.parse(row.meta || '{}') } catch { meta = null }
    const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : ''
    if (!cwd) continue
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
    if (base) return base
  }
  return projectId || 'manual'
}

export function pageRelPath({ project, projectId, kind, slug }) {
  const dir = KIND_DIR[kind] ?? 'concepts'
  const name = dir === '' ? `${slug}.md` : `${dir}/${slug}.md`
  return `Library/${project}/Projects/${projectId}/${name}`
}

/** 把一个 abstraction 渲染成页面正文（尽量保住 v1 的内容与引用）。 */
function bodyOf(row, citations) {
  const lines = [String(row.content || '').trim(), '']
  if (citations.length > 0) {
    lines.push('## 出处', '')
    for (const c of citations) {
      const quote = String(c.quote || '').replace(/\s+/gu, ' ').slice(0, 240)
      lines.push(`- \`${c.locator || c.to_id}\`：${quote}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * 执行迁移。返回 { pages, skipped }。
 * 已存在的（project_id, kind, slug）跳过——那是迁移后新建/改过的页。
 */
export function migrateV2(db) {
  const rows = db.prepare("SELECT * FROM abstractions WHERE status != 'discarded' ORDER BY created_at").all()
  let pages = 0
  let skipped = 0
  const now = nowIso()
  for (const row of rows) {
    const kind = KIND_MAP[row.kind] || 'concept'
    const project = projectNameOf(db, row.project_id)
    const base = slugify(row.title)
    const existing = db.prepare('SELECT id, slug FROM pages WHERE project_id = ? AND kind = ?').all(row.project_id, kind)
    if (existing.some((p) => p.slug === base)) { skipped += 1; continue }
    const taken = new Set(existing.map((p) => p.slug))
    const slug = uniqueSlug(base, taken)
    const path = pageRelPath({ project, projectId: row.project_id, kind, slug })
    const citations = db.prepare("SELECT * FROM citations WHERE from_layer = 'L3' AND from_id = ?").all(row.id)
    const body = bodyOf(row, citations)
    const id = ulid()
    db.prepare(`INSERT INTO pages
      (id, project_id, kind, slug, title, path, status, revision, summary, tags, body, content_sha256, ingested_at, compiled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, row.project_id, kind, slug, row.title, path,
      row.status === 'approved' ? 'approved' : 'candidate',
      1,
      String(row.content || '').replace(/\s+/gu, ' ').slice(0, 140),
      '[]', body, '', row.created_at || now, now,
    )
    // 证据链接：abstraction 引用的 L1 → 记录成 evidence 链接（L1 不是页面，只进 citations）
    for (const c of citations) {
      db.prepare(`INSERT OR IGNORE INTO citations (id, from_layer, from_id, to_layer, to_id, quote, span_start, span_end, created_at)
        VALUES (?, 'L3', ?, 'L1', ?, ?, ?, ?, ?)`)
        .run(ulid(), id, c.to_id, c.quote, c.span_start ?? null, c.span_end ?? null, now)
    }
    pages += 1
  }
  // v1 的 edges 里指向旧 L3 id 的边无法映射成页 id，记录一条 job 结果备查即可
  run(db, "INSERT INTO jobs (id, kind, status, payload, result, created_at, finished_at) VALUES (?, 'migrate-v2', 'done', ?, ?, ?, ?)",
    [ulid(), JSON.stringify({ abstractions: rows.length }), JSON.stringify({ pages, skipped }), now, now])
  return { pages, skipped }
}
