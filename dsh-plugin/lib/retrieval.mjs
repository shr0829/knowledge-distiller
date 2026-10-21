// lib/retrieval.mjs — 检索与组装（spec §10）。
//
// 管线：查询归一 → FTS5 匹配（中文 bigram）→ 1 跳图扩展 → 组装
//      （L3 在前并附 L2/L1 证据链，L1 单独成组）→ 截断（默认 8 条 / 24KB）。
// 排序：score = 0.6*text + 0.25*recency + 0.15*centrality（权重存 policies）。
import { all, get } from './db.mjs'
import { normalizeQuery } from './text.mjs'
import { matchFts, centralityMap, neighboursOf } from './indexer.mjs'
import { bytesOf, truncateBytes } from './text.mjs'

export const DEFAULT_WEIGHTS = Object.freeze({ text: 0.6, recency: 0.25, centrality: 0.15 })
export const MAX_RESULTS = 8
export const MAX_BYTES = 24 * 1024
const GRAPH_FACTOR = 0.5

const LAYER_TABLE = { L1: 'sources', L2: 'extractions', L3: 'abstractions' }

/** 取权重（policies 优先，缺项用默认）。 */
export function readWeights(db, override = null) {
  const pick = (key, fallback) => {
    const value = Number(override && override[key])
    if (Number.isFinite(value) && value >= 0) return value
    const row = get(db, 'SELECT value FROM policies WHERE key = ?', [key])
    const stored = row ? Number(row.value) : NaN
    return Number.isFinite(stored) && stored >= 0 ? stored : fallback
  }
  const weights = {
    text: pick('retrievalWeightText', DEFAULT_WEIGHTS.text),
    recency: pick('retrievalWeightRecency', DEFAULT_WEIGHTS.recency),
    centrality: pick('retrievalWeightCentrality', DEFAULT_WEIGHTS.centrality),
  }
  const sum = weights.text + weights.recency + weights.centrality
  if (sum <= 0) return { ...DEFAULT_WEIGHTS }
  return { text: weights.text / sum, recency: weights.recency / sum, centrality: weights.centrality / sum }
}

/** 取一条节点（统一成组装用的形状）。 */
export function loadNode(db, layer, id) {
  if (layer === 'L1') {
    const row = get(db, 'SELECT id, project_id, role, kind, session_id, turn, content, created_at FROM sources WHERE id = ? AND deleted_at IS NULL', [id])
    if (!row) return null
    return {
      layer: 'L1', id: row.id, projectId: row.project_id, title: `[${row.role || row.kind}]`,
      content: row.content, status: 'raw', uncertain: 0, createdAt: row.created_at,
      sessionId: row.session_id, turn: row.turn,
    }
  }
  const table = LAYER_TABLE[layer]
  const row = get(db, `SELECT id, project_id, title, content, kind, status, uncertain, created_at FROM ${table} WHERE id = ?`, [id])
  if (!row) return null
  return {
    layer, id: row.id, projectId: row.project_id, title: row.title, content: row.content,
    kind: row.kind, status: row.status, uncertain: Number(row.uncertain) || 0, createdAt: row.created_at,
  }
}

/** L2/L3 的证据链：citations → L1 原文 + derived_from → L2。 */
export function evidenceOf(db, layer, id) {
  const evidence = []
  if (layer === 'L1') return evidence
  const cites = all(
    db,
    'SELECT to_id, quote FROM citations WHERE from_layer = ? AND from_id = ? ORDER BY created_at LIMIT 6',
    [layer, id],
  )
  for (const cite of cites) {
    const row = get(db, 'SELECT id, role, content, session_id, created_at FROM sources WHERE id = ? AND deleted_at IS NULL', [cite.to_id])
    evidence.push({
      layer: 'L1', id: cite.to_id, quote: String(cite.quote || ''),
      content: row ? row.content : '', role: row ? row.role : null,
      sessionId: row ? row.session_id : null, createdAt: row ? row.created_at : null,
    })
  }
  if (layer === 'L3') {
    const parents = all(
      db,
      "SELECT to_id FROM edges WHERE from_layer = 'L3' AND from_id = ? AND to_layer = 'L2' AND kind = 'derived_from' LIMIT 4",
      [id],
    )
    for (const parent of parents) {
      const node = loadNode(db, 'L2', parent.to_id)
      if (node) evidence.push({ layer: 'L2', id: node.id, quote: '', content: node.content, title: node.title, status: node.status })
    }
  }
  return evidence
}

function ageScore(createdAt, now) {
  const ts = Date.parse(String(createdAt || ''))
  if (!Number.isFinite(ts)) return 0.5
  const days = Math.max(0, (now - ts) / 86400000)
  return 1 / (1 + days / 30)
}

/** 无可用 token 时的退路：LIKE 命中计数（中文 bigram 也能用）。 */
function likeFallback(db, tokens, limit) {
  if (tokens.length === 0) return []
  const scored = new Map()
  const probes = tokens.slice(0, 8)
  const bump = (layer, id) => {
    const key = `${layer}:${id}`
    scored.set(key, (scored.get(key) || 0) + 1)
  }
  for (const token of probes) {
    const like = `%${token}%`
    for (const row of all(db, 'SELECT id FROM sources WHERE deleted_at IS NULL AND content LIKE ? LIMIT 60', [like])) bump('L1', row.id)
    for (const row of all(db, "SELECT id FROM extractions WHERE status <> 'discarded' AND (title LIKE ? OR content LIKE ?) LIMIT 30", [like, like])) bump('L2', row.id)
    for (const row of all(db, "SELECT id FROM abstractions WHERE status <> 'discarded' AND (title LIKE ? OR content LIKE ?) LIMIT 30", [like, like])) bump('L3', row.id)
  }
  return [...scored.entries()]
    .map(([key, count]) => {
      const [layer, id] = [key.slice(0, 2), key.slice(3)]
      return { layer, refId: id, rank: -count }
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
}

/**
 * v2 检索（docs/DSH_WIKI_SPEC.md §5.4）：索引页优先，主张带时态，原文成组。
 *
 * 与 v1 `search()` 的区别：
 *   · 先查 pages（fts 里 layer='L3' 且 refId 是页面 id），命中页再挂「相关主张」与「证据锚点」；
 *   · 主张按 asOf 过滤（双时态的事实时间），回答「当时是怎么说的」；
 *   · 加了 feedback 分项（有人点过有用/无用就影响排序）；
 *   · 原文（L1）单独成组，不跟页面混排——页面负责结论，来源负责凭据。
 */
export const WIKI_WEIGHTS = Object.freeze({ text: 0.55, recency: 0.2, centrality: 0.15, feedback: 0.1 })

export function readWikiWeights(db, override = null) {
  const pick = (key, fallback) => {
    const value = Number(override && override[key])
    if (Number.isFinite(value) && value >= 0) return value
    const row = get(db, 'SELECT value FROM policies WHERE key = ?', [key])
    const stored = row ? Number(row.value) : NaN
    return Number.isFinite(stored) && stored >= 0 ? stored : fallback
  }
  const weights = {
    text: pick('wikiWeightText', WIKI_WEIGHTS.text),
    recency: pick('wikiWeightRecency', WIKI_WEIGHTS.recency),
    centrality: pick('wikiWeightCentrality', WIKI_WEIGHTS.centrality),
    feedback: pick('wikiWeightFeedback', WIKI_WEIGHTS.feedback),
  }
  const sum = weights.text + weights.recency + weights.centrality + weights.feedback
  if (sum <= 0) return { ...WIKI_WEIGHTS }
  return {
    text: weights.text / sum, recency: weights.recency / sum,
    centrality: weights.centrality / sum, feedback: weights.feedback / sum,
  }
}

function feedbackScore(db, pageId) {
  const rows = all(db, 'SELECT verdict, COUNT(*) AS n FROM page_feedback WHERE page_id = ? GROUP BY verdict', [pageId])
  let useful = 0
  let bad = 0
  for (const row of rows) {
    if (row.verdict === 'useful') useful += Number(row.n)
    else bad += Number(row.n)
  }
  const total = useful + bad
  if (total === 0) return 0.5
  return Math.max(0, Math.min(1, (useful + 1) / (total + 2)))
}

/** 某页在 asOf 时点仍然成立的主张（不传 asOf 就是「现在成立的」）。 */
export function pageClaimsAsOf(db, pageId, asOf = null) {
  const at = asOf ? String(asOf) : null
  return all(db, `SELECT * FROM claims
    WHERE page_id = ?
      AND t_expired IS NULL
      AND (t_invalid IS NULL OR ? IS NULL OR t_invalid > ?)
      AND (t_valid IS NULL OR ? IS NULL OR t_valid <= ?)
    ORDER BY t_created DESC LIMIT 12`, [pageId, at, at, at, at])
}

function pageEvidence(db, pageId) {
  return all(db, `SELECT c.to_id AS sourceId, c.quote, s.role, s.session_id AS sessionId, s.created_at AS createdAt
    FROM citations c LEFT JOIN sources s ON s.id = c.to_id
    WHERE c.from_layer = 'PAGE' AND c.from_id = ?
    ORDER BY c.created_at LIMIT 8`, [pageId])
}

function rawGroup(db, tokens, { limit = 4, projectId = null } = {}) {
  const out = []
  const probes = tokens.slice(0, 6)
  for (const token of probes) {
    for (const row of all(db, `SELECT id, project_id, role, kind, content, session_id, created_at FROM sources
      WHERE deleted_at IS NULL AND content LIKE ? LIMIT 20`, [`%${token}%`])) {
      if (projectId && row.project_id !== projectId) continue
      if (out.some((item) => item.sourceId === row.id)) continue
      out.push({
        sourceId: row.id,
        projectId: row.project_id,
        role: row.role,
        kind: row.kind,
        sessionId: row.session_id,
        createdAt: row.created_at,
        excerpt: truncateBytes(String(row.content || ''), 320),
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * @param {{limit?:number,maxBytes?:number,asOf?:string|null,projectId?:string|null,weights?:object,raw?:boolean}} [options]
 */
export function searchWiki(db, query, options = {}) {
  const started = Date.now()
  const normalized = normalizeQuery(query)
  const limit = Math.max(1, Math.min(50, Number(options.limit) || MAX_RESULTS))
  const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_BYTES)
  const weights = readWikiWeights(db, options.weights)
  const projectId = options.projectId || null
  const asOf = options.asOf || null

  const { tokens, rows } = matchFts(db, query || '')
  const centrality = centralityMap(db)
  const maxCentrality = Math.max(1, ...centrality.values())
  const now = Date.now()

  const hits = rows.filter((row) => row.layer === 'L3')
  const ranks = hits.map((row) => Number(row.rank) || 0)
  const minRank = ranks.length ? Math.min(...ranks) : 0
  const maxRank = ranks.length ? Math.max(...ranks) : 0

  const results = []
  for (const row of hits) {
    const page = get(db, 'SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL', [row.refId])
    if (!page) continue
    if (projectId && page.project_id !== projectId) continue
    const rank = Number(row.rank) || 0
    const textScore = maxRank === minRank ? 1 : (maxRank - rank) / (maxRank - minRank)
    const key = `L3:${page.id}`
    const components = {
      text: textScore,
      recency: ageScore(page.updated_at || page.created_at, now),
      centrality: (centrality.get(key) || 0) / maxCentrality,
      feedback: feedbackScore(db, page.id),
    }
    results.push({
      pageId: page.id,
      projectId: page.project_id,
      kind: page.kind,
      title: page.title,
      summary: page.summary,
      status: page.status,
      revision: page.revision,
      path: page.path,
      updatedAt: page.updated_at,
      score: Number((
        weights.text * components.text +
        weights.recency * components.recency +
        weights.centrality * components.centrality +
        weights.feedback * components.feedback
      ).toFixed(6)),
      components,
      claims: pageClaimsAsOf(db, page.id, asOf),
      evidence: pageEvidence(db, page.id),
    })
  }
  results.sort((a, b) => b.score - a.score)

  // 截断：页面优先吃预算，原文组吃剩下的
  const kept = []
  let totalBytes = 0
  let truncated = false
  for (const page of results) {
    if (kept.length >= limit) { truncated = true; break }
    const cost = bytesOf(`${page.title}${page.summary}${page.claims.map((c) => c.statement).join('')}`)
    if (totalBytes + cost > maxBytes) { truncated = true; break }
    totalBytes += cost
    kept.push(page)
  }
  // 原文组（L1）也吃同一份预算：先保页面，剩下的给原文，命中 4 条为止
  const rawAll = options.raw === false ? [] : rawGroup(db, tokens, { projectId })
  const raw = []
  for (const item of rawAll) {
    if (raw.length >= 4) { truncated = true; break }
    const cost = bytesOf(`${item.title}${item.excerpt}`)
    if (totalBytes + cost > maxBytes) { truncated = true; break }
    totalBytes += cost
    raw.push(item)
  }

  return {
    query: String(query ?? ''),
    normalized,
    tokens,
    mode: rows.length > 0 ? 'fts' : (raw.length > 0 ? 'like' : 'empty'),
    asOf,
    weights,
    results: kept,
    raw,
    total: kept.length,
    truncated,
    bytes: totalBytes,
    maxBytes,
    tookMs: Date.now() - started,
  }
}

/**
 * 检索入口。
 * @param {object} db
 * @param {string} query
 * @param {{limit?:number,maxBytes?:number,weights?:object,projectId?:string|null,expandGraph?:boolean}} [options]
 */
export function search(db, query, options = {}) {
  const started = Date.now()
  const normalized = normalizeQuery(query)
  const limit = Math.max(1, Math.min(50, Number(options.limit) || MAX_RESULTS))
  const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_BYTES)
  const weights = readWeights(db, options.weights)
  const projectId = options.projectId || null

  let { tokens, rows } = matchFts(db, query || '')
  let mode = 'fts'
  if (rows.length === 0) {
    rows = likeFallback(db, tokens, 120)
    mode = rows.length > 0 ? 'like' : 'empty'
  }

  // ---- 打分：bm25 归一成 [0,1]，再叠加时近性与中心度
  const ranks = rows.map((row) => Number(row.rank) || 0)
  const minRank = Math.min(...ranks)
  const maxRank = Math.max(...ranks)
  const centrality = centralityMap(db)
  const maxCentrality = Math.max(1, ...centrality.values())
  const now = Date.now()

  const nodes = new Map()
  for (const row of rows) {
    const node = loadNode(db, row.layer, row.refId)
    if (!node) continue
    if (projectId && node.projectId !== projectId) continue
    const rank = Number(row.rank) || 0
    const textScore = maxRank === minRank ? 1 : (maxRank - rank) / (maxRank - minRank)
    const nodeKey = `${row.layer}:${row.refId}`
    nodes.set(nodeKey, {
      ...node,
      score: 0,
      via: 'match',
      components: {
        text: textScore,
        recency: ageScore(node.createdAt, now),
        centrality: (centrality.get(nodeKey) || 0) / maxCentrality,
      },
    })
  }

  // ---- 1 跳图扩展（derived_from 双向）
  if (options.expandGraph !== false) {
    for (const [key, node] of [...nodes]) {
      for (const neighbour of neighboursOf(db, node.layer, node.id)) {
        const nKey = `${neighbour.layer}:${neighbour.id}`
        if (nodes.has(nKey)) continue
        const neighbourNode = loadNode(db, neighbour.layer, neighbour.id)
        if (!neighbourNode) continue
        if (projectId && neighbourNode.projectId !== projectId) continue
        const base = node.components
        nodes.set(nKey, {
          ...neighbourNode,
          score: 0,
          via: `${node.layer}:${node.id}`,
          components: {
            text: base.text * GRAPH_FACTOR,
            recency: ageScore(neighbourNode.createdAt, now),
            centrality: (centrality.get(nKey) || 0) / maxCentrality,
          },
        })
      }
    }
  }

  // ---- 合成总分并排序
  const ranked = [...nodes.values()].map((node) => ({
    ...node,
    score: Number((
      weights.text * node.components.text +
      weights.recency * node.components.recency +
      weights.centrality * node.components.centrality
    ).toFixed(6)),
  })).sort((a, b) => b.score - a.score)

  // ---- 组装：L3 在前（带证据链）、L2 次之、L1 单独成组
  const order = { L3: 0, L2: 1, L1: 2 }
  ranked.sort((a, b) => (order[a.layer] - order[b.layer]) || (b.score - a.score))

  const results = []
  let totalBytes = 0
  let truncated = false
  for (const node of ranked) {
    if (results.length >= limit) { truncated = true; break }
    const contentBytes = bytesOf(node.content)
    if (totalBytes + contentBytes > maxBytes) {
      const room = maxBytes - totalBytes
      if (room < 256) { truncated = true; break }
      node.content = truncateBytes(node.content, room) + '\n…（内容已截断）'
      node.truncated = true
      truncated = true
    }
    totalBytes += bytesOf(node.content)
    node.evidence = evidenceOf(db, node.layer, node.id)
    results.push(node)
  }

  return {
    query: String(query ?? ''),
    normalized,
    tokens,
    mode,
    weights,
    results,
    total: results.length,
    truncated,
    bytes: totalBytes,
    maxBytes,
    tookMs: Date.now() - started,
  }
}
