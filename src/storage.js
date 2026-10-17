import { assertJSONValue, validateSaveRecord, validateTimestamp } from './compatibility.js';

// Pre-PathOS identifiers. Renaming them would orphan existing libraries and reject earlier backups.
export const DATABASE_NAME = 'story-vault';
export const DATABASE_VERSION = 1;
export const BACKUP_FORMAT = 'story-vault-backup';
export const MAX_AUTOSAVES_PER_VERSION = 20;
const STORES = ['games', 'versions', 'saves', 'profiles'];
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requiredString(record, field, label) {
  if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error(`${label} is missing ${field}.`);
}

export function validateRecord(store, record) {
  if (!STORES.includes(store)) throw new Error(`Unknown database store: ${store}.`);
  if (!plain(record)) throw new Error('A database record must be an object.');
  requiredString(record, 'id', 'The record');
  if (store === 'saves') return validateSaveRecord(record);
  if (store === 'games') requiredString(record, 'title', 'The game');
  if (store === 'versions') {
    requiredString(record, 'gameId', 'The version');
    requiredString(record, 'label', 'The version');
    validateTimestamp(record.createdAt, 'The version');
    requiredString(record, 'contentHash', 'The version');
    requiredString(record, 'entryPath', 'The version');
    if (!Array.isArray(record.files) || !record.files.length) throw new Error('The version contains no game files.');
    const paths = new Set();
    for (const file of record.files) {
      requiredString(file, 'path', 'A game file');
      if (file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => part === '..' || part === '.')) throw new Error('The version contains an unsafe file path.');
      if (paths.has(file.path)) throw new Error('The version contains duplicate file paths.');
      paths.add(file.path);
      if (!(file.data instanceof Uint8Array)) throw new Error('A game file has invalid binary data.');
      if (file.mime !== undefined && typeof file.mime !== 'string') throw new Error('A game file has an invalid content type.');
    }
    if (!paths.has(record.entryPath)) throw new Error('The game entry file is missing.');
    const { files, ...metadata } = record;
    assertJSONValue(metadata);
  } else assertJSONValue(record);
  return record;
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

export function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('A backup file contains invalid base64 data.');
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function encodeBackup(records) {
  for (const store of STORES) for (const record of records[store] ?? []) validateRecord(store, record);
  const backup = {
    format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    games: records.games ?? [],
    versions: (records.versions ?? []).map(version => ({ ...version, files: version.files.map(file => ({ ...file, data: bytesToBase64(file.data), encoding: 'base64' })) })),
    saves: records.saves ?? [], profiles: records.profiles ?? [],
  };
  validateRelationships(records);
  return backup;
}

export function decodeBackup(input) {
  if (typeof input === 'string') {
    if (input.length > MAX_BACKUP_BYTES * 1.4) throw new Error('This backup is too large.');
    try { input = JSON.parse(input); } catch { throw new Error('The backup is not valid JSON.'); }
  }
  if (!plain(input) || input.format !== BACKUP_FORMAT || input.version !== 1) throw new Error('This isn’t a PathOS backup file, or it uses an unsupported format.');
  assertJSONValue(input);
  for (const store of STORES) if (!Array.isArray(input[store])) throw new Error(`The backup is missing ${store}.`);
  let totalBytes = 0;
  const records = {
    games: input.games,
    versions: input.versions.map(version => {
      if (!Array.isArray(version.files)) throw new Error('A version contains no file list.');
      return { ...version, files: version.files.map(file => {
        if (file.encoding !== 'base64') throw new Error('A game file has unsupported encoding.');
        totalBytes += typeof file.data === 'string' ? Math.floor(file.data.length * 0.75) : 0;
        if (totalBytes > MAX_BACKUP_BYTES) throw new Error('This backup is too large.');
        const { encoding, ...decoded } = file;
        return { ...decoded, data: base64ToBytes(file.data) };
      }) };
    }),
    saves: input.saves,
    profiles: input.profiles,
  };
  for (const store of STORES) {
    const ids = new Set();
    for (const record of records[store]) {
      validateRecord(store, record);
      if (ids.has(record.id)) throw new Error(`The backup contains duplicate ${store} IDs.`);
      ids.add(record.id);
    }
  }
  validateRelationships(records);
  return records;
}

export function validateRelationships(records) {
  const games = new Map((records.games ?? []).map(game => [game.id, game]));
  const versions = new Map((records.versions ?? []).map(version => [version.id, version]));
  for (const version of versions.values()) if (!games.has(version.gameId)) throw new Error('A version references a missing game.');
  for (const game of games.values()) {
    if (game.activeVersionId && versions.get(game.activeVersionId)?.gameId !== game.id) throw new Error('A game references a missing or unrelated active version.');
  }
  for (const save of records.saves ?? []) {
    if (!games.has(save.gameId) || versions.get(save.versionId)?.gameId !== save.gameId) throw new Error('A save references a missing or unrelated game version.');
  }
}

export function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('Device storage is full. Export a backup, then remove an unused game version or free device storage and try again.');
  if (error?.name === 'VersionError') return new Error('This library was created by a newer version of PathOS. Update the app to open it.');
  return error instanceof Error ? error : new Error(String(error || 'The library could not be saved.'));
}

// Native JSON round trips may reorder object keys; save identity compares values.
const canonical = value => JSON.stringify(value, (_, item) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// Both backends use the same validation, merge and save-retention rules.
export function createVault(transact, storageKind = 'browser') {
  function mergeRecords(imported, markMigrated = false) {
    return transact(STORES, 'readwrite', async tx => {
      const existing = {};
      const merged = {};
      for (const store of STORES) {
        existing[store] = await tx.getAll(store);
        const byId = new Map(existing[store].map(record => [record.id, record]));
        for (const record of imported[store]) {
          const previous = byId.get(record.id);
          if (store === 'versions' && previous && (previous.gameId !== record.gameId || previous.contentHash !== record.contentHash)) throw new Error('The backup contains a version ID that conflicts with an installed version.');
          if (store === 'saves' && previous && canonical(previous) !== canonical(record)) throw new Error('The backup contains a save ID that conflicts with an existing save. Export both libraries separately before restoring.');
          if (!previous) byId.set(record.id, record);
        }
        merged[store] = [...byId.values()];
      }
      validateRelationships(merged);
      for (const store of STORES) {
        const known = new Set(existing[store].map(record => record.id));
        for (const record of imported[store]) if (!known.has(record.id)) await tx.put(store, record);
      }
      if (markMigrated) await tx.markMigrated();
      return { games: imported.games.length, versions: imported.versions.length, saves: imported.saves.length };
    });
  }
  const api = {
    storageKind,
    get: (store, key) => transact([store], 'readonly', tx => tx.get(store, key)),
    getAll: (store, index, key) => transact([store], 'readonly', tx => tx.getAll(store, index, key)),
    put(store, record) {
      validateRecord(store, record);
      return transact([store], 'readwrite', async tx => { await tx.put(store, record); return record; });
    },
    delete: (store, key) => transact([store], 'readwrite', tx => tx.delete(store, key)),
    importVersion(game, version) {
      validateRecord('games', game); validateRecord('versions', version);
      if (version.gameId !== game.id) throw new Error('The version belongs to a different game.');
      if (game.activeVersionId && game.activeVersionId !== version.id) throw new Error('The imported version must be the active version.');
      return transact(['games', 'versions'], 'readwrite', async tx => {
        const existing = await tx.get('versions', version.id);
        if (existing && (existing.gameId !== game.id || existing.contentHash !== version.contentHash)) throw new Error('This version ID is already used by another version.');
        await tx.put('games', { ...game, activeVersionId: version.id });
        await tx.put('versions', version);
        return { game, version };
      });
    },
    putSave: save => api.putSaves([save]).then(() => save),
    putSaves(records) {
      if (!Array.isArray(records)) throw new Error('The save batch must be an array.');
      const ids = new Set();
      for (const record of records) {
        validateSaveRecord(record);
        if (ids.has(record.id)) throw new Error('The save batch contains duplicate IDs.');
        ids.add(record.id);
      }
      if (!records.length) return Promise.resolve([]);
      return transact(['versions', 'saves'], 'readwrite', async tx => {
        const installed = new Map();
        for (const gameId of new Set(records.map(record => record.gameId))) {
          // Read keys only: save ownership checks must not load the game assets.
          installed.set(gameId, await tx.getAllKeys('versions', 'gameId', gameId));
        }
        for (const record of records) {
          if (!installed.get(record.gameId).includes(record.versionId)) throw new Error('The save batch contains a save that does not belong to an installed game version.');
          const previous = await tx.get('saves', record.id);
          if (previous && canonical(previous) !== canonical(record)) throw new Error('This save ID already exists. Save edits and migrations as a new copy.');
        }
        const expired = new Set();
        for (const versionId of new Set(records.filter(record => record.kind === 'auto').map(record => record.versionId))) {
          const existing = await tx.getAll('saves', 'versionId', versionId);
          const byId = new Map(existing.filter(record => record.kind === 'auto').map(record => [record.id, record]));
          for (const record of records) if (record.kind === 'auto' && record.versionId === versionId) byId.set(record.id, record);
          const automatic = [...byId.values()].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.id.localeCompare(left.id));
          for (const record of automatic.slice(MAX_AUTOSAVES_PER_VERSION)) expired.add(record.id);
        }
        for (const id of expired) await tx.delete('saves', id);
        for (const record of records) if (!expired.has(record.id)) await tx.put('saves', record);
        return records;
      });
    },
    exportRecords() {
      return transact(STORES, 'readonly', async tx => {
        const records = {};
        for (const store of STORES) records[store] = await tx.getAll(store);
        return records;
      });
    },
    exportBackup: () => api.exportRecords().then(encodeBackup),
    restoreBackup: input => mergeRecords(decodeBackup(input)),
    migrateRecords(records) {
      // Only the existing on-device library takes this path. Avoid encoding the
      // whole library as a backup and imposing a backup-file size limit on it.
      for (const store of STORES) {
        if (!Array.isArray(records[store])) throw new Error('The existing library is incomplete.');
        for (const record of records[store]) validateRecord(store, record);
      }
      validateRelationships(records);
      return mergeRecords(records, true);
    },
    deleteGame(gameId) {
      return transact(['games', 'versions', 'saves'], 'readwrite', async tx => {
        await tx.delete('games', gameId);
        for (const store of ['versions', 'saves']) {
          for (const key of await tx.getAllKeys(store, 'gameId', gameId)) await tx.delete(store, key);
        }
      });
    },
  };
  return api;
}

export async function openVault(options = {}) {
  const native = options.native === false ? null : options.nativeStorage ?? globalThis.window?.VaultNative?.storage;
  if (native) {
    const { openNativeVault } = await import('./native-storage.js');
    return openNativeVault(native, () => openVault({ ...options, native: false }));
  }
  if (options.native !== false && globalThis.location?.protocol === 'capacitor:') throw new Error('Native library storage is unavailable. Reopen or update PathOS before saving.');
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('This browser doesn’t support IndexedDB. Open PathOS in a supported browser, outside private browsing.');
  const db = await new Promise((resolve, reject) => {
    const request = factory.open(options.name ?? DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of STORES) {
        const store = database.objectStoreNames.contains(name) ? request.transaction.objectStore(name) : database.createObjectStore(name, { keyPath: 'id' });
        if (name === 'versions' || name === 'saves') {
          if (!store.indexNames.contains('gameId')) store.createIndex('gameId', 'gameId', { unique: false });
        }
        if (name === 'saves' && !store.indexNames.contains('versionId')) store.createIndex('versionId', 'versionId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => reject(new Error('PathOS is open in another tab. Close the other tabs and try again.'));
  });
  db.onversionchange = () => db.close();
  const requestResult = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const api = createVault((stores, mode, action) => new Promise((resolve, reject) => {
    let result, failure, transaction;
    try {
      transaction = db.transaction(stores, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(storageError(failure ?? transaction.error));
      transaction.onerror = () => { /* onabort provides the final atomic outcome */ };
      const source = (store, index) => index ? transaction.objectStore(store).index(index) : transaction.objectStore(store);
      const tx = {
        get: (store, key) => requestResult(source(store).get(key)),
        getAll: (store, index, key) => requestResult(key === undefined ? source(store, index).getAll() : source(store, index).getAll(key)),
        getAllKeys: (store, index, key) => requestResult(key === undefined ? source(store, index).getAllKeys() : source(store, index).getAllKeys(key)),
        put: (store, record) => requestResult(source(store).put(record)),
        delete: (store, key) => requestResult(source(store).delete(key)),
      };
      Promise.resolve().then(() => action(tx)).then(value => { result = value; }, error => {
        failure = error;
        try { transaction.abort(); } catch { reject(storageError(error)); }
      });
    } catch (error) { reject(storageError(error)); }
  }));
  api.close = () => db.close();
  return api;
}
