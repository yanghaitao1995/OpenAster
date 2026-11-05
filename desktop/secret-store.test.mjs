import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSecretStore } from './secret-store.mjs';

const mockCrypto = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(`cipher:${value.split('').reverse().join('')}`),
  decryptStringAsync: async buffer => ({ result: buffer.toString().slice(7).split('').reverse().join(''), shouldReEncrypt: false }),
  getSelectedStorageBackend: () => 'gnome_libsecret',
};
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openaster-secrets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('secret store persists only provider-encrypted bytes and supports replacement/deletion', async t => {
  const directory = await temporary(t);
  const store = createSecretStore({ directory, crypto: mockCrypto, platform: 'linux' });
  assert.equal(await store.get('provider-1'), undefined);
  await store.set('provider-1', 'secret-one');
  assert.equal((await readFile(path.join(directory, 'provider-1.secret'))).includes(Buffer.from('secret-one')), false);
  assert.equal(await store.get('provider-1'), 'secret-one');
  await store.set('provider-1', 'secret-two');
  assert.equal(await store.get('provider-1'), 'secret-two');
  await store.delete('provider-1');
  assert.equal(await store.get('provider-1'), undefined);
});
test('secret store fails closed on plaintext Linux backend or unavailable OS encryption', async t => {
  const directory = await temporary(t);
  const plain = createSecretStore({ directory, platform: 'linux', crypto: { ...mockCrypto, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(plain.set('test', 'secret'), /Plaintext fallback/);
  const missing = createSecretStore({ directory, crypto: { ...mockCrypto, isAsyncEncryptionAvailable: async () => false } });
  await assert.rejects(missing.set('test', 'secret'), /unavailable/);
});
test('secret identifiers cannot escape the vault or produce alternate Windows streams', async t => {
  const store = createSecretStore({ directory: await temporary(t), crypto: mockCrypto });
  for (const id of ['../outside', 'key:stream', 'C:\\key', '', 'a/b', '..']) await assert.rejects(store.set(id, 'secret'), /identifier/);
});

test('a delayed rotation cannot overwrite a newer key or resurrect a deleted key',async t=>{
  for(const operation of ['replace','delete']) {
    const directory=await temporary(t);let pause=false;let entered;let release;
    const reading=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    const store=createSecretStore({directory,crypto:{...mockCrypto,async decryptStringAsync(bytes){if(pause){entered();await gate;}return {...await mockCrypto.decryptStringAsync(bytes),shouldReEncrypt:pause};}}});
    await store.set('provider','old-key');pause=true;
    const oldRead=store.get('provider');await reading;
    const change=operation==='replace'?store.set('provider','new-key'):store.delete('provider');
    release();assert.equal(await oldRead,'old-key');await change;pause=false;
    assert.equal(await store.get('provider'),operation==='replace'?'new-key':undefined);
  }
});

test('a failed secret operation releases its queue and does not block other providers',async t=>{
  const directory=await temporary(t);const store=createSecretStore({directory,crypto:{...mockCrypto,async encryptStringAsync(value){if(value==='fail')throw new Error('locked keyring');return mockCrypto.encryptStringAsync(value);}}});
  await assert.rejects(store.set('first','fail'),/locked/);
  await Promise.all([store.set('first','recovered'),store.set('second','independent')]);
  assert.equal(await store.get('first'),'recovered');assert.equal(await store.get('second'),'independent');
});
