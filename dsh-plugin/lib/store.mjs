// lib/store.mjs — 数据库生命周期（惰性打开、失败可降级）。
//
// 打开时机：apply 时先试一次（让 /health 立刻能报 db 状态）；失败不抛给宿主，
// 只记日志并让后续调用重试——「模型/DB 不可用时其余功能照常」是 spec §9 的降级要求。
import { openDb, counts, listPolicies, setPolicy, getPolicy } from './db.mjs'
import { dbFile, dataDir, migrateLegacyData } from './paths.mjs'

export function createStore({ log, file = null }) {
  let db = null
  let lastError = null
  let migrated = false
  const fileOf = () => file || dbFile()

  function open() {
    if (db) return db
    try {
      if (!migrated && !file) {
        migrated = true
        const copied = migrateLegacyData()
        if (copied.length > 0) log?.('info', `已从旧目录 zhixu/ 迁入库文件：${copied.join('、')}`)
      }
      db = openDb(fileOf())
      lastError = null
      log?.('info', `数据库已打开：${fileOf()}`)
      return db
    } catch (err) {
      lastError = err
      log?.('error', `数据库打开失败（${fileOf()}）：${String((err && err.message) || err)}`)
      throw err
    }
  }

  return {
    /** 取连接（必要时打开；打不开就抛，调用方自行降级）。 */
    get: open,
    isOpen: () => db !== null,
    error: () => (lastError ? String((lastError && lastError.message) || lastError) : null),
    file: fileOf,
    dir: dataDir,
    counts() {
      return db ? counts(db) : null
    },
    policies() {
      return db ? listPolicies(db) : {}
    },
    setPolicy(key, value) {
      if (!db) open()
      setPolicy(db, key, value)
    },
    getPolicy(key, fallback) {
      if (!db) open()
      return getPolicy(db, key, fallback)
    },
    close() {
      if (!db) return
      try { db.close() } catch (err) { log?.('warn', `数据库关闭异常：${String((err && err.message) || err)}`) }
      db = null
    },
  }
}
