import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

test('rebuilding removes obsolete assets from both the bundle and offline manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pathos-build-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(['scripts', 'src', 'public'].map(name => mkdir(join(root, name))));
  await writeFile(join(root, 'scripts/build.mjs'), await readFile(new URL('../scripts/build.mjs', import.meta.url)));
  await writeFile(join(root, 'src/obsolete.js'), 'old source');
  await writeFile(join(root, 'public/index.html'), '<title>PathOS fixture</title>');
  await writeFile(join(root, 'public/sw.js'), "const CACHE='pathos-__BUILD__';");
  const build = () => {
    const result = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  build();
  const before = await readFile(join(root, 'dist/sw.js'), 'utf8');
  assert.equal(await readFile(join(root, 'dist/src/obsolete.js'), 'utf8'), 'old source');
  await rm(join(root, 'src/obsolete.js'));
  await writeFile(join(root, 'src/current.js'), 'current source');
  build();
  await assert.rejects(readFile(join(root, 'dist/src/obsolete.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'dist/src/current.js'), 'utf8'), 'current source');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/asset-list.json'), 'utf8')).sort(), ['./index.html', './src/current.js']);
  assert.notEqual(await readFile(join(root, 'dist/sw.js'), 'utf8'), before, 'the new asset set gets a different offline cache');
});
