import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCompatibility, cloneEditedSave, migrateSave, restartFromCheckpoint, validateSaveRecord } from '../src/compatibility.js';

const version = (id, overrides = {}) => ({
  id, gameId: 'game', contentHash: id, engineHash: 'engine-v1', label: id,
  sceneIndex: { chapter1: { hash: 'same' }, prologue: { hash: 'prologue' }, chapter2: { hash: 'chapter2' } },
  initialStats: { strength: 10, name: 'Knight' }, ...overrides,
});
const save = () => ({
  id: 'save', gameId: 'game', versionId: 'v1', name: 'Before the duel', kind: 'manual',
  snapshot: { format: 'story-vault-state-v1', state: { stats: { sceneName: 'chapter1', strength: 12, name: 'Ari' }, temps: {}, lineNum: 24, indent: 2 }, scene: { name: 'chapter1', crc: 100 } },
  storage: {}, createdAt: '2026-10-16T00:00:00Z',
});

test('an exact saved version can resume without source metadata', () => {
  const assessment = assessCompatibility(save(), version('v1'));
  assert.equal(assessment.status, 'exact'); assert.equal(assessment.canResume, true);
});

test('changed current chapter never resumes at a stale line number', () => {
  const updated = version('v2', { sceneIndex: { chapter1: { hash: 'rewritten' } } });
  const assessment = assessCompatibility(save(), updated, version('v1'));
  assert.equal(assessment.canResume, false); assert.equal(assessment.status, 'blocked');
  assert.deepEqual(assessment.changedScenes, ['chapter1']);
});

test('a changed cross-scene return target blocks resume even when current chapter is unchanged', () => {
  const record = save(); record.snapshot.state.stats.choice_subscene_stack = [{ name: 'prologue', lineNum: 20 }];
  const updated = version('v2', { sceneIndex: { chapter1: { hash: 'same' }, prologue: { hash: 'changed' } } });
  assert.equal(assessCompatibility(record, updated, version('v1')).canResume, false);
});

test('a changed future chapter is reported while unchanged active code can migrate', () => {
  const updated = version('v2', { sceneIndex: { chapter1: { hash: 'same' }, chapter2: { hash: 'rewritten' } } });
  const assessment = assessCompatibility(save(), updated, version('v1'));
  assert.equal(assessment.status, 'compatible'); assert.equal(assessment.canResume, true);
  assert.match(assessment.warnings.join(' '), /Other chapters changed/);
});

test('cross-content migration drops opaque in-game quickslots without modifying the original', () => {
  const record = save();
  record.storage = { 'persist:game:state': 'old state', 'persist:game:save_list': '["quickslot"]', 'local:theme': 'dark' };
  const originalStorage = structuredClone(record.storage);
  const updated = version('v2', { sceneIndex: { chapter1: { hash: 'same' }, chapter2: { hash: 'changed' } } });
  const assessment = assessCompatibility(record, updated, version('v1'));
  assert.match(assessment.warnings.join(' '), /Built-in save slots and preferences/);
  const migrated = migrateSave(record, updated, version('v1'));
  assert.deepEqual(migrated.storage, {}); assert.deepEqual(record.storage, originalStorage);
  assert.match(migrated.migration.warnings.join(' '), /empty isolated game storage/);
});

test('byte-identical content can retain opaque storage in a new copy', () => {
  const record = save(); record.storage = { 'local:theme': 'dark', 'persist:game:quickslot': 'same version state' };
  const migrated = migrateSave(record, version('v2', { contentHash: 'v1' }), version('v1'));
  assert.deepEqual(migrated.storage, record.storage);
  assert.notEqual(migrated.storage, record.storage);
});

test('new variable defaults are applied only to a new migrated copy', () => {
  const record = save(); const original = structuredClone(record);
  const updated = version('v2', { initialStats: { strength: 10, name: 'Knight', trust: 0 } });
  const copy = migrateSave(record, updated, version('v1'));
  assert.notEqual(copy.id, record.id); assert.equal(copy.parentSaveId, record.id);
  assert.equal(copy.versionId, 'v2'); assert.equal(copy.snapshot.state.stats.trust, 0);
  assert.equal(copy.snapshot.state.stats.strength, 12); assert.deepEqual(record, original);
});

test('migration synchronises compiler CRCs after verifying identical source hashes', () => {
  const record = save(); record.snapshot.state.temps.choice_crc = 100;
  record.snapshot.state.stats.choice_subscene_stack = [{ name: 'prologue', lineNum: 10, indent: 0, temps: { choice_crc: 50 } }];
  record.snapshot.checkpoint = { state: { stats: { sceneName: 'chapter1' }, temps: { choice_crc: 100 }, lineNum: 0, indent: 0 }, scene: { name: 'chapter1', crc: 100 }, atSceneStart: true };
  const updated = version('v2', { sceneIndex: { chapter1: { hash: 'same', crc: 900 }, prologue: { hash: 'prologue', crc: 500 } } });
  const migrated = migrateSave(record, updated, version('v1'));
  assert.equal(migrated.snapshot.state.temps.choice_crc, 900);
  assert.equal(migrated.snapshot.scene.crc, 900);
  assert.equal(migrated.snapshot.checkpoint.state.temps.choice_crc, 900);
  assert.equal(migrated.snapshot.checkpoint.scene.crc, 900);
  assert.equal(migrated.snapshot.state.stats.choice_subscene_stack[0].temps.choice_crc, 500);
  assert.equal(record.snapshot.state.temps.choice_crc, 100);
});

test('new or changed dynamic initializers block migration while unchanged declarations can resume', () => {
  const target = version('v2', { unresolvedInitializers: { inventory: '*create_array inventory (starting_slots) 0' } });
  assert.equal(assessCompatibility(save(), target, version('v1')).canResume, false);
  assert.equal(assessCompatibility(save(), target, version('v1', { unresolvedInitializers: { inventory: '*create_array inventory 4 0' } })).canResume, false);
  const source = version('v1', { unresolvedInitializers: { ...target.unresolvedInitializers } });
  assert.equal(assessCompatibility(save(), target, source).canResume, true);
});

test('chapter restart requires matching unresolved initializer declarations', () => {
  const record = save(); record.snapshot.checkpoint = { state: { stats: { sceneName: 'chapter1' }, temps: {}, lineNum: 0, indent: 0 }, scene: { name: 'chapter1' }, atSceneStart: true };
  const target = version('v2', { unresolvedInitializers: { randomseed: '*create randomseed (choice_random_seed)' } });
  assert.equal(assessCompatibility(record, target, version('v1')).canRestartCheckpoint, false);
  assert.throws(() => restartFromCheckpoint(record, target), /initializers/);
  const source = version('v1', { unresolvedInitializers: { ...target.unresolvedInitializers } });
  assert.equal(assessCompatibility(record, target, source).canRestartCheckpoint, true);
  assert.doesNotThrow(() => restartFromCheckpoint(record, target, source));
});

test('migration without a target CRC lets the engine compute its own checksum', () => {
  const record = save(); record.snapshot.state.temps.choice_crc = 100;
  const migrated = migrateSave(record, version('v2'), version('v1'));
  assert.equal(Object.hasOwn(migrated.snapshot.state.temps, 'choice_crc'), false);
  assert.equal(Object.hasOwn(migrated.snapshot.scene, 'crc'), false);
});

test('engine and variable type changes are blocked', () => {
  assert.equal(assessCompatibility(save(), version('v2', { engineHash: 'engine-v2' }), version('v1')).canResume, false);
  assert.equal(assessCompatibility(save(), version('v2', { initialStats: { strength: 'strong' } }), version('v1')).canResume, false);
});

test('unrecognised cross-scene return frames and missing scenes fail closed', () => {
  const record = save(); record.snapshot.state.stats.choice_subscene_stack = [{ mysterious: 10 }];
  assert.equal(assessCompatibility(record, version('v2'), version('v1')).canResume, false);
  assert.equal(assessCompatibility(save(), version('v2', { sceneIndex: {} }), version('v1')).canResume, false);
});

test('edit produces a new save without mutating the original', () => {
  const record = save(); const original = structuredClone(record);
  const edited = cloneEditedSave(record, { stats: { strength: 50 }, temps: { visited: true } });
  assert.equal(edited.kind, 'edited'); assert.equal(edited.snapshot.state.stats.strength, 50);
  assert.equal(edited.snapshot.state.temps.visited, true); assert.deepEqual(record, original);
});

test('invalid and prototype-bearing save state is rejected', () => {
  const record = save(); record.snapshot.state.lineNum = -1;
  assert.throws(() => validateSaveRecord(record), /line number/);
  assert.throws(() => cloneEditedSave(save(), JSON.parse('{"stats":{"__proto__":{"polluted":true}}}')), /unsafe property/);
});

test('engine scene names must match verified scene metadata, including raw edits', () => {
  const record = save(); record.snapshot.state.stats.sceneName = 'chapter2';
  assert.throws(() => validateSaveRecord(record), /engine scene name/);
  assert.equal(assessCompatibility(record, version('v1')).canResume, false);
  const missing = save(); delete missing.snapshot.state.stats.sceneName;
  assert.throws(() => validateSaveRecord(missing), /engine scene name/);
  const normalised = save(); normalised.snapshot.state.stats.sceneName = 'CHAPTER1';
  assert.doesNotThrow(() => validateSaveRecord(normalised));
});

test('saved instruction pointers must stay within supplied scene source', () => {
  const record = save(); record.snapshot.scene.lines = ['*label start', 'Hello'];
  record.snapshot.state.lineNum = 3;
  assert.throws(() => validateSaveRecord(record), /outside/);
  record.snapshot.state.lineNum = 2;
  assert.doesNotThrow(() => validateSaveRecord(record));
  record.createdAt = 'yesterday';
  assert.throws(() => validateSaveRecord(record), /creation date/);
});

test('chapter restart uses target source and preserves original saved state', () => {
  const record = save();
  record.storage = { 'persist:game:quickslot': 'old code state' };
  record.snapshot.checkpoint = { state: { stats: { sceneName: 'chapter1', strength: 9, name: 'Ari' }, temps: { choice_crc: 100 }, lineNum: 0, indent: 0 }, scene: { name: 'chapter1', crc: 100, lines: ['old source'] }, atSceneStart: true };
  const original = structuredClone(record);
  const updated = version('v2', { sceneIndex: { chapter1: { hash: 'new', crc: 200, lines: ['new source'] } } });
  assert.equal(assessCompatibility(record, updated, version('v1')).canRestartCheckpoint, true);
  const restarted = restartFromCheckpoint(record, updated);
  assert.equal(restarted.snapshot.state.lineNum, 0); assert.equal(restarted.snapshot.state.stats.strength, 9);
  assert.deepEqual(restarted.snapshot.scene.lines, ['new source']); assert.equal(restarted.versionId, 'v2');
  assert.equal(restarted.snapshot.state.temps.choice_crc, 200);
  assert.equal(restarted.snapshot.checkpoint.state.temps.choice_crc, 200);
  assert.deepEqual(restarted.storage, {});
  assert.match(restarted.migration.warnings.join(' '), /Built-in save slots and preferences/);
  assert.deepEqual(record, original);
});

test('mismatched checkpoint scene names and every stack alias prevent chapter restart', () => {
  const make = () => {
    const record = save();
    record.snapshot.checkpoint = { state: { stats: { sceneName: 'chapter1' }, temps: {}, lineNum: 0, indent: 0 }, scene: { name: 'chapter1' }, atSceneStart: true };
    return record;
  };
  for (const scope of ['stats', 'temps']) for (const key of ['choice_subscene_stack', 'choice_gosub_scene_stack', 'choice_gosub_stack', 'choice_subroutine_stack']) {
    const record = make(); record.snapshot.checkpoint.state[scope][key] = [{ name: 'chapter1' }];
    assert.equal(assessCompatibility(record, version('v2'), version('v1')).canRestartCheckpoint, false, `${scope}.${key}`);
    assert.throws(() => restartFromCheckpoint(record, version('v2')), /no verified/);
  }
  const record = make(); record.snapshot.checkpoint.state.stats.sceneName = 'chapter2';
  assert.equal(assessCompatibility(record, version('v2'), version('v1')).canRestartCheckpoint, false);
});
