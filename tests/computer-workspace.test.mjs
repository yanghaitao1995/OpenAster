// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace } from '../core/workspace.mjs';
import { createComputerWorkspace } from '../core/computer-workspace.mjs';
import { createCommandRunner } from '../core/command-runner.mjs';
import { validateCommand } from '../core/command-schema.mjs';

async function fixture(t) {
  const parent=path.resolve('test-results');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'computer-access-'));
  assert.equal(path.dirname(root),parent);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const local=path.join(root,'project'),external=path.join(root,'outside'),protectedRoot=path.join(root,'private-data');
  for(const directory of [local,external,protectedRoot])await fs.mkdir(directory);
  await fs.writeFile(path.join(local,'local.txt'),'local');
  await fs.writeFile(path.join(external,'note.txt'),'outside original');
  await fs.writeFile(path.join(protectedRoot,'private.txt'),'must not be read');
  let access='workspace';
  const workspace=createWorkspace(local,{createRoot:false});
  const adapter=createComputerWorkspace({workspace,getFileAccess:()=>access,protectedRoots:[protectedRoot]});
  return {root,local,external,protectedRoot,adapter,setAccess:value=>{access=value;}};
}

test('absolute external file access needs a human grant; inside absolute paths map to the workspace',async t=>{
  const f=await fixture(t);
  assert.equal((await f.adapter.read('local.txt')).content,'local');
  assert.equal((await f.adapter.read(path.join(f.local,'local.txt'))).path,'local.txt');
  await assert.rejects(f.adapter.read(path.join(f.external,'note.txt')),{code:'COMPUTER_ACCESS_REQUIRED'});
  f.setAccess('computer');
  const outside=await f.adapter.read(path.join(f.external,'note.txt'));
  assert.equal(outside.content,'outside original');assert.equal(outside.path,path.join(f.external,'note.txt'));
  assert.match(f.adapter.permissionSummary(),/Python, git/u);
  f.setAccess('workspace');
  await assert.rejects(f.adapter.read(path.join(f.external,'note.txt')),{code:'COMPUTER_ACCESS_REQUIRED'});
});

test('external write stays a one-use immutable approval and checks grant again at commit',async t=>{
  const f=await fixture(t);f.setAccess('computer');
  const location=path.join(f.external,'note.txt');
  const proposal=await f.adapter.prepareWrite({path:location,content:'approved replacement'});
  assert.equal(proposal.path,location);assert.equal(proposal.originalContent,'outside original');assert.ok(Object.isFrozen(proposal));
  assert.equal(await fs.readFile(location,'utf8'),'outside original');
  f.setAccess('workspace');await assert.rejects(f.adapter.commitWrite(proposal),{code:'COMPUTER_ACCESS_REQUIRED'});
  assert.equal(await fs.readFile(location,'utf8'),'outside original');
  f.setAccess('computer');
  const next=await f.adapter.prepareWrite({path:location,content:'approved replacement'});
  const result=await f.adapter.commitWrite(next);assert.equal(result.path,location);
  assert.equal(await fs.readFile(location,'utf8'),'approved replacement');
  await assert.rejects(f.adapter.commitWrite(next),{code:'INVALID_APPROVAL'});
});

test('external edits retain hash conflicts and exact replacement, and may create approved parents',async t=>{
  const f=await fixture(t);f.setAccess('computer');const location=path.join(f.external,'note.txt');
  const read=await f.adapter.read(location);
  const edit=await f.adapter.prepareEdit({path:location,oldText:'original',newText:'edited',expectedHash:read.sha256});
  await f.adapter.commitWrite(edit);assert.equal(await fs.readFile(location,'utf8'),'outside edited');
  await assert.rejects(f.adapter.prepareEdit({path:location,oldText:'edited',newText:'stale',expectedHash:read.sha256}),{code:'WRITE_CONFLICT'});
  const nested=path.join(f.external,'new','folder','note.txt');
  const proposal=await f.adapter.prepareWrite({path:nested,content:'new'});
  await assert.rejects(fs.stat(path.dirname(nested)),{code:'ENOENT'});
  await f.adapter.commitWrite(proposal);assert.equal(await fs.readFile(nested,'utf8'),'new');
});

test('global browsing is shallow; protected data, credentials, links and traversal remain unavailable',async t=>{
  const f=await fixture(t);f.setAccess('computer');
  await fs.mkdir(path.join(f.external,'nested'));await fs.writeFile(path.join(f.external,'nested','deep.txt'),'deep');
  await fs.writeFile(path.join(f.external,'.env'),'do not read');
  const result=await f.adapter.list({path:f.external});
  assert.equal(result.listing,'children');assert.equal(result.scope,f.external);
  assert.ok(result.files.some(file=>file.path===path.join(f.external,'note.txt')));
  assert.ok(!result.files.some(file=>file.path.endsWith('deep.txt')));
  await assert.rejects(f.adapter.read(path.join(f.protectedRoot,'private.txt')),{code:'PROTECTED_PATH'});
  await assert.rejects(f.adapter.read(path.join(f.external,'.env')),{code:'PROTECTED_PATH'});
  await assert.rejects(f.adapter.read(f.external+path.sep+'..'+path.sep+'private-data'+path.sep+'private.txt'),{code:'INVALID_PATH'});
  await assert.rejects(f.adapter.search('must',{path:f.root}),{code:'SEARCH_SCOPE_REQUIRED'});
  const listing=await f.adapter.list({path:f.root});assert.ok(!listing.files.some(file=>file.path===f.protectedRoot));
  assert.equal(listing.excludedProtectedEntries,1);
  await fs.link(path.join(f.external,'note.txt'),path.join(f.external,'hard.txt'));
  await assert.rejects(f.adapter.read(path.join(f.external,'hard.txt')),{code:'UNSAFE_PATH'});
  await fs.symlink(f.protectedRoot,path.join(f.external,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.adapter.read(path.join(f.external,'linked','private.txt')),{code:'PROTECTED_PATH'});
});

test('absolute shell cwd uses the same grant and directory identity gate',async t=>{
  const f=await fixture(t);const runner=createCommandRunner({workspace:f.adapter});
  const args={command:process.platform==='win32'?'Write-Output ready':'printf ready',cwd:f.external};
  await assert.rejects(runner.prepare(args),{code:'COMPUTER_ACCESS_REQUIRED'});
  f.setAccess('computer');const proposal=await runner.prepare(args);assert.equal(proposal.cwd,f.external);
  assert.equal(validateCommand(proposal).cwd,f.external);
  f.setAccess('workspace');await assert.rejects(runner.execute(proposal),{code:'COMPUTER_ACCESS_REQUIRED'});
  f.setAccess('computer');
  const fresh=await runner.prepare(args);await fs.rename(f.external,f.external+'-old');await fs.mkdir(f.external);
  await assert.rejects(runner.execute(fresh),{code:'COMMAND_DIRECTORY_CHANGED'});
});
