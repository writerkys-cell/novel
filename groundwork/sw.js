/* ============================================================
   서비스 워커 — 앱을 브라우저 안에 복사해 두어 인터넷 없이도 열리게 한다.

   새 판을 올릴 때는 아래 VERSION의 날짜만 바꾸면 됩니다.
   그러면 앱이 "새 판이 있습니다"라고 알려줍니다.
   ============================================================ */
const VERSION='2026-08-07a';
const APP='groundwork';                  /* 앱마다 다른 이름 */
const SHELL='shell-'+APP+'-'+VERSION;
const FONTS='fonts-v1';               /* 글꼴은 판이 바뀌어도 그대로 둔다 */

const ASSETS=[
  './','./index.html','./shell.js','./manifest.webmanifest',
  './icon-192.png','./icon-512.png','./icon-maskable.png'
];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(SHELL).then(c=>c.addAll(ASSETS)).catch(()=>{}));
});

self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.map(k=>{
      if(k===SHELL||k===FONTS) return null;
      if(k.startsWith('shell-'+APP+'-')) return caches.delete(k);  /* 지난 판만 지운다 */
      return null;
    }));
    await self.clients.claim();
  })());
});

/* 앱이 "새 판으로 바꿔라" 하면 그때 갈아 끼운다 — 사용자가 누르기 전에는 그대로 둔다 */
self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  let url;
  try{ url=new URL(req.url); }catch(err){ return; }

  /* 구글 글꼴 — 한 번 받아두면 계속 그것을 쓴다 */
  if(url.hostname.endsWith('googleapis.com')||url.hostname.endsWith('gstatic.com')){
    e.respondWith((async()=>{
      const c=await caches.open(FONTS);
      const hit=await c.match(req);
      if(hit) return hit;
      try{ const res=await fetch(req); if(res&&res.status<400) c.put(req,res.clone()); return res; }
      catch(err){ return new Response('',{status:504}); }
    })());
    return;
  }

  if(url.origin!==location.origin) return;

  e.respondWith((async()=>{
    const hit=await caches.match(req);
    if(hit) return hit;
    try{
      const res=await fetch(req);
      if(res&&res.status<400&&url.pathname.indexOf('/'+APP+'/')>=0){
        const c=await caches.open(SHELL); c.put(req,res.clone());
      }
      return res;
    }catch(err){
      const home=await caches.match('./index.html');
      if(home&&req.mode==='navigate') return home;
      return new Response('오프라인입니다',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
  })());
});
