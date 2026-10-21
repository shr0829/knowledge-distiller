// Update a QMD collection from a bounded path manifest without rescanning
// every document body in the collection.
import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

const [modulePath, database, collection, folder, manifestPath] = process.argv.slice(2);
if (!modulePath || !database || !collection || !folder || !manifestPath) {
  throw new Error("usage: qmd-incremental.mjs module database collection folder manifest");
}
const {
  createStore,
  extractTitle,
  hashContent,
  insertContent,
  insertDocument,
  deactivateDocument,
  cleanupOrphanedContent,
} = await import(pathToFileURL(modulePath).href);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const store = createStore(database);
const root = resolve(folder);
const now = new Date().toISOString();
const normalized = (value) => value.replaceAll("\\", "/");
const inside = (value) => {
  const rel = relative(root, resolve(root, value));
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}${sep}`);
};
let indexed = 0;
let removed = 0;
const skipped = [];
try {
  store.db.exec("BEGIN IMMEDIATE");
  for (const path of manifest.upsert ?? []) {
    if (!inside(path)) {
      skipped.push({ path, code: "OUTSIDE_COLLECTION" });
      continue;
    }
    const full = resolve(root, path);
    let content, stat;
    try {
      content = readFileSync(full, "utf8");
      stat = statSync(full);
    } catch (error) {
      skipped.push({ path, code: error?.code || "READ_FAILED" });
      continue;
    }
    const hash = await hashContent(content);
    insertContent(store.db, hash, content, now);
    insertDocument(store.db, collection, normalized(path), extractTitle(content, path), hash,
      now, new Date(stat.mtimeMs).toISOString());
    indexed++;
  }
  for (const path of manifest.remove ?? []) {
    deactivateDocument(store.db, collection, normalized(path));
    removed++;
  }
  cleanupOrphanedContent(store.db);
  store.db.exec("COMMIT");
  console.log(JSON.stringify({ indexed, removed, skipped }));
} catch (error) {
  if (store.db.inTransaction) store.db.exec("ROLLBACK");
  throw error;
} finally {
  store.close();
}
