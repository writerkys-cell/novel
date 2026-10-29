// 메모함 폰 — 서비스 워커. 페이지를 폰에 저장해 두어 인터넷이 없어도 바로 열리게 한다.
// 맥으로 보내는 요청(다른 주소)은 그대로 통과시킨다.
const CACHE = 'memobox-phone-v3';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './icon-360.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return; // 맥 서버 등 다른 곳은 손대지 않는다
  // 저장된 것을 먼저 내고, 뒤에서 새 판을 받아 둔다 (다음 열 때 반영)
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((r) => { if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; }).catch(() => hit);
      return hit || net;
    })
  );
});
