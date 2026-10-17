import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function syncGitHub({
  directory = process.cwd(),
  destination = 'https://github.com/kazum1kun/PathOS.git',
  token = process.env.GH_MIRROR_TOKEN,
} = {}) {
  if (!token) throw new Error('Add GH_MIRROR_TOKEN in Forgejo Settings > Actions > Secrets.');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const redact = text => String(text || '').split(token).join('[redacted]').split(basic).join('[redacted]');
  const result = spawnSync('git', [
    'push', '--no-follow-tags', destination, 'refs/heads/main:refs/heads/main',
  ], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      // Keep the credential out of the URL, process arguments and saved config.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0',
    },
  });
  if (result.error) throw new Error(`GitHub sync failed: ${redact(result.error.message)}`);
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`).trim();
  if (result.status !== 0) throw new Error(`GitHub sync failed. ${output}`);
  return output || 'GitHub main is up to date.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(syncGitHub()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
