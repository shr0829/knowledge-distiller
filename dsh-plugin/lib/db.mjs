// lib/db.mjs — 连接、迁移与最小查询封装。
//
// 驱动是 Node 内置 node:sqlite 的 DatabaseSync（同步 API）：
//   ⇒ 单次事务绝不允许跨 await（spec §7 / §8「同步写库、异步提炼」）。
// 所有绑定参数必须是 null | number | bigint | string | Uint8Array，undefined 会抛。
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_VERSION, DEFAULT_POLICIES } from './schema.mjs'
import { nowIso } from './ids.mjs'
import { migrateV2 } from './migrate-v2.mjs'

/** 打开（并初始化）数据库。 */
export function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

/** 建表 + 记录迁移版本（幂等：重开库不会重复执行）。 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)')
  db.exec(SCHEMA_SQL)
  db.exec(SCHEMA_V2_SQL)
  const applied = (id) => db.prepare('SELECT id FROM migrations WHERE id = ?').get(id)
  const mark = (id, name) => db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)')
    .run(id, name, nowIso())
  // v1 的迁移行：只标记 DDL 已执行
  if (!applied(1)) mark(1, 'schema-v1')
  // v2：先跑数据搬迁（abstractions → pages），成功后才记版本，失败可在下次打开时重试
  if (!applied(SCHEMA_VERSION)) {
    migrateV2(db)
    mark(SCHEMA_VERSION, `schema-v${SCHEMA_VERSION}`)
  }
  ensureColumns(db)
  allowPageCitations(db)
  // 默认 policies 只在缺失时落库，不覆盖用户改过的值
  const insertPolicy = db.prepare('INSERT OR IGNORE INTO policies (key, value, updated_at) VALUES (?, ?, ?)')
  const ts = nowIso()
  for (const [key, value] of Object.entries(DEFAULT_POLICIES)) insertPolicy.run(key, value, ts)
}

// ------------------------------------------------------------------ 增量列
/**
 * 增量加列（幂等）：v2 的 DDL 里已含这些列；对「v2 表已建、但还没这些列」的旧库补上。
 * 只加列，不改类型、不删列——SQLite 的 ALTER 也只有这个安全子集。
 */
function ensureColumns(db) {
  const wanted = [
    ['claims', 'patch_id', 'TEXT'],
    ['pages', 'last_patch_id', 'TEXT'],
    ['patches', 'base_sources', "TEXT NOT NULL DEFAULT '[]'"],
  ]
  for (const [table, column, type] of wanted) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
    if (columns.length === 0) continue
    if (columns.includes(column)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

// ------------------------------------------------------------------ 陈表升级
/**
 * v1 的 citations 允许的 from_layer 只有 L2/L3；v2 的页面证据是 from_layer='PAGE'。
 * SQLite 不能改 CHECK，只能重建表：旧表改名 → 建新表 → 拷数据 → 丢旧表。全程一个事务。
 */
function allowPageCitations(db) {
  const row = get(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'citations'")
  if (!row?.sql || row.sql.includes("'PAGE'")) return
  tx(db, () => {
    db.exec('ALTER TABLE citations RENAME TO citations_v1')
    db.exec(`CREATE TABLE citations (
      id         TEXT PRIMARY KEY,
      from_layer TEXT NOT NULL CHECK (from_layer IN ('L2','L3','PAGE')),
      from_id    TEXT NOT NULL,
      to_layer   TEXT NOT NULL CHECK (to_layer IN ('L1')),
      to_id      TEXT NOT NULL,
      quote      TEXT NOT NULL,
      span_start INTEGER,
      span_end   INTEGER,
      created_at TEXT NOT NULL
    )`)
    db.exec(`INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, span_start, span_end, created_at)
      SELECT id, from_layer, from_id, to_layer, to_id, quote, span_start, span_end, created_at FROM citations_v1`)
    db.exec('DROP TABLE citations_v1')
    db.exec('CREATE INDEX IF NOT EXISTS ix_citations_from ON citations(from_layer, from_id)')
    db.exec('CREATE INDEX IF NOT EXISTS ix_citations_to ON citations(to_layer, to_id)')
  })
}

// ------------------------------------------------------------------ 查询封装
export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params.map(normalizeParam))
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params.map(normalizeParam))
}

export function get(db, sql, params = []) {
  return db.prepare(sql).get(...params.map(normalizeParam))
}

export function exec(db, sql) {
  db.exec(sql)
}

function normalizeParam(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

/**
 * 同步事务：fn 必须是同步函数（内部不得 await），抛错即回滚。
 * 用 BEGIN IMMEDIATE 避免与 WAL 下的并发写互相等待升级锁。
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new Error('tx() 内不允许 await：node:sqlite 是同步 API，事务不能跨 await')
    }
    db.exec('COMMIT')
    return result
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败保留原错 */ }
    throw err
  }
}

// ------------------------------------------------------------------ policies
export function getPolicy(db, key, fallback = undefined) {
  const row = get(db, 'SELECT value FROM policies WHERE key = ?', [key])
  if (!row) return fallback
  return row.value
}

export function setPolicy(db, key, value) {
  run(db, 'INSERT INTO policies (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, String(value), nowIso()])
}

export function listPolicies(db) {
  const rows = all(db, 'SELECT key, value, updated_at FROM policies ORDER BY key')
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

// ------------------------------------------------------------------ 统计
export function counts(db) {
  const pick = (sql) => {
    const row = get(db, sql)
    return row ? Number(Object.values(row)[0]) : 0
  }
  return {
    sources: pick('SELECT COUNT(*) FROM sources'),
    sourcesLive: pick('SELECT COUNT(*) FROM sources WHERE deleted_at IS NULL'),
    extractions: pick('SELECT COUNT(*) FROM extractions'),
    candidates: pick("SELECT COUNT(*) FROM extractions WHERE status = 'candidate'"),
    abstractions: pick('SELECT COUNT(*) FROM abstractions'),
    pages: pick("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL"),
    pagesApproved: pick("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND status = 'approved'"),
    claims: pick('SELECT COUNT(*) FROM claims'),
    claimsLive: pick('SELECT COUNT(*) FROM claims WHERE t_invalid IS NULL'),
    patches: pick('SELECT COUNT(*) FROM patches'),
    patchesPending: pick("SELECT COUNT(*) FROM patches WHERE status = 'candidate'"),
    links: pick('SELECT COUNT(*) FROM links'),
    lint: pick('SELECT COUNT(*) FROM lint_findings'),
    lintErrors: pick("SELECT COUNT(*) FROM lint_findings WHERE severity = 'error'"),
    citations: pick('SELECT COUNT(*) FROM citations'),
    notes: pick('SELECT COUNT(*) FROM notes'),
    reviews: pick('SELECT COUNT(*) FROM reviews'),
    writes: pick('SELECT COUNT(*) FROM writes'),
    edges: pick('SELECT COUNT(*) FROM edges'),
  }
}
