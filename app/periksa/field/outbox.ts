/**
 * Offline outbox in IndexedDB. Every inspection / report is saved here first, then sent when the
 * phone has signal: photos are uploaded one by one (the server dedupes by hash), then the record is
 * posted with its Idempotency-Key, so a retry after a dropped connection can never create a duplicate.
 * Records belong to the officer who made them and are only ever sent with that officer's session.
 */
export type PhotoDraft = { localId: string; blob: Blob; ruleId: string | null; meta: Record<string, unknown> };
export type OutboxKind = 'inspection' | 'unlisted';
export type OutboxRecord = {
  key: string;                  // Idempotency-Key
  userId: string;
  kind: OutboxKind;
  title: string;                // shown in the log (premise / signboard name)
  summary: string;              // e.g. "Tidak patuh · 2 gambar"
  createdAt: string;
  payload: Record<string, unknown>;
  photos: PhotoDraft[];
  uploaded: Record<string, string>;     // localId → server photo id
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};
export type SentRecord = { key: string; userId: string; kind: OutboxKind; title: string; summary: string; createdAt: string; sentAt: string; serverId: string };

const DB_NAME = 'semak-premis';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('sent')) db.createObjectStore('sent', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
const db = () => (dbPromise ??= open());

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('TX_ABORTED'));
  });
}

export const putRecord = (r: OutboxRecord) => tx('outbox', 'readwrite', (s) => s.put(r));
export const deleteRecord = (key: string) => tx('outbox', 'readwrite', (s) => s.delete(key));
export const allRecords = () => tx<OutboxRecord[]>('outbox', 'readonly', (s) => s.getAll());
export const allSent = () => tx<SentRecord[]>('sent', 'readonly', (s) => s.getAll());
export const putSent = (r: SentRecord) => tx('sent', 'readwrite', (s) => s.put(r));
export const cacheGet = <T>(key: string) => tx<T | undefined>('cache', 'readonly', (s) => s.get(key));
export const cachePut = (key: string, value: unknown) => tx('cache', 'readwrite', (s) => s.put(value, key));

export function newKey(prefix: string) {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------------------------- sync
export type SyncState = { pending: number; failed: number; otherUser: number; needsLogin: boolean; syncing: boolean; lastError: string | null };

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function send(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, String(body.error ?? `HTTP_${res.status}`));
  return body.data;
}

/** Errors worth retrying later: no signal, timeouts, server trouble, rate limit, a concurrent retry in progress. */
const retryable = (e: unknown) => !(e instanceof HttpError) || e.status >= 500 || e.status === 429 || e.status === 408 || e.code === 'IDEMPOTENCY_IN_PROGRESS';

const MESSAGES: Record<string, string> = {
  PREMISE_NOT_FOUND: 'Premis tidak lagi wujud dalam data lesen.',
  RULE_NOT_IN_CHECKLIST: 'Senarai semak telah berubah. Buat semakan baharu.',
  OBSERVED_AT_TOO_OLD: 'Rekod lebih 7 hari belum dihantar. Hubungi penyelia.',
  OBSERVED_AT_IN_FUTURE: 'Jam telefon tidak betul. Betulkan tarikh dan masa telefon.',
  PHOTO_TOO_LARGE: 'Gambar terlalu besar.',
  IDEMPOTENCY_KEY_REUSED: 'Rekod bercanggah dengan rekod yang telah dihantar.',
};
export const errorMessage = (code: string | null) => (code ? MESSAGES[code] ?? `Ditolak oleh pelayan (${code}).` : '');

let running: Promise<SyncState> | null = null;

/** Send everything that is due for this officer. Safe to call often; concurrent calls share one run. */
export function syncNow(userId: string, onProgress?: (s: SyncState) => void): Promise<SyncState> {
  return (running ??= (async () => {
    const state: SyncState = { pending: 0, failed: 0, otherUser: 0, needsLogin: false, syncing: true, lastError: null };
    try {
      const records = (await allRecords()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const r of records) {
        if (r.userId !== userId) { state.otherUser++; continue; }
        if (r.status === 'failed') { state.failed++; continue; }
        if (state.needsLogin || r.nextAttemptAt > Date.now() || !navigator.onLine) { state.pending++; continue; }
        try {
          for (const p of r.photos) {
            if (r.uploaded[p.localId]) continue;
            const form = new FormData();
            form.append('file', p.blob, `${p.localId}.jpg`);
            form.append('meta', JSON.stringify(p.meta));
            const saved = await send('/api/v1/photos', { method: 'POST', body: form });
            r.uploaded[p.localId] = saved.id;
            await putRecord(r);
          }
          const photos = r.photos.map((p) => (r.kind === 'inspection' ? { photo_id: r.uploaded[p.localId], rule_id: p.ruleId } : { photo_id: r.uploaded[p.localId] }));
          const url = r.kind === 'inspection' ? '/api/v1/inspections' : '/api/v1/unlisted-reports';
          const result = await send(url, {
            method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': r.key }, body: JSON.stringify({ ...r.payload, photos }),
          });
          await putSent({ key: r.key, userId: r.userId, kind: r.kind, title: r.title, summary: r.summary, createdAt: r.createdAt, sentAt: new Date().toISOString(), serverId: result.id });
          await deleteRecord(r.key);
        } catch (error) {
          r.attempts++;
          if (error instanceof HttpError && error.status === 401) { state.needsLogin = true; state.pending++; await putRecord(r); continue; }
          if (retryable(error)) {
            r.nextAttemptAt = Date.now() + Math.min(15 * 60_000, 5_000 * 2 ** Math.min(r.attempts, 8));
            r.lastError = error instanceof HttpError ? error.code : 'NETWORK';
            state.pending++;
          } else {
            r.status = 'failed';
            r.lastError = (error as HttpError).code;
            state.failed++;
          }
          state.lastError = r.lastError;
          await putRecord(r);
        }
        onProgress?.({ ...state });
      }
    } finally {
      state.syncing = false;
      running = null;
    }
    return state;
  })());
}

export async function outboxState(userId: string): Promise<SyncState> {
  const records = await allRecords();
  return {
    pending: records.filter((r) => r.userId === userId && r.status === 'pending').length,
    failed: records.filter((r) => r.userId === userId && r.status === 'failed').length,
    otherUser: records.filter((r) => r.userId !== userId).length,
    needsLogin: false, syncing: false, lastError: null,
  };
}

/** Retry a failed record (after the officer reads why it failed). */
export async function retryRecord(key: string) {
  const r = (await allRecords()).find((x) => x.key === key);
  if (!r) return;
  r.status = 'pending'; r.nextAttemptAt = 0; r.lastError = null;
  await putRecord(r);
}
