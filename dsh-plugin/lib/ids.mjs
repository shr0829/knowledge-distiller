// lib/ids.mjs — 标识与摘要（spec §7：ISO-8601 UTC 时间、26 位 ULID）。
import { createHash, randomBytes } from 'node:crypto'

// Crockford Base32（ULID 字母表，去掉 I L O U）
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 生成 26 位 ULID：前 10 位 48bit 毫秒时间戳，后 16 位 80bit 随机。
 * 随机位取整字节低 5 位（256/32 整除，均匀）。
 */
export function ulid(now = Date.now()) {
  let remaining = now
  const time = new Array(10)
  for (let i = 9; i >= 0; i -= 1) {
    time[i] = ENCODING[remaining % 32]
    remaining = Math.floor(remaining / 32)
  }
  const bytes = randomBytes(16)
  let random = ''
  for (const byte of bytes) random += ENCODING[byte & 31]
  return time.join('') + random
}

/** ISO-8601 UTC 时间（DB 里所有时间列都用它）。传 Date / 毫秒数 / 已是 ISO 字符串的时刻都接受。 */
export function nowIso(date = new Date()) {
  if (typeof date === 'string') return date
  if (typeof date === 'number') return new Date(date).toISOString()
  return date.toISOString()
}

/** 内容摘要（去重与外部改动检测的唯一依据）。 */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** 短哈希（指纹、project_id 等）。 */
export function shortHash(text, length = 12, algo = 'sha1') {
  return createHash(algo).update(String(text), 'utf8').digest('hex').slice(0, length)
}

/**
 * 规范化 workspace 路径：反斜杠转正斜杠、去尾斜杠、盘符小写、Windows 下整体小写
 *（NTFS 大小写不敏感，同一目录不同写法必须落到同一个 project_id）。
 */
export function normalizeWorkspacePath(input) {
  if (typeof input !== 'string' || input.trim() === '') return ''
  let value = input.replace(/\\/g, '/').trim()
  value = value.replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(value)) {
    value = value[0].toLowerCase() + value.slice(1)
    return value.toLowerCase()
  }
  return value
}

/** project_id = sha1(规范化 workspace 路径)[:12]；无 cwd 归 manual（spec §8）。 */
export function projectIdOf(workspacePath) {
  const normalized = normalizeWorkspacePath(workspacePath)
  if (normalized === '') return 'manual'
  return shortHash(normalized, 12, 'sha1')
}
