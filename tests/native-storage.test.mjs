import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openVault, MAX_AUTOSAVES_PER_VERSION } from '../src/storage.js';

const game = { id: 'g', title: 'Native story', activeVersionId: 'v' };
const version = { id: 'v', gameId: 'g', label: 'Original', contentHash: 'hash', createdAt: '2026-10-16T00:00:00Z', entryPath: 'index.html', files: [{ path: 'index.html', data: new Uint8Array([0, 255, 1, 128]), mime: 'text/html' }] };
const save = { id: 's', gameId: 'g', versionId: 'v', name: 'Keep me', kind: 'manual', createdAt: version.createdAt, snapshot: { state: { stats: { sceneName: 'startup', gold: 5 }, temps: {}, lineNum: 0, indent: 0 }, scene: { name: 'startup' } } };
const stores = () => Object.fromEntries(['games', 'versions', 'saves', 'profiles'].map(name => [name, new Map()]));
const reorder = value => JSON.parse(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

// The WK boundary is mocked here; the actual SQLite/filesystem implementation
// has a separate Swift integration runner in ios-native/scripts/storage-tests.swift.
function nativeBoundary() {
  let committed = stores(), migrated = false, transaction = null, nextToken = 0;
  const calls = [];
  const boundary = {
    fail: null,
    calls,
    async bridge(payload) {
      const request = structuredClone(payload); calls.push(request);
      if (boundary.fail?.(request)) throw new Error('Simulated native disk failure');
      const { operation, store, key } = request;
      if (operation === 'open') { transaction = null; return { migrated }; }
      if (operation === 'info') return { usage: 123, available: 456 };
      if (operation === 'begin') {
        assert.equal(transaction, null, 'native transactions must not overlap');
        transaction = { token: String(++nextToken), records: structuredClone(committed), migrated };
        return { token: transaction.token };
      }
      assert.equal(request.token, transaction.token);
      if (operation === 'rollback') { transaction = null; return null; }
      if (operation === 'commit') { committed = transaction.records; migrated = transaction.migrated; transaction = null; return null; }
      if (operation === 'markMigrated') { transaction.migrated = true; return null; }
      const records = transaction.records[store];
      if (operation === 'get') return records.has(key) ? reorder(records.get(key)) : null;
      if (operation === 'put') { records.set(request.record.id, reorder(request.record)); return null; }
      if (operation === 'delete') { records.delete(key); return null; }
      let found = [...records.values()];
      if (request.index && key !== undefined) found = found.filter(record => record[request.index] === key);
      return operation === 'getAllKeys' ? found.map(record => record.id) : found.map(reorder);
    },
  };
  return boundary;
}

async function legacyLibrary() {
  const options = { indexedDB: new IDBFactory(), name: crypto.randomUUID() };
  const legacy = await openVault(options);
  await legacy.importVersion(game, version); await legacy.putSave(save);
  await legacy.put('profiles', { id: 'p', name: 'Reader' });
  return { options, legacy };
}

test('native migration copies exact assets and saves, retains the source and never resurrects deleted data', async () => {
  const { options, legacy } = await legacyLibrary();
  const boundary = nativeBoundary();
  let vault = await openVault({ ...options, nativeStorage: boundary.bridge });
  assert.equal(vault.storageKind, 'native');
  assert.deepEqual(await vault.get('saves', 's'), save);
  assert.deepEqual((await vault.get('versions', 'v')).files, version.files);
  assert.deepEqual(await legacy.get('saves', 's'), save);
  assert.equal((await vault.getAll('profiles'))[0].name, 'Reader');
  const backup = await vault.exportBackup();
  await vault.deleteGame('g'); vault.close();
  // A completed migration must never open the old IndexedDB library again.
  vault = await openVault({ nativeStorage: boundary.bridge, indexedDB: { open() { throw new Error('Do not reopen the source'); } } });
  assert.equal((await vault.getAll('games')).length, 0);
  await vault.restoreBackup(backup); await vault.restoreBackup(backup);
  assert.deepEqual(await vault.get('saves', 's'), save, 'reordered native JSON must allow an idempotent restore');
  const browser = await openVault({ indexedDB: new IDBFactory() });
  await browser.restoreBackup(JSON.stringify(await vault.exportBackup()));
  assert.deepEqual((await browser.get('versions', 'v')).files, version.files);
  assert.deepEqual(await browser.get('saves', 's'), save);
  vault.close(); browser.close(); legacy.close();
});

for (const failure of ['put', 'commit']) {
  test(`failed native migration at ${failure} rolls back records and the completion marker and can be retried`, async () => {
    const { options, legacy } = await legacyLibrary();
    const boundary = nativeBoundary();
    boundary.fail = request => request.operation === failure;
    await assert.rejects(openVault({ ...options, nativeStorage: boundary.bridge }), /browser copy is unchanged/);
    boundary.fail = null;
    assert.equal((await boundary.bridge({ operation: 'open' })).migrated, false);
    assert.deepEqual(await legacy.get('saves', 's'), save);
    const vault = await openVault({ ...options, nativeStorage: boundary.bridge });
    assert.deepEqual(await vault.get('saves', 's'), save);
    vault.close(); legacy.close();
  });
}

test('native saves serialize, retain named snapshots and reject a whole conflicting batch', async () => {
  const { options, legacy } = await legacyLibrary();
  const boundary = nativeBoundary();
  const vault = await openVault({ ...options, nativeStorage: boundary.bridge });
  boundary.calls.length = 0;
  await vault.putSave(save); // Same record, despite native object-key reordering.
  await Promise.all(Array.from({ length: MAX_AUTOSAVES_PER_VERSION + 5 }, (_, index) => vault.putSave({ ...save, id: `auto-${index}`, kind: 'auto', createdAt: new Date(Date.UTC(2026, 9, 16, 0, index)).toISOString() })));
  assert.ok(!boundary.calls.some(call => call.store === 'versions' && call.operation === 'getAll'), 'autosaves must not load game assets');
  const saved = await vault.getAll('saves');
  assert.equal(saved.filter(record => record.kind === 'auto').length, MAX_AUTOSAVES_PER_VERSION);
  assert.deepEqual(saved.find(record => record.id === 's'), save);
  await assert.rejects(vault.putSaves([{ ...save, id: 'extra' }, { ...save, name: 'Overwrite' }]), /new copy/);
  assert.equal(await vault.get('saves', 'extra'), undefined);
  boundary.fail = request => request.operation === 'commit';
  await assert.rejects(vault.putSave({ ...save, id: 'failed' }), /disk failure/);
  boundary.fail = null;
  await vault.putSave({ ...save, id: 'recovered' });
  assert.equal(await vault.get('saves', 'failed'), undefined);
  assert.equal((await vault.get('saves', 'recovered')).name, save.name);
  vault.close(); legacy.close();
});

test('native startup failure never falls back to browser storage', async () => {
  const { options, legacy } = await legacyLibrary();
  await assert.rejects(openVault({ ...options, nativeStorage: async () => { throw new Error('Disk unavailable'); } }), /Disk unavailable/);
  assert.deepEqual(await legacy.get('saves', 's'), save);
  legacy.close();
});
