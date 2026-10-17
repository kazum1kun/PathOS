import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const [configText, packageText, source, project, scene, storyboard] = await Promise.all([
  read('capacitor.config.json'), read('package.json'),
  read('ios/App/App/VaultBridgeViewController.swift'), read('ios/App/App.xcodeproj/project.pbxproj'),
  read('ios/App/App/SceneDelegate.swift'), read('ios/App/App/Base.lproj/Main.storyboard'),
]);
const config = JSON.parse(configText);
const pkg = JSON.parse(packageText);
assert.equal(config.webDir, '../dist');
assert.equal(config.appId, 'com.swsoftworks.pathos');
assert.equal(config.server.iosScheme, 'capacitor');
assert.equal(config.server.hostname, 'localhost');
assert.equal(config.server.url, undefined, 'The native release must bundle its assets.');
for (const dep of ['@capacitor/core', '@capacitor/ios']) assert.equal(pkg.dependencies[dep], '8.5.3');
const swiftPackage = await read('ios/App/CapApp-SPM/Package.swift');
assert.ok(swiftPackage.includes('exact: "8.5.3"'));
assert.equal(pkg.devDependencies['@capacitor/cli'], '8.5.3');
assert.ok(scene.includes('VaultBridgeViewController()'));
assert.ok(storyboard.includes('customClass="VaultBridgeViewController"'));
assert.equal((project.match(/VaultBridgeViewController.swift in Sources/g) || []).length, 2);
assert.equal((project.match(/VaultStore.swift in Sources/g) || []).length, 2);

// Execute the actual JS injected by Swift. This verifies promises, cancellation,
// failure handling and the frame/origin guard without pretending to compile Swift.
const script = source.match(/private static let exportScript = #"""\r?\n([\s\S]*?)\r?\n    """#/)[1];
const messages = [];
const storageMessages = [];
const top = {webkit: {messageHandlers: {pathosExport: {postMessage: (payload) => messages.push(payload)}, pathosStorage: {postMessage: payload => storageMessages.push(payload)}}}};
top.top = top;
const context = vm.createContext({window: top, location: {protocol: 'capacitor:', hostname: 'localhost', port: ''}});
new vm.Script(script).runInContext(context);
assert.equal(top.VaultNative.platform, 'ios');
const pending = top.VaultNative.exportFile({name: 'save.json', data: '{"scene":"startup"}'});
assert.equal(messages.length, 1);
assert.equal(messages[0].name, 'save.json');
assert.equal(messages[0].data, '{"scene":"startup"}');
top.VaultNative.__settle({id: messages[0].id, ok: true, result: {shared: false, cancelled: true}});
assert.equal((await pending).cancelled, true);
const failure = top.VaultNative.exportFile({name: 'save.json', data: '{}'});
top.VaultNative.__settle({id: messages[1].id, ok: false, error: 'Disk full'});
await assert.rejects(failure, /Disk full/);
await assert.rejects(top.VaultNative.exportFile({name: 'save.json', data: 123}), /text data/);
assert.equal(messages.length, 2);
for (const location of [{protocol: 'https:', hostname: 'example.com'}, {protocol: 'capacitor:', hostname: 'other'}, {protocol: 'capacitor:', hostname: 'localhost', port: '1234'}]) {
  const remote = {}; remote.top = remote;
  new vm.Script(script).runInContext(vm.createContext({window: remote, location}));
  assert.equal(remote.VaultNative, undefined);
}
const child = {top};
new vm.Script(script).runInContext(vm.createContext({window: child, location: {protocol: 'capacitor:', hostname: 'localhost', port: ''}}));
assert.equal(child.VaultNative, undefined);
const opened = top.VaultNative.storage({operation: 'open'});
assert.equal(storageMessages[0].operation, 'open');
top.VaultNative.__settle({id: storageMessages[0].id, ok: true, result: {migrated: true}});
assert.equal((await opened).migrated, true);
const storageFailure = top.VaultNative.storage({operation: 'commit', token: 'test'});
top.VaultNative.__settle({id: storageMessages[1].id, ok: false, error: 'Storage full'});
await assert.rejects(storageFailure, /Storage full/);
const missingTransport = top.webkit.messageHandlers.pathosStorage;
delete top.webkit.messageHandlers.pathosStorage;
await assert.rejects(top.VaultNative.storage({operation: 'open'}));
top.webkit.messageHandlers.pathosStorage = missingTransport;
console.log('Native project metadata and injected export/storage bridge checks passed. Swift compilation and device checks require Xcode on macOS.');

if (process.platform === 'darwin') {
  const result = spawnSync('bash', [fileURLToPath(new URL('test-storage.sh', import.meta.url))], {stdio: 'inherit', timeout: 60000});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Native SQLite/filesystem tests failed.');
}
