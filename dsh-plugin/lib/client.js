// lib/client.js — LLM Wiki v2 浏览器半（docs/DSH_WIKI_SPEC.md §7）。
//
// 约束：只 require('react')；视觉一律 var(--dsw-*)；不碰数据库（数据全走 /api-llm-wiki/*）；
// 槽位一律 ctx.slots.inject 惰性注册；不用 React Router，视图状态在组件内。
//
// 六个视图：审核（补丁队列，人的闸门）· 页面（L3 页面 + 主张 + 证据）· 检索（页面优先 + 问答）
//          · 记录（L1 来源 + 手工补录）· 洞察（矛盾/过时/孤岛/坏引用）· 设置。
window.__ModuleLoader__.load({
  id: 'dsh-llm-wiki',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const API = '/api-llm-wiki'
    const STYLE_ID = 'llm-wiki-styles'
    const PANEL_ID = 'llm-wiki'

    // ───────────────────────────── 样式（只用宿主 token） ─────────────────────────────
    const CSS = `
.lw-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-bg-base); color: var(--dsw-label-primary);
  font: var(--dsw-font-s-14, 14px/20px system-ui, sans-serif); }
.lw-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px;
  border-bottom: 1px solid var(--dsw-border-l1); }
.lw-title { font-size: var(--dsw-font-l-16, 16px); font-weight: 600; letter-spacing: 0.2px; }
.lw-sub { color: var(--dsw-label-secondary); font-size: var(--dsw-font-s-12, 12px); }
.lw-spacer { flex: 1; }
.lw-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px;
  border: 1px solid var(--dsw-border-l1); border-radius: var(--dsw-radius-md, 6px);
  color: var(--dsw-label-secondary); font-size: var(--dsw-font-s-12, 12px); }
.lw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-state-idle-primary); }
.lw-dot.ok { background: var(--dsw-state-success-primary); }
.lw-dot.warn { background: var(--dsw-state-warn-primary); }
.lw-dot.bad { background: var(--dsw-state-error-primary); }
.lw-body { display: flex; flex: 1; min-height: 0; }
.lw-nav { width: 168px; flex: none; padding: 10px 8px; border-right: 1px solid var(--dsw-border-l1);
  display: flex; flex-direction: column; gap: 2px; background: var(--dsw-bg-layer-1); }
.lw-nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 6px);
  color: var(--dsw-label-secondary); cursor: pointer; border: none; background: transparent; text-align: left;
  font: inherit; width: 100%; }
.lw-nav-item:hover { background: var(--dsw-bg-layer-2); color: var(--dsw-label-primary); }
.lw-nav-item.on { background: var(--dsw-bg-layer-2); color: var(--dsw-label-primary); font-weight: 600; }
.lw-nav-count { margin-left: auto; font-size: var(--dsw-font-s-12, 12px); color: var(--dsw-brand-primary); }
.lw-main { flex: 1; min-width: 0; overflow: auto; padding: 16px 18px 40px; }
.lw-split { display: flex; gap: 16px; min-height: 0; }
.lw-list { width: 320px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.lw-card { border: 1px solid var(--dsw-border-l1); border-radius: var(--dsw-radius-lg, 10px);
  padding: 10px 12px; background: var(--dsw-bg-layer-1); cursor: pointer; }
.lw-card:hover { border-color: var(--dsw-border-l2); }
.lw-card.on { border-color: var(--dsw-brand-primary); }
.lw-detail { flex: 1; min-width: 0; border: 1px solid var(--dsw-border-l1); border-radius: var(--dsw-radius-lg, 10px);
  padding: 14px 16px; background: var(--dsw-bg-layer-1); }
.lw-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lw-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: var(--dsw-font-s-12, 12px);
  border: 1px solid var(--dsw-border-l1); color: var(--dsw-label-secondary); }
.lw-chip.accent { color: var(--dsw-brand-primary); border-color: var(--dsw-brand-primary); }
.lw-chip.warn { color: var(--dsw-state-warn-primary); border-color: var(--dsw-state-warn-primary); }
.lw-chip.err { color: var(--dsw-state-error-primary); border-color: var(--dsw-state-error-primary); }
.lw-chip.ok { color: var(--dsw-state-success-primary); border-color: var(--dsw-state-success-primary); }
.lw-btn { padding: 6px 12px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-border-l1);
  background: var(--dsw-bg-layer-2); color: var(--dsw-label-primary); font: inherit; cursor: pointer; }
.lw-btn:hover { border-color: var(--dsw-border-l2); }
.lw-btn.primary { background: var(--dsw-brand-primary); color: var(--dsw-bg-base); border-color: var(--dsw-brand-primary); }
.lw-btn.danger { color: var(--dsw-state-error-primary); }
.lw-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.lw-input { width: 100%; padding: 7px 10px; border-radius: var(--dsw-radius-md, 6px);
  border: 1px solid var(--dsw-border-l1); background: var(--dsw-bg-base); color: var(--dsw-label-primary); font: inherit; }
.lw-input:focus { outline: none; border-color: var(--dsw-brand-primary); }
.lw-textarea { width: 100%; min-height: 120px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 6px);
  border: 1px solid var(--dsw-border-l1); background: var(--dsw-bg-base); color: var(--dsw-label-primary);
  font: var(--dsw-font-mono-13, 13px/20px ui-monospace, monospace); resize: vertical; }
.lw-pre { margin: 0; padding: 10px 12px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-bg-base);
  border: 1px solid var(--dsw-border-l1); white-space: pre-wrap; word-break: break-word;
  font: var(--dsw-font-mono-13, 13px/20px ui-monospace, monospace); color: var(--dsw-label-primary); }
.lw-muted { color: var(--dsw-label-secondary); font-size: var(--dsw-font-s-12, 12px); }
.lw-h2 { font-size: var(--dsw-font-m-15, 15px); font-weight: 600; margin: 0 0 8px; }
.lw-h3 { font-size: var(--dsw-font-s-14, 14px); font-weight: 600; margin: 16px 0 6px; }
.lw-sec { margin-bottom: 18px; }
.lw-table { width: 100%; border-collapse: collapse; font-size: var(--dsw-font-s-13, 13px); }
.lw-table th, .lw-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-border-l1);
  vertical-align: top; }
.lw-table th { color: var(--dsw-label-secondary); font-weight: 500; }
.lw-kv { display: grid; grid-template-columns: 180px 1fr; gap: 6px 12px; font-size: var(--dsw-font-s-13, 13px); }
.lw-kv dt { color: var(--dsw-label-secondary); }
.lw-kv dd { margin: 0; word-break: break-word; }
.lw-empty { padding: 28px 8px; color: var(--dsw-label-secondary); text-align: center; }
.lw-empty strong { display: block; color: var(--dsw-label-primary); font-weight: 600; margin-bottom: 6px; }
.lw-skeleton { height: 54px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-border-l1);
  background: linear-gradient(90deg, var(--dsw-bg-layer-1), var(--dsw-bg-layer-2), var(--dsw-bg-layer-1));
  background-size: 200% 100%; animation: lw-shimmer 1.4s ease-in-out infinite; margin-bottom: 8px; }
@keyframes lw-shimmer { 0% { background-position: 0 0; } 100% { background-position: 200% 0; } }
.lw-error { border: 1px solid var(--dsw-state-error-primary); border-radius: var(--dsw-radius-md, 6px);
  padding: 10px 12px; margin: 8px 0; background: var(--dsw-bg-layer-1); }
.lw-error-title { color: var(--dsw-state-error-primary); font-weight: 600; margin-bottom: 4px; }
.lw-toast { position: sticky; bottom: 12px; margin-top: 14px; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--dsw-border-l2); border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-bg-overlay); }
.lw-quote { border-left: 2px solid var(--dsw-border-l2); padding-left: 10px; margin: 6px 0;
  color: var(--dsw-label-secondary); }
.lw-kbd { display: inline-block; padding: 0 5px; border: 1px solid var(--dsw-border-l1);
  border-radius: var(--dsw-radius-sm, 4px); font-size: var(--dsw-font-s-11, 11px); color: var(--dsw-label-secondary); }
.lw-score { display: inline-flex; gap: 6px; font-size: var(--dsw-font-s-12, 12px); color: var(--dsw-label-secondary); }
.lw-page-body { white-space: pre-wrap; font: var(--dsw-font-s-13, 13px/21px system-ui, sans-serif); }
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ───────────────────────────── 传输与工具 ─────────────────────────────
    async function request(method, path, body) {
      const init = { method, headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body || {})
      }
      const res = await fetch(API + path, init)
      const payload = await res.json().catch(() => ({}))
      if (!res.ok || payload.ok === false) {
        const error = new Error(payload.error || `${method} ${path} 失败（${res.status}）`)
        error.status = res.status
        throw error
      }
      return payload
    }
    const post = (path, body) => request('POST', path, body || {})

    function clampText(text, max) {
      const value = String(text == null ? '' : text)
      const limit = Math.max(0, Number(max) || 0)
      if (value.length <= limit) return { text: value, clipped: false }
      return { text: `${value.slice(0, limit)}…`, clipped: true }
    }

    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / (1024 * 1024)).toFixed(2)} MB`
    }

    function formatTime(iso) {
      const text = String(iso || '')
      const date = new Date(text)
      if (!text || Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 审核队列的键盘映射（J/K 移动、A/D/S 裁定、W 落文件、Enter 展开、Esc 收起）。 */
    function keyToAction(event) {
      if (!event || event.ctrlKey || event.metaKey || event.altKey) return null
      const key = String(event.key || '')
      if (key === 'j' || key === 'J' || key === 'ArrowDown') return 'next'
      if (key === 'k' || key === 'K' || key === 'ArrowUp') return 'prev'
      if (key === 'a' || key === 'A') return 'accept'
      if (key === 'd' || key === 'D') return 'discard'
      if (key === 's' || key === 'S') return 'defer'
      if (key === 'e' || key === 'E') return 'edit'
      if (key === 'w' || key === 'W') return 'write'
      if (key === 'Enter') return 'expand'
      if (key === 'Escape') return 'back'
      return null
    }

    function nextIndex(current, total, action) {
      if (total <= 0) return 0
      const i = action === 'prev' ? Math.max(0, Number(current) - 1) : Number(current)
      return Math.min(Math.max(0, i), total - 1)
    }

    const KIND_LABELS = {
      concept: '概念', decision: '决策', entity: '实体', answer: '答案', timeline: '时间线', index: '索引',
    }
    const STATUS_LABELS = {
      candidate: '待审', approved: '已落页', discarded: '已丢弃', deferred: '已暂缓', stale: '过时',
    }
    const LINT_LABELS = {
      contradiction: '矛盾', stale: '过时', orphan: '孤岛', 'missing-page': '缺页',
      'missing-link': '缺链', 'broken-quote': '坏引用', gap: '缺口',
    }

    const chip = (text, tone) => h('span', { className: `lw-chip${tone ? ` ${tone}` : ''}` }, text)
    const statusChip = (status) => chip(STATUS_LABELS[status] || status,
      status === 'approved' ? 'ok' : status === 'stale' ? 'warn' : status === 'discarded' ? 'err' : '')

    function Skeleton(props) {
      const rows = Array.from({ length: props.rows || 3 }, (_, i) => i)
      return h('div', null, rows.map((i) => h('div', { key: i, className: 'lw-skeleton' })))
    }

    function ErrorBox(props) {
      const text = String((props.error && props.error.message) || props.error || '未知错误')
      const copy = () => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
      }
      return h('div', { className: 'lw-error' },
        h('div', { className: 'lw-error-title' }, '这一步失败了'),
        h('pre', { className: 'lw-pre' }, text),
        h('div', { className: 'lw-row' },
          h('button', { className: 'lw-btn', onClick: copy, type: 'button' }, '复制错误'),
          props.onRetry ? h('button', { className: 'lw-btn', onClick: props.onRetry, type: 'button' }, '重试') : null))
    }

    function Empty(props) {
      return h('div', { className: 'lw-empty' },
        h('strong', null, props.title || '这里还没有东西'),
        h('div', null, props.hint || ''),
        props.action ? h('div', { style: { marginTop: 10 } }, props.action) : null)
    }

    function Toast(props) {
      if (!props.toast) return null
      return h('div', { className: 'lw-toast' },
        h('span', null, props.toast.message),
        h('span', { className: 'lw-spacer' }),
        props.toast.onUndo ? h('button', { className: 'lw-btn', type: 'button', onClick: props.toast.onUndo }, '撤销') : null,
        h('button', { className: 'lw-btn', type: 'button', onClick: props.onClose }, '知道了'))
    }

    /** 取数：POST 打 /api-llm-wiki/*，返回 {phase, data, error, reload}。 */
    function useApi(path, body, deps) {
      const bodyKey = JSON.stringify(body || {})
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [tick, setTick] = React.useState(0)
      const reload = React.useCallback(() => setTick((n) => n + 1), [])
      React.useEffect(() => {
        let alive = true
        setState((prev) => ({ phase: prev.data ? 'ok' : 'loading', data: prev.data, error: null }))
        post(path, JSON.parse(bodyKey))
          .then((data) => { if (alive) setState({ phase: 'ok', data, error: null }) })
          .catch((error) => { if (alive) setState({ phase: 'error', data: null, error }) })
        return () => { alive = false }
      }, [path, bodyKey, tick].concat(deps || []))
      return { phase: state.phase, data: state.data, error: state.error, reload }
    }

    // ───────────────────────────── 1. 审核：补丁队列 ─────────────────────────────
    function ReviewView(props) {
      const queue = useApi('/patch-queue', { limit: 40, projectId: props.projectId || null })
      const [index, setIndex] = React.useState(0)
      const [detail, setDetail] = React.useState(null)
      const [expanded, setExpanded] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const items = (queue.data && queue.data.patches) || []
      const counts = (queue.data && queue.data.counts) || {}
      const current = items[index] || null

      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 6000)
        return () => clearTimeout(timer)
      }, [toast])

      const currentId = current && current.id
      React.useEffect(() => {
        if (!currentId) { setDetail(null); return undefined }
        let alive = true
        setDetail(null)
        post('/patch', { id: currentId })
          .then((data) => { if (alive) setDetail(data) })
          .catch((error) => { if (alive) setDetail({ error: error.message }) })
        return () => { alive = false }
      }, [currentId])

      const refresh = React.useCallback(() => {
        queue.reload()
        setExpanded(false)
      }, [queue.reload])

      const act = React.useCallback(async (action) => {
        if (!current || busy) return
        setBusy(action)
        try {
          if (action === 'discard') {
            await post('/patch-review', { id: current.id, action: 'discard' })
            setToast({ message: '已丢弃这个补丁' })
          } else if (action === 'defer') {
            await post('/patch-review', { id: current.id, action: 'defer' })
            setToast({ message: '已暂缓，稍后再看' })
          } else {
            const result = await post('/patch-review', { id: current.id, action: 'accept' })
            const wrote = result.file || null
            const message = wrote
              ? (wrote.ok === false ? `已更新页面，但写入被拒：${wrote.error || '冲突'}` : `已落页：${wrote.path}`)
              : '已更新页面（未落文件）'
            setToast({
              message,
              onUndo: result.reviewId
                ? async () => {
                  try {
                    await post('/patch-undo', { reviewId: result.reviewId })
                    setToast({ message: '已撤销这次接受' })
                    refresh()
                  } catch (error) { setToast({ message: `撤销失败：${error.message}` }) }
                }
                : null,
            })
          }
          refresh()
        } catch (error) {
          setToast({ message: `失败：${error.message}` })
        } finally {
          setBusy('')
        }
      }, [current, busy, refresh])

      React.useEffect(() => {
        const onKey = (event) => {
          const tag = (event.target && event.target.tagName) || ''
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
          const action = keyToAction(event)
          if (!action) return
          if (action === 'next' || action === 'prev') {
            event.preventDefault()
            setIndex((i) => nextIndex(action === 'next' ? i + 1 : i - 1, items.length, 'next'))
          } else if (action === 'expand') {
            setExpanded((v) => !v)
          } else if (action === 'back') {
            setExpanded(false)
          } else if (action === 'write') {
            act('accept')
          } else if (action === 'accept' || action === 'discard' || action === 'defer') {
            act(action)
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [items.length, act])

      if (queue.phase === 'loading') return h(Skeleton, { rows: 4 })
      if (queue.phase === 'error') return h(ErrorBox, { error: queue.error, onRetry: queue.reload })

      return h('div', { className: 'lw-split' },
        h('div', { className: 'lw-list' },
          h('div', { className: 'lw-row' },
            h('b', null, '待审补丁'),
            h('span', { className: 'lw-muted' }, `${counts.candidate || 0} 个 · 待编译来源 ${queue.data.pendingSources || 0}`)),
          h('div', { className: 'lw-muted' },
            '一个补丁是一次页面改动。J/K 移动，A 采纳，D 丢弃，S 暂缓，W 采纳并落文件，Enter 展开全文。'),
          items.length === 0
            ? h(Empty, {
              title: '没有待审的补丁',
              hint: '有新记录时，后台会先把它们编译成「页面补丁」放到这里。',
              action: h('button', {
                className: 'lw-btn primary', type: 'button',
                onClick: () => post('/compile', { projectId: props.projectId || null })
                  .then(refresh)
                  .catch((error) => setToast({ message: error.message })),
              }, '现在编译一轮'),
            })
            : items.map((item, i) => h('div', {
              key: item.id,
              className: `lw-card${i === index ? ' on' : ''}`,
              onClick: () => setIndex(i),
            },
            h('div', { className: 'lw-row' },
              chip(KIND_LABELS[item.kind] || item.kind, 'accent'),
              h('span', { className: 'lw-muted' }, `r${item.base_revision ?? 0}`),
              item.created_at ? h('span', { className: 'lw-muted' }, formatTime(item.created_at)) : null),
            h('div', { style: { marginTop: 4, fontWeight: 600 } }, item.title || '（无标题）'),
            h('div', { className: 'lw-muted' }, item.reason || '')))),
        h('div', { className: 'lw-detail' },
          !current
            ? h('div', { className: 'lw-muted' }, '左边选一个补丁。')
            : h('div', null,
              h('div', { className: 'lw-row' },
                h('h2', { className: 'lw-h2', style: { margin: 0 } }, current.title || '（无标题）'),
                chip(KIND_LABELS[current.kind] || current.kind, 'accent'),
                h('span', { className: 'lw-muted' }, `基于 r${current.base_revision ?? 0}`)),
              h('div', { className: 'lw-muted' }, `项目 ${current.project_id} · ${current.id}`),
              detail && detail.error ? h(ErrorBox, { error: detail.error }) : null,
              detail && !detail.error
                ? h('div', null,
                  h('div', { className: 'lw-h3' }, `改动 ${(detail.ops || []).length} 处`),
                  (detail.ops || []).map((op, i) => h('div', { key: i, className: 'lw-sec' },
                    h('div', { className: 'lw-row' },
                      chip(op.op === 'claim' ? '新主张' : op.op, op.op === 'claim' ? 'accent' : ''),
                      op.section ? h('span', { className: 'lw-muted' }, `小节「${op.section}」`) : null),
                    h('div', { className: 'lw-page-body', style: { marginTop: 4 } },
                      clampText(op.text, expanded ? 4000 : 400).text),
                    (op.quotes || []).map((quote, j) => h('div', { key: j, className: 'lw-quote' },
                      `「${clampText(quote.quote, 200).text}」`)))),
                  h('div', { className: 'lw-h3' }, '证据检查'),
                  (detail.ops || []).every((op) => (op.quotes || []).length > 0)
                    ? h('div', { className: 'lw-row' }, chip('每个改动都带原文引用', 'ok'))
                    : h('div', { className: 'lw-row' }, chip('有改动没有引用，采纳后会标为待补', 'warn')),
                  h('div', { className: 'lw-row', style: { marginTop: 14 } },
                    h('button', {
                      className: 'lw-btn primary', type: 'button', disabled: busy !== '',
                      onClick: () => act('accept'),
                    }, busy === 'accept' ? '处理中…' : '采纳（A）'),
                    h('button', {
                      className: 'lw-btn', type: 'button', disabled: busy !== '',
                      onClick: () => act('defer'),
                    }, '暂缓（S）'),
                    h('button', {
                      className: 'lw-btn danger', type: 'button', disabled: busy !== '',
                      onClick: () => act('discard'),
                    }, '丢弃（D）'),
                    h('button', {
                      className: 'lw-btn', type: 'button',
                      onClick: () => setExpanded((v) => !v),
                    }, expanded ? '收起文本（Esc）' : '展开全文（Enter）')))
                : detail ? h(Skeleton, { rows: 2 }) : null)),
        h(Toast, { toast, onClose: () => setToast(null) }))
    }

    // ───────────────────────────── 2. 页面：页面 + 主张 + 证据 ─────────────────────────────
    function PageDetail(props) {
      const detail = useApi('/page', { id: props.id })
      const [toast, setToast] = React.useState(null)
      if (detail.phase === 'loading') return h(Skeleton, { rows: 4 })
      if (detail.phase === 'error') return h(ErrorBox, { error: detail.error, onRetry: detail.reload })
      const data = detail.data
      const page = data.page || {}
      const feedback = (verdict) => post('/page-feedback', { pageId: page.id, verdict })
        .then(() => setToast({ message: '已记录反馈，之后的排序会用它' }))
        .catch((error) => setToast({ message: error.message }))
      return h('div', null,
        h('div', { className: 'lw-row' },
          h('h2', { className: 'lw-h2', style: { margin: 0 } }, page.title),
          chip(KIND_LABELS[page.kind] || page.kind, 'accent'),
          statusChip(page.status),
          h('span', { className: 'lw-muted' }, `r${page.revision} · ${page.path}`),
          h('span', { className: 'lw-spacer' }),
          h('button', { className: 'lw-btn', type: 'button', onClick: props.onClose }, '返回列表')),
        h('div', { className: 'lw-muted' }, page.summary || ''),
        h('div', { className: 'lw-h3' }, `主张 ${data.claims.length} 条（t_invalid 为空表示现在仍成立）`),
        data.claims.length === 0
          ? h('div', { className: 'lw-muted' }, '这一页还没有结构化主张。')
          : h('table', { className: 'lw-table' },
            h('thead', null, h('tr', null,
              ['陈述', '主 / 谓 / 宾', '生效', '失效', '置信'].map((label) => h('th', { key: label }, label)))),
            h('tbody', null, data.claims.map((claim) => h('tr', { key: claim.id },
              h('td', null, claim.statement),
              h('td', { className: 'lw-muted' }, `${claim.subject} / ${claim.predicate} / ${claim.object}`),
              h('td', { className: 'lw-muted' }, formatTime(claim.t_valid)),
              h('td', { className: claim.t_invalid ? 'lw-muted' : '' }, claim.t_invalid ? formatTime(claim.t_invalid) : '仍成立'),
              h('td', null, String(claim.confidence ?? '—')))))),
        h('div', { className: 'lw-h3' }, `证据 ${data.citations.length} 条`),
        data.citations.length === 0
          ? h('div', { className: 'lw-row' }, chip('没有引用：这一页还不能算有据', 'warn'))
          : data.citations.map((citation) => h('div', { key: citation.id, className: 'lw-sec' },
            h('div', { className: 'lw-quote' }, `「${citation.quote}」`),
            h('div', { className: 'lw-muted' },
              `${citation.locator || citation.sourceId} · 字符 ${citation.spanStart ?? '—'}–${citation.spanEnd ?? '—'}`))),
        h('div', { className: 'lw-h3' }, '链接'),
        h('div', { className: 'lw-kv' },
          h('dt', null, '出链'), h('dd', null, data.outbound.length === 0 ? '（无）' : data.outbound.map((link) => link.title || link.toPage).join('、')),
          h('dt', null, '入链'), h('dd', null, data.inbound.length === 0 ? '（无）' : data.inbound.map((link) => link.title || link.fromPage).join('、'))),
        h('div', { className: 'lw-h3' }, '这页有用吗'),
        h('div', { className: 'lw-row' }, ['useful', 'irrelevant', 'wrong'].map((verdict) => h('button', {
          key: verdict, className: 'lw-btn', type: 'button', onClick: () => feedback(verdict),
        }, verdict === 'useful' ? '有用' : verdict === 'irrelevant' ? '不相关' : '有错'))),
        h('div', { className: 'lw-h3' }, '正文'),
        h('div', { className: 'lw-page-body' }, page.body || '（空）'),
        h(Toast, { toast, onClose: () => setToast(null) }))
    }

    function PagesView(props) {
      const [kind, setKind] = React.useState('')
      const [status, setStatus] = React.useState('')
      const list = useApi('/pages', { limit: 50, kind: kind || null, status: status || null, projectId: props.projectId || null })
      const [openId, setOpenId] = React.useState(null)
      if (list.phase === 'loading') return h(Skeleton, { rows: 4 })
      if (list.phase === 'error') return h(ErrorBox, { error: list.error, onRetry: list.reload })
      const pages = list.data.pages || []
      const stats = list.data.stats || {}
      if (openId) return h(PageDetail, { id: openId, onClose: () => setOpenId(null) })
      return h('div', null,
        h('div', { className: 'lw-row' },
          h('h2', { className: 'lw-h2', style: { margin: 0 } }, '页面'),
          h('span', { className: 'lw-muted' }, `共 ${stats.total ?? 0} 页 · 已落页 ${stats.approved ?? 0} · 待审 ${stats.candidate ?? 0}`),
          h('span', { className: 'lw-spacer' }),
          h('select', {
            className: 'lw-input', style: { width: 140 }, value: kind,
            onChange: (e) => setKind(e.target.value),
          },
          h('option', { value: '' }, '全部类型'),
          ['concept', 'decision', 'entity', 'answer'].map((k) => h('option', { key: k, value: k }, KIND_LABELS[k]))),
          h('select', {
            className: 'lw-input', style: { width: 140 }, value: status,
            onChange: (e) => setStatus(e.target.value),
          },
          h('option', { value: '' }, '全部状态'),
          ['approved', 'candidate', 'stale', 'deferred'].map((s) => h('option', { key: s, value: s }, STATUS_LABELS[s])))),
        pages.length === 0
          ? h(Empty, { title: '还没有页面', hint: '审核通过第一个补丁后，页面就会出现在这里。' })
          : h('table', { className: 'lw-table', style: { marginTop: 12 } },
            h('thead', null, h('tr', null, ['标题', '类型', '状态', '版本', '更新', '路径'].map((label) => h('th', { key: label }, label)))),
            h('tbody', null, pages.map((page) => h('tr', {
              key: page.id, style: { cursor: 'pointer' }, onClick: () => setOpenId(page.id),
            },
            h('td', { style: { fontWeight: 600 } }, page.title),
            h('td', null, KIND_LABELS[page.kind] || page.kind),
            h('td', null, statusChip(page.status)),
            h('td', null, `r${page.revision}`),
            h('td', { className: 'lw-muted' }, formatTime(page.compiledAt)),
            h('td', { className: 'lw-muted' }, page.path))))))
    }

    // ───────────────────────────── 3. 检索 + 问答 ─────────────────────────────
    function SearchView() {
      const [q, setQ] = React.useState('')
      const [asOf, setAsOf] = React.useState('')
      const [submitted, setSubmitted] = React.useState(null)
      const [answer, setAnswer] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [toast, setToast] = React.useState(null)

      const run = (mode) => {
        const query = q.trim()
        if (!query || busy) return
        setBusy(mode)
        const path = mode === 'ask' ? '/ask' : '/wiki-search'
        post(path, { q: query, asOf: asOf || null })
          .then((result) => {
            if (mode === 'ask') { setAnswer(result); setSubmitted(null) } else { setSubmitted(result); setAnswer(null) }
          })
          .catch((error) => setToast({ message: error.message }))
          .finally(() => setBusy(''))
      }

      const feedback = (pageId, verdict) => post('/page-feedback', { pageId, verdict })
        .then(() => setToast({ message: '已记录反馈' }))
        .catch((error) => setToast({ message: error.message }))

      return h('div', null,
        h('h2', { className: 'lw-h2' }, '检索与问答'),
        h('div', { className: 'lw-row' },
          h('div', { style: { flex: 1 } }, h('input', {
            className: 'lw-input', placeholder: '问点什么，例如：联合命中怎么统计？',
            value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') run('search') },
          })),
          h('button', { className: 'lw-btn primary', type: 'button', disabled: busy !== '', onClick: () => run('search') }, '检索'),
          h('button', { className: 'lw-btn', type: 'button', disabled: busy !== '', onClick: () => run('ask') }, '问答')),
        h('div', { className: 'lw-row', style: { marginTop: 8 } },
          h('span', { className: 'lw-muted' }, '时点（可空，查「当时成立的说法」）'),
          h('input', {
            className: 'lw-input', style: { width: 240 }, placeholder: '2026-10-01T00:00:00.000Z',
            value: asOf, onChange: (e) => setAsOf(e.target.value),
          })),
        answer
          ? h('div', { className: 'lw-sec', style: { marginTop: 14 } },
            h('div', { className: 'lw-row' },
              h('b', null, '回答'),
              answer.degraded ? chip('规则组装（未配模型）', 'warn') : null),
            h('pre', { className: 'lw-pre', style: { marginTop: 8 } }, answer.answer),
            (answer.sources || []).length > 0
              ? h('div', { className: 'lw-row', style: { marginTop: 8 } },
                h('span', { className: 'lw-muted' }, '依据页面：'),
                answer.sources.map((source) => h('span', { key: source.pageId, className: 'lw-muted' }, source.title)))
              : null)
          : null,
        submitted
          ? h('div', { className: 'lw-sec', style: { marginTop: 14 } },
            h('div', { className: 'lw-muted' },
              `${submitted.results.length} 页 · ${submitted.raw.length} 条原文 · ${formatBytes(submitted.bytes)} · ${submitted.mode} · ${submitted.tookMs}ms`),
            submitted.results.length === 0
              ? h(Empty, {
                title: '没有命中的页面',
                hint: '换个说法，或在「记录」里补一条来源再编译。',
                action: h('button', { className: 'lw-btn', type: 'button', onClick: () => run('ask') }, '直接问答试试'),
              })
              : submitted.results.map((result) => h('div', {
                key: result.pageId, className: 'lw-card', style: { marginTop: 10, cursor: 'default' },
              },
              h('div', { className: 'lw-row' },
                chip(KIND_LABELS[result.kind] || result.kind, 'accent'),
                h('b', null, result.title),
                h('span', { className: 'lw-muted' }, `r${result.revision}`),
                h('span', { className: 'lw-spacer' }),
                h('span', { className: 'lw-score' },
                  `文本 ${(result.components.text * 100).toFixed(0)} · 时效 ${(result.components.recency * 100).toFixed(0)} · 反馈 ${(result.components.feedback * 100).toFixed(0)}`)),
              h('div', { className: 'lw-muted', style: { marginTop: 4 } }, result.summary || ''),
              (result.claims || []).slice(0, 3).map((claim) => h('div', {
                key: claim.id, className: 'lw-page-body', style: { marginTop: 4 },
              }, `- ${claim.statement}`)),
              (result.evidence || []).slice(0, 2).map((item, i) => h('div', { key: i, className: 'lw-quote' },
                `「${clampText(item.quote, 160).text}」`)),
              h('div', { className: 'lw-row', style: { marginTop: 6 } },
                h('span', { className: 'lw-muted' }, result.path),
                h('span', { className: 'lw-spacer' }),
                h('button', { className: 'lw-btn', type: 'button', onClick: () => feedback(result.pageId, 'useful') }, '有用'),
                h('button', { className: 'lw-btn', type: 'button', onClick: () => feedback(result.pageId, 'irrelevant') }, '不相关')))),
            submitted.raw.length > 0
              ? h('div', { className: 'lw-sec', style: { marginTop: 14 } },
                h('div', { className: 'lw-h3' }, `原文片段 ${submitted.raw.length} 条`),
                submitted.raw.map((item) => h('div', { key: item.id, className: 'lw-quote' },
                  `[${item.role || item.kind}] ${clampText(item.excerpt, 220).text}`)))
              : null)
          : h(Empty, { title: '先查一次', hint: '检索先看页面（编译后的结论），再补原文片段（证据）。' }),
        h(Toast, { toast, onClose: () => setToast(null) }))
    }

    // ───────────────────────────── 4. 记录：L1 来源 ─────────────────────────────
    function RecordsView(props) {
      const [q, setQ] = React.useState('')
      const [offset, setOffset] = React.useState(0)
      const feed = useApi('/sources', { limit: 25, offset, q, projectId: props.projectId || null })
      const [draft, setDraft] = React.useState({ title: '', content: '' })
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)

      const save = () => {
        if (!draft.content.trim() || busy) return
        setBusy(true)
        post('/record', { title: draft.title, content: draft.content, projectId: props.projectId || null })
          .then((result) => {
            setToast({ message: `已补录：${result.id || '一条来源'}` })
            setDraft({ title: '', content: '' })
            setOffset(0)
            feed.reload()
          })
          .catch((error) => setToast({ message: error.message }))
          .finally(() => setBusy(false))
      }

      if (feed.phase === 'loading') return h(Skeleton, { rows: 4 })
      if (feed.phase === 'error') return h(ErrorBox, { error: feed.error, onRetry: feed.reload })
      const items = feed.data.sources || []
      const total = feed.data.total || 0
      return h('div', null,
        h('h2', { className: 'lw-h2' }, '记录（L1 原始来源，只增不改）'),
        h('div', { className: 'lw-row' },
          h('div', { style: { flex: 1 } }, h('input', {
            className: 'lw-input', placeholder: '按关键词过滤来源', value: q,
            onChange: (e) => { setQ(e.target.value); setOffset(0) },
          })),
          h('span', { className: 'lw-muted' }, `共 ${total} 条`)),
        h('div', { className: 'lw-sec', style: { marginTop: 12 } },
          h('div', { className: 'lw-h3' }, '手工补录一条来源'),
          h('input', {
            className: 'lw-input', placeholder: '标题（可空）', value: draft.title,
            onChange: (e) => setDraft({ ...draft, title: e.target.value }),
          }),
          h('textarea', {
            className: 'lw-textarea', style: { marginTop: 6 }, placeholder: '粘贴一段可信的原文',
            value: draft.content, onChange: (e) => setDraft({ ...draft, content: e.target.value }),
          }),
          h('div', { className: 'lw-row', style: { marginTop: 6 } },
            h('button', { className: 'lw-btn primary', type: 'button', disabled: busy, onClick: save }, busy ? '保存中…' : '补录'),
            h('span', { className: 'lw-muted' }, '补录立即进库；要不要变成页面，还得经过编译和人工审核。'))),
        items.length === 0
          ? h(Empty, { title: '还没有来源', hint: '会话里的对话会自动进来；也可以在上面手工补一条。' })
          : h('table', { className: 'lw-table' },
            h('thead', null, h('tr', null, ['时间', '类型', '角色', '标题', '片段', '哈希'].map((label) => h('th', { key: label }, label)))),
            h('tbody', null, items.map((item) => h('tr', { key: item.id },
              h('td', { className: 'lw-muted' }, formatTime(item.createdAt)),
              h('td', null, chip(item.kind, item.kind === 'manual' ? 'accent' : '')),
              h('td', { className: 'lw-muted' }, item.role || '—'),
              h('td', null, item.title || clampText(item.content, 40).text),
              h('td', { className: 'lw-muted' }, clampText(String(item.content || '').replace(/\n/gu, ' '), 140).text),
              h('td', { className: 'lw-muted' }, String(item.contentSha || '').slice(0, 10)))))),
        h('div', { className: 'lw-row', style: { marginTop: 10 } },
          h('button', {
            className: 'lw-btn', type: 'button', disabled: offset <= 0,
            onClick: () => setOffset(Math.max(0, offset - 25)),
          }, '上一页'),
          h('button', {
            className: 'lw-btn', type: 'button', disabled: offset + 25 >= total,
            onClick: () => setOffset(offset + 25),
          }, '下一页'),
          h('span', { className: 'lw-muted' }, `${offset + 1}–${Math.min(offset + 25, total)} / ${total}`)),
        h(Toast, { toast, onClose: () => setToast(null) }))
    }

    // ───────────────────────────── 5. 洞察：体检 ─────────────────────────────
    function InsightsView(props) {
      const overview = useApi('/wiki-overview', { projectId: props.projectId || null })
      const [findings, setFindings] = React.useState(null)
      const [kind, setKind] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [toast, setToast] = React.useState(null)

      const doLint = () => {
        if (busy) return
        setBusy('lint')
        post('/lint', { projectId: props.projectId || null })
          .then((result) => post('/lint-findings', { runId: result.runId, limit: 200 })
            .then((rows) => {
              setFindings(rows.findings || [])
              setToast({ message: `体检完成：${(result.findings || []).length} 条发现` })
            }))
          .catch((error) => setToast({ message: error.message }))
          .finally(() => setBusy(''))
      }

      const doCompile = () => {
        if (busy) return
        setBusy('compile')
        post('/compile', { projectId: props.projectId || null })
          .then((result) => {
            setToast({ message: `编译完成：新补丁 ${result.inserted}，待编译 ${result.pending}` })
            overview.reload()
          })
          .catch((error) => setToast({ message: error.message }))
          .finally(() => setBusy(''))
      }

      if (overview.phase === 'loading') return h(Skeleton, { rows: 4 })
      if (overview.phase === 'error') return h(ErrorBox, { error: overview.error, onRetry: overview.reload })
      const data = overview.data
      const counts = (data.lint && data.lint.counts) || {}
      const shown = (findings || []).filter((item) => !kind || item.kind === kind)
      return h('div', null,
        h('div', { className: 'lw-row' },
          h('h2', { className: 'lw-h2', style: { margin: 0 } }, '洞察'),
          h('span', { className: 'lw-muted' }, `页面 ${data.pages.total} · 已落页 ${data.pages.approved} · 待审 ${data.pages.candidate} · 待编译来源 ${data.pendingSources}`),
          h('span', { className: 'lw-spacer' }),
          h('button', {
            className: 'lw-btn', type: 'button', disabled: busy !== '', onClick: doCompile,
          }, busy === 'compile' ? '编译中…' : '编译一轮'),
          h('button', {
            className: 'lw-btn primary', type: 'button', disabled: busy !== '', onClick: doLint,
          }, busy === 'lint' ? '体检中…' : '跑一次体检')),
        h('div', { className: 'lw-sec', style: { marginTop: 12 } },
          h('div', { className: 'lw-h3' }, '主张与补丁'),
          h('div', { className: 'lw-kv' },
            h('dt', null, '主张（现行）'), h('dd', null, String(data.claims.live ?? 0)),
            h('dt', null, '主张（历史）'), h('dd', null, String(data.claims.retired ?? 0)),
            h('dt', null, '补丁'), h('dd', null, `待审 ${data.patches.candidate || 0} · 已采纳 ${data.patches.approved || 0} · 暂缓 ${data.patches.deferred || 0}`),
            h('dt', null, '最近体检'), h('dd', null, data.lint.at ? `${formatTime(data.lint.at)} · ${data.lint.runId}` : '还没跑过'))),
        Object.keys(counts).length > 0
          ? h('div', { className: 'lw-row', style: { marginTop: 10 } },
            Object.entries(counts).map(([key, n]) => chip(`${LINT_LABELS[key] || key} ${n}`,
              key === 'broken-quote' || key === 'contradiction' ? 'err' : 'warn')))
          : null,
        findings === null
          ? h(Empty, {
            title: '体检还没跑',
            hint: '体检看七件事：矛盾、过时、孤岛、缺页、缺链、坏引用、缺口。它只报告，不改页面。',
            action: h('button', { className: 'lw-btn primary', type: 'button', disabled: busy !== '', onClick: doLint }, '现在体检'),
          })
          : h('div', null,
            h('div', { className: 'lw-row', style: { marginTop: 14 } },
              h('select', {
                className: 'lw-input', style: { width: 160 }, value: kind,
                onChange: (e) => setKind(e.target.value),
              },
              h('option', { value: '' }, '全部类型'),
              Object.keys(LINT_LABELS).map((key) => h('option', { key, value: key }, LINT_LABELS[key])))),
            shown.length === 0
              ? h(Empty, { title: '这次体检没有发现', hint: '一致性良好。' })
              : h('table', { className: 'lw-table', style: { marginTop: 10 } },
                h('thead', null, h('tr', null, ['类型', '页面', '说明', '建议'].map((label) => h('th', { key: label }, label)))),
                h('tbody', null, shown.map((item) => h('tr', { key: item.id },
                  h('td', null, chip(LINT_LABELS[item.kind] || item.kind,
                    item.kind === 'broken-quote' || item.kind === 'contradiction' ? 'err' : 'warn')),
                  h('td', { className: 'lw-muted' }, item.page_id || '—'),
                  h('td', null, item.detail),
                  h('td', { className: 'lw-muted' }, item.suggestion || '—')))))),
        h(Toast, { toast, onClose: () => setToast(null) }))
    }

    // ───────────────────────────── 6. 设置 ─────────────────────────────
    function SettingsView() {
      const overview = useApi('/overview', {})
      const fsck = useApi('/fsck', {})
      const [busy, setBusy] = React.useState('')
      const [toast, setToast] = React.useState(null)
      const [conflictPath, setConflictPath] = React.useState('')

      const maintenance = (mode) => {
        if (busy) return
        setBusy(mode)
        const done = (message) => { setToast({ message }); setBusy('') }
        const failed = (error) => { setToast({ message: error.message }); setBusy('') }
        if (mode === 'reindex') {
          post('/reindex', {})
            .then((result) => done(`索引已重算：${result.notes ?? 0} 条笔记`))
            .catch(failed)
        } else if (mode === 'fsck') {
          fsck.reload()
          done('已重跑自检')
        } else if (mode === 'rebuild') {
          post('/fsck', { rebuild: true })
            .then((result) => { fsck.reload(); done(`全文索引重建完成：${result.rebuilt ?? 0} 条`) })
            .catch(failed)
        } else if (mode === 'resolve') {
          post('/resolve', { path: conflictPath.trim() })
            .then((result) => { setConflictPath(''); done(`已把磁盘现状登记为 r${result.revision}`) })
            .catch(failed)
        }
      }

      if (overview.phase === 'loading') return h(Skeleton, { rows: 4 })
      if (overview.phase === 'error') return h(ErrorBox, { error: overview.error, onRetry: overview.reload })
      const data = overview.data
      const config = data.config || {}
      const policies = data.policies || {}
      const model = data.model || {}
      const db = data.db || {}
      return h('div', null,
        h('h2', { className: 'lw-h2' }, '设置'),
        model.mode === 'rules'
          ? h('div', { className: 'lw-row', style: { marginBottom: 10 } },
            chip('未配置模型 · 编译按规则模式', 'warn'),
            h('span', { className: 'lw-muted' }, '规则模式只做标题/首段与要点抽取，全部进待审队列，不会自动写。'))
          : null,
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-h3' }, '数据位置'),
          h('div', { className: 'lw-kv' },
            h('dt', null, '库文件'), h('dd', null, db.file || '—'),
            h('dt', null, 'vault'), h('dd', null, config.vaultPath || '—'),
            h('dt', null, '状态'), h('dd', null, db.open ? '已打开' : '未打开（首次写入时创建）'),
            h('dt', null, '版本'), h('dd', null, data.version || '—'))),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-h3' }, '计数'),
          h('div', { className: 'lw-kv' }, Object.entries(data.counts || {}).map(([key, value]) =>
            h(React.Fragment, { key }, h('dt', null, key), h('dd', null, String(value)))))),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-h3' }, '策略（行为开关，存在库里）'),
          h('div', { className: 'lw-kv' }, Object.entries(policies).map(([key, value]) =>
            h(React.Fragment, { key }, h('dt', null, key),
              h('dd', null, value === 'true' ? '开' : value === 'false' ? '关' : String(value))))),
          h('div', { className: 'lw-muted' }, 'autoWrite 永远不允许打开：落页只能由人触发。')),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-h3' }, '维护'),
          h('div', { className: 'lw-row' },
            h('button', { className: 'lw-btn', type: 'button', disabled: busy !== '', onClick: () => maintenance('fsck') }, '重跑自检'),
            h('button', { className: 'lw-btn', type: 'button', disabled: busy !== '', onClick: () => maintenance('rebuild') }, '重建全文索引'),
            h('button', { className: 'lw-btn', type: 'button', disabled: busy !== '', onClick: () => maintenance('reindex') }, '重算索引.md')),
          fsck.phase === 'ok' && fsck.data
            ? h('div', { className: 'lw-row', style: { marginTop: 8 } },
              fsck.data.ok
                ? chip('自检通过', 'ok')
                : chip(`自检发现 ${(fsck.data.issues || []).length} 个问题`, 'err'))
            : null),
        h('div', { className: 'lw-sec' },
          h('div', { className: 'lw-h3' }, '文件被外部改过？'),
          h('div', { className: 'lw-muted' }, '如果某个笔记在磁盘上被手工改过，写入会停下来等你确认。填它的相对路径，把磁盘现状登记成新版本：'),
          h('div', { className: 'lw-row', style: { marginTop: 6 } },
            h('div', { style: { flex: 1 } }, h('input', {
              className: 'lw-input', placeholder: 'Library/项目名/Projects/<project_id>/decisions/xxx.md',
              value: conflictPath, onChange: (e) => setConflictPath(e.target.value),
            })),
            h('button', {
              className: 'lw-btn', type: 'button',
              disabled: busy !== '' || !conflictPath.trim(),
              onClick: () => maintenance('resolve'),
            }, '接受磁盘改动'))),
        h(Toast, { toast, onClose: () => setToast(null) }))
    }

    // ───────────────────────────── 外壳 ─────────────────────────────
    const VIEWS = [
      { id: 'review', label: '审核' },
      { id: 'pages', label: '页面' },
      { id: 'search', label: '检索' },
      { id: 'records', label: '记录' },
      { id: 'insights', label: '洞察' },
      { id: 'settings', label: '设置' },
    ]

    function Shell() {
      ensureStyles()
      const [view, setView] = React.useState('review')
      const health = useApi('/health', {})
      const queue = useApi('/patch-queue', { limit: 1 })
      const overview = useApi('/wiki-overview', {})
      const pending = (queue.data && queue.data.counts && queue.data.counts.candidate) || 0
      const model = (overview.data && overview.data.model) || {}
      const dotTone = health.phase === 'error' ? 'bad' : health.phase === 'ok' ? 'ok' : 'warn'
      return h('div', { className: 'lw-root' },
        h('div', { className: 'lw-head' },
          h('span', { className: 'lw-title' }, 'Wiki'),
          h('span', { className: 'lw-sub' }, '编译式知识库 · 页面是真相层'),
          h('span', { className: 'lw-spacer' }),
          model.mode === 'rules' ? chip('规则模式', 'warn') : null,
          h('span', { className: 'lw-badge' },
            h('span', { className: `lw-dot ${dotTone}` }),
            health.phase === 'ok' ? '运行中' : health.phase === 'error' ? '连不上宿主' : '连接中')),
        h('div', { className: 'lw-body' },
          h('div', { className: 'lw-nav' }, VIEWS.map((item) => h('button', {
            key: item.id, type: 'button',
            className: `lw-nav-item${view === item.id ? ' on' : ''}`,
            onClick: () => setView(item.id),
          },
          h('span', null, item.label),
          h('span', { className: 'lw-nav-count' },
            item.id === 'review' && pending > 0 ? String(pending) : '')))),
          h('div', { className: 'lw-main' },
            view === 'review' ? h(ReviewView, null)
              : view === 'pages' ? h(PagesView, null)
                : view === 'search' ? h(SearchView, null)
                  : view === 'records' ? h(RecordsView, null)
                    : view === 'insights' ? h(InsightsView, null)
                      : h(SettingsView, null))))
    }

    /** 侧栏图标：三层由小到大的矩形（L1 原文 → L2 页面 → L3 主张）。 */
    function SidebarIcon(owner) {
      const size = (owner && owner.size) || 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1, y: 10, width: 14, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 3, y: 5.5, width: 10, height: 3.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 5, y: 1.5, width: 6, height: 3, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }))
    }

    /** 自检上报：客户端一进来就打一声招呼，宿主可据此判断浏览器半是否活着。 */
    function report(event, extra) {
      try {
        const body = Object.assign({ event, platform: 'web', location: String(window.location.pathname || '/') }, extra || {})
        fetch(API + '/client-hello', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }).catch(() => {})
      } catch { /* 自检失败不影响面板 */ }
    }

    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => 'Wiki',
      }, SidebarIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Shell))
      report('apply')
    }

    exports.name = 'llm-wiki'
    exports.inject = ['slots']
    exports.apply = apply
    exports.__internals = {
      clampText, formatBytes, formatTime, keyToAction, nextIndex,
      VIEW_IDS: VIEWS.map((item) => item.id),
    }
    return module.exports
  },
})
