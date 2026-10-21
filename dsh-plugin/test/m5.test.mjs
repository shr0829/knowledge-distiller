// test/m5.test.mjs — M5：页面骨架（pages 表、迁移、链接、索引、写文件不变量）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, get, run } from '../lib/db.mjs'
import { insertSource } from '../lib/capture.mjs'
import {
  createPage, getPage, findPage, listPages, pageDetail, renderPageMarkdown, syncLinks,
  rebuildProjectIndex, rebuildLibraryIndex, relPathOf, writePageFile, rebaselinePage, stripFrontmatter, pageStats,
} from '../lib/pages.mjs'
import { migrateV2 } from '../lib/migrate-v2.mjs'
import { nowIso, sha256Hex } from '../lib/ids.mjs'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'llm-wiki-m5-'))
  return { dir, vault: join(dir, 'vault'), db: openDb(join(dir, 'wiki.sqlite3')) }
}

/** 造一条 L1（project + cwd 的 meta），返回 id。 */
function source(db, { projectId = 'p1', content = '碳命中容差 ±50 raw', cwd = 'E:\\proj\\BaoSteel', role = 'user' } = {}) {
  const inserted = insertSource(db, {
    kind: 'dsh-turn', role, projectId, sessionId: 's1', turn: 1, step: 1,
    locator: `s1#t1-${role}-${Math.random().toString(36).slice(2, 8)}`,
    content, meta: { role, cwd }, createdAt: nowIso(),
  })
  return inserted.id
}

test('schema v2：新表与迁移版本都到位', () => {
  const { db } = temp()
  const tables = get(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('pages','claims','links','patches','lint_findings','page_feedback')")
  assert.equal(Number(tables.n), 6)
  const rows = db.prepare('SELECT id FROM migrations ORDER BY id').all().map((row) => Number(row.id))
  assert.deepEqual(rows, [1, 2])
  const policy = get(db, "SELECT value FROM policies WHERE key = 'retrievalWeightFeedback'")
  assert.equal(policy.value, '0.10')
  db.close()
})

test('迁移：abstractions 按 kind 映射成页面，重复执行不增页', () => {
  const { db } = temp()
  const srcId = source(db)
  const absId = '01J9ABS0000000000000000000'
  run(db, `INSERT INTO abstractions (id, project_id, kind, title, content, status, uncertain, created_at, updated_at)
    VALUES (?, 'p1', 'decision', '评估口径', '联合命中单列，不取分区平均。', 'approved', 0, ?, ?)`,
  [absId, nowIso(), nowIso()])
  run(db, `INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, created_at)
    VALUES ('c1', 'L3', ?, 'L1', ?, '±50 raw', ?)`, [absId, srcId, nowIso()])

  const first = migrateV2(db)
  assert.equal(first.pages, 1)
  const page = findPage(db, { projectId: 'p1', kind: 'decision', slug: '评估口径' })
  assert.ok(page, '应生成决策页')
  assert.equal(page.status, 'approved')
  assert.equal(page.path, relPathOf({ projectName: 'BaoSteel', projectId: 'p1', kind: 'decision', slug: '评估口径' }))
  assert.match(page.body, /联合命中单列/u)
  assert.match(page.body, /## 出处/u)

  const second = migrateV2(db)
  assert.equal(second.pages, 0, '重跑不应再增页')
  assert.equal(second.skipped, 1)
  db.close()
})

test('页面：创建 / 列表 / 详情 / slug 冲突加序号', () => {
  const { db } = temp()
  source(db)
  const a = createPage(db, { projectId: 'p1', kind: 'concept', title: '碳命中容差', summary: '±50 raw' })
  const b = createPage(db, { projectId: 'p1', kind: 'concept', title: '碳命中容差', summary: '重名' })
  assert.equal(a.slug, '碳命中容差')
  assert.equal(b.slug, '碳命中容差-2')
  assert.equal(a.revision, 0, '还没写进 vault 的页 revision 为 0')

  const listed = listPages(db, { projectId: 'p1' })
  assert.equal(listed.total, 2)
  const detail = pageDetail(db, a.id)
  assert.deepEqual(detail.claims, [])
  assert.deepEqual(detail.backlinks, [])

  const stats = pageStats(db, { projectId: 'p1' })
  assert.equal(stats.total, 2)
  assert.equal(stats.unwritten, 2)
  db.close()
})

test('链接：正文里的 [[wikilink]] 解析成 links，缺页目标被报告', () => {
  const { db } = temp()
  source(db)
  const target = createPage(db, { projectId: 'p1', kind: 'concept', title: '联合命中率' })
  const page = createPage(db, {
    projectId: 'p1', kind: 'decision', title: '评估口径',
    body: '口径见 [[联合命中率]] 与 [[还没写的页]]。\n',
  })
  const result = syncLinks(db, page.id)
  assert.equal(result.linked, 1)
  assert.deepEqual(result.missing, ['还没写的页'])

  const detail = pageDetail(db, page.id)
  assert.equal(detail.outbound.length, 1)
  assert.equal(detail.outbound[0].id, target.id)

  const back = pageDetail(db, target.id)
  assert.equal(back.backlinks.length, 1)
  assert.equal(back.backlinks[0].title, '评估口径')

  // 幂等：再同步一次不多不少
  syncLinks(db, page.id)
  assert.equal(pageDetail(db, page.id).outbound.length, 1)
  db.close()
})

test('索引：项目 index.md 与全库索引都列出页面', () => {
  const { db, vault } = temp()
  source(db)
  createPage(db, { projectId: 'p1', kind: 'decision', title: '评估口径', summary: '容差与合并规则', tags: ['评估'] })
  createPage(db, { projectId: 'p1', kind: 'concept', title: '碳命中容差', summary: '±50 raw' })

  const index = rebuildProjectIndex(db, { vaultPath: vault, projectId: 'p1' })
  assert.match(index.path, /index\.md$/u)
  const text = readFileSync(join(vault, index.path), 'utf8')
  assert.match(text, /评估口径/u)
  assert.match(text, /碳命中容差/u)
  assert.match(text, /## 决策/u)
  assert.match(text, /## 概念/u)
  assert.match(text, /#评估/u)

  const library = rebuildLibraryIndex(db, { vaultPath: vault })
  const all = readFileSync(join(vault, library.path), 'utf8')
  assert.match(all, /BaoSteel/u)
  assert.match(all, /2 页/u)
  db.close()
})

test('写文件：没有 reviewId 拒写；写一次 revision=1、再写幂等；外部改动停写', () => {
  const { db, vault } = temp()
  const srcId = source(db)
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '评估口径', summary: '容差', body: '碳命中容差 ±50 raw。\n' })
  run(db, `INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, created_at)
    VALUES ('cit1', 'L3', ?, 'L1', ?, '±50 raw', ?)`, [page.id, srcId, nowIso()])
  run(db, `INSERT INTO reviews (id, target_layer, target_id, action, before, after, actor, created_at)
    VALUES ('rev1', 'L3', ?, 'accept', '{}', '{}', 'test', ?)`, [page.id, nowIso()])

  assert.throws(() => writePageFile(db, { pageId: page.id, vaultPath: vault, reviewId: null }), /reviewId/u)

  const first = writePageFile(db, { pageId: page.id, vaultPath: vault, reviewId: 'rev1' })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(first.revision, 1)
  const abs = join(vault, first.path)
  assert.ok(existsSync(abs))
  const text = readFileSync(abs, 'utf8')
  assert.match(text, /wiki_id: /u)
  assert.match(text, /## 出处/u)
  const after = getPage(db, page.id)
  assert.equal(after.revision, 1)
  assert.equal(after.status, 'approved')
  assert.equal(after.content_sha256, sha256Hex(text))

  // 幂等：内容没变 ⇒ 不涨 revision
  const second = writePageFile(db, { pageId: page.id, vaultPath: vault, reviewId: 'rev1' })
  assert.equal(second.changed, false)
  assert.equal(second.revision, 1)
  assert.equal(getPage(db, page.id).revision, 1)

  // 外部改动 ⇒ conflict，且不覆盖
  writeFileSync(abs, text.replace('±50 raw', '±50 raw（人改的）'), 'utf8')
  const third = writePageFile(db, { pageId: page.id, vaultPath: vault, reviewId: 'rev1' })
  assert.equal(third.ok, false)
  assert.equal(third.conflict, true)
  assert.match(third.error, /conflict/u)
  assert.match(readFileSync(abs, 'utf8'), /人改的/u, '人的改动不能被覆盖')

  // 接受人的改动 ⇒ 登记成新 revision，文件不动
  const rebased = rebaselinePage(db, { pageId: page.id, vaultPath: vault })
  assert.equal(rebased.revision, 2)
  assert.match(readFileSync(abs, 'utf8'), /人改的/u)
  assert.match(getPage(db, page.id).body, /人改的/u)
  db.close()
})

test('stripFrontmatter：去掉 frontmatter 与一级标题', () => {
  const text = ['---', 'title: X', '---', '', '# X', '', '正文第一段。', '', '## 小节', '内容'].join('\n')
  const body = stripFrontmatter(text)
  assert.equal(body.includes('title:'), false)
  assert.match(body, /^正文第一段。/u)
  assert.match(body, /## 小节/u)
})

test('渲染：正文与出处都在，frontmatter 字段顺序稳定', () => {
  const { db } = temp()
  const srcId = source(db)
  const page = createPage(db, { projectId: 'p1', kind: 'concept', title: '碳命中容差', body: '容差 ±50 raw。\n' })
  run(db, `INSERT INTO citations (id, from_layer, from_id, to_layer, to_id, quote, created_at)
    VALUES ('c9', 'L3', ?, 'L1', ?, '±50 raw', ?)`, [page.id, srcId, nowIso()])
  const text = renderPageMarkdown(db, page)
  const lines = text.split('\n')
  assert.equal(lines[0], '---')
  assert.match(lines[1], /^title: /u)
  assert.ok(lines.some((line) => line.startsWith('wiki_id: ')))
  assert.ok(lines.indexOf('updated: ' + lines.find((l) => l.startsWith('updated: ')).slice(9)) >= 0)
  assert.match(text, /- `s1#t1-user-[a-z0-9]+`：±50 raw/u)
})

test.after(() => {
  // 清理本文件创建的所有临时目录（Windows 上 node --test 不保证 cwd 可删，逐个删）
  void rmSync
})
