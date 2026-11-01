import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';

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
  const handlers=new Map(), opened=[], network=[];let offline=false;
  const active=new Map([['./index.html','active HTML'],['https://pathos.test/src/app.js','active JavaScript']]);
  const context=vm.createContext({URL,
    self:{location:{origin:'https://pathos.test'},addEventListener:(type,handler)=>handlers.set(type,handler)},
    caches:{async open(name){opened.push(name);return {match:async request=>active.get(typeof request==='string'?request:request.url)};},match(){throw new Error('Must not search waiting-build caches.');}},
    fetch:async request=>{network.push(request.url);if(offline)throw new Error('offline');return 'network response';},
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
  offline=true;
  assert.equal(await fetch({url:'https://pathos.test/',mode:'navigate'}),'active HTML');
  active.delete('./index.html');
  await assert.rejects(fetch({url:'https://pathos.test/',mode:'navigate'}),/offline/,'a missing shell propagates the network failure instead of returning an undefined response');
});

test('PWA navigations remove redirect history from cached and network HTML while preserving content',async t=>{
  const html='<!doctype html><title>PathOS</title><p>Your stories — 灯台</p>';
  const server=createServer((request,response)=>{
    if(request.url==='/index.html'){response.writeHead(302,{Location:'/'});response.end();return;}
    response.writeHead(200,'Story shell',{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"frame-src 'self' blob: data:",'Cache-Control':'no-cache'});
    response.end(html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const redirected=await fetch(origin+'/index.html'), plain=await fetch(origin+'/');
  assert.equal(redirected.redirected,true,'precache follows the host’s canonical index redirect');
  assert.equal(redirected.clone().redirected,true,'cloning a cached response alone does not fix WebKit navigation');
  const cached=new Map([['./index.html',redirected]]), handlers=new Map(), network=[];
  let networkResponse=redirected;
  const source=(await readFile(new URL('../public/sw.js',import.meta.url),'utf8')).replace('__BUILD__','redirect-fix');
  vm.runInNewContext(source,{URL,Response,
    self:{location:{origin},addEventListener:(type,handler)=>handlers.set(type,handler)},
    caches:{async open(){return {match:async request=>cached.get(typeof request==='string'?request:request.url)?.clone()};}},
    fetch:async request=>{network.push(request.url);return networkResponse.clone();},
  });
  function serve(url,mode='navigate'){
    let result;handlers.get('fetch')({request:{method:'GET',mode,redirect:'manual',url},respondWith:response=>{result=response;}});return result;
  }
  async function verify(response){
    assert.equal(response.redirected,false,'WebKit must receive a response with no followed redirects');
    assert.equal(response.status,200);assert.equal(response.statusText,'Story shell');
    assert.equal(response.headers.get('Content-Type'),'text/html; charset=utf-8');
    assert.equal(response.headers.get('Content-Security-Policy'),"frame-src 'self' blob: data:");
    assert.equal(response.headers.get('Cache-Control'),'no-cache');
    assert.equal(await response.text(),html);
  }
  await verify(await serve(origin+'/'));
  await verify(await serve(origin+'/?launch=standalone'));
  cached.set(origin+'/index.html',redirected);
  await verify(await serve(origin+'/index.html'));
  assert.deepEqual(network,[],'cached launches stay offline and do not fetch newer shell HTML');
  assert.equal(cached.get('./index.html').bodyUsed,false,'reading a cache match must not consume the stored shell');
  cached.clear();
  await verify(await serve(origin+'/index.html'));
  assert.deepEqual(network,[origin+'/index.html'],'the same normalization also covers followed network responses');
  networkResponse=plain;
  const unchanged=await serve(origin+'/');
  assert.equal(unchanged.url,plain.url,'unredirected responses keep their existing metadata');
  networkResponse=redirected;
  assert.equal((await serve(origin+'/asset','cors')).redirected,true,'asset responses are not navigation responses');
  networkResponse=Response.redirect(origin+'/',302);
  const redirect=await serve(origin+'/index.html');
  assert.equal(redirect.status,302,'an unfollowed HTTP redirect must remain a redirect');
  assert.equal(redirect.headers.get('Location'),origin+'/');
});
