// Fluxo de permissão + assinatura de Web Push. Regra de ouro (ver seção 3 do briefing):
// Notification.requestPermission() SÓ pode ser chamado a partir de um toque direto do
// usuário no botão "Ativar lembretes" — nunca automaticamente no load da página.

import { CONFIG } from './config.js';
import { api } from './api.js';
import { kvSet, kvGet } from './db.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function subscriptionToJson(subscription) {
  const json = subscription.toJSON();
  return { endpoint: json.endpoint, keys: json.keys };
}

/**
 * Chamado em resposta direta ao toque no botão "Ativar lembretes". Pede permissão,
 * assina o Push, registra a assinatura no backend e dispara uma notificação de teste.
 * Retorna { ok, permission, error }.
 */
export async function activateNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, permission: 'unsupported', error: 'Este navegador não suporta notificações push.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, permission, error: null };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
      });
    }

    const subJson = subscriptionToJson(subscription);
    const result = await api.subscribePush(subJson);
    if (!result.ok) {
      return { ok: false, permission, error: result.error || 'Falha ao registrar as notificações no servidor.' };
    }

    await kvSet('pushSubscribed', true);
    await kvSet('pushEndpoint', subJson.endpoint);

    const testResult = await api.sendTestPush();
    return { ok: true, permission, testSent: testResult.ok };
  } catch (err) {
    return { ok: false, permission, error: 'Não foi possível concluir a assinatura de notificações.' };
  }
}

export async function isPushSubscribed() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return Boolean(subscription);
  } catch {
    return Boolean(await kvGet('pushSubscribed'));
  }
}

/** Usado pelo fluxo de "Apagar meus dados deste dispositivo". */
export async function unsubscribeEverywhere() {
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
        return;
      }
    }
    await api.unsubscribePush();
  } catch {
    // best-effort — a limpeza local (IndexedDB) continua acontecendo de qualquer forma.
  }
}
