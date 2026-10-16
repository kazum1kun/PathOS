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
async function harness({ installed = [version()], saved = [], runtimeFactory, archiveCandidate = version() } = {}) {
  const { window, document } = parseHTML(await readFile(new URL('public/index.html', root), 'utf8'));
  const previous = new Map();
  for (const [key, value] of Object.entries({ window, document, navigator: { storage: { persist: async () => true } }, location: { protocol: 'https:' } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const modal = document.querySelector('#modal');
  modal.showModal = () => { modal.open = true; };
  modal.close = () => { modal.open = false; };
  const vault = await storageModule.openVault({ indexedDB: new IDBFactory(), name: crypto.randomUUID() });
  for (const item of installed) await vault.importVersion({ ...game, activeVersionId: item.id }, item);
  for (const item of saved) await vault.putSave(item);
  const players = [];
  const createRuntime = async options => {
    if (runtimeFactory) return runtimeFactory(options, players);
    const player = {
      options, state: structuredClone(options.state || snapshot()), values: structuredClone(options.storage), disposed: false,
      capture: async () => { options.onStorage(structuredClone(player.values)); return structuredClone(player.state); },
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
