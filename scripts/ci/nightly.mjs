import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const tag = 'nightly';
const files = ['PathOS-unsigned.ipa', 'PathOS-web.zip'];
const checksumFile = 'SHA256SUMS';

function requireDefaultBranch(context) {
  const branch = context.payload.repository.default_branch;
  if (context.ref !== `refs/heads/${branch}`) {
    throw new Error(`Run Publish nightly from the default branch (${branch}).`);
  }
  return branch;
}

async function getNightly(github, repo) {
  let release;
  try {
    release = (await github.rest.repos.getReleaseByTag({...repo, tag})).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (!release.prerelease || release.immutable) {
    throw new Error('The nightly release must be an editable prerelease. Refusing to replace a stable or immutable release.');
  }
  return release;
}

export async function checkNightly({github, context, core, force = false}) {
  requireDefaultBranch(context);
  const release = await getNightly(github, context.repo);
  let build = true;
  if (!force && release && !release.draft &&
      [...files, checksumFile].every(name => release.assets.some(asset => asset.name === name))) {
    const commit = await github.rest.repos.getCommit({...context.repo, ref: tag});
    build = commit.data.sha !== context.sha;
  }
  core.setOutput('build', String(build));
  const message = build ? 'Building a new nightly.' : 'This commit is already published; skipping nightly builds.';
  core.info(message);
  await core.summary.addHeading('Nightly').addRaw(message).write();
  return build;
}

export async function publishNightly({github, context, core, directory}) {
  const branch = requireDefaultBranch(context);
  // Read both successful builds before making any changes to the release.
  const assets = await Promise.all(files.map(async name => ({name, data: await readFile(join(directory, name))})));
  const checksums = assets.map(({name, data}) => `${createHash('sha256').update(data).digest('hex')}  ${name}`).join('\n') + '\n';
  await writeFile(join(directory, checksumFile), checksums);
  assets.push({name: checksumFile, data: Buffer.from(checksums)});

  const repo = context.repo;
  const repoURL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo.owner}/${repo.repo}`;
  let release = await getNightly(github, repo);
  if (!release) {
    release = (await github.rest.repos.createRelease({
      ...repo, tag_name: tag, target_commitish: context.sha,
      name: 'Nightly', draft: true, prerelease: true, make_latest: 'false',
    })).data;
  }
  const previousAssets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo, release_id: release.id, per_page: 100,
  });
  for (const {name, data} of assets) {
    for (const previous of previousAssets.filter(asset => asset.name === name)) {
      await github.rest.repos.deleteReleaseAsset({...repo, asset_id: previous.id});
    }
    await github.rest.repos.uploadReleaseAsset({
      ...repo, release_id: release.id, name, data,
      headers: {'content-type': 'application/octet-stream', 'content-length': data.length},
    });
  }

  // Point the rolling tag at the actual build commit after all assets upload.
  const ref = `tags/${tag}`;
  let tagExists = true;
  try {
    await github.rest.git.getRef({...repo, ref});
  } catch (error) {
    if (error.status !== 404) throw error;
    tagExists = false;
  }
  if (tagExists) {
    await github.rest.git.updateRef({...repo, ref, sha: context.sha, force: true});
  } else {
    await github.rest.git.createRef({...repo, ref: `refs/${ref}`, sha: context.sha});
  }
  const body = [
    'Automated build from the latest successfully built default-branch commit.',
    '',
    `Commit: [${context.sha.slice(0, 12)}](${repoURL}/commit/${context.sha})`,
    `Branch: \`${branch}\``,
    `Build: [#${context.runNumber}](${repoURL}/actions/runs/${context.runId})`,
    `Published: ${new Date().toISOString()}`,
    '',
    '- **PathOS-unsigned.ipa**: sign with your sideloading tool before installing on an iPhone or iPad.',
    '- **PathOS-web.zip**: extract and serve over HTTPS.',
    '- **SHA256SUMS**: checksums for both downloads.',
    '',
    'This prerelease is updated in place when a new nightly build succeeds.',
  ].join('\n');
  const published = (await github.rest.repos.updateRelease({
    ...repo, release_id: release.id, tag_name: tag, target_commitish: context.sha,
    name: 'Nightly', body, draft: false, prerelease: true, make_latest: 'false',
  })).data;
  core.info(`Nightly published: ${published.html_url}`);
  await core.summary.addHeading('Nightly published').addLink('Download the nightly', published.html_url).write();
}
