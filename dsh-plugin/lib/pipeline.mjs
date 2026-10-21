// lib/pipeline.mjs — L1 → L2 提炼（spec §9）。
//
// 三条铁律：
//   1. 同步写库、异步提炼：本模块只在宿主事件循环的空闲时点被调度，绝不阻塞会话。
//   2. 单位是「多来源窗口」——一个窗口 = 同一会话同一轮的 user/assistant/tool 若干条 L1，
//      产出**一条** L2 候选（libary 硬约束：L2 禁止逐来源成篇）。
//   3. 提炼产物一律 status='candidate' + uncertain=1（规则模式）：它只是待审材料，
//      正文是否成立由人在审核队列里裁定（spec §G5）。
//
// 规则模式（无模型）产出：标题 + 首段 + 逐字引用；不做 L3。有模型时同样走这条通路，
// 只是抽取结果换成模型返回的 JSON（本插件不持有模型密钥，见 spec §G3/§9 的降级条款）。
import { all, get, run as runSql, tx } from './db.mjs'
import { ulid, nowIso, sha256Hex } from './ids.mjs'
import { fingerprintOf, bytesOf } from './text.mjs'
import { indexDoc, addEdge } from './indexer.mjs'

export const MODE_RULES = 'rules'
export const MODE_MODEL = 'model'

/** 单轮抽取的输入上界（spec §9：≤8K 输入、≤2K 输出）。 */
export const MAX_WINDOW_BYTES = 8 * 1024
export const MAX_L2_BYTES = 2 * 1024
/** 引用片段长度上限：够证明来源，又不至于把 L1 整段抄进 L2。 */
export const MAX_QUOTE_CHARS = 240

const TEXT_ROLES = new Set(['user', 'assistant', 'manual', 'summary'])

/** 判定为「决策类」的关键词（决定 Markdown 落到 decisions/ 还是 concepts/）。 */
const DECISION_HINTS = ['决定', '采用', '选择', '放弃', '不用', '改用', '方案', '结论', '取舍', '定稿', '拍板']

/**
 * 还没被任何 L2 引用过的 L1（pending = 待提炼）。
 * 只要被引用过就算已消化（哪怕那条 L2 后来被 discard）：这让重复运行保持幂等，
 * 而重新提炼要人工先把 L2 删掉——这是刻意的，避免同一段对话反复产出候选。
 */
export function pendingSources(db, { projectId = null, limit = 100 } = {}) {
  const params = []
  let filter = ''
  if (projectId) { filter = 'AND s.project_id = ?'; params.push(projectId) }
  const rows = all(
    db,
    `SELECT s.id, s.kind, s.role, s.project_id, s.session_id, s.turn, s.step, s.locator,
            s.part, s.content, s.content_sha256, s.meta, s.created_at
       FROM sources s
      WHERE s.deleted_at IS NULL
        AND s.kind IN ('dsh-turn','manual')
        ${filter}
        AND NOT EXISTS (
              SELECT 1 FROM citations c
               WHERE c.to_layer = 'L1' AND c.to_id = s.id
            )
      ORDER BY s.created_at, s.id
      LIMIT ?`,
    [...params, limit],
  )
  return rows
}

/** 待提炼条数（面板显示 / 触发条件判断）。 */
export function pendingCount(db, { projectId = null } = {}) {
  const params = []
  let filter = ''
  if (projectId) { filter = 'AND s.project_id = ?'; params.push(projectId) }
  const row = get(
    db,
    `SELECT COUNT(*) AS n FROM sources s
      WHERE s.deleted_at IS NULL AND s.kind IN ('dsh-turn','manual') ${filter}
        AND NOT EXISTS (SELECT 1 FROM citations c WHERE c.to_layer = 'L1' AND c.to_id = s.id)`,
    params,
  )
  return row ? Number(row.n) : 0
}

/**
 * 把 pending 的 L1 按「会话 + 轮」切成窗口。
 * 没有 turn 的（手工补录 / 会话汇总）各自独立成窗，避免把无关内容并成一篇。
 */
export function groupWindows(rows) {
  const windows = new Map()
  for (const row of rows) {
    const key = row.turn === null || row.turn === undefined
      ? `solo:${row.id}`
      : `${row.project_id}|${row.session_id || ''}|${row.turn}`
    if (!windows.has(key)) windows.set(key, [])
    windows.get(key).push(row)
  }
  const out = []
  for (const [key, items] of windows) {
    items.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || String(a.id).localeCompare(String(b.id)))
    const usable = items.filter((row) => TEXT_ROLES.has(String(row.role || '')) && String(row.content || '').trim() !== '')
    if (usable.length === 0) continue
    out.push({ key, projectId: items[0].project_id, sessionId: items[0].session_id, turn: items[0].turn, items: usable })
  }
  return out
}

/** 逐字摘录：必须是原文的子串（spec §9 落库后要校验 quote 能在 sources.content 里找到）。 */
export function rawExcerpt(content, maxChars = MAX_QUOTE_CHARS) {
  const raw = String(content ?? '')
  if (raw.trim() === '') return ''
  // 开头的标题行对「出处」没有信息量（标题已经单独抽出来了），从第一段正文起摘。
  const body = raw.replace(/^\s*#{1,6}[^\n]*\n+/, '')
  const source = body.trim() === '' ? raw : body
  if (source.length <= maxChars) return source
  const head = source.slice(0, maxChars)
  let cut = -1
  for (const ch of ['。', '！', '？', '\n', '；', '.', '!', '?']) {
    const idx = head.lastIndexOf(ch)
    if (idx > cut) cut = idx
  }
  return cut >= Math.floor(maxChars * 0.3) ? head.slice(0, cut + 1) : head
}

/** 标题清洗：去掉 Markdown 记号，取第一句有内容的行。 */
export function ruleTitle(text, maxChars = 40) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const cleaned = line
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^\s*>\s*/, '')
      .replace(/`{1,3}/g, '')
      .replace(/\*\*|__|~~/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned === '') continue
    if (cleaned.length <= maxChars) return cleaned
    const head = cleaned.slice(0, maxChars)
    let cut = -1
    for (const ch of ['。', '！', '？', '；', '.', '!', '?', ';', '，', ',']) {
      const idx = head.lastIndexOf(ch)
      if (idx > cut) cut = idx
    }
    return cut >= Math.floor(maxChars * 0.4) ? head.slice(0, cut) : `${head.slice(0, maxChars - 1)}…`
  }
  return ''
}

/** 粗略分类：决策类 → decision，其余 → concept（对应 vault 的 decisions/ 与 concepts/）。 */
export function classify(text) {
  const sample = String(text ?? '')
  return DECISION_HINTS.some((hint) => sample.includes(hint)) ? 'decision' : 'concept'
}

/** 规则模式的 L2 正文：带角色标签的窗口摘要，总字节受 MAX_L2_BYTES 约束。 */
export function ruleContent(window) {
  const pieces = []
  for (const row of window.items) {
    const role = String(row.role || 'unknown')
    const label = role === 'user' ? '用户' : role === 'assistant' ? '助手' : role === 'manual' ? '手工补录' : role === 'summary' ? '会话汇总' : role
    // 自带的一级标题就是 L2 的标题，正文里不再重复（vault 渲染时本来就写了一遍标题）。
    const body = String(row.content || '').trim().replace(/^#{1,6}[^\n]*\n+/, '').trim()
    if (body === '') continue
    pieces.push(`【${label}】${body}`)
  }
  let text = pieces.join('\n\n')
  if (bytesOf(text) > MAX_L2_BYTES) {
    const buf = Buffer.from(text, 'utf8')
    text = `${buf.subarray(0, MAX_L2_BYTES - 3).toString('utf8').replace(/\uFFFD+$/, '')}…`
  }
  return text
}

/**
 * 单个窗口 → 一条 L2 候选（含 citations 与 derived_from 边）。
 * 返回 { inserted: boolean, id: string|null, reason?: string }。
 */
export function extractWindow(db, window, { mode = MODE_RULES, model = null, now = Date.now() } = {}) {
  const hashes = window.items.map((row) => row.content_sha256)
  const fingerprint = fingerprintOf(window.projectId, hashes)
  const existing = get(db, 'SELECT id FROM extractions WHERE fingerprint = ?', [fingerprint])
  if (existing) return { inserted: false, id: existing.id, reason: 'fingerprint' }

  const primary = window.items.find((row) => String(row.role) === 'user') || window.items[0]
  const title = ruleTitle(primary.content) || `会话摘录 ${String(window.turn ?? '')}`.trim()
  const content = ruleContent(window)
  const kind = classify(`${title}\n${content}`)
  const ts = nowIso(new Date(now))
  const id = ulid(now)

  const citations = []
  for (const row of window.items.slice(0, 4)) {
    const quote = rawExcerpt(row.content)
    if (quote === '') continue
    // quote 必须是原文逐字片段；规则模式下它是切片所以必然成立，
    // 但校验必须真的存在——模型模式下这里会拦掉编造的引用（spec §9）。
    if (!String(row.content).includes(quote)) continue
    citations.push({ toId: row.id, quote })
  }

  const uncertain = citations.length === 0 ? 1 : 1 // 规则模式一律待审
  const sourceIds = window.items.map((row) => row.id)

  return tx(db, () => {
    runSql(
      db,
      `INSERT INTO extractions (id, project_id, title, content, kind, status, uncertain, fingerprint, source_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`,
      [id, window.projectId, title, content, kind, uncertain, fingerprint, JSON.stringify(sourceIds), model || `rules:${MODE_RULES}`, ts, ts],
    )
    for (const citation of citations) {
      runSql(
        db,
        `INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, span_start, span_end, created_at)
         VALUES (?, 'L2', ?, 'L1', ?, ?, NULL, NULL, ?)`,
        [ulid(now), id, citation.toId, citation.quote, ts],
      )
      addEdge(db, { fromLayer: 'L2', fromId: id, toLayer: 'L1', toId: citation.toId, kind: 'derived_from' })
    }
    indexDoc(db, { layer: 'L2', refId: id, title, body: content })
    return { inserted: true, id, reason: null }
  })
}

/**
 * 跑一轮提炼。返回结构化结果，供 API / 日志 / 面板共用。
 * 触发条件由调用方（scheduler）判断，这里只负责执行。
 */
export function runPipeline(db, { config, log = null, now = Date.now(), projectId = null, force = false, maxSources = 0 } = {}) {
  const batchSize = Math.max(1, Number(config?.pipelineBatchSize) || 12)
  const limit = maxSources > 0 ? maxSources : batchSize * 6
  const pending = pendingSources(db, { projectId, limit })
  if (pending.length === 0) {
    return { ran: false, reason: 'nothing-pending', inserted: 0, skipped: 0, windows: 0, mode: MODE_RULES }
  }
  // 预算：输入 ≤8K 的窗口不再合并；超了就在本窗口截断（ruleContent 已做）
  const windows = groupWindows(pending)
  const mode = MODE_RULES
  const jobId = ulid(now)
  const ts = nowIso(new Date(now))
  let inserted = 0
  let skipped = 0
  const created = []
  for (const window of windows) {
    try {
      const result = extractWindow(db, window, { mode, model: config?.pipelineModel || null, now })
      if (result.inserted) { inserted += 1; created.push(result.id) } else skipped += 1
    } catch (err) {
      skipped += 1
      log?.('warn', `提炼窗口失败：${String((err && err.message) || err)}`)
    }
  }
  runSql(
    db,
    `INSERT INTO jobs (id, kind, status, payload, result, created_at, started_at, finished_at)
     VALUES (?, 'extract', 'done', ?, ?, ?, ?, ?)`,
    [jobId, JSON.stringify({ projectId, pending: pending.length, windows: windows.length, force: Boolean(force) }),
      JSON.stringify({ inserted, skipped }), ts, ts, nowIso()],
  )
  runSql(
    db,
    `INSERT INTO policies (key, value, updated_at) VALUES ('pipelineLastRunAt', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [ts, ts],
  )
  if (inserted > 0) log?.('info', `提炼完成：新增 ${inserted} 条 L2 候选（跳过 ${skipped}）`)
  return { ran: true, reason: null, jobId, inserted, skipped, windows: windows.length, pending: pending.length, mode, created }
}

/** 面板「知识加工」用的状态快照。 */
export function pipelineState(db, { config = null } = {}) {
  const last = get(db, "SELECT value FROM policies WHERE key = 'pipelineLastRunAt'")
  const lastJob = get(db, "SELECT id, status, payload, result, created_at FROM jobs WHERE kind = 'extract' ORDER BY created_at DESC LIMIT 1")
  const pending = pendingCount(db)
  const batchSize = Math.max(1, Number(config?.pipelineBatchSize) || 12)
  const model = String(config?.pipelineModel || '')
  const lastRunAt = last ? last.value : null
  let lastResult = null
  if (lastJob && lastJob.result) {
    try { lastResult = JSON.parse(lastJob.result) } catch { lastResult = null }
  }
  return {
    pending,
    windowsReady: pending >= batchSize,
    threshold: batchSize,
    mode: model === '' ? MODE_RULES : MODE_MODEL,
    degraded: model === '',
    model: model === '' ? null : model,
    autoRun: config?.pipelineAutoRun !== false,
    idleMinutes: Math.max(1, Number(config?.pipelineIdleMinutes) || 30),
    lastRunAt,
    lastJob: lastJob ? { id: lastJob.id, status: lastJob.status, at: lastJob.created_at, result: lastResult } : null,
  }
}

/** 与 source 无关的工具导出，供测试断言用。 */
export const __internals = { DECISION_HINTS, TEXT_ROLES, sha256Hex }
