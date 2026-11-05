import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

// Uses generated synthetic records only; never benchmarks the user's own conversations.
const dir=await mkdtemp(join(tmpdir(),'openaster-benchmark-'));
let app;
try {
  const seed=new Store(dir);
  for(let n=0;n<500;n++) {
    const session=seed.createSession({title:`Synthetic task ${n}`});
    session.messages=[{id:`message-${n}`,role:'user',content:'Synthetic local test. '.repeat(800),createdAt:session.createdAt}];
    seed.putSession(session);
  }
  seed.close();
  const bootStart=performance.now();app=await startServer({dataDir:dir});const startupMs=performance.now()-bootStart;
  const bootstrap=await fetch(`${app.url}/api/bootstrap`);const cookie=bootstrap.headers.get('set-cookie').split(';')[0];await bootstrap.arrayBuffer();
  const latencies=[];let responseBytes=0;
  for(let n=0;n<80;n++) {
    const start=performance.now();const response=await fetch(`${app.url}/api/state`,{headers:{cookie}});
    if(!response.ok)throw new Error(`Unexpected benchmark HTTP ${response.status}`);
    const bytes=await response.arrayBuffer();responseBytes=bytes.byteLength;latencies.push(performance.now()-start);
  }
  latencies.sort((a,b)=>a-b);
  const result={measuredAt:new Date().toISOString(),environment:{node:process.version,os:`${platform()} ${release()}`,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryGiB:Number((totalmem()/2**30).toFixed(1))},scenario:{sessions:500,charactersPerSession:16800,requests:80,provider:'none — no model calls',transport:'loopback HTTP',client:'Node fetch',note:'Warm HTTP session after one bootstrap; not a cloud-model latency or desktop memory benchmark.'},startupMs:Number(startupMs.toFixed(2)),state:{p50Ms:Number(latencies[39].toFixed(2)),p95Ms:Number(latencies[75].toFixed(2)),maxMs:Number(latencies[79].toFixed(2)),responseBytes},processMemoryMiB:{rss:Number((process.memoryUsage().rss/2**20).toFixed(2)),heapUsed:Number((process.memoryUsage().heapUsed/2**20).toFixed(2))}};
  const output=resolve('docs/benchmark-result.json');await mkdir(resolve('docs'),{recursive:true});await writeFile(output,`${JSON.stringify(result,null,2)}\n`);console.log(JSON.stringify(result,null,2));
} finally {await app?.close();await rm(dir,{recursive:true,force:true});}
