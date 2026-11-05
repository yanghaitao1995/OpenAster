const CACHE = 'openaster-shell-v41';
const SHELL = ['./', './index.html', './app.js', './model-picker.mjs', './execution-flow.mjs', './image-input.mjs', './android-notices-ui.mjs', './theme.mjs', './composer-drafts.mjs', './draft-session.mjs', './composer-draft-ui.mjs', './file-editor-ui.mjs', './file-editor-text.mjs', './styles.css', './workbench.css', './command-palette.js', './command-palette.css', './markdown.js', './gateway.mjs', './text-diff.mjs', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('openaster-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (!SHELL.some(path => new URL(path, self.registration.scope).pathname === url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; }).catch(() => caches.match(event.request)));
});


