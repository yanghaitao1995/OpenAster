import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startServer } from '../server/index.mjs';
// Run in Playwright's setup process: no detached child server to orphan on Windows.
export default async function setup() {
  const dataDir=resolve('test-results',`e2e-data-${process.pid}-${Date.now()}`);
  await mkdir(dataDir,{recursive:true});
  await mkdir(resolve('test-results','screenshots'),{recursive:true});
  const workspace=join(dataDir,'workspace');
  const server=await startServer({port:4318,dataDir,workspace});
  await writeFile(resolve('test-results','e2e-server.json'),JSON.stringify({workspace,dataDir}));
  return async()=>{await server.close();};
}
