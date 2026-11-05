import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateAndroidNoticeAsset, readAndroidNoticeAsset } from './notice-assets.mjs';
const packageInfo={devDependencies:{'@capacitor/android':'8.5.3','@capacitor/core':'8.5.3'}};
const sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(){return {schemaVersion:1,platform:'android',licenses:[{id:'MIT',text:'Fixture license\n',sha256:sha('Fixture license\n')}],components:['@capacitor/android','@capacitor/core'].map(name=>({id:name,name,version:'8.5.3',kind:'npm',licenseIds:['MIT'],notices:[]})),counts:{components:2}};}
const encode=value=>Buffer.from(JSON.stringify(value));
test('mobile notices reject changed text, missing references and stale Capacitor versions',()=>{
 const asset=fixture();assert.equal(validateAndroidNoticeAsset(encode(asset),packageInfo).components.length,2);
 asset.licenses[0].text+='changed';assert.throws(()=>validateAndroidNoticeAsset(encode(asset),packageInfo),/changed license/);
 asset.licenses[0].sha256=sha(asset.licenses[0].text);asset.components[0].licenseIds=['absent'];assert.throws(()=>validateAndroidNoticeAsset(encode(asset),packageInfo),/license reference/);
 asset.components[0].licenseIds=['MIT'];asset.components[0].version='9.0.0';assert.throws(()=>validateAndroidNoticeAsset(encode(asset),packageInfo),/regenerate/);
});
test('mobile notices reject malformed and oversized documents before preparation',()=>{
 for(const bytes of [Buffer.from([255]),Buffer.from('{}'),Buffer.alloc(2*1024*1024+1)])assert.throws(()=>validateAndroidNoticeAsset(bytes,packageInfo),/Android notice asset/);
 const asset=fixture();asset.components[1]=structuredClone(asset.components[0]);assert.throws(()=>validateAndroidNoticeAsset(encode(asset),packageInfo),/invalid component/);
});
test('checked-in Android notice bytes are validated and preserved exactly',async()=>{
 const source=new URL('./notices/android-notices.json',import.meta.url);
 const bytes=await readAndroidNoticeAsset(source,new URL('../package.json',import.meta.url));
 assert.deepEqual(bytes,await readFile(source));
 const asset=JSON.parse(bytes);assert.ok(asset.licenses.find(x=>x.id==='Apache-2.0'));assert.ok(asset.licenses.find(x=>x.id==='MIT'));
});
