/* Service worker: shows push notifications and opens the right page when one is tapped. It never caches or intercepts pages. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'eazystores', body: e.data ? e.data.text() : '' }; }
  const url = typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : '/';
  e.waitUntil(self.registration.showNotification(String(d.title || 'eazystores').slice(0, 80), { body: String(d.body || '').slice(0, 140), tag: d.tag ? String(d.tag) : undefined, data: { url } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { for (const c of list) if (c.url === target && 'focus' in c) return c.focus(); return self.clients.openWindow(target); }));
});
