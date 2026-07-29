// Orquestrador do app: decide qual tela mostrar, registra o Service Worker, mantém a
// tela "Hoje" sincronizada com o backend, e liga os três estados de onboarding descritos
// na seção 3 do briefing ao app principal (seção 4).

import { getPlatformSnapshot } from './platform.js';
import { setOnboardingSeenSync } from './db.js';
import { cacheTasksReplace, cacheTasksGetAll } from './db.js';
import { ensureInstallation, api } from './api.js';
import { activateNotifications, isPushSubscribed } from './push.js';
import { wireInstallScreen } from './ui/onboarding.js';
import { renderToday } from './ui/today.js';
import { renderHistory } from './ui/history.js';
import { renderSettings, checkHomeArrivalIfConfigured } from './ui/settings.js';
import { toast } from './ui/components.js';

const screens = {
  loading: document.getElementById('screen-loading'),
  install: document.getElementById('screen-install'),
  main: document.getElementById('screen-main')
};

let currentActiveTasks = [];
let currentTab = 'today';

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
}

function setGlobalBanner(message, kind) {
  const banner = document.getElementById('global-banner');
  if (!message) {
    banner.hidden = true;
    banner.textContent = '';
    banner.className = 'global-banner';
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
  banner.className = `global-banner${kind ? ` is-${kind}` : ''}`;
}

function updateOfflineBadge() {
  document.getElementById('offline-badge').hidden = navigator.onLine;
  if (!navigator.onLine) {
    setGlobalBanner('Você está offline. O que já foi carregado continua visível, mas ações novas exigem conexão.', 'warning');
  } else {
    setGlobalBanner(null);
  }
}

async function updateBadge() {
  const count = currentActiveTasks.filter((t) => t.status === 'scheduled' || t.status === 'reminding').length;
  if ('setAppBadge' in navigator) {
    try {
      if (count > 0) await navigator.setAppBadge(count);
      else await navigator.clearAppBadge();
    } catch { /* Badging API pode falhar silenciosamente em alguns contextos — não é crítico. */ }
  }
}

async function refreshTasksAndRender({ silent = false } = {}) {
  const result = await api.listActiveTasks();
  if (result.ok) {
    currentActiveTasks = result.data.tasks;
    await cacheTasksReplace(currentActiveTasks);
    if (!silent) setGlobalBanner(null);
  } else if (!result.offline) {
    // Backend respondeu com erro (não é só "sem internet") — avisa sem travar a UI.
    if (!silent) setGlobalBanner('Não foi possível falar com o servidor agora. Mostrando os últimos dados salvos.', 'warning');
    currentActiveTasks = await cacheTasksGetAll();
  } else {
    currentActiveTasks = await cacheTasksGetAll();
  }

  renderCurrentTab();
  updateBadge();
}

function renderCurrentTab() {
  if (currentTab === 'today') {
    renderToday(document.getElementById('today-content'), {
      tasks: currentActiveTasks,
      isOnline: navigator.onLine,
      onTasksChanged: () => refreshTasksAndRender()
    });
  } else if (currentTab === 'history') {
    renderHistory(document.getElementById('tab-history'));
  } else if (currentTab === 'settings') {
    renderSettings(document.getElementById('settings-content'), {
      onResetApp: () => {
        setOnboardingSeenSync(false);
        window.location.reload();
      }
    });
  }
}

function wireTabBar() {
  document.querySelectorAll('.tab-bar-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab-target');
      if (target === currentTab) return;
      currentTab = target;

      document.querySelectorAll('.tab-bar-btn').forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('is-active', isActive);
        if (isActive) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-tab') !== target;
      });

      renderCurrentTab();
    });
  });
}

// --------------------------- Ativação de lembretes (in-app) ---------------------------

/** Mostra o cartão "Ative os lembretes" só enquanto as notificações não estiverem ativas. */
async function refreshNotificationCta() {
  const cta = document.getElementById('notif-cta');
  if (!cta) return;

  const platform = getPlatformSnapshot();
  if (!platform.supportsPush || platform.notificationPermission === 'unsupported') {
    cta.hidden = true;
    return;
  }

  cta.hidden = platform.notificationPermission === 'granted' && (await isPushSubscribed());
}

function wireNotificationCta() {
  const btn = document.getElementById('btn-enable-notifications-inline');
  const errorEl = document.getElementById('notif-cta-error');
  if (!btn || btn.dataset.wired === 'true') return;
  btn.dataset.wired = 'true';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Ativando…';
    errorEl.hidden = true;

    // Chamada direta dentro do handler de toque — é isso que o iOS Safari exige para
    // permitir Notification.requestPermission().
    const result = await activateNotifications();

    btn.disabled = false;
    btn.textContent = 'Ativar';

    if (result.ok) {
      toast('Lembretes ativados. Enviei uma notificação de teste.');
      await refreshNotificationCta();
      return;
    }

    if (result.permission === 'denied') {
      errorEl.hidden = false;
      errorEl.textContent =
        'As notificações estão bloqueadas para o Feito?. Abra Ajustes do iPhone → Feito? → Notificações, permita os avisos e volte aqui.';
      return;
    }

    errorEl.hidden = false;
    errorEl.textContent = result.error || 'Não deu para ativar agora. Tente de novo.';
  });
}

function openTaskById(taskId) {
  // MVP: não há tela de detalhe separada — a tarefa ativa já aparece na Hoje.
  // Garantimos que a aba correta esteja em foco e os dados estejam frescos.
  document.querySelector('[data-tab-target="today"]').click();
  refreshTasksAndRender();
  if (taskId) toast('Abrindo sua tarefa…');
}

// --------------------------- Service Worker + atualização ---------------------------

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });

    const showUpdateBanner = () => {
      const banner = document.getElementById('update-banner');
      if (banner) banner.hidden = false;
    };

    // Caso 1: já havia uma versão nova esperando quando o app abriu. O evento 'updatefound'
    // NÃO dispara nesse cenário (ele já disparou numa sessão anterior), então sem esta
    // checagem o banner nunca apareceria e o app ficaria preso na versão antiga.
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner();

    // Caso 2: a versão nova é descoberta agora, com o app aberto.
    registration.addEventListener('updatefound', () => {
      const installingWorker = registration.installing;
      if (!installingWorker) return;
      installingWorker.addEventListener('statechange', () => {
        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }
      });
    });

    const btnUpdate = document.getElementById('btn-update-now');
    if (btnUpdate) {
      btnUpdate.addEventListener('click', async () => {
        btnUpdate.disabled = true;
        btnUpdate.textContent = 'Atualizando…';

        // Pega a registration mais atual — a variável capturada acima pode estar
        // desatualizada se o Safari trocou de worker no meio do caminho.
        const current = (await navigator.serviceWorker.getRegistration()) || registration;

        if (current.waiting) {
          current.waiting.postMessage({ type: 'SKIP_WAITING' });
        } else {
          // Não há worker esperando: força uma verificação e, se aparecer um, ativa.
          try { await current.update(); } catch { /* segue para o recarregamento */ }
          if (current.waiting) current.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        // Rede de segurança: no Safari em modo standalone (PWA na tela de início) o evento
        // 'controllerchange' às vezes não chega, e sem isso o banner ficava para sempre na
        // tela com o app rodando a versão antiga. Recarregar resolve mesmo nesse caso.
        setTimeout(() => window.location.reload(), 1200);
      });
    }

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'OPEN_TASK') {
        openTaskById(event.data.taskId);
      }
    });

    // Procura versões novas sempre que o app volta ao primeiro plano.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  } catch {
    // Sem Service Worker, o app ainda funciona como temporizador visual (sem push).
  }
}

// --------------------------- Boot ---------------------------

async function boot() {
  await registerServiceWorker();

  const platform = getPlatformSnapshot();

  const params = new URLSearchParams(window.location.search);
  const deepLinkTaskId = params.get('task');

  async function proceedToMain() {
    setOnboardingSeenSync(true);
    showScreen('main');
    wireTabBar();
    wireNotificationCta();
    refreshNotificationCta();

    await ensureInstallation();
    await refreshTasksAndRender();

    if (deepLinkTaskId) openTaskById(deepLinkTaskId);

    if (document.visibilityState === 'visible') {
      checkHomeArrivalIfConfigured(currentActiveTasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'));
    }
  }

  // Onboarding enxuto: a ÚNICA tela que precisa existir antes do app é a de instalação,
  // e só para quem ainda não instalou no iOS (sem estar na Tela de Início, o iPhone nem
  // permite notificações). Quem já instalou entra direto no app; a ativação de lembretes
  // virou um cartão dentro da tela Hoje (#notif-cta), sem etapa extra a percorrer.
  const needsInstallScreen = platform.isIos && !platform.isStandalone;

  if (needsInstallScreen) {
    showScreen('install');
    wireInstallScreen({
      onContinueAnyway: () => proceedToMain()
    });
  } else {
    proceedToMain();
  }

  window.addEventListener('online', () => { updateOfflineBadge(); refreshTasksAndRender({ silent: true }); });
  window.addEventListener('offline', updateOfflineBadge);
  updateOfflineBadge();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !screens.main.hidden) {
      refreshTasksAndRender({ silent: true });
      refreshNotificationCta();
      checkHomeArrivalIfConfigured(currentActiveTasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'));
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
