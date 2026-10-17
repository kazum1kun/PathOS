import { createVault, bytesToBase64, base64ToBytes } from './storage.js';

// Binary game files cross WKWebView's JSON bridge as base64, but live as native
// files. Saves and ownership queries never need to read those files.
const encode = (store, record) => store === 'versions' ? { ...record, files: record.files.map(file => ({ ...file, data: bytesToBase64(file.data) })) } : record;
const decode = (store, record) => record == null ? undefined : store === 'versions' ? { ...record, files: record.files.map(file => ({ ...file, data: base64ToBytes(file.data) })) } : record;

export async function openNativeVault(bridge, openLegacy) {
  const status = await bridge({ operation: 'open' });
  let queue = Promise.resolve(), closed = false;
  const vault = createVault((stores, mode, action) => {
    const run = queue.then(async () => {
      if (closed) throw new Error('The library is closed. Reopen PathOS.');
      const { token } = await bridge({ operation: 'begin', stores, mode });
      const call = (operation, fields = {}) => bridge({ ...fields, operation, token });
      try {
        const result = await action({
          get: async (store, key) => decode(store, await call('get', { store, key })),
          getAll: async (store, index, key) => (await call('getAll', { store, index, key })).map(record => decode(store, record)),
          getAllKeys: (store, index, key) => call('getAllKeys', { store, index, key }),
          put: (store, record) => call('put', { store, record: encode(store, record) }),
          delete: (store, key) => call('delete', { store, key }),
          markMigrated: () => call('markMigrated'),
        });
        await call('commit');
        return result;
      } catch (error) {
        // Preserve the original error. SQLite also rolls back after process death.
        await call('rollback').catch(() => {});
        throw error;
      }
    });
    queue = run.catch(() => {});
    return run;
  }, 'native');
  vault.close = () => { closed = true; };
  vault.storageInfo = () => queue.then(() => bridge({ operation: 'info' }));
  if (!status.migrated) {
    let legacy;
    try {
      legacy = await openLegacy();
      await vault.migrateRecords(await legacy.exportRecords());
    } catch (error) {
      throw new Error(`Your existing library could not be moved to native storage. Its browser copy is unchanged. ${error.message}`);
    } finally { legacy?.close(); }
  }
  return vault;
}
