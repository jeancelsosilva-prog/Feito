// Service Worker do "Feito?". Responsável por: cache do app shell (funciona offline),
// recebimento de Web Push, abrir a tarefa certa ao tocar na notificação, e o fluxo de
// atualização ("Tem uma versão nova pronta").
//
// IMPORTANTE: suba o número de CACHE_VERSION sempre que publicar mudanças nos arquivos
// estáticos. É isso que faz o Safari perceber que há uma versão nova do Service Worker.
const CACHE_VERSION = 'feito-v4';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// Caminhos relativos ao próprio sw.js — funcionam tanto em domínio raiz quanto em
// usuario.github.io/nome-do-repo/, porque o navegador resolve relativo à localização do SW.
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/config.js',
  './js/db.js',
  './js/api.js',
  './js/push.js',
  './js/platform.js',
  './js/utils/time.js',
  './js/utils/sanitize.js',
  './js/modules/registry.js',
  './js/modules/laundry.js',
  './js/ui/components.js',
  './js/ui/onboarding.js',
  './js/ui/today.js',
  './js/ui/taskSheet.js',
  './js/ui/history.js',
  './js/ui/settings.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // `cache: 'reload'` obriga a buscar da rede, ignorando o cache HTTP do navegador.
      // Sem isso, o Safari pode "atualizar" o app shell com cópias antigas dos mesmos
      // arquivos e a versão nova entra em vigor sem realmente conter as mudanças.
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('feito-') && key !== STATIC_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Estratégia: network-first para navegação/HTML (pega atualizações rápido), cache-first
// para o resto do app shell, e passthrough total para a API (nunca cacheamos respostas
// da API — dados de tarefas precisam ser sempre frescos ou explicitamente tratados como
// "não sincronizado" pela UI).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // deixa a API seguir seu fluxo normal

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// --------------------------- Web Push ---------------------------

self.addEventListener('push', (event) => {
  let payload = { title: 'Feito?', body: 'Você tem uma tarefa pendente.' };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // payload não veio em JSON válido — usa o fallback genérico acima.
  }

  const taskId = payload.taskId || null;
  const tag = payload.tag || (taskId ? `feito-task-${taskId}` : 'feito-generic');

  const options = {
    body: payload.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag,
    renotify: true,
    data: { taskId, url: payload.url || null },
    timestamp: payload.timestamp || Date.now()
  };

  event.waitUntil(self.registration.showNotification(payload.title || 'Feito?', options));

  // Badge da PWA: soma otimista de 1 — o app corrige o número exato assim que reabrir
  // (feature detection: nem todo navegador tem setAppBadge).
  if (self.navigator && 'setAppBadge' in self.navigator) {
    self.navigator.setAppBadge().catch(() => {});
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data && event.notification.data.taskId;

  // Constrói a URL de destino relativa ao escopo do próprio Service Worker — assim
  // funciona igual em domínio raiz ou em usuario.github.io/nome-do-repo/.
  const targetUrl = new URL(
    taskId ? `./index.html?task=${encodeURIComponent(taskId)}` : './index.html',
    self.registration.scope
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          client.postMessage({ type: 'OPEN_TASK', taskId });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

// --------------------------- Atualização sob demanda ---------------------------
// app.js detecta um SW "waiting" e mostra o banner "Tem uma versão nova pronta". Ao
// tocar em "Atualizar agora", ele manda esta mensagem, e SÓ ENTÃO chamamos skipWaiting —
// nunca automaticamente, para não recarregar o app no meio de uma edição de tarefa.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
