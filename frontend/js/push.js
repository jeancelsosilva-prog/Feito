// Fluxo de permissão + assinatura de Web Push. Regra de ouro (ver seção 3 do briefing):
// Notification.requestPermission() SÓ pode ser chamado a partir de um toque direto do
// usuário no botão "Ativar lembretes" — nunca automaticamente no load da página.

import { CONFIG } from './config.js';
import { api, ensureInstallation } from './api.js';
const CACHE_VERSION = 'feito-v2';

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

  // A instalação PRECISA existir antes de qualquer chamada autenticada. Este fluxo pode
  // rodar no onboarding, ou seja, antes de a tela principal ter chamado ensureInstallation();
  // sem isto, /api/push/subscribe sai sem os cabeçalhos de autenticação e o backend
  // responde 401 ("Cabeçalhos de autenticação ausentes").
  const installation = await ensureInstallation();
  if (!installation.ok) {
    return {
      ok: false,
      permission,
      error: 'Não foi possível falar com o servidor para registrar este aparelho. Verifique a conexão e tente de novo.'
    };
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
// `stage` acompanha em que ponto estamos, para que uma falha possa dizer ONDE quebrou.
  let stage = 'service worker';

  try {
    const registration = await navigator.serviceWorker.ready;

    stage = 'assinatura existente';
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      stage = 'chave VAPID';
      const applicationServerKey = urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
      if (applicationServerKey.length !== 65 || applicationServerKey[0] !== 4) {
        return {
          ok: false,
          permission,
          error: `A chave VAPID pública em config.js parece inválida (${applicationServerKey.length} bytes; o esperado são 65). Confira se ela é idêntica à do wrangler.toml.`
        };
      }

      stage = 'nova assinatura';
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }

    stage = 'registro no servidor';
    const subJson = subscriptionToJson(subscription);
    const result = await api.subscribePush(subJson);
    if (!result.ok) {
      return { ok: false, permission, error: result.error || 'Falha ao registrar as notificações no servidor.' };
    }

    stage = 'salvar local';
    await kvSet('pushSubscribed', true);
    await kvSet('pushEndpoint', subJson.endpoint);

    stage = 'notificação de teste';
    const testResult = await api.sendTestPush();
    return { ok: true, permission, testSent: testResult.ok };
  } catch (err) {
    const detail = [err && err.name, err && err.message].filter(Boolean).join(': ');
    return {
      ok: false,
      permission,
      error: `Falhou em "${stage}"${detail ? ` — ${detail}` : ''}`
    };
  }
}
}
