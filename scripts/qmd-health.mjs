// Use QMD's own embedding fingerprint and completion check for the pinned runtime.
import { pathToFileURL } from "node:url";
const [modulePath, database, collection, model, semanticCollection = collection] = process.argv.slice(2);
const { createStore, getHashesNeedingEmbedding, getEmbeddingFingerprint } =
  await import(pathToFileURL(modulePath).href);
const store = createStore(database);
try {
  const documents = store.db.prepare(
    "SELECT COUNT(*) AS count FROM documents WHERE active=1 AND collection=?",
  ).get(collection).count;
  const semanticDocuments = store.db.prepare(
    "SELECT COUNT(*) AS count FROM documents WHERE active=1 AND collection=?",
  ).get(semanticCollection).count;
  const pending = getHashesNeedingEmbedding(store.db, semanticCollection, model);
  const chunks = store.db.prepare(
    `SELECT COUNT(*) AS count FROM content_vectors v WHERE model=? AND embed_fingerprint=?
     AND hash IN (SELECT hash FROM documents WHERE active=1 AND collection=?)`,
  ).get(model, getEmbeddingFingerprint(model), semanticCollection).count;
  console.log(JSON.stringify({ documents, semantic_documents: semanticDocuments, pending, chunks, model }));
} finally {
  store.close();
}
