// lib/wiki-api.mjs — v2 业务处理器（/api-llm-wiki/* 里与「页面 / 补丁 / 体检 / 问答」有关的部分）。
//
// 约定同 api.mjs：(state, body) => payload；抛错由 routes.mjs 转 500。
// 这里的写操作只有一条：接受/丢弃/延后补丁（人工闸门），其余都是读。
import { all, get } from './db.mjs'
import { listPages, pageDetail, countPages, pageStats } from './pages.mjs'
import { compileBatch, listPatches, patchDetail, patchOps, pipelineState, pendingCount, diffText } from './compiler.mjs'
import { acceptPatch, discardPatch, deferPatch, undoAccept, queuePatches, queueCounts } from './apply.mjs'
import { runLint, findings, latestRun } from './lint.mjs'
import { searchWiki } from './retrieval.mjs'
import { claimCounts } from './claims.mjs'
import { ulid, nowIso } from './ids.mjs'

const str = (value, fallback = '') => (typeof value === 'string' && value !== '' ? value : fallback)

/**
 * 当前提炼/回答用的是哪种模式。宿主没有公开的 LLM 服务（决策 D11），
 * 所以除了显式配置 pipelineModel 之外，一律是规则模式，面板顶部据此常驻提示。
 */
function modelInfo(state) {
  const config = state.getConfig ? state.getConfig() : {}
  const model = str(config.pipelineModel)
  return { mode: model === '' ? 'rules' : 'model', model, degraded: model === '' }
}

const int = (value, fallback, min, max) => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export const wikiHandlers = {
  /** 页面列表（带 kind/status/q 过滤与分页）。 */
  pages(state, body) {
    const db = state.store.get()
    const options = {
      projectId: str(body.projectId) || null,
      kind: str(body.kind) || null,
      status: str(body.status) || null,
      q: str(body.q),
      limit: int(body.limit, 30, 1, 100),
      offset: int(body.offset, 0, 0, 100000),
    }
    const listed = listPages(db, options)
    return {
      ok: true,
      pages: listed.items,
      total: listed.total,
      stats: pageStats(db, { projectId: options.projectId }),
    }
  },

  /** 单页详情：正文 + 主张（可带时点）+ 证据 + 链接 + 反馈。 */
  page(state, body) {
    const db = state.store.get()
    const id = str(body.id)
    if (!id) throw new Error('缺少页面 id')
    const detail = pageDetail(db, id)
    if (!detail) throw new Error(`页面不存在：${id}`)
    const outbound = all(db, `SELECT l.to_page AS toPage, l.kind, p.title FROM links l
      LEFT JOIN pages p ON p.id = l.to_page WHERE l.from_page = ?`, [id])
    const inbound = all(db, `SELECT l.from_page AS fromPage, l.kind, p.title FROM links l
      LEFT JOIN pages p ON p.id = l.from_page WHERE l.to_page = ?`, [id])
    const feedback = all(db, 'SELECT verdict, COUNT(*) AS n FROM page_feedback WHERE page_id = ? GROUP BY verdict', [id])
    return { ok: true, ...detail, outbound, inbound, feedback }
  },

  /** 待审补丁队列。 */
  patchQueue(state, body) {
    const db = state.store.get()
    const status = str(body.status, 'candidate')
    const patches = listPatches(db, {
      status,
      projectId: str(body.projectId) || null,
      limit: int(body.limit, 20, 1, 100),
      offset: int(body.offset, 0, 0, 100000),
    })
    return {
      ok: true,
      patches,
      counts: queueCounts(db),
      pendingSources: pendingCount(db, { projectId: str(body.projectId) || null }),
    }
  },

  /** 补丁详情（含逐行 diff，用于预览）。 */
  patch(state, body) {
    const db = state.store.get()
    const id = str(body.id)
    if (!id) throw new Error('缺少补丁 id')
    const detail = patchDetail(db, id)
    if (!detail) throw new Error(`补丁不存在：${id}`)
    const ops = detail.ops ?? patchOps(detail.patch)
    const before = detail.base_body ?? (detail.patch.page_id ? (get(db, 'SELECT body FROM pages WHERE id = ?', [detail.patch.page_id])?.body ?? '') : '')
    const after = ops.map((op) => op.text).join('\n\n')
    return { ok: true, patch: detail.patch, ops, quotes: detail.quotes ?? [], before, diff: diffText(before, after) }
  },

  /** 审核动作：accept / discard / defer（闸门）。 */
  patchReview(state, body) {
    const db = state.store.get()
    const id = str(body.id)
    const action = str(body.action)
    if (!id) throw new Error('缺少补丁 id')
    const configured = state.getConfig ? str(state.getConfig().vaultPath) : ''
    const vaultPath = str(body.vaultPath) || configured || null
    if (action === 'accept') {
      // 页面真相层是 Markdown：没有 vault 就没有真相层，接受动作直接拒绝（不静默只写库）
      if (!vaultPath) throw new Error('接受补丁必须给出 vaultPath：页面必须落到 Markdown 真相层')
      const result = acceptPatch(db, { patchId: id, vaultPath, actor: 'human' })
      return { ok: true, action, ...result }
    }
    if (action === 'discard') return { ok: true, action, ...discardPatch(db, { patchId: id }) }
    if (action === 'defer') return { ok: true, action, ...deferPatch(db, { patchId: id }) }
    throw new Error(`未知动作：${action}（只能是 accept / discard / defer）`)
  },

  /** 撤销上一次接受（删本次 claim、回滚正文、补丁回 candidate）。 */
  patchUndo(state, body) {
    const db = state.store.get()
    const reviewId = str(body.reviewId)
    if (!reviewId) throw new Error('缺少 reviewId')
    return { ok: true, ...undoAccept(db, { reviewId, vaultPath: str(body.vaultPath) || null }) }
  },

  /** 跑一轮编译（L1 → 补丁），不改页面。 */
  compile(state, body) {
    const db = state.store.get()
    const result = compileBatch(db, {
      config: state.getConfig ? state.getConfig() : {},
      projectId: str(body.projectId) || null,
      maxSources: int(body.maxSources, 0, 0, 200),
      force: body.force === true,
    })
    return { ok: true, ...result, pending: pendingCount(db, { projectId: str(body.projectId) || null }) }
  },

  compileState(state, body) {
    const db = state.store.get()
    return { ok: true, ...pipelineState(db, { projectId: str(body.projectId) || null }) }
  },

  /** 跑一轮体检。 */
  lint(state, body) {
    const db = state.store.get()
    const result = runLint(db, { projectId: str(body.projectId) || null })
    return { ok: true, ...result }
  },

  lintFindings(state, body) {
    const db = state.store.get()
    const run = latestRun(db)
    const rows = findings(db, {
      runId: str(body.runId) || run?.runId || null,
      kind: str(body.kind) || null,
      limit: int(body.limit, 100, 1, 500),
    })
    return { ok: true, runId: run?.runId ?? null, findings: rows }
  },

  /** 检索：页面优先 + 原文成组；asOf 查「某个时点上成立的说法」。 */
  search(state, body) {
    const db = state.store.get()
    const q = str(body.q)
    if (!q) throw new Error('缺少查询词 q')
    const result = searchWiki(db, q, {
      limit: int(body.limit, 8, 1, 20),
      asOf: str(body.asOf) || null,
      projectId: str(body.projectId) || null,
      raw: body.raw !== false,
    })
    return { ok: true, ...result }
  },

  /**
   * 问答：先用检索把证据取回来，再把「结论 + 凭据」拼成回答。
   * 没配模型时这是规则组装（不编造）：只复述检索到的页面摘要与原文片段，并明确标注来源。
   */
  ask(state, body) {
    const db = state.store.get()
    const q = str(body.q)
    if (!q) throw new Error('缺少问题 q')
    const asOf = str(body.asOf) || null
    const result = searchWiki(db, q, { limit: int(body.limit, 5, 1, 10), asOf, projectId: str(body.projectId) || null, raw: true })
    const lines = []
    if (result.results.length === 0 && result.raw.length === 0) {
      lines.push('知识库里没有找到相关内容。可以先在「记录」里补一条来源，或换几个关键词再查。')
    }
    for (const page of result.results) {
      lines.push(`### ${page.title}`)
      if (page.summary) lines.push(page.summary)
      for (const claim of (page.claims || []).slice(0, 4)) lines.push(`- ${claim.statement}`)
      const quotes = (page.evidence || []).filter((item) => item.quote).slice(0, 3)
      if (quotes.length > 0) {
        lines.push('')
        for (const quote of quotes) lines.push(`> ${quote.quote}`)
      }
      lines.push('')
      lines.push(`出处：\`${page.path}\`${asOf ? `（时点 ${asOf}）` : ''}`)
      lines.push('')
    }
    if (result.raw.length > 0) {
      lines.push('### 原文片段')
      for (const item of result.raw.slice(0, 3)) lines.push(`- [${item.role || item.kind}] ${String(item.excerpt).replace(/\n/gu, ' ')}`)
    }
    // degraded 指「没有配模型，答案由规则拼装」；insufficient 指「没命中任何页面」——两件事不能混用
    const model = modelInfo(state)
    const insufficient = result.results.length === 0
    const answer = lines.join('\n').trim()
    if (body.save === true && result.results.length > 0) {
      // 保存成 answers 页这一步仍走人工审核：只生成补丁，不直接写页
      return {
        ok: true, question: q, asOf, answer, saved: false,
        note: '答案页的落库需要人工确认（先出现在待审队列里）',
        sources: result.results.map((page) => ({ pageId: page.pageId, path: page.path, title: page.title })),
        degraded: model.degraded,
        insufficient,
        search: { mode: result.mode, total: result.total, truncated: result.truncated, bytes: result.bytes },
      }
    }
    return {
      ok: true,
      question: q,
      asOf,
      answer,
      degraded: model.degraded,
      insufficient,
      sources: result.results.map((page) => ({ pageId: page.pageId, path: page.path, title: page.title })),
      raw: result.raw,
      search: { mode: result.mode, total: result.total, truncated: result.truncated, bytes: result.bytes },
    }
  },

  /** 页面反馈：useful / irrelevant / wrong，影响之后排序。 */
  pageFeedback(state, body) {
    const db = state.store.get()
    const pageId = str(body.pageId)
    const verdict = str(body.verdict)
    if (!pageId) throw new Error('缺少 pageId')
    if (!['useful', 'irrelevant', 'wrong'].includes(verdict)) throw new Error(`未知反馈：${verdict}`)
    db.prepare(`INSERT INTO page_feedback (id, page_id, verdict, note, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(ulid(), pageId, verdict, str(body.note), nowIso())
    return { ok: true, pageId, verdict }
  },

  /** v2 概览：页面/主张/补丁/体检/待编译。 */
  wikiOverview(state, body) {
    const db = state.store.get()
    const projectId = str(body.projectId) || null
    const pages = pageStats(db, { projectId })
    const claims = claimCounts(db, { projectId })
    const patches = queueCounts(db)
    const run = latestRun(db)
    const lintCounts = {}
    if (run) {
      for (const row of all(db, 'SELECT kind, COUNT(*) AS n FROM lint_findings WHERE run_id = ? GROUP BY kind', [run.runId])) {
        lintCounts[row.kind] = Number(row.n)
      }
    }
    return {
      ok: true,
      pages,
      claims,
      patches,
      pendingSources: pendingCount(db, { projectId }),
      lint: { runId: run?.runId ?? null, at: run?.at ?? null, counts: lintCounts },
      model: modelInfo(state),
    }
  },
}
