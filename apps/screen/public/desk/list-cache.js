// The lists this device last had, kept in IndexedDB with their ETags: a reload (every deploy reloads the page)
// paints at once and asks the server only whether anything changed, which is usually a 304.
// Never throws into the desk: no IndexedDB (a private window, an old browser) just means no cache.

const DB = 'tango-desk';
const STORE = 'lists';

/**
 * @param {{ indexedDB?: IDBFactory | null }} [options]
 * @returns {{ read: (key: string) => Promise<{ etag: string, build: string | null, data: object } | null>, write: (key: string, value: { etag: string, build: string | null, data: object }) => Promise<void> }}
 */
export function createListCache({ indexedDB = typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB } = {}) {
  let opening = null;
  const open = () => {
    if (!indexedDB) return Promise.resolve(null);
    opening ??= new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return opening;
  };
  const run = async (mode, work) => {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result ?? null);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  };
  return {
    read: (key) => run('readonly', (store) => store.get(key)).then((value) => (value && value.etag && value.data ? value : null)),
    write: (key, value) => run('readwrite', (store) => store.put(value, key)).then(() => undefined),
  };
}
