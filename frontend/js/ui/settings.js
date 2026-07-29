// Tela "Ajustes" (seções 8 e 11 do briefing): status de notificações, reforço de presença
// em casa (experimental, só em primeiro plano — nunca finge geofencing em segundo plano),
// e "Apagar meus dados deste dispositivo".

import { el, confirmDialog, toast } from './components.js';
import { CONFIG } from '../config.js';
import { kvGet, kvSet, kvDelete, wipeAllLocalData } from '../db.js';
import { api } from '../api.js';
import { activateNotifications, unsubscribeEverywhere, isPushSubscribed } from '../push.js';
import { notificationPermission, supportsPush, supportsBadging } from '../platform.js';

const MIN_RADIUS = 100;
const MAX_RADIUS = 500;
const DEFAULT_RADIUS = 250;

export async function renderSettings(container, { onResetApp }) {
  container.innerHTML = '';

  const rerender = () => renderSettings(container, { onResetApp });

  container.appendChild(await buildNotificationsCard(rerender));
  container.appendChild(await buildHomeBoostCard(rerender));
  container.appendChild(buildDataCard({ onResetApp }));
  container.appendChild(buildAboutCard());
}

// --------------------------- Notificações ---------------------------

async function buildNotificationsCard(rerender) {
  const permission = notificationPermission();
  const subscribed = await isPushSubscribed();

  const card = el('div', { class: 'settings-card' });
  card.appendChild(el('h2', { text: 'Notificações' }));

  const statusMap = {
    granted: { dot: 'ok', text: subscribed ? 'Ativadas e registradas neste dispositivo.' : 'Permitidas, mas ainda não registradas — toque em "Ativar lembretes" de novo.' },
    denied: { dot: 'bad', text: 'Bloqueadas para o Feito? neste iPhone.' },
    default: { dot: 'warn', text: 'Ainda não configuradas.' },
    unsupported: { dot: 'bad', text: 'Este navegador não suporta notificações push.' }
  };
  const status = statusMap[permission] || statusMap.default;

  card.appendChild(el('div', { class: 'settings-row' }, [
    el('span', {}, [el('span', { class: `status-dot ${status.dot}` }), status.text])
  ]));

  if (!supportsPush()) {
    card.appendChild(el('p', { class: 'field-hint', text: 'Sem Push, o Feito? ainda funciona como um temporizador visual — mas os avisos só aparecem enquanto você está olhando para o app.' }));
    return card;
  }

  if (permission === 'default' || (permission === 'granted' && !subscribed)) {
    const btn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Ativar lembretes' });
    btn.onclick = async () => {
      btn.disabled = true;
      const result = await activateNotifications();
      btn.disabled = false;
      if (result.ok) { toast('Lembretes ativados.'); rerender(); }
      else if (result.permission === 'denied') toast('Notificações bloqueadas. Veja como reativar nos Ajustes do iPhone.');
      else toast(result.error || 'Não deu para ativar agora.');
    };
    card.appendChild(btn);
  }

  if (permission === 'denied') {
    card.appendChild(el('p', { class: 'onboarding-help', text: 'Para reativar: Ajustes do iPhone → Feito? → Notificações → permitir.' }));
  }

  if (permission === 'granted' && subscribed) {
    const testBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Enviar notificação de teste' });
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      const result = await api.sendTestPush();
      testBtn.disabled = false;

      if (result.ok) {
        toast('Notificação de teste enviada.');
        return;
      }

      // 404 aqui = o backend não tem nenhuma assinatura válida para esta instalação —
      // ou porque nunca chegou a registrar, ou porque o push service marcou como expirada
      // (ver seção 17 do briefing: "assinatura expirada"). Nos dois casos, a saída é a
      // mesma: orientar o usuário a reativar, sem inventar um estado "meio ativado".
      if (result.status === 404) {
        toast('Sua assinatura de notificações expirou. Toque em "Ativar lembretes" para reativar.');
        // O backend já não tem essa assinatura — descarta também no navegador, para que
        // a tela volte a mostrar o botão "Ativar lembretes" em vez do de teste.
        try {
          const registration = await navigator.serviceWorker.ready;
          const staleSubscription = await registration.pushManager.getSubscription();
          if (staleSubscription) await staleSubscription.unsubscribe();
        } catch { /* best-effort */ }
        rerender();
        return;
      }

      toast(result.error || 'Não foi possível enviar agora (limite de testes pode ter sido atingido).');
    };
    card.appendChild(testBtn);
  }

  if (!supportsBadging()) {
    card.appendChild(el('p', { class: 'field-hint', text: 'Este navegador não suporta o selo numérico no ícone do app (Badging API) — os lembretes continuam funcionando normalmente.' }));
  }

  return card;
}

// --------------------------- Reforço "estou em casa" ---------------------------

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function buildHomeBoostCard(rerender) {
  const home = await kvGet('homeLocation');

  const card = el('div', { class: 'settings-card' });
  card.appendChild(el('h2', { text: 'Reforçar quando eu estiver em casa (experimental)' }));
  card.appendChild(el('p', {
    class: 'field-hint',
    text: 'Por limitações do iPhone, a versão web confirma sua chegada somente quando o app é aberto ou quando você toca em "Estou em casa". Detecção totalmente automática exigirá uma futura versão nativa.'
  }));

  if (!home) {
    const btn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cadastrar minha casa' });
    btn.onclick = () => registerHomeLocation(btn);
    card.appendChild(btn);
    return card;
  }

  card.appendChild(el('div', { class: 'settings-row' }, [
    el('span', { class: 'settings-row-label', id: 'home-radius-label', text: `Casa cadastrada · raio de ${home.radius}m` })
  ]));
  card.appendChild(el('input', {
    type: 'range',
    min: String(MIN_RADIUS),
    max: String(MAX_RADIUS),
    step: '25',
    value: String(home.radius),
    style: 'width:100%;',
    oninput: (e) => {
      document.getElementById('home-radius-label').textContent = `Casa cadastrada · raio de ${e.target.value}m`;
    },
    onchange: async (e) => {
      await kvSet('homeLocation', { ...home, radius: Number(e.target.value) });
      toast('Raio atualizado.');
    }
  }));

  const removeBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Remover casa cadastrada' });
  removeBtn.onclick = async () => {
    await kvDelete('homeLocation');
    toast('Casa removida.');
    rerender();
  };
  card.appendChild(removeBtn);

  return card;

  async function registerHomeLocation(triggerBtn) {
    if (!('geolocation' in navigator)) {
      toast('Este navegador não suporta localização.');
      return;
    }
    triggerBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          radius: DEFAULT_RADIUS
        };
        await kvSet('homeLocation', location);
        toast('Casa cadastrada.');
        rerender();
      },
      () => {
        toast('Não foi possível obter sua localização agora.');
        triggerBtn.disabled = false;
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }
}

/**
 * Chamado por app.js quando o app volta ao primeiro plano. Se há uma casa cadastrada e a
 * localização atual está dentro do raio, ativa o reforço nas tarefas ativas — sem nunca
 * mandar coordenadas precisas ao backend (só o efeito: home_boost_until).
 */
export async function checkHomeArrivalIfConfigured(activeTasks) {
  const home = await kvGet('homeLocation');
  if (!home || activeTasks.length === 0) return;
  if (!('geolocation' in navigator)) return;
  if ('permissions' in navigator) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state !== 'granted') return; // nunca solicita aqui — só reaproveita permissão já concedida
    } catch {
      return;
    }
  } else {
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const here = { lat: position.coords.latitude, lng: position.coords.longitude };
      const distance = haversineMeters(here, home);
      if (distance <= home.radius) {
        for (const task of activeTasks) {
          await api.homeBoost(task.id);
        }
      }
    },
    () => {},
    { enableHighAccuracy: false, timeout: 8000 }
  );
}

// --------------------------- Dados locais ---------------------------

function buildDataCard({ onResetApp }) {
  const card = el('div', { class: 'settings-card' });
  card.appendChild(el('h2', { text: 'Seus dados' }));
  card.appendChild(el('p', { class: 'field-hint', text: 'O Feito? não usa contas nem login — tudo fica associado só a este dispositivo.' }));

  const btn = el('button', { class: 'btn btn-danger', type: 'button', text: 'Apagar meus dados deste dispositivo' });
  btn.onclick = async () => {
    const confirmed = await confirmDialog({
      title: 'Apagar todos os seus dados?',
      message: 'Isso cancela tarefas ativas, remove as notificações registradas e apaga tudo salvo neste dispositivo. Não pode ser desfeito.',
      confirmLabel: 'Apagar tudo',
      cancelLabel: 'Voltar',
      destructive: true
    });
    if (!confirmed) return;
    await resetEverything();
    onResetApp();
  };
  card.appendChild(btn);
  return card;
}

async function resetEverything() {
  try {
    const activeResult = await api.listActiveTasks();
    if (activeResult.ok) {
      for (const task of activeResult.data.tasks) {
        await api.cancelTask(task.id);
      }
    }
  } catch { /* segue mesmo se falhar — a limpeza local é o que importa aqui */ }

  await unsubscribeEverywhere();
  await wipeAllLocalData();

  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
  if ('clearAppBadge' in navigator) {
    try { await navigator.clearAppBadge(); } catch { /* feature detection já cobre a ausência */ }
  }
}

// --------------------------- Sobre ---------------------------

function buildAboutCard() {
  const card = el('div', { class: 'settings-card' });
  card.appendChild(el('h2', { text: 'Sobre' }));
  card.appendChild(el('div', { class: 'settings-row' }, [
    el('span', { class: 'settings-row-label', text: 'Versão' }),
    el('span', { text: CONFIG.APP_VERSION })
  ]));
  return card;
}
