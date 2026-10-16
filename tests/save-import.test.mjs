import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLegacySaves } from '../src/save-import.js';
import { validateSaveRecord } from '../src/compatibility.js';

const game = { id:'game-id', identity:'dinoknights', title:'DinoKnights' };
const version = { id:'original-version', gameId:game.id, storeName:'dinoknights', sceneIndex:{ chapter1:{ crc:1234, lines:['a','b','c'] }, chapter2:{ crc:2345, lines:['a','b','c'] } } };
const state = () => ({ version:'UNKNOWN', stats:{ sceneName:'chapter1', strength:42 }, temps:{ choice_crc:1234 }, lineNum:1, indent:0 });
const options = { game, version };
const code = expected => error => error.code === expected;
const bundle = items => ({ format:'choicescript-save-bundle-v1', game:'dinoknights', save_list:'123', items });

test('raw state becomes an immutable imported copy assigned only to selected original version', () => {
  const input = state(), before = structuredClone(input);
  const records = prepareLegacySaves(JSON.stringify(input), options);
  assert.equal(records.length, 1);
  assert.equal(records[0].versionId, version.id);
  assert.equal(records[0].gameId, game.id);
  assert.equal(records[0].kind, 'imported');
  assert.equal(records[0].legacyImport.verification, 'scene-crc');
  assert.equal(records.requiresSourceConfirmation, true);
  assert.match(records.warnings.join(' '), /does not migrate/);
  assert.match(records.warnings.join(' '), /does not identify its game/);
  assert.notEqual(records[0].snapshot.state, input);
  assert.deepEqual(input, before);
  validateSaveRecord(records[0]);
});

test('previous editor bundles use item.data while alternate exporters may use item.state', () => {
  const records = prepareLegacySaves(bundle([
    { key:'state', data:state() }, { key:'statebackup', state:state() },
    { key:'statedinoknights_SAVE_123', data:JSON.stringify(state()), name:'At the gate' },
  ]), options);
  assert.equal(records.length, 3);
  assert.equal(records[0].name, 'Imported autosave');
  assert.equal(records[1].name, 'Imported backup save');
  assert.equal(records[2].name, 'At the gate');
  assert.equal(records[2].legacyImport.sourceKey, 'statedinoknights_SAVE_123');
  assert.equal(new Set(records.map(save => save.id)).size, 3);
  assert.deepEqual(records[0].storage, {});
});

test('missing current CRC or selected-version CRC requires explicit source confirmation', () => {
  const input = state(); delete input.temps.choice_crc;
  const records = prepareLegacySaves(input, options);
  assert.equal(records[0].legacyImport.verification, 'unverified');
  assert.match(records.warnings.join(' '), /no comparable checksum/);
  assert.equal(records[0].snapshot.scene.crc, null);
  const noSourceCRC = { ...version, sceneIndex:{ chapter1:{ lines:['a','b','c'] } } };
  assert.equal(prepareLegacySaves(state(), { game, version:noSourceCRC })[0].legacyImport.verification, 'unverified');
  assert.equal(JSON.parse(JSON.stringify(records))[0].legacyImport.requiresSourceConfirmation, true);
});

test('changed scene CRC, missing chapter and out-of-range line block assignment', () => {
  const changed = state(); changed.temps.choice_crc = 9999;
  assert.throws(() => prepareLegacySaves(changed, options), code('CRC_MISMATCH'));
  const missing = state(); missing.stats.sceneName = 'other-game-scene';
  assert.throws(() => prepareLegacySaves(missing, options), code('MISSING_SCENE'));
  const beyond = state(); beyond.lineNum = 100;
  assert.throws(() => prepareLegacySaves(beyond, options), code('INVALID_LINE'));
});

test('CRC field aliases accept signed 32-bit representation and reject conflicts', () => {
  const input = state(); input.temps.choice_crc = -1;
  const original = { ...version, sceneIndex:{ chapter1:{ crc:4294967295 } } };
  assert.equal(prepareLegacySaves(input, { game, version:original })[0].snapshot.scene.crc, 4294967295);
  delete input.temps.choice_crc; input.scene = { crc:'4294967295' };
  assert.equal(prepareLegacySaves(input, { game, version:original })[0].legacyImport.verification, 'scene-crc');
  input.temps.choice_crc = 123;
  assert.throws(() => prepareLegacySaves(input, { game, version:original }), code('CONFLICTING_CRC'));
});

test('wrong bundle identity is blocked; stable game identity can link renamed namespace editions', () => {
  const foreign = bundle([{ key:'state', data:state() }]); foreign.game = 'another-game';
  assert.throws(() => prepareLegacySaves(foreign, options), code('WRONG_GAME'));
  const renamed = { ...version, storeName:'new-package-namespace' };
  assert.equal(prepareLegacySaves(bundle([{ key:'state', data:state() }]), { game, version:renamed }).length, 1);
});

test('unexpected, duplicate, ambiguous or missing bundle slots are rejected', () => {
  assert.throws(() => prepareLegacySaves(bundle([{ key:'achievements', data:state() }]), options), code('INVALID_SLOT'));
  assert.throws(() => prepareLegacySaves(bundle([{ key:'state', data:state() }, { key:'state', data:state() }]), options), code('DUPLICATE_SLOT'));
  assert.throws(() => prepareLegacySaves(bundle([{ key:'state' }]), options), code('INVALID_SLOT'));
  const changed = state(); changed.stats.strength = 90;
  assert.throws(() => prepareLegacySaves(bundle([{ key:'state', data:state(), state:changed }]), options), code('AMBIGUOUS_SLOT'));
  assert.throws(() => prepareLegacySaves(bundle([]), options), code('INVALID_BUNDLE'));
});

test('malformed raw state, executable objects and prototype properties are rejected', () => {
  assert.throws(() => prepareLegacySaves('{', options), code('INVALID_JSON'));
  const missing = state(); delete missing.temps;
  assert.throws(() => prepareLegacySaves(missing, options), code('INVALID_SAVE'));
  const badLine = state(); badLine.lineNum = -1;
  assert.throws(() => prepareLegacySaves(badLine, options), code('INVALID_LINE'));
  const unsafe = JSON.parse(JSON.stringify(state()).replace('"strength":42', '"__proto__":{"bad":true}'));
  assert.throws(() => prepareLegacySaves(unsafe, options), code('UNSAFE_DATA'));
  const executable = state(); executable.stats.run = () => {};
  assert.throws(() => prepareLegacySaves(executable, options), code('UNSAFE_DATA'));
});

test('saved cross-scene return destinations must exist and incomplete return provenance is reported', () => {
  const input = state(); input.stats.choice_subscene_stack = [{ name:'chapter2', lineNum:2 }];
  assert.match(prepareLegacySaves(input, options).warnings.join(' '), /return locations/);
  input.stats.choice_subscene_stack[0].name = 'missing';
  assert.throws(() => prepareLegacySaves(input, options), code('MISSING_RETURN_SCENE'));
});

test('game/version relationships are checked before preparing save records', () => {
  assert.throws(() => prepareLegacySaves(state()), code('NO_GAME'));
  assert.throws(() => prepareLegacySaves(state(), { game, version:{ ...version, gameId:'other' } }), code('NO_SOURCE_VERSION'));
});
