import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { IDBFactory } from 'fake-indexeddb';
import * as storageModule from '../src/storage.js';
import * as compatibilityModule from '../src/compatibility.js';
import { prepareLegacySaves } from '../src/save-import.js';

const root = new URL('../', import.meta.url);
const now = '2026-10-16T12:00:00.000Z';
const game = { id: 'game-a', title: 'A Small Story', identity: 'small-story', createdAt: now, activeVersionId: 'v1' };
const version = (id = 'v1', overrides = {}) => ({
  id, gameId: game.id, title: game.title, label: id, createdAt: now,
  contentHash: `content-${id}`, engineHash: 'engine-1', entryPath: 'index.html',
  files: [{ path: 'index.html', data: new TextEncoder().encode('<html>Game</html>'), mime: 'text/html' }],
  sceneIndex: { chapter1: { hash: 'chapter1-same' } }, initialStats: { strength: 4 }, ...overrides,
});
const snapshot = (strength = 6) => ({
  state: { stats: { sceneName: 'chapter1', strength }, temps: {}, lineNum: 5, indent: 0 },
  scene: { name: 'chapter1' },
  checkpoint: { state: { stats: { sceneName: 'chapter1', strength: 4 }, temps: {}, lineNum: 0, indent: 0 }, scene: { name: 'chapter1' } },
});
const save = () => ({ id: 'original-save', gameId: game.id, versionId: 'v1', name: 'Before the duel', kind: 'manual', createdAt: now, snapshot: snapshot(), storage: { 'persist:small-story:slot1': 'existing quicksave' } });
async function clickAndWait(element, completed) {
  element.click();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (completed()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('The app action did not complete.');
}

// Exercise the real app handlers and persistence with a DOM implementation. The
// runtime is a controlled boundary: engine/VFS behavior has separate VM tests.
async function harness({ installed = [version()], saved = [], runtimeFactory, archiveCandidate = version(), navigatorOverrides = {}, native = false } = {}) {
  const { window, document } = parseHTML(await readFile(new URL('public/index.html', root), 'utf8'));
  const previous = new Map();
  for (const [key, value] of Object.entries({ window, document, navigator: { storage: { persist: async () => true }, ...navigatorOverrides }, location: { protocol: 'https:' } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const modal = document.querySelector('#modal');
  modal.showModal = () => { modal.open = true; };
  modal.close = () => { modal.open = false; };
  const vault = await storageModule.openVault({ indexedDB: new IDBFactory(), name: crypto.randomUUID() });
  if (native) { vault.storageKind = 'native'; vault.storageInfo = async () => ({ usage: 1024, available: 4096 }); }
  for (const item of installed) await vault.importVersion({ ...game, activeVersionId: item.id }, item);
  for (const item of saved) await vault.putSave(item);
  const players = [];
  const createRuntime = async options => {
    if (runtimeFactory) return runtimeFactory(options, players);
    const player = {
      options, state: structuredClone(options.state || snapshot()), values: structuredClone(options.storage), disposed: false,
      capture: async () => { options.onStorage(structuredClone(player.values)); return structuredClone(player.state); },
      setDebugMode: async enabled => { player.debugMode=enabled; return {enabled}; },
      dispose: () => { player.disposed = true; },
    };
    players.push(player);
    options.onStatus({ level: 'ready', message: 'Ready' });
    return player;
  };
  const bindings = {
    inspectArchive: async () => ({ candidates: [archiveCandidate], warnings: [] }),
    openVault: async () => vault,
    validateRecord: storageModule.validateRecord,
    ...compatibilityModule,
    prepareLegacySaves,
    createRuntime,
    createDemoArchive: async () => new File(['demo'], 'demo.zip'),
  };
  const source = (await readFile(new URL('src/app.js', root), 'utf8')).replace(/^import[^\n]*\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const app = await new AsyncFunction(...Object.keys(bindings), source + '\nreturn { refresh, launch, flush, leavePlayer, enqueueSave, openEditor, handleAction, importSave, importArchive, getData: () => ({ games, versions, saves, selected, session }) };')(...Object.values(bindings));
  return { app, document, vault, players, async close() {
    await app.leavePlayer(false);
    vault.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  } };
}

test('app keeps storage-only changes and prevents old callbacks saving into another playthrough', async () => {
  const h = await harness();
  try {
    await h.app.launch(game, version());
    const first = h.players[0];
    await h.app.flush();
    first.values['persist:small-story:slot2'] = 'new quicksave';
    await h.app.flush();
    const records = await h.vault.getAll('saves');
    assert.equal(records.length, 2, 'a storage-only change needs a new persisted snapshot');
    assert.ok(records.some(record => record.storage['persist:small-story:slot2'] === 'new quicksave'));
    await h.app.leavePlayer();
    await h.app.launch(game, version());
    first.options.onStorage({ stale: 'must be ignored' });
    first.options.onSnapshot(snapshot(999));
    await h.app.flush();
    const all = await h.vault.getAll('saves');
    assert.ok(!all.some(record => record.snapshot.state.stats.strength === 999));
    assert.ok(!all.some(record => record.storage.stale));
  } finally { await h.close(); }
});

test('choice debug toggle controls the active runtime without adding saves and keeps the session preference', async () => {
  const original=save(), h=await harness({saved:[original]});
  try{
    await h.app.handleAction('resume',original.id);
    const button=h.document.querySelector('#debug-choices');
    assert.equal(button.disabled,false);
    await clickAndWait(button,()=>button.getAttribute('aria-pressed')==='true');
    assert.equal(h.players[0].debugMode,true);
    await h.app.flush();
    assert.equal((await h.vault.getAll('saves')).length,1);
    await h.app.leavePlayer();await h.app.handleAction('resume',original.id);
    assert.equal(h.players[1].options.debugMode,true);
    h.players[1].setDebugMode=async()=>{throw new Error('Choice debugging is unavailable for this game engine.');};
    await clickAndWait(button,()=>!h.document.querySelector('#runtime-status').hidden);
    assert.match(h.document.querySelector('#runtime-status').textContent,/unavailable/);
    assert.equal(button.disabled,false);
    assert.equal(button.getAttribute('aria-pressed'),'true','a failed toggle retains the last working mode');
  }finally{await h.close();}
});

test('library menu opens existing import/restore controls, follows the selected game and closes on Escape or outside click', async()=>{
  const h=await harness({saved:[save()]});
  try{
    const menu=h.document.querySelector('#main-menu-toggle'),panel=h.document.querySelector('#main-menu');
    let pickedSave=0,restoredBackup=0;
    h.document.querySelector('#save-file').click=()=>{pickedSave++;};
    h.document.querySelector('#backup-file').click=()=>{restoredBackup++;};
    h.document.querySelector('#select-saves').click();
    assert.equal(h.document.querySelector('#import-save'),null);
    menu.click();assert.equal(menu.getAttribute('aria-expanded'),'true');assert.ok(panel.classList.contains('is-open'));
    assert.match(h.document.querySelector('#menu-game-context').textContent,/A Small Story/);
    h.document.querySelector('#menu-import-save').click();
    assert.equal(pickedSave,1);assert.equal(menu.getAttribute('aria-expanded'),'false');
    assert.ok(h.document.querySelector('#import-save'),'menu import exits bulk selection and restores the regular save controls');
    menu.click();h.document.querySelector('#restore-backup').click();
    assert.equal(restoredBackup,1);assert.equal(menu.getAttribute('aria-expanded'),'false');
    menu.click();
    const escape=new h.document.defaultView.Event('keydown',{bubbles:true,cancelable:true});escape.key='Escape';h.document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented,true);assert.equal(menu.getAttribute('aria-expanded'),'false');
    menu.click();h.document.querySelector('h1').click();assert.equal(menu.getAttribute('aria-expanded'),'false');
    const otherGame={...game,id:'other-game',title:'Another Story',activeVersionId:'other-version'};
    await h.vault.importVersion(otherGame,version('other-version',{gameId:otherGame.id}));await h.app.refresh();
    h.document.querySelector('[data-game="other-game"]').click();
    assert.equal(h.document.querySelector('#menu-game-context').textContent,'Into Another Story');
    menu.click();await clickAndWait(h.document.querySelector('#help'),()=>h.document.querySelector('#modal').open);
    assert.equal(menu.getAttribute('aria-expanded'),'false');
  }finally{await h.close();}
  const empty=await harness({installed:[]});
  try{assert.equal(empty.document.querySelector('#menu-import-save').disabled,true);assert.match(empty.document.querySelector('#menu-game-context').textContent,/Import a game first/);}
  finally{await empty.close();}
});

test('reader tools disclose save status and existing actions without creating snapshots', async()=>{
  const original=save(),h=await harness({saved:[original]});
  try{
    const mainMenu=h.document.querySelector('#main-menu-toggle'),tools=h.document.querySelector('#reader-menu-toggle');
    mainMenu.click();await h.app.handleAction('resume',original.id);
    assert.equal(mainMenu.getAttribute('aria-expanded'),'false');
    tools.click();assert.equal(tools.getAttribute('aria-expanded'),'true');
    assert.ok(h.document.querySelector('#reader-actions').classList.contains('is-open'));
    await h.app.flush();assert.equal((await h.vault.getAll('saves')).length,1);
    h.document.querySelector('#save-now').click();
    assert.equal(tools.getAttribute('aria-expanded'),'false');assert.equal(h.document.querySelector('#modal').open,true);
    h.document.querySelector('[data-close]').click();
    tools.click();await clickAndWait(h.document.querySelector('#debug-choices'),()=>tools.getAttribute('aria-expanded')==='false');
    assert.equal(h.players[0].debugMode,true);
    await h.app.leavePlayer();assert.equal(tools.getAttribute('aria-expanded'),'false');
    assert.equal((await h.vault.getAll('saves')).length,1);
  }finally{await h.close();}
});

test('resuming an autosave does not save again for key ordering, engine caches or restore metadata', async () => {
  const original = { ...save(), kind: 'auto' };
  const h = await harness({ saved: [original] });
  try {
    await h.app.handleAction('resume', original.id);
    const player = h.players[0];
    player.state.state.stats = { strength: 6, sceneName: 'chapter1' };
    player.state.state.version = 'engine-build-metadata';
    player.state.state.temps.choice_user_restored = true;
    player.state.capturedAt = '2026-10-17T12:00:00.000Z';
    player.state.preview = 'The restored page';
    delete player.state.checkpoint;
    player.values['persist:small-story:state'] = 'engine page cache';
    player.values['persist:small-story:statetemp'] = 'stats screen cache';
    player.values['persist:small-story:statebackup'] = 'engine backup cache';
    player.options.onSnapshot(structuredClone(player.state));
    await h.app.flush();
    await h.app.leavePlayer();
    assert.deepEqual(await h.vault.getAll('saves'), [original], 'opening/stats/closing must retain the original without making a duplicate');

    await h.app.handleAction('resume', original.id);
    const resumed = h.players[1];
    resumed.state.state.lineNum++;
    resumed.state.preview = 'A new choice awaits.';
    resumed.values['persist:small-story:state'] = 'new engine page cache';
    await h.app.flush();
    const records = await h.vault.getAll('saves');
    assert.equal(records.length, 2, 'a new story position must create a checkpoint');
    const automatic = records.find(record => record.id !== original.id);
    assert.equal(automatic.snapshot.preview, 'A new choice awaits.');
    assert.equal(automatic.storage['persist:small-story:state'], 'new engine page cache', 'engine caches are retained in real saves');
    await h.app.refresh();
    assert.match(h.document.querySelector('#detail').textContent, /A new choice awaits/);
    assert.match(h.document.querySelector('#detail').textContent, /line 7/);
    assert.equal(h.document.querySelector('.kind-auto .badge').textContent, 'Automatic');
  } finally { await h.close(); }
});

test('repeated capture and stats caches do not inflate history, while in-game save slots still persist', async () => {
  const h = await harness();
  try {
    await h.app.launch(game, version());
    await h.app.flush();
    const player = h.players[0];
    player.values['persist:small-story:statetemp'] = 'stats view';
    player.values['persist:small-story:state'] = 'same page in engine format';
    await h.app.flush();
    await h.app.flush();
    assert.equal((await h.vault.getAll('saves')).length, 1);
    player.values['persist:small-story:state_SAVE_1'] = 'a player-created quicksave';
    await h.app.flush();
    const records = await h.vault.getAll('saves');
    assert.equal(records.length, 2);
    assert.ok(records.some(record => record.storage['persist:small-story:state_SAVE_1'] === 'a player-created quicksave'));
  } finally { await h.close(); }
});

test('explicit named saves can keep identical moments without creating an extra autosave', async () => {
  const original = save(), h = await harness({ saved: [original] });
  try {
    await h.app.handleAction('resume', original.id);
    await h.app.enqueueSave(snapshot(), 'manual', 'First named copy');
    await h.app.enqueueSave(snapshot(), 'manual', 'Second named copy');
    await h.app.leavePlayer();
    const records = await h.vault.getAll('saves');
    assert.equal(records.length, 3);
    assert.ok(records.every(record => record.kind === 'manual'));
  } finally { await h.close(); }
});

test('plain continuation pages do not autosave on capture or close, but decisions and variable changes do', async () => {
  const original={...save(),kind:'auto'}, h=await harness({saved:[original]});
  try {
    await h.app.handleAction('resume',original.id);
    const player=h.players[0];
    player.state.transition='continue';
    player.state.state.lineNum=10;player.state.state.indent=2;
    await h.app.flush();
    player.state.state.lineNum=20;
    await h.app.flush();
    assert.equal((await h.vault.getAll('saves')).length,1);
    await h.app.leavePlayer();
    assert.equal((await h.vault.getAll('saves')).length,1,'closing must not turn a skipped Next page into an autosave');

    await h.app.handleAction('resume',original.id);
    const choice=h.players[1];
    choice.state.transition='choice';choice.state.state.lineNum=10;
    await h.app.flush();
    assert.equal((await h.vault.getAll('saves')).length,2,'a decision is saved even when only its story position changes');
    choice.state.transition='continue';choice.state.state.lineNum=20;
    choice.state.state.stats.strength=7;
    await h.app.flush();
    assert.equal((await h.vault.getAll('saves')).length,3,'real variable changes remain saved');
    choice.values['persist:small-story:state_SAVE_1']='a quicksave after Next';
    await h.app.flush();
    assert.equal((await h.vault.getAll('saves')).length,4,'in-game save slots remain saved');
  } finally {await h.close();}
});

test('save selection supports select all, cancel and a confirmed scoped batch deletion', async () => {
  const records=[save(),{...save(),id:'auto-save',kind:'auto'},{...save(),id:'edited-save',kind:'edited',name:'Edited copy'}];
  const h=await harness({saved:records});
  try {
    h.document.querySelector('#select-saves').click();
    const boxes=[...h.document.querySelectorAll('[data-save-select]')];
    boxes[0].checked=true;boxes[0].onchange();
    boxes[1].checked=true;boxes[1].onchange();
    assert.equal(h.document.querySelector('#save-selection-count').textContent,'2 selected');
    assert.equal(h.document.querySelector('#select-all-saves').indeterminate,true);
    h.document.querySelector('#delete-selected-saves').click();
    assert.equal(h.document.querySelector('.delete-save-list').children.length,2);
    h.document.querySelector('[data-close]').click();
    assert.equal((await h.vault.getAll('saves')).length,3,'Cancel must not delete');
    const selectedIds=boxes.slice(0,2).map(box=>box.dataset.saveSelect);
    h.document.querySelector('#delete-selected-saves').click();
    const deleteSaves=h.vault.deleteSaves;
    h.vault.deleteSaves=async()=>{throw new Error('Storage unavailable');};
    await h.document.querySelector('#delete-confirm').onclick();
    assert.equal(h.document.querySelector('#delete-error').textContent,'Storage unavailable');
    assert.equal(h.document.querySelector('#save-selection-count').textContent,'2 selected');
    assert.equal((await h.vault.getAll('saves')).length,3);
    assert.equal(h.document.querySelector('#delete-confirm').disabled,false);
    h.vault.deleteSaves=deleteSaves;
    await h.document.querySelector('#delete-confirm').onclick();
    const remaining=await h.vault.getAll('saves');
    assert.equal(remaining.length,1);
    assert.ok(!selectedIds.includes(remaining[0].id));
    assert.equal((await h.vault.getAll('versions')).length,1);
    assert.equal(h.document.querySelector('#save-selection-count'),null,'selection ends after deleting');

    h.document.querySelector('#select-saves').click();
    const all=h.document.querySelector('#select-all-saves');
    all.checked=true;all.dispatchEvent(new h.document.defaultView.Event('change'));
    assert.equal(h.document.querySelector('#save-selection-count').textContent,'1 selected');
    all.checked=false;all.dispatchEvent(new h.document.defaultView.Event('change'));
    assert.equal(h.document.querySelector('#delete-selected-saves').disabled,true);
    h.document.querySelector('#cancel-save-selection').click();
    assert.equal(h.document.querySelectorAll('[data-save-select]').length,0);
  } finally {await h.close();}
});

test('switching games clears save selection', async () => {
  const h=await harness({saved:[save()]});
  try {
    await h.vault.importVersion({...game,id:'other-game',title:'Other story',activeVersionId:'other-version'},version('other-version',{gameId:'other-game'}));
    await h.vault.putSave({...save(),id:'other-save',gameId:'other-game',versionId:'other-version'});
    await h.app.refresh();
    h.document.querySelector('#select-saves').click();
    const box=h.document.querySelector('[data-save-select]');box.checked=true;box.onchange();
    h.document.querySelector('[data-game="other-game"]').click();
    assert.equal(h.document.querySelectorAll('[data-save-select]').length,0);
    h.document.querySelector('#select-saves').click();
    assert.equal(h.document.querySelector('#save-selection-count').textContent,'0 selected');
    assert.equal(h.document.querySelector('[data-save-select]').dataset.saveSelect,'other-save');
  } finally {await h.close();}
});

test('app serializes overlapping player launches while the archive runtime prepares', async () => {
  let resolveRuntime;
  const gate = new Promise(resolve => { resolveRuntime = resolve; });
  const h = await harness({ runtimeFactory: async (options, players) => {
    const player = { options, capture: async () => snapshot(), dispose() {} };
    players.push(player);
    await gate;
    return player;
  } });
  try {
    const launch = h.app.launch(game, version());
    await h.app.launch({ ...game, title: 'A Different Game' }, version());
    assert.equal(h.players.length, 1);
    assert.equal(h.document.querySelector('#leave-player').disabled, true);
    resolveRuntime();
    await launch;
    assert.equal(h.app.getData().session.game.title, 'A Small Story');
  } finally { resolveRuntime(); await h.close(); }
});

test('app lists previous-version saves and creates a separate compatible updated copy', async () => {
  const original = save();
  const h = await harness({ installed: [version(), version('v2', { initialStats: { strength: 4, trust: 0 } })], saved: [original] });
  try {
    assert.match(h.document.querySelector('#detail').textContent, /Before the duel/);
    assert.match(h.document.querySelector('#detail').textContent, /Available on active version/);
    await h.app.handleAction('resume', original.id);
    await clickAndWait(h.document.querySelector('#resume-active'), () => h.players.length === 1);
    const records = await h.vault.getAll('saves');
    assert.equal(records.length, 2);
    const migrated = records.find(record => record.kind === 'migrated');
    assert.equal(migrated.versionId, 'v2');
    assert.equal(migrated.snapshot.state.stats.trust, 0);
    assert.deepEqual(records.find(record => record.id === original.id), original);
    assert.equal(h.players[0].options.version.id, 'v2');
    assert.equal(h.players[0].options.state.state.stats.strength, 6);
  } finally { await h.close(); }
});

test('app imports an APK update into the same game without moving or overwriting its saves', async () => {
  const original = save();
  const candidate = version('candidate-v2', { contentHash: 'new-version-fingerprint', storeName: 'a-renamed-storage-namespace', versionName: '2.0' });
  const h = await harness({ saved: [original], archiveCandidate: candidate });
  try {
    await h.app.importArchive(new File(['APK fixture'], 'story-v2.apk'), game.id);
    assert.equal(h.document.querySelector('#destination').value, game.id);
    // Linkedom does not implement the browser's implicit first-option selection.
    h.document.querySelector('#entry option').selected = true;
    await h.document.querySelector('#confirm-import').onclick();
    assert.equal(h.document.querySelector('#import-error')?.textContent || '', '');
    const installed = await h.vault.getAll('versions');
    assert.equal(installed.length, 2);
    const updated = installed.find(record => record.contentHash === candidate.contentHash);
    assert.equal(updated.gameId, game.id);
    assert.equal(updated.storeName, 'a-renamed-storage-namespace');
    assert.equal((await h.vault.get('games', game.id)).activeVersionId, updated.id);
    assert.deepEqual(await h.vault.get('saves', original.id), original);
    assert.match(h.document.querySelector('#detail').textContent, /Before the duel/);
  } finally { await h.close(); }
});

test('app blocks direct changed-chapter resume and offers the explicit chapter checkpoint', async () => {
  const h = await harness({ installed: [version(), version('v2', { sceneIndex: { chapter1: { hash: 'changed', crc: 456, lines: ['*label start', 'Updated story'], labels: { start: 0 } } } })], saved: [save()] });
  try {
    await h.app.handleAction('resume', 'original-save');
    assert.equal(h.document.querySelector('#resume-active'), null);
    assert.ok(h.document.querySelector('#resume-original'));
    assert.ok(h.document.querySelector('#restart-checkpoint'));
    await clickAndWait(h.document.querySelector('#restart-checkpoint'), () => h.players.length === 1);
    const checkpoint = (await h.vault.getAll('saves')).find(record => record.kind === 'checkpoint');
    assert.equal(checkpoint.versionId, 'v2');
    assert.equal(checkpoint.snapshot.state.lineNum, 0);
    assert.equal(h.players[0].options.state.state.stats.strength, 4);
  } finally { await h.close(); }
});

test('app save editor creates a copy and portable imports map to the installed content fingerprint', async () => {
  const original = save();
  const h = await harness({ saved: [original] });
  try {
    h.app.openEditor(original);
    h.document.querySelector('[data-variable="strength"]').value = '42';
    await h.document.querySelector('#edit-confirm').onclick();
    const edited = (await h.vault.getAll('saves')).find(record => record.kind === 'edited');
    assert.equal(edited.snapshot.state.stats.strength, 42);
    assert.deepEqual(await h.vault.get('saves', original.id), original);
    const portable = { format: 'story-vault-save', version: 1, source: { contentHash: version().contentHash }, save: { ...original, gameId: 'foreign-device-game-id', versionId: 'foreign-device-version-id' } };
    await h.app.importSave(new File([JSON.stringify(portable)], 'save.json'));
    const imported = (await h.vault.getAll('saves')).find(record => record.name.endsWith('(imported)'));
    assert.equal(imported.gameId, game.id);
    assert.equal(imported.versionId, 'v1');
    assert.notEqual(imported.id, original.id);
  } finally { await h.close(); }
});

test('app imports earlier raw saves and editor bundles after source confirmation and rejects changed scene CRCs', async () => {
  const originalVersion = version('v1', { storeName: 'small-story', sceneIndex: { chapter1: { hash: 'same', crc: 123, lines: Array(6).fill('Story text') } } });
  const h = await harness({ installed: [originalVersion] });
  const raw = { stats: { sceneName: 'chapter1', strength: 17 }, temps: { choice_crc: 123 }, lineNum: 5, indent: 0 };
  try {
    await h.app.importSave(new File([JSON.stringify(raw)], 'earlier-raw-save.json'));
    assert.equal(h.document.querySelector('#legacy-error').textContent, '');
    assert.equal(h.document.querySelector('#legacy-import').disabled, true);
    assert.equal((await h.vault.getAll('saves')).length, 0);
    h.document.querySelector('#legacy-confirm').checked = true;
    h.document.querySelector('#legacy-confirm').onchange();
    assert.equal(h.document.querySelector('#legacy-import').disabled, false);
    await h.document.querySelector('#legacy-import').onclick();
    let records = await h.vault.getAll('saves');
    assert.equal(records.length, 1);
    assert.equal(records[0].snapshot.state.stats.strength, 17);
    assert.equal(records[0].versionId, 'v1');

    const bundle = { format: 'choicescript-save-bundle-v1', game: 'small-story', items: [{ key: 'statesmall-story_SAVE_1', name: 'Earlier quicksave', data: JSON.stringify({ ...raw, stats: { ...raw.stats, strength: 23 } }) }] };
    await h.app.importSave(new File([JSON.stringify(bundle)], 'earlier-save-bundle.json'));
    assert.equal(h.document.querySelector('#legacy-error').textContent, '');
    h.document.querySelector('#legacy-confirm').checked = true;
    h.document.querySelector('#legacy-confirm').onchange();
    await h.document.querySelector('#legacy-import').onclick();
    records = await h.vault.getAll('saves');
    assert.equal(records.length, 2);
    assert.ok(records.some(record => record.name === 'Earlier quicksave' && record.snapshot.state.stats.strength === 23));

    await h.app.importSave(new File([JSON.stringify({ ...raw, temps: { choice_crc: 999 } })], 'changed-scene-save.json'));
    assert.match(h.document.querySelector('#legacy-error').textContent, /differs from the selected version/);
    h.document.querySelector('#legacy-confirm').checked = true;
    h.document.querySelector('#legacy-confirm').onchange();
    assert.equal(h.document.querySelector('#legacy-import').disabled, true);
    await h.document.querySelector('#legacy-import').onclick();
    assert.equal((await h.vault.getAll('saves')).length, 2, 'a failed CRC verification must perform no writes');
  } finally { await h.close(); }
});

test('iOS web explains Home Screen installation, backup transfer and persistence in storage and help', async () => {
  const h = await harness({ navigatorOverrides: { userAgent: 'Mozilla iPhone', storage: { persisted: async () => false, persist: async () => false, estimate: async () => ({ usage: 1024, quota: 4096 }) } } });
  try {
    assert.equal(h.document.querySelector('#ios-storage-help').hidden, false);
    h.document.querySelector('#ios-storage-steps').click();
    assert.match(h.document.querySelector('#modal-body').textContent, /Add to Home Screen/);
    assert.match(h.document.querySelector('#modal-body').textContent, /Restore backup/);
    await h.document.querySelector('#storage-info').onclick();
    assert.match(h.document.querySelector('#modal-body').textContent, /has not been confirmed/);
    assert.match(h.document.querySelector('#modal-body').textContent, /Add to Home Screen/);
    h.document.querySelector('#help').click();
    assert.match(h.document.querySelector('#modal-body').textContent, /Add to Home Screen/);
  } finally { await h.close(); }
});

test('installed iPad web apps retain storage instructions without the installation banner', async () => {
  const h = await harness({ navigatorOverrides: { platform: 'MacIntel', maxTouchPoints: 5, standalone: true, storage: { persisted: async () => true, persist: async () => { throw new Error('Already granted'); } } } });
  try {
    assert.equal(h.document.querySelector('#ios-storage-help').hidden, true);
    await h.document.querySelector('#storage-info').onclick();
    assert.match(h.document.querySelector('#modal-body').textContent, /Persistent storage is on/);
    assert.match(h.document.querySelector('#modal-body').textContent, /Add to Home Screen/);
  } finally { await h.close(); }
});

test('native storage UI describes durable storage and app deletion, without browser eviction warnings', async () => {
  const h = await harness({ native: true });
  try {
    assert.equal(h.document.querySelector('#ios-storage-help').hidden, true);
    assert.match(h.document.querySelector('#local-storage-note').textContent, /durable app storage/);
    await h.document.querySelector('#storage-info').onclick();
    const text = h.document.querySelector('#modal-body').textContent;
    assert.match(text, /durable app storage/);
    assert.match(text, /Deleting the app deletes/);
    assert.doesNotMatch(text, /browser may clear/);
  } finally { await h.close(); }
});
