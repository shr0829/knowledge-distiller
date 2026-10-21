// lib/paths.mjs — 数据目录与默认路径。
//
// 约定（spec §6.5）：插件数据落在 <DSH 用户数据目录>/llm-wiki/，与 profile 无关；
// 数据库与日志不进 git（本包 .gitignore 已排除）。
import { join } from 'node:path'
import { homedir } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'

/** $DSH_HOME，缺省 ~/.dsh（dsh-chat-import 的 resolveRegistryDir 同源约定）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 插件数据目录：<DSH_HOME>/llm-wiki（按需创建）。 */
export function dataDir() {
  const dir = join(dshHome(), 'llm-wiki')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 旧名字（本插件最早叫 zhixu）留下的数据目录。改名不丢数据：
 * 首次需要库文件时，把 <DSH_HOME>/zhixu 里的 sqlite 文件复制过来（不动旧目录，便于回退）。
 */
export const LEGACY_DIR_NAME = 'zhixu'

export function legacyDataDir() {
  return join(dshHome(), LEGACY_DIR_NAME)
}

/** 把旧目录里的库文件搬（复制）进新目录；已经存在就什么也不做。返回被复制的文件名列表。 */
export function migrateLegacyData() {
  const from = legacyDataDir()
  const to = dataDir()
  if (!existsSync(from)) return []
  const copied = []
  for (const name of readdirSync(from)) {
    if (!/\.(sqlite3|sqlite3-wal|sqlite3-shm)$/.test(name)) continue
    const target = join(to, name.replace(/^zhixu\.sqlite3/, 'wiki.sqlite3'))
    if (existsSync(target)) continue
    copyFileSync(join(from, name), target)
    copied.push(name)
  }
  return copied
}

/** SQLite 单文件库（spec §7：单文件 SQLite）。 */
export function dbFile() {
  return join(dataDir(), 'wiki.sqlite3')
}

/** 日志目录：<DSH_HOME>/llm-wiki/logs。 */
export function logDir() {
  const dir = join(dataDir(), 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 默认 vault（spec §6.5 / §13）。 */
export const DEFAULT_VAULT_PATH = 'E:/files/知序知识库'
