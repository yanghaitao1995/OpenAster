// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDesktopExecutable } from './desktop-smoke-staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = { win32: 'release/win-unpacked/OpenAster.exe', darwin: 'release/mac/OpenAster.app/Contents/MacOS/OpenAster', linux: 'release/linux-unpacked/openaster' };
const argumentsList=process.argv.slice(2);
const originalExecutable = path.resolve(argumentsList.find(arg=>!arg.startsWith('--')) || path.join(root, defaults[process.platform] || ''));
let executable=originalExecutable;
if (!defaults[process.platform]) throw new Error('Unsupported desktop smoke platform');
const temporaryRoot = await realpath(tmpdir());
const directory = await mkdtemp(path.join(temporaryRoot, 'openaster-smoke-'));
const owner = randomBytes(32).toString('hex');
await writeFile(path.join(directory, '.smoke-owner'), owner, { mode: 0o600, flag: 'wx' });
let output = '';
let timer;
let code;
let binaryDirectory;
try {
  if(argumentsList.includes('--stage')) {
    binaryDirectory=await mkdtemp(path.join(temporaryRoot,'openaster-binary-'));
    await writeFile(path.join(binaryDirectory,'.smoke-owner'),owner,{mode:0o600,flag:'wx'});
    ({ executable } = await stageDesktopExecutable({ executable: originalExecutable, directory: binaryDirectory, owner }));
  }
  const env = { ...process.env, OPENASTER_SMOKE_DATA_DIR: directory, OPENASTER_SMOKE_OWNER: owner };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  code = await new Promise((resolve, reject) => {
    const launchArguments=[...(argumentsList.includes('--source')?[path.join(root,'desktop/main.mjs')]:[]),'--smoke-test',...(argumentsList.includes('--backup')?['--backup-smoke-test']:[]),...(argumentsList.includes('--software-rendering')?['--disable-gpu']:[])];
    const child = spawn(executable, launchArguments, { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const receive = chunk => { output = `${output}${chunk}`.slice(-65536); };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    timer = setTimeout(() => { child.kill(); }, argumentsList.includes('--backup') ? 60000 : 35000);
    child.on('error', reject);
    child.on('close', resolve);
  });
  const resultLine = output.split(/\r?\n/).find(line => line.startsWith('OPENASTER_SMOKE_RESULT '));
  if (!resultLine) throw new Error(`Desktop smoke exited ${code} without a result. ${output.slice(-3000)}`);
  const result = JSON.parse(resultLine.slice('OPENASTER_SMOKE_RESULT '.length));
  if (code !== 0 || !result.ok) throw new Error(`Desktop smoke failed: ${JSON.stringify(result)}\n${output.slice(-4000)}`);
  console.log(JSON.stringify({ executable, ...result }));
} finally {
  clearTimeout(timer);
  // Delete only the directory created by this invocation, after validating its real parent and owner marker.
  const canonical = await realpath(directory);
  if (path.dirname(canonical) !== temporaryRoot || !/^openaster-smoke-[a-zA-Z0-9]+$/.test(path.basename(canonical))) throw new Error('Refusing unsafe smoke cleanup');
  if (await readFile(path.join(canonical, '.smoke-owner'), 'utf8') !== owner) throw new Error('Smoke ownership marker changed; refusing cleanup');
  await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if(binaryDirectory) {
    const binaryReal=await realpath(binaryDirectory);
    if(path.dirname(binaryReal)!==temporaryRoot||!/^openaster-binary-[a-zA-Z0-9]+$/.test(path.basename(binaryReal))||await readFile(path.join(binaryReal,'.smoke-owner'),'utf8')!==owner)throw new Error('Refusing unsafe binary cleanup');
    await rm(binaryReal,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
