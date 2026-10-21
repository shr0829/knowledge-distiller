// lib/routes.mjs — 浏览器侧数据通道：全部 /api-llm-wiki/* 路由（spec §10 / §12.7 / §17）。
//
// handler 是裸 Node http 的 (req, res)：自己读 body、自己 writeHead/end。
// 所有路由同一 JSON 出口：handle(state, body) 返回载荷，抛错统一 500。
import { handlers } from './api.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

const errorText = (err) => String((err && err.message) || err)

/** 一条 JSON 路由：GET 直接取 query，其余方法读 JSON body。 */
export function jsonRoute(path, name, state) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      let status = 200
      let payload
      try {
        const body = req.method === 'GET' ? fromQuery(req) : await readJsonBody(req)
        payload = await handlers[name](state, body)
      } catch (err) {
        status = 500
        payload = { ok: false, error: errorText(err) }
      }
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    },
  }
}

/** 读请求体并解析 JSON（空体返回 {}）。 */
export async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error(`请求体超过上限 ${limitBytes} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function fromQuery(req) {
  const url = new URL(req.url || '/', 'http://localhost')
  const out = {}
  for (const [key, value] of url.searchParams) out[key] = value
  return out
}

/** path → handler 名。 */
export const ROUTES = [
  ['/api-llm-wiki/health', 'health'],
  ['/api-llm-wiki/ping', 'ping'],
  ['/api-llm-wiki/client-hello', 'clientHello'],
  ['/api-llm-wiki/overview', 'overview'],
  ['/api-llm-wiki/sources', 'sources'],
  ['/api-llm-wiki/search', 'search'],
  ['/api-llm-wiki/record', 'record'],
  ['/api-llm-wiki/projects', 'projects'],
  ['/api-llm-wiki/policies', 'policies'],
  // 审核队列
  ['/api-llm-wiki/queue', 'queue'],
  ['/api-llm-wiki/item', 'item'],
  ['/api-llm-wiki/review', 'review'],
  ['/api-llm-wiki/review-undo', 'reviewUndo'],
  ['/api-llm-wiki/reviews', 'reviews'],
  // vault
  ['/api-llm-wiki/preview', 'preview'],
  ['/api-llm-wiki/write', 'write'],
  ['/api-llm-wiki/notes', 'notes'],
  ['/api-llm-wiki/writes', 'writes'],
  ['/api-llm-wiki/resolve', 'resolve'],
  ['/api-llm-wiki/reindex', 'reindex'],
  // 提炼与维护
  ['/api-llm-wiki/pipeline', 'pipeline'],
  ['/api-llm-wiki/fsck', 'fsck'],
  ['/api-llm-wiki/graph', 'graph'],
  ['/api-llm-wiki/feedback', 'feedback'],
  // v2：页面 / 补丁 / 体检 / 问答（docs/DSH_WIKI_SPEC.md）
  ['/api-llm-wiki/wiki-overview', 'wikiOverview'],
  ['/api-llm-wiki/pages', 'pages'],
  ['/api-llm-wiki/page', 'page'],
  ['/api-llm-wiki/patch-queue', 'patchQueue'],
  ['/api-llm-wiki/patch', 'patch'],
  ['/api-llm-wiki/patch-review', 'patchReview'],
  ['/api-llm-wiki/patch-undo', 'patchUndo'],
  ['/api-llm-wiki/compile', 'compile'],
  ['/api-llm-wiki/compile-state', 'compileState'],
  ['/api-llm-wiki/lint', 'lint'],
  ['/api-llm-wiki/lint-findings', 'lintFindings'],
  ['/api-llm-wiki/wiki-search', 'wikiSearch'],
  ['/api-llm-wiki/ask', 'ask'],
  ['/api-llm-wiki/page-feedback', 'pageFeedback'],
]

/**
 * 上一次 apply 注册的路由。插件在同一进程里被重新 apply（开发者热换、bundle 开关）时，
 * 旧实例的 webServer 路由可能还没释放，直接注册会撞 `duplicate route`；这里先收掉上一份，
 * 保证「同一路径永远只有最新实例在服务」。
 */
let currentDispose = null

export function registerRoutes(ctx, webServer, state) {
  if (typeof currentDispose === 'function') {
    try { currentDispose() } catch { /* 上一份已经没了就忽略 */ }
    currentDispose = null
  }
  const disposers = []
  for (const [path, name] of ROUTES) {
    if (typeof handlers[name] !== 'function') {
      state.log?.('warn', `路由 ${path} 没有对应处理器 ${name}`)
      continue
    }
    try {
      const dispose = webServer.register(jsonRoute(path, name, state))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      state.log?.('error', `路由 ${path} 注册失败：${errorText(err)}`)
    }
  }
  const disposeAll = () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载失败不打断 */ }
    }
    if (currentDispose === disposeAll) currentDispose = null
  }
  currentDispose = disposeAll
  return disposeAll
}
