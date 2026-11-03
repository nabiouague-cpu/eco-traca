// Fonctionnement hors réseau : l'application, ses bibliothèques et les images de carte déjà consultées sont gardées sur le téléphone.
const NOM = 'terrain-v2', TUILES = 'terrain-tuiles-v1', MAX_TUILES = 2500;
const COUCHE = [
  'terrain.html', 'terrain.webmanifest', 'terrain-192.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers-2x.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];
let compteur = 0;
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(NOM).then(c=>Promise.all(COUCHE.map(u=>c.add(new Request(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' })).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==NOM && k!==TUILES).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
async function tuile(r){
  const c = await caches.open(TUILES), m = await c.match(r);
  if (m) return m;
  try {
    const x = await fetch(r);
    if (x.ok && x.type!=='opaque'){
      c.put(r, x.clone());
      if (++compteur % 50 === 0){ const ks = await c.keys(); for (let i=0; i<ks.length-MAX_TUILES; i++) await c.delete(ks[i]); }
    }
    return x;
  } catch(err){ return Response.error(); }
}
self.addEventListener('fetch', e=>{
  const r = e.request; if (r.method!=='GET') return;
  const u = new URL(r.url);
  if (u.hostname==='server.arcgisonline.com' || u.hostname==='tile.openstreetmap.org'){ e.respondWith(tuile(r)); return; }
  const meme = u.origin===location.origin && /terrain/.test(u.pathname);
  const cdn = u.hostname==='cdnjs.cloudflare.com' || u.hostname==='cdn.jsdelivr.net';
  if (!meme && !cdn) return;                       // base de données, etc. : jamais interceptés
  if (meme){
    e.respondWith(fetch(r).then(x=>{ const c = x.clone(); caches.open(NOM).then(k=>k.put(r,c)); return x; }).catch(()=>caches.match(r, { ignoreSearch:true })));
  } else {
    e.respondWith(caches.match(r).then(m=>m || fetch(r).then(x=>{ const c = x.clone(); caches.open(NOM).then(k=>k.put(r,c)); return x; })));
  }
});
