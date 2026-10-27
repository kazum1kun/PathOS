/* Archive inspection never evaluates APK JavaScript. The separate player owns execution. */
import './vendor/jszip.js';

export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  entries: 20000,
  ratio: 400,
});

export class ArchiveError extends Error {
  constructor(code, message) { super(message); this.name = 'ArchiveError'; this.code = code; }
}
const fail = (code, message) => { throw new ArchiveError(code, message); };
const decoder = new TextDecoder('utf-8');
const text = bytes => decoder.decode(bytes);
const u16 = (view, offset) => view.getUint16(offset, true);
const u32 = (view, offset) => view.getUint32(offset, true);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const dictionary = () => Object.create(null);

function safePath(path) {
  if (!path || /^[\/\\]/.test(path) || /^[a-z]:/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path)) {
    fail('UNSAFE_PATH', `The archive contains an unsafe file path: ${JSON.stringify(path)}.`);
  }
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* A literal percent is a valid asset name. */ }
  for (const form of [path, decoded]) {
    if (/^[\/\\]/.test(form) || form.includes('\\') || form.split('/').some(part => part === '..' || part === '.')) {
      fail('UNSAFE_PATH', `The archive contains a parent-directory or ambiguous path: ${JSON.stringify(path)}.`);
    }
  }
  return path;
}

/** Read sizes and original names before JSZip can sanitize names or allocate expanded entries. */
export function inspectDirectory(bytes, limits) {
  if (bytes.byteLength > limits.archiveBytes) fail('ARCHIVE_TOO_LARGE', `Archive exceeds the ${Math.floor(limits.archiveBytes / 1048576)} MiB import limit.`);
  if (bytes.byteLength < 22) fail('NOT_ZIP', 'Choose an APK or ZIP archive containing a ChoiceScript game.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22, first = Math.max(0, bytes.length - 65557); offset >= first; offset--) {
    if (u32(view, offset) === 0x06054b50 && offset + 22 + u16(view, offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail('NOT_ZIP', 'The file is not a complete ZIP/APK archive (end directory is missing).');
  const disk = u16(view, end + 4), directoryDisk = u16(view, end + 6);
  const count = u16(view, end + 10), directorySize = u32(view, end + 12), start = u32(view, end + 16);
  if (count === 65535 || start === 0xffffffff || directorySize === 0xffffffff) fail('ZIP64_UNSUPPORTED', 'ZIP64 archives are not supported. Export a smaller ordinary ZIP.');
  if (disk || directoryDisk || u16(view, end + 8) !== count) fail('MULTIDISK_UNSUPPORTED', 'Split ZIP archives are not supported.');
  if (count > limits.entries) fail('TOO_MANY_FILES', `Archive contains more than ${limits.entries} files.`);
  if (start + directorySize > end) fail('CORRUPT_ZIP', 'The ZIP directory extends outside the archive.');
  const entries = [], names = new Set();
  let offset = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(view, offset) !== 0x02014b50) fail('CORRUPT_ZIP', 'A ZIP directory entry is invalid.');
    const flags = u16(view, offset + 8), method = u16(view, offset + 10);
    const packed = u32(view, offset + 20), size = u32(view, offset + 24), crc = u32(view, offset + 16);
    const nameSize = u16(view, offset + 28), extraSize = u16(view, offset + 30), commentSize = u16(view, offset + 32);
    const local = u32(view, offset + 42), endEntry = offset + 46 + nameSize + extraSize + commentSize;
    if (endEntry > start + directorySize) fail('CORRUPT_ZIP', 'A ZIP filename extends outside the directory.');
    const path = safePath(text(bytes.subarray(offset + 46, offset + 46 + nameSize)));
    if (names.has(path)) fail('DUPLICATE_PATH', `The archive contains duplicate entries for ${path}.`);
    names.add(path);
    if (flags & 1) fail('ENCRYPTED_ZIP', 'Password-protected ZIP files cannot be imported.');
    if (method !== 0 && method !== 8) fail('COMPRESSION_UNSUPPORTED', `Unsupported ZIP compression method ${method} in ${path}.`);
    if (((u32(view, offset + 38) >>> 16) & 0xf000) === 0xa000) fail('SYMLINK_UNSUPPORTED', `Symbolic links are not allowed in game archives: ${path}.`);
    if (size === 0xffffffff || packed === 0xffffffff || local === 0xffffffff) fail('ZIP64_UNSUPPORTED', 'ZIP64 entries are not supported.');
    if (size > limits.entryBytes) fail('ENTRY_TOO_LARGE', `File ${path} exceeds the ${Math.floor(limits.entryBytes / 1048576)} MiB per-file limit.`);
    total += size;
    if (total > limits.expandedBytes) fail('EXPANSION_LIMIT', `Expanded archive exceeds ${Math.floor(limits.expandedBytes / 1048576)} MiB.`);
    if (size > 1048576 && size / Math.max(1, packed) > limits.ratio) fail('SUSPICIOUS_COMPRESSION', `File ${path} expands more than ${limits.ratio} times. Import a normally compressed archive.`);
    if (local + 30 > start || u32(view, local) !== 0x04034b50) fail('CORRUPT_ZIP', `The ZIP local header for ${path} is invalid.`);
    const localName = u16(view, local + 26), localExtra = u16(view, local + 28);
    const dataStart = local + 30 + localName + localExtra;
    if (dataStart + packed > start || localName !== nameSize || text(bytes.subarray(local + 30, local + 30 + localName)) !== path) fail('CORRUPT_ZIP', `The ZIP local entry for ${path} is inconsistent.`);
    entries.push({ path, size, packed, crc, directory: path.endsWith('/') });
    offset = endEntry;
  }
  if (offset !== start + directorySize) fail('CORRUPT_ZIP', 'The ZIP directory length is inconsistent.');
  return entries;
}

function extension(path) { return path.split('.').pop().toLowerCase(); }
export function mimeForPath(path) {
  return ({ html:'text/html', htm:'text/html', js:'text/javascript', mjs:'text/javascript', css:'text/css', json:'application/json', txt:'text/plain', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon', avif:'image/avif', mp3:'audio/mpeg', m4a:'audio/mp4', ogg:'audio/ogg', wav:'audio/wav', mp4:'video/mp4', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', wasm:'application/wasm', xml:'application/xml' })[extension(path)] || 'application/octet-stream';
}

function literalString(value) {
  if (!value) return null;
  if (value[0] === '"') { try { return JSON.parse(value); } catch { return null; } }
  if (value[0] === "'") return value.slice(1, -1).replace(/\\(['\\])/g, '$1');
  return null;
}

// Locate a balanced JSON object without running JavaScript or accepting JS expressions.
function jsonObjectAt(source, start, withEnd = false) {
  if (source[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { const value = JSON.parse(source.slice(start, i + 1)); return withEnd ? { value, end:i + 1 } : value; } catch { return null; }
    }
  }
  return null;
}

function labelsForLines(lines) {
  const labels = dictionary();
  lines.forEach((line, index) => { const match = /^\s*\*label\s+(\S+)/i.exec(line); if (match) labels[match[1].toLowerCase()] = index; });
  return labels;
}

function addCompiledScenes(source, scenes) {
  const assignments = /(?:\b(?:window\.)?allScenes)\s*=\s*(?=\{)/g;
  let match;
  while ((match = assignments.exec(source))) {
    const parsed = jsonObjectAt(source, assignments.lastIndex);
    if (!parsed || typeof parsed !== 'object') continue;
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || !Array.isArray(value.lines) || !value.lines.every(line => typeof line === 'string')) continue;
      const labels = dictionary();
      for (const [label, line] of Object.entries(value.labels || labelsForLines(value.lines))) {
        if (Number.isInteger(line) && line >= 0 && line < value.lines.length) labels[label.toLowerCase()] = line;
      }
      scenes[name.toLowerCase()] = { crc: Number.isInteger(value.crc) ? value.crc : null, lines: value.lines, labels, source:'compiled' };
    }
  }
}

function initialDeclarationsFor(scene) {
  const initialStats = dictionary(), initializers = dictionary(), unresolvedInitializers = dictionary();
  for (const line of scene?.lines || []) {
    const match = /^\s*\*(create|create_array)\s+(\S+)(?:\s+(.+?))?\s*$/i.exec(line);
    if (!match) continue;
    const name = match[2].toLowerCase(), declaration = line.trim();
    initializers[name] = declaration;
    if (match[1].toLowerCase() === 'create_array' || !/^[a-z][a-z0-9_]*$/i.test(match[2])) { unresolvedInitializers[name] = declaration; continue; }
    let value;
    try { value = JSON.parse(match[3]); } catch { unresolvedInitializers[name] = declaration; continue; }
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) initialStats[name] = value;
    else unresolvedInitializers[name] = declaration;
  }
  return { initialStats, initializers, unresolvedInitializers };
}

function htmlEntities(value) {
  return value.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (all, numeric, named) => {
    if (numeric) { const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10); return code <= 0x10ffff ? String.fromCodePoint(code) : all; }
    return { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'" }[named.toLowerCase()];
  });
}

function readManifest(bytes) {
  const metadata = { packageName:null, versionName:null, versionCode:null, applicationLabel:null };
  if (!bytes) return metadata;
  // Some exported packages contain a textual manifest instead of binary AXML.
  const source = text(bytes);
  if (/^\s*(?:<\?xml[^>]*>\s*)?<manifest\b/i.test(source)) {
    const manifest = /<manifest\b([^>]+)>/i.exec(source)?.[1] || '';
    const attr = (tag, name) => new RegExp(`(?:^|\\s)(?:android:)?${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1] || null;
    metadata.packageName = attr(manifest, 'package');
    metadata.versionName = attr(manifest, 'versionName');
    metadata.versionCode = attr(manifest, 'versionCode');
    metadata.applicationLabel = attr(/<application\b([^>]+)>/i.exec(source)?.[1] || '', 'label');
    return metadata;
  }
  if (bytes.length < 8) return metadata;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u16(view, 0) !== 3) return metadata;
  let strings = [];
  try {
    for (let offset = u16(view, 2); offset + 8 <= bytes.length;) {
      const type = u16(view, offset), header = u16(view, offset + 2), size = u32(view, offset + 4);
      if (size < 8 || offset + size > bytes.length) break;
      if (type === 1 && header >= 28) {
        const count = u32(view, offset + 8), flags = u32(view, offset + 16), base = offset + u32(view, offset + 20);
        if (count > 100000 || offset + header + count * 4 > offset + size) break;
        strings = [];
        for (let index = 0; index < count; index++) {
          let pos = base + u32(view, offset + header + index * 4);
          if (flags & 0x100) {
            if (bytes[pos++] & 0x80) pos++;
            let length = bytes[pos++];
            if (length & 0x80) length = ((length & 0x7f) << 8) | bytes[pos++];
            if (pos + length > offset + size) throw new Error('Invalid string pool');
            strings.push(text(bytes.subarray(pos, pos + length)));
          } else {
            let length = u16(view, pos); pos += 2;
            if (length & 0x8000) { length = ((length & 0x7fff) * 65536) + u16(view, pos); pos += 2; }
            if (pos + length * 2 > offset + size) throw new Error('Invalid string pool');
            strings.push(new TextDecoder('utf-16le').decode(bytes.subarray(pos, pos + length * 2)));
          }
        }
      } else if (type === 0x0102 && header >= 16 && size >= 36) {
        const name = strings[u32(view, offset + 20)], attributeStart = u16(view, offset + 24);
        const attributeSize = u16(view, offset + 26), count = u16(view, offset + 28);
        if (attributeSize < 20 || offset + 16 + attributeStart + count * attributeSize > offset + size) break;
        for (let i = 0; i < count; i++) {
          const at = offset + 16 + attributeStart + i * attributeSize;
          const key = strings[u32(view, at + 4)], raw = u32(view, at + 8), valueType = bytes[at + 15], data = u32(view, at + 16);
          const value = raw !== 0xffffffff ? strings[raw] : valueType === 3 ? strings[data] : valueType === 0x10 ? String(data) : null;
          if (name === 'manifest' && key === 'package') metadata.packageName = value;
          if (name === 'manifest' && key === 'versionName') metadata.versionName = value;
          if (name === 'manifest' && key === 'versionCode') metadata.versionCode = value;
          if (name === 'application' && key === 'label') metadata.applicationLabel = value;
        }
      }
      offset += size;
    }
  } catch { /* Optional metadata does not make an otherwise valid game unreadable. */ }
  return metadata;
}

function resolveRelative(from, relative) {
  if (!relative || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(relative)) return null;
  const clean = relative.split(/[?#]/)[0], parts = from.split('/').slice(0, -1);
  for (const piece of clean.split('/')) {
    if (piece === '..') { if (!parts.length) return null; parts.pop(); }
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

async function hashFiles(files) {
  if (!globalThis.crypto?.subtle) fail('SECURE_CONTEXT_REQUIRED', 'Import requires HTTPS or localhost so the browser can calculate a version fingerprint.');
  // Hash each file first: the final allocation depends on file count, not game size.
  const chunks = await Promise.all(files.map(async file => {
    const hash = await crypto.subtle.digest('SHA-256', file.data);
    return `${file.path}\u0000${[...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')}\n`;
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chunks.join('')));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function engineSource(source) {
  let result = '', offset = 0, match;
  const assignments = /(?:\b(?:window\.)?allScenes)\s*=\s*(?=\{)/g;
  while ((match = assignments.exec(source))) {
    const parsed = jsonObjectAt(source, assignments.lastIndex, true);
    if (!parsed) continue;
    result += source.slice(offset, match.index) + 'allScenes = {}';
    offset = parsed.end;
    assignments.lastIndex = parsed.end;
  }
  return (result + source.slice(offset)).replace(/(?:window\.)?\bversion\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, 'version=""');
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let value = i; for (let j = 0; j < 8; j++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); crcTable[i] = value; }
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }

// JSZip's chunked stream lets us abort a forged size before allocating its output.
export function expandBounded(file, entry) {
  return new Promise((resolve, reject) => {
    const chunks = [], stream = file.internalStream('uint8array');
    let length = 0, failed = false;
    stream.on('data', chunk => {
      length += chunk.length;
      if (length > entry.size) { failed = true; stream.pause(); reject(new ArchiveError('EXPANSION_LIMIT', `File ${entry.path} expands beyond its declared size.`)); return; }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (failed) return;
      if (length !== entry.size) { reject(new ArchiveError('CORRUPT_ZIP', `Expanded length is inconsistent for ${entry.path}.`)); return; }
      const output = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      if (crc32(output) !== entry.crc) { reject(new ArchiveError('CORRUPT_ZIP', `CRC verification failed for ${entry.path}.`)); return; }
      resolve(output);
    });
    stream.resume();
  });
}

/**
 * Inspect a File, Blob, Uint8Array or ArrayBuffer. Candidate paths are relative to
 * rootPath; filenames are never written to disk. Existing game scripts stay intact.
 */
export async function inspectArchive(input, { filename = input?.name || 'game.apk', limits: overrides = {} } = {}) {
  const limits = { ...ARCHIVE_LIMITS, ...overrides };
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input && typeof input.arrayBuffer === 'function') {
    if (input.size > limits.archiveBytes) fail('ARCHIVE_TOO_LARGE', 'The selected archive exceeds the 256 MiB import limit.');
    bytes = new Uint8Array(await input.arrayBuffer());
  } else fail('INVALID_INPUT', 'Select an APK or ZIP file.');
  const entries = inspectDirectory(bytes, limits);
  let zip;
  try { zip = await globalThis.JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false }); }
  catch (error) { fail('CORRUPT_ZIP', `Unable to read this archive: ${error.message}`); }
  const cache = new Map();
  async function read(path) {
    if (!cache.has(path)) {
      const entry = entries.find(item => item.path === path), file = zip.file(path);
      if (!entry || !file) return null;
      let data;
      try { data = await expandBounded(file, entry); } catch (error) { if (error instanceof ArchiveError) throw error; fail('CORRUPT_ZIP', `Cannot decompress ${path}: ${error.message}`); }
      if (data.length !== entry.size) fail('CORRUPT_ZIP', `Expanded length is inconsistent for ${path}.`);
      cache.set(path, data);
    }
    return cache.get(path);
  }
  const manifest = readManifest(await read('AndroidManifest.xml'));
  const candidates = [], warnings = [];
  const htmlEntries = entries.filter(entry => !entry.directory && /(?:^|\/)(?:index|mygame)\.html?$/i.test(entry.path));
  // Index files are preferred; generic .html support remains useful for author exports.
  if (!htmlEntries.length) htmlEntries.push(...entries.filter(entry => !entry.directory && /\.html?$/i.test(entry.path)).slice(0, 40));
  for (const entry of htmlEntries) {
    const html = text(await read(entry.path)), sources = [html], sceneIndex = dictionary();
    const linked = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => resolveRelative(entry.path, htmlEntities(match[1]))).filter(Boolean);
    for (const path of linked) { const data = await read(path); if (data) sources.push(text(data)); }
    const combined = sources.join('\n');
    if (!/allScenes\s*=|SceneNavigator|choicescript(?:_stats|\/)|Scene\.prototype/i.test(combined)) continue;
    for (const source of sources) addCompiledScenes(source, sceneIndex);
    // APK assets root includes parent engine files for the common assets/mygame layout.
    const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
    const rootPath = entry.path.startsWith('assets/') ? 'assets/' : /(?:^|\/)mygame\//i.test(directory) ? directory.replace(/mygame\/$/i, '') : directory;
    const candidateEntries = entries.filter(item => !item.directory && item.path.startsWith(rootPath) && item.path !== 'AndroidManifest.xml' && !item.path.startsWith('META-INF/'));
    // Keep APK bytecode/resources out of ZIP-root web exports that also contain a manifest.
    const webEntries = candidateEntries.filter(item => !/^(?:classes\d*\.dex|resources\.arsc|res\/|lib\/|META-INF\/)/.test(item.path.slice(rootPath.length)));
    for (const item of webEntries.filter(item => /(?:^|\/)scenes\/[^/]+\.(?:txt|txt\.json|json)$/i.test(item.path))) {
      const name = item.path.split('/').pop().replace(/(?:\.txt)?\.json$|\.txt$/i, '').toLowerCase();
      const source = text(await read(item.path));
      if (/\.json$/i.test(item.path)) {
        try {
          const parsed = JSON.parse(source);
          if (Array.isArray(parsed.lines) && parsed.lines.every(line => typeof line === 'string')) sceneIndex[name] = { crc:Number.isInteger(parsed.crc) ? parsed.crc : null, lines:parsed.lines, labels:labelsForLines(parsed.lines), source:'compiled' };
        } catch { warnings.push(`Could not index scene metadata in ${item.path}; the original file is preserved.`); }
      } else if (!own(sceneIndex, name)) {
        const lines = source.replace(/\r\n?/g, '\n').split('\n');
        sceneIndex[name] = { crc:null, lines, labels:labelsForLines(lines), source:'text' };
      }
    }
    const startup = sceneIndex.startup;
    const titleLine = startup?.lines.find(line => /^\s*\*title\s+/i.test(line));
    const cleanHTML = html.replace(/<!--[\s\S]*?-->/g, '');
    const title = (titleLine?.replace(/^\s*\*title\s+/i, '').trim() || htmlEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleanHTML)?.[1]?.trim() || '') || manifest.applicationLabel || filename.replace(/\.(?:apk|zip)$/i, '')).replace(/<[^>]*>/g, '').slice(0, 200);
    const storeMatch = /(?:\bwindow\s*\.\s*)?\bstoreName\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(combined);
    const versionMatch = /(?:\bwindow\s*\.\s*)?\bversion\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(combined);
    const storeName = literalString(storeMatch?.[1]);
    const parsedVersion = literalString(versionMatch?.[1]);
    const files = [];
    for (const item of webEntries.sort((a, b) => a.path.localeCompare(b.path, 'en'))) files.push({ path:item.path.slice(rootPath.length), data:await read(item.path), mime:mimeForPath(item.path) });
    const contentHash = await hashFiles(files);
    for (const scene of Object.values(sceneIndex)) scene.hash = await sha256(JSON.stringify({ lines:scene.lines, labels:scene.labels }));
    const scriptSources = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => engineSource(match[1]));
    // Include dynamically loaded engine libraries, even when index.html does not
    // mention them directly. Data-only JS changes conservatively require review.
    const bundledScripts = files.filter(file => /\.(?:js|mjs)$/i.test(file.path)).map(file => `${file.path}\u0000${engineSource(text(file.data))}`);
    const engineHash = await sha256([...scriptSources, ...bundledScripts].join('\n'));
    candidates.push({ entryPath:entry.path.slice(rootPath.length), rootPath, archiveFormat:entries.some(item => item.path === 'AndroidManifest.xml') ? 'apk' : 'zip', title, storeName, ...manifest, versionName:manifest.versionName || (parsedVersion && parsedVersion !== 'UNKNOWN' ? parsedVersion : null), files, sceneIndex, ...initialDeclarationsFor(startup), contentHash, engineHash });
  }
  if (!candidates.length) {
    const apk = entries.some(entry => entry.path === 'AndroidManifest.xml');
    fail('NO_CHOICESCRIPT_GAME', apk ? 'This APK does not contain a supported ChoiceScript HTML game. Unity, native Android games, split APKs, and packages that download story files after installation are not supported.' : 'No ChoiceScript game was found. Choose an APK or a ZIP that contains the engine HTML, scripts, and story files.');
  }
  if (candidates.some(candidate => !candidate.storeName && !candidate.packageName)) warnings.push('This package has no stable store name or Android package ID. Link later imports to the existing game explicitly to preserve its saves.');
  if (candidates.some(candidate => !Object.keys(candidate.sceneIndex).length)) warnings.push('Scene metadata could not be indexed. Gameplay may work, but safe save migration between versions requires a chapter restart.');
  return { filename, candidates, warnings, archiveBytes:bytes.length, entryCount:entries.length };
}
