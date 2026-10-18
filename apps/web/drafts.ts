export type DraftScope = { ownerId: string; knowledgeId: string };
export type DraftRange = {
  startLine: number;
  endLine: number;
  lineByteOffset: number;
  startByte: number;
  endByte: number;
  rangeHash: string;
};
export type DraftInput = {
  noteId: string;
  kind: 'note' | 'fragment';
  content: string;
  baseRevision: string;
  range?: DraftRange;
};
export type DraftRecord = DraftInput & {
  scope: DraftScope;
  version: string;
  updatedAt: number;
};
export type DraftStore = {
  load(noteId: string): Promise<DraftRecord | undefined>;
  put(input: DraftInput): Promise<DraftRecord>;
  remove(noteId: string, expectedVersion: string): Promise<boolean>;
  clearScope(): Promise<void>;
};
export class DraftStorageError extends Error {
  constructor(public code: 'unavailable' | 'quota' | 'failed' | 'scope-cleared') {
    super(
      {
        unavailable: '浏览器无法使用本地草稿存储。请保留当前页面或复制未保存内容。',
        quota: '本地存储空间不足，草稿未写入。请复制未保存内容或手动保存原文。',
        failed: '本地草稿未能保存。请保留当前页面或复制未保存内容。',
        'scope-cleared': '当前账号已退出，本地草稿已停止保存。',
      }[code],
    );
    this.name = 'DraftStorageError';
  }
}
export function noteDraftBase(note: { modifiedAt: string; contentHash?: string | null }): string {
  return JSON.stringify([note.modifiedAt, note.contentHash ?? null]);
}

const databaseName = 'dooknow-local-drafts';
const ownerGenerations = new Map<string, number>();
let database: Promise<IDBDatabase> | undefined;
function storageError(error: unknown): DraftStorageError {
  if (error instanceof DraftStorageError) return error;
  return new DraftStorageError(
    error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'quota'
      : error instanceof DOMException &&
          ['SecurityError', 'InvalidStateError', 'NotSupportedError'].includes(error.name)
        ? 'unavailable'
        : 'failed',
  );
}
function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new DraftStorageError('unavailable'));
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      try {
        const request = indexedDB.open(databaseName, 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('drafts')) {
            const store = request.result.createObjectStore('drafts', {
              keyPath: ['scope.ownerId', 'scope.knowledgeId', 'noteId'],
            });
            store.createIndex('owner', 'scope.ownerId');
            store.createIndex('scope', ['scope.ownerId', 'scope.knowledgeId']);
          }
          if (!request.result.objectStoreNames.contains('owners'))
            request.result.createObjectStore('owners', { keyPath: 'ownerId' });
        };
        request.onblocked = () => {
          settled = true;
          reject(new DraftStorageError('unavailable'));
        };
        request.onerror = () => {
          settled = true;
          reject(storageError(request.error));
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            database = undefined;
          };
          resolve(db);
        };
      } catch (error) {
        reject(storageError(error));
      }
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (
    store: IDBObjectStore,
    value: (result: T) => void,
    tx: IDBTransaction,
    abort: (cause: unknown) => void,
  ) => void,
  guard?: () => void,
): Promise<T> {
  try {
    const db = await openDatabase();
    guard?.();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['drafts', 'owners'], mode);
      let result: T;
      let failure: DraftStorageError | undefined;
      const abort = (cause: unknown) => {
        failure = storageError(cause);
        tx.abort();
        reject(failure);
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || storageError(tx.error));
      try {
        run(
          tx.objectStore('drafts'),
          (value) => {
            result = value;
          },
          tx,
          abort,
        );
      } catch (error) {
        abort(error);
      }
    });
  } catch (error) {
    throw storageError(error);
  }
}
function validate(input: DraftInput) {
  if (
    !input.noteId ||
    !input.baseRevision ||
    typeof input.content !== 'string' ||
    !['note', 'fragment'].includes(input.kind)
  )
    throw new DraftStorageError('failed');
  if (input.kind !== 'fragment') return;
  const r = input.range;
  if (
    !r ||
    !Number.isSafeInteger(r.startLine) ||
    r.startLine < 1 ||
    !Number.isSafeInteger(r.endLine) ||
    r.endLine < r.startLine ||
    !Number.isSafeInteger(r.startByte) ||
    r.startByte < 0 ||
    !Number.isSafeInteger(r.endByte) ||
    r.endByte < r.startByte ||
    !Number.isSafeInteger(r.lineByteOffset) ||
    r.lineByteOffset < 0 ||
    !r.rangeHash ||
    new TextEncoder().encode(input.content).length > 128 * 1024
  )
    throw new DraftStorageError('failed');
}
function version(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
}
export function createDraftStore(options: { scope: DraftScope }): DraftStore {
  const scope = { ...options.scope };
  if (!scope.ownerId || !scope.knowledgeId) throw new DraftStorageError('unavailable');
  const generation = ownerGenerations.get(scope.ownerId) ?? 0;
  // Start capturing the durable owner epoch when the store is created, before
  // any later debounce callback can run. A handled result avoids an unhandled
  // rejection if storage is disabled and this store never gets used.
  const durableGeneration = transaction<string>('readonly', (_store, value, tx) => {
    const read = tx.objectStore('owners').get(scope.ownerId);
    read.onsuccess = () => value(read.result?.generation || '');
  }).then(
    (value) => ({ value }),
    (cause) => ({ error: storageError(cause) }),
  );
  const guard = () => {
    if ((ownerGenerations.get(scope.ownerId) ?? 0) !== generation)
      throw new DraftStorageError('scope-cleared');
  };
  const key = (noteId: string) => [scope.ownerId, scope.knowledgeId, noteId];
  return {
    async load(noteId) {
      return transaction<DraftRecord | undefined>('readonly', (store, value) => {
        store.get(key(noteId)).onsuccess = (event) => value((event.target as IDBRequest).result);
      });
    },
    async put(input) {
      guard();
      validate(input);
      // Snapshot before waiting for IndexedDB so later typing cannot mutate this version.
      const record: DraftRecord = structuredClone({
        ...input,
        scope,
        version: version(),
        updatedAt: Date.now(),
      });
      const expected = await durableGeneration;
      if ('error' in expected) throw expected.error;
      return transaction<DraftRecord>(
        'readwrite',
        (store, value, tx, abort) => {
          const read = tx.objectStore('owners').get(scope.ownerId);
          read.onsuccess = () => {
            if ((read.result?.generation || '') !== expected.value) {
              abort(new DraftStorageError('scope-cleared'));
              return;
            }
            try {
              store.put(record);
              value(record);
            } catch (cause) {
              abort(cause);
            }
          };
        },
        guard,
      );
    },
    async remove(noteId, expectedVersion) {
      return transaction<boolean>('readwrite', (store, value) => {
        const request = store.get(key(noteId));
        request.onsuccess = () => {
          if (!expectedVersion || request.result?.version !== expectedVersion) {
            value(false);
            return;
          }
          store.delete(key(noteId));
          value(true);
        };
      });
    },
    async clearScope() {
      await transaction<void>('readwrite', (store, value) => {
        const cursor = store
          .index('scope')
          .openKeyCursor(IDBKeyRange.only([scope.ownerId, scope.knowledgeId]));
        cursor.onsuccess = () => {
          if (cursor.result) {
            store.delete(cursor.result.primaryKey);
            cursor.result.continue();
          } else value();
        };
      });
    },
  };
}
export async function clearOwnerDrafts(ownerId: string): Promise<void> {
  ownerGenerations.set(ownerId, (ownerGenerations.get(ownerId) ?? 0) + 1);
  await transaction<void>('readwrite', (store, value, tx) => {
    // Revocation and deletion commit together; an old tab's queued write either
    // commits before this transaction and is deleted, or sees the new epoch.
    tx.objectStore('owners').put({ ownerId, generation: version() });
    const cursor = store.index('owner').openKeyCursor(IDBKeyRange.only(ownerId));
    cursor.onsuccess = () => {
      if (cursor.result) {
        store.delete(cursor.result.primaryKey);
        cursor.result.continue();
      } else value();
    };
  });
}
