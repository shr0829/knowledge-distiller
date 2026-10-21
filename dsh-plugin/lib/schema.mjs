// lib/schema.mjs — 单文件 SQLite 的数据模型（spec §7）。
//
// 不变量：
//   · sources 不可变（触发器拒绝 UPDATE / DELETE；唯一例外是 deleted_at 由 NULL 变时间戳的软删除）
//   · writes.review_id 必填（外键指向 reviews）
//   · notes 的 (path, revision) 唯一且单调递增，旧 revision 不删
//   · edges / fts 可整表重建且幂等
//   · approved 的 L2/L3 至少一条 citations（写入时校验 + fsck 复查）
//
// 时间统一 ISO-8601 UTC 文本；主键统一 26 位 ULID。

export const SCHEMA_VERSION = 2

export const SCHEMA_SQL = `
-- L1 原始层：会话里的每一条用户消息 / 助手回复 / 工具调用 / 汇总快照
CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,                       -- dsh-turn | dsh-tool | manual
  role           TEXT,                                -- user | assistant | summary | tool
  project_id     TEXT NOT NULL,
  session_id     TEXT,
  turn           INTEGER,
  step           INTEGER,
  locator        TEXT NOT NULL,                       -- 稳定定位串（含 #part=n）
  part           INTEGER NOT NULL DEFAULT 0,
  content        TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  meta           TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sources_locator ON sources(locator, content_sha256);
CREATE INDEX IF NOT EXISTS ix_sources_project ON sources(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sources_session ON sources(session_id, turn);

-- L1 不可变：除「只把 deleted_at 从 NULL 写成时间戳」的软删除外，任何 UPDATE 都拒绝
CREATE TRIGGER IF NOT EXISTS sources_immutable
BEFORE UPDATE ON sources
WHEN NOT (
  OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.kind IS OLD.kind
  AND NEW.role IS OLD.role
  AND NEW.project_id IS OLD.project_id
  AND NEW.session_id IS OLD.session_id
  AND NEW.turn IS OLD.turn
  AND NEW.step IS OLD.step
  AND NEW.locator IS OLD.locator
  AND NEW.part IS OLD.part
  AND NEW.content IS OLD.content
  AND NEW.content_sha256 IS OLD.content_sha256
  AND NEW.meta IS OLD.meta
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'sources are immutable');
END;

CREATE TRIGGER IF NOT EXISTS sources_no_delete
BEFORE DELETE ON sources
BEGIN
  SELECT RAISE(ABORT, 'sources are immutable');
END;

-- L2 抽取层
CREATE TABLE IF NOT EXISTS extractions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  kind        TEXT,
  status      TEXT NOT NULL DEFAULT 'candidate'
              CHECK (status IN ('candidate','approved','discarded','deferred')),
  uncertain   INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  source_ids  TEXT NOT NULL DEFAULT '[]',
  model       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_extractions_status ON extractions(status, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_extractions_fingerprint
  ON extractions(fingerprint) WHERE fingerprint IS NOT NULL;

-- L3 抽象层
CREATE TABLE IF NOT EXISTS abstractions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('principle','decision','experience','preference','hypothesis','task')),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'candidate'
              CHECK (status IN ('candidate','approved','discarded','deferred')),
  uncertain   INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_abstractions_status ON abstractions(status, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_abstractions_fingerprint
  ON abstractions(fingerprint) WHERE fingerprint IS NOT NULL;

-- 引用：L2/L3/PAGE → L1（quote 必须是原文逐字片段，落库后校验）
CREATE TABLE IF NOT EXISTS citations (
  id         TEXT PRIMARY KEY,
  from_layer TEXT NOT NULL CHECK (from_layer IN ('L2','L3','PAGE')),
  from_id    TEXT NOT NULL,
  to_layer   TEXT NOT NULL CHECK (to_layer IN ('L1')),
  to_id      TEXT NOT NULL,
  quote      TEXT NOT NULL,
  span_start INTEGER,
  span_end   INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_citations_from ON citations(from_layer, from_id);
CREATE INDEX IF NOT EXISTS ix_citations_to ON citations(to_layer, to_id);

-- Markdown 真相层的历史（正文在 vault 文件里，这里存每次写入的快照）
CREATE TABLE IF NOT EXISTS notes (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  content        TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  superseded_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notes_path_rev ON notes(path, revision);
CREATE INDEX IF NOT EXISTS ix_notes_path ON notes(path, revision DESC);

-- 审核动作（唯一写入闸门）
CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  target_layer TEXT NOT NULL CHECK (target_layer IN ('L2','L3')),
  target_id    TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('accept','discard','defer','edit')),
  before       TEXT,
  after        TEXT,
  actor        TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reviews_target ON reviews(target_layer, target_id, created_at DESC);

-- vault 写入记录（review_id 必填：没有审核就没有写入）
CREATE TABLE IF NOT EXISTS writes (
  id         TEXT PRIMARY KEY,
  review_id  TEXT NOT NULL REFERENCES reviews(id),
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_writes_path ON writes(path, created_at DESC);

-- 图谱邻接表
CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  from_layer TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_layer   TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('derived_from','contradicts','extends','same_topic')),
  weight     REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_edges
  ON edges(from_layer, from_id, to_layer, to_id, kind);

-- 全文索引（独立表，可整表重建且幂等：spec §7 允许重建）
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  layer UNINDEXED,
  ref_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61'
);

-- 行为开关（autoWrite 等）
CREATE TABLE IF NOT EXISTS policies (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 检索反馈
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  target_layer TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  signal       TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_feedback_target ON feedback(target_layer, target_id);

-- 后台任务（提炼、写入、重建索引）
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','done','failed','skipped')),
  payload    TEXT NOT NULL DEFAULT '{}',
  result     TEXT,
  error      TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status, created_at DESC);

-- 用户偏好（可在面板里改；与 Config 的关系：Config 是宿主持有的条目配置，
-- settings 表是本插件自己的运行态偏好，读时以 Config 为初值）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
`

/**
 * v2（docs/DSH_WIKI_SPEC.md §4）：L3 从「记录」升级为「页面」。
 *
 * 真相层仍是 vault 里的 Markdown；这里存的是索引、版本、快照与待审对象：
 *   · pages      —— 页面（Markdown 文件的指针 + 检索/索引字段 + 最后一次写入的正文快照）
 *   · claims     —— 句子级主张，双时态（事实时间 tValid/tInvalid，记录时间 tCreated/tExpired）
 *   · links      —— 页间 wikilink 图（可从正文整表重建）
 *   · patches    —— 编译产出的页面差分（待审对象；审核前不落页）
 *   · lint_findings —— 六项自检结果（每次运行一组，可清空重算）
 *   · page_feedback —— 页面有用/无用反馈（驱动检索排序的 feedback 分项）
 *
 * v1 的 abstractions 表保留（只读，退役但不删）：迁移时按 kind 映射成 pages。
 */
export const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS pages (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('concept','decision','entity','answer','timeline','index')),
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  path           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'candidate'
                 CHECK (status IN ('candidate','approved','discarded','deferred','stale')),
  revision       INTEGER NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '[]',
  body           TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL DEFAULT '',
  ingested_at    TEXT NOT NULL,
  compiled_at    TEXT,
  linted_at      TEXT,
  last_patch_id  TEXT,
  deleted_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pages_path ON pages(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pages_project_slug ON pages(project_id, kind, slug);
CREATE INDEX IF NOT EXISTS ix_pages_project ON pages(project_id, status, kind);

CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL REFERENCES pages(id),
  patch_id      TEXT,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL DEFAULT '',
  statement     TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
  t_valid       TEXT NOT NULL,
  t_invalid     TEXT,
  t_created     TEXT NOT NULL,
  t_expired     TEXT,
  superseded_by TEXT REFERENCES claims(id),
  source_ids    TEXT NOT NULL DEFAULT '[]',
  CHECK (t_invalid IS NULL OR t_valid <= t_invalid),
  CHECK (t_expired IS NULL OR t_created <= t_expired)
);
CREATE INDEX IF NOT EXISTS ix_claims_page ON claims(page_id);
CREATE INDEX IF NOT EXISTS ix_claims_spo ON claims(subject, predicate, object);
CREATE INDEX IF NOT EXISTS ix_claims_valid ON claims(t_valid, t_invalid);

CREATE TABLE IF NOT EXISTS links (
  from_page TEXT NOT NULL REFERENCES pages(id),
  to_page   TEXT NOT NULL REFERENCES pages(id),
  kind      TEXT NOT NULL CHECK (kind IN ('related','evidence','contradicts','extends')),
  weight    REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (from_page, to_page, kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_links ON links(from_page, to_page, kind);

CREATE TABLE IF NOT EXISTS patches (
  id            TEXT PRIMARY KEY,
  page_id       TEXT,
  project_id    TEXT NOT NULL,
  base_revision INTEGER,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'concept',
  ops           TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','approved','discarded','deferred')),
  fingerprint   TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT 'rules',
  reason        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_patches_fingerprint ON patches(fingerprint);
CREATE INDEX IF NOT EXISTS ix_patches_status ON patches(status, project_id);

CREATE TABLE IF NOT EXISTS lint_findings (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  kind       TEXT NOT NULL
             CHECK (kind IN ('contradiction','stale','orphan','missing-page','missing-link','broken-quote','gap')),
  page_id    TEXT,
  claim_id   TEXT,
  detail     TEXT NOT NULL,
  suggestion TEXT NOT NULL DEFAULT '',
  severity   TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','error')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lint_kind ON lint_findings(kind, severity);
CREATE INDEX IF NOT EXISTS ix_lint_run ON lint_findings(run_id);

CREATE TABLE IF NOT EXISTS page_feedback (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL REFERENCES pages(id),
  verdict    TEXT NOT NULL CHECK (verdict IN ('useful','irrelevant','wrong')),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_page_feedback ON page_feedback(page_id, verdict);
`

/** 默认行为开关（spec §13：policies 是行为开关，autoWrite=false 永不允许自动写）。 */
export const DEFAULT_POLICIES = Object.freeze({
  autoWrite: 'false',
  autoRunPipeline: 'true',
  captureEnabled: 'true',
  retrievalWeightText: '0.6',
  retrievalWeightRecency: '0.25',
  retrievalWeightCentrality: '0.15',
  // v2：检索加入反馈分项后，文本权重让出 0.05（权重总和仍为 1）
  retrievalWeightFeedback: '0.10',
  retrievalMaxResults: '8',
  fsckOnStart: 'true',
  // v2：编译与页面维护
  compileMaxPages: '6',
  pageMaxBytes: '12288',
  staleAfterDays: '180',
})
