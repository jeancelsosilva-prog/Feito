// Motor de lembretes: a lógica de negócio pura, desacoplada de QUEM a dispara.
//
// Por quê isso importa (ver seção 2 do spec): hoje um Cron Trigger varre tarefas vencidas
// e chama processDueTask() em loop, uma vez por tarefa. No futuro, se o volume justificar
// migrar para Durable Object Alarms, cada tarefa vai ter seu próprio alarme que chama
// processDueTask() uma única vez para si mesma e se reagenda sozinho. A função abaixo não
// sabe (nem precisa saber) qual dos dois mecanismos a invocou — toda a checagem de
// idempotência, horário silencioso e cálculo de próximo horário mora aqui dentro.

import { nowIso, addMinutesIso, isWithinQuietHours, nextQuietHoursEnd } from './time.js';
import { pickMessage, resolveStage, taskTitle } from './messages.js';
import { sendWebPush, PushSendError } from './webpush.js';

/** Calcula o intervalo (em minutos) até o próximo lembrete, dado o estado atual da tarefa. */
export function computeIntervalMinutes(task) {
  const base = task.repeat_interval_minutes;
  const homeBoostActive = task.home_boost_until && new Date(task.home_boost_until) > new Date();

  let interval = base;

  switch (task.intensity) {
    case 'light':
      interval = Math.round(base * 1.5);
      break;
    case 'insistent':
      // Depois de 3 avisos, o modo insistente aperta a cadência (mínimo de 5 minutos).
      if (task.reminder_count >= 3) {
        interval = Math.max(5, Math.round(base * 0.6));
      }
      break;
    case 'normal':
    default:
      interval = base;
  }

  if (homeBoostActive) {
    interval = Math.max(5, Math.round(interval * 0.5));
  }

  return interval;
}

/**
 * Dado o instante em que um lembrete acabou de ser enviado (ou seria enviado),
 * calcula o próximo next_reminder_at, já pulando o horário silencioso se necessário.
 */
export function computeNextReminderAt(task, fromIso) {
  const intervalMinutes = computeIntervalMinutes(task);
  let candidate = addMinutesIso(fromIso, intervalMinutes);

  if (task.quiet_hours_enabled) {
    const withinQuiet = isWithinQuietHours({
      isoString: candidate,
      quietHoursStart: task.quiet_hours_start,
      quietHoursEnd: task.quiet_hours_end,
      timeZone: task.quiet_hours_timezone
    });
    if (withinQuiet) {
      candidate = nextQuietHoursEnd({
        isoString: candidate,
        quietHoursEnd: task.quiet_hours_end,
        timeZone: task.quiet_hours_timezone
      });
    }
  }

  return candidate;
}

/**
 * Processa UMA tarefa vencida: decide se envia (respeitando horário silencioso), envia
 * via Web Push para todas as assinaturas válidas da instalação, registra o resultado de
 * forma idempotente e recalcula o próximo horário. Não lança para fora em caso de falha
 * de envio isolada — falhas de uma tarefa não devem interromper o processamento das demais.
 */
export async function processDueTask(env, taskRow, { vapidKeys, vapidSubject, logger = console }) {
  const now = nowIso();

  // Recarrega a tarefa para reduzir a janela de corrida com uma conclusão concorrente
  // (ex: usuário tocou "Roupa retirada" no exato minuto em que o cron disparou).
  const fresh = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskRow.id).first();
  if (!fresh) return { taskId: taskRow.id, outcome: 'not_found' };
  if (fresh.status === 'completed' || fresh.status === 'cancelled') {
    return { taskId: fresh.id, outcome: 'already_terminal' };
  }
  if (fresh.status === 'paused') {
    return { taskId: fresh.id, outcome: 'paused' };
  }

  // Horário silencioso: não envia agora, apenas reagenda para o fim da janela.
  if (fresh.quiet_hours_enabled && isWithinQuietHours({
    isoString: now,
    quietHoursStart: fresh.quiet_hours_start,
    quietHoursEnd: fresh.quiet_hours_end,
    timeZone: fresh.quiet_hours_timezone
  })) {
    const resumeAt = nextQuietHoursEnd({
      isoString: now,
      quietHoursEnd: fresh.quiet_hours_end,
      timeZone: fresh.quiet_hours_timezone
    });
    await env.DB.prepare(
      `UPDATE tasks SET next_reminder_at = ?, updated_at = ? WHERE id = ? AND status != 'completed' AND status != 'cancelled'`
    ).bind(resumeAt, now, fresh.id).run();
    return { taskId: fresh.id, outcome: 'quiet_hours_deferred', resumeAt };
  }

  const subscriptions = await env.DB.prepare(
    'SELECT * FROM push_subscriptions WHERE installation_id = ? AND is_valid = 1'
  ).bind(fresh.installation_id).all();

  const subs = subscriptions.results || [];

  const homeBoostActive = fresh.home_boost_until && new Date(fresh.home_boost_until) > new Date(now);
  const stage = resolveStage({ reminderCountBeforeThisSend: fresh.reminder_count, isHomeBoostActive: homeBoostActive });
  const message = pickMessage({ module: fresh.module, stage, lastMessageKey: fresh.last_message_key });

  // Chave de idempotência: uma por (tarefa, número do lembrete). O slot é reivindicado
  // ANTES de enviar qualquer push — não depois — porque um SELECT seguido de um INSERT
  // tem uma janela de corrida entre duas execuções concorrentes (ex: duas invocações do
  // cron sobrepostas). Reivindicando primeiro, a constraint UNIQUE em
  // notification_log.idempotency_key garante que, no máximo, uma das execuções concorrentes
  // passe adiante e realmente dispare o Web Push; a outra recebe erro de constraint aqui
  // mesmo, antes de tocar em sendWebPush.
  const idempotencyKey = `${fresh.id}:${fresh.reminder_count}`;

  try {
    await env.DB.prepare(
      `INSERT INTO notification_log (task_id, installation_id, stage, message_key, sent_at, success, error, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 0, 'pending', ?)`
    ).bind(fresh.id, fresh.installation_id, stage, message.key, now, idempotencyKey).run();
  } catch (err) {
    // Violação da constraint UNIQUE: outra execução já reivindicou este (tarefa, contagem).
    return { taskId: fresh.id, outcome: 'duplicate_skipped' };
  }

  // Checagem de última hora: entre o momento em que fresh foi lida e agora, o usuário pode
  // ter tocado em "Roupa retirada" (ou cancelado). O envio do Web Push é uma chamada de rede
  // que pode levar centenas de ms — sem essa checagem, a notificação sairia mesmo com a
  // tarefa já concluída. Isso não fecha 100% da janela (o envio já em trânsito não pode ser
  // "puxado de volta"), mas reduz drasticamente os casos práticos, e é barato: uma leitura
  // extra no D1 antes de qualquer chamada de rede.
  const recheck = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(fresh.id).first();
  if (!recheck || recheck.status === 'completed' || recheck.status === 'cancelled') {
    await env.DB.prepare(
      `UPDATE notification_log SET success = 0, error = 'tarefa concluída/cancelada antes do envio' WHERE idempotency_key = ?`
    ).bind(idempotencyKey).run();
    return { taskId: fresh.id, outcome: 'skipped_task_completed' };
  }

  let anySuccess = subs.length === 0 ? false : false;
  const errors = [];

  if (subs.length === 0) {
    errors.push('Nenhuma assinatura Push válida para esta instalação.');
  }

  for (const sub of subs) {
    try {
      await sendWebPush({
        subscription: sub,
        payload: {
          title: 'Feito?',
          body: message.text,
          taskId: fresh.id,
          module: fresh.module,
          url: `/task/${fresh.id}`,
          tag: `feito-task-${fresh.id}`,
          timestamp: Date.now()
        },
        vapidKeys,
        vapidSubject
      });
      anySuccess = true;
    } catch (err) {
      if (err instanceof PushSendError && err.isPermanent) {
        await env.DB.prepare(
          'UPDATE push_subscriptions SET is_valid = 0, last_error = ?, updated_at = ? WHERE id = ?'
        ).bind(String(err.message).slice(0, 200), now, sub.id).run();
      }
      errors.push(err.message || String(err));
      logger.warn?.('push_send_failed', { taskId: fresh.id, subscriptionId: sub.id });
    }
  }

  // Atualiza o registro já reivindicado acima com o resultado real do envio.
  await env.DB.prepare(
    `UPDATE notification_log SET success = ?, error = ? WHERE idempotency_key = ?`
  ).bind(
    anySuccess ? 1 : 0, errors.length ? errors.join(' | ').slice(0, 400) : null, idempotencyKey
  ).run();

  const newReminderCount = fresh.reminder_count + 1;
  const taskForCalc = { ...fresh, reminder_count: newReminderCount };
  const nextReminderAt = computeNextReminderAt(taskForCalc, now);

  await env.DB.prepare(
    `UPDATE tasks
     SET status = 'reminding', reminder_count = ?, last_notification_at = ?, last_message_key = ?,
         next_reminder_at = ?, updated_at = ?
     WHERE id = ? AND status != 'completed' AND status != 'cancelled'`
  ).bind(newReminderCount, now, message.key, nextReminderAt, now, fresh.id).run();

  return { taskId: fresh.id, outcome: anySuccess ? 'sent' : 'send_failed', stage, messageKey: message.key, nextReminderAt };
}

export { taskTitle };
