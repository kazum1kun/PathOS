import { ARCHIVE_LIMITS, inspectDirectory, expandBounded } from './importer.js';
import { assertJSONValue, validateSaveRecord, compactSaveRecord } from './compatibility.js';

export const TRANSFER_LIMITS = Object.freeze({
  ...ARCHIVE_LIMITS, archiveBytes: 512 * 1024 * 1024,
  // Repeated stats and text can legitimately compress extremely well.
  ratio: 10000,
});

export async function writeArchive(manifest, files = new Map(), overrides = {}) {
  const zip = new globalThis.JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  for (const [path, data] of files) zip.file(path, data, { binary: true, createFolders: false });
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true });
  inspectDirectory(bytes, { ...TRANSFER_LIMITS, ...overrides });
  return bytes;
}

export async function readArchive(input, overrides = {}) {
  const limits = { ...TRANSFER_LIMITS, ...overrides };
  if (input?.size > limits.archiveBytes) throw new Error('This PathOS archive is too large.');
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input)
    : input?.arrayBuffer ? new Uint8Array(await input.arrayBuffer()) : null;
  if (!bytes) throw new Error('Choose a compressed PathOS ZIP file.');
  const entries = inspectDirectory(bytes, limits);
  const zip = await globalThis.JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const byPath = new Map(entries.filter(entry => !entry.directory).map(entry => [entry.path, entry]));
  async function read(path) {
    const entry = byPath.get(path), file = zip.file(path);
    if (!entry || !file) throw new Error(`The PathOS archive is missing ${path}.`);
    return expandBounded(file, entry);
  }
  const data = await read('manifest.json');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new Error('The PathOS archive has an invalid manifest.'); }
  assertJSONValue(manifest);
  return { manifest, read, entries: byPath };
}

export async function hashBytes(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function encodeSave(envelope) {
  validateSaveRecord(envelope.save);
  return writeArchive({ ...envelope, format: 'story-vault-save', version: 2, save: compactSaveRecord(envelope.save) }, new Map(), { archiveBytes: 20 * 1024 * 1024, expandedBytes: 20 * 1024 * 1024, entryBytes: 20 * 1024 * 1024 });
}

export async function readSaveFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('This save file is larger than 20 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Raw ChoiceScript JSON remains useful for importing external engine saves.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return JSON.parse(new TextDecoder().decode(bytes));
  const { manifest } = await readArchive(bytes, { expandedBytes: 20 * 1024 * 1024, entryBytes: 20 * 1024 * 1024 });
  return manifest;
}
