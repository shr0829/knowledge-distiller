// lib/slug.mjs — 中文友好的 slug 生成（页面文件名用）。
//
// 规则（docs/DSH_WIKI_SPEC.md §9「中文 slug」）：保留汉字 / 假名 / 谚文 / 字母 / 数字，
// 其余（标点、空白、符号）一律折叠成单个 '-'，首尾去 '-'，按字符数截断（默认 40）。
// 空结果兜底 'page'——文件名不能为空。

const KEEP = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9]/u

export function slugify(text, maxLen = 40) {
  const chars = Array.from(String(text == null ? '' : text))
  let out = ''
  let pendingDash = false
  for (const ch of chars) {
    if (KEEP.test(ch)) {
      if (pendingDash && out.length > 0) out += '-'
      pendingDash = false
      out += ch
    } else {
      pendingDash = true
    }
    if (out.length >= maxLen) break
  }
  const trimmed = out.replace(/-+$/u, '')
  return trimmed === '' ? 'page' : trimmed
}

/** 同名冲突时加序号：base、base-2、base-3…（调用方给定已占用的 slug 集合）。 */
export function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
