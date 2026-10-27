import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('installing an app update fetches fresh assets instead of reusing an older HTTP cache',async()=>{
  const source=(await readFile(new URL('../public/sw.js',import.meta.url),'utf8')).replace('__BUILD__','next');
  const handlers=new Map(), installed=new Map();
  const origin='https://pathos.test/reader/';
  const assets=['./index.html','./style.css','./src/app.js'];
  const latest=new Map(assets.map(asset=>[new URL(asset,origin).href,`new ${asset}`]));
  const httpCache=new Map(assets.map(asset=>[new URL(asset,origin).href,`old ${asset}`]));
  const context=vm.createContext({URL,Request,
    self:{location:{origin:'https://pathos.test',href:origin+'sw.js'},addEventListener:(type,handler)=>handlers.set(type,handler)},
    caches:{async open(){return {async addAll(requests){
      for(const request of requests){
        const url=typeof request==='string'?new URL(request,origin).href:request.url;
        const content=request.cache==='reload'?latest.get(url):httpCache.get(url);
        installed.set(url,content);
      }
    }};}},
    fetch:async()=>({ok:true,json:async()=>assets}),
  });
  vm.runInContext(source,context);
  let installing;
  handlers.get('install')({waitUntil:result=>{installing=result;}});
  await installing;
  assert.deepEqual(installed,latest,'the new offline shell must contain the deployed HTML, CSS and JavaScript even while old HTTP responses are still fresh');
});

test('waiting app updates cannot mix new navigation HTML or assets into the active shell',async()=>{
  const source=(await readFile(new URL('../public/sw.js',import.meta.url),'utf8')).replace('__BUILD__','active');
  const handlers=new Map(), opened=[], network=[];
  const active=new Map([['./index.html','active HTML'],['https://pathos.test/src/app.js','active JavaScript']]);
  const context=vm.createContext({URL,
    self:{location:{origin:'https://pathos.test'},addEventListener:(type,handler)=>handlers.set(type,handler)},
    caches:{async open(name){opened.push(name);return {match:async request=>active.get(typeof request==='string'?request:request.url)};},match(){throw new Error('Must not search waiting-build caches.');}},
    fetch:async request=>{network.push(request.url);return 'network response';},
  });
  vm.runInContext(source,context);
  function fetch(request){let response;handlers.get('fetch')({request:{method:'GET',mode:'cors',...request},respondWith:result=>{response=result;}});return response;}
  assert.equal(await fetch({url:'https://pathos.test/',mode:'navigate'}),'active HTML','online navigation must not fetch newer HTML beside cached older scripts');
  assert.equal(await fetch({url:'https://pathos.test/?launch=again',mode:'navigate'}),'active HTML');
  assert.equal(await fetch({url:'https://pathos.test/src/app.js'}),'active JavaScript');
  assert.deepEqual(network,[]);
  assert.equal(await fetch({url:'https://pathos.test/uncached.svg'}),'network response');
  assert.equal(fetch({url:'https://other.test/game'}),undefined);
  assert.equal(fetch({url:'https://pathos.test/post',method:'POST'}),undefined);
  assert.ok(opened.every(name=>name==='pathos-active'));
});
