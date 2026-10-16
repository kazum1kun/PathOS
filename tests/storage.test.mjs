import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBackup, decodeBackup, validateRecord, storageError } from '../src/storage.js';

const library = () => ({
  games: [{ id: 'game', title: 'Dino Knights', identity: 'dinoknights', activeVersionId: 'version' }],
  versions: [{ id: 'version', gameId: 'game', contentHash: 'hash', entryPath: 'index.html', label: '1.0', createdAt: '2026-10-16T00:00:00Z', files: [{ path: 'index.html', data: Uint8Array.of(0, 1, 127, 128, 255), mime: 'text/html' }] }],
  saves: [{ id: 'save', gameId: 'game', versionId: 'version', createdAt: '2026-10-16T00:00:00Z', snapshot: { state: { stats: { sceneName: 'startup', strength: 50 }, temps: {}, lineNum: 2, indent: 0 }, scene: { name: 'startup' } } }],
  profiles: [],
});

test('backup survives a JSON round-trip with exact binary assets and save state', () => {
  const records = library();
  const backup = JSON.stringify(encodeBackup(records));
  const restored = decodeBackup(backup);
  assert.deepEqual(restored, records);
  assert.ok(restored.versions[0].files[0].data instanceof Uint8Array);
});

test('restoring a save into an unrelated game version is rejected', () => {
  const backup = encodeBackup(library()); backup.saves[0].gameId = 'other-game';
  assert.throws(() => decodeBackup(backup), /unrelated/);
});

test('missing active versions, duplicate IDs, corrupt bytes and unsafe paths are rejected', () => {
  const missing = encodeBackup(library()); missing.games[0].activeVersionId = 'missing';
  assert.throws(() => decodeBackup(missing), /active version/);
  const duplicate = encodeBackup(library()); duplicate.saves.push(duplicate.saves[0]);
  assert.throws(() => decodeBackup(duplicate), /duplicate/);
  const corrupt = encodeBackup(library()); corrupt.versions[0].files[0].data = '%%%';
  assert.throws(() => decodeBackup(corrupt), /base64/);
  const unsafe = library().versions[0]; unsafe.files[0].path = '../index.html';
  assert.throws(() => validateRecord('versions', unsafe), /unsafe file path/);
});

test('future backup schemas are not silently consumed', () => {
  const backup = encodeBackup(library()); backup.version = 2;
  assert.throws(() => decodeBackup(backup), /supported/);
});

test('quota failures explain a concrete recovery action', () => {
  const error = new Error('full'); error.name = 'QuotaExceededError';
  assert.match(storageError(error).message, /Export a backup/);
});
