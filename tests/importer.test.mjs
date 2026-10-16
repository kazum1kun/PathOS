import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectArchive, ARCHIVE_LIMITS, mimeForPath } from '../src/importer.js';

const scene = (lines, crc = 123) => ({ lines, crc, labels:{ intro:1 } });
function gameHTML({ title = 'A Small Story', store = 'small_story', score = 1, later = 'Next page', extra = '' } = {}) {
  return `<!doctype html><html><head><title>Fallback title</title><script>window.storeName = ${JSON.stringify(store)};window.version="1.0";allScenes = ${JSON.stringify({ startup:scene([`*title ${title}`, '*label intro', `*create score ${score}`, '*create enabled true', '*create name "Mira"', '*create ignored (1 + 2)', '*goto_scene chapter']), chapter:scene(['*label intro', later], 456) })};function SceneNavigator(){}${extra}</script></head><body>Game</body></html>`;
}
async function archive(files, compression = 'DEFLATE') {
  const zip = new globalThis.JSZip();
  for (const [path, data] of Object.entries(files)) zip.file(path, data, { createFolders:false });
  return zip.generateAsync({ type:'uint8array', compression });
}
const manifest = (version = '1.0') => `<manifest package="org.example.small" android:versionName="${version}" android:versionCode="4"><application android:label="A Small Story"></application></manifest>`;
const rejectsCode = (code) => error => error.code === code;

test('imports APK assets, scene index and literal defaults without executing game code', async () => {
  const bytes = await archive({ 'assets/index.html':gameHTML({ extra:'globalThis.importerMustNeverRun=true;' }), 'assets/pictures/scene.png':new Uint8Array([1,2,3]), 'classes.dex':'unrelated native code', 'AndroidManifest.xml':manifest() });
  const result = await inspectArchive(bytes, { filename:'game.apk' });
  assert.equal(result.candidates.length, 1);
  const game = result.candidates[0];
  assert.equal(game.rootPath, 'assets/');
  assert.equal(game.entryPath, 'index.html');
  assert.equal(game.title, 'A Small Story');
  assert.equal(game.storeName, 'small_story');
  assert.equal(game.packageName, 'org.example.small');
  assert.equal(game.versionName, '1.0');
  assert.equal(game.sceneIndex.startup.crc, 123);
  assert.equal(game.sceneIndex.startup.labels.intro, 1);
  assert.equal(game.sceneIndex.startup.hash.length, 64);
  assert.deepEqual({ ...game.initialStats }, { score:1, enabled:true, name:'Mira' });
  assert.equal(game.initializers.score, '*create score 1');
  assert.equal(game.unresolvedInitializers.ignored, '*create ignored (1 + 2)');
  assert.deepEqual(game.files.map(file => file.path), ['index.html', 'pictures/scene.png']);
  assert.equal(globalThis.importerMustNeverRun, undefined);
  assert.equal(game.contentHash.length, 64);
  assert.equal(game.engineHash.length, 64);
});

test('packaging and APK manifest version changes preserve content identity', async () => {
  const html = gameHTML();
  const first = (await inspectArchive(await archive({ 'assets/index.html':html, 'AndroidManifest.xml':manifest() }))).candidates[0];
  const second = (await inspectArchive(await archive({ 'assets/index.html':html, 'AndroidManifest.xml':manifest('2.0') }, 'STORE'))).candidates[0];
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.storeName, second.storeName);
  assert.equal(second.versionName, '2.0');
});

test('scene update changes relevant fingerprint and preserves engine fingerprint', async () => {
  const first = (await inspectArchive(await archive({ 'index.html':gameHTML() }))).candidates[0];
  const second = (await inspectArchive(await archive({ 'index.html':gameHTML({ later:'A revised page' }) }))).candidates[0];
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(first.engineHash, second.engineHash);
  assert.equal(first.sceneIndex.startup.hash, second.sceneIndex.startup.hash);
  assert.notEqual(first.sceneIndex.chapter.hash, second.sceneIndex.chapter.hash);
});

test('engine fingerprint includes dynamically loaded scripts and array initializers remain explicit', async () => {
  const html = gameHTML().replace('*create ignored (1 + 2)', '*create_array answers 3 0');
  const first = (await inspectArchive(await archive({ 'index.html':html, 'dynamic/engine.js':'function later() { return 1; }' }))).candidates[0];
  const second = (await inspectArchive(await archive({ 'index.html':html, 'dynamic/engine.js':'function later() { return 2; }' }))).candidates[0];
  assert.notEqual(first.engineHash, second.engineHash);
  assert.equal(first.unresolvedInitializers.answers, '*create_array answers 3 0');
  assert.equal(first.initializers.answers, '*create_array answers 3 0');
  assert.equal(first.initialStats.answers, undefined);
});

test('external engine and textual scenes under mygame preserve parent engine paths', async () => {
  const result = await inspectArchive(await archive({
    'project/mygame/index.html':'<html><head><title>Author &amp; Friends</title><script src="../engine.js"></script></head></html>',
    'project/engine.js':'window.storeName="authors_story";function SceneNavigator() {}',
    'project/mygame/scenes/startup.txt':'*title Author & Friends\r\n*create score 8\r\n*label start\r\nHello',
    'project/mygame/scenes/second.txt.json':JSON.stringify({ lines:['*label hello', 'Hello'], crc:789 }),
  }));
  const game = result.candidates[0];
  assert.equal(game.rootPath, 'project/');
  assert.equal(game.entryPath, 'mygame/index.html');
  assert.equal(game.storeName, 'authors_story');
  assert.equal(game.title, 'Author & Friends');
  assert.equal(game.initialStats.score, 8);
  assert.equal(game.sceneIndex.startup.labels.start, 2);
  assert.equal(game.sceneIndex.second.crc, 789);
  assert.ok(game.files.some(file => file.path === 'engine.js'));
});

test('multiple games produce distinct candidates and accept Blob input', async () => {
  const bytes = await archive({ 'one/index.html':gameHTML({ store:'first' }), 'two/index.html':gameHTML({ store:'second' }) });
  const result = await inspectArchive(new Blob([bytes]), { filename:'collection.zip' });
  assert.deepEqual(result.candidates.map(game => game.storeName), ['first', 'second']);
  assert.equal(result.filename, 'collection.zip');
});

test('unsupported APK and incomplete ZIP explain the problem', async () => {
  await assert.rejects(inspectArchive(await archive({ 'AndroidManifest.xml':manifest(), 'classes.dex':'native' })), rejectsCode('NO_CHOICESCRIPT_GAME'));
  await assert.rejects(inspectArchive(new Uint8Array([1,2,3])), rejectsCode('NOT_ZIP'));
});

test('traversal, absolute paths, backslashes and URL-encoded traversal are rejected before decompression', async () => {
  for (const path of ['../outside.html', '/absolute.html', 'foo\\index.html', 'assets/%2e%2e/escape.html']) {
    await assert.rejects(inspectArchive(await archive({ [path]:gameHTML() })), rejectsCode('UNSAFE_PATH'));
  }
});

test('declared expansion, entry count and suspicious compression are bounded', async () => {
  const normal = await archive({ 'index.html':gameHTML() });
  await assert.rejects(inspectArchive(normal, { limits:{ archiveBytes:10 } }), rejectsCode('ARCHIVE_TOO_LARGE'));
  await assert.rejects(inspectArchive(normal, { limits:{ entries:0 } }), rejectsCode('TOO_MANY_FILES'));
  await assert.rejects(inspectArchive(normal, { limits:{ entryBytes:10 } }), rejectsCode('ENTRY_TOO_LARGE'));
  await assert.rejects(inspectArchive(normal, { limits:{ expandedBytes:10 } }), rejectsCode('EXPANSION_LIMIT'));
  await assert.rejects(inspectArchive(await archive({ 'index.html':gameHTML(), 'bomb.txt':'0'.repeat(2 * 1024 * 1024) })), rejectsCode('SUSPICIOUS_COMPRESSION'));
  assert.equal(ARCHIVE_LIMITS.archiveBytes, 256 * 1024 * 1024);
});

test('forged small expansion size aborts the decompressor', async () => {
  const bytes = await archive({ 'index.html':gameHTML() });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 < bytes.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) { view.setUint32(offset + 24, 1, true); break; }
  }
  await assert.rejects(inspectArchive(bytes), rejectsCode('EXPANSION_LIMIT'));
});

test('CRC tampering, encryption flags and symlinks are rejected', async () => {
  for (const [kind, expected] of [['crc','CORRUPT_ZIP'], ['encrypted','ENCRYPTED_ZIP'], ['symlink','SYMLINK_UNSUPPORTED']]) {
    const bytes = await archive({ 'index.html':gameHTML() });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 46 < bytes.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      if (kind === 'crc') view.setUint32(offset + 16, 0, true);
      if (kind === 'encrypted') view.setUint16(offset + 8, 1, true);
      if (kind === 'symlink') view.setUint32(offset + 38, 0xa000 << 16, true);
      break;
    }
    await assert.rejects(inspectArchive(bytes), rejectsCode(expected));
  }
});

test('types assigned for assets used by the virtual filesystem', () => {
  assert.equal(mimeForPath('scenes/startup.txt'), 'text/plain');
  assert.equal(mimeForPath('images/hero.PNG'), 'image/png');
  assert.equal(mimeForPath('engine.js'), 'text/javascript');
});
