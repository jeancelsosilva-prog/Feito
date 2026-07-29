import { json, errorResponse } from '../lib/response.js';
import { generateInstallationToken, hashToken } from '../lib/auth.js';
import { validateInstallationBody } from '../lib/validate.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { nowIso } from '../lib/time.js';

/**
 * POST /api/installations
 *
 * Sem credenciais válidas no request -> cria uma instalação nova e devolve
 * { installationId, token } UMA ÚNICA VEZ (o cliente deve guardar em IndexedDB).
 *
 * Com X-Installation-Id + Authorization Bearer válidos -> apenas atualiza metadados
 * (timezone/platform/app_version/last_seen_at) e devolve { installationId, token: null }.
 *
 * Com X-Installation-Id presente mas SEM Authorization válido -> 401. Isso impede que
 * alguém tente "assumir" um installationId de terceiros sem provar posse do token.
 */
export async function handleCreateOrUpdateInstallation(request, env) {
  const body = await request.json().catch(() => ({}));
  const { timezone, platform, appVersion } = validateInstallationBody(body);
  const now = nowIso();

  const claimedId = request.headers.get('X-Installation-Id');
  const authHeader = request.headers.get('Authorization') || '';
  const claimedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (claimedId) {
    if (!claimedToken) {
      return errorResponse(request, env, { status: 401, message: 'Token ausente para instalação existente.' });
    }
    const row = await env.DB.prepare('SELECT id, token_hash FROM installations WHERE id = ?').bind(claimedId).first();
    if (!row) {
      return errorResponse(request, env, { status: 401, message: 'Instalação não encontrada.' });
    }
    const incomingHash = await hashToken(claimedToken);
    if (incomingHash !== row.token_hash) {
      return errorResponse(request, env, { status: 401, message: 'Token inválido.' });
    }

    await checkRateLimit(env, claimedId, 'POST /api/installations');

    await env.DB.prepare(
      `UPDATE installations SET timezone = ?, platform = ?, app_version = ?, last_seen_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(timezone, platform, appVersion, now, now, claimedId).run();

    return json(request, env, { installationId: claimedId, token: null }, 200);
  }

  // Nova instalação.
  const installationId = crypto.randomUUID();
  const token = generateInstallationToken();
  const tokenHash = await hashToken(token);

  await env.DB.prepare(
    `INSERT INTO installations (id, token_hash, timezone, platform, app_version, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(installationId, tokenHash, timezone, platform, appVersion, now, now, now).run();

  return json(request, env, { installationId, token }, 201);
}
