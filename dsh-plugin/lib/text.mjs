// lib/text.mjs — 文本提取、截断、Markdown 切段、查询归一（spec §8 / §10）。
import { sha256Hex } from './ids.mjs'

const encoder = new TextEncoder()

/** UTF-8 字节数（不能用 String.length：中文占 3 字节）。 */
export function bytesOf(text) {
  return encoder.encode(String(text ?? '')).length
}

/** 按 UTF-8 字节截断，不切断多字节字符，尾部标记剩余量。 */
export function truncateBytes(text, maxBytes) {
  const source = String(text ?? '')
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ''
  if (bytesOf(source) <= maxBytes) return source
  // 二分找到不超限的最长前缀，再对齐到合法代理对边界
  let lo = 0
  let hi = source.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (bytesOf(source.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let cut = source.slice(0, lo)
  // 避免切在代理对中间
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  }
  return cut
}

/** 带省略标记的截断（工具参数/结果摘要用）。 */
export function summarizeBytes(text, maxBytes) {
  const source = String(text ?? '')
  const total = bytesOf(source)
  if (total <= maxBytes) return { text: source, truncated: false, bytes: total }
  const kept = truncateBytes(source, Math.max(64, maxBytes - 32))
  return { text: `${kept}\n…（已截断，原 ${total} 字节）`, truncated: true, bytes: total }
}

/**
 * 从宿主消息对象里抽纯文本。
 * MessageBase 的确切形状未在 inspect 里取到，这里防御式处理三种形态：
 * 内容块数组（type==='text'）、纯字符串、缺 content 时退回 text 字段。
 */
export function messageText(message) {
  if (message === null || message === undefined) return ''
  if (typeof message === 'string') return message
  const content = message.content ?? message.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') { parts.push(block); continue }
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (typeof block.text === 'string' && block.type === undefined) parts.push(block.text)
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/**
 * 按 Markdown 标题切段，每段不超过 maxBytes（spec §8：单轮 ≤8KB 直存，>8KB 按标题切段）。
 * 单段自身仍超限时按字节硬切（不破坏多字节字符）。
 * @returns {{part:number,text:string}[]}
 */
export function splitMarkdown(text, maxBytes) {
  const source = String(text ?? '')
  if (source === '') return []
  if (bytesOf(source) <= maxBytes) return [{ part: 0, text: source }]

  const lines = source.split('\n')
  const sections = []
  let buffer = []
  const flush = () => {
    if (buffer.length === 0) return
    sections.push(buffer.join('\n'))
    buffer = []
  }
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && buffer.length > 0) flush()
    buffer.push(line)
  }
  flush()

  const parts = []
  for (const section of sections) {
    if (bytesOf(section) <= maxBytes) { parts.push(section); continue }
    let rest = section
    while (bytesOf(rest) > maxBytes) {
      let chunk = truncateBytes(rest, maxBytes)
      // 尽量切在换行处，避免把一句话劈开
      const at = chunk.lastIndexOf('\n')
      if (at > maxBytes * 0.5) chunk = chunk.slice(0, at)
      parts.push(chunk)
      rest = rest.slice(chunk.length).replace(/^\n/, '')
    }
    if (rest !== '') parts.push(rest)
  }
  return parts.map((text, index) => ({ part: index, text }))
}

/**
 * 查询归一（spec §10）：去标点、全角转半角、英文小写、折叠空白。
 */
export function normalizeQuery(input) {
  let text = String(input ?? '')
  // 全角 ASCII → 半角
  text = text.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  text = text.replace(/\u3000/g, ' ')
  text = text.toLowerCase()
  // 去掉标点与符号（保留中日韩文字、字母、数字、空白）
  text = text.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9\s]/gu, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * FTS 分词：中文按 bigram 切（unicode61 会把连续汉字当成一个整词，
 * 必须索引端与查询端用同一套切法才能命中短语）；英文/数字按整词。
 * @returns {string[]} 去重后的 token 列表
 */
export function ftsTokens(normalized) {
  const tokens = []
  for (const word of String(normalized ?? '').split(' ')) {
    if (word === '') continue
    if (/^[a-z0-9]+$/.test(word)) { tokens.push(word); continue }
    const chars = Array.from(word)
    if (chars.length === 1) { tokens.push(chars[0]); continue }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1])
  }
  return [...new Set(tokens)]
}

/**
 * 建索引用的正文：与 ftsTokens 同一切法，但保留重复（词频影响 bm25 排序）。
 */
export function ftsBody(text, maxTokens = 20000) {
  const normalized = normalizeQuery(text)
  const tokens = []
  for (const word of normalized.split(' ')) {
    if (word === '') continue
    if (/^[a-z0-9]+$/.test(word)) { tokens.push(word); continue }
    const chars = Array.from(word)
    if (chars.length === 1) { tokens.push(chars[0]); continue }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1])
    if (tokens.length >= maxTokens) break
  }
  return tokens.slice(0, maxTokens).join(' ')
}

/**
 * FTS5 查询表达式：结果形如 `"炉次" OR "次温" OR "温度"`。
 */
export function ftsQuery(normalized) {
  const unique = ftsTokens(normalized).slice(0, 32)
  if (unique.length === 0) return ''
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

/** 内容指纹（幂等用，spec §9）。 */
export function fingerprintOf(projectId, hashes) {
  const sorted = [...hashes].sort().join(',')
  return sha256Hex(`${projectId}|${sorted}`)
}
