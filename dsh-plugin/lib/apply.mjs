// lib/apply.mjs — M8（gates/apply 的一半）：把一个补丁落成页面版本（docs/DSH_WIKI_SPEC.md §5.2）。
//
// 不变量：
//   · 只有人能触发（HTTP 路由层不做任何自动应用；autoWrite 策略永不允许打开）；
//   · 一次只应用一个补丁（禁止批量）；
//   · 落页 = 页面正文 + claims + links + reviews + writes 同一个事务，writes.review_id 必填；
//   · 撤销走补偿事务（删本补丁的 claim、复活被它挤掉的旧 claim、回滚正文），不是只改状态字段。
import { all, get, run, tx } from './db.mjs'
import { nowIso, ulid } from './ids.mjs'
import { addClaim, deleteClaimsOfPatch, restoreClaimsRetiredBy, supersedeConflicts } from './claims.mjs'
import { createPage, getPage, syncLinks, writePageFile } from './pages.mjs'
import { patchOps } from './compiler.mjs'

export const ACTIONS = Object.freeze(['accept', 'discard', 'defer'])

/** 取某小节正文的区间（返回 [start, end) 或 null），用下标替换避免拼接换行出错。 */
function sectionRange(body, section) {
  const text = String(body || '')
  const marker = `## ${section}`
  const start = text.indexOf(marker)
  if (start < 0) return null
  const contentStart = start + marker.length
  const rest = text.slice(contentStart)
  const next = rest.search(/^## /mu)
  return { start, contentStart, end: next < 0 ? text.length : contentStart + next }
}

/** 把 ops 合并进已有正文：update 覆盖同名小节，add 追到末尾，claim 作为要点追加。 */
export function mergeOps(body, ops) {
  let text = String(body || '').trimEnd()
  const claims = []
  for (const op of ops) {
    if (op.op === 'update' && op.section) {
      const range = sectionRange(text, op.section)
      if (range !== null) {
        const head = text.slice(0, range.contentStart)
        const tail = text.slice(range.end)
        text = `${head}\n\n${String(op.text).trim()}\n\n${tail}`.replace(/\n{3,}/gu, '\n\n').trimEnd()
      } else {
        text = `${text}\n\n## ${op.section}\n\n${String(op.text).trim()}\n`
      }
    } else if (op.op === 'add' || op.op === 'update') {
      const section = op.section || '概览'
      const block = `## ${section}\n\n${String(op.text).trim()}\n`
      text = text === '' ? block : `${text}\n\n${block}`
    } else if (op.op === 'claim') {
      claims.push(op)
    }
  }
  if (claims.length > 0) {
    const block = claims.map((op) => `- ${String(op.text).trim()}`).join('\n')
    text = `${text}\n\n## 要点\n\n${block}\n`
  }
  return { body: text, claims, content: ops.filter((op) => op.op === 'add' || op.op === 'update') }
}

/**
 * 落一条证据锚点。quote 必须是来源原文的逐字片段（长度 >= 2），
 * 找不到就整条丢掉——宁可这一条没证据，也不写一条经不起体检的引用。
 */
export function insertCitation(db, { pageId, quote, now = Date.now() }) {
  const sourceId = quote?.source_id
  const text = String(quote?.quote ?? '')
  if (!sourceId || text.length < 2) return 0
  const source = get(db, 'SELECT content FROM sources WHERE id = ? AND deleted_at IS NULL', [sourceId])
  if (!source) return 0
  const at = String(source.content ?? '').indexOf(text)
  if (at < 0) return 0
  const dup = get(db, `SELECT id FROM citations WHERE from_layer = 'L3' AND from_id = ? AND to_id = ? AND quote = ?`,
    [pageId, sourceId, text])
  if (dup) return 0
  run(db, `INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, span_start, span_end, created_at)
    VALUES (?, 'L3', ?, 'L1', ?, ?, ?, ?, ?)`,
  [ulid(now), pageId, sourceId, text, at, at + text.length, nowIso(now)])
  return 1
}

/** 这条补丁带来的引用（撤销时要一起收回，否则页面回退了证据还在）。 */
function citationsOfPatch(db, patch, pageId) {
  const ops = patchOps(patch)
  const quotes = []
  for (const op of ops) for (const quote of op.quotes ?? []) {
    if (quote?.source_id && quote?.quote) quotes.push(quote)
  }
  if (quotes.length === 0 || !pageId) return 0
  let removed = 0
  for (const quote of quotes) {
    removed += Number(run(db, `DELETE FROM citations WHERE from_layer = 'L3' AND from_id = ? AND to_id = ? AND quote = ?`,
      [pageId, quote.source_id, String(quote.quote)]).changes ?? 0)
  }
  return removed
}

/**
 * 接受补丁。`vaultPath` 给了就落文件（需要人工审核 review 记录 + 冲突检测），
 * 没给就只更新数据库（单测与纯审核场景）。
 */
export function acceptPatch(db, { patchId, vaultPath = null, actor = 'human', now = Date.now(), after = null }) {
  const patch = get(db, 'SELECT * FROM patches WHERE id = ?', [patchId])
  if (!patch) throw new Error(`补丁不存在：${patchId}`)
  if (patch.status !== 'candidate') throw new Error(`补丁状态是 ${patch.status}，不能再接受`)

  const ops = patchOps(patch)
  if (ops.length === 0) throw new Error('这个补丁没有任何可应用的改动')

  let page = patch.page_id ? getPage(db, patch.page_id) : null
  const beforeBody = page?.body ?? ''
  const merged = mergeOps(beforeBody, ops)
  const body = after && typeof after.body === 'string' ? after.body : merged.body

  const reviewId = ulid(now)
  let pageId = page?.id ?? null
  let written = null

  tx(db, () => {
    if (page === null) {
      page = createPage(db, {
        projectId: patch.project_id,
        kind: patch.kind,
        title: patch.title,
        body,
        status: 'approved',
        patchId: patch.id,
        now: nowIso(now),
      })
      pageId = page.id
    } else {
      run(db, 'UPDATE pages SET body = ?, last_patch_id = ? WHERE id = ?', [body, patch.id, page.id])
    }

    const created = []
    let citations = 0
    for (const op of merged.claims) {
      const sourceIds = (op.quotes ?? []).map((quote) => quote.source_id)
      const claim = addClaim(db, {
        pageId,
        patchId: patch.id,
        statement: op.text,
        sourceIds,
        tValid: nowIso(now),
        tCreated: nowIso(now),
      })
      supersedeConflicts(db, { claim, patchId: patch.id })
      created.push(claim)
      // 证据锚点跟着 claim 一起落库：只有 quote 在来源原文里逐字存在的才收（§3.2）
      for (const quote of op.quotes ?? []) citations += insertCitation(db, { pageId, quote, now })
    }

    // 正文段落自身也带证据锚点（§3.2 段落级 ^[src:quote]）：没有 claim 的页面同样要有出处
    for (const op of merged.content ?? []) {
      for (const quote of op.quotes ?? []) citations += insertCitation(db, { pageId, quote, now })
    }

    syncLinks(db, pageId)

    run(db, `INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at)
      VALUES (?, 'L3', ?, 'accept', ?, ?, ?, ?)`,
    [reviewId, patch.id, JSON.stringify({ pageId, body: beforeBody }), JSON.stringify({ body }), actor, nowIso(now)])
    run(db, "UPDATE patches SET status = 'approved', decided_at = ? WHERE id = ?", [nowIso(now), patch.id])
    written = { claims: created.length, citations, pageId }
  })

  if (vaultPath) {
    written.file = writePageFile(db, { pageId, vaultPath, reviewId, now })
  }
  return { ok: true, reviewId, pageId, patchId, ...written, body }
}

/** 丢弃补丁：只改补丁状态，不动页面（没有落页就没有补偿）。 */
export function discardPatch(db, { patchId, actor = 'human', now = Date.now() }) {
  const patch = get(db, 'SELECT * FROM patches WHERE id = ?', [patchId])
  if (!patch) throw new Error(`补丁不存在：${patchId}`)
  if (patch.status === 'approved') throw new Error('已应用的补丁不能直接丢弃：先撤销这次应用')
  run(db, `INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at)
    VALUES (?, 'L3', ?, 'discard', ?, NULL, ?, ?)`,
  [ulid(now), patchId, JSON.stringify({ status: patch.status }), actor, nowIso(now)])
  run(db, "UPDATE patches SET status = 'discarded', decided_at = ? WHERE id = ?", [nowIso(now), patchId])
  return { ok: true, status: 'discarded' }
}

export function deferPatch(db, { patchId, actor = 'human', now = Date.now() }) {
  const patch = get(db, 'SELECT * FROM patches WHERE id = ?', [patchId])
  if (!patch) throw new Error(`补丁不存在：${patchId}`)
  run(db, `INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at)
    VALUES (?, 'L3', ?, 'defer', ?, NULL, ?, ?)`,
  [ulid(now), patchId, JSON.stringify({ status: patch.status }), actor, nowIso(now)])
  run(db, "UPDATE patches SET status = 'deferred', decided_at = ? WHERE id = ?", [nowIso(now), patchId])
  return { ok: true, status: 'deferred' }
}

/** 撤销一次「接受」：补偿事务。 */
export function undoAccept(db, { reviewId, vaultPath = null, now = Date.now() }) {
  const review = get(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId])
  if (!review) throw new Error(`审核记录不存在：${reviewId}`)
  if (review.action !== 'accept') throw new Error('只有「接受」可以撤销')
  const before = JSON.parse(review.before || '{}')
  const patch = get(db, 'SELECT * FROM patches WHERE id = ?', [review.target_id])
  if (!patch) throw new Error('补丁已不存在，无法撤销')

  // 先复活被这批 claim 挤掉的旧 claim，再删这批（顺序不能反：复活要靠它们还在）
  const revived = restoreClaimsRetiredBy(db, patch.id)
  const removedClaims = deleteClaimsOfPatch(db, patch.id)
  const removedCitations = citationsOfPatch(db, patch, before.pageId ?? null)

  let page = null
  if (before.pageId) {
    page = getPage(db, before.pageId)
    if (page) {
      run(db, 'UPDATE pages SET body = ?, last_patch_id = NULL WHERE id = ?', [before.body ?? '', page.id])
      syncLinks(db, page.id)
    }
  }
  run(db, "UPDATE patches SET status = 'candidate', decided_at = NULL WHERE id = ?", [patch.id])
  run(db, 'DELETE FROM writes WHERE review_id = ?', [reviewId])
  run(db, `INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at)
    VALUES (?, 'L3', ?, 'edit', ?, NULL, 'undo', ?)`,
  [ulid(now), patch.id, JSON.stringify({ undoOf: reviewId }), nowIso(now)])

  void vaultPath
  return { ok: true, patchId: patch.id, pageId: page?.id ?? null, removedClaims, removedCitations, revivedClaims: revived }
}

export function queuePatches(db, { status = 'candidate', projectId = null, limit = 50 } = {}) {
  const params = [status]
  let where = 'WHERE status = ?'
  if (projectId) { where += ' AND project_id = ?'; params.push(projectId) }
  params.push(limit)
  return all(db, `SELECT p.*, (SELECT COUNT(*) FROM pages g WHERE g.id = p.page_id) AS pageExists
    FROM patches p ${where} ORDER BY p.created_at DESC LIMIT ?`, params)
}

export function queueCounts(db) {
  const row = get(db, `SELECT
      SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) AS discarded,
      SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END) AS deferred
    FROM patches`)
  return {
    candidate: Number(row?.candidate ?? 0),
    approved: Number(row?.approved ?? 0),
    discarded: Number(row?.discarded ?? 0),
    deferred: Number(row?.deferred ?? 0),
  }
}
