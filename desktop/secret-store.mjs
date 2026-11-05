// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const protectedLinuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/** OS encryption is mandatory. Never substitute an application-owned hardcoded key. */
export function createSecretStore({ directory, crypto, platform = process.platform }) {
  const root = path.resolve(directory);
  const operations = new Map();
  function file(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid secret identifier');
    return path.join(root, `${id}.secret`);
  }
  function serialized(id, operation) {
    file(id);
    const previous=operations.get(id) ?? Promise.resolve();
    const result=previous.catch(()=>{}).then(operation);
    operations.set(id,result);
    result.finally(()=>{if(operations.get(id)===result)operations.delete(id);}).catch(()=>{});
    return result;
  }
  async function ready() {
    if (typeof crypto.isAsyncEncryptionAvailable !== 'function' || !await crypto.isAsyncEncryptionAvailable()) {
      throw new Error('OS secret storage is unavailable. Unlock your system keychain before saving API keys.');
    }
    if (platform === 'linux' && !protectedLinuxBackends.has(crypto.getSelectedStorageBackend())) {
      throw new Error('A protected Linux keyring is required. Plaintext fallback is disabled.');
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Secret directory must not be a symbolic link');
  }
  async function set(id, value) {
    const destination = file(id);
    if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid secret value');
    await ready();
    const encrypted = await crypto.encryptStringAsync(value);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return {
    async get(id) {
      return serialized(id,async()=>{
      const location = file(id);
      let encrypted;
      try {
        const stat = await lstat(location);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink>1 || stat.size > 65536) throw new Error('Invalid encrypted secret file');
        encrypted = await readFile(location);
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      await ready();
      const decrypted = await crypto.decryptStringAsync(encrypted);
      if (typeof decrypted.result !== 'string') throw new Error('Unable to decrypt stored secret');
      if (decrypted.shouldReEncrypt) await set(id, decrypted.result);
      return decrypted.result;
      });
    },
    async set(id,value) {return serialized(id,()=>set(id,value));},
    async delete(id) {
      return serialized(id,()=>unlink(file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
    },
  };
}
