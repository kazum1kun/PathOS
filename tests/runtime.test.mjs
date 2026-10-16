import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeAssetPath, rewriteGameHTML, prepareRuntimeDocument, runtimeBootstrap, GAME_CSP } from '../src/runtime.js';

function sandbox(config = {}) {
  const messages = [], listeners = new Map(), timers = new Map(); let nextTimer = 0;
  class Element { setAttribute(name, value) { this[name] = value; } }
  const document = { querySelectorAll: () => [], addEventListener(name, fn) { const list = listeners.get('doc:' + name) || []; list.push(fn); listeners.set('doc:' + name, list); } };
  const parent = { postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); } };
  const context = {
    console, Event, EventTarget, Response, Blob, Uint8Array, TextDecoder, TextEncoder, Object, JSON,
    atob, btoa, parent, document, Element,
    setTimeout(fn, delay = 0) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    MutationObserver: class { observe() {} },
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`(${runtimeBootstrap.toString()})(${JSON.stringify({ token: 'token-test', files: {}, storage: {}, entryPath: 'index.html', ...config })})`, context);
  return {
    context, messages, parent,
    run(source) { return vm.runInContext(source, context); },
    flush(maxDelay = 200) {
      for (let round = 0; round < 100; round++) {
        const tasks = [...timers].filter(([, task]) => task.delay <= maxDelay);
        if (!tasks.length) return;
        for (const [id, task] of tasks) { if (!timers.has(id)) continue; timers.delete(id); task.fn(); }
      }
      throw new Error('Timer loop did not settle.');
    },
    message(type, payload, { source = parent, token = 'token-test', id = 1 } = {}) {
      for (const listener of listeners.get('message') || []) listener({ source, data: { channel: 'pathos-runtime-v1', token, type, payload, id } });
    }
  };
}

const miniEngine = `
window.storeName = 'test-game';
window.stats = {};
function Scene(name, stats, nav) {
 this.name = name; this.stats = stats; this.stats.scene = this; this.stats.sceneName = name;
 this.temps = { choice_crc: 123 }; this.lineNum = 0; this.indent = 0;
 this.crc = 123; this.lines = ['*set gold +10', 'Visible page', '*choice']; this.labels = {};
}
function computeCookie(stats, temps, lineNum, indent) {
 const scene = stats.scene; delete stats.scene;
 const result = JSON.stringify({ stats, temps, lineNum, indent }); stats.scene = scene; return result;
}
Scene.prototype.printLoop = function() { this.stats.gold = Number(this.stats.gold || 0) + 10; this.lineNum = 3; };
function clearScreen(fn) { fn(); }
function restoreGame(state, forcedScene, userRestored) {
 window.restoreArguments = [forcedScene, userRestored];
 window.stats = state.stats;
 const scene = new Scene(state.stats.sceneName, state.stats);
 scene.temps = state.temps; scene.lineNum = state.lineNum; scene.indent = state.indent;
 scene.printLoop();
}
window.__pathosFinishLoading();
`;

test('asset paths remain inside the imported root and network schemes are rejected', () => {
  assert.equal(normalizeAssetPath('../scenes/startup.txt', 'web/mygame/index.html'), 'web/scenes/startup.txt');
  assert.equal(normalizeAssetPath('../../outside', 'web/index.html'), null);
  assert.equal(normalizeAssetPath('file:///android_asset/scenes/startup.txt'), 'scenes/startup.txt');
  assert.equal(normalizeAssetPath('https://example.com/game.js'), null);
  assert.equal(normalizeAssetPath('//example.com/game.js'), null);
  assert.equal(normalizeAssetPath('scenes/a%20b.txt?v=1'), 'scenes/a b.txt');
});

test('HTML rewriting preserves inline engine strings and replaces asset tags', () => {
  const original = '<head><base href="https://remote/"><meta http-equiv="refresh" content="0;url=https://remote/"><script>const template = \'<img src="game.png">\';</script><script src="game.js"></script><link href="style.css"></head><body><img src="game.png"></body>';
  const output = rewriteGameHTML(original, value => 'blob:' + value);
  assert.ok(output.includes('const template = \'<img src="game.png">\';'));
  assert.ok(output.includes('<script src="blob:game.js">'));
  assert.ok(output.includes('<img src="blob:game.png">'));
  assert.ok(!output.includes('<base'));
  assert.ok(!output.includes('http-equiv="refresh"'));
});

test('prepared game document boots isolation before any game code', async () => {
  const result = await prepareRuntimeDocument({ entryPath: 'index.html', files: [
    { path: 'index.html', mime: 'text/html', data: '<!doctype html><html><head><script>window.gameRan=true;</script><script src="engine.js"></script></head><body><img src="image.png"></body></html>' },
    { path: 'engine.js', mime: 'text/javascript', data: 'window.engine=true;' },
    { path: 'image.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }
  ] }, { token: 'test-token', storage: { 'local:a': '</script><script>evil()</script>' } });
  try {
    assert.ok(result.html.indexOf('Content-Security-Policy') < result.html.indexOf('window.gameRan=true'));
    assert.ok(result.html.includes("connect-src 'none'"));
    assert.ok(result.html.includes("frame-src 'none'"));
    assert.ok(result.html.includes('\\u003c/script>'));
    assert.ok(result.html.includes('src="blob:'));
    assert.ok(!result.html.includes('src="engine.js"'));
    assert.ok(result.html.includes('__pathosFinishLoading();'));
    assert.ok(GAME_CSP.includes("form-action 'none'"));
  } finally { result.dispose(); }
});

test('isolated localStorage and Persist remain synchronous/asynchronous as expected', () => {
  const env = sandbox({ storage: { 'local:previous': 'value' }, state: { stats: { sceneName: 'chapter' }, temps: {}, lineNum: 4, indent: 0 } });
  env.run(`window.storeName='title'; window.store = new Persist.Store('title'); window.first=store.get('state'); localStorage.gold=20; localStorage.setItem('x','y'); store.set('achieved','x', function(ok) { window.callbackOK=ok; });`);
  assert.equal(env.context.localStorage.getItem('previous'), 'value');
  assert.equal(env.context.localStorage.gold, '20');
  assert.equal(env.context.localStorage.length, 3);
  assert.equal(JSON.parse(env.context.first).stats.sceneName, 'chapter');
  assert.equal(env.context.callbackOK, undefined);
  env.flush();
  assert.equal(env.context.callbackOK, true);
  const storage = env.messages.findLast(message => message.type === 'storage').payload;
  assert.equal(storage['persist:title:achieved'], 'x');
  assert.equal(storage['local:gold'], '20');
  env.run(`Persist = {type:'replaced'};`);
  assert.equal(env.context.Persist.type, 'pathos');
  assert.equal(env.context.Capacitor, undefined);
  assert.equal(env.context.webkit, undefined);
});

test('VFS fetch and XHR read local scene assets while network is unavailable', async () => {
  const env = sandbox({ entryPath: 'mygame/index.html', files: { 'mygame/scenes/startup.txt': { url: 'blob:scene', mime: 'text/plain', data: btoa('A bundled scene') } } });
  assert.equal(await (await env.context.fetch('scenes/startup.txt')).text(), 'A bundled scene');
  assert.equal((await env.context.fetch('https://external.example/')).status, 404);
  env.run(`window.xhr = new XMLHttpRequest(); xhr.open('GET','scenes/startup.txt',false); xhr.send();`);
  assert.equal(env.context.xhr.status, 200);
  assert.equal(env.context.xhr.responseText, 'A bundled scene');
  assert.ok(env.messages.some(message => message.type === 'status' && /network resource/.test(message.payload.message)));
});

test('snapshots preserve page-start state and restore without double applying page effects', () => {
  const env = sandbox(); env.run(miniEngine);
  env.run(`stats.gold=5; stats.scene = new Scene('chapter', stats); stats.scene.printLoop();`);
  env.flush();
  const captured = env.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(env.context.stats.gold, 15);
  assert.equal(captured.state.stats.gold, 5);
  assert.equal(captured.state.lineNum, 0);
  assert.equal(captured.checkpoint.atSceneStart, true);
  assert.equal(captured.scene.crc, 123);
  assert.deepEqual(captured.scene.lines, ['*set gold +10', 'Visible page', '*choice']);
  env.message('restore', captured); env.flush();
  assert.equal(env.context.stats.gold, 15);
  assert.deepEqual(Array.from(env.context.restoreArguments), [null, false]);
  env.message('capture', null, { id: 4 }); env.flush();
  const response = env.messages.findLast(message => message.type === 'result' && message.id === 4);
  assert.equal(response.payload.snapshot.state.stats.gold, 5);
  assert.ok(env.messages.some(message => message.type === 'status' && message.payload.level === 'ready'));
});

test('stats views cannot replace main progress; forged postMessages are ignored', () => {
  const env = sandbox(); env.run(miniEngine);
  env.run(`stats.gold=1; stats.scene = new Scene('chapter', stats); stats.scene.printLoop(); var other = new Scene('choicescript_stats', stats); other.secondaryMode='stats'; other.printLoop();`);
  env.flush();
  env.message('capture', null, { token: 'wrong', id: 66 });
  env.message('capture', null, { source: {}, id: 67 });
  assert.ok(!env.messages.some(message => message.id === 66 || message.id === 67));
  env.message('capture', null, { id: 68 });
  const captured = env.messages.find(message => message.id === 68).payload.snapshot;
  assert.equal(captured.scene.name, 'chapter');
  assert.equal(captured.state.stats.sceneName, 'chapter');
});

test('real APK ChoiceScript computeCookie and restoreGame integrate with boundary capture', { skip: !process.env.PATHOS_APK_HTML }, async () => {
  const source = await readFile(process.env.PATHOS_APK_HTML, 'utf8');
  const functionSource = name => {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' is present in real engine');
    // These engine functions contain no unbalanced braces in string literals.
    let braces = 0, begin = source.indexOf('{', start), at = begin;
    for (; at < source.length; at++) { if (source[at] === '{') braces++; else if (source[at] === '}' && --braces === 0) break; }
    return source.slice(start, at + 1);
  };
  const env = sandbox(); env.run(miniEngine);
  env.run(`var _global=window; var nav={}; var debug=false; var toJson=JSON.stringify; function isStateValid(s){return !!s?.stats?.sceneName;} function safeCall(self,fn){fn.call(self);} Scene.prototype.execute=function(){this.printLoop();};`);
  env.run(functionSource('computeCookie') + '\n' + functionSource('restoreGame'));
  env.run(`stats.gold=7; stats.scene=new Scene('chapter',stats); stats.scene.printLoop();`); env.flush();
  const saved = env.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(saved.state.stats.gold, 7);
  env.message('restore', saved); env.flush();
  assert.equal(env.context.stats.gold, 17);
  assert.equal(env.context.stats.scene.name, 'chapter');
});

test('an author export with no storeName restores the selected snapshot on first boot', () => {
  const selected = { state: { stats: { sceneName: 'chapter', gold: 42 }, temps: { choice_crc: 123 }, lineNum: 0, indent: 0 }, checkpoint: { atSceneStart: true, state: { stats: { sceneName: 'chapter', gold: 42 }, temps: { choice_crc: 123 }, lineNum: 0, indent: 0 }, scene: { name: 'chapter', crc: 123 } } };
  const env = sandbox({ state: selected });
  env.run(miniEngine.replace("window.storeName = 'test-game';", ''));
  assert.equal(env.context.storeName, undefined);
  // This is the standard engine's initStore()===false bootstrap path.
  env.run('restoreGame(null, null, false);'); env.flush();
  assert.equal(env.context.stats.gold, 52);
  assert.equal(env.context.stats.sceneName, 'chapter');
  const captured = env.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(captured.state.stats.gold, 42);
  assert.equal(captured.checkpoint.atSceneStart, true);
  // A later restart must remain a real restart, not silently replay the selected save.
  env.run(`window.restoreGame=function(state) { window.laterState=state; }; window.__pathosFinishLoading(); restoreGame(null);`);
  assert.equal(env.context.laterState, null);
});

test('malformed pre-head game tokens cannot precede runtime CSP or storage bootstrap', async () => {
  const result = await prepareRuntimeDocument({ entryPath: 'index.html', files: [
    { path: 'index.html', mime: 'text/html', data: '<!doctype html><script>window.beforeHeadRan=true; window.fetch("https://external.example/");</script><img src="https://external.example/pixel"><html><head><title>Malformed export</title></head><body>Game</body></html>' }
  ] }, { token: 'prehead-test' });
  try {
    assert.ok(result.html.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'));
    const firstScript = result.html.indexOf('<script>');
    const bootstrapAt = result.html.indexOf('(function runtimeBootstrap');
    const hostileAt = result.html.indexOf('window.beforeHeadRan=true');
    assert.equal(firstScript + '<script>'.length, bootstrapAt);
    assert.ok(bootstrapAt < hostileAt);
    assert.ok(result.html.indexOf('Content-Security-Policy') < hostileAt);
    assert.ok(!result.html.includes('src="https://external.example/pixel"'));
    assert.ok(result.html.includes('window.beforeHeadRan=true; window.fetch("https://external.example/");'));
  } finally { result.dispose(); }
});
