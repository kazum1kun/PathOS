import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {syncGitHub} from '../scripts/ci/sync-github.mjs';

function git(directory, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', directory, ...args], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pathos-github-sync-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, {recursive: true, force: true});
  });
  git(root, 'init', '--initial-branch=main', 'source');
  git(root, 'init', '--bare', '--initial-branch=main', 'destination.git');
  const source = join(root, 'source'), destination = join(root, 'destination.git');
  const commit = message => {
    git(source, '-c', 'user.name=PathOS Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', message);
    return git(source, 'rev-parse', 'HEAD');
  };
  const first = commit('First');
  git(source, 'push', destination, 'refs/heads/main:refs/heads/main');
  git(destination, 'update-ref', 'refs/tags/nightly', first);
  return {source, destination, commit, first};
}

test('Forgejo sync updates main and preserves GitHub-only nightly tags without pushing local tags', async t => {
  const {source, destination, commit, first} = await fixture(t);
  const latest = commit('Second');
  git(source, '-c', 'user.name=PathOS Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'local-only', first, '-m', 'Must stay local');
  git(source, 'config', 'push.followTags', 'true');
  syncGitHub({directory: source, destination, token: 'test-token'});
  assert.equal(git(destination, 'rev-parse', 'refs/heads/main'), latest);
  assert.equal(git(destination, 'rev-parse', 'refs/tags/nightly'), first);
  assert.equal(git(destination, 'tag', '--list'), 'nightly');
  syncGitHub({directory: source, destination, token: 'test-token'});
  assert.equal(git(destination, 'rev-parse', 'refs/tags/nightly'), first);
});

test('Forgejo sync refuses to overwrite a diverged GitHub main and preserves its nightly tag', async t => {
  const {source, destination, commit, first} = await fixture(t);
  const githubCommit = commit('GitHub change');
  git(source, 'push', destination, 'refs/heads/main:refs/heads/main');
  git(source, 'checkout', '-B', 'main', first);
  commit('Different source change');
  assert.throws(() => syncGitHub({directory: source, destination, token: 'test-token'}), /sync failed/);
  assert.equal(git(destination, 'rev-parse', 'refs/heads/main'), githubCommit);
  assert.equal(git(destination, 'rev-parse', 'refs/tags/nightly'), first);
});

test('Forgejo sync gives setup instructions when the secret is missing', () => {
  assert.throws(() => syncGitHub({token: ''}), /Settings > Actions > Secrets/);
});
