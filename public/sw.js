const CACHE='pathos-__BUILD__';
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  const response=await fetch('./asset-list.json',{cache:'no-store'});
  if(!response.ok)throw new Error('Asset list unavailable');
  await cache.addAll(await response.json());
})()));
// A waiting shell activates on the next app launch, never during a live game.
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if((key.startsWith('pathos-')||key.startsWith('story-vault-'))&&key!==CACHE)await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cached=await caches.match(event.request);
    if(cached)return cached;
    try{return await fetch(event.request);}catch(error){
      if(event.request.mode==='navigate')return await caches.match('./index.html');
      throw error;
    }
  })());
});
