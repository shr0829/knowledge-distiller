// lib/vault.mjs — Markdown 真相层（spec §11）。
//
// 只有这里能碰 vault 里的文件，路径白名单也在这一层做（spec §14：Host 代码在 DSH 主进程内
// 不受 workspace 沙箱约束，插件必须自己校验路径）。
//
// 四条不变量：
//   1. 只增：内容变了 revision+1，旧内容进 notes 表，**不另存 r2 文件**。
//   2. 外部改动过（磁盘 sha ≠ notes 里记的 sha）→ 拒绝写入并标 conflict，绝不覆盖人的手改。
//   3. 原子写：先写同目录临时文件再 rename。
//   4. 每次写入都挂 review_id（writes.review_id 外键），没有审核就没有写入。
import fs from 'node:fs'
import path from 'node:path'
import { all, get, run as runSql, tx } from './db.mjs'
import { ulid, nowIso, sha256Hex } from './ids.mjs'
import { bytesOf } from './text.mjs'
import { loadTarget, approvalOf } from './review.mjs'

const KIND_DIR = { concept: 'concepts', decision: 'decisions' }

/** vault 根目录（不存在就建；建不出来抛错由上层降级）。 */
export function ensureVault(vaultPath) {
  const root = path.resolve(String(vaultPath || ''))
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
  return root
}

/** 文件名片段：保留中英文数字，其余折成 '-'。 */
export function safeSegment(input, fallback = 'untitled', maxChars = 80) {
  const raw = String(input ?? '').trim()
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, maxChars)
  return cleaned === '' ? fallback : cleaned
}

/** 项目名：优先用会话 cwd 的末段，其次 project_id。 */
export function projectNameOf(db, projectId) {
  const row = get(
    db,
    `SELECT meta FROM sources WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  )
  let cwd = ''
  if (row && row.meta) {
    try {
      const meta = JSON.parse(row.meta)
      cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
    } catch { cwd = '' }
  }
  if (cwd) {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
    if (base) return safeSegment(base, projectId, 40)
  }
  return safeSegment(projectId, 'manual', 40)
}

/** 标题 → slug（同标题稳定，便于重复预览）。 */
export function slugOf(title, fallbackId = '') {
  const slug = safeSegment(String(title ?? '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '-'), '', 60)
  return slug === '' ? `note-${String(fallbackId).slice(-8)}` : slug
}

/**
 * 目标文件的 vault 相对路径：Library/<项目名>/Projects/<project_id>/<kind>/<slug>.md
 */
export function noteRelPath({ projectName, projectId, kind, slug }) {
  const dir = KIND_DIR[String(kind)] || KIND_DIR.concept
  return path.join('Library', safeSegment(projectName, 'manual', 40), 'Projects', safeSegment(projectId, 'manual', 60), dir, `${slug}.md`)
}

/**
 * 路径白名单：解析后的绝对路径必须落在 vault 内（spec §14）。
 * 不用字符串前缀比较——大小写、符号链接、`..` 都会被绕过去。
 */
export function assertInside(vaultRoot, target) {
  const root = path.resolve(vaultRoot)
  const full = path.resolve(target)
  const rel = path.relative(root, full)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝写入 vault 之外的路径：${full}`)
  }
  return full
}

function yamlScalar(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  if (/^[\p{Script=Han}A-Za-z0-9._\/-]+$/u.test(text) && !/^(true|false|null|yes|no|on|off|\d+(\.\d+)?)$/i.test(text)) return text
  return JSON.stringify(text)
}

/** frontmatter（spec §11 字段）——顺序固定，便于人眼 diff。 */
export function frontmatter(fields) {
  const lines = ['---']
  lines.push(`title: ${yamlScalar(fields.title)}`)
  lines.push(`project: ${yamlScalar(fields.project)}`)
  lines.push(`project_id: ${yamlScalar(fields.projectId)}`)
  lines.push(`kind: ${yamlScalar(fields.kind)}`)
  lines.push(`status: ${yamlScalar(fields.status)}`)
  lines.push(`revision: ${Number(fields.revision) || 1}`)
  lines.push(`wiki_id: ${yamlScalar(fields.wikiId)}`)
  const sources = Array.isArray(fields.sources) ? fields.sources : []
  lines.push('sources:')
  for (const id of sources) lines.push(`  - ${yamlScalar(id)}`)
  if (sources.length === 0) lines[lines.length - 1] = 'sources: []'
  const related = Array.isArray(fields.related) ? fields.related : []
  if (related.length === 0) lines.push('related: []')
  else {
    lines.push('related:')
    for (const link of related) lines.push(`  - ${JSON.stringify(`[[${link}]]`)}`)
  }
  lines.push(`updated: ${yamlScalar(fields.updated)}`)
  lines.push('---')
  return lines.join('\n')
}

/** 完整文件内容 = frontmatter + 正文 + 出处。 */
export function renderNote({ title, project, projectId, kind, status, revision, wikiId, sources, related, updated, body, citations = [] }) {
  const head = frontmatter({ title, project, projectId, kind, status, revision, wikiId, sources, related, updated })
  const parts = [head, '', `# ${title}`, '', String(body || '').trim(), '']
  if (citations.length > 0) {
    parts.push('## 出处', '')
    for (const item of citations) {
      const where = item.locator ? `\`${item.locator}\`` : '未登记定位'
      const quote = String(item.quote || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      parts.push(`- ${where}：${quote}`)
    }
    parts.push('')
  }
  return parts.join('\n')
}

/**
 * 幂等比较用的规范化文本：抹掉 frontmatter 里每次渲染都会变的两个字段。
 *   · `updated` —— 时间戳，每轮都不同；
 *   · `revision` —— 由「已有笔记 + 1」推出来，比较时它必然是新的那个号。
 * 二者都不属于「内容」，直接比 sha 会让每次写入都涨 revision。
 */
export function compareText(text) {
  return String(text)
    .replace(/^updated: .*$/mu, 'updated: <any>')
    .replace(/^revision: \d+$/mu, 'revision: <n>')
}

/** 同一项目里已存在的其它笔记（related 的候选：wikilink 目标必须存在）。 */
export function relatedCandidates(db, { projectId, selfPath, limit = 5 }) {
  const rows = all(
    db,
    `SELECT path, MAX(revision) AS rev FROM notes WHERE path <> ? GROUP BY path ORDER BY rev DESC LIMIT ?`,
    [selfPath, limit],
  )
  return rows
    .map((row) => String(row.path).replace(/\\/g, '/'))
    .filter((p) => p.includes(`/Projects/${projectId}/`))
    .map((p) => path.basename(p, '.md'))
    .slice(0, limit)
}

/**
 * 把一条 approved 的 L2/L3 写进 vault。
 * 返回 { ok, path, revision, bytes, changed, conflict?, writeId }。
 */
export function writeNote(db, { layer, id, vaultPath, language = 'zh', now = Date.now() }) {
  const target = loadTarget(db, layer, id)
  if (!target) throw new Error(`找不到 ${layer} 记录：${id}`)
  if (target.status !== 'approved') {
    throw new Error('只有 approved 的记录能写入 vault：先在审核队列里采纳它')
  }
  const approval = approvalOf(db, layer, id)
  if (!approval) throw new Error('这条没有可用的审核凭据（writes.review_id 缺失），拒绝写入')

  const root = ensureVault(vaultPath)
  const projectId = target.project_id
  const projectName = projectNameOf(db, projectId)
  const slug = slugOf(target.title, target.id)
  const rel = noteRelPath({ projectName, projectId, kind: target.kind, slug })
  const full = assertInside(root, path.join(root, rel))
  const citations = all(
    db,
    `SELECT c.quote, c.to_id AS sourceId, s.locator FROM citations c
       LEFT JOIN sources s ON s.id = c.to_id
      WHERE c.from_layer = ? AND c.from_id = ? ORDER BY c.created_at, c.id`,
    [layer, id],
  )
  const sourceIds = citations.map((item) => item.sourceId)
  const relKey = rel.split(path.sep).join('/')
  const related = relatedCandidates(db, { projectId, selfPath: relKey })
  const existingNote = get(db, 'SELECT * FROM notes WHERE path = ? ORDER BY revision DESC LIMIT 1', [relKey])
  const existingFile = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
  const revision = existingNote ? Number(existingNote.revision) + 1 : 1
  const text = renderNote({
    title: target.title,
    project: projectName,
    projectId,
    kind: target.kind || 'concept',
    status: target.status,
    revision,
    wikiId: target.id,
    sources: sourceIds,
    related,
    updated: nowIso(new Date(now)),
    body: target.content,
    citations,
  })
  const bytes = bytesOf(text)
  const sha = sha256Hex(text)

  // 冲突：磁盘上有人改过（不是上一次写进去的内容）→ 停手，记账，报 conflict
  if (existingFile !== null && existingNote && sha256Hex(existingFile) !== existingNote.content_sha256) {
    const writeId = ulid(now)
    runSql(
      db,
      `INSERT INTO writes (id, review_id, path, bytes, revision, error, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [writeId, approval.id, relKey, existingNote.revision, 'conflict: 文件在 vault 外被改动过，已停止写入', nowIso(new Date(now))],
    )
    return { ok: false, conflict: true, path: relKey, revision: Number(existingNote.revision), writeId, bytes: 0 }
  }
  // 幂等：正文没变就什么都不做（不涨 revision、不写文件）。
  // 比较时抹掉 updated 行——它每轮都会变，但不属于「内容」（否则每次写都涨 revision）。
  if (existingFile !== null && compareText(existingFile) === compareText(text)) {
    return { ok: true, changed: false, path: relKey, revision: existingNote ? Number(existingNote.revision) : revision, bytes, writeId: null }
  }

  fs.mkdirSync(path.dirname(full), { recursive: true })
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.${ulid(now)}.tmp`)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, full)

  const writeId = ulid(now)
  const noteId = ulid(now)
  const ts = nowIso(new Date(now))
  tx(db, () => {
    if (existingNote) runSql(db, 'UPDATE notes SET superseded_by = ? WHERE id = ?', [noteId, existingNote.id])
    runSql(
      db,
      `INSERT INTO notes (id, path, revision, content, content_sha256, created_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [noteId, relKey, revision, text, sha, ts],
    )
    runSql(
      db,
      `INSERT INTO writes (id, review_id, path, bytes, revision, error, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [writeId, approval.id, relKey, bytes, revision, ts],
    )
  })
  return { ok: true, changed: true, path: relKey, revision, bytes, writeId }
}

/**
 * 重算 Library/索引.md（spec §11：每次写入后重算，只增不删）。
 */
export function rebuildIndex(db, { vaultPath, now = Date.now() }) {
  const root = ensureVault(vaultPath)
  const rows = all(
    db,
    `SELECT n.path, n.revision, n.content FROM notes n
       JOIN (SELECT path, MAX(revision) AS rev FROM notes GROUP BY path) latest
         ON latest.path = n.path AND latest.rev = n.revision
      ORDER BY n.path`,
  )
  const groups = new Map()
  for (const row of rows) {
    const rel = String(row.path).replace(/\\/g, '/')
    const parts = rel.split('/')
    const project = parts.length > 2 ? parts[1] : '未分组'
    if (!groups.has(project)) groups.set(project, [])
    const body = String(row.content || '')
    const kindMatch = body.match(/^kind:\s*(.+)$/m)
    groups.get(project).push({
      slug: path.basename(rel, '.md'),
      revision: Number(row.revision),
      kind: kindMatch ? kindMatch[1].trim() : 'concept',
    })
  }
  const lines = ['# LLM Wiki 索引', '', `> 由 dsh-llm-wiki 自动生成（${nowIso(new Date(now))}）。请勿手工编辑：下次写入会整篇重算。`, '']
  if (groups.size === 0) lines.push('_还没有写入任何笔记。在审核队列里采纳并写入后，这里会出现条目。_', '')
  for (const [project, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${project}`, '')
    for (const item of items.sort((a, b) => a.slug.localeCompare(b.slug))) {
      lines.push(`- [[${item.slug}]] · ${item.kind} · v${item.revision}`)
    }
    lines.push('')
  }
  const text = lines.join('\n')
  const full = assertInside(root, path.join(root, 'Library', '索引.md'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const tmp = path.join(path.dirname(full), `.索引.md.${process.pid}.tmp`)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, full)
  return { ok: true, path: 'Library/索引.md', entries: rows.length, bytes: bytesOf(text) }
}

/**
 * 解决冲突：人类在 Obsidian 里改过文件，插件不该覆盖，但也不能永远卡死。
 * 这里把 notes 里最新 revision 的 content_sha256 重新对齐到磁盘现状（不碰文件内容），
 * 之后的新写入会基于「人类这一版」继续只增 revision。
 */
export function rebaselineNote(db, { path: relPath, vaultPath, now = Date.now() }) {
  const root = path.resolve(String(vaultPath || ''))
  const key = String(relPath || '').replace(/^[/\\]+/, '')
  if (key === '') throw new Error('缺少 path（vault 内相对路径，如 Library/…/x.md）')
  const full = assertInside(root, path.join(root, key))
  if (!fs.existsSync(full)) {
    // 文件被人类删了：清掉 notes 指针，下次写入会当作新文件从 revision 1 开始
    const existing = get(db, 'SELECT id FROM notes WHERE path = ? ORDER BY revision DESC LIMIT 1', [key])
    if (!existing) return { ok: true, path: key, existed: false, reset: false }
    runSql(db, 'DELETE FROM notes WHERE path = ?', [key])
    return { ok: true, path: key, existed: false, reset: true }
  }
  const text = fs.readFileSync(full, 'utf8')
  const sha = sha256Hex(text)
  const latest = get(db, 'SELECT id, content_sha256 AS sha, revision FROM notes WHERE path = ? ORDER BY revision DESC LIMIT 1', [key])
  if (!latest) {
    // 文件在库里没有记录（人类新建的）：不动它，交给用户决定是否登记
    return { ok: false, path: key, reason: 'untracked', sha, bytes: bytesOf(text) }
  }
  if (latest.sha === sha) return { ok: true, path: key, existed: true, reset: false, revision: Number(latest.revision) }
  // 人类这一版也占一个 revision：先插新行（内容 = 磁盘现状），再把上一条挂成 superseded。
  // 这样「每次内容变更 revision+1」对所有作者成立，历史里也留得下人的手改。
  const noteId = ulid(now)
  const revision = Number(latest.revision) + 1
  const ts = nowIso(new Date(now))
  tx(db, () => {
    runSql(db, 'UPDATE notes SET superseded_by = ? WHERE id = ?', [noteId, latest.id])
    runSql(
      db,
      `INSERT INTO notes (id, path, revision, content, content_sha256, created_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [noteId, key, revision, text, sha, ts],
    )
  })
  return { ok: true, path: key, existed: true, reset: true, revision, bytes: bytesOf(text), at: ts }
}

/** 已写入的笔记（面板用）。 */
export function listNotes(db, { limit = 100 } = {}) {
  return all(
    db,
    `SELECT n.path, MAX(n.revision) AS revision, COUNT(*) AS revisions, MAX(n.created_at) AS updatedAt
       FROM notes n GROUP BY n.path ORDER BY updatedAt DESC LIMIT ?`,
    [limit],
  )
}

/** 写入历史。 */
export function listWrites(db, { limit = 50 } = {}) {
  return all(
    db,
    `SELECT w.id, w.path, w.bytes, w.revision, w.error, w.created_at AS createdAt,
            w.review_id AS reviewId, r.action AS reviewAction
       FROM writes w LEFT JOIN reviews r ON r.id = w.review_id
      ORDER BY w.created_at DESC LIMIT ?`,
    [limit],
  )
}

/** 与 vault 相关的配置摘要（设置视图）。 */
export function vaultStatus(vaultPath) {
  const root = path.resolve(String(vaultPath || ''))
  const exists = fs.existsSync(root)
  let noteCount = 0
  try {
    const library = path.join(root, 'Library')
    if (fs.existsSync(library)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const next = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(next)
          else if (entry.name.endsWith('.md')) noteCount += 1
        }
      }
      walk(library)
    }
  } catch { noteCount = 0 }
  return { root, exists, noteCount }
}
