import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { normalizeAssetPath, rewriteGameHTML, prepareRuntimeDocument, runtimeBootstrap, createRuntime, GAME_CSP } from '../src/runtime.js';
import { inspectChoiceBlock } from '../src/choice-debug.js';
import { inspectArchive } from '../src/importer.js';
import { readerStyles } from '../src/settings.js';
import { createDemoArchive } from '../src/demo.js';

function sandbox(config = {}, domDocument = null, extensions = {}) {
  const messages = [], listeners = new Map(), timers = new Map(); let nextTimer = 0;
  class Element { setAttribute(name, value) { this[name] = value; } }
  const document = domDocument || parseHTML('<html><head></head><body></body></html>').document;
  if (!domDocument) document.addEventListener = (name, fn) => { const list = listeners.get('doc:' + name) || []; list.push(fn); listeners.set('doc:' + name, list); };
  const parent = { postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); } };
  const context = {
    console, Event, EventTarget, Response, Blob, Uint8Array, TextDecoder, TextEncoder, Object, JSON,
    atob, btoa, parent, document, Element,
    setTimeout(fn, delay = 0) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    MutationObserver: class { observe() {} },
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    ...extensions,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`(${runtimeBootstrap.toString()})(${JSON.stringify({ token: 'token-test', files: {}, storage: {}, entryPath: 'index.html', ...config })}, ${inspectChoiceBlock.toString()}, ${normalizeAssetPath.toString()})`, context);
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
    event(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
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

async function referenceEngineSandbox({ debugMode = true, stats = { gold: 5 }, lines = [], files = {}, sceneMap = null, sceneList = null, allScenes = null } = {}) {
  const [util, scene] = await Promise.all(['util.js', 'scene.js'].map(name => readFile(new URL(`./fixtures/choicescript/${name}`, import.meta.url), 'utf8')));
  const { document } = parseHTML('<html><head></head><body><div id="main"></div></body></html>');
  const env = sandbox({ debugMode, files }, document, { navigator: { userAgent: 'Test' }, location: { href: 'http://local/', protocol: 'http:' } });
  env.context.fixtureStats = stats;
  env.context.fixtureLines = lines;
  env.context.fixtureSceneMap = sceneMap;
  env.context.fixtureSceneList = sceneList;
  env.context.fixtureScenes = allScenes;
  env.run(util + '\n' + scene);
  env.run(`
    var toJson=JSON.stringify, jsonParse=JSON.parse;
    var stats=fixtureStats, storeName='reference-game', debug=false;
    var nav={startingStats:{},bugLog:[],products:{},_sceneMap:fixtureSceneMap,_sceneList:fixtureSceneList,getStartupScene:function(){return 'chapter';}};
    window.allScenes=fixtureScenes;
    var main=document.getElementById('main');
    function safeCall(self,fn){return fn.call(self);}
    function safeCallback(fn){return fn;}
    function safeTimeout(fn,ms){return setTimeout(fn,ms);}
    function trackEvent(){}
    function clearScreen(fn){main.textContent='';fn();}
    function printFooter(){}
    function printOptions(groups,options,callback){main.appendChild(document.createElement('form'));window.lastRenderedOptions=options;}
    Scene.prototype.paragraph=function(){};
    Scene.prototype.printLine=function(text){main.appendChild(document.createTextNode(text.trim()+' '));};
    Scene.prototype.execute=function(){if(!this.lines.length)this.loadLines(fixtureLines.join('\\n'));this.printLoop();};
    window.__pathosFinishLoading();
    var scene=new Scene('chapter',stats,nav);
    scene.loadLines(fixtureLines.join('\\n'));
  `);
  return env;
}

test('reader settings apply inside the isolated game and change without replaying or altering progress', () => {
  const { document } = parseHTML('<html><head></head><body><div id="main">A story.</div></body></html>');
  const initial = readerStyles({ theme: 'light', fontSize: 18 });
  const env = sandbox({ appearanceCSS: initial }, document);
  env.run(miniEngine); env.run("stats.gold=5;stats.scene=new Scene('chapter',stats);stats.scene.printLoop();"); env.flush();
  assert.equal(document.querySelector('#pathos-reader-settings').textContent, initial);
  const before = JSON.stringify(env.context.stats.gold), snapshots = env.messages.filter(message => message.type === 'snapshot').length;
  const changed = readerStyles({ theme: 'dark', fontFamily: 'sans', fontSize: 24 });
  env.message('appearance', { css: changed });
  assert.equal(document.querySelector('#pathos-reader-settings').textContent, changed);
  assert.equal(document.querySelectorAll('#pathos-reader-settings').length, 1);
  assert.equal(JSON.stringify(env.context.stats.gold), before);
  assert.equal(env.messages.filter(message => message.type === 'snapshot').length, snapshots);
  env.message('appearance', { css: '' });
  assert.equal(document.querySelector('#pathos-reader-settings').textContent, '');
});

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
    assert.ok(result.html.includes('src="data:text/javascript;charset=utf-8;base64,'));
    assert.ok(result.html.includes('<img src="data:image/png;base64,'));
    assert.ok(!result.html.includes('src="engine.js"'));
    assert.ok(result.html.includes('__pathosFinishLoading();'));
    assert.ok(GAME_CSP.includes("form-action 'none'"));
  } finally { result.dispose(); }
});

test('bundled scripts embed their original UTF-8 bytes and preserve classic script ordering', async () => {
  const source = '"use strict"; var label = "\u706f\u53f0 </script>"; function Scene() {}';
  const result = await prepareRuntimeDocument({ entryPath: 'index.html', files: [
    { path: 'index.html', mime: 'text/html', data: '<script src="engine.js"></script><script>Scene.started = label;</script>' },
    { path: 'engine.js', mime: 'text/javascript', data: new TextEncoder().encode(source) }
  ] });
  try {
    const url = result.html.match(/<script src="(data:text\/javascript;[^\"]+)"/)[1];
    assert.equal(await (await fetch(url)).text(), source);
    assert.ok(result.html.indexOf('<script src="' + url) < result.html.indexOf('Scene.started = label;'));
    assert.ok(!result.html.includes(source));
    assert.ok(result.html.includes("connect-src 'none'"));
  } finally { result.dispose(); }
});

test('bundled images embed their original bytes and MIME type for HTML and CSS in the opaque frame',async()=>{
  const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='),char=>char.charCodeAt(0));
  const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><text>灯</text></svg>');
  const prepared=await prepareRuntimeDocument({entryPath:'mygame/index.html',files:[
    {path:'mygame/index.html',mime:'text/html',data:'<link rel="stylesheet" href="style.css"><img src="stats_header.png?hash=123"><img src="mark.svg">'},
    {path:'mygame/style.css',mime:'text/css',data:'body{background-image:url("stats_header.png");}'},
    {path:'mygame/stats_header.png',mime:'image/png',data:png},
    {path:'mygame/mark.svg',data:svg},
  ]});
  try{
    const images=[...prepared.html.matchAll(/<img src="([^"]+)"/g)].map(match=>match[1]);
    assert.ok(images[0].startsWith('data:image/png;base64,'));assert.ok(images[1].startsWith('data:image/svg+xml;base64,'));
    assert.deepEqual(new Uint8Array(await (await fetch(images[0])).arrayBuffer()),png);
    assert.deepEqual(new Uint8Array(await (await fetch(images[1])).arrayBuffer()),svg);
    const stylesheet=prepared.html.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
    assert.ok((await (await fetch(stylesheet)).text()).includes(`url("${images[0]}")`));
    assert.ok(prepared.html.includes("img-src blob: data:"));assert.ok(prepared.html.includes("connect-src 'none'"));
  }finally{prepared.dispose();}
});

test('dynamic image source properties resolve bundled hashed paths while remote images stay blocked',()=>{
  class ImageElement {get src(){return this.assigned;}set src(value){this.assigned=value;}}
  const url='data:image/png;base64,aW1hZ2U=';
  const env=sandbox({entryPath:'mygame/index.html',files:{'mygame/stats_header.png':{url,mime:'image/png',data:'aW1hZ2U='}}},null,{HTMLImageElement:ImageElement});
  env.run('window.picture=new HTMLImageElement();picture.src="stats_header.png?hash=123";');
  assert.equal(env.context.picture.src,url);
  env.run('picture.src=picture.src;');assert.equal(env.context.picture.src,url,'resolved image URLs remain unchanged');
  env.run('picture.src="https://example.com/remote.png";');assert.equal(env.context.picture.src,'data:application/octet-stream,');
});

test('script errors identify the bundled asset and load failures are reported', () => {
  const env = sandbox({ files: { 'engine.js': { url: 'data:text/javascript;base64,ZW5naW5l', data: 'ZW5naW5l' } } });
  env.event('error', { message: 'Uncaught Error: startup failed', error: new Error('startup failed'), filename: 'data:text/javascript;base64,ZW5naW5l', lineno: 12 });
  env.event('error', { target: { tagName: 'SCRIPT', src: 'data:text/javascript;base64,ZW5naW5l' } });
  assert.ok(env.messages.some(message => message.payload?.message === 'Game error: startup failed (engine.js:12)'));
  assert.ok(env.messages.some(message => message.payload?.message === 'Could not load bundled game script: engine.js'));
});

test('stylesheets and their imports embed with rewritten local asset URLs', async () => {
  const result = await prepareRuntimeDocument({ entryPath: 'index.html', files: [
    { path: 'index.html', mime: 'text/html', data: '<link rel="stylesheet" href="style.css">' },
    { path: 'style.css', mime: 'text/css', data: '@import "theme.css"; body { background-image: url("cover.png"); }' },
    { path: 'theme.css', mime: 'text/css', data: 'body::before { content: "\u706f\u53f0"; }' },
    { path: 'cover.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }
  ] });
  try {
    const url = result.html.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
    assert.ok(url.startsWith('data:text/css;charset=utf-8;base64,'));
    const css = await (await fetch(url)).text();
    const theme = css.match(/@import "([^"]+)"/)[1];
    assert.equal(await (await fetch(theme)).text(), 'body::before { content: "\u706f\u53f0"; }');
    assert.match(css, /url\("data:image\/png;base64,/);
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
  for (const path of ['scenes/startup.txt', 'scenes/startup%2Etxt?v=1', '..\\mygame\\scenes\\startup.txt', 'file:///android_asset/mygame/scenes/startup.txt', 'blob:scene', { url: 'blob:scene' }]) {
    assert.equal(await (await env.context.fetch(path)).text(), 'A bundled scene');
  }
  for (const path of ['https://external.example/', '//external.example/', '../../outside.txt']) assert.equal((await env.context.fetch(path)).status, 404);
  env.run(`window.xhr = new XMLHttpRequest(); xhr.open('GET','scenes/startup.txt',false); xhr.send();`);
  assert.equal(env.context.xhr.status, 200);
  assert.equal(env.context.xhr.responseText, 'A bundled scene');
  assert.ok(env.messages.some(message => message.type === 'status' && /network resource/.test(message.payload.message)));
});

test('APK platform flags select the bundled engine browser fallbacks without native bridges', () => {
  const env = sandbox();
  env.run(`
    'use strict';
    window.isAndroidApp = true;
    window.isAmazonAndroidApp = true;
    window.isNookAndroidApp = true;
    window.isIosApp = true;
    window.isOmnibusApp = true;
    // Representative engine dispatch, including its asynchronous purchase result.
    function checkPurchase(callback) {
      if (window.isAndroidApp) androidBilling.checkPurchase('adfree');
      else if (window.isIosApp) webkit.messageHandlers.choicescript.postMessage('checkpurchase');
      else setTimeout(() => callback({adfree: false, billingSupported: false}), 0);
    }
    checkPurchase(value => { window.purchaseResult = value; });
    window.statsPath = window.isAndroidApp ? statsMode.get() : 'browser';
  `);
  assert.equal(env.context.purchaseResult, undefined);
  env.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(env.context.purchaseResult)), { adfree: false, billingSupported: false });
  assert.equal(env.context.statsPath, 'browser');
  for (const name of ['isAndroidApp', 'isAmazonAndroidApp', 'isNookAndroidApp', 'isIosApp', 'isOmnibusApp']) assert.equal(env.context[name], false);
  assert.equal(env.context.androidBilling, undefined);
  assert.equal(env.context.webkit, undefined);
});

test('APK content compatibility covers old imports while explicit ZIP exports keep their purchase behavior', async () => {
  const files = [{ path: 'index.html', data: '<p>Story</p>', mime: 'text/html' }];
  for (const [metadata, expected] of [
    [{ archiveFormat: 'apk' }, true], [{ filename: 'old-import.apk' }, true],
    [{ packageName: 'org.example.game' }, true], [{ archiveFormat: 'zip', filename: 'renamed.apk', packageName: 'org.example.game' }, false],
    [{ filename: 'author-export.zip' }, false],
  ]) {
    const prepared = await prepareRuntimeDocument({ entryPath: 'index.html', files, ...metadata });
    try { assert.ok(prepared.html.includes(`"apkContent":${expected}`)); } finally { prepared.dispose(); }
  }
});

test('APK purchase checks report complete bundled products asynchronously without billing or online scene caching', async () => {
  const env = sandbox({ apkContent: true, entryPath: 'mygame/index.html', files: {
    'mygame/scenes/chapter4.txt.json': { data: btoa('{"lines":["Paid chapter"]}'), mime: 'application/json' },
    'mygame/scenes/chapter5.txt': { data: btoa('Another paid chapter'), mime: 'text/plain' },
  } });
  env.run(`
    window.purchases={chapter4:'adfree',chapter5:'adfree',missing:'bonus','fake:tip':'tip'};
    window.purchaseSubscriptions={adfree:function(){window.subscribed=(window.subscribed||0)+1;window.subscriptionContext=this===window;}};
    function checkPurchase(){throw new Error('The web billing implementation must not run');}
    function isStoreSceneCacheRequired(){return true;}
    window.__pathosFinishLoading();
    checkPurchase('adfree bonus tip unknown',function(ok,result){window.purchaseOK=ok;window.purchaseResult=result;});
  `);
  assert.equal(env.context.purchaseResult, undefined);
  assert.equal(env.context.isStoreSceneCacheRequired(), false);
  env.flush();
  assert.equal(env.context.purchaseOK, 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(env.context.purchaseResult)), { adfree: true, bonus: false, tip: true, unknown: false, billingSupported: false });
  assert.equal(env.context.subscribed, 1);
  assert.equal(env.context.subscriptionContext, true, 'purchase subscriptions retain the engine callback context');
  assert.equal(env.context.knownPurchases, undefined, 'local content checks do not fabricate store receipts');
  assert.equal(env.context.androidBilling, undefined);
  assert.equal(env.context.isAndroidApp, false);
  assert.equal(await (await env.context.fetch('scenes/chapter4.txt.json')).text(), '{"lines":["Paid chapter"]}');
  env.run(`delete purchases.chapter5; purchases.missing='adfree'; checkPurchase('adfree',function(ok,result){window.incomplete=result.adfree;});`);
  env.flush(); assert.equal(env.context.incomplete, false, 'all mapped paid chapters are required');
});

test('compiled APK scenes and older base-game product checks work without changing ZIP billing', () => {
  for (const apkContent of [true, false]) {
    const env = sandbox({ apkContent });
    env.run(`
      window.allScenes={startup:{lines:['Story']},chapter:{lines:['Paid story']}};
      window.purchases={chapter:'bonus'};
      function checkPurchase(products,callback){callback('ok',{adfree:false,bonus:false,billingSupported:true});}
      function isStoreSceneCacheRequired(){return true;}
      window.__pathosFinishLoading();
      checkPurchase('adfree bonus',function(ok,result){window.purchaseResult=result;});
    `);
    env.flush();
    assert.equal(env.context.purchaseResult.adfree, apkContent);
    assert.equal(env.context.purchaseResult.bonus, apkContent);
    assert.equal(env.context.purchaseResult.billingSupported, !apkContent);
    assert.equal(env.context.isStoreSceneCacheRequired(), !apkContent);
  }
});

test('resuming an APK refreshes cached trial flags on a copy of the selected save', () => {
  const selected = { state: { stats: { sceneName: 'chapter', gold: 42 }, temps: {
    choice_crc: 123, choice_purchased_adfree: false, choice_purchased_bonus: true,
    choice_purchased_everything: false, choice_purchase_supported: true, choice_purchase_error: true,
  }, lineNum: 0, indent: 0 } };
  const env = sandbox({ apkContent: true, state: selected });
  env.run(`window.allScenes={startup:{lines:['Story']}};window.purchases={missing:'bonus'};`);
  env.run(miniEngine);
  env.run('restoreGame(null, null, false);'); env.flush();
  assert.equal(env.context.stats.scene.temps.choice_purchased_adfree, true);
  assert.equal(env.context.stats.scene.temps.choice_purchased_bonus, false);
  assert.equal(env.context.stats.scene.temps.choice_purchased_everything, false);
  assert.equal(env.context.stats.scene.temps.choice_purchase_supported, false);
  assert.equal(env.context.stats.scene.temps.choice_purchase_error, false);
  assert.equal(selected.state.temps.choice_purchased_adfree, false);
  assert.equal(selected.state.temps.choice_purchased_bonus, true);
  assert.equal(env.context.stats.gold, 52, 'the normal restore path still runs');
});

test('private APKs keep their actual declared purchase checks on bundled content', { skip: !process.env.PATHOS_CONTENT_APKS }, async () => {
  for (const filename of JSON.parse(process.env.PATHOS_CONTENT_APKS)) {
    const [version] = (await inspectArchive(new Uint8Array(await readFile(filename)), { filename })).candidates;
    const files = Object.fromEntries(version.files.map(file => [file.path, { data: Buffer.from(file.data).toString('base64'), mime: file.mime }]));
    const scripts = version.files.filter(file => /\.js$/.test(file.path)).map(file => new TextDecoder().decode(file.data));
    const purchases = JSON.parse(scripts.map(source => /\bpurchases\s*=\s*(\{[^}]*\})/.exec(source)?.[1]).find(Boolean));
    const check = scripts.map(source => /Scene\.prototype\.check_purchase\s*=\s*function[^\n]*\{[\s\S]*?\n\};/.exec(source)?.[0]).find(Boolean);
    const loader = scripts.map(source => /Scene\.prototype\.loadSceneFast\s*=\s*function[^\n]*\{[\s\S]*?\n\};/.exec(source)?.[0]).find(Boolean);
    assert.ok(check, 'the original engine purchase command is present');
    assert.ok(loader, 'the original paid chapter loader is present');
    const env = sandbox({ apkContent: true, entryPath: version.entryPath, files });
    env.context.purchases = purchases;
    env.run(`function Scene(){this.nav={products:{}};this.temps={};this.execute=function(){window.resumed=true;};}
      function checkPurchase(){throw new Error('Unexpected store access');}
      function isStoreSceneCacheRequired(){return true;}
      ${check}
      window.__pathosFinishLoading();window.scene=new Scene();`);
    const products = [...new Set(Object.values(purchases))];
    for (const product of products) env.context.scene.nav.products[product] = {};
    env.context.scene.check_purchase(products.join(' ')); env.flush();
    for (const product of products) assert.equal(env.context.scene.temps['choice_purchased_' + product], true, `${version.title}: ${product}`);
    assert.equal(env.context.scene.temps.choice_purchased_everything, true);
    assert.equal(env.context.scene.temps.choice_purchase_supported, false);
    assert.equal(env.context.resumed, true);
    assert.equal(env.context.isStoreSceneCacheRequired(), false);
    env.run(`${loader}
      Scene.baseUrl='scenes';window.location={protocol:'http:'};window.isWeb=true;var isIE=false;
      function startLoading(){}function doneLoading(){}
      function findXhr(){return new XMLHttpRequest();}function jsonParse(text){return JSON.parse(text);}
      function updateSinglePaidSceneCache(){throw new Error('Paid chapters must load from the APK, not the authenticated web cache');}
      Scene.prototype.loadLinesFast=function(crc,lines,labels){this.crc=crc;this.lines=lines;this.labels=labels;};`);
    for (const name of Object.keys(purchases).filter(name => !name.startsWith('fake:'))) {
      env.run(`window.chapter=new Scene();chapter.name=${JSON.stringify(name)};chapter.loadSceneFast();`); env.flush();
      assert.ok(env.context.chapter.lines?.length, `${version.title}: load paid chapter ${name}`);
      assert.equal(env.context.chapter.crc, version.sceneIndex[name.toLowerCase()].crc);
    }
  }
});

test('player permits local submit handlers while preventing form navigation and origin access', async () => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  const { window, document } = parseHTML('<div id="player"></div>');
  globalThis.window = window; globalThis.document = document;
  let runtime;
  try {
    runtime = await createRuntime({ container: document.getElementById('player'), version: {
      entryPath: 'index.html', files: [{ path: 'index.html', data: '<form><input name="name"><button>Next</button></form>', mime: 'text/html' }]
    } });
    const flags = runtime.iframe.getAttribute('sandbox').split(' ');
    assert.ok(flags.includes('allow-forms'));
    assert.ok(flags.includes('allow-scripts'));
    assert.ok(!flags.includes('allow-same-origin'));
    assert.ok(!flags.includes('allow-top-navigation'));
    assert.ok(runtime.iframe.srcdoc.includes("form-action 'none'"));
    assert.ok(runtime.iframe.srcdoc.includes("connect-src 'none'"));
  } finally {
    runtime?.dispose();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});

test('handled game inputs do not warn while unhandled form navigation is cancelled', () => {
  const env = sandbox();
  let prevented = 0;
  env.event('doc:submit', { defaultPrevented: true, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.ok(!env.messages.some(message => message.payload?.level === 'error'));
  env.event('doc:submit', { defaultPrevented: false, preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  assert.ok(env.messages.some(message => /Forms that navigate/.test(message.payload?.message)));
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
  assert.equal(captured.scene.lineCount, 3);
  assert.equal(captured.scene.lines, undefined, 'chapter source must not be copied into each save');
  const resumed = sandbox({ state: captured }); resumed.run(miniEngine);
  resumed.run('restoreGame(null, null, false);'); resumed.flush();
  assert.equal(resumed.context.stats.gold, 15);
  assert.deepEqual(Array.from(resumed.context.restoreArguments), [null, false]);
  resumed.message('capture', null, { id: 4 }); resumed.flush();
  const response = resumed.messages.findLast(message => message.type === 'result' && message.id === 4);
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

function liveVariables(env, id = 900) {
  env.message('variables', null, { id });
  return env.messages.findLast(message => message.id === id).payload;
}
function changeVariables(env, changes, current = liveVariables(env), id = 901) {
  env.message('editVariables', { scene: current.scene, revision: current.revision, changes }, { id });
  return env.messages.findLast(message => message.id === id).payload;
}

test('live variable listing reads the main scene while stats are open without saving or exposing engine internals', () => {
  const env = sandbox(); env.run(miniEngine);
  env.run(`stats.gold=5;stats.title='Ada';stats.ready=false;stats.choice_secret=12;stats.list=[1,2];stats.scene=new Scene('chapter',stats);stats.scene.temps.token=3;stats.scene.temps.param_1=99;stats.scene.temps._internal=true;stats.scene.printLoop();var mainScene=stats.scene;`);
  env.flush();
  const before = JSON.stringify(env.messages), current = liveVariables(env);
  assert.equal(current.scene, 'chapter');
  assert.deepEqual(current.variables.map(variable => [variable.scope, variable.name, variable.value]), [
    ['stats', 'gold', 15], ['stats', 'ready', false], ['stats', 'title', 'Ada'], ['temps', 'token', 3],
  ]);
  env.run(`var statsScreen=new Scene('choicescript_stats',stats);statsScreen.secondaryMode='stats';statsScreen.temps.token=88;statsScreen.printLoop();`);
  const opened = liveVariables(env, 902);
  assert.equal(opened.scene, 'chapter');
  assert.equal(opened.variables.find(variable => variable.scope === 'temps' && variable.name === 'token').value, 3);
  assert.equal(opened.revision, current.revision);
  assert.match(changeVariables(env, [{ scope: 'temps', name: 'token', before: 3, value: 9 }], opened).error, /Close the game’s stats or save screen/);
  assert.equal(env.context.mainScene.temps.token, 3);
  assert.equal(env.messages.filter(message => message.type === 'snapshot').length, JSON.parse(before).filter(message => message.type === 'snapshot').length);
  assert.equal(env.context.mainScene.lineNum, 3);
});

test('live edits apply typed stats and temps without replay and resume after the saved page effects', () => {
  const env = sandbox(); env.run(miniEngine);
  env.run(`stats.gold=5;stats.title='Ada';stats.ready=false;stats.scene=new Scene('chapter',stats);stats.scene.temps.token=3;stats.scene.printLoop();`);
  env.flush();
  const result = changeVariables(env, [
    { scope: 'stats', name: 'gold', before: 15, value: 42 },
    { scope: 'stats', name: 'title', before: 'Ada', value: 'Bea' },
    { scope: 'stats', name: 'ready', before: false, value: true },
    { scope: 'temps', name: 'token', before: 3, value: 8 },
  ]);
  env.flush();
  assert.equal(result.error, undefined);
  assert.equal(env.context.stats.gold, 42);
  assert.equal(env.context.stats.title, 'Bea');
  assert.equal(env.context.stats.ready, true);
  assert.equal(env.context.stats.scene.temps.token, 8);
  assert.equal(env.context.stats.scene.lineNum, 3, 'editing does not execute the page again');
  assert.equal(result.snapshot.state.stats.gold, 5, 'the replay boundary remains the original page start');
  assert.deepEqual(result.snapshot.liveEdits, { stats: { gold: 42, title: 'Bea', ready: true }, temps: { token: 8 } });
  const captured = env.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(captured.transition, 'edit');
  const resumed = sandbox({ state: captured }); resumed.run(miniEngine);
  resumed.run('restoreGame(null, null, false);'); resumed.flush();
  assert.equal(resumed.context.stats.gold, 42, 'restoring applies the edited value after the page adds ten');
  assert.equal(resumed.context.stats.title, 'Bea');
  assert.equal(resumed.context.stats.scene.temps.token, 8);
  assert.deepEqual(resumed.messages.findLast(message => message.type === 'snapshot').payload.liveEdits, captured.liveEdits);
  resumed.run('stats.scene.printLoop();'); resumed.flush();
  const next = resumed.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(next.state.stats.gold, 42);
  assert.equal(next.state.temps.token, 8);
  assert.equal(next.liveEdits, undefined, 'progression folds prior edits into the next page-start snapshot');
  assert.equal(resumed.context.stats.gold, 52);
});

test('live edits validate the whole request atomically and reject stale pages, values and forged requests', () => {
  const env = sandbox(); env.run(miniEngine);
  env.run(`stats.gold=5;stats.scene=new Scene('chapter',stats);stats.scene.printLoop();`); env.flush();
  const current = liveVariables(env);
  const valid = { scope: 'stats', name: 'gold', before: 15, value: 42 };
  for (const invalid of [
    { scope: 'stats', name: 'missing', before: 0, value: 1 },
    { scope: 'stats', name: 'sceneName', before: 'chapter', value: 'other' },
    { scope: 'temps', name: 'choice_crc', before: 123, value: 999 },
    { scope: 'stats', name: '__proto__', before: {}, value: {} },
    { scope: 'stats', name: 'gold', before: 15, value: '42' },
    { scope: 'stats', name: 'gold', before: 15, value: Infinity },
  ]) {
    const result = changeVariables(env, [valid, invalid], current);
    assert.equal(typeof result.error, 'string', JSON.stringify(invalid));
    assert.equal(env.context.stats.gold, 15, 'a later invalid edit prevents earlier edits too');
  }
  assert.match(changeVariables(env, [{ ...valid, before: 14 }], current).error, /has changed/);
  assert.match(changeVariables(env, [valid], { ...current, scene: 'other' }).error, /story has changed/);
  env.message('editVariables', { ...current, changes: [valid] }, { id: 912, source: {} });
  env.message('editVariables', { ...current, changes: [valid] }, { id: 913, token: 'wrong' });
  assert.equal(env.messages.some(message => message.id === 912 || message.id === 913), false);
  assert.equal(env.context.stats.gold, 15);
  assert.equal(changeVariables(env, [valid], current).error, undefined);
  assert.match(changeVariables(env, [{ ...valid, before: 42, value: 99 }], current).error, /story has changed/);
});

test('failed page capture blocks live edits instead of attaching them to the previous page snapshot', () => {
  const env = sandbox(); env.run(miniEngine);
  env.run(`stats.gold=5;stats.scene=new Scene('chapter',stats);stats.scene.printLoop();`); env.flush();
  const current = liveVariables(env);
  env.run(`computeCookie=function(){throw new Error('Capture failed');};stats.scene.printLoop();`); env.flush();
  assert.match(liveVariables(env).error, /Wait for the story page/);
  assert.match(changeVariables(env, [{ scope: 'stats', name: 'gold', before: 25, value: 42 }], current).error, /Wait for the story page/);
  env.message('capture', null, { id: 915 });
  assert.match(env.messages.findLast(message => message.id === 915).payload.error, /not reached a restorable page/);
  assert.equal(env.context.stats.gold, 25);
  assert.equal(env.messages.filter(message => message.type === 'snapshot').length, 1);
});

test('malformed saved live edits cannot change engine fields or partially apply valid entries', () => {
  const state = { state: { stats: { sceneName: 'chapter', gold: 5 }, temps: {}, lineNum: 0, indent: 0 }, scene: { name: 'chapter' } };
  for (const liveEdits of [
    { stats: { gold: 42, sceneName: 'other' } },
    { stats: { gold: 42 }, arbitrary: { gold: 99 } },
    { stats: { gold: '42' } },
  ]) {
    const env = sandbox({ state: { ...state, liveEdits } }); env.run(miniEngine);
    env.run('restoreGame(null, null, false);'); env.flush();
    assert.equal(env.context.stats.gold, 15);
    assert.equal(env.context.stats.sceneName, 'chapter');
    assert.ok(env.messages.some(message => /Could not restore live variable edits/.test(message.payload?.message)));
    assert.equal(env.messages.findLast(message => message.type === 'snapshot').payload.liveEdits, undefined);
  }
});

test('live variable edits refresh ordinary choice eligibility and debug predictions without executing story commands', async () => {
  const env = await referenceEngineSandbox({ stats: { gold: 5, ready: false }, lines: [
    '*choice', '  *if (ready) #Open gate', '    *set gold +100', '    *abort',
    '  *selectable_if (ready) #Join guard', '    *abort', '  #Wait', '    *abort',
  ] });
  env.run('scene.printLoop();'); env.flush();
  assert.deepEqual(Array.from(env.context.lastRenderedOptions, option => option.name), ['Join guard', 'Wait']);
  const before = env.context.scene.lineNum;
  const result = changeVariables(env, [{ scope: 'stats', name: 'ready', before: false, value: true }]); env.flush();
  assert.equal(result.error, undefined);
  assert.equal(result.notice, undefined);
  assert.deepEqual(Array.from(env.context.lastRenderedOptions, option => [option.name, !!option.unselectable]), [['Open gate', false], ['Join guard', false], ['Wait', false]]);
  const panel = env.context.document.querySelector('.pathos-choice-debug');
  assert.match(panel.textContent, /stats.ready = true/);
  assert.equal(env.context.stats.gold, 5);
  assert.equal(env.context.scene.lineNum, before);
  assert.equal(env.context.document.querySelectorAll('form').length, 1);
});

test('the bundled demo refreshes hidden and disabled options after live variable edits', async () => {
  const archive = await inspectArchive(await createDemoArchive());
  const html = new TextDecoder().decode(archive.candidates[0].files.find(file => file.path === 'index.html').data);
  const { document } = parseHTML(html), env = sandbox({}, document);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) env.run(script[1]);
  env.run('window.__pathosFinishLoading();window.onload();'); env.flush();
  assert.equal(document.querySelector('button').textContent, 'Climb the tower.');
  assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Take the cliff path.'), false);
  const result = changeVariables(env, [
    { scope: 'stats', name: 'courage', before: 50, value: 65 },
    { scope: 'stats', name: 'supplies', before: 3, value: 6 },
  ]); env.flush();
  assert.equal(result.error, undefined); assert.equal(result.notice, undefined);
  const buttons = [...document.querySelectorAll('form button')];
  assert.ok(buttons.some(button => button.textContent === 'Take the cliff path.' && !button.disabled));
  assert.ok(buttons.some(button => button.textContent === 'Hire a guide.' && !button.disabled));
  assert.equal(document.querySelectorAll('form').length, 1);
  assert.equal(env.context.stats.sceneName, 'startup');
  assert.equal(env.context.stats.courage, 65);
});

test('editing implicit control flow preserves the rendered menu exit behavior in debug predictions and selection', async () => {
  for (const initial of [false, true]) {
    const env = await referenceEngineSandbox({ stats: { gold: 5, implicit_control_flow: initial }, lines: [
      '*choice', '  #Test', '    A quiet moment.', '  #Sibling', '    *abort', '*set gold +100', '*abort',
    ] });
    env.run('scene.printLoop();'); env.flush();
    const result = changeVariables(env, [{ scope: 'stats', name: 'implicit_control_flow', before: initial, value: !initial }]); env.flush();
    assert.equal(result.error, undefined);
    assert.equal(result.notice, undefined);
    const effects = env.context.document.querySelector('.pathos-choice-effects').textContent;
    if (initial) assert.match(effects, /stats.gold: 5 → 105/);
    else assert.doesNotMatch(effects, /stats.gold|105/);
    env.context.document.querySelector('[aria-label="Choose Test"]').click(); env.flush();
    assert.equal(env.context.stats.gold, initial ? 105 : 5);
    assert.equal(env.messages.some(message => /illegal to fall out/.test(message.payload?.message)), !initial);
  }
});

test('snapshots describe the visible story page and stats cannot replace its preview', () => {
  const env = sandbox();
  env.run(miniEngine);
  env.run(`document.querySelector = () => ({innerText:'A light on the shore.\\nChoose your next path.'}); stats.scene = new Scene('chapter', stats); stats.scene.printLoop();`);
  env.flush();
  const original = env.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(original.preview, 'A light on the shore. Choose your next path.');
  env.run(`document.querySelector = () => ({innerText:'Strength: 10'}); var statsView = new Scene('choicescript_stats', stats); statsView.secondaryMode='stats'; statsView.printLoop();`);
  env.message('capture', null, { id: 77 });
  assert.equal(env.messages.findLast(message => message.id === 77).payload.snapshot.preview, original.preview);
});

test('page-break callbacks mark continuations while choices and text input mark decisions', () => {
  const env=sandbox();env.run(miniEngine);
  env.run(`
    window.printButton=function(label,target,isSubmit,callback){window.nextCallback=callback;};
    window.printOptions=function(groups,options,callback){window.choiceCallback=callback;};
    window.printInput=function(target,options,callback){window.inputCallback=callback;};
    Scene.prototype.page_break=function(label){printButton(label,null,false,()=>{this.lineNum++;this.printLoop();});};
    window.__pathosFinishLoading();
    stats.scene=new Scene('chapter',stats);stats.scene.printLoop();
    stats.scene.page_break('Continue reading');window.nextCallback();
  `);
  env.flush();
  assert.equal(env.messages.findLast(message=>message.type==='snapshot').payload.transition,'continue');
  env.run(`printOptions([],[],()=>{stats.scene.lineNum++;stats.scene.printLoop();});window.choiceCallback({});`);
  env.flush();
  assert.equal(env.messages.findLast(message=>message.type==='snapshot').payload.transition,'choice');
  env.run(`printInput(null,{},value=>{stats.name=value;stats.scene.lineNum++;stats.scene.printLoop();});window.inputCallback('Alex');`);
  env.flush();
  assert.equal(env.messages.findLast(message=>message.type==='snapshot').payload.transition,'choice');
  assert.equal(env.messages.findLast(message=>message.type==='snapshot').payload.state.stats.name,'Alex');
});

const debugChoiceSource = ['*fake_choice', '  *if (strong) #Hidden path', '    hidden outcome', '  *selectable_if (ready) #Guarded path', '    guarded outcome', '  #Open path', '    open outcome', 'Afterwards'];
const debugChoiceEngine = `
  window.stats={strong:false,ready:false};window.main=document.getElementById('main');
  function Scene(){this.name='chapter';this.stats=stats;stats.scene=this;stats.sceneName=this.name;this.lines=${JSON.stringify(debugChoiceSource)};this.temps={choice_reuse:'allow',_fakeChoiceDepth:1,_choiceEnds:{}};this.lineNum=0;this.indent=0;}
  Scene.prototype.getIndent=function(line){this.checkedIndent=true;return /^\\s*/.exec(line||'')[0].length;};
  Scene.prototype.tokenizeExpr=function(value){return value;};
  Scene.prototype.evaluateExpr=function(value){return this.getVar(value);};
  Scene.prototype.replaceVariables=function(value){return value;};
  Scene.prototype.getVar=function(value){return this.stats[value]||false;};
  Scene.prototype.parseOptions=function(){if(window.syntaxError)throw new Error('Invalid indent');if(window.emptyMenu)throw new Error('No selectable options');this.lineNum=6;return [{name:'Guarded path',line:4,unselectable:true},{name:'Open path',line:6}];};
  window.printOptions=function(groups,options,callback){var form=document.createElement('form');main.appendChild(form);options.forEach(option=>{var button=document.createElement('button');button.textContent=option.name;button.disabled=!!option.unselectable;button.onclick=()=>callback(option);form.appendChild(button);});var next=document.createElement('button');next.id='original-next';next.textContent='Next';main.appendChild(next);};
  Scene.prototype.renderOptions=function(groups,options,callback){printOptions(groups,options,callback);};
  Scene.prototype.choice=function(){var start=this.lineNum,options=this.parseOptions(0,['']);this.renderOptions([''],options,option=>this.standardResolution(option));this.lineNum=start;};
  Scene.prototype.standardResolution=function(option){this.lineNum=option.line;this.printLoop();};
  Scene.prototype.printLoop=function(){main.textContent='';if(this.lineNum===0){this.choice('');}else{this.stats.outcome=this.lines[this.lineNum].trim();main.textContent=this.stats.outcome;}};
  function computeCookie(stats,temps,lineNum,indent){var clean={...stats};delete clean.scene;return JSON.stringify({stats:clean,temps,lineNum,indent});}
  window.__pathosFinishLoading();stats.scene=new Scene();stats.scene.printLoop();
`;

test('debug mode reveals conditions and force-selects a hidden option through the engine without changing eligibility', () => {
  const {document}=parseHTML('<main id="main"></main>'), env=sandbox({},document);
  env.run(debugChoiceEngine);env.flush();
  const initial=JSON.parse(JSON.stringify(env.context.stats.scene.temps)), form=document.querySelector('form');
  assert.equal(document.querySelector('.pathos-choice-debug'),null);
  env.message('debug',{enabled:true},{source:{},id:100});
  assert.equal(document.querySelector('.pathos-choice-debug'),null,'other windows cannot enable debugging');
  env.message('debug',{enabled:true},{id:101});
  const panel=document.querySelector('.pathos-choice-debug');
  assert.match(panel.textContent,/\*if strong → false/);
  assert.match(panel.textContent,/\*selectable_if ready → false/);
  assert.match(panel.textContent,/stats.strong = false/);
  assert.match(panel.textContent,/stats.ready = false/);
  assert.equal(panel.querySelectorAll('[data-availability="hidden"]').length,1);
  assert.equal(panel.querySelectorAll('[data-availability="disabled"]').length,1);
  assert.equal(form.style.display,'none');
  assert.equal(document.getElementById('original-next').style.display,'none','submit controls outside the form are hidden too');
  assert.equal(env.context.stats.scene.lineNum,0);
  assert.equal(env.context.stats.scene.checkedIndent,undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(env.context.stats.scene.temps)),initial);
  env.message('debug',{enabled:false},{id:102});
  assert.equal(document.querySelector('.pathos-choice-debug'),null);
  assert.notEqual(form.style.display,'none');
  assert.notEqual(document.getElementById('original-next').style.display,'none');
  env.message('debug',{enabled:true},{id:103});
  document.querySelector('[aria-label="Force-select Hidden path"]').click();env.flush();
  assert.equal(env.context.stats.outcome,'hidden outcome');
  assert.equal(env.context.stats.strong,false,'forcing chooses the body without granting the condition');
  assert.equal(env.context.stats.scene.temps._choiceEnds[3],6,'hidden fake-choice exits skip the other option bodies');
  assert.equal(document.querySelector('.pathos-choice-debug'),null,'old force buttons are removed after progression');
  const saved=env.messages.findLast(message=>message.type==='snapshot').payload;
  assert.equal(saved.transition,'choice');assert.equal(saved.state.lineNum,2);
});

test('choice debugger keeps effects concise and exposes original script and context on demand', () => {
  const { document } = parseHTML('<main id="main"></main>'), env = sandbox({ debugMode: true }, document);
  const lines = [...debugChoiceSource];
  lines[2] = '    *set strength + 5';
  lines[4] = '    *set label "<img src=x onerror=alert(1)>"';
  lines[6] = '    *gosub reward';
  env.run(debugChoiceEngine
    .replace(JSON.stringify(debugChoiceSource), JSON.stringify(lines))
    .replace('strong:false,ready:false', 'strong:false,ready:false,strength:10,label:"before"')
    .replace('return this.getVar(value);', 'if(value==="strength + 5")return this.getVar("strength")+5;if(value.startsWith(\'"\'))return JSON.parse(value);return this.getVar(value);'));
  env.flush();
  const panel = document.querySelector('.pathos-choice-debug');
  assert.match(panel.textContent, /Checks/);
  assert.match(panel.textContent, /Selection effects/);
  assert.match(panel.textContent, /stats.strength: 10 → 15 \(\+5\)/);
  assert.match(panel.textContent, /stats.label: "before" → "<img src=x onerror=alert\(1\)>"/);
  assert.match(panel.textContent, /Call: reward/);
  assert.match(panel.textContent, /No checks\./);
  assert.doesNotMatch(panel.textContent, /Preview stops|not predicted|invalid game state|eligibility checks/);
  const effects = [...panel.querySelectorAll('.pathos-choice-effects')].map(node => node.textContent).join('\n');
  assert.doesNotMatch(effects, /\*set|\*gosub|line \d+/);
  const source = panel.querySelector('.pathos-choice-source');
  assert.equal(source.hasAttribute('open'), false);
  assert.equal(source.querySelector('pre'), null, 'source is loaded when expanded');
  source.open = true; source.dispatchEvent(new document.defaultView.Event('toggle'));
  assert.match(source.querySelector('pre').textContent, /1 │ \*fake_choice/);
  assert.match(source.querySelector('pre').textContent, /\*if \(strong\) #Hidden path/);
  assert.match(source.querySelector('pre').textContent, /\*set strength \+ 5/);
  assert.equal(source.querySelectorAll('.source-option').length, 2, 'the selected header and body stand out from their context');
  const guardedSource = panel.querySelectorAll('.pathos-choice-source')[1];
  guardedSource.open = true; guardedSource.dispatchEvent(new document.defaultView.Event('toggle'));
  assert.match(guardedSource.querySelector('pre').textContent, /<img src=x onerror=alert\(1\)>/);
  source.open = false; source.dispatchEvent(new document.defaultView.Event('toggle'));
  source.open = true; source.dispatchEvent(new document.defaultView.Event('toggle'));
  assert.equal(source.querySelectorAll('pre').length, 1);
  assert.equal(panel.querySelector('img'), null);
  assert.equal(env.context.stats.strength, 10);
  assert.equal(env.context.stats.label, 'before');
  assert.equal(env.context.stats.scene.lineNum, 0);
});

test('choice debugger presents random ranges and dependent branch probabilities without source clutter', () => {
  const { document } = parseHTML('<main id="main"></main>'), env = sandbox({ debugMode: true }, document);
  const source = ['*fake_choice', '  #Roll', '    *rand roll 1 6', '    *if roll <= 2', '      *set strength + 5', '    *else', '      *set strength - 3', '  #Read', '    A quiet moment.'];
  env.run(debugChoiceEngine
    .replace(JSON.stringify(debugChoiceSource), JSON.stringify(source))
    .replace('strong:false,ready:false', 'strong:false,ready:false,strength:10,roll:0')
    .replace("[{name:'Guarded path',line:4,unselectable:true},{name:'Open path',line:6}]", "[{name:'Roll',line:2},{name:'Read',line:8}]")
    .replace('return this.getVar(value);', 'if(/^\\d+$/.test(value))return Number(value);if(value==="roll <= 2")return this.getVar("roll")<=2;if(value==="strength + 5")return this.getVar("strength")+5;if(value==="strength - 3")return this.getVar("strength")-3;return this.getVar(value);'));
  env.flush();
  const panel = document.querySelector('.pathos-choice-debug'), effects = panel.querySelector('.pathos-choice-effects');
  assert.match(effects.textContent, /stats.roll: 0 → 1–6 \(random integer\)/);
  assert.match(effects.textContent, /33\.33% chance · stats.strength: 10 → 15 \(\+5\)/);
  assert.match(effects.textContent, /66\.67% chance · stats.strength: 10 → 7 \(-3\)/);
  assert.doesNotMatch(effects.textContent, /\*rand|\*set|line \d+/);
  assert.match(panel.querySelectorAll('.pathos-choice-effects')[1].textContent, /^No effects\.$/);
  assert.equal(env.context.stats.roll, 0);
  assert.equal(env.context.stats.strength, 10);
});

test('debug lookahead reads bundled plain, JSON, and embedded chapters without running loaders or changing progress', async () => {
  const nextLines = [
    '*temp token 2', '*set gold +3', 'The next chapter.', '*page_break', '*fake_choice',
    '  #Look', '    The view is clear.', '  #Listen', '    The wind is quiet.',
    '*set gold +token', '*choice', '  #Spend', '    *set gold +100', '    *abort', '  #Save', '    *abort'
  ];
  for (const format of ['plain', 'json', 'embedded']) {
    const data = format === 'json' ? JSON.stringify({ lines: nextLines, labels: {} }) : nextLines.join('\r\n');
    const files = format === 'embedded' ? {} : { ['SCENES/CHAPTER2.TXT' + (format === 'json' ? '.JSON' : '')]: { url: 'blob:chapter2', data: Buffer.from(data).toString('base64') } };
    const env = await referenceEngineSandbox({ debugMode: false, files, allScenes: format === 'embedded' ? { CHAPTER2: { lines: nextLines } } : null, lines: [
      '*choice', '  #Travel', '    *set gold +1', '    *goto_scene chapter2', '  #Wait', '    *abort'
    ] });
    env.run('scene.printLoop();'); env.flush();
    const before = env.run('JSON.stringify({stats:{...stats,scene:null},temps:scene.temps,lineNum:scene.lineNum,indent:scene.indent,bugLog:nav.bugLog})');
    const published = env.messages.filter(message => ['snapshot', 'storage'].includes(message.type)).length;
    env.run('Scene.prototype.loadScene=function(){throw new Error("Preview ran a scene loader");};Math.random=function(){throw new Error("Preview drew randomness");};');
    env.message('debug', { enabled: true }); env.flush();
    const panel = env.context.document.querySelector('.pathos-choice-debug'), effects = panel.querySelector('.pathos-choice-effects').textContent;
    assert.match(panel.textContent, /Looks ahead through pages, jumps, and harmless fake choices/);
    assert.match(effects, /stats.gold: 5 → 6 \(\+1\)/, format);
    assert.match(effects, /Chapter: chapter2/, format);
    assert.match(effects, /stats.gold: 6 → 9 \(\+3\)/, format);
    assert.match(effects, /stats.gold: 9 → 11 \(\+2\)/, format);
    assert.doesNotMatch(effects, /111|\+100/, 'another meaningful choice is a lookahead boundary');
    assert.equal(env.run('JSON.stringify({stats:{...stats,scene:null},temps:scene.temps,lineNum:scene.lineNum,indent:scene.indent,bugLog:nav.bugLog})'), before, format);
    assert.equal(env.messages.filter(message => ['snapshot', 'storage'].includes(message.type)).length, published, format);
    assert.deepEqual(env.messages.filter(message => message.type === 'status' && message.payload.level === 'error'), [], format);
  }
});

test('debug lookahead derives finish destinations from navigator data without invoking navigation methods', async () => {
  for (const navigation of [{ sceneMap: { chapter: 'chapter2' } }, { sceneList: ['chapter', 'chapter2'] }]) {
    const env = await referenceEngineSandbox({ ...navigation, allScenes: { chapter2: { lines: ['*set gold +3', '*abort'] } }, lines: [
      '*choice', '  #Continue', '    *finish', '  #Wait', '    *abort'
    ] });
    env.run('nav.nextSceneName=function(){throw new Error("Preview invoked navigation");};scene.printLoop();'); env.flush();
    const effects = env.context.document.querySelector('.pathos-choice-effects').textContent;
    assert.match(effects, /Chapter: chapter2/);
    assert.match(effects, /stats.gold: 5 → 8 \(\+3\)/);
    assert.equal(env.context.stats.gold, 5);
    assert.equal(env.context.stats.sceneName, 'chapter');
    assert.deepEqual(env.messages.filter(message => message.type === 'status' && message.payload.level === 'error'), []);
  }
});

test('debug lookahead leaves unavailable or invalid bundled chapter sources as partial previews', async () => {
  for (const data of [null, '{broken JSON', JSON.stringify({ lines: [17] })]) {
    const files = data === null ? {} : { 'scenes/chapter2.txt.json': { url: 'blob:chapter2', data: Buffer.from(data).toString('base64') } };
    const env = await referenceEngineSandbox({ files, lines: [
      '*choice', '  #Travel', '    *set gold +1', '    *goto_scene chapter2', '  #Wait', '    *abort'
    ] });
    env.run('scene.printLoop();'); env.flush();
    const effects = env.context.document.querySelector('.pathos-choice-effects').textContent;
    assert.match(effects, /stats.gold: 5 → 6 \(\+1\)/);
    assert.match(effects, /Go to chapter: chapter2/);
    assert.equal(env.context.stats.gold, 5);
    assert.deepEqual(env.messages.filter(message => message.type === 'status' && message.payload.level === 'error'), []);
  }
});

test('debug mode force-selects disabled choices and handles a menu with no selectable options', () => {
  for(const emptyMenu of [false,true]){
    const {document}=parseHTML('<main id="main"></main>'),env=sandbox({debugMode:true},document);
    env.context.emptyMenu=emptyMenu;
    env.run(debugChoiceEngine);env.flush();
    document.querySelector('[aria-label="Force-select Guarded path"]').click();env.flush();
    assert.equal(env.context.stats.outcome,'guarded outcome');
    assert.equal(env.context.stats.ready,false);
  }
  const {document}=parseHTML('<main id="main"></main>'),env=sandbox({debugMode:true},document);
  env.context.syntaxError=true;
  assert.throws(()=>env.run(debugChoiceEngine),/Invalid indent/,'debug mode must not suppress unrelated engine errors');
});

test('reference engine hidden fake-choice bodies and implicit control flow skip their sibling options when forced', async () => {
  for (const [command, implicit] of [['*fake_choice', false], ['*choice', true]]) {
    const env = await referenceEngineSandbox({ stats: { gold: 5, implicit_control_flow: implicit }, lines: [
      command, '  *if (false)', '    #Hidden one', '      *set gold +1', '      Hidden outcome one.',
      '    #Hidden two', '      Hidden outcome two.', '  #Open', '    Open outcome.', 'Afterwards.', '*abort'
    ] });
    env.run('scene.printLoop();'); env.flush();
    env.context.document.querySelector('[aria-label="Force-select Hidden one"]').click(); env.flush();
    assert.equal(env.context.stats.gold, 6);
    assert.match(env.context.document.getElementById('main').textContent, /Hidden outcome one\. Afterwards\./);
    assert.doesNotMatch(env.context.document.getElementById('main').textContent, /Hidden outcome two|Open outcome/);
    assert.deepEqual(env.messages.filter(message => message.type === 'status' && message.payload.level === 'error'), []);
  }
});

test('reference engine ordinary choices retain their explicit exit requirement when a hidden option is forced', async () => {
  const env = await referenceEngineSandbox({ lines: [
    '*choice', '  *if (false)', '    #Hidden one', '      Hidden outcome one.',
    '    #Hidden two', '      Hidden outcome two.', '  #Open', '    *abort', 'Afterwards.', '*abort'
  ] });
  env.run('scene.printLoop();'); env.flush();
  env.context.document.querySelector('[aria-label="Force-select Hidden one"]').click(); env.flush();
  assert.ok(env.messages.some(message => message.type === 'status' && /illegal to fall out of a \*choice/.test(message.payload.message)));
  assert.doesNotMatch(env.context.document.getElementById('main').textContent, /Afterwards/);
});

test('reference engine initializes usage tracking when forcing hidden reuse-limited options', async () => {
  for (const modifier of ['hide_reuse', 'disable_reuse']) {
    const env = await referenceEngineSandbox({ lines: [
      '*fake_choice', '  *if (false)', `    *${modifier} #Hidden`, '      *set gold +1', '      Hidden outcome.',
      '  #Open', '    Open outcome.', 'Afterwards.', '*abort'
    ] });
    env.run('scene.printLoop();'); env.flush();
    assert.equal(env.context.scene.temps.choice_used, undefined, 'the engine skips usage tracking inside a false condition');
    env.context.document.querySelector('[aria-label="Force-select Hidden"]').click(); env.flush();
    assert.equal(env.context.scene.temps.choice_used[2], 1);
    assert.equal(env.context.stats.gold, 6);
    assert.match(env.context.document.getElementById('main').textContent, /Hidden outcome\. Afterwards\./);
    assert.deepEqual(env.messages.filter(message => message.type === 'status' && message.payload.level === 'error'), []);
  }
});

test('reference engine menus with no selectable options remain inspectable only in debug mode', async () => {
  const lines = [
    '*fake_choice', '  *if (false)', '    #Hidden one', '      Hidden outcome one.',
    '    #Hidden two', '      Hidden outcome two.', '  *selectable_if (false) #Disabled', '    Disabled outcome.', 'Afterwards.', '*abort'
  ];
  const normal = await referenceEngineSandbox({ debugMode: false, lines });
  assert.throws(() => normal.run('scene.printLoop();'), /no selectable options/i);
  const env = await referenceEngineSandbox({ lines });
  env.run('scene.printLoop();'); env.flush();
  assert.equal(env.context.document.querySelectorAll('.pathos-choice-debug button').length, 3);
  env.context.document.querySelector('[aria-label="Force-select Hidden one"]').click(); env.flush();
  assert.match(env.context.document.getElementById('main').textContent, /Hidden outcome one\. Afterwards\./);
  assert.deepEqual(env.messages.filter(message => message.type === 'status' && message.payload.level === 'error'), []);
});

test('reference engine restore keeps forced stats and temps passed through its five-argument API', async () => {
  const env = await referenceEngineSandbox({ lines: ['*abort'] });
  env.run(`restoreGame({stats:{sceneName:'chapter',gold:5},temps:{choice_just_restored_checkpoint:false,_choiceEnds:{}},lineNum:0,indent:0},null,false,{gold:12},{choice_just_restored_checkpoint:true});`);
  assert.equal(env.context.stats.gold, 12);
  assert.equal(env.context.stats.scene.temps.choice_just_restored_checkpoint, true);
});

test('reference engine checkpoint restores retain excluded variables and mark the checkpoint as restored', async () => {
  const env = await referenceEngineSandbox({ lines: [
    '*temp checkpoint_exclusions "gold token"', '*temp token 1', '*save_checkpoint test', '*abort'
  ] });
  env.run('scene.printLoop();'); env.flush();
  assert.equal(env.context.scene.temps.choice_just_restored_checkpoint, false);
  env.run('stats.gold=12; scene.temps.token=9; scene.restore_checkpoint("test");'); env.flush();
  assert.equal(env.context.stats.gold, 12);
  assert.equal(env.context.stats.scene.temps.token, 9);
  assert.equal(env.context.stats.scene.temps.choice_just_restored_checkpoint, true);
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
  const support = `var _global=window; var nav={}; var debug=false; var toJson=JSON.stringify; function isStateValid(s){return !!s?.stats?.sceneName;} function safeCall(self,fn){fn.call(self);} Scene.prototype.execute=function(){this.printLoop();};`;
  const engineFunctions = functionSource('computeCookie') + '\n' + functionSource('restoreGame');
  const env = sandbox(); env.run(miniEngine); env.run(support + engineFunctions);
  env.run(`stats.gold=7; stats.scene=new Scene('chapter',stats); stats.scene.printLoop();`); env.flush();
  const saved = env.messages.findLast(message => message.type === 'snapshot').payload;
  assert.equal(saved.state.stats.gold, 7);
  const resumed = sandbox({ state: saved });
  resumed.run(miniEngine.replace('window.__pathosFinishLoading();', '') + support + engineFunctions + '\nwindow.__pathosFinishLoading(); restoreGame(null, null, false);'); resumed.flush();
  assert.equal(resumed.context.stats.gold, 17);
  assert.equal(resumed.context.stats.scene.name, 'chapter');
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
