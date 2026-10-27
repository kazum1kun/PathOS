import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openVault, decodeBackup, MAX_AUTOSAVES_PER_VERSION } from '../src/storage.js';
import { compactSaveRecord } from '../src/compatibility.js';

const require = createRequire(import.meta.url);
const { IDBFactory } = require(require.resolve('fake-indexeddb', { paths: [process.env.PATHOS_TEST_DEPS ?? process.cwd()] }));
function fixture() {
  const game = { id: 'game', title: 'Smoke', identity: 'smoke', activeVersionId: 'v1' };
  const version = { id: 'v1', gameId: 'game', contentHash: 'one', entryPath: 'index.html', label: 'Version 1', createdAt: '2026-10-16T00:00:00Z', files: [{ path: 'index.html', mime: 'text/html', data: new TextEncoder().encode('<title>Smoke</title>') }] };
  const save = { id: 'save', gameId: 'game', versionId: 'v1', name: 'Chapter 1', kind: 'manual', createdAt: '2026-10-16T00:00:00Z', snapshot: { state: { stats: { sceneName: 'chapter1', strength: 5 }, temps: {}, lineNum: 20, indent: 2 }, scene: { name: 'chapter1' } } };
  return { game, version, save };
}

async function writeUncompacted(indexedDB, name, records) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(['saves'], 'readwrite');
    transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    for (const record of records) transaction.objectStore('saves').put(record);
  });
  database.close();
}

test('existing saves compact in place without losing progress or creating restore conflicts', async () => {
  const indexedDB = new IDBFactory(), name = 'compact-library';
  const vault = await openVault({ indexedDB, name });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version);
  save.snapshot.scene = { ...save.snapshot.scene, lines: Array(30).fill('Bundled story'), labels: { start: 0 } };
  save.storage = { 'persist:smoke:state': 'duplicate'.repeat(10000), 'persist:smoke:statebackup': 'recovery', 'persist:smoke:slot1': 'keep me' };
  await writeUncompacted(indexedDB, name, [save]);
  assert.ok(await vault.compactSaves() > 0);
  const compact = compactSaveRecord(save);
  assert.deepEqual(await vault.get('saves', save.id), compact);
  assert.equal(await vault.compactSaves(), 0, 'compaction is idempotent');
  await vault.restoreRecords({ games: [game], versions: [version], saves: [save], profiles: [] });
  assert.deepEqual(await vault.getAll('saves'), [compact]);
  const backup = await vault.exportBackup();
  await vault.deleteGame(game.id); await vault.restoreBackup(backup);
  assert.deepEqual(await vault.get('saves', save.id), compact);
  vault.close();
});

test('a failed compaction leaves every original save untouched', async () => {
  const indexedDB = new IDBFactory(), name = 'atomic-compaction';
  const vault = await openVault({ indexedDB, name });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version);
  save.storage = { 'persist:smoke:state': 'duplicate engine cache' };
  const invalid = { ...structuredClone(save), id: 'z-invalid' }; delete invalid.snapshot.state;
  await writeUncompacted(indexedDB, name, [save, invalid]);
  await assert.rejects(vault.compactSaves(), /state/);
  assert.deepEqual(await vault.get('saves', save.id), save);
  assert.deepEqual(await vault.get('saves', invalid.id), invalid);
  vault.close();
});

test('IndexedDB persists saves and binary assets across connections', async () => {
  const indexedDB = new IDBFactory();
  let vault = await openVault({ indexedDB });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save); vault.close();
  vault = await openVault({ indexedDB });
  assert.deepEqual(await vault.get('saves', 'save'), save);
  assert.deepEqual((await vault.get('versions', 'v1')).files, version.files);
  assert.equal((await vault.getAll('saves', 'gameId', 'game')).length, 1);
  vault.close();
});

test('a conflicting version import rolls back the whole game update', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version } = fixture(); await vault.importVersion(game, version);
  await assert.rejects(vault.importVersion({ ...game, title: 'Must not persist' }, { ...version, contentHash: 'collision' }), /already used/);
  assert.equal((await vault.get('games', 'game')).title, 'Smoke');
  assert.equal((await vault.get('versions', 'v1')).contentHash, 'one');
  vault.close();
});

test('restore conflicts roll back all records while preserving existing saves', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save);
  const backup = await decodeBackup(await vault.exportBackup());
  backup.games.push({ id: 'extra', title: 'Must not persist' });
  backup.saves[0].snapshot.state.stats.strength = 99;
  await assert.rejects(vault.restoreRecords(backup), /conflicts/);
  assert.equal(await vault.get('games', 'extra'), undefined);
  assert.equal((await vault.get('saves', 'save')).snapshot.state.stats.strength, 5);
  vault.close();
});

test('save identities are immutable and ownership is checked', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save);
  await assert.rejects(vault.putSave({ ...save, name: 'Overwrite' }), /new copy/);
  await assert.rejects(vault.putSave({ ...save, id: 'other', gameId: 'unrelated' }), /installed game version/);
  assert.equal((await vault.getAll('saves')).length, 1);
  vault.close();
});

test('batch deletion is scoped to a game and retains all records on an invalid selection', async () => {
  const vault=await openVault({indexedDB:new IDBFactory()});
  const {game,version,save}=fixture();
  try {
    await vault.importVersion(game,version);
    await vault.putSaves([save,{...save,id:'automatic',kind:'auto'}]);
    await vault.importVersion({...game,id:'other',activeVersionId:'other-version'},{...version,id:'other-version',gameId:'other'});
    await vault.putSave({...save,id:'other-save',gameId:'other',versionId:'other-version'});
    await assert.rejects(vault.deleteSaves(game.id,[save.id,'other-save']),/different game/);
    assert.equal((await vault.getAll('saves')).length,3);
    assert.equal(await vault.deleteSaves(game.id,[save.id,save.id,'missing']),1);
    assert.deepEqual((await vault.getAll('saves')).map(record=>record.id).sort(),['automatic','other-save']);
    assert.equal((await vault.getAll('versions')).length,2);
    assert.equal(await vault.deleteSaves(game.id,[]),0);
  } finally {vault.close();}
});

test('batch save imports commit together and roll back on one unrelated version', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture(); await vault.importVersion(game, version);
  await assert.rejects(vault.putSaves([{ ...save, id: 'valid' }, { ...save, id: 'invalid', gameId: 'unrelated' }]), /installed game version/);
  assert.equal((await vault.getAll('saves')).length, 0);
  const records = [{ ...save, id: 'first' }, { ...save, id: 'second' }];
  await vault.putSaves(records);
  assert.equal((await vault.getAll('saves')).length, 2);
  await assert.rejects(vault.putSaves([{ ...save, id: 'third' }, { ...save, id: 'first', name: 'Overwrite' }]), /new copy/);
  assert.equal(await vault.get('saves', 'third'), undefined);
  assert.equal((await vault.get('saves', 'first')).name, save.name);
  vault.close();
});

test('only automatic snapshots are trimmed, independently for each installed version', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save);
  await vault.importVersion({ ...game, activeVersionId: 'v2' }, { ...version, id: 'v2', contentHash: 'two' });
  await vault.putSave({ ...save, id: 'v2-auto', versionId: 'v2', kind: 'auto', createdAt: '2026-10-01T00:00:00Z' });
  for (let count = 0; count < MAX_AUTOSAVES_PER_VERSION + 7; count++) {
    await vault.putSave({ ...save, id: `auto-${count}`, kind: 'auto', createdAt: new Date(Date.UTC(2026, 9, 16, 0, count)).toISOString() });
  }
  const saves = await vault.getAll('saves');
  assert.equal(saves.filter(record => record.versionId === 'v1' && record.kind === 'auto').length, MAX_AUTOSAVES_PER_VERSION);
  assert.equal(saves.find(record => record.id === 'save').kind, 'manual');
  assert.equal(saves.find(record => record.id === 'v2-auto').versionId, 'v2');
  assert.equal(saves.find(record => record.id === 'auto-0'), undefined);
  assert.ok(saves.find(record => record.id === `auto-${MAX_AUTOSAVES_PER_VERSION + 6}`));
  vault.close();
});

test('delete cascades through version/save indexes and a compressed backup restores exact data', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save);
  const backup = await vault.exportBackup();
  await vault.deleteGame('game');
  assert.equal((await vault.getAll('games')).length, 0);
  assert.equal((await vault.getAll('versions')).length, 0);
  assert.equal((await vault.getAll('saves')).length, 0);
  await vault.restoreBackup(backup);
  assert.deepEqual(await vault.get('saves', 'save'), save);
  assert.deepEqual((await vault.get('versions', 'v1')).files, version.files);
  // A repeated restore is an idempotent merge.
  await vault.restoreBackup(backup);
  assert.equal((await vault.getAll('saves')).length, 1);
  vault.close();
});

test('removing versions keeps saves and source fingerprints until the last installed version is removed', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  version.sceneIndex = { chapter1: { hash: 'chapter-hash', crc: 123, lines: Array(30).fill('Source text'), labels: { start: 0 } } };
  await vault.importVersion(game, version); await vault.putSave(save);
  const newer = { ...version, id: 'v2', contentHash: 'two', createdAt: '2026-10-17T00:00:00Z' };
  await vault.importVersion({ ...game, activeVersionId: 'v2' }, newer);
  await vault.putSave({ ...save, id: 'second-save', versionId: 'v2' });
  const other = { ...game, id: 'other', activeVersionId: 'other-version' };
  await vault.importVersion(other, { ...version, id: 'other-version', gameId: other.id });
  await vault.putSave({ ...save, id: 'other-save', gameId: other.id, versionId: 'other-version' });
  assert.deepEqual(await vault.deleteVersion(game.id, version.id), { gameRemoved: false, deletedSaves: 0 });
  const removed = await vault.get('versions', version.id);
  assert.equal(removed.removed, true); assert.deepEqual(removed.files, []);
  assert.equal(removed.sceneIndex.chapter1.hash, 'chapter-hash');
  assert.equal(removed.sceneIndex.chapter1.lines, undefined);
  assert.deepEqual(await vault.get('saves', save.id), save);
  assert.equal((await vault.get('games', game.id)).activeVersionId, 'v2');
  const backup = await vault.exportBackup();
  await vault.deleteGame(game.id); await vault.restoreBackup(backup);
  assert.deepEqual(await vault.get('versions', version.id), removed, 'retained save metadata must survive a backup');
  const result = await vault.deleteVersion(game.id, 'v2', { allowGameRemoval: true });
  assert.deepEqual(result, { gameRemoved: true, deletedSaves: 2 });
  assert.equal(await vault.get('games', game.id), undefined);
  assert.equal((await vault.getAll('versions', 'gameId', game.id)).length, 0);
  assert.equal((await vault.getAll('saves', 'gameId', game.id)).length, 0);
  assert.ok(await vault.get('saves', 'other-save'));
  assert.ok(await vault.get('versions', 'other-version'));
  vault.close();
});

test('removing the active version selects a remaining version and guards stale or unrelated removal', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save);
  await vault.importVersion({ ...game, activeVersionId: 'v2' }, { ...version, id: 'v2', contentHash: 'two' });
  await assert.rejects(vault.deleteVersion('unrelated', 'v2'), /no longer installed|different game/);
  await vault.deleteVersion(game.id, 'v2');
  assert.equal(await vault.get('versions', 'v2'), undefined, 'unused removed versions need no metadata record');
  assert.equal((await vault.get('games', game.id)).activeVersionId, version.id);
  await assert.rejects(vault.deleteVersion(game.id, version.id), /last version/);
  assert.deepEqual(await vault.get('saves', save.id), save);
  const originalBackup = await vault.exportBackup();
  await vault.importVersion({ ...game, activeVersionId: 'v2' }, { ...version, id: 'v2', contentHash: 'two' });
  await vault.deleteVersion(game.id, version.id);
  await vault.restoreBackup(originalBackup);
  assert.deepEqual((await vault.get('versions', version.id)).files, version.files, 'restoring a backup reinstalls removed game files');
  assert.equal((await vault.get('versions', version.id)).removed, undefined);
  assert.deepEqual(await vault.get('saves', save.id), save);
  vault.close();
});
