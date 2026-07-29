import { json, errorResponse } from '../lib/response.js';
import { requireInstallation } from '../lib/auth.js';
import { validatePushSubscribe } from '../lib/validate.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { nowIso } from '../lib/time.js';
import { sendWebPush, PushSendError } from '../lib/webpush.js';

export async function handleSubscribe(request, env) {
  const { installationId } = await requireInstallation(request, env);
  await checkRateLimit(env, installationId, 'POST /api/push/subscribe');

  const body = await request.json().catch(() => ({}));
  const { endpoint, p256dh, auth } = validatePushSubscribe(body);
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO push_subscriptions (installation_id, endpoint, p256dh, auth, is_valid, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       installation_id = excluded.installation_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       is_valid = 1,
       last_error = NULL,
       updated_at = excluded.updated_at`
  ).bind(installationId, endpoint, p256dh, auth, now, now).run();

  return json(request, env, { subscribed: true }, 201);
}

export async function handleUnsubscribe(request, env) {
  const { installationId } = await requireInstallation(request, env);
  const body = await request.json().catch(() => ({}));

  if (body && body.endpoint) {
    await env.DB.prepare(
      'DELETE FROM push_subscriptions WHERE installation_id = ? AND endpoint = ?'
    ).bind(installationId, body.endpoint).run();
  } else {
    await env.DB.prepare(
      'DELETE FROM push_subscriptions WHERE installation_id = ?'
    ).bind(installationId).run();
  }

  return json(request, env, { unsubscribed: true }, 200);
}

/**
 * POST /api/push/test — envia uma notificação de teste. Fortemente limitado
 * (ver rateLimit.js: 3 por 5 minutos) para não virar vetor de abuso/spam.
 */
export async function handlePushTest(request, env) {
  const { installationId } = await requireInstallation(request, env);
  await checkRateLimit(env, installationId, 'POST /api/push/test');

  const subs = await env.DB.prepare(
    'SELECT * FROM push_subscriptions WHERE installation_id = ? AND is_valid = 1'
  ).bind(installationId).all();

  const results = [];
  for (const sub of (subs.results || [])) {
    try {
      await sendWebPush({
        subscription: sub,
        payload: {
          // Sem repetir o nome do app: o iOS já o exibe no cabeçalho da notificação.
          title: 'Tudo certo por aqui',
          body: 'É assim que os lembretes vão chegar.',
          taskId: null,
          module: null,
          url: '/',
          tag: 'feito-test',
          timestamp: Date.now()
        },
        vapidKeys: {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKeyJwk: JSON.parse(env.VAPID_PRIVATE_KEY_JWK)
        },
        vapidSubject: env.VAPID_SUBJECT
      });
      results.push({ subscriptionId: sub.id, ok: true });
    } catch (err) {
      if (err instanceof PushSendError && err.isPermanent) {
        await env.DB.prepare(
          'UPDATE push_subscriptions SET is_valid = 0, last_error = ?, updated_at = ? WHERE id = ?'
        ).bind(String(err.message).slice(0, 200), nowIso(), sub.id).run();
      }
      results.push({ subscriptionId: sub.id, ok: false, error: err.message });
    }
  }

  if (results.length === 0) {
    return errorResponse(request, env, { status: 404, message: 'Nenhuma assinatura Push ativa para esta instalação.' });
  }

  return json(request, env, { results }, 200);
}
