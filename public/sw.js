const CACHE='pathos-__BUILD__';
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  const response=await fetch('./asset-list.json',{cache:'no-store'});
  if(!response.ok)throw new Error('Asset list unavailable');
  // Fixed asset URLs may still be fresh in the HTTP cache after a deployment.
  // Fetch this build from the network instead of caching older scripts/styles
  // alongside its new HTML, then keep serving the complete shell offline.
  const assets=await response.json();
  await cache.addAll(assets.map(asset=>new Request(new URL(asset,self.location.href),{cache:'reload'})));
})()));
// A waiting shell activates on the next app launch, never during a live game.
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if((key.startsWith('pathos-')||key.startsWith('story-vault-'))&&key!==CACHE)await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    // A waiting update may already have its own cache. Keep this shell's HTML,
    // scripts and styles together until that worker activates on the next launch.
    const cache=await caches.open(CACHE);
    const response=await cache.match(event.request)||(event.request.mode==='navigate'?await cache.match('./index.html'):null)||await fetch(event.request);
    // Hosting can redirect index.html to /. Safari rejects that redirect history
    // on cached PWA navigations; a fresh response keeps the final page and headers.
    return event.request.mode==='navigate'&&response.redirected
      ?new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers})
      :response;
  })());
});
