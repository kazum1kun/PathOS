import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {checkNightly, publishNightly} from '../scripts/ci/nightly.mjs';

const names = ['PathOS-unsigned.ipa', 'PathOS-web.zip', 'SHA256SUMS'];
const context = {
  repo: {owner: 'example', repo: 'PathOS'},
  payload: {repository: {default_branch: 'main'}},
  ref: 'refs/heads/main', sha: 'a'.repeat(40), runNumber: 42, runId: 123,
};
const error = status => Object.assign(new Error(`HTTP ${status}`), {status});
const release = overrides => ({
  id: 7, prerelease: true, draft: false,
  assets: names.map((name, index) => ({name, id: index + 1})), ...overrides,
});

function harness(options = {}) {
  const calls = [];
  const record = (name, handler) => async args => {
    calls.push({name, args});
    return handler(args);
  };
  const github = {
    rest: {
      repos: {
        getReleaseByTag: record('get-release', () => {
          if (options.releaseError) throw options.releaseError;
          if (!options.release) throw error(404);
          return {data: options.release};
        }),
        getCommit: record('get-commit', () => ({data: {sha: options.commit || context.sha}})),
        createRelease: record('create-release', () => ({data: release({draft: true})})),
        listReleaseAssets() {},
        deleteReleaseAsset: record('delete-asset', () => ({})),
        uploadReleaseAsset: record('upload-asset', () => {
          if (options.uploadError) throw options.uploadError;
          return {};
        }),
        updateRelease: record('publish-release', () => ({data: {html_url: 'https://github.com/example/PathOS/releases/tag/nightly'}})),
      },
      git: {
        getRef: record('get-tag', () => {
          if (!options.tagExists) throw error(404);
          return {data: {object: {sha: 'b'.repeat(40)}}};
        }),
        updateRef: record('move-tag', () => ({})),
        createRef: record('create-tag', () => ({})),
      },
    },
    paginate: async () => options.release?.assets || [],
  };
  const outputs = {};
  const summary = {addHeading() {return this;}, addRaw() {return this;}, addLink() {return this;}, async write() {}};
  return {github, context, calls, outputs, core: {
    setOutput: (name, value) => {outputs[name] = value;}, info() {}, summary,
  }};
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pathos-nightly-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const name of names.slice(0, 2)) await writeFile(join(directory, name), `test ${name}`);
  return directory;
}

test('nightly builds initially, on a new commit, or when release files are missing', async () => {
  for (const options of [{}, {release: release(), commit: 'b'.repeat(40)}, {release: release({assets: []})}]) {
    const state = harness(options);
    assert.equal(await checkNightly(state), true);
    assert.equal(state.outputs.build, 'true');
  }
});

test('nightly skips an already published commit unless a rebuild is requested', async () => {
  const state = harness({release: release()});
  assert.equal(await checkNightly(state), false);
  assert.equal(state.outputs.build, 'false');
  assert.equal(await checkNightly({...state, force: true}), true);
});

test('nightly lookup propagates authentication errors and protects stable or immutable releases', async () => {
  await assert.rejects(checkNightly(harness({releaseError: error(403)})), /HTTP 403/);
  for (const existing of [release({prerelease: false}), release({immutable: true})]) {
    const state = harness({release: existing});
    await assert.rejects(checkNightly(state), /editable prerelease/);
    assert.equal(state.calls.length, 1);
  }
});

test('nightly publishing is limited to the default branch', async t => {
  const state = harness();
  state.context = {...context, ref: 'refs/heads/feature'};
  await assert.rejects(checkNightly(state), /default branch/);
  await assert.rejects(publishNightly({...state, directory: await fixture(t)}), /default branch/);
  assert.equal(state.calls.length, 0);
});

test('first nightly uploads both builds and checksums before publishing the prerelease', async t => {
  const directory = await fixture(t);
  const state = harness();
  await publishNightly({...state, directory});
  const uploads = state.calls.filter(call => call.name === 'upload-asset');
  assert.deepEqual(uploads.map(call => call.args.name), names);
  const checksums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  for (const {args} of uploads.slice(0, 2)) {
    assert.ok(checksums.includes(`${createHash('sha256').update(args.data).digest('hex')}  ${args.name}`));
  }
  assert.equal(state.calls.find(call => call.name === 'create-release').args.draft, true);
  assert.equal(state.calls.find(call => call.name === 'create-tag').args.sha, context.sha);
  const final = state.calls.at(-1);
  assert.equal(final.name, 'publish-release');
  assert.equal(final.args.prerelease, true);
  assert.equal(final.args.draft, false);
  assert.equal(final.args.make_latest, 'false');
  assert.ok(final.args.body.includes(context.sha.slice(0, 12)));
});

test('subsequent nightlies replace matching assets and move the existing nightly tag', async t => {
  const state = harness({release: release({assets: [...release().assets, {id: 99, name: 'user-note.txt'}]}), tagExists: true});
  await publishNightly({...state, directory: await fixture(t)});
  assert.deepEqual(state.calls.filter(call => call.name === 'delete-asset').map(call => call.args.asset_id), [1, 2, 3]);
  const move = state.calls.find(call => call.name === 'move-tag');
  assert.deepEqual({...move.args}, {...context.repo, ref: 'tags/nightly', sha: context.sha, force: true});
  assert.equal(state.calls.some(call => call.name === 'create-release'), false);
});

test('missing build files prevent any GitHub release changes', async t => {
  const state = harness();
  const directory = await fixture(t);
  await rm(join(directory, 'PathOS-unsigned.ipa'));
  await assert.rejects(publishNightly({...state, directory}), /ENOENT/);
  assert.equal(state.calls.length, 0);
});

test('upload failure prevents moving the tag or publishing an incomplete first release', async t => {
  const state = harness({uploadError: error(503)});
  await assert.rejects(publishNightly({...state, directory: await fixture(t)}), /HTTP 503/);
  assert.equal(state.calls.some(call => ['move-tag', 'create-tag', 'publish-release'].includes(call.name)), false);
});
