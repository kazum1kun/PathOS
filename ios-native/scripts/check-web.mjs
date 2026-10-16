import {access, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
const webRoot = resolve(fileURLToPath(new URL('../', import.meta.url)), config.webDir);
try {
  await access(resolve(webRoot, 'index.html'));
} catch {
  console.error('Build the shared web app first: from the project root, run npm run build.');
  process.exit(1);
}
if (config.appId !== 'com.swsoftworks.pathos' || config.server?.iosScheme !== 'capacitor' || config.server?.hostname !== 'localhost') {
  console.error('Native app identity or origin changed. Restore the stable bundle ID and origin to keep existing libraries.');
  process.exit(1);
}
console.log(`Shared web bundle ready: ${webRoot}`);
