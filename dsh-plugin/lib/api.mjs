// lib/api.mjs — /api-llm-wiki/* 的业务处理（与 HTTP 解耦，便于单测）。
//
// 每个处理器签名：(state, body) => payload；抛错由 routes 统一转 500。
// 所有 handler 都在 host 进程内跑，路径校验必须自己做（spec §14）。
//
// v2（docs/DSH_WIKI_SPEC.md）的页面/补丁/体检/问答处理器在 lib/wiki-api.mjs，
// 末尾合并进同一个 handlers 对象——路由表只认名字，不关心实现在哪个文件。
import { all, get, counts, listPolicies } from './db.mjs'
import { search } from './retrieval.mjs'
import { ftsCount, rebuildFts, centralityMap } from './indexer.mjs'
import { recordManual } from './capture.mjs'
import { bytesOf } from './text.mjs'
import { queue, queueCounts, decide, history, undoLast, loadTarget, citationsOf } from './review.mjs'
import { writeNote, rebaselineNote, rebuildIndex, listNotes, listWrites, vaultStatus, projectNameOf, slugOf, noteRelPath } from './vault.mjs'
import { runPipeline, pipelineState, pendingCount } from './pipeline.mjs'
import { fsck } from './fsck.mjs'
import { wikiHandlers } from './wiki-api.mjs'

const str = (value, fallback = '') => (typeof value === 'string' && value !== '' ? value : fallback)
const int = (value, fallback, min, max) => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 统一的项目标签（project_id → 可读的 cwd）。 */
export function projectLabel(db, projectId) {
  const row = get(db, 'SELECT meta FROM sources WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', [projectId])
  if (!row) return projectId
  try {
    const meta = JSON.parse(row.meta || '{}')
    return str(meta.cwd, projectId)
  } catch {
    return projectId
  }
}

/** 项目列表（面板左上的范围选择器用）。 */
export function projects(db) {
  const rows = all(
    db,
    `SELECT project_id AS projectId, COUNT(*) AS n, MAX(created_at) AS lastAt
       FROM sources WHERE deleted_at IS NULL GROUP BY project_id ORDER BY lastAt DESC`,
  )
  return rows.map((row) => ({ ...row, n: Number(row.n), label: projectLabel(db, row.projectId) }))
}

export const handlers = {
  /** 面板总览：计数、降级状态、库位置。 */
  overview(state) {
    const db = state.store.get()
    const config = state.getConfig()
    return {
      ok: true,
      version: state.version,
      uptimeMs: Date.now() - state.startedAt,
      db: { file: state.store.file(), open: true, fts: ftsCount(db) },
      counts: counts(db),
      projects: projects(db),
      policies: listPolicies(db),
      config,
      vault: vaultStatus(config.vaultPath),
      queue: queueCounts(db),
      pipeline: pipelineState(db, { config }),
      model: {
        configured: str(config.pipelineModel) !== '',
        mode: str(config.pipelineModel) === '' ? 'rules' : 'model',
      },
      degraded: str(config.pipelineModel) === '',
      // 自检通道：浏览器半的 hello / ping 记录（诊断「面板到底加载了没」）。
      client: {
        hello: state.clientHello,
        pings: state.pings,
        events: (state.clientEvents || []).slice(-5),
      },
    }
  },

  /** L1 记录列表（「记录」视图）。 */
  sources(state, body) {
    const db = state.store.get()
    const limit = int(body.limit, 50, 1, 200)
    const offset = int(body.offset, 0, 0, 100000)
    const where = ['deleted_at IS NULL']
    const params = []
    if (str(body.projectId)) { where.push('project_id = ?'); params.push(body.projectId) }
    if (str(body.sessionId)) { where.push('session_id = ?'); params.push(body.sessionId) }
    if (str(body.role)) { where.push('role = ?'); params.push(body.role) }
    if (str(body.kind)) { where.push('kind = ?'); params.push(body.kind) }
    if (str(body.q)) { where.push('content LIKE ?'); params.push(`%${body.q}%`) }
    const clause = where.join(' AND ')
    const rows = all(
      db,
      `SELECT id, kind, role, project_id AS projectId, session_id AS sessionId, turn, step, locator, part,
              content, content_sha256 AS contentSha, meta, created_at AS createdAt
         FROM sources WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = get(db, `SELECT COUNT(*) AS n FROM sources WHERE ${clause}`, params)
    return {
      ok: true,
      total: total ? Number(total.n) : 0,
      limit,
      offset,
      items: rows.map((row) => ({
        ...row,
        bytes: bytesOf(row.content),
        meta: safeJson(row.meta),
      })),
    }
  },

  /** 检索（spec §10 全流程）。 */
  search(state, body) {
    const db = state.store.get()
    const query = str(body.q)
    if (query.trim() === '') return { ok: true, empty: true, results: [], total: 0, mode: 'empty' }
    const config = state.getConfig()
    const result = search(db, query, {
      limit: int(body.limit, Math.max(1, config.retrievalMaxResults), 1, 20),
      projectId: str(body.projectId) || null,
      weights: {
        text: Number(config.retrievalWeightText),
        recency: Number(config.retrievalWeightRecency),
        centrality: Number(config.retrievalWeightCentrality),
      },
    })
    return { ok: true, ...result }
  },

  /** 手工补录一条 L1（降级路径）。 */
  record(state, body) {
    const db = state.store.get()
    const content = str(body.content)
    if (content.trim() === '') throw new Error('内容不能为空')
    const projectId = str(body.projectId) || 'manual'
    const result = recordManual(db, {
      projectId,
      title: str(body.title),
      content,
      sessionId: str(body.sessionId) || null,
    })
    return { ok: true, ...result }
  },

  /** 项目列表。 */
  projects(state) {
    const db = state.store.get()
    return { ok: true, items: projects(db) }
  },

  /** policies 读写（行为开关）。 */
  policies(state, body) {
    const db = state.store.get()
    if (body.key !== undefined) {
      const key = str(body.key)
      if (key === 'autoWrite' && body.value === true) {
        throw new Error('autoWrite 永不允许打开：写入必须经人工审核（spec §13）')
      }
      state.store.setPolicy(key, String(body.value))
    }
    return { ok: true, policies: listPolicies(db) }
  },

  /** 健康检查（GET 也可用）。 */
  health(state) {
    return {
      ok: true,
      version: state.version,
      uptimeMs: Date.now() - state.startedAt,
      vaultPath: state.getConfig().vaultPath,
      captureEnabled: state.getConfig().captureEnabled,
      db: state.store.isOpen() ? 'open' : 'pending',
      dbError: state.store.error(),
      capture: state.capture ? state.capture.stats() : null,
      pings: state.pings,
    }
  },

  // ---------------------------------------------------------------- 审核队列
  /** 待审列表（L2 + L3 合并，uncertain 优先）。 */
  queue(state, body) {
    const db = state.store.get()
    return {
      ok: true,
      ...queue(db, {
        layer: str(body.layer) || null,
        status: str(body.status, 'candidate'),
        projectId: str(body.projectId) || null,
        limit: int(body.limit, 30, 1, 200),
        offset: int(body.offset, 0, 0, 100000),
      }),
    }
  },

  /** 单条详情（含引用与裁定历史）。 */
  item(state, body) {
    const db = state.store.get()
    const layer = str(body.layer)
    const id = str(body.id)
    const target = loadTarget(db, layer, id)
    if (!target) throw new Error(`找不到 ${layer} 记录：${id}`)
    return {
      ok: true,
      layer,
      item: { ...target, citations: citationsOf(db, layer, id), history: history(db, layer, id) },
    }
  },

  /** 裁定：accept / discard / defer / edit。 */
  review(state, body) {
    const db = state.store.get()
    const result = decide(db, {
      layer: str(body.layer),
      id: str(body.id),
      action: str(body.action),
      after: body.after && typeof body.after === 'object' ? body.after : null,
      actor: str(body.actor, 'human'),
    })
    return { ok: true, ...result, queue: queueCounts(db) }
  },

  /** 撤销最近一次裁定（面板 3 秒撤销）。 */
  reviewUndo(state, body) {
    const db = state.store.get()
    const result = undoLast(db, { layer: str(body.layer), id: str(body.id) })
    return { ok: true, ...result, queue: queueCounts(db) }
  },

  /** 裁定历史（时间线）。 */
  reviews(state, body) {
    const db = state.store.get()
    return { ok: true, items: history(db, str(body.layer), str(body.id), int(body.limit, 20, 1, 100)) }
  },

  // ---------------------------------------------------------------- 写入 vault
  /** 预览：这条会写到哪儿（不落盘）。 */
  preview(state, body) {
    const db = state.store.get()
    const layer = str(body.layer)
    const id = str(body.id)
    const target = loadTarget(db, layer, id)
    if (!target) throw new Error(`找不到 ${layer} 记录：${id}`)
    const projectId = target.project_id
    const projectName = projectNameOf(db, projectId)
    const rel = noteRelPath({ projectName, projectId, kind: target.kind, slug: slugOf(target.title, target.id) })
    const existing = get(db, 'SELECT MAX(revision) AS rev FROM notes WHERE path = ?', [rel.split('\\').join('/')])
    return {
      ok: true,
      path: rel.split('\\').join('/'),
      project: projectName,
      nextRevision: existing && existing.rev ? Number(existing.rev) + 1 : 1,
      writable: target.status === 'approved',
      reason: target.status === 'approved' ? null : '只有 approved 的记录能写入',
      citations: citationsOf(db, layer, id).length,
    }
  },

  /** 写入一条 approved 记录（vault 只增 revision）。 */
  write(state, body) {
    const db = state.store.get()
    const config = state.getConfig()
    const layer = str(body.layer)
    const id = str(body.id)
    const result = writeNote(db, { layer, id, vaultPath: config.vaultPath, language: config.writeLanguage })
    if (result.ok && result.changed) {
      try { rebuildIndex(db, { vaultPath: config.vaultPath }) } catch (err) {
        state.log?.('warn', `索引重算失败：${String((err && err.message) || err)}`)
      }
    }
    return { ok: true, ...result, notes: listNotes(db, { limit: 20 }) }
  },

  /** 已知笔记 / 写入历史。 */
  notes(state) {
    const db = state.store.get()
    return { ok: true, items: listNotes(db, { limit: 200 }), vault: vaultStatus(state.getConfig().vaultPath) }
  },

  writes(state) {
    const db = state.store.get()
    return { ok: true, items: listWrites(db, { limit: 100 }) }
  },

  /**
   * 解决 vault 冲突：人类在 Obsidian 里改过文件后，把 notes 的 sha 对齐到磁盘现状，
   * 之后的新写入从「人类这一版」继续只增 revision（不覆盖、不丢人的手改）。
   */
  resolve(state, body) {
    const db = state.store.get()
    const config = state.getConfig()
    const result = rebaselineNote(db, { path: str(body.path), vaultPath: config.vaultPath })
    return { ok: true, ...result, notes: listNotes(db, { limit: 20 }) }
  },

  /** 手动重算索引（面板设置里的维护动作）。 */
  reindex(state) {
    const db = state.store.get()
    const result = rebuildIndex(db, { vaultPath: state.getConfig().vaultPath })
    return { ok: true, ...result }
  },

  // ---------------------------------------------------------------- 提炼
  /** 提炼状态；带 run=true 时立即跑一轮。 */
  pipeline(state, body) {
    const db = state.store.get()
    const config = state.getConfig()
    if (body.run === true) {
      const result = runPipeline(db, { config, log: state.log, projectId: str(body.projectId) || null, force: true })
      return { ok: true, ran: result, state: pipelineState(db, { config }) }
    }
    return { ok: true, state: pipelineState(db, { config }), pending: pendingCount(db) }
  },

  // ---------------------------------------------------------------- 维护
  /** 不变量自检；rebuild=true 时先重建 FTS。 */
  fsck(state, body) {
    const db = state.store.get()
    const config = state.getConfig()
    if (body.rebuild === true) rebuildFts(db)
    const result = fsck(db, { vaultPath: config.vaultPath })
    return { ok: true, ...result }
  },

  /** 图谱：节点度 + 最近边（M3 图谱视图的数据源）。 */
  graph(state, body) {
    const db = state.store.get()
    const limit = int(body.limit, 80, 1, 400)
    const degree = centralityMap(db)
    const edges = all(
      db,
      `SELECT from_layer AS fromLayer, from_id AS fromId, to_layer AS toLayer, to_id AS toId, kind
         FROM edges ORDER BY created_at DESC LIMIT ?`,
      [limit],
    )
    return { ok: true, edges, degree }
  },

  /** 检索反馈（一次点击 = 一条信号）。 */
  feedback(state, body) {
    const db = state.store.get()
    const layer = str(body.layer)
    const id = str(body.id)
    const signal = str(body.signal, 'useful')
    db.prepare('INSERT INTO feedback (id, target_layer, target_id, signal, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, layer, id, signal, str(body.note) || null, new Date().toISOString())
    return { ok: true }
  },

  ping(state, body) {
    state.pings += 1
    state.log?.('info', `客户端心跳 #${state.pings}（from=${str(body.from, 'unknown')}）`)
    return { ok: true, pings: state.pings, serverTime: new Date().toISOString() }
  },

  clientHello(state, body) {
    const event = { at: new Date().toISOString(), ...body }
    state.clientHello = event
    if (!Array.isArray(state.clientEvents)) state.clientEvents = []
    state.clientEvents.push(event)
    if (state.clientEvents.length > 50) state.clientEvents.shift()
    return { ok: true, ...handlers.health(state) }
  },
}

function safeJson(text) {
  try { return JSON.parse(String(text || '{}')) } catch { return {} }
}

// v2（页面 → 主张 → 补丁 → 体检 → 问答）的处理器并进来。
// 与 v1 同名的两个（search / overview）不覆盖：v1 的语义被现有测试与「记录」视图依赖，
// v2 的版本另取名字暴露在 /wiki-search 与 /wiki-overview。
for (const [name, fn] of Object.entries(wikiHandlers)) {
  if (name === 'search' || name === 'wikiOverview') continue
  handlers[name] = fn
}
handlers.wikiSearch = wikiHandlers.search
handlers.wikiOverview = wikiHandlers.wikiOverview
