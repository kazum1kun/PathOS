import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

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

// Execute the actual JS injected by Swift. This verifies promises, cancellation,
// failure handling and the frame/origin guard without pretending to compile Swift.
const script = source.match(/private static let exportScript = #"""\n([\s\S]*?)\n    """#/)[1];
const messages = [];
const top = {webkit: {messageHandlers: {pathosExport: {postMessage: (payload) => messages.push(payload)}}}};
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
console.log('Native project metadata and injected export bridge checks passed. Swift compilation and device checks require Xcode on macOS.');
