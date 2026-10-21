// scripts/live-check.mjs — 对**正在运行的** DSH 做自检（v2：页面 + 主张 + 补丁闸门）。
//
//   node scripts/live-check.mjs                 # 只读：健康/概览/自检/检索/问答/补丁队列/页面
//   node scripts/live-check.mjs http://127.0.0.1:49812   # 指定宿主地址（端口每次启动会变）
//   $env:LLM_WIKI_WRITE='1'; node scripts/live-check.mjs   # 额外跑一次真实写路径（会动 vault）
//
// 读路径不写库、不写 vault；写路径会补录一条来源、编译、接受补丁、落页，并在最后把这次留下的
// 页面状态打印出来——它只用于人工验收，不要当日常命令跑。
const BASE = process.argv[2] || process.env.LLM_WIKI_BASE || process.env.ZHIXU_BASE || 'http://127.0.0.1:59631'
const WRITE = process.env.LLM_WIKI_WRITE === '1' || process.env.ZHIXU_WRITE === '1'

let failures = 0
const ok = (label, extra) => console.log(`  OK   ${label}${extra ? '  ' + extra : ''}`)
const bad = (label, extra) => { failures += 1; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`) }

const call = async (method, path, body) => {
  const init = { method, headers: { accept: 'application/json' } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body || {})
  }
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 原样留着 */ }
  return { status: res.status, json, text }
}
const get = (path) => call('GET', path)
const post = (path, body) => call('POST', path, body || {})

console.log(`LLM Wiki v2 线上自检 → ${BASE}`)

const health = await get('/api-llm-wiki/health')
if (health.status === 200 && health.json && health.json.ok) ok('health', `v${health.json.version} db=${health.json.db}`)
else bad('health', `${health.status} ${health.text.slice(0, 160)}`)

const overview = await post('/api-llm-wiki/wiki-overview', {})
if (overview.status === 200 && overview.json && overview.json.ok) {
  const data = overview.json
  ok('概览', `页面 ${data.pages.total}（已落页 ${data.pages.approved}）· 主张 ${data.claims.live} · 待审补丁 ${data.patches.candidate} · 待编译来源 ${data.pendingSources}`)
  ok('模型', data.model ? data.model.mode : 'rules')
} else {
  bad('概览', `${overview.status} ${overview.text.slice(0, 160)}`)
}

const fsck = await get('/api-llm-wiki/fsck')
if (fsck.status === 200 && fsck.json && fsck.json.ok) ok('不变量自检', JSON.stringify(fsck.json.counts || {}))
else bad('不变量自检', fsck.text.slice(0, 240))

for (const query of ['联合命中', '容差', '温度']) {
  const search = await post('/api-llm-wiki/wiki-search', { q: query })
  if (search.status === 200 && search.json && search.json.ok) {
    const data = search.json
    const label = `检索「${query}」`
    ok(label, `mode=${data.mode} 页面 ${data.results.length} / 原文 ${data.raw.length} / ${data.bytes}B`)
    if (data.results.length <= 8) ok(`${label} 条数上限`, String(data.results.length))
    else bad(`${label} 条数上限`, `${data.results.length} > 8`)
    if (data.bytes <= 24576) ok(`${label} 字节上限`, `${data.bytes}B`)
    else bad(`${label} 字节上限`, `${data.bytes}B > 24576B`)
  } else {
    bad(`检索「${query}」`, `${search.status} ${search.text.slice(0, 160)}`)
  }
}

const asked = await post('/api-llm-wiki/ask', { q: '联合命中怎么统计' })
if (asked.status === 200 && asked.json && asked.json.ok) {
  ok('问答', `degraded=${asked.json.degraded} 依据页面 ${asked.json.sources.length} 个`)
  if (typeof asked.json.answer === 'string' && asked.json.answer.length > 0) ok('问答有正文', `${asked.json.answer.length} 字符`)
  else bad('问答有正文', '空答案')
} else {
  bad('问答', `${asked.status} ${asked.text.slice(0, 160)}`)
}

const states = await post('/api-llm-wiki/compile-state', {})
if (states.status === 200 && states.json && states.json.ok) ok('编译状态', `待编译 ${states.json.pending} · 队列 ${states.json.queue} · 模式 ${states.json.mode}`)
else bad('编译状态', states.text.slice(0, 160))

const queue = await post('/api-llm-wiki/patch-queue', { limit: 5 })
if (queue.status === 200 && queue.json && queue.json.ok) ok('补丁队列', `待审 ${queue.json.counts.candidate} · 已采纳 ${queue.json.counts.approved} · 暂缓 ${queue.json.counts.deferred}`)
else bad('补丁队列', queue.text.slice(0, 160))

const pages = await post('/api-llm-wiki/pages', { limit: 5 })
if (pages.status === 200 && pages.json && pages.json.ok) ok('页面列表', `共 ${pages.json.total} 页`)
else bad('页面列表', pages.text.slice(0, 160))

const lintRun = await post('/api-llm-wiki/lint-findings', { limit: 5 })
if (lintRun.status === 200 && lintRun.json && lintRun.json.ok) ok('体检发现', `run=${lintRun.json.runId || '—'} 条数 ${lintRun.json.findings.length}`)
else bad('体检发现', lintRun.text.slice(0, 160))

if (WRITE) {
  console.log('\n写路径检查（LLM_WIKI_WRITE=1：补录 → 编译 → 接受 → 落页）')
  const stamp = new Date().toISOString().slice(0, 19)
  const title = `LLM Wiki v2 自检样本 ${stamp}`
  const content = [
    `# ${title}`,
    '',
    '这条由 scripts/live-check.mjs 写入，用来确认：编译产物必须经过人工补丁审核才能落页。',
    '',
    '## 约定',
    '',
    '我们决定：自检样本页的容差按 ±50 raw 记；联合命中必须单列统计。',
  ].join('\n')

  const recorded = await post('/api-llm-wiki/record', { projectId: 'manual', title, content })
  if (recorded.json && recorded.json.ok && recorded.json.inserted) ok('手工补录', title)
  else bad('手工补录', recorded.text.slice(0, 200))

  const compiled = await post('/api-llm-wiki/compile', {})
  if (compiled.json && compiled.json.ok) ok('编译一轮', `新补丁 ${compiled.json.inserted} · 待编译 ${compiled.json.pending}`)
  else bad('编译一轮', compiled.text.slice(0, 200))

  const fresh = await post('/api-llm-wiki/patch-queue', { limit: 20 })
  const patch = ((fresh.json && fresh.json.patches) || []).find((row) => row.title === title)
  if (patch) ok('补丁入队', patch.id)
  else bad('补丁入队', '没找到刚编译出的补丁')

  if (patch) {
    const detail = await post('/api-llm-wiki/patch', { id: patch.id })
    if (detail.json && detail.json.ok) ok('补丁详情', `改动 ${detail.json.ops.length} 处`)
    else bad('补丁详情', detail.text.slice(0, 200))

    const accepted = await post('/api-llm-wiki/patch-review', { id: patch.id, action: 'accept' })
    if (accepted.json && accepted.json.ok) ok('接受补丁', `page=${accepted.json.pageId} 文件=${accepted.json.file ? accepted.json.file.path : '未写文件'}`)
    else bad('接受补丁', accepted.text.slice(0, 240))

    if (accepted.json && accepted.json.pageId) {
      const page = await post('/api-llm-wiki/page', { id: accepted.json.pageId })
      if (page.json && page.json.ok) {
        ok('页面详情', `${page.json.page.path} r${page.json.page.revision}`)
        ok('主张与证据', `主张 ${page.json.claims.length} · 引用 ${page.json.citations.length}`)
        if (page.json.citations.length >= 1) ok('证据逐字校验', page.json.citations[0].quote.slice(0, 40))
        else bad('证据逐字校验', '没有引用（规则模式也没抽到逐字片段？）')
        const found = await post('/api-llm-wiki/wiki-search', { q: '自检样本' })
        if (found.json && found.json.ok && found.json.results.some((row) => row.pageId === page.json.page.id)) ok('检索命中新页', found.json.results[0].title)
        else bad('检索命中新页', JSON.stringify((found.json && found.json.results) || []).slice(0, 200))
      } else {
        bad('页面详情', page.text.slice(0, 200))
      }
    }
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不通过`)
process.exitCode = failures === 0 ? 0 : 1
