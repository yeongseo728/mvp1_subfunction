// 집콕체크 오프라인 파일 (2026-11-21, 구글 플레이 출시 준비)
// 앱으로 설치했을 때 인터넷이 잠깐 끊겨도 첫 화면이 열리게 해요.
// 화면과 파일은 늘 새로 받아 오고(고친 내용이 바로 보이게), 인터넷이 끊겼을 때만 저장해 둔 것을 보여 줘요.
// AI·조회(/api)와 방문자 통계(/_vercel)는 저장하지 않아요. 사용자 답은 원래처럼 브라우저 저장소에만 있어요.
const CACHE = 'zipkok-v1';
const SHELL = ['/', '/favicon.svg', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/privacy.html', '/data/dong-xy.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== location.origin) return;
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/_vercel/')) return;
  const page = req.mode === 'navigate';
  const key = page ? '/' : req;
  e.respondWith(
    fetch(req).then(res => {
      if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || (page ? caches.match('/') : Response.error())))
  );
});

// 계약 케어 알림 (2026-11-28): 서버가 보낸 알림을 보여 주고, 누르면 앱(계약 케어)을 열어요
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(x) {}
  e.waitUntil(self.registration.showNotification(d.title || '집콕체크', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag || 'care', data: {url: d.url || '/'}
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for(const c of list){ if('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
