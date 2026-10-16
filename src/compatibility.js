// ChoiceScript line numbers are meaningful only for the source that produced them.
// Never move a saved instruction pointer into a changed chapter automatically.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateTimestamp(value, label = 'The record') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must have a valid ISO creation date.`);
  }
}

export function validateSaveRecord(save) {
  if (!isObject(save)) throw new Error('The save must be an object.');
  for (const field of ['id', 'gameId', 'versionId']) {
    if (typeof save[field] !== 'string' || !save[field].trim()) throw new Error(`The save is missing ${field}.`);
  }
  if (save.name !== undefined && typeof save.name !== 'string') throw new Error('The save name must be text.');
  validateTimestamp(save.createdAt, 'The save');
  if (!isObject(save.snapshot) || !isObject(save.snapshot.state)) throw new Error('The save has no ChoiceScript state.');
  const state = save.snapshot.state;
  if (!isObject(state.stats) || !isObject(state.temps)) throw new Error('The save must contain stats and temporary variables.');
  if (!Number.isInteger(state.lineNum) || state.lineNum < 0) throw new Error('The saved line number is invalid.');
  if (state.indent !== undefined && (!Number.isInteger(state.indent) || state.indent < 0)) throw new Error('The saved indentation is invalid.');
  if (!isObject(save.snapshot.scene) || typeof save.snapshot.scene.name !== 'string' || !save.snapshot.scene.name) {
    throw new Error('The save must identify its current scene.');
  }
  if (typeof state.stats.sceneName !== 'string' || !state.stats.sceneName.trim() || state.stats.sceneName.toLowerCase() !== save.snapshot.scene.name.toLowerCase()) {
    throw new Error('The saved engine scene name must match its scene metadata.');
  }
  if (save.snapshot.scene.lines !== undefined) {
    if (!Array.isArray(save.snapshot.scene.lines) || save.snapshot.scene.lines.some(line => typeof line !== 'string')) throw new Error('The saved scene source is invalid.');
    // ChoiceScript permits the line-count sentinel when finishing a scene.
    if (state.lineNum > save.snapshot.scene.lines.length) throw new Error('The saved line number is outside its scene source.');
  }
  if (save.storage !== undefined && !isObject(save.storage)) throw new Error('The saved storage is invalid.');
  assertJSONValue(save);
  return save;
}

// Reject executable/prototype-bearing data and values JSON cannot preserve.
export function assertJSONValue(value, depth = 0, seen = new Set()) {
  if (depth > 100) throw new Error('The data is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('The data contains an invalid number.');
    return;
  }
  if (typeof value !== 'object') throw new Error('The data contains an unsupported value.');
  if (seen.has(value)) throw new Error('The data contains a circular reference.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('The data contains an unsupported object.');
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('The data contains an unsafe property name.');
    assertJSONValue(child, depth + 1, seen);
  }
  seen.delete(value);
}

function checksum(entry) {
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.hash ?? entry.sha256 ?? entry.contentHash ?? entry.crc;
  return value === undefined || value === null ? null : String(value);
}

function sceneMap(version) {
  const index = version?.sceneIndex;
  if (!index) return {};
  if (Array.isArray(index)) return Object.fromEntries(index.map(scene => [String(scene.name).toLowerCase(), scene]));
  return Object.fromEntries(Object.entries(index).map(([name, info]) => [name.toLowerCase(), info]));
}

function sceneName(value) {
  if (typeof value === 'string') return value.toLowerCase();
  if (isObject(value)) return String(value.sceneName ?? value.scene ?? value.name ?? '').toLowerCase();
  return '';
}

// Cross-scene return frames appear in several engine revisions. Treat an
// unrecognised frame conservatively, rather than guessing its return location.
function referencedScenes(snapshot) {
  const names = new Set([snapshot.scene.name.toLowerCase()]);
  let unknown = false;
  for (const scope of [snapshot.state.stats, snapshot.state.temps]) {
    for (const key of ['choice_subscene_stack', 'choice_gosub_scene_stack', 'choice_gosub_stack', 'choice_subroutine_stack']) {
      const stack = scope?.[key];
      if (stack === undefined || stack === null) continue;
      if (!Array.isArray(stack)) { unknown = true; continue; }
      for (const frame of stack) {
        const name = sceneName(frame);
        if (name) names.add(name);
        else if (key.includes('subscene') || key.includes('gosub_scene')) unknown = true;
        // Local gosub frames only contain line/indent and belong to this scene.
      }
    }
  }
  return { names: [...names], unknown };
}

function typeOf(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }

function usableCheckpoint(save, targetVersion) {
  const checkpoint = save.snapshot?.checkpoint;
  if (!checkpoint?.state || typeof checkpoint?.scene?.name !== 'string' || !checkpoint.scene.name || checkpoint.state.lineNum !== 0) return false;
  if (!isObject(checkpoint.state.stats) || !isObject(checkpoint.state.temps)) return false;
  if (typeof checkpoint.state.stats.sceneName !== 'string' || checkpoint.state.stats.sceneName.toLowerCase() !== checkpoint.scene.name.toLowerCase()) return false;
  for (const scope of [checkpoint.state.stats, checkpoint.state.temps]) {
    for (const key of ['choice_subscene_stack', 'choice_gosub_scene_stack', 'choice_gosub_stack', 'choice_subroutine_stack']) {
      const stack = scope[key];
      if (stack !== undefined && stack !== null && (!Array.isArray(stack) || stack.length)) return false;
    }
  }
  return Boolean(sceneMap(targetVersion)[checkpoint.scene.name.toLowerCase()]);
}

function changedUnresolvedInitializers(save, targetVersion, sourceVersion) {
  if (save.versionId === targetVersion?.id || (sourceVersion?.contentHash && sourceVersion.contentHash === targetVersion?.contentHash)) return [];
  const previous = sourceVersion?.unresolvedInitializers ?? {};
  return Object.entries(targetVersion?.unresolvedInitializers ?? {})
    .filter(([name, declaration]) => !own(previous, name) || previous[name] !== declaration)
    .map(([name]) => name);
}

function storageNeedsReset(save, targetVersion, sourceVersion) {
  return save.versionId !== targetVersion?.id && !(sourceVersion?.contentHash && sourceVersion.contentHash === targetVersion?.contentHash);
}

const STORAGE_RESET_WARNING = 'Moving this save to the selected version starts with empty isolated game storage. Built-in save slots and preferences stay in the original-version snapshot.';

export function assessCompatibility(save, targetVersion, sourceVersion) {
  const result = {
    status: 'unknown', canResume: false, canRestartCheckpoint: false,
    reason: 'The source version is required to verify this save.',
    warnings: [], changedScenes: [], newVariables: [], typeChanges: [],
  };
  try { validateSaveRecord(save); } catch (error) { result.status = 'blocked'; result.reason = error.message; return result; }
  if (!targetVersion || targetVersion.gameId !== save.gameId) {
    result.status = 'blocked'; result.reason = 'This save belongs to a different game.'; return result;
  }
  const unresolvedChanges = changedUnresolvedInitializers(save, targetVersion, sourceVersion);
  result.canRestartCheckpoint = usableCheckpoint(save, targetVersion) && unresolvedChanges.length === 0;
  if (storageNeedsReset(save, targetVersion, sourceVersion)) result.warnings.push(STORAGE_RESET_WARNING);
  if (save.versionId === targetVersion.id || (sourceVersion?.contentHash && sourceVersion.contentHash === targetVersion.contentHash)) {
    result.status = 'exact'; result.canResume = true; result.reason = 'The save matches this installed version.'; return result;
  }
  if (sourceVersion && sourceVersion.gameId !== save.gameId) {
    result.status = 'blocked'; result.reason = 'The source version belongs to a different game.'; return result;
  }
  if (unresolvedChanges.length) {
    result.status = 'blocked';
    result.reason = `The new version added or changed initializers that cannot safely be evaluated from a save: ${unresolvedChanges.join(', ')}. Start a new game or use the original version.`;
    return result;
  }
  const sourceScenes = sceneMap(sourceVersion);
  const targetScenes = sceneMap(targetVersion);
  const { names, unknown } = referencedScenes(save.snapshot);
  if (unknown) {
    result.status = 'blocked'; result.reason = 'A saved return stack cannot be verified on the new version.'; return result;
  }
  for (const name of names) {
    const source = sourceScenes[name];
    const target = targetScenes[name];
    if (!target) {
      result.status = 'blocked'; result.reason = `The new version does not contain the saved scene “${name}”.`; return result;
    }
    const oldHash = checksum(source);
    const newHash = checksum(target);
    if (oldHash === null || newHash === null) {
      result.reason = `The saved scene “${name}” has no source checksum to compare.`; return result;
    }
    if (oldHash !== newHash) result.changedScenes.push(name);
  }
  if (result.changedScenes.length) {
    result.status = 'blocked';
    result.reason = `Saved code changed in ${result.changedScenes.join(', ')}. Resume with the original version, or explicitly restart from an available chapter checkpoint.`;
    return result;
  }
  if (sourceVersion?.engineHash && targetVersion.engineHash && sourceVersion.engineHash !== targetVersion.engineHash) {
    result.status = 'blocked'; result.reason = 'The ChoiceScript engine changed. Use the original version for this save.'; return result;
  }
  const initial = targetVersion.initialStats ?? {};
  for (const [name, value] of Object.entries(initial)) {
    if (!own(save.snapshot.state.stats, name)) result.newVariables.push(name);
    else if (typeOf(value) !== typeOf(save.snapshot.state.stats[name])) result.typeChanges.push(name);
  }
  if (result.typeChanges.length) {
    result.status = 'blocked'; result.reason = `The new version changed variable types: ${result.typeChanges.join(', ')}.`; return result;
  }
  if (result.newVariables.length) {
    result.warnings.push(`New variables were added: ${result.newVariables.join(', ')}. Their defaults will be copied into a new save when you choose to migrate.`);
  }
  const changedElsewhere = Object.keys(targetScenes).filter(name => sourceScenes[name] && checksum(targetScenes[name]) !== checksum(sourceScenes[name]));
  if (changedElsewhere.length) result.warnings.push('Other chapters changed. The author may have changed story logic or variable meanings; keep the original version and save.');
  if (!sourceVersion?.engineHash || !targetVersion.engineHash) result.warnings.push('The engine version could not be compared.');
  result.status = 'compatible'; result.canResume = true;
  result.reason = 'The current scene and every saved return scene are unchanged. Resume creates a migrated copy.';
  return result;
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function newId() { return globalThis.crypto?.randomUUID?.() ?? `save-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function synchronizeChecksum(snapshot, targetVersion) {
  const scenes = sceneMap(targetVersion);
  const entry = scenes[typeof snapshot?.scene?.name === 'string' ? snapshot.scene.name.toLowerCase() : ''];
  if (!snapshot?.state?.temps) return;
  // Engine builds can assign a different CRC even when the normalised scene
  // source is identical. A stale choice_crc invokes ChoiceScript's automatic
  // recovery, which can replace the selected state with an older backup.
  if (entry?.crc !== undefined && entry.crc !== null) {
    snapshot.state.temps.choice_crc = entry.crc;
    snapshot.scene.crc = entry.crc;
  } else {
    delete snapshot.state.temps.choice_crc;
    delete snapshot.scene.crc;
  }
  for (const scope of [snapshot.state.stats, snapshot.state.temps]) {
    for (const key of ['choice_subscene_stack', 'choice_gosub_scene_stack', 'choice_gosub_stack', 'choice_subroutine_stack']) {
      if (!Array.isArray(scope?.[key])) continue;
      for (const frame of scope[key]) {
        if (!isObject(frame?.temps)) continue;
        const frameScene = scenes[sceneName(frame)] ?? (sceneName(frame) ? undefined : entry);
        if (frameScene?.crc !== undefined && frameScene.crc !== null) frame.temps.choice_crc = frameScene.crc;
        else delete frame.temps.choice_crc;
      }
    }
  }
}

export function cloneEditedSave(save, patch = {}, name) {
  validateSaveRecord(save);
  assertJSONValue(patch);
  const clone = copy(save);
  if (patch.stats) Object.assign(clone.snapshot.state.stats, copy(patch.stats));
  if (patch.temps) Object.assign(clone.snapshot.state.temps, copy(patch.temps));
  clone.id = newId(); clone.parentSaveId = save.id; clone.kind = 'edited';
  clone.createdAt = new Date().toISOString(); clone.name = name ?? `${save.name || 'Save'} (edited)`;
  validateSaveRecord(clone);
  return clone;
}

export function migrateSave(save, targetVersion, sourceVersion) {
  const assessment = assessCompatibility(save, targetVersion, sourceVersion);
  if (!assessment.canResume) throw new Error(assessment.reason);
  const migrated = copy(save);
  migrated.id = newId(); migrated.parentSaveId = save.id; migrated.versionId = targetVersion.id;
  migrated.kind = 'migrated'; migrated.createdAt = new Date().toISOString();
  migrated.name = `${save.name || 'Save'} (${targetVersion.label || 'updated version'})`;
  // Opaque in-game quickslots can contain instruction pointers in other,
  // changed chapters. Carrying them into this version would bypass the host's
  // compatibility checks when the player uses the game's own Load button.
  if (storageNeedsReset(save, targetVersion, sourceVersion)) migrated.storage = {};
  for (const key of assessment.newVariables) migrated.snapshot.state.stats[key] = copy(targetVersion.initialStats[key]);
  synchronizeChecksum(migrated.snapshot, targetVersion);
  if (migrated.snapshot.checkpoint) synchronizeChecksum(migrated.snapshot.checkpoint, targetVersion);
  migrated.migration = { fromVersionId: save.versionId, toVersionId: targetVersion.id, warnings: assessment.warnings };
  return migrated;
}

export function restartFromCheckpoint(save, targetVersion, sourceVersion) {
  validateSaveRecord(save);
  if (targetVersion?.gameId !== save.gameId || !usableCheckpoint(save, targetVersion)) {
    throw new Error('This save has no verified chapter-start checkpoint in the selected version.');
  }
  const unresolvedChanges = changedUnresolvedInitializers(save, targetVersion, sourceVersion);
  if (unresolvedChanges.length) throw new Error(`The new version has new or changed initializers that cannot safely be evaluated from this checkpoint: ${unresolvedChanges.join(', ')}.`);
  const checkpoint = copy(save.snapshot.checkpoint);
  const targetScene = sceneMap(targetVersion)[checkpoint.scene.name.toLowerCase()];
  for (const [key, value] of Object.entries(targetVersion.initialStats ?? {})) {
    if (!own(checkpoint.state.stats, key)) checkpoint.state.stats[key] = copy(value);
    else if (typeOf(value) !== typeOf(checkpoint.state.stats[key])) throw new Error(`The new version changed the type of “${key}”. Use the original version for this checkpoint.`);
  }
  // The new scene must be loaded from the selected package, never from the
  // source/CRC attached to the old checkpoint.
  const scene = { name: checkpoint.scene.name };
  for (const key of ['crc', 'lines', 'labels']) if (targetScene[key] !== undefined && targetScene[key] !== null) scene[key] = copy(targetScene[key]);
  const restarted = copy(save);
  restarted.id = newId(); restarted.parentSaveId = save.id; restarted.versionId = targetVersion.id;
  restarted.kind = 'checkpoint'; restarted.createdAt = new Date().toISOString();
  restarted.name = `${save.name || 'Save'} (chapter restart)`;
  restarted.storage = {};
  restarted.snapshot = { ...restarted.snapshot, state: checkpoint.state, scene, checkpoint: { state: copy(checkpoint.state), scene: copy(scene), atSceneStart: true } };
  synchronizeChecksum(restarted.snapshot, targetVersion);
  synchronizeChecksum(restarted.snapshot.checkpoint, targetVersion);
  restarted.migration = { fromVersionId: save.versionId, toVersionId: targetVersion.id, checkpointRestart: true, warnings: ['This replays the chapter with progress captured before its old version ran. Story logic changed by the author may require starting a new game.', 'This chapter-restart copy starts with empty isolated game storage. Built-in save slots and preferences stay in the original-version snapshot.'] };
  validateSaveRecord(restarted);
  return restarted;
}
