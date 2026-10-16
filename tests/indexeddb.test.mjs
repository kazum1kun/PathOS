import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openVault, MAX_AUTOSAVES_PER_VERSION } from '../src/storage.js';

const require = createRequire(import.meta.url);
const { IDBFactory } = require(require.resolve('fake-indexeddb', { paths: [process.env.PATHOS_TEST_DEPS ?? process.cwd()] }));
function fixture() {
  const game = { id: 'game', title: 'Smoke', identity: 'smoke', activeVersionId: 'v1' };
  const version = { id: 'v1', gameId: 'game', contentHash: 'one', entryPath: 'index.html', label: 'Version 1', createdAt: '2026-10-16T00:00:00Z', files: [{ path: 'index.html', mime: 'text/html', data: new TextEncoder().encode('<title>Smoke</title>') }] };
  const save = { id: 'save', gameId: 'game', versionId: 'v1', name: 'Chapter 1', kind: 'manual', createdAt: '2026-10-16T00:00:00Z', snapshot: { state: { stats: { sceneName: 'chapter1', strength: 5 }, temps: {}, lineNum: 20, indent: 2 }, scene: { name: 'chapter1' } } };
  return { game, version, save };
}

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
  const backup = await vault.exportBackup();
  backup.games.push({ id: 'extra', title: 'Must not persist' });
  backup.saves[0].snapshot.state.stats.strength = 99;
  await assert.rejects(vault.restoreBackup(backup), /conflicts/);
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

test('delete cascades through version/save indexes and a JSON backup restores exact data', async () => {
  const vault = await openVault({ indexedDB: new IDBFactory() });
  const { game, version, save } = fixture();
  await vault.importVersion(game, version); await vault.putSave(save);
  const backup = JSON.stringify(await vault.exportBackup());
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
