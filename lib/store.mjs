/**
 * Хранилище счётчиков (лимиты частоты, блокировка входа).
 *
 * На Netlify — Netlify Blobs (функции не помнят ничего между вызовами).
 * Локально (dev-server.mjs, тесты) — память процесса: SQLGEN_MEMORY_STORE=1.
 */

export function memoryStore() {
  const data = new Map();
  return {
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
  };
}

function blobStore() {
  let storePromise;
  const store = () => (storePromise ??= import("@netlify/blobs").then(({ getStore }) =>
    getStore({ name: "sqlgen-limits", consistency: "strong" })));
  return {
    async get(key) { return (await store()).get(key, { type: "json" }); },
    async set(key, value) { await (await store()).setJSON(key, value); },
    async delete(key) { await (await store()).delete(key); },
  };
}

let shared;
/** Общее хранилище для всего процесса. */
export function getSharedStore() {
  shared ??= process.env.SQLGEN_MEMORY_STORE === "1" ? memoryStore() : blobStore();
  return shared;
}
