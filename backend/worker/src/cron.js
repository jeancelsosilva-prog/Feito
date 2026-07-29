import { processDueTask } from './lib/reminderEngine.js';
import { nowIso } from './lib/time.js';

// Quantas tarefas vencidas processar por execução do cron. Como o cron roda a cada
// minuto, isso é uma rede de segurança contra picos — em uso normal o número de
// tarefas vencidas por minuto é pequeno. Se esse limite passar a ser atingido com
// frequência, é o sinal de que chegou a hora de migrar para Durable Object Alarms
// (ver nota de arquitetura no README).
const MAX_TASKS_PER_TICK = 100;

/**
 * Handler do Cron Trigger (`scheduled` no Workers). Busca tarefas com next_reminder_at
 * vencido e delega o processamento de cada uma para processDueTask(), que é a MESMA
 * função que seria chamada por um Durable Object Alarm individual no futuro.
 */
export async function runReminderSweep(env, logger = console) {
  const now = nowIso();

  const due = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('scheduled', 'reminding')
       AND next_reminder_at IS NOT NULL
       AND next_reminder_at <= ?
     ORDER BY next_reminder_at ASC
     LIMIT ?`
  ).bind(now, MAX_TASKS_PER_TICK).all();

  const tasks = due.results || [];
  if (tasks.length === 0) return { processed: 0 };

  const vapidKeys = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKeyJwk: JSON.parse(env.VAPID_PRIVATE_KEY_JWK)
  };
  const vapidSubject = env.VAPID_SUBJECT;

  const outcomes = [];
  for (const task of tasks) {
    try {
      const outcome = await processDueTask(env, task, { vapidKeys, vapidSubject, logger });
      outcomes.push(outcome);
    } catch (err) {
      // Uma falha isolada não pode derrubar o processamento das outras tarefas do lote.
      logger.error?.('reminder_processing_failed', { taskId: task.id, message: err?.message });
      outcomes.push({ taskId: task.id, outcome: 'error', error: err?.message });
    }
  }

  return { processed: outcomes.length, outcomes };
}

/** Limpeza periódica leve: expira tarefas abandonadas e apaga logs/rate-limit antigos. */
export async function runMaintenance(env) {
  const now = new Date();

  // Tarefas "scheduled"/"reminding" sem nenhuma atividade há mais de 30 dias são
  // consideradas abandonadas (ex: usuário desinstalou o app sem cancelar).
  const abandonedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE tasks SET status = 'cancelled', cancelled_at = ?, next_reminder_at = NULL, updated_at = ?
     WHERE status IN ('scheduled','reminding','paused') AND created_at < ?`
  ).bind(now.toISOString(), now.toISOString(), abandonedCutoff).run();

  // Logs de notificação e eventos de rate limit não precisam viver para sempre.
  const logCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM notification_log WHERE sent_at < ?').bind(logCutoff).run();

  const rateLimitCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM rate_limit_events WHERE created_at < ?').bind(rateLimitCutoff).run();

  const idempotencyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').bind(idempotencyCutoff).run();
}
