import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBackup, decodeBackup, validateRecord, storageError, bytesToBase64 } from '../src/storage.js';
import { compactSaveRecord, validateSaveRecord } from '../src/compatibility.js';
import { writeArchive, readArchive, encodeSave, readSaveFile } from '../src/transfer.js';

const library = () => ({
  games: [{ id: 'game', title: 'Dino Knights', identity: 'dinoknights', activeVersionId: 'version' }],
  versions: [{ id: 'version', gameId: 'game', contentHash: 'hash', entryPath: 'index.html', label: '1.0', createdAt: '2026-10-16T00:00:00Z', files: [{ path: 'index.html', data: Uint8Array.of(0, 1, 127, 128, 255), mime: 'text/html' }] }],
  saves: [{ id: 'save', gameId: 'game', versionId: 'version', createdAt: '2026-10-16T00:00:00Z', snapshot: { state: { stats: { sceneName: 'startup', strength: 50 }, temps: {}, lineNum: 2, indent: 0 }, scene: { name: 'startup' } } }],
  profiles: [],
});

async function alteredBackup(change) {
  const { manifest, entries, read } = await readArchive(await encodeBackup(library()));
  const files = new Map();
  for (const path of entries.keys()) if (path !== 'manifest.json') files.set(path, await read(path));
  change(manifest, files);
  return writeArchive(manifest, files);
}

test('compressed backup preserves exact binary assets and save state without base64', async () => {
  const records = library(), backup = await encodeBackup(records);
  const restored = await decodeBackup(backup);
  assert.deepEqual(restored, records);
  assert.ok(restored.versions[0].files[0].data instanceof Uint8Array);
  const { manifest } = await readArchive(backup);
  assert.equal(manifest.versions[0].files[0].data, undefined);
  assert.match(manifest.versions[0].files[0].asset, /^assets\/[a-f0-9]{64}$/);
});

test('backups store identical assets from different versions only once', async () => {
  const records = library();
  records.versions.push({ ...structuredClone(records.versions[0]), id: 'v2', contentHash: 'updated' });
  const backup = await encodeBackup(records), { manifest, entries } = await readArchive(backup);
  assert.equal(entries.size, 2, 'one manifest and one shared binary asset');
  assert.equal(manifest.versions[0].files[0].asset, manifest.versions[1].files[0].asset);
  assert.deepEqual(await decodeBackup(backup), records);
});

test('saves discard source and engine caches while retaining progress, chapter checkpoints, quickslots and preferences', async () => {
  const original = library().saves[0];
  original.snapshot.scene.lines = Array(5000).fill('A chapter line already present in the installed game.');
  original.snapshot.scene.labels = { start: 0 };
  original.snapshot.checkpoint = { state: { ...structuredClone(original.snapshot.state), lineNum: 0 }, scene: structuredClone(original.snapshot.scene), atSceneStart: true };
  original.storage = {
    'persist:game:state': 'engine current state'.repeat(10000),
    'persist:game:statetemp': 'engine temporary state'.repeat(10000),
    'persist:game:statebackup': 'engine recovery state'.repeat(10000),
    'persist:game:stategame_SAVE_1': 'keep this in-game save',
    'persist:game:fontSize': 'large', 'local:settings': 'keep custom preferences',
  };
  const before = structuredClone(original), compact = compactSaveRecord(original);
  validateSaveRecord(compact);
  assert.deepEqual(original, before, 'compaction must not mutate its input');
  assert.deepEqual(compact.snapshot.state, original.snapshot.state);
  assert.deepEqual(compact.snapshot.checkpoint.state, original.snapshot.checkpoint.state);
  assert.equal(compact.snapshot.scene.lineCount, 5000);
  assert.equal(compact.snapshot.checkpoint.scene.lines, undefined);
  assert.deepEqual(compact.storage, { 'persist:game:stategame_SAVE_1': 'keep this in-game save', 'persist:game:fontSize': 'large', 'local:settings': 'keep custom preferences' });
  assert.ok(JSON.stringify(compact).length < JSON.stringify(original).length / 100);
  const bytes = await encodeSave({ source: { contentHash: 'hash' }, save: original });
  const restored = await readSaveFile(new File([bytes], 'save.pathos-save.zip'));
  assert.deepEqual(restored.save, compact);
  assert.equal(restored.version, 2);
  const invalid = structuredClone(compact); invalid.snapshot.state.lineNum = 5001;
  assert.throws(() => validateSaveRecord(invalid), /outside/);
});

test('compressed library exports are substantially smaller than the former JSON representation', async () => {
  const records = library();
  records.versions[0].files[0].data = new TextEncoder().encode('*title A story\n*create strength 50\n' + 'Story text and choices in the bundled chapter.\n'.repeat(10000));
  const oldJSON = JSON.stringify({ ...records, versions: records.versions.map(version => ({ ...version, files: version.files.map(file => ({ ...file, data: bytesToBase64(file.data) })) })) }, null, 2);
  const compressed = await encodeBackup(records);
  assert.ok(compressed.byteLength < oldJSON.length / 20, 'text-heavy backup should shrink by over 95%');
  assert.deepEqual(await decodeBackup(compressed), records);
});

test('unrelated versions, duplicate IDs and unsupported formats are rejected before restore', async () => {
  await assert.rejects(decodeBackup(await alteredBackup(backup => { backup.saves[0].gameId = 'other-game'; })), /unrelated/);
  await assert.rejects(decodeBackup(await alteredBackup(backup => { backup.games[0].activeVersionId = 'missing'; })), /active version/);
  await assert.rejects(decodeBackup(await alteredBackup(backup => { backup.saves.push(backup.saves[0]); })), /duplicate/);
  await assert.rejects(decodeBackup(await alteredBackup(backup => { backup.version = 99; })), /supported/);
  const unsafe = library().versions[0]; unsafe.files[0].path = '../index.html';
  assert.throws(() => validateRecord('versions', unsafe), /unsafe file path/);
});

test('missing assets, altered content and malformed archives fail validation', async () => {
  await assert.rejects(decodeBackup(await alteredBackup((backup, files) => { files.clear(); })), /missing/);
  await assert.rejects(decodeBackup(await alteredBackup((backup, files) => { files.set(backup.versions[0].files[0].asset, Uint8Array.of(123)); })), /checksum/);
  await assert.rejects(decodeBackup(await alteredBackup(backup => { backup.versions[0].files[0].asset = '../outside'; })), /reference/);
  await assert.rejects(decodeBackup(Uint8Array.of(1, 2, 3)), /ZIP|archive/);
  const archive = await encodeBackup(library());
  await assert.rejects(readArchive(archive, { expandedBytes: 1 }), /Expanded archive/);
  await assert.rejects(decodeBackup(archive.subarray(0, archive.length - 5)), /complete/);
});

test('quota failures explain a concrete recovery action', () => {
  const error = new Error('full'); error.name = 'QuotaExceededError';
  assert.match(storageError(error).message, /Export a backup/);
});
