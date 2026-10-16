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

export async function openVault(options = {}) {
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

  function transact(stores, mode, action) {
    return new Promise((resolve, reject) => {
      let result;
      let failure;
      let transaction;
      try {
        transaction = db.transaction(stores, mode);
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(storageError(failure ?? transaction.error));
        transaction.onerror = () => { /* onabort provides the final atomic outcome */ };
        const setResult = value => { result = value; };
        const abort = error => { failure = error; transaction.abort(); };
        action(transaction, setResult, abort);
      } catch (error) {
        failure = error;
        try { transaction?.abort(); } catch { /* already finished */ }
        reject(storageError(error));
      }
    });
  }

  function allRecords(transaction, callback, abort) {
    const records = {};
    let pending = STORES.length;
    for (const name of STORES) {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => {
        records[name] = request.result;
        if (--pending === 0) { try { callback(records); } catch (error) { abort(error); } }
      };
    }
  }

  const api = {
    get(store, key) {
      return transact([store], 'readonly', (transaction, done) => {
        const request = transaction.objectStore(store).get(key);
        request.onsuccess = () => done(request.result);
      });
    },
    getAll(store, index, key) {
      return transact([store], 'readonly', (transaction, done) => {
        const source = index ? transaction.objectStore(store).index(index) : transaction.objectStore(store);
        const request = key === undefined ? source.getAll() : source.getAll(key);
        request.onsuccess = () => done(request.result);
      });
    },
    put(store, record) {
      validateRecord(store, record);
      return transact([store], 'readwrite', (transaction, done) => { transaction.objectStore(store).put(record); done(record); });
    },
    delete(store, key) {
      return transact([store], 'readwrite', transaction => transaction.objectStore(store).delete(key));
    },
    importVersion(game, version) {
      validateRecord('games', game); validateRecord('versions', version);
      if (version.gameId !== game.id) throw new Error('The version belongs to a different game.');
      if (game.activeVersionId && game.activeVersionId !== version.id) throw new Error('The imported version must be the active version.');
      return transact(['games', 'versions'], 'readwrite', (transaction, done, abort) => {
        const versions = transaction.objectStore('versions');
        const existing = versions.get(version.id);
        existing.onsuccess = () => {
          if (existing.result && (existing.result.gameId !== game.id || existing.result.contentHash !== version.contentHash)) {
            abort(new Error('This version ID is already used by another version.')); return;
          }
          transaction.objectStore('games').put({ ...game, activeVersionId: version.id });
          versions.put(version); done({ game, version });
        };
      });
    },
    putSave(save) {
      validateSaveRecord(save);
      return transact(['versions', 'saves'], 'readwrite', (transaction, done, abort) => {
        const request = transaction.objectStore('versions').index('gameId').getAllKeys(save.gameId);
        request.onsuccess = () => {
          if (!request.result.includes(save.versionId)) { abort(new Error('The save does not belong to an installed game version.')); return; }
          const saves = transaction.objectStore('saves');
          const previous = saves.get(save.id);
          previous.onsuccess = () => {
            if (previous.result && JSON.stringify(previous.result) !== JSON.stringify(save)) {
              abort(new Error('This save ID already exists. Save edits and migrations as a new copy.')); return;
            }
            if (save.kind !== 'auto') { saves.put(save); done(save); return; }
            const retained = saves.index('versionId').getAll(save.versionId);
            retained.onsuccess = () => {
              const automatic = retained.result.filter(record => record.kind === 'auto' && record.id !== save.id);
              automatic.push(save);
              automatic.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.id.localeCompare(left.id));
              for (const expired of automatic.slice(MAX_AUTOSAVES_PER_VERSION)) saves.delete(expired.id);
              if (automatic.slice(0, MAX_AUTOSAVES_PER_VERSION).some(record => record.id === save.id)) saves.put(save);
              done(save);
            };
          };
        };
      });
    },
    putSaves(records) {
      if (!Array.isArray(records)) throw new Error('The save batch must be an array.');
      const ids = new Set();
      for (const record of records) {
        validateSaveRecord(record);
        if (ids.has(record.id)) throw new Error('The save batch contains duplicate IDs.');
        ids.add(record.id);
      }
      if (!records.length) return Promise.resolve([]);
      return transact(['versions', 'saves'], 'readwrite', (transaction, done, abort) => {
        const saves = transaction.objectStore('saves');
        const games = [...new Set(records.map(record => record.gameId))];
        const installed = new Map();
        const existing = new Map();
        let pending = games.length + records.length;
        const checked = () => {
          if (--pending) return;
          for (const record of records) {
            if (!installed.get(record.gameId)?.has(record.versionId)) { abort(new Error('The save batch contains a save that does not belong to an installed game version.')); return; }
            const previous = existing.get(record.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(record)) { abort(new Error('This save ID already exists. Save edits and migrations as a new copy.')); return; }
          }
          const autoVersions = [...new Set(records.filter(record => record.kind === 'auto').map(record => record.versionId))];
          const expired = new Set();
          const commit = () => {
            for (const id of expired) saves.delete(id);
            for (const record of records) if (!expired.has(record.id)) saves.put(record);
            done(records);
          };
          if (!autoVersions.length) { commit(); return; }
          let remaining = autoVersions.length;
          for (const versionId of autoVersions) {
            const request = saves.index('versionId').getAll(versionId);
            request.onsuccess = () => {
              const byId = new Map(request.result.filter(record => record.kind === 'auto').map(record => [record.id, record]));
              for (const record of records) if (record.kind === 'auto' && record.versionId === versionId) byId.set(record.id, record);
              const automatic = [...byId.values()].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.id.localeCompare(left.id));
              for (const record of automatic.slice(MAX_AUTOSAVES_PER_VERSION)) expired.add(record.id);
              if (--remaining === 0) commit();
            };
          }
        };
        for (const gameId of games) {
          // Read keys only: checking ownership must not clone entire APK assets.
          const request = transaction.objectStore('versions').index('gameId').getAllKeys(gameId);
          request.onsuccess = () => { installed.set(gameId, new Set(request.result)); checked(); };
        }
        for (const record of records) {
          const request = saves.get(record.id);
          request.onsuccess = () => { existing.set(record.id, request.result); checked(); };
        }
      });
    },
    exportBackup() {
      return transact(STORES, 'readonly', (transaction, done, abort) => allRecords(transaction, records => done(encodeBackup(records)), abort));
    },
    restoreBackup(input) {
      const imported = decodeBackup(input);
      return transact(STORES, 'readwrite', (transaction, done, abort) => {
        allRecords(transaction, existing => {
          const merged = {};
          for (const store of STORES) {
            const byId = new Map(existing[store].map(record => [record.id, record]));
            for (const record of imported[store]) {
              const previous = byId.get(record.id);
              if (store === 'versions' && previous && (previous.gameId !== record.gameId || previous.contentHash !== record.contentHash)) throw new Error('The backup contains a version ID that conflicts with an installed version.');
              if (store === 'saves' && previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('The backup contains a save ID that conflicts with an existing save. Export both libraries separately before restoring.');
              // Existing preferences/active-version selection win on repeated imports.
              if (!previous) byId.set(record.id, record);
            }
            merged[store] = [...byId.values()];
          }
          validateRelationships(merged);
          for (const store of STORES) {
            const known = new Set(existing[store].map(record => record.id));
            for (const record of imported[store]) if (!known.has(record.id)) transaction.objectStore(store).put(record);
          }
          done({ games: imported.games.length, versions: imported.versions.length, saves: imported.saves.length });
        }, abort);
      });
    },
    deleteGame(gameId) {
      return transact(['games', 'versions', 'saves'], 'readwrite', transaction => {
        transaction.objectStore('games').delete(gameId);
        for (const name of ['versions', 'saves']) {
          const store = transaction.objectStore(name);
          const request = store.index('gameId').getAllKeys(gameId);
          request.onsuccess = () => { for (const key of request.result) store.delete(key); };
        }
      });
    },
    close() { db.close(); },
  };
  return api;
}
