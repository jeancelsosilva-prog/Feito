// Cliente HTTP do backend. Centraliza autenticação (installationId + token), geração de
// Idempotency-Key para ações de escrita, e um formato de retorno consistente que a UI
// consegue tratar sem repetir try/catch em todo lugar: { ok, data, error, offline }.

import { CONFIG } from './config.js';
import { kvGet, kvSet } from './db.js';

const REQUEST_TIMEOUT_MS = 12000;

async function getAuthHeaders() {
  const installationId = await kvGet('installationId');
  const token = await kvGet('installationToken');
  const headers = {};
  if (installationId) headers['X-Installation-Id'] = installationId;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function request(path, { method = 'GET', body, idempotent = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!navigator.onLine) {
    return { ok: false, offline: true, error: 'Sem conexão com a internet.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const authHeaders = await getAuthHeaders();
    const headers = { 'Content-Type': 'application/json', ...authHeaders };
    if (idempotent) headers['Idempotency-Key'] = crypto.randomUUID();

    const response = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const contentType = response.headers.get('Content-Type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      return { ok: false, status: response.status, error: (data && data.error) || `Erro ${response.status}`, data };
    }
    return { ok: true, status: response.status, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'O servidor demorou para responder. Tente novamente.', timedOut: true };
    }
    return { ok: false, error: 'Não foi possível falar com o servidor.', networkError: true };
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  /** Cria (primeira vez) ou atualiza (visitas seguintes) a instalação. */
  async registerInstallation({ timezone, platform, appVersion } = {}) {
    return request('/api/installations', {
      method: 'POST',
      body: { timezone, platform, app_version: appVersion }
    });
  },

  async subscribePush(subscriptionJson) {
    return request('/api/push/subscribe', { method: 'POST', body: subscriptionJson });
  },

  async unsubscribePush(endpoint) {
    return request('/api/push/subscribe', { method: 'DELETE', body: endpoint ? { endpoint } : {} });
  },

  async sendTestPush() {
    return request('/api/push/test', { method: 'POST' });
  },

  async listActiveTasks() {
    return request('/api/tasks/active');
  },

  async getTask(taskId) {
    return request(`/api/tasks/${encodeURIComponent(taskId)}`);
  },

  async createTask(payload) {
    return request('/api/tasks', { method: 'POST', body: payload, idempotent: true });
  },

  async completeTask(taskId) {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST', idempotent: true });
  },

  async cancelTask(taskId) {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', idempotent: true });
  },

  async pauseTask(taskId) {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/pause`, { method: 'POST' });
  },

  async resumeTask(taskId) {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
  },

  async homeBoost(taskId) {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/home-boost`, { method: 'POST' });
  },

  async getHistory(cursor) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request(`/api/history${query}`);
  }
};

/** Garante que existe uma instalação registrada, criando uma na primeira vez. */
export async function ensureInstallation() {
  const existingId = await kvGet('installationId');
  const existingToken = await kvGet('installationToken');

  let timezone = 'UTC';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* mantém UTC */ }

  const platform = window.navigator.standalone ? 'ios-standalone' : 'ios-safari';

  const result = await api.registerInstallation({ timezone, platform, appVersion: CONFIG.APP_VERSION });

  if (!result.ok) {
    // Sem rede na primeira execução: segue offline, tenta de novo mais tarde.
    return { ok: Boolean(existingId), installationId: existingId || null, offline: !existingId };
  }

  if (result.data.token) {
    // Instalação nova — guarda id + token pela primeira (e única) vez.
    await kvSet('installationId', result.data.installationId);
    await kvSet('installationToken', result.data.token);
  } else if (!existingId) {
    // Não deveria acontecer (servidor confirmou uma instalação existente que não tínhamos),
    // mas por segurança não sobrescreve o token local com null.
  }

  return { ok: true, installationId: result.data.installationId };
}
