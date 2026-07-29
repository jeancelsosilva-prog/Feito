// Service Worker do "Feito?". Responsável por: cache do app shell (para funcionar offline),
// recebimento de Web Push, e abrir a tarefa certa ao tocar na notificação.
//
// IMPORTANTE: suba o número de CACHE_VERSION sempre que publicar mudanças nos arquivos
// estáticos. É isso que faz o Safari perceber que há uma versão nova do Service Worker.
const CACHE_VERSION = 'feito-v6';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// Caminhos relativos ao próprio sw.js — funcionam tanto em domínio raiz quanto em
// usuario.github.io/nome-do-repo/, porque o navegador resolve relativo à localização do SW.
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/theme-init.js',
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
      // Assume o controle assim que instalar, sem esperar. Antes o app mostrava um banner
      // "Atualizar agora" que dependia de skipWaiting() ser disparado pela página — e no
      // Safari em modo PWA isso simplesmente não funciona de forma confiável: o worker novo
      // ficava esperando para sempre e o banner nunca sumia. Atualizar sozinho é mais
      // simples e não tem estado travado possível.
      .then(() => self.skipWaiting())
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

// Estratégia de busca. Passthrough total para a API (nunca cacheamos respostas da API —
// dados de tarefas precisam ser sempre frescos).
//
// Para o código do app (HTML, JS, CSS, manifest): NETWORK-FIRST, com o cache apenas como
// reserva para quando não há internet. Antes era cache-first, e isso causou o pior bug
// desta fase de testes: cada arquivo era atualizado de forma independente, então o app
// podia rodar um app.js de uma versão junto com um config.js de outra. Um Frankenstein
// assim é praticamente impossível de depurar — a versão exibida em Ajustes dizia uma
// coisa e o comportamento era de outra. Com network-first, ou tudo é novo, ou tudo é o
// que estava salvo para uso offline.
//
// Para imagens/ícones: cache-first continua sendo o certo — são grandes e não mudam.
const CODE_EXTENSIONS = /\.(html|js|css|webmanifest)$/i;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // deixa a API seguir seu fluxo normal

  const isCode = event.request.mode === 'navigate'
    || CODE_EXTENSIONS.test(url.pathname)
    || url.pathname.endsWith('/');

  if (isCode) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
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
  let payload = { title: 'Tarefa pendente', body: 'Toque para abrir o Feito?.' };
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
    // `silent: false` pede explicitamente som+vibração. No iPhone quem decide o som é o
    // sistema (Ajustes → Notificações → Feito? → Sons); a web não pode escolher o toque.
    // O que podemos garantir é não pedir uma notificação silenciosa.
    silent: false,
    vibrate: [180, 90, 180],
    data: { taskId, url: payload.url || null },
    timestamp: payload.timestamp || Date.now()
  };

  event.waitUntil(self.registration.showNotification(payload.title || 'Tarefa pendente', options));

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

// --------------------------- Atualização ---------------------------
// Não há mais banner "Atualizar agora": a versão nova assume sozinha (skipWaiting no
// install + clients.claim no activate) e o app recarrega discretamente quando volta ao
// primeiro plano. A mensagem abaixo fica só por compatibilidade, caso uma aba antiga
// ainda esteja aberta e envie o pedido.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
