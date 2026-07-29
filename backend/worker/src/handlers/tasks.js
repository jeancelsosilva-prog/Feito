import { json, errorResponse } from '../lib/response.js';
import { requireInstallation } from '../lib/auth.js';
import { validateCreateTask } from '../lib/validate.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { withIdempotency } from '../lib/idempotency.js';
import { nowIso, addMinutesIso } from '../lib/time.js';
import { sha256Hex } from '../lib/hash.js';

const ACTIVE_STATUSES = ['scheduled', 'reminding', 'paused'];

export async function handleListActiveTasks(request, env) {
  const { installationId } = await requireInstallation(request, env);
  const rows = await env.DB.prepare(
    `SELECT * FROM tasks WHERE installation_id = ? AND status IN ('scheduled','reminding','paused')
     ORDER BY created_at DESC`
  ).bind(installationId).all();
  return json(request, env, { tasks: rows.results || [] }, 200);
}

export async function handleGetTask(request, env, taskId) {
  const { installationId } = await requireInstallation(request, env);
  const task = await env.DB.prepare(
    'SELECT * FROM tasks WHERE id = ? AND installation_id = ?'
  ).bind(taskId, installationId).first();

  if (!task) return errorResponse(request, env, { status: 404, message: 'Tarefa não encontrada.' });
  return json(request, env, { task }, 200);
}

export async function handleCreateTask(request, env) {
  const { installationId } = await requireInstallation(request, env);
  await checkRateLimit(env, installationId, 'POST /api/tasks');

  const idempotencyKey = request.headers.get('Idempotency-Key');
  const rawBody = await request.text();
  // Hash do corpo cru da requisição: se a mesma Idempotency-Key voltar com um payload
  // diferente, withIdempotency() detecta e responde 409 em vez de silenciosamente devolver
  // a tarefa criada pela primeira chamada.
  const requestHash = idempotencyKey ? await sha256Hex(rawBody) : null;

  const result = await withIdempotency(
    env,
    { installationId, endpoint: 'POST /api/tasks', idempotencyKey, requestHash },
    async () => {
      let body;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return { status: 400, body: { error: 'JSON inválido no corpo da requisição.' } };
      }
      const data = validateCreateTask(body);
      const now = nowIso();
      const taskId = crypto.randomUUID();

      const status = new Date(data.first_reminder_at) <= new Date(now) ? 'reminding' : 'scheduled';

      await env.DB.prepare(
        `INSERT INTO tasks (
          id, installation_id, module, task_type, custom_title, started_at, first_reminder_at,
          next_reminder_at, repeat_interval_minutes, intensity, quiet_hours_enabled,
          quiet_hours_start, quiet_hours_end, quiet_hours_timezone, status, reminder_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        taskId, installationId, data.module, data.task_type, data.custom_title,
        data.started_at, data.first_reminder_at, data.first_reminder_at,
        data.repeat_interval_minutes, data.intensity, data.quiet_hours_enabled,
        data.quiet_hours_start, data.quiet_hours_end, data.quiet_hours_timezone,
        status, now, now
      ).run();

      const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
      return { status: 201, body: { task } };
    }
  );

  return json(request, env, result.body, result.status, result.replayed ? { 'Idempotent-Replay': 'true' } : {});
}

async function transitionTask(request, env, taskId, { fromRequired, toStatus, timestampField, extraSet = '', extraBinds = [] }) {
  const { installationId } = await requireInstallation(request, env);
  const idempotencyKey = request.headers.get('Idempotency-Key');
  const endpointName = `POST /api/tasks/:id/${toStatus}`;
  // A tabela idempotency_keys tem `key` como chave primária GLOBAL — a mesma Idempotency-Key
  // reaparecendo em uma URL diferente (ex: para concluir uma TAREFA diferente) precisa ser
  // detectada como reuso indevido, não silenciosamente responder com os dados da primeira
  // tarefa. Por isso passamos taskId como requestHash: withIdempotency() compara esse valor
  // com o que foi salvo na primeira chamada e retorna 409 se não bater (ver lib/idempotency.js).
  const requestHash = idempotencyKey ? taskId : null;

  const result = await withIdempotency(
    env,
    { installationId, endpoint: endpointName, idempotencyKey, requestHash },
    async () => {
      const now = nowIso();
      const existing = await env.DB.prepare(
        'SELECT * FROM tasks WHERE id = ? AND installation_id = ?'
      ).bind(taskId, installationId).first();

      if (!existing) {
        return { status: 404, body: { error: 'Tarefa não encontrada.' } };
      }

      // Idempotência de domínio: concluir/cancelar uma tarefa já terminal é um no-op
      // bem-sucedido, não um erro — evita corrida entre o toque do usuário e o cron.
      if (existing.status === 'completed' || existing.status === 'cancelled') {
        return { status: 200, body: { task: existing, alreadyTerminal: true } };
      }

      const setClause = `status = ?, ${timestampField} = ?, next_reminder_at = NULL, updated_at = ? ${extraSet}`;
      await env.DB.prepare(
        `UPDATE tasks SET ${setClause} WHERE id = ? AND installation_id = ?`
      ).bind(toStatus, now, now, ...extraBinds, taskId, installationId).run();

      const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
      return { status: 200, body: { task } };
    }
  );

  return json(request, env, result.body, result.status, result.replayed ? { 'Idempotent-Replay': 'true' } : {});
}

export async function handleCompleteTask(request, env, taskId) {
  return transitionTask(request, env, taskId, {
    toStatus: 'completed',
    timestampField: 'completed_at'
  });
}

export async function handleCancelTask(request, env, taskId) {
  return transitionTask(request, env, taskId, {
    toStatus: 'cancelled',
    timestampField: 'cancelled_at'
  });
}

export async function handlePauseTask(request, env, taskId) {
  const { installationId } = await requireInstallation(request, env);
  const now = nowIso();
  const existing = await env.DB.prepare(
    'SELECT * FROM tasks WHERE id = ? AND installation_id = ?'
  ).bind(taskId, installationId).first();
  if (!existing) return errorResponse(request, env, { status: 404, message: 'Tarefa não encontrada.' });
  // Nota: só tarefas realmente em andamento (scheduled/reminding) podem ser pausadas — uma
  // tarefa já pausada não deve poder "pausar de novo" silenciosamente (isso mascararia bugs
  // de cliente que chamam o endpoint fora de hora), por isso não usamos ACTIVE_STATUSES aqui,
  // que inclui 'paused' (usado em outros lugares para decidir o que aparece na tela "Hoje").
  if (existing.status !== 'scheduled' && existing.status !== 'reminding') {
    return errorResponse(request, env, { status: 409, message: 'Tarefa não está ativa.' });
  }

  await env.DB.prepare(
    `UPDATE tasks SET status = 'paused', next_reminder_at = NULL, updated_at = ? WHERE id = ?`
  ).bind(now, taskId).run();

  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return json(request, env, { task }, 200);
}

export async function handleResumeTask(request, env, taskId) {
  const { installationId } = await requireInstallation(request, env);
  const now = nowIso();
  const existing = await env.DB.prepare(
    'SELECT * FROM tasks WHERE id = ? AND installation_id = ?'
  ).bind(taskId, installationId).first();
  if (!existing) return errorResponse(request, env, { status: 404, message: 'Tarefa não encontrada.' });
  if (existing.status !== 'paused') {
    return errorResponse(request, env, { status: 409, message: 'Tarefa não está pausada.' });
  }

  const nextReminderAt = addMinutesIso(now, 1); // retoma no próximo ciclo do cron
  await env.DB.prepare(
    `UPDATE tasks SET status = 'reminding', next_reminder_at = ?, updated_at = ? WHERE id = ?`
  ).bind(nextReminderAt, now, taskId).run();

  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return json(request, env, { task }, 200);
}

/**
 * POST /api/tasks/:id/home-boost
 * Ativa o reforço temporário de cadência (ver seção 8 do spec). Não usa GPS no backend —
 * o cliente decide (por geolocalização local ou pelo botão manual "Estou em casa") quando
 * chamar este endpoint. O backend apenas grava até quando o reforço vale.
 */
export async function handleHomeBoost(request, env, taskId) {
  const { installationId } = await requireInstallation(request, env);
  const now = nowIso();
  const existing = await env.DB.prepare(
    'SELECT * FROM tasks WHERE id = ? AND installation_id = ?'
  ).bind(taskId, installationId).first();
  if (!existing) return errorResponse(request, env, { status: 404, message: 'Tarefa não encontrada.' });
  if (!ACTIVE_STATUSES.includes(existing.status)) {
    return errorResponse(request, env, { status: 409, message: 'Tarefa não está ativa.' });
  }

  const homeBoostUntil = addMinutesIso(now, 90);
  await env.DB.prepare(
    'UPDATE tasks SET home_boost_until = ?, updated_at = ? WHERE id = ?'
  ).bind(homeBoostUntil, now, taskId).run();

  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return json(request, env, { task }, 200);
}
