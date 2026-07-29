// Orquestrador do app: decide qual tela mostrar, registra o Service Worker, mantém a
// tela "Hoje" sincronizada com o backend, e liga os três estados de onboarding descritos
// na seção 3 do briefing ao app principal (seção 4).

import { getPlatformSnapshot } from './platform.js';
import { getOnboardingSeenSync, setOnboardingSeenSync, kvGet } from './db.js';
import { cacheTasksReplace, cacheTasksGetAll } from './db.js';
import { ensureInstallation, api } from './api.js';
import { wireInstallScreen, wireEnableNotificationsScreen } from './ui/onboarding.js';
import { renderToday } from './ui/today.js';
import { renderHistory } from './ui/history.js';
import { renderSettings, checkHomeArrivalIfConfigured } from './ui/settings.js';
import { toast } from './ui/components.js';

const screens = {
  loading: document.getElementById('screen-loading'),
  install: document.getElementById('screen-install'),
  enableNotifications: document.getElementById('screen-enable-notifications'),
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

    registration.addEventListener('updatefound', () => {
      const installingWorker = registration.installing;
      if (!installingWorker) return;
      installingWorker.addEventListener('statechange', () => {
        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
          document.getElementById('update-banner').hidden = false;
        }
      });
    });

    document.getElementById('btn-update-now').addEventListener('click', () => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    });

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
  } catch {
    // Sem Service Worker, o app ainda funciona como temporizador visual (sem push).
  }
}

// --------------------------- Boot ---------------------------

async function boot() {
  await registerServiceWorker();

  const platform = getPlatformSnapshot();
  const onboardingSeen = getOnboardingSeenSync();

  const params = new URLSearchParams(window.location.search);
  const deepLinkTaskId = params.get('task');

  async function proceedToMain() {
    setOnboardingSeenSync(true);
    showScreen('main');
    wireTabBar();

    await ensureInstallation();
    await refreshTasksAndRender();

    if (deepLinkTaskId) openTaskById(deepLinkTaskId);

    if (document.visibilityState === 'visible') {
      checkHomeArrivalIfConfigured(currentActiveTasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'));
    }
  }

  function maybeShowEnableNotifications() {
    const permission = platform.notificationPermission;
    const alreadyDecided = permission === 'granted' || permission === 'denied' || permission === 'unsupported' || !platform.supportsPush;

    if (alreadyDecided || onboardingSeen) {
      proceedToMain();
      return;
    }

    showScreen('enableNotifications');
    wireEnableNotificationsScreen({
      onResolved: () => proceedToMain()
    });
  }

  const needsInstallScreen = platform.isIos && !platform.isStandalone;

  if (needsInstallScreen) {
    showScreen('install');
    wireInstallScreen({
      onContinueAnyway: () => maybeShowEnableNotifications()
    });
  } else {
    maybeShowEnableNotifications();
  }

  window.addEventListener('online', () => { updateOfflineBadge(); refreshTasksAndRender({ silent: true }); });
  window.addEventListener('offline', updateOfflineBadge);
  updateOfflineBadge();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !screens.main.hidden) {
      refreshTasksAndRender({ silent: true });
      checkHomeArrivalIfConfigured(currentActiveTasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'));
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
