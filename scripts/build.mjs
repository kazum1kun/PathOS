import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'dist'), { recursive: true });
await cp(path.join(root, 'src'), path.join(root, 'dist/src'), { recursive: true });
await cp(path.join(root, 'public'), path.join(root, 'dist'), { recursive: true });
const assets=[];
async function walk(dir,prefix='') {
  for (const e of await readdir(dir,{withFileTypes:true})) {
    const relative=prefix+e.name;
    if(e.isDirectory()) await walk(path.join(dir,e.name),relative+'/');
    else if(!['sw.js','asset-list.json','_headers'].includes(relative)) assets.push('./'+relative);
  }
}
await walk(path.join(root,'dist'));
await writeFile(path.join(root,'dist/asset-list.json'),JSON.stringify(assets));
const files=await Promise.all(assets.map(x=>readFile(path.join(root,'dist',x))));
const { createHash }=await import('node:crypto');
const hash=createHash('sha256');files.forEach(f=>hash.update(f));
const sw=await readFile(path.join(root,'public/sw.js'),'utf8');
await writeFile(path.join(root,'dist/sw.js'),sw.replace('__BUILD__',hash.digest('hex').slice(0,16)));
console.log(`Built ${assets.length} static files; no server or build dependencies required.`);
