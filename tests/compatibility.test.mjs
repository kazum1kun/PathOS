import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assessCompatibility, cloneEditedSave, compactSaveRecord, migrateSave, restartFromCheckpoint, validateSaveRecord } from '../src/compatibility.js';
import { inspectArchive } from '../src/importer.js';
import { encodeSave, readSaveFile } from '../src/transfer.js';

function referenceScene(declarations) {
  const context = vm.createContext({ console });
  for (const file of ['scene.js', 'util.js']) vm.runInContext(fs.readFileSync(new URL(`fixtures/choicescript/${file}`, import.meta.url), 'utf8'), context);
  const scene = new context.Scene('startup', {});
  for (const declaration of declarations) scene.create(declaration.slice('*create '.length));
  return scene;
}

async function importedVersion(id, declarations, future = 'Future chapter') {
  const zip = new globalThis.JSZip();
  zip.file('index.html', `<script>allScenes = ${JSON.stringify({
    startup:{ crc:1, lines:declarations, labels:{} },
    chapter1:{ crc:2, lines:Array(30).fill('Current chapter'), labels:{} },
    chapter2:{ crc:3, lines:[future], labels:{} },
  })};</script>`);
  return { ...(await inspectArchive(await zip.generateAsync({ type:'uint8array' }))).candidates[0], id, gameId:'game' };
}

function withCheckpoint(record) {
  record.snapshot.checkpoint = {
    state:{ ...structuredClone(record.snapshot.state), lineNum:0 },
    scene:{ name:'chapter1' }, atSceneStart:true,
  };
  return record;
}

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

test('real engine numeric strings and arithmetic results migrate and restart across old numeric metadata', async () => {
  const declarations = ['*create strength 10', '*create name "Knight"'];
  const reference = referenceScene(declarations);
  assert.equal(reference.stats.strength, '10');
  const values = [reference.stats.strength];
  reference.set('strength + 2');
  assert.equal(reference.stats.strength, 12);
  values.push(reference.stats.strength);
  const source = await importedVersion('v1', declarations, 'Old future');
  const target = await importedVersion('v2', declarations, 'Changed future');
  assert.equal(source.engineHash, target.engineHash);
  for (const oldSource of [false, true]) for (const oldTarget of [false, true]) for (const value of values) {
    const originalVersion = structuredClone(source), selectedVersion = structuredClone(target);
    if (oldSource) { originalVersion.initialStats.strength = 10; delete originalVersion.initializers; }
    if (oldTarget) { selectedVersion.initialStats.strength = 10; delete selectedVersion.initializers; }
    const record = withCheckpoint(save());
    record.snapshot.state.stats.strength = value;
    record.snapshot.checkpoint.state.stats.strength = value;
    const assessment = assessCompatibility(record, selectedVersion, originalVersion);
    assert.equal(assessment.canResume, true, JSON.stringify({ oldSource, oldTarget, value, assessment }));
    assert.equal(assessment.canRestartCheckpoint, true);
    assert.equal(migrateSave(record, selectedVersion, originalVersion).snapshot.state.stats.strength, value);
    assert.equal(restartFromCheckpoint(record, selectedVersion, originalVersion).snapshot.state.stats.strength, value);
  }
});

test('numeric-looking quoted defaults remain author type changes for migration and restart', async () => {
  for (const [before, after] of [['10', '"10"'], ['"10"', '10']]) {
    const source = await importedVersion('v1', [`*create strength ${before}`, '*create name "Knight"']);
    const target = await importedVersion('v2', [`*create strength ${after}`, '*create name "Knight"']);
    const reference = referenceScene([`*create strength ${before}`]);
    const record = withCheckpoint(save());
    record.snapshot.state.stats.strength = reference.stats.strength;
    record.snapshot.checkpoint.state.stats.strength = reference.stats.strength;
    const assessment = assessCompatibility(record, target, source);
    assert.equal(assessment.canResume, false);
    assert.deepEqual(assessment.typeChanges, ['strength']);
    assert.equal(assessment.canRestartCheckpoint, false);
    assert.throws(() => restartFromCheckpoint(record, target, source), /changed the type/);
  }
});

test('new defaults reparse old imported declarations with actual engine string and numeric semantics', async () => {
  const declarations = ['*create strength 10', '*create name "Knight"'];
  const added = [String.raw`*create code "a\nb"`, '*create precision 2.50'];
  const reference = referenceScene(added);
  const source = await importedVersion('v1', declarations);
  const target = await importedVersion('v2', [...declarations, ...added]);
  // Simulate metadata saved by the previous JSON.parse-based importer.
  target.initialStats.code = 'a\nb';
  target.initialStats.precision = 2.5;
  const record = withCheckpoint(save()), original = structuredClone(record);
  for (const copy of [migrateSave(record, target, source), restartFromCheckpoint(record, target, source)]) {
    assert.equal(copy.snapshot.state.stats.code, reference.stats.code);
    assert.equal(copy.snapshot.state.stats.precision, reference.stats.precision);
  }
  assert.deepEqual(record, original);
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

test('live edits preserve variables created during page replay and round-trip through compressed saves', async () => {
  const record = save();
  record.snapshot.liveEdits = { stats: { strength: 42, name: 'New name' }, temps: { visited: true, newly_created: 3 } };
  const original = structuredClone(record);
  assert.doesNotThrow(() => validateSaveRecord(record));
  assert.deepEqual(compactSaveRecord(record).snapshot.liveEdits, record.snapshot.liveEdits);
  const encoded = await encodeSave({ save: record });
  const restored = await readSaveFile(new File([encoded], 'edited.zip'));
  assert.deepEqual(restored.save.snapshot.liveEdits, record.snapshot.liveEdits);
  assert.deepEqual(record, original);
});

test('live edit validation rejects invalid scopes, values and internal variable names', () => {
  for (const edits of [null, [], { unknown: {} }, { stats: [] }, { stats: null }, { temps: { ready: null } }, { stats: { strength: Infinity } }, { stats: { inventory: [] } }, { stats: { strength: () => 1 } }]) {
    const record = save(); record.snapshot.liveEdits = edits;
    assert.throws(() => validateSaveRecord(record), /live variable edits/);
  }
  for (const name of ['scene', 'sceneName', 'SCENENAME', 'choice_reuse', 'Choice_random_seed', '_looplimit', 'param', 'PARAM_1', 'constructor', 'Prototype', '__proto__', 'strength.value', 'two words']) {
    const record = save(); record.snapshot.liveEdits = { stats: { [name]: 1 } };
    assert.throws(() => validateSaveRecord(record), /internal or invalid variable name/, name);
  }
  const record = save(); record.snapshot.checkpoint = { liveEdits: { temps: { choice_reuse: 'hide' } } };
  assert.throws(() => validateSaveRecord(record), /internal or invalid variable name/);
});

test('edited copies update overlapping live overrides and preserve other current-page edits', () => {
  const record = save(); record.snapshot.liveEdits = { stats: { strength: 42, name: 'Current name' }, temps: { visited: true } };
  const original = structuredClone(record);
  const edited = cloneEditedSave(record, { stats: { strength: 50 }, temps: { visited: false } });
  assert.equal(edited.snapshot.state.stats.strength, 50);
  assert.equal(edited.snapshot.state.temps.visited, false);
  assert.deepEqual(edited.snapshot.liveEdits, { stats: { strength: 50, name: 'Current name' }, temps: { visited: false } });
  assert.deepEqual(record, original);
});

test('compatible migration retains current-page live edits and validates their stat types', () => {
  const record = save(); record.snapshot.liveEdits = { stats: { strength: '42' }, temps: { created_on_page: true } };
  const original = structuredClone(record);
  const migrated = migrateSave(record, version('v2'), version('v1'));
  assert.deepEqual(migrated.snapshot.liveEdits, record.snapshot.liveEdits);
  assert.notEqual(migrated.snapshot.liveEdits, record.snapshot.liveEdits);
  assert.deepEqual(record, original);
  record.snapshot.liveEdits.stats.strength = 'not a number';
  assert.deepEqual(assessCompatibility(record, version('v2'), version('v1')).typeChanges, ['strength']);
  assert.throws(() => migrateSave(record, version('v2'), version('v1')), /changed variable types/);
});

test('chapter restarts discard edits belonging to the original current page', () => {
  const record = withCheckpoint(save());
  record.snapshot.liveEdits = { stats: { strength: 42 }, temps: { visited: true } };
  record.snapshot.checkpoint.liveEdits = { stats: { strength: 25 } };
  const original = structuredClone(record);
  const restarted = restartFromCheckpoint(record, version('v2'), version('v1'));
  assert.equal(restarted.snapshot.state.stats.strength, 12);
  assert.equal(Object.hasOwn(restarted.snapshot, 'liveEdits'), false);
  assert.equal(Object.hasOwn(restarted.snapshot.checkpoint, 'liveEdits'), false);
  assert.deepEqual(record, original);
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
