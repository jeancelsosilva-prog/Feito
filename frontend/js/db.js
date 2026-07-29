// Camada de persistência local. Regra do projeto: IndexedDB é o banco principal
// (installationId, token, tarefas em cache, preferências). localStorage só é usado para
// uma flag minúscula de onboarding (ver getOnboardingSeenSync/setOnboardingSeenSync),
// porque precisa ser lida de forma síncrona antes do IndexedDB abrir, para decidir a
// primeira tela sem "piscar" a UI.

const DB_NAME = 'feito-db';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_TASKS = 'tasks_cache';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        const store = db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

// --- Chave-valor genérico (installationId, token, preferências, localização de casa, etc.) ---

export async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_KV, 'readonly').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_KV, 'readwrite').put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function kvDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_KV, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Cache de tarefas (para exibir algo offline enquanto não sincroniza) ---

export async function cacheTasksReplace(tasks) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, STORE_TASKS, 'readwrite');
    store.clear();
    for (const task of tasks) store.put(task);
    const req = store.transaction;
    req.oncomplete = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function cacheTaskUpsert(task) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_TASKS, 'readwrite').put(task);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function cacheTasksGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, STORE_TASKS, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Apaga TODOS os dados locais (installationId, token, tarefas em cache, preferências). */
export async function wipeAllLocalData() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const txn = db.transaction([STORE_KV, STORE_TASKS], 'readwrite');
    txn.objectStore(STORE_KV).clear();
    txn.objectStore(STORE_TASKS).clear();
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
  });
  try {
    localStorage.removeItem('feito.onboardingSeen');
  } catch {
    // localStorage pode não estar disponível (modo privado restrito) — não é crítico aqui.
  }
}

// --- Flag de onboarding em localStorage (única exceção — precisa ser síncrona no boot) ---

export function getOnboardingSeenSync() {
  try {
    return localStorage.getItem('feito.onboardingSeen') === 'true';
  } catch {
    return false;
  }
}

export function setOnboardingSeenSync(value) {
  try {
    localStorage.setItem('feito.onboardingSeen', value ? 'true' : 'false');
  } catch {
    // ignora — pior caso, o onboarding aparece de novo na próxima visita.
  }
}
