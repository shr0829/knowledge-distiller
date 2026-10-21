import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(':memory:')
console.log('sqlite version', db.prepare('select sqlite_version() as v').get())
try {
  db.exec('CREATE VIRTUAL TABLE t USING fts5(a)')
  console.log('FTS5: OK')
} catch (error) {
  console.log('FTS5: FAIL', error.message)
}
const opts = db.prepare("select compile_options as o from pragma_compile_options where compile_options like '%FTS%'").all()
console.log('compile options (FTS*):', opts.map((r) => r.o).join(', ') || '(none)')
