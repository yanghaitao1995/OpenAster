import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root=process.cwd();
const file=path.join(root,'docs','dependency-licenses.json');
const groups=JSON.parse(await readFile(file,'utf8'));
if(groups.error)throw new Error('License inventory contains an error, not dependency data');
const components=[];
for(const [expression,entries]of Object.entries(groups))for(const entry of entries){
  entry.paths=entry.paths?.map(value=>path.isAbsolute(value)?path.relative(root,value).split(path.sep).join('/'):value);
  for(const version of entry.versions){
    const purl=`pkg:npm/${entry.name.startsWith('@')?`%40${entry.name.slice(1)}`:entry.name}@${version}`;
    components.push({type:'library','bom-ref':purl,name:entry.name,version,purl,licenses:[{expression}],scope:'optional',description:entry.description});
  }
}
components.sort((a,b)=>a['bom-ref'].localeCompare(b['bom-ref']));
const pkg=JSON.parse(await readFile('package.json','utf8'));
const result={bomFormat:'CycloneDX',specVersion:'1.5',serialNumber:`urn:uuid:${randomUUID()}`,version:1,metadata:{timestamp:new Date().toISOString(),component:{type:'application',name:pkg.name,version:pkg.version},properties:[{name:'openaster:scope',value:'Installed npm development/build/test dependencies. Does not enumerate the separate bundled Chromium/Node native components; retain Electron LICENSE and LICENSES.chromium.html.'}]},components};
await writeFile(file,`${JSON.stringify(groups,null,2)}\n`);
await writeFile('docs/sbom.cdx.json',`${JSON.stringify(result,null,2)}\n`);
console.log(`Wrote local CycloneDX inventory for ${components.length} installed npm components; absolute paths removed.`);
