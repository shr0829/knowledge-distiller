// test/m7.test.mjs — M7：主张抽取规则 + 双时态（矛盾冲突、as-of 回溯、撤销）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, get } from '../lib/db.mjs'
import { createPage } from '../lib/pages.mjs'
import {
  analyzeStatement, normalizeEntity, addClaim, liveClaims, claimsAsOf, findContradictions,
  retireClaim, supersedeConflicts, claimsOfPage, deleteClaimsOfPatch, restoreClaimsRetiredBy, claimCounts,
} from '../lib/claims.mjs'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'llm-wiki-m7-'))
  return openDb(join(dir, 'wiki.sqlite3'))
}

test('切句规则：主语 / 谓词 / 宾语', () => {
  // 括号注释不参与拆句：主语是实体本身，补充说明被剔掉
  assert.deepEqual(
    (({ subject, predicate, object }) => ({ subject, predicate, object }))(analyzeStatement('碳命中容差 ±50 raw（≈±0.05%）')),
    { subject: '碳命中容差 ±50 raw', predicate: 'states', object: '' },
  )
  assert.equal(analyzeStatement('联合命中必须单列').predicate, 'must')
  assert.equal(analyzeStatement('不取分区百分比平均').predicate, 'not')
  assert.equal(analyzeStatement('改用 SQLite 单文件').predicate, 'uses')
  assert.equal(analyzeStatement('口径即 ±50 raw').predicate, 'is')
  assert.equal(analyzeStatement('该项目采用 uv 管理环境').predicate, 'uses')

  const is = analyzeStatement('真相层是 Obsidian Markdown')
  assert.equal(is.predicate, 'is')
  assert.equal(is.subject, '真相层', '判断句的主语要停在系词前')
  assert.equal(is.object, 'obsidian markdown', '宾语要规范化（ASCII 小写）')

  const uses = analyzeStatement('该项目采用 uv 管理环境')
  assert.equal(uses.subject, '该项目')
  assert.equal(uses.object, 'uv 管理环境')
})

test('实体规范化：wikilink、标点、大小写', () => {
  assert.equal(normalizeEntity('[[评估口径]]'), '评估口径')
  assert.equal(normalizeEntity('[[评估口径|口径]]'), '评估口径')
  assert.equal(normalizeEntity('  Foo Bar  '), 'foo bar')
  assert.equal(normalizeEntity('温度偏差。'), '温度偏差')
})

test('主张：写入即现行，同主语同谓词不同宾语算矛盾', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '评估口径' })
  const a = addClaim(db, { pageId: page.id, statement: '口径是 ±50 raw' })
  const b = addClaim(db, { pageId: page.id, statement: '口径是 ±100 raw' })
  assert.equal(liveClaims(db, { projectId: 'p1' }).length, 2)

  const pairs = findContradictions(db, { projectId: 'p1' })
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].subject, '口径')
  assert.deepEqual([pairs[0].a.object, pairs[0].b.object].sort(), ['±100 raw', '±50 raw'])

  // 让旧主张失效：旧说法的 t_invalid 取新说法的 t_valid，两条首尾相接
  const retired = retireClaim(db, { id: a.id, tInvalid: b.t_valid, supersededBy: b.id })
  assert.equal(retired.t_invalid, b.t_valid)
  assert.equal(retired.superseded_by, b.id)
  assert.equal(liveClaims(db, { projectId: 'p1' }).length, 1)
  assert.equal(findContradictions(db, { projectId: 'p1' }).length, 0)

  // 历史不删：一条被取代的主张仍能读到
  assert.equal(claimsOfPage(db, page.id).length, 2)
  db.close()
})

test('as-of：按事实时间回溯，能看到旧口径', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'decision', title: '口径沿革' })
  const old = addClaim(db, { pageId: page.id, statement: '碳容差是 100 raw', tValid: '2026-01-01T00:00:00.000Z' })
  const fresh = addClaim(db, { pageId: page.id, statement: '碳容差是 50 raw', tValid: '2026-06-01T00:00:00.000Z' })
  retireClaim(db, { id: old.id, tInvalid: fresh.t_valid, supersededBy: fresh.id })

  const march = claimsAsOf(db, { asOf: '2026-03-01T00:00:00.000Z', projectId: 'p1' })
  assert.equal(march.length, 1)
  assert.match(march[0].object, /100 raw/u)

  const august = claimsAsOf(db, { asOf: '2026-08-01T00:00:00.000Z', projectId: 'p1' })
  assert.equal(august.length, 1)
  assert.match(august[0].object, /50 raw/u)

  // 现行视图只有新说法
  assert.equal(liveClaims(db, { projectId: 'p1' }).length, 1)
  db.close()
})

test('自动失效：新主张落地时把冲突的旧主张标失效，且可整批撤销', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'concept', title: '温度补偿' })
  const old = addClaim(db, { pageId: page.id, statement: '温度补偿是 线性' })
  const next = addClaim(db, { pageId: page.id, statement: '温度补偿是 分段' })

  const retired = supersedeConflicts(db, { claim: next })
  assert.equal(retired.length, 1)
  assert.equal(retired[0].id, old.id)
  assert.equal(retired[0].superseded_by, next.id)
  assert.equal(liveClaims(db, { projectId: 'p1' }).length, 1)

  // 撤销：删掉这批主张，并把被它们挤掉的旧主张复活；两者都必须带 patchId
  assert.throws(() => restoreClaimsRetiredBy(db, null), /patchId/u)
  assert.throws(() => deleteClaimsOfPatch(db, null), /patchId/u)
  db.close()
})

test('计数：total 与 live 分开', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'concept', title: '计数' })
  const a = addClaim(db, { pageId: page.id, statement: 'X 是 A' })
  addClaim(db, { pageId: page.id, statement: 'Y 是 B' })
  retireClaim(db, { id: a.id })
  const counts = claimCounts(db, { projectId: 'p1' })
  assert.equal(counts.total, 2)
  assert.equal(counts.live, 1)
  db.close()
})

test('签发主张必须带主语', () => {
  const db = temp()
  const page = createPage(db, { projectId: 'p1', kind: 'concept', title: '空' })
  assert.throws(() => addClaim(db, { pageId: page.id, statement: '。' }), /没有主语/u)
  void get
  db.close()
})
