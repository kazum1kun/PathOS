/**
 * Imported games execute in an opaque-origin iframe. Only game state and isolated
 * storage cross its message channel; host/native APIs are never exposed there.
 * No original ChoiceScript engine or purchase implementation is replaced.
 */
export const RUNTIME_CHANNEL = 'pathos-runtime-v1';
export const GAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

export function normalizeAssetPath(input, base = '') {
  let value = String(input || '').replace(/\\/g, '/');
  if (/^(?:https?:|\/\/|javascript:|mailto:|tel:|intent:|capacitor:)/i.test(value)) return null;
  if (/^(?:blob:|data:|#)/i.test(value)) return value;
  value = value.replace(/^file:\/\/\/(?:android_asset\/)?/i, '/').split(/[?#]/)[0];
  try { value = decodeURIComponent(value); } catch { /* retain malformed literal */ }
  const parts = value.startsWith('/') ? [] : String(base).split('/').slice(0, -1);
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function rewriteCSS(text, resolve) {
  return String(text).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_all, _quote, path) => `url("${resolve(path)}")`)
    .replace(/(@import\s+)(['"])([^'"]+)\2/gi, (_all, prefix, quote, path) => prefix + quote + resolve(path) + quote);
}

/** Preserve script bodies verbatim; rewrite only parsed opening tags/assets. */
export function rewriteGameHTML(html, resolve) {
  const rewriteTag = tag => {
    if (/^<base\b/i.test(tag)) return '';
    if (/^<meta\b/i.test(tag) && /http-equiv\s*=\s*['"]?(?:content-security-policy|refresh)/i.test(tag)) return '';
    return tag.replace(/\b(src|href|poster|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (all, attr, double, single, bare) => {
        const value = double ?? single ?? bare ?? '';
        if (/^(?:href)$/i.test(attr) && (value.startsWith('#') || /^javascript:/i.test(value))) return all;
        const resolved = resolve(value);
        return `${attr}="${String(resolved).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
      }).replace(/\bstyle\s*=\s*"([^"]*)"/gi, (_all, css) => `style="${rewriteCSS(css, resolve).replace(/"/g, '&quot;')}"`);
  };
  return String(html).replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]+>/gi, token => {
    if (token.startsWith('<!--')) return token;
    if (/^<script\b/i.test(token)) {
      const end = token.indexOf('>');
      return rewriteTag(token.slice(0, end + 1)) + token.slice(end + 1);
    }
    if (/^<style\b/i.test(token)) {
      const end = token.indexOf('>');
      return token.slice(0, end + 1) + rewriteCSS(token.slice(end + 1, token.lastIndexOf('</')), resolve) + '</style>';
    }
    return rewriteTag(token);
  });
}

async function fileBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('An imported asset has an unsupported data format.');
}
function base64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 24576) result += String.fromCharCode(...bytes.subarray(i, i + 24576));
  return btoa(result);
}
function safeJSON(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

/** Exported so security and VFS construction can be tested without a browser. */
export async function prepareRuntimeDocument(version, { token, storage = {}, state = null } = {}) {
  if (!version?.files?.length || !version.entryPath) throw new Error('The selected version has no playable entry page.');
  const files = Object.create(null), urls = Object.create(null), ownedURLs = [];
  for (const file of version.files) {
    const path = normalizeAssetPath(file.path);
    if (!path || /^(blob:|data:)/.test(path)) throw new Error('Invalid asset path.');
    files[path] = { path, bytes: await fileBytes(file.data), mime: file.mime || 'application/octet-stream' };
  }
  const entryPath = normalizeAssetPath(version.entryPath);
  if (!files[entryPath]) throw new Error('The selected entry page is missing from this version.');
  const creating = new Set();
  const assetURL = path => {
    if (urls[path]) return urls[path];
    const file = files[path];
    if (!file || creating.has(path)) return 'data:application/octet-stream,';
    creating.add(path);
    let body = file.bytes;
    if (/css/i.test(file.mime) || /\.css$/i.test(path)) {
      body = rewriteCSS(new TextDecoder().decode(file.bytes), input => resolve(input, path));
    }
    // The player has an opaque origin. Parent-owned blob scripts can fail to
    // load in WebKit, and cross-origin classic scripts can hide exceptions as
    // "Script error." Embedded scripts keep normal parser ordering and global
    // declarations without depending on the host's http/capacitor blob origin.
    if (/(?:java|ecma)script/i.test(file.mime) || /\.m?js$/i.test(path)) {
      const url = 'data:text/javascript;charset=utf-8;base64,' + base64(file.bytes);
      urls[path] = url; creating.delete(path);
      return url;
    }
    const url = URL.createObjectURL(new Blob([body], { type: file.mime }));
    ownedURLs.push(url); urls[path] = url; creating.delete(path);
    return url;
  };
  const resolve = (input, base = entryPath) => {
    const path = normalizeAssetPath(input, base);
    if (path && /^(blob:|data:|#)/i.test(path)) return path;
    return path && files[path] ? assetURL(path) : 'data:application/octet-stream,';
  };
  for (const path of Object.keys(files)) assetURL(path);
  const virtual = Object.fromEntries(Object.values(files).map(file => [file.path, { url: urls[file.path], mime: file.mime, data: base64(file.bytes) }]));
  const config = { token: token || crypto.randomUUID(), storage, state, entryPath, files: virtual, storeName: version.storeName || version.metadata?.storeName || null };
  const bootstrap = `<meta http-equiv="Content-Security-Policy" content="${GAME_CSP}"><script>(${runtimeBootstrap.toString()})(${safeJSON(config)});<\/script>`;
  let html = rewriteGameHTML(new TextDecoder().decode(files[entryPath].bytes), resolve);
  // A malformed export can contain executable tokens before its explicit head.
  // Start the document ourselves so CSP and storage always precede every game
  // token. The HTML parser ignores the later duplicate html/head opening tags;
  // the export's normal head/body end tags preserve its usual document layout.
  html = '<!doctype html><html><head><meta charset="utf-8">' + bootstrap + html.replace(/^(?:\uFEFF)?\s*<!doctype[^>]*>/i, '');
  // Install engine hooks after inline/classic scripts, before DOMContentLoaded.
  const tail = '<script>window.__pathosFinishLoading();<\/script>';
  // Appending is valid HTML parser behavior even after </html>, and avoids
  // mistaking a literal </body> inside an engine script for the document end.
  html += tail;
  return { html, token: config.token, dispose() { ownedURLs.forEach(url => URL.revokeObjectURL(url)); } };
}

// Serialized into the opaque frame. Keep this function self-contained.
export function runtimeBootstrap(config) {
  'use strict';
  const channel = 'pathos-runtime-v1', token = config.token;
  const originalPost = parent.postMessage.bind(parent);
  const post = (type, payload, id) => originalPost({ channel, token, type, payload, id }, '*');
  const values = Object.assign(Object.create(null), config.storage || {});
  let storageTimer, saveTimer, candidate = null, checkpoint = config.state?.checkpoint ? JSON.parse(JSON.stringify(config.state.checkpoint)) : null, lastPublished = '', ready = false, initialStateUsed = false;
  const seenWarnings = new Set(), pendingInitial = config.state?.state || config.state || null;
  const initializedStores = new Set();
  const warning = message => { if (!seenWarnings.has(message)) { seenWarnings.add(message); post('status', { level: 'error', message }); } };
  const status = (level, message) => post('status', { level, message });
  const clone = value => JSON.parse(JSON.stringify(value));
  const changed = () => {
    clearTimeout(storageTimer);
    storageTimer = setTimeout(() => post('storage', clone(values)), 120);
  };
  function makeStorage(prefix) {
    const api = {
      getItem(key) { return Object.hasOwn(values, prefix + String(key)) ? String(values[prefix + String(key)]) : null; },
      setItem(key, value) { values[prefix + String(key)] = String(value); changed(); },
      removeItem(key) { delete values[prefix + String(key)]; changed(); },
      clear() { for (const key of Object.keys(values)) if (key.startsWith(prefix)) delete values[key]; changed(); },
      key(index) { return Object.keys(values).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))[index] ?? null; },
      get length() { return Object.keys(values).filter(key => key.startsWith(prefix)).length; }
    };
    return new Proxy(api, {
      get(target, key) { if (typeof key === 'symbol' || key in target) return Reflect.get(target, key); return target.getItem(key) ?? undefined; },
      set(target, key, value) { target.setItem(key, value); return true; },
      deleteProperty(target, key) { target.removeItem(key); return true; },
      ownKeys() { return Object.keys(values).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)); },
      getOwnPropertyDescriptor(target, key) { if (target.getItem(key) !== null) return { enumerable: true, configurable: true }; }
    });
  }
  for (const [name, prefix] of [['localStorage', 'local:'], ['sessionStorage', 'session:']]) {
    Object.defineProperty(window, name, { value: makeStorage(prefix), configurable: false });
  }
  const cookieJar = Object.create(null);
  try { Object.defineProperty(document, 'cookie', {
    configurable: false,
    get() { return Object.entries(cookieJar).map(([key, value]) => key + '=' + value).join('; '); },
    set(input) { const [first, ...attributes] = String(input).split(';'); const at = first.indexOf('='); if (at < 0) return;
      const key = first.slice(0, at).trim();
      if (attributes.some(attr => /expires\s*=.*(?:1970|1969)/i.test(attr))) delete cookieJar[key];
      else cookieJar[key] = first.slice(at + 1); }
  }); } catch { /* engine uses the isolated Persist backend */ }
  const persist = {
    type: 'pathos', VERSION: 'pathos-1', Cookie: { enabled: true },
    add() {}, remove() {}, init() {},
    Store: function Store(name) {
      name = String(name || config.storeName || 'choicescript'); this.name = name;
      const prefix = 'persist:' + name + ':';
      if (!initializedStores.has(name)) {
        initializedStores.add(name);
        if (pendingInitial?.stats && name === (window.storeName || config.storeName || name)) values[prefix + 'state'] = JSON.stringify(pendingInitial);
      }
      this.get = (key, callback, scope) => { const value = Object.hasOwn(values, prefix + key) ? values[prefix + key] : null;
        if (callback) setTimeout(() => callback.call(scope || this, true, value), 0); return value; };
      this.set = (key, value, callback, scope) => { values[prefix + key] = String(value); changed();
        if (callback) setTimeout(() => callback.call(scope || this, true, value), 0); return value; };
      this.remove = (key, callback, scope) => { const previous = values[prefix + key] ?? null; delete values[prefix + key]; changed();
        if (callback) setTimeout(() => callback.call(scope || this, true, previous), 0); return previous; };
      this.load = () => {}; this.save = () => {};
    }
  };
  // APKs often bundle their own Persist implementation. Keep its public API
  // backed by the same isolated store, including during initial boot.
  Object.defineProperty(window, 'Persist', { configurable: false, get: () => persist, set: () => {} });
  // An opaque frame has no native bridge. Explicit calls receive a diagnostic.
  for (const name of ['Capacitor', 'cordova', 'webkit']) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  window.alert = message => warning(String(message));
  window.confirm = message => { warning('This game requested a synchronous native confirmation: ' + String(message)); return false; };
  window.prompt = message => { warning('This game requested a synchronous native prompt: ' + String(message)); return null; };
  window.open = () => { warning('External links and native app commands are unavailable in the isolated player.'); return null; };
  function pathOf(input) {
    let value = typeof input === 'string' ? input : input?.url || String(input);
    const exact = Object.keys(config.files).find(key => config.files[key].url === value);
    if (exact) return exact;
    if (/^(?:https?:|\/\/|javascript:|mailto:|tel:|intent:|capacitor:)/i.test(value)) return null;
    if (/^(?:blob:|data:|#)/i.test(value)) return value;
    value = value.replace(/\\/g, '/').replace(/^file:\/\/\/(?:android_asset\/)?/i, '/').split(/[?#]/)[0];
    try { value = decodeURIComponent(value); } catch {}
    const parts = value.startsWith('/') ? [] : config.entryPath.split('/').slice(0, -1);
    for (const part of value.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part); }
    return parts.join('/');
  }
  const bytesOf = file => Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
  function resolve(input) {
    const path = pathOf(input);
    if (path && config.files[path]) return config.files[path].url;
    if (path && /^(blob:|data:|#)/i.test(path)) return path;
    return 'data:application/octet-stream,';
  }
  window.fetch = async (input, options = {}) => {
    if (options.method && String(options.method).toUpperCase() !== 'GET') throw new Error('Only bundled local assets are available.');
    const path = pathOf(input), file = config.files[path];
    if (!file) { if (!path) warning('A network resource was requested; the isolated player only loads bundled assets.'); return new Response('Asset unavailable', { status: 404 }); }
    return new Response(bytesOf(file), { status: 200, headers: { 'content-type': file.mime } });
  };
  class LocalXHR extends EventTarget {
    constructor() { super(); this.readyState = 0; this.status = 0; this.statusText = ''; this.responseType = ''; this.response = null; this.responseText = ''; this.timeout = 0; this.withCredentials = false; this.upload = new EventTarget(); }
    emit(type) { const event = new Event(type); this.dispatchEvent(event); if (typeof this['on' + type] === 'function') this['on' + type].call(this, event); }
    open(method, url, async = true) { this.method = String(method).toUpperCase(); this.url = url; this.async = async; this.readyState = 1; this.emit('readystatechange'); }
    setRequestHeader() {} overrideMimeType(type) { this.mime = type; }
    getResponseHeader(name) { return String(name).toLowerCase() === 'content-type' ? this.mime || null : null; }
    getAllResponseHeaders() { return this.mime ? 'Content-Type: ' + this.mime : ''; }
    abort() { this.aborted = true; this.status = 0; this.readyState = 0; this.emit('abort'); this.emit('loadend'); }
    send() {
      const load = () => {
        if (this.aborted) return;
        const path = pathOf(this.url), file = this.method === 'GET' ? config.files[path] : null;
        this.status = file ? 200 : path ? 404 : 0; this.statusText = file ? 'OK' : 'Asset unavailable'; this.mime = file?.mime || '';
        const bytes = file ? bytesOf(file) : new Uint8Array();
        this.responseText = new TextDecoder().decode(bytes);
        try {
          this.response = this.responseType === 'json' ? JSON.parse(this.responseText) : this.responseType === 'arraybuffer' ? bytes.buffer : this.responseType === 'blob' ? new Blob([bytes], { type: this.mime }) : this.responseText;
        } catch { this.response = null; }
        this.readyState = 4; this.emit('readystatechange'); this.emit(this.status ? 'load' : 'error'); this.emit('loadend');
        if (!path) warning('A network resource was requested; the isolated player only loads bundled assets.');
      };
      if (this.async) setTimeout(load, 0); else load();
    }
  }
  for (const [name, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) { LocalXHR[name] = value; LocalXHR.prototype[name] = value; }
  window.XMLHttpRequest = LocalXHR;
  // Resource property assignments from *image, generated scripts, and styles.
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (/^(src|poster|background)$/i.test(name) || (/^href$/i.test(name) && this.tagName === 'LINK')) value = resolve(String(value));
    return nativeSetAttribute.call(this, name, value);
  };
  for (const [type, property] of [[window.HTMLImageElement, 'src'], [window.HTMLScriptElement, 'src'], [window.HTMLLinkElement, 'href'], [window.HTMLMediaElement, 'src'], [window.HTMLSourceElement, 'src'], [window.HTMLVideoElement, 'poster']]) {
    if (!type) continue;
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, property);
    if (descriptor?.set && descriptor.configurable) Object.defineProperty(type.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, resolve(String(value))); } });
  }
  const repairAssets = root => {
    if (!root?.querySelectorAll) return;
    for (const element of root.querySelectorAll('[src],[poster],link[href]')) {
      for (const attr of ['src', 'poster', ...(element.tagName === 'LINK' ? ['href'] : [])]) {
        if (!element.hasAttribute(attr)) continue;
        const raw = element.getAttribute(attr), mapped = resolve(raw);
        if (raw !== mapped) nativeSetAttribute.call(element, attr, mapped);
      }
    }
  };
  function currentScene(state) {
    const name = state.stats.sceneName;
    const active = window.stats?.scene;
    const source = active?.name === name ? active : window.allScenes?.[name];
    return { name, crc: source?.crc ?? state.temps?.choice_crc ?? null,
      ...(Array.isArray(source?.lines) ? { lines: source.lines.slice() } : {}),
      ...(source?.labels ? { labels: clone(source.labels) } : {}) };
  }
  function decodeEngineState(scene) {
    if (typeof window.computeCookie === 'function') return JSON.parse(window.computeCookie(scene.stats, scene.temps, scene.lineNum, scene.indent));
    const stats = {};
    for (const key of Object.keys(scene.stats || {})) if (key !== 'scene') stats[key] = scene.stats[key];
    stats.sceneName = scene.name;
    return clone({ stats, temps: scene.temps || {}, lineNum: scene.lineNum || 0, indent: scene.indent || 0 });
  }
  function snapshot() {
    if (!candidate) throw new Error('The game has not reached a restorable page yet.');
    return clone({ format: 'story-vault-state-v1', state: candidate.state, scene: candidate.scene, ...(checkpoint ? { checkpoint } : {}), capturedAt: new Date().toISOString() });
  }
  function publish() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!candidate) return;
      const signature = JSON.stringify(candidate.state);
      if (signature !== lastPublished) { lastPublished = signature; post('snapshot', snapshot()); }
      if (!ready) { ready = true; status('ready', 'Game ready. Your progress is saved each time a new page opens.'); }
    }, 140);
  }
  function hookEngine() {
    // Author exports may intentionally omit storeName and disable Persist.
    // Their existing loader still calls restoreGame(null): pass the selected
    // portable snapshot to that first call without inventing a store namespace.
    if (typeof window.restoreGame === 'function' && !window.restoreGame.__pathosHooked) {
      const originalRestore = window.restoreGame;
      const restore = function(state, forcedScene, userRestored) {
        if (!initialStateUsed) {
          initialStateUsed = true;
          if (!state?.stats?.sceneName && pendingInitial?.stats?.sceneName) state = clone(pendingInitial);
        }
        return originalRestore.call(this, state, forcedScene, userRestored);
      };
      Object.defineProperty(restore, '__pathosHooked', { value: true });
      window.restoreGame = restore;
    }
    const prototype = window.Scene?.prototype;
    if (!prototype || prototype.__pathosHooked) return;
    const original = prototype.printLoop;
    if (typeof original !== 'function') return;
    Object.defineProperty(prototype, '__pathosHooked', { value: true });
    prototype.printLoop = function(...args) {
      const main = !this.secondaryMode && !this.saveSlot && this.name !== 'choicescript_stats' && this.name !== 'choicescript_upgrade';
      if (main) {
        try {
          const state = decodeEngineState(this);
          candidate = { state, scene: currentScene(state) };
          if (this.lineNum === 0 && !(state.stats.choice_subscene_stack?.length)) checkpoint = { ...clone(candidate), atSceneStart: true };
        } catch (error) { warning('Could not capture this page: ' + error.message); }
      }
      const result = original.apply(this, args);
      if (main) publish();
      return result;
    };
  }
  Object.defineProperty(window, '__pathosFinishLoading', { value() { hookEngine(); repairAssets(document); } });
  const hookTimer = setInterval(hookEngine, 20);
  setTimeout(() => { clearInterval(hookTimer); if (!ready) warning('This game never reached a ChoiceScript page that PathOS can save. It may need missing files or native Android features.'); }, 30000);
  document.addEventListener('DOMContentLoaded', () => { hookEngine(); repairAssets(document); });
  new MutationObserver(() => repairAssets(document)).observe(document, { subtree: true, childList: true });
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
    event.preventDefault(); warning('External navigation is unavailable in the isolated player.');
  }, true);
  document.addEventListener('submit', event => { event.preventDefault(); warning('Forms that navigate outside the game are unavailable in the isolated player.'); }, true);
  window.addEventListener('error', event => {
    const script = event.target?.tagName === 'SCRIPT' ? event.target : null;
    const url = script?.src || event.filename;
    const path = Object.keys(config.files).find(key => config.files[key].url === url);
    if (script) {
      warning('Could not load bundled game script' + (path ? ': ' + path : '.'));
    } else if (event.message || event.error?.message) {
      const location = path ? ' (' + path + (event.lineno ? ':' + event.lineno : '') + ')' : '';
      warning('Game error: ' + (event.error?.message || event.message) + location);
    }
  }, true);
  window.addEventListener('unhandledrejection', event => warning('Game error: ' + (event.reason?.message || String(event.reason))));
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== channel || message.token !== token) return;
    try {
      if (message.type === 'capture') {
        post('storage', clone(values)); post('result', { snapshot: snapshot(), storage: clone(values) }, message.id);
      } else if (message.type === 'restore') {
        const state = clone(message.payload?.state || message.payload);
        if (!state?.stats?.sceneName || !state.temps || !Number.isInteger(state.lineNum)) throw new Error('Invalid ChoiceScript save.');
        if (typeof window.restoreGame !== 'function' || typeof window.clearScreen !== 'function') throw new Error('This engine does not expose a supported restore method.');
        const name = window.storeName || config.storeName || 'choicescript';
        values['persist:' + name + ':state'] = JSON.stringify(state);
        window.pseudoSave = {};
        changed();
        window.clearScreen(() => { window.restoreGame(state, null, false); post('result', { restored: true }, message.id); });
      }
    } catch (error) { post('result', { error: error.message }, message.id); }
  });
  status('info', 'Loading bundled game assets.');
}

export async function createRuntime({ container, version, storage = {}, state = null, onSnapshot = () => {}, onStorage = () => {}, onStatus = () => {} }) {
  if (!container) throw new Error('A player container is required.');
  const prepared = await prepareRuntimeDocument(version, { storage, state });
  const iframe = document.createElement('iframe');
  iframe.className = 'game-frame'; iframe.title = version.title || 'ChoiceScript game';
  iframe.setAttribute('sandbox', 'allow-scripts'); iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'");
  const waiting = new Map(); let sequence = 0, disposed = false, latestStorage = { ...storage };
  const listener = event => {
    const message = event.data;
    if (disposed || event.source !== iframe.contentWindow || !message || message.channel !== RUNTIME_CHANNEL || message.token !== prepared.token) return;
    if (message.type === 'snapshot') onSnapshot(message.payload);
    else if (message.type === 'storage') { latestStorage = message.payload; onStorage(message.payload); }
    else if (message.type === 'status') onStatus(message.payload);
    else if (message.type === 'result' && waiting.has(message.id)) {
      const task = waiting.get(message.id); waiting.delete(message.id); clearTimeout(task.timer);
      if (message.payload?.error) task.reject(new Error(message.payload.error)); else task.resolve(message.payload);
    }
  };
  window.addEventListener('message', listener);
  iframe.srcdoc = prepared.html; container.appendChild(iframe);
  function request(type, payload) {
    if (disposed) return Promise.reject(new Error('The player is closed.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The game did not respond. Wait for the page to finish loading.')); }, 10000);
      waiting.set(id, { resolve, reject, timer });
      iframe.contentWindow.postMessage({ channel: RUNTIME_CHANNEL, token: prepared.token, type, payload, id }, '*');
    });
  }
  return {
    iframe,
    async capture() { const result = await request('capture'); latestStorage = result.storage; onStorage(result.storage); return result.snapshot; },
    restore(value) { return request('restore', value); },
    getStorage() { return { ...latestStorage }; },
    dispose() { disposed = true; window.removeEventListener('message', listener); iframe.remove(); prepared.dispose();
      for (const task of waiting.values()) { clearTimeout(task.timer); task.reject(new Error('The player was closed.')); } waiting.clear(); }
  };
}
