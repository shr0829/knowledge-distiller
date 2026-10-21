// Scoped indexing via the pinned QMD SDK, with bounded SQLite transactions.
import { pathToFileURL } from "node:url";
const [modulePath, database, collection, folder] = process.argv.slice(2);
const { createStore, reindexCollection } = await import(pathToFileURL(modulePath).href);
const store = createStore(database);
try {
  store.db.exec("BEGIN IMMEDIATE");
  const result = await reindexCollection(store, folder, "**/*.md", collection, {
    onProgress: ({ current, total }) => {
      if (current % 1000 === 0) {
        store.db.exec("COMMIT");
        console.error(JSON.stringify({ collection, current, total }));
        store.db.exec("BEGIN IMMEDIATE");
      }
    },
  });
  store.db.exec("COMMIT");
  console.log(JSON.stringify(result));
} catch (error) {
  if (store.db.inTransaction) store.db.exec("ROLLBACK");
  throw error;
} finally { store.close(); }
