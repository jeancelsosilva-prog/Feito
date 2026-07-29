// Orquestrador do app: decide qual tela mostrar, registra o Service Worker, mantém a
// tela "Hoje" sincronizada com o backend, e liga os três estados de onboarding descritos
// na seção 3 do briefing ao app principal (seção 4).

import { getPlatformSnapshot } from './platform.js';
import { setOnboardingSeenSync } from './db.js';
import { cacheTasksReplace, cacheTasksGetAll } from './db.js';
import { ensureInstallation, api } from './api.js';
import { activateNotifications } from './push.js';
import { wireInstallScreen } from './ui/onboarding.js';
import { renderToday } from './ui/today.js';
import { renderHistory } from './ui/history.js';
import { renderSettings, checkHomeArrivalIfConfigured } from './ui/settings.js';
import { toast } from './ui/components.js';

const screens = {
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

// --------------------------- Tema claro/escuro ---------------------------

function currentTheme() {
  return document.documentElement.getAttribute('data-theme'); // 'light' | 'dark' | null
}

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');

  const isDark = theme ? theme === 'dark' : systemPrefersDark();

  const icon = document.getElementById('theme-toggle-icon');
  // O ícone mostra o que o toque VAI fazer: sol para "ir para o claro".
  if (icon) icon.textContent = isDark ? '☀️' : '🌙';

  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.setAttribute('aria-label', isDark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro');

  // Mantém a cor da barra de status do iPhone coerente com o tema escolhido.
  const meta = document.querySelector('meta[name="theme-color"]:not([media])')
    || document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#141220' : '#F7F4FF');
}

function wireThemeToggle() {
  const btn = document.getElementById('btn-theme-toggle');
  if (!btn) return;

  applyTheme(currentTheme());

  btn.addEventListener('click', () => {
    const isDarkNow = currentTheme() ? currentTheme() === 'dark' : systemPrefersDark();
    const next = isDarkNow ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('feito.theme', next); } catch { /* modo privado: vale só nesta sessão */ }
  });
}

// --------------------------- Ativação de lembretes (in-app) ---------------------------

/**
 * O cartão tem três estados: pedindo ativação, já ativado (confirmação discreta) ou
 * escondido (quando o aparelho não suporta push).
 */
function refreshNotificationCta() {
  const cta = document.getElementById('notif-cta');
  if (!cta) return;

  const title = document.getElementById('notif-cta-title');
  const body = document.getElementById('notif-cta-body');
  const btn = document.getElementById('btn-enable-notifications-inline');
  const errorEl = document.getElementById('notif-cta-error');

  const supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  if (!supported) {
    cta.hidden = true;
    return;
  }

  // Lê a permissão direto da API, e não de um retrato tirado no início do boot: depois de
  // ativar, o valor muda na hora e o cartão precisa refletir isso sem esperar um reload.
  const permission = Notification.permission;

  cta.hidden = false;

  if (permission === 'granted') {
    cta.classList.add('is-active');
    title.textContent = 'Lembretes ativados';
    body.textContent = 'Este aparelho já recebe os avisos. Dá para testar em Ajustes → Notificações.';
    btn.hidden = true;
    errorEl.hidden = true;
    return;
  }

  cta.classList.remove('is-active');
  btn.hidden = false;
  title.textContent = 'Ative os lembretes';
  body.textContent = permission === 'denied'
    ? 'As notificações estão bloqueadas nos Ajustes do iPhone.'
    : 'Sem isso, o Feito? não consegue te avisar quando a hora chegar.';
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
      refreshNotificationCta();
      return;
    }

    if (result.permission === 'denied') {
      refreshNotificationCta();
      errorEl.hidden = false;
      errorEl.textContent =
        'Abra Ajustes do iPhone → Feito? → Notificações, permita os avisos e volte aqui.';
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

    // Atualização silenciosa. Não existe mais o banner "Tem uma versão nova pronta": ele
    // dependia de skipWaiting() ser acionado pela página, e no Safari em modo PWA isso
    // falha com frequência — o resultado era um banner permanente que não fazia nada.
    // Agora o Service Worker novo assume sozinho (skipWaiting no install), e aqui só
    // decidimos QUANDO recarregar a tela para que o código novo passe a valer.
    let pendingReload = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (pendingReload) return;
      pendingReload = true;

      // Recarregar no meio do uso seria grosseiro (o usuário pode estar preenchendo o
      // formulário de uma lavagem). Esperamos o app sair de vista e voltar.
      if (document.visibilityState === 'visible') {
        document.addEventListener('visibilitychange', function onVisible() {
          if (document.visibilityState === 'visible') {
            document.removeEventListener('visibilitychange', onVisible);
            window.location.reload();
          }
        });
      } else {
        window.location.reload();
      }
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
  wireThemeToggle();

  // O registro do Service Worker NÃO bloqueia mais a primeira tela. Antes o boot ficava
  // esperando por ele, e nesse intervalo o usuário só via uma tela de splash com a palavra
  // "Feito?" — tempo morto sem informação nenhuma. Agora a tela certa aparece de imediato
  // e o Service Worker se registra em paralelo.
  registerServiceWorker();

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
