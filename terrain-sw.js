// Fonctionnement hors réseau : l'application et ses bibliothèques sont gardées en mémoire du téléphone.
const NOM = 'terrain-v1';
const COUCHE = [
  'terrain.html', 'terrain.webmanifest', 'terrain-192.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/layers-2x.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(NOM).then(c=>Promise.all(COUCHE.map(u=>c.add(new Request(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' })).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==NOM).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const r = e.request; if (r.method!=='GET') return;
  const u = new URL(r.url);
  const meme = u.origin===location.origin && /terrain/.test(u.pathname);
  const cdn = u.hostname==='cdnjs.cloudflare.com' || u.hostname==='cdn.jsdelivr.net';
  if (!meme && !cdn) return;                       // tuiles, base de données, etc. : jamais interceptés
  if (meme){                                       // l'application : réseau d'abord, mémoire si hors réseau
    e.respondWith(fetch(r).then(x=>{ const c = x.clone(); caches.open(NOM).then(k=>k.put(r,c)); return x; }).catch(()=>caches.match(r, { ignoreSearch:true })));
  } else {                                         // bibliothèques : mémoire d'abord
    e.respondWith(caches.match(r).then(m=>m || fetch(r).then(x=>{ const c = x.clone(); caches.open(NOM).then(k=>k.put(r,c)); return x; })));
  }
});
