// lib/capture.mjs — 会话即采集（spec §8）。
//
// 监听宿主事件 session/event，把一轮对话落成 L1 sources：
//   · user/message          → kind='dsh-turn' role='user'
//   · assistant/message     → kind='dsh-turn' role='assistant'（按 turn/step 覆盖式缓冲，取最终消息）
//   · tool/call + tool/result → kind='dsh-tool'（只存工具名 + 参数摘要 + 结果摘要，上限 4KB）
//   · turn/end              → 5s 去抖后写一条 meta.role='summary' 的汇总快照
//
// 硬约束：同步写库（node:sqlite 同步 API），不 await、不阻塞会话；异常只记日志。
// 去重：ux_sources_locator(locator, content_sha256) + INSERT OR IGNORE。
// 不采：模型思考、系统提示词、密钥（含密钥特征的片段改写为 [REDACTED]）。
import { projectIdOf, sha256Hex, ulid, nowIso } from './ids.mjs'
import { messageText, splitMarkdown, summarizeBytes, bytesOf } from './text.mjs'
import { run } from './db.mjs'
import { indexDoc, l1Title } from './indexer.mjs'

/** 单轮直存上限（spec §8：单轮 ≤8KB 直存，>8KB 按 Markdown 标题切段）。 */
export const TURN_MAX_BYTES = 8 * 1024
/** 汇总快照去抖窗口（spec G1：会话结束 5s 内可见）。 */
export const SUMMARY_DEBOUNCE_MS = 5000

// 密钥特征：命中即改写，绝不落库（spec §8「不采密钥」）
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
]

/** 把疑似密钥片段替换成 [REDACTED:长度]。 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  let hits = 0
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      hits += 1
      return `[REDACTED:${match.length}]`
    })
  }
  return { text: out, redacted: hits }
}

/** 写一条 L1。返回 { inserted, id }；重复（同 locator + 同内容）时 inserted=false。 */
export function insertSource(db, row) {
  const content = String(row.content ?? '')
  const contentSha = sha256Hex(content)
  const id = ulid()
  const result = run(
    db,
    `INSERT OR IGNORE INTO sources
       (id, kind, role, project_id, session_id, turn, step, locator, part, content, content_sha256, meta, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      row.kind,
      row.role ?? null,
      row.projectId ?? 'manual',
      row.sessionId ?? null,
      row.turn ?? null,
      row.step ?? null,
      row.locator,
      row.part ?? 0,
      content,
      contentSha,
      JSON.stringify(row.meta ?? {}),
      row.createdAt ?? nowIso(),
    ],
  )
  const inserted = Number(result.changes) > 0
  if (inserted) {
    // FTS 同步（幂等）：indexDoc 先删后插，重复索引不会产生双份
    try {
      indexDoc(db, { layer: 'L1', refId: id, title: l1Title(row.role, content), body: content })
    } catch { /* 索引失败不影响 L1 已落库 */ }
  }
  return { inserted, id, contentSha }
}

/** 写一条可能超长的 L1：超限按 Markdown 标题切段，locator 追加 #part=n。 */
export function insertMultipart(db, base, content) {
  const { text, redacted } = redactSecrets(content)
  const parts = splitMarkdown(text, TURN_MAX_BYTES)
  const written = []
  for (const piece of parts) {
    const locator = parts.length > 1 ? `${base.locator}#part=${piece.part}` : base.locator
    const out = insertSource(db, {
      ...base,
      locator,
      part: piece.part,
      content: piece.text,
      meta: { ...(base.meta || {}), ...(redacted > 0 ? { redacted } : {}), ...(parts.length > 1 ? { parts: parts.length } : {}) },
    })
    written.push(out)
  }
  return { parts: parts.length, inserted: written.filter((x) => x.inserted).length }
}

/**
 * 采集器：每个会话一份内存缓冲，事件到达即同步落库。
 */
export function createCapture({ getDb, getConfig, log, summaryDebounceMs = SUMMARY_DEBOUNCE_MS }) {
  /** sessionId → { projectId, currentTurn, assistants: Map<'turn:step', {text}>, tools: Map<callId, entry>, summaries: Map<turn, timer>, lastAt } */
  const sessions = new Map()
  let disposed = false
  let lastEventAt = 0
  const cfg = () => getConfig() || {}

  /** 工具名黑名单（config.captureBlocklist，逗号分隔）。 */
  function blocked(toolName) {
    const raw = String(cfg().captureBlocklist || '')
    if (raw === '') return false
    const name = String(toolName || '')
    return raw.split(',').map((x) => x.trim()).filter(Boolean)
      .some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
  }

  function sessionState(session) {
    const sessionId = String((session && session.id) || 'unknown')
    let state = sessions.get(sessionId)
    if (!state) {
      const cwd = session && session.header ? session.header.cwd : undefined
      state = {
        sessionId,
        projectId: projectIdOf(cwd),
        cwd: cwd || '',
        currentTurn: null,
        assistants: new Map(),
        tools: new Map(),
        summaries: new Map(),
        lastAt: Date.now(),
        turnCount: 0,
      }
      sessions.set(sessionId, state)
      if (sessions.size > 200) {
        // 只丢最久没动的会话缓冲（已落库的数据不受影响）
        let oldestKey = null
        let oldestAt = Infinity
        for (const [key, value] of sessions) {
          if (value.lastAt < oldestAt) { oldestAt = value.lastAt; oldestKey = key }
        }
        if (oldestKey !== null) sessions.delete(oldestKey)
      }
    }
    state.lastAt = Date.now()
    return state
  }

  function flushAssistant(db, state, turn, step) {
    const key = `${turn}:${step}`
    const buffered = state.assistants.get(key)
    if (!buffered || buffered.text.trim() === '') return 0
    const base = {
      kind: 'dsh-turn',
      role: 'assistant',
      projectId: state.projectId,
      sessionId: state.sessionId,
      turn,
      step,
      locator: `dsh-turn:${state.sessionId}:t${turn}:s${step}:assistant`,
      meta: { role: 'assistant', cwd: state.cwd },
    }
    const out = insertMultipart(db, base, buffered.text)
    state.assistants.delete(key)
    return out.inserted
  }

  function scheduleSummary(state, turn) {
    const existing = state.summaries.get(turn)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      state.summaries.delete(turn)
      if (disposed) return
      try {
        writeSummary(getDb(), state, turn)
      } catch (err) {
        log?.('warn', `汇总快照写入失败：${String((err && err.message) || err)}`)
      }
    }, summaryDebounceMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    state.summaries.set(turn, timer)
  }

  function writeSummary(db, state, turn) {
    const rows = db.prepare(
      'SELECT role, COUNT(*) AS n FROM sources WHERE session_id = ? AND turn = ? AND deleted_at IS NULL GROUP BY role',
    ).all(state.sessionId, turn)
    const parts = rows.map((row) => `${row.role}:${row.n}`).join(' / ')
    const tools = db.prepare(
      "SELECT COUNT(*) AS n FROM sources WHERE session_id = ? AND turn = ? AND kind = 'dsh-tool' AND deleted_at IS NULL",
    ).get(state.sessionId, turn)
    const content = `本轮汇总 · turn ${turn}\n- 记录数：${parts || '无'}\n- 工具调用：${Number(tools && tools.n) || 0} 次`
    insertSource(db, {
      kind: 'dsh-turn',
      role: 'summary',
      projectId: state.projectId,
      sessionId: state.sessionId,
      turn,
      locator: `dsh-summary:${state.sessionId}:t${turn}`,
      content,
      meta: { role: 'summary', cwd: state.cwd },
    })
    state.turnCount += 1
  }

  function onEvent(session, event) {
    if (disposed) return 0
    if (!event || typeof event !== 'object') return 0
    if (cfg().captureEnabled === false) return 0
    lastEventAt = Date.now()
    const data = event.data || {}
    const state = sessionState(session)

    try {
      const db = getDb()
      switch (event.type) {
        case 'turn/start': {
          state.currentTurn = typeof data.turn === 'number' ? data.turn : null
          return 0
        }
        case 'user/message': {
          const text = messageText(data)
          if (text.trim() === '') return 0
          const turn = state.currentTurn
          return insertMultipart(db, {
            kind: 'dsh-turn',
            role: 'user',
            projectId: state.projectId,
            sessionId: state.sessionId,
            turn,
            locator: `dsh-turn:${state.sessionId}:t${turn}:user`,
            meta: { role: 'user', cwd: state.cwd },
          }, text).inserted
        }
        case 'assistant/message': {
          const turn = typeof data.turn === 'number' ? data.turn : state.currentTurn
          const step = typeof data.step === 'number' ? data.step : 0
          const text = messageText(data.message ?? data)
          if (text.trim() === '') return 0
          const key = `${turn}:${step}`
          const buffered = state.assistants.get(key)
          // stream 为真表示这是流式增量：追加；否则视为完整最终消息：覆盖
          if (data.stream && buffered) buffered.text += text
          else state.assistants.set(key, { text })
          // 步骤结束才落库，避免把半截流式文本写进 L1
          if (data.interrupted) return flushAssistant(db, state, turn, step)
          return 0
        }
        case 'step/end': {
          const turn = typeof data.turn === 'number' ? data.turn : state.currentTurn
          const step = typeof data.step === 'number' ? data.step : 0
          return flushAssistant(db, state, turn, step)
        }
        case 'turn/end': {
          const turn = typeof data.turn === 'number' ? data.turn : state.currentTurn
          for (const key of [...state.assistants.keys()]) {
            const [t, s] = key.split(':').map(Number)
            flushAssistant(db, state, t, s)
          }
          scheduleSummary(state, turn)
          return 0
        }
        case 'tool/call': {
          const callId = String(data.callId ?? '')
          if (callId === '') return 0
          const toolName = String(data.name ?? 'unknown')
          if (blocked(toolName)) {
            state.tools.set(callId, null)
            return 0
          }
          state.tools.set(callId, {
            name: toolName,
            arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? ''),
            turn: typeof data.turn === 'number' ? data.turn : state.currentTurn,
            step: typeof data.step === 'number' ? data.step : 0,
          })
          return 0
        }
        case 'tool/result': {
          const callId = String(data.callId ?? (data.message && data.message.toolCallId) ?? '')
          const pending = callId !== '' ? state.tools.get(callId) : undefined
          if (callId !== '') state.tools.delete(callId)
          // 参数阶段已被黑名单挡掉（占位 null）→ 结果也不采
          if (pending === null) return 0
          const resultText = messageText(data.message ?? data) || (data.error ? JSON.stringify(data.error) : '')
          const maxBytes = Math.max(256, Number(cfg().captureMaxToolBytes) || 4096)
          const args = summarizeBytes(pending ? pending.arguments : '', Math.floor(maxBytes / 2))
          const result = summarizeBytes(resultText, Math.floor(maxBytes / 2))
          const turn = pending ? pending.turn : state.currentTurn
          const content = [
            `工具：${pending ? pending.name : 'unknown'}`,
            `参数摘要：${args.text || '(空)'}`,
            `结果摘要：${result.text || '(空)'}`,
            data.error ? `错误：${JSON.stringify(data.error)}` : '',
          ].filter(Boolean).join('\n')
          const out = insertSource(db, {
            kind: 'dsh-tool',
            role: 'tool',
            projectId: state.projectId,
            sessionId: state.sessionId,
            turn,
            step: pending ? pending.step : 0,
            locator: `dsh-tool:${state.sessionId}:${callId || ulid()}`,
            content: summarizeBytes(content, maxBytes).text,
            meta: {
              tool: pending ? pending.name : 'unknown',
              argsTruncated: args.truncated,
              resultTruncated: result.truncated,
              cwd: state.cwd,
            },
          })
          return out.inserted ? 1 : 0
        }
        default:
          return 0
      }
    } catch (err) {
      log?.('warn', `采集失败（${event.type}）：${String((err && err.message) || err)}`)
      return 0
    }
  }

  return {
    onEvent,
    /** 最近一次会话事件时间（提炼调度用它判断「会话是否进行中」，spec §9 禁止会话进行中提炼）。 */
    lastActivity: () => lastEventAt,
    stats() {
      return {
        sessions: sessions.size,
        pendingAssistants: [...sessions.values()].reduce((sum, s) => sum + s.assistants.size, 0),
        pendingTools: [...sessions.values()].reduce((sum, s) => sum + s.tools.size, 0),
      }
    },
    dispose() {
      disposed = true
      for (const state of sessions.values()) {
        for (const timer of state.summaries.values()) clearTimeout(timer)
        state.summaries.clear()
      }
      sessions.clear()
    },
  }
}

/** 手工录入一条 L1（降级路径 / 面板「记录」里的补录）。 */
export function recordManual(db, { projectId, title, content, sessionId = null }) {
  const body = String(content ?? '')
  if (body.trim() === '') throw new Error('内容不能为空')
  const locator = `manual:${projectId}:${sha256Hex(`${title || ''}|${body}`).slice(0, 16)}`
  return insertMultipart(db, {
    kind: 'manual',
    role: 'manual',
    projectId: projectId || 'manual',
    sessionId,
    locator,
    meta: { role: 'manual', title: title || '', bytes: bytesOf(body) },
  }, body)
}
