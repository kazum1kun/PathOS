import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../src/importer.js';

test('vendored JSZip initializes through the browser global branch and imports an archive', async () => {
  const archive = new globalThis.JSZip();
  archive.file('assets/index.html', '<html><head><title>Browser export</title><script>var storeName="browser_game";function SceneNavigator(){};allScenes={"startup":{"lines":["*title Browser export","Hello"],"labels":{},"crc":123}}</script></head><body></body></html>');
  const bytes = await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  // No module/exports/global/Buffer/process is supplied: this exercises the UMD
  // path used by <script type="module"> imports in the deployed browser app.
  const context = { console, TextDecoder, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob, crypto, setTimeout, clearTimeout };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(await readFile(new URL('../src/vendor/jszip.js', import.meta.url), 'utf8'), context);
  assert.equal(typeof context.JSZip?.loadAsync, 'function');
  const source = (await readFile(new URL('../src/importer.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=(?:async )?(?:function|class|const)\b)/g, '');
  vm.runInContext(source + '\nglobalThis.inspectArchive = inspectArchive;', context);
  const result = await context.inspectArchive(bytes, { filename: 'browser.apk' });
  assert.equal(result.candidates[0].title, 'Browser export');
  assert.equal(result.candidates[0].storeName, 'browser_game');
  assert.equal(result.candidates[0].sceneIndex.startup.lines[1], 'Hello');
  assert.equal(result.candidates[0].files[0].path, 'index.html');
});
