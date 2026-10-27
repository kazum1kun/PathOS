import { assertJSONValue, validateSaveRecord } from './compatibility.js';

const BUNDLE_FORMAT = 'choicescript-save-bundle-v1';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SAVES = 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class LegacySaveError extends Error {
  constructor(code, message) { super(message); this.name = 'LegacySaveError'; this.code = code; }
}
const fail = (code, message) => { throw new LegacySaveError(code, message); };

function parsed(input) {
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES) fail('TOO_LARGE', 'The legacy save file exceeds the 20 MB import limit.');
    try { input = JSON.parse(input); } catch { fail('INVALID_JSON', 'The save file is not valid JSON.'); }
  }
  try { assertJSONValue(input); } catch (error) { fail('UNSAFE_DATA', error.message); }
  if (!object(input)) fail('INVALID_SAVE', 'Choose a complete ChoiceScript state or an exported ChoiceScript save bundle.');
  if (JSON.stringify(input).length > MAX_BYTES) fail('TOO_LARGE', 'The legacy save file exceeds the 20 MB import limit.');
  return input;
}

function sourceScenes(version) {
  const entries = Array.isArray(version.sceneIndex)
    ? version.sceneIndex.map(scene => [scene.name, scene]) : Object.entries(version.sceneIndex || {});
  return new Map(entries.filter(([name]) => typeof name === 'string').map(([name, scene]) => [name.toLowerCase(), scene]));
}

function normalizedCRC(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < -2147483648 || value > 4294967295) fail('INVALID_CRC', 'A saved scene checksum is invalid.');
  return value >>> 0;
}

function savedCRC(state) {
  const possible = [state.temps?.choice_crc, state.scene?.crc, state.sceneCRC, state.sceneCrc, state.crc];
  const values = possible.map(normalizedCRC).filter(value => value !== null);
  if (values.some(value => value !== values[0])) fail('CONFLICTING_CRC', 'This save contains conflicting checksums for its current scene.');
  return values[0] ?? null;
}

function stateFrom(input) {
  const source = typeof input === 'string' ? parsed(input) : input;
  if (!object(source) || !object(source.stats) || !object(source.temps)) fail('INVALID_SAVE', 'A complete ChoiceScript save needs stats and temporary variables.');
  if (typeof source.stats.sceneName !== 'string' || !source.stats.sceneName.trim()) fail('INVALID_SCENE', 'The saved state does not identify its current scene.');
  if (!Number.isInteger(source.lineNum) || source.lineNum < 0) fail('INVALID_LINE', 'The saved line number is invalid.');
  if (!Number.isInteger(source.indent) || source.indent < 0) fail('INVALID_INDENT', 'The saved indentation is missing or invalid.');
  if (source.debug !== undefined && typeof source.debug !== 'boolean') fail('INVALID_SAVE', 'The saved debug flag must be true or false.');
  if (source.version !== undefined && typeof source.version !== 'string' && typeof source.version !== 'number') fail('INVALID_SAVE', 'The saved engine version must be text or a number.');
  // Preserve engine state only. Imported object fields cannot become library IDs,
  // stored browser settings, or arbitrary save-record metadata.
  const state = { stats:copy(source.stats), temps:copy(source.temps), lineNum:source.lineNum, indent:source.indent };
  for (const key of ['version', 'debug']) if (own(source, key)) state[key] = source[key];
  return { state, crc:savedCRC(source) };
}

function validateReturnScenes(state, scenes, warnings) {
  let hasReturn = false;
  for (const scope of [state.stats, state.temps]) {
    for (const key of ['choice_subscene_stack', 'choice_gosub_scene_stack', 'choice_gosub_stack', 'choice_subroutine_stack']) {
      const stack = scope[key];
      if (stack === undefined || stack === null) continue;
      if (!Array.isArray(stack)) fail('INVALID_STACK', 'The save contains an invalid return stack.');
      for (const frame of stack) {
        hasReturn = true;
        const name = typeof frame === 'string' ? frame : object(frame) ? frame.sceneName ?? frame.scene ?? frame.name : null;
        if (typeof name === 'string' && name && !scenes.has(name.toLowerCase())) fail('MISSING_RETURN_SCENE', `The selected version does not contain saved return scene “${name}”.`);
      }
    }
  }
  if (hasReturn) warnings.push('Saved return locations have no complete source fingerprint. Confirm that the selected package is the original version.');
}

function sourceKeyLabel(key) {
  if (key === 'state') return 'Imported autosave';
  if (key === 'statebackup') return 'Imported backup save';
  if (key === 'statetemp') return 'Imported temporary save';
  return key ? `Imported quick save ${key.match(/_SAVE_(\d+)$/)?.[1] || key}` : 'Imported ChoiceScript save';
}

/**
 * Convert the old web editor's raw state or choicescript-save-bundle-v1 export.
 * The caller must display source-version confirmation before persisting results.
 * No automatic migration is performed, even when the current scene CRC matches.
 *
 * Returns an Array of save records. Non-enumerable .warnings (string[]) and
 * .requiresSourceConfirmation (true) support preview UI. The same provenance and
 * per-record warnings remain in each record.legacyImport after JSON serialization.
 */
export function prepareLegacySaves(input, { game, version } = {}) {
  if (!game || typeof game.id !== 'string' || !game.id) fail('NO_GAME', 'Select the matching installed game before importing a legacy save.');
  if (!version || typeof version.id !== 'string' || !version.id || version.gameId !== game.id) fail('NO_SOURCE_VERSION', 'Select an installed original version of this game.');
  const value = parsed(input), bundle = value.format === BUNDLE_FORMAT;
  if (value.format !== undefined && !bundle) fail('UNSUPPORTED_FORMAT', 'This file isn’t a ChoiceScript save or save bundle that PathOS can import.');
  const sourceGame = bundle ? value.game : null;
  let items;
  if (bundle) {
    if (typeof sourceGame !== 'string' || !sourceGame || sourceGame.length > 300) fail('INVALID_BUNDLE', 'The save bundle does not identify its game.');
    const identities = [game.identity, game.storeName, version.storeName].filter(name => typeof name === 'string' && name).map(name => name.toLowerCase());
    if (!identities.includes(sourceGame.toLowerCase())) fail('WRONG_GAME', `This bundle belongs to “${sourceGame}”, which does not match the selected game identity.`);
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_SAVES) fail('INVALID_BUNDLE', `A save bundle must contain between 1 and ${MAX_SAVES} saved positions.`);
    const seen = new Set();
    items = value.items.map(item => {
      if (!object(item) || typeof item.key !== 'string' || item.key.length > 700) fail('INVALID_SLOT', 'The save bundle contains an invalid slot.');
      const quickPrefix = `state${sourceGame}_SAVE_`;
      if (!['state', 'statebackup', 'statetemp'].includes(item.key) && !(item.key.startsWith(quickPrefix) && /^\d+$/.test(item.key.slice(quickPrefix.length)))) fail('INVALID_SLOT', `Unexpected save key in bundle: ${item.key}.`);
      if (seen.has(item.key)) fail('DUPLICATE_SLOT', `The save bundle contains duplicate slot ${item.key}.`);
      seen.add(item.key);
      if (own(item, 'state') && own(item, 'data') && JSON.stringify(item.state) !== JSON.stringify(item.data)) fail('AMBIGUOUS_SLOT', `Slot ${item.key} contains two different saved states.`);
      if (!own(item, 'state') && !own(item, 'data')) fail('INVALID_SLOT', `Slot ${item.key} contains no saved state.`);
      return { key:item.key, input:item.state ?? item.data, name:typeof item.name === 'string' ? item.name.slice(0, 160) : null };
    });
  } else items = [{ key:null, input:value, name:null }];

  const scenes = sourceScenes(version), createdAt = new Date().toISOString();
  const common = ['Legacy saves have no complete package or engine fingerprint. Confirm the original game version before importing; this does not migrate the save to an update.'];
  if (!bundle) common.push('A raw state file does not identify its game. Confirm that it belongs to the selected game.');
  const records = items.map(item => {
    const { state, crc } = stateFrom(item.input), name = state.stats.sceneName.toLowerCase();
    const scene = scenes.get(name);
    if (!scene || !object(scene)) fail('MISSING_SCENE', `The selected version does not contain saved scene “${state.stats.sceneName}”. Install the original APK version first.`);
    if (Array.isArray(scene.lines) && state.lineNum > scene.lines.length) fail('INVALID_LINE', `The saved line is outside scene “${name}” in the selected version.`);
    const expectedCRC = normalizedCRC(scene.crc);
    if (crc !== null && expectedCRC !== null && crc !== expectedCRC) fail('CRC_MISMATCH', `Saved scene “${name}” differs from the selected version. Install the original game version; the old line number cannot be assigned to changed code.`);
    const verified = crc !== null && expectedCRC !== null;
    const warnings = [...common];
    if (!verified) warnings.push(`The saved scene “${name}” has no comparable checksum. Its source cannot be verified; explicitly select the original version that produced this save.`);
    validateReturnScenes(state, scenes, warnings);
    const record = {
      id:crypto.randomUUID(), gameId:game.id, versionId:version.id, kind:'imported',
      name:item.name || sourceKeyLabel(item.key), createdAt,
      snapshot:{ format:'story-vault-state-v1', state, scene:{ name, crc }, capturedAt:createdAt }, storage:{},
      legacyImport:{ sourceFormat:bundle ? BUNDLE_FORMAT : 'raw-choicescript', sourceGame, sourceKey:item.key, verification:verified ? 'scene-crc' : 'unverified', requiresSourceConfirmation:true, warnings },
    };
    if (bundle && typeof value.exportedAt === 'string') record.legacyImport.exportedAt = value.exportedAt.slice(0, 100);
    validateSaveRecord(record);
    return record;
  });
  const warnings = [...new Set(records.flatMap(record => record.legacyImport.warnings))];
  Object.defineProperties(records, { warnings:{ value:warnings }, requiresSourceConfirmation:{ value:true } });
  return records;
}
