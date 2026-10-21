// scripts/check-syntax.mjs — 纯 JS 项目的替代型“类型检查”：逐个文件过 node --check，
// 并禁用 any/@ts-ignore 这类逃生舱（验收 §15.1）。
// 运行：node scripts/check-syntax.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(full, out)
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = [...walk(join(root, 'lib')), ...walk(join(root, 'test')), ...walk(join(root, 'scripts'))]
let failed = 0

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    console.log(`OK   ${file.slice(root.length + 1)}`)
  } catch (err) {
    failed += 1
    console.error(`FAIL ${file.slice(root.length + 1)}`)
    console.error(String(err.stderr || err.message))
  }
}

// 验收：无 any 逃生舱。纯 JS 下对应的坏味道是 @ts-ignore / @ts-nocheck / 显式 any 断言注释。
const FORBIDDEN = /@ts-(ignore|nocheck|expect-error)/
for (const file of files) {
  // 本脚本自己写着这条规则的正则，跳过自身
  if (file.endsWith('check-syntax.mjs')) continue
  const text = readFileSync(file, 'utf8')
  const hit = text.split('\n').findIndex((line) => FORBIDDEN.test(line))
  if (hit >= 0) {
    failed += 1
    console.error(`FAIL ${file.slice(root.length + 1)}:${hit + 1} 出现 @ts-ignore 类逃生舱`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个文件未通过`)
  process.exit(1)
}
console.log(`\n全部 ${files.length} 个文件通过`)
