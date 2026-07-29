// Rate limiting básico por instalação + rota, usando uma tabela D1 como janela deslizante.
// Suficiente para o volume esperado do MVP. Se o tráfego crescer, isso pode migrar para
// Cloudflare Rate Limiting bindings ou Durable Objects sem alterar os handlers que o chamam.

import { nowIso } from './time.js';

const LIMITS = {
  'POST /api/installations': { max: 10, windowSeconds: 60 },
  'POST /api/tasks': { max: 20, windowSeconds: 60 },
  'POST /api/push/subscribe': { max: 10, windowSeconds: 60 },
  'POST /api/push/test': { max: 3, windowSeconds: 300 },
  default: { max: 60, windowSeconds: 60 }
};

export async function checkRateLimit(env, installationId, routeKey) {
  const rule = LIMITS[routeKey] || LIMITS.default;
  const since = new Date(Date.now() - rule.windowSeconds * 1000).toISOString();

  const { count } = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM rate_limit_events
     WHERE installation_id = ? AND route = ? AND created_at >= ?`
  ).bind(installationId, routeKey, since).first();

  if (count >= rule.max) {
    throw { status: 429, message: 'Muitas requisições. Tente novamente em instantes.' };
  }

  await env.DB.prepare(
    `INSERT INTO rate_limit_events (installation_id, route, created_at) VALUES (?, ?, ?)`
  ).bind(installationId, routeKey, nowIso()).run();
}
