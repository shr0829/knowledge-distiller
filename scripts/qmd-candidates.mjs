// Lightweight recall over the pinned QMD database. Never load content.doc.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
const [modulePath, database, model, collection, limitText, mode, query] = process.argv.slice(2);
const { createStore, getEmbeddingFingerprint } = await import(pathToFileURL(modulePath).href);
const { LlamaCpp, formatQueryForEmbedding } = await import(pathToFileURL(join(dirname(modulePath), "llm.js")).href);
const store = createStore(database);
const limit = Math.max(1, Math.min(Number(limitText), 160));
let llm;
const started = performance.now();
try {
  if (mode !== "hybrid") {
    console.log(JSON.stringify({ results: [], metrics: { vectors_compared: 0 } }));
  } else {
    const present = store.db.prepare("SELECT name FROM sqlite_master WHERE name='vectors_vec'").get();
    if (!present) throw new Error("QMD vector table is unavailable");
    const modelStat = statSync(model);
    const key = store.getCacheKey("library-query-embedding-v1", {
      query, model, fingerprint: getEmbeddingFingerprint(model),
      size: modelStat.size, modified: modelStat.mtimeMs,
    });
    store.db.exec(`CREATE TABLE IF NOT EXISTS library_query_cache(
      key TEXT PRIMARY KEY,value TEXT NOT NULL,bytes INTEGER NOT NULL,last_used TEXT NOT NULL)`);
    const cached = store.db.prepare("SELECT value FROM library_query_cache WHERE key=?").get(key);
    let result = cached ? JSON.parse(cached.value) : null;
    if (!result) {
      llm = new LlamaCpp({ embedModel: model });
      result = await llm.embed(formatQueryForEmbedding(query, model));
      if (!result) throw new Error("Query embedding unavailable");
      const value = JSON.stringify(result);
      store.db.prepare("INSERT OR REPLACE INTO library_query_cache VALUES(?,?,?,?)")
        .run(key, value, Buffer.byteLength(value)+256, new Date().toISOString());
      // Byte capacity, rather than a file/count limit.
      while (store.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM library_query_cache").get().bytes > 4*1024*1024) {
        store.db.exec("DELETE FROM library_query_cache WHERE key=(SELECT key FROM library_query_cache ORDER BY last_used LIMIT 1)");
      }
    } else {
      store.db.prepare("UPDATE library_query_cache SET last_used=? WHERE key=?").run(new Date().toISOString(), key);
    }
    const keyRows = store.db.prepare(`
      SELECT DISTINCT cv.hash || '_' || cv.seq AS key
      FROM content_vectors cv JOIN documents d ON d.hash=cv.hash AND d.active=1
      WHERE d.collection=? AND cv.model=? AND cv.embed_fingerprint=?
    `).iterate(collection, model, getEmbeddingFingerprint(model));
    // This is an explicit exact scan, not an ANN index. Its cost remains
    // proportional to this collection; metrics make that work visible.
    let compared = 0;
    const distances = [];
    const keep = limit * 3;
    function compare(batch) {
      const scored = store.db.prepare(`
        SELECT hash_seq,vec_distance_cosine(embedding,?) AS distance
        FROM vectors_vec WHERE hash_seq IN (${batch.map(() => "?").join(",")})
      `).all(new Float32Array(result.embedding), ...batch);
      compared += batch.length;
      distances.push(...scored);
      distances.sort((a, b) => a.distance - b.distance);
      distances.length = Math.min(keep, distances.length);
    }
    let batch = [];
    for (const row of keyRows) {
      batch.push(row.key);
      if (batch.length === 400) { compare(batch); batch = []; }
    }
    if (batch.length) compare(batch);
    const chosen = distances;
    const rows = [];
    const seen = new Set();
    const find = store.db.prepare(`
      SELECT d.path,cv.pos FROM content_vectors cv
      JOIN documents d ON d.hash=cv.hash AND d.active=1
      WHERE cv.hash=? AND cv.seq=? AND d.collection=? AND cv.model=? AND cv.embed_fingerprint=?
    `);
    for (const vector of chosen) {
      const [hash, seq] = vector.hash_seq.split("_");
      for (const row of find.all(hash, Number(seq), collection, model, getEmbeddingFingerprint(model))) {
        if (seen.has(row.path)) continue;
        seen.add(row.path);
        rows.push({ file: row.path, chunkPos: row.pos, score: 1-vector.distance });
      }
      if (rows.length >= limit) break;
    }
    console.log(JSON.stringify({ results: rows.slice(0, limit), metrics: {
      vectors_compared: compared, candidates: rows.length,
      embedding_cache_hit: Boolean(cached), seconds: (performance.now()-started)/1000,
      algorithm: "collection-scoped-exact-cosine",
    } }));
  }
} finally {
  if (llm) await llm.dispose();
  store.close();
}
