// Testes da lógica de cadência (backend/worker/src/lib/reminderEngine.js): cálculo de
// intervalo por intensidade, home boost, e o fluxo completo de processDueTask contra um
// D1 falso em memória (incluindo o teste de idempotência: rodar duas vezes não duplica envio).
//
// Rodar com: node tests/unit/reminderEngine.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeD1, loadFullSchemaSql } from '../api/fakeD1.mjs';
import { computeIntervalMinutes, computeNextReminderAt, processDueTask } from '../../backend/worker/src/lib/reminderEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = loadFullSchemaSql(path.join(__dirname, '../../backend/migrations'));

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

function baseTask(overrides = {}) {
  return {
    id: 'task-1',
    installation_id: 'install-1',
    module: 'laundry',
    task_type: 'take_out_machine',
    repeat_interval_minutes: 15,
    intensity: 'normal',
    reminder_count: 0,
    quiet_hours_enabled: 0,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_timezone: 'UTC',
    home_boost_until: null,
    last_message_key: null,
    ...overrides
  };
}

async function testIntervals() {
  console.log('computeIntervalMinutes');
  check('normal: usa o intervalo configurado', computeIntervalMinutes(baseTask({ intensity: 'normal', repeat_interval_minutes: 15 })) === 15);
  check('light: 1.5x o intervalo configurado', computeIntervalMinutes(baseTask({ intensity: 'light', repeat_interval_minutes: 10 })) === 15);
  check('insistent com poucos avisos: igual ao normal', computeIntervalMinutes(baseTask({ intensity: 'insistent', repeat_interval_minutes: 15, reminder_count: 1 })) === 15);
  check('insistent após 3 avisos: intervalo reduzido', computeIntervalMinutes(baseTask({ intensity: 'insistent', repeat_interval_minutes: 15, reminder_count: 3 })) < 15);

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const boosted = computeIntervalMinutes(baseTask({ intensity: 'normal', repeat_interval_minutes: 15, home_boost_until: future }));
  check('home boost ativo reduz o intervalo pela metade', boosted === Math.max(5, Math.round(15 * 0.5)));

  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const notBoosted = computeIntervalMinutes(baseTask({ intensity: 'normal', repeat_interval_minutes: 15, home_boost_until: past }));
  check('home boost expirado não afeta o intervalo', notBoosted === 15);
}

function testQuietHoursReschedule() {
  console.log('computeNextReminderAt com horário silencioso');
  // 22:40 UTC (usamos UTC como timezone para simplificar o teste), janela 22:30-07:00,
  // intervalo de 15 min -> cairia às 22:55, que ainda está dentro da janela -> deve pular pra 07:00.
  const task = baseTask({
    repeat_interval_minutes: 15,
    quiet_hours_enabled: 1,
    quiet_hours_start: '22:30',
    quiet_hours_end: '07:00',
    quiet_hours_timezone: 'UTC'
  });
  const next = computeNextReminderAt(task, '2026-07-26T22:40:00.000Z');
  const hourMinute = next.slice(11, 16);
  check('próximo lembrete é adiado para o fim do horário silencioso (07:00)', hourMinute === '07:00');
}

async function testProcessDueTaskIdempotent() {
  console.log('processDueTask (fluxo completo contra D1 falso)');

  const originalFetch = global.fetch;
  let fetchCallCount = 0;
  global.fetch = async () => {
    fetchCallCount += 1;
    return new Response(null, { status: 201 });
  };

  try {
    const db = createFakeD1(schemaSql);
    const now = new Date().toISOString();

    await db.prepare(
      `INSERT INTO installations (id, token_hash, created_at, updated_at, last_seen_at) VALUES (?, 'x', ?, ?, ?)`
    ).bind('install-1', now, now, now).run();

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const p256dh = btoa(String.fromCharCode(...rawPublic)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const auth = btoa('0123456789abcdef').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await db.prepare(
      `INSERT INTO push_subscriptions (installation_id, endpoint, p256dh, auth, is_valid, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).bind('install-1', 'https://push.example.com/abc', p256dh, auth, now, now).run();

    await db.prepare(
      `INSERT INTO tasks (
        id, installation_id, module, task_type, started_at, first_reminder_at, next_reminder_at,
        repeat_interval_minutes, intensity, quiet_hours_enabled, status, reminder_count, created_at, updated_at
      ) VALUES ('task-x', 'install-1', 'laundry', 'take_out_machine', ?, ?, ?, 15, 'normal', 0, 'scheduled', 0, ?, ?)`
    ).bind(now, now, now, now, now).run();

    const env = { DB: db };
    const vapidKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const vapidKeys = {
      publicKey: 'fake-pub',
      privateKeyJwk: await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey)
    };

    const taskRow = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('task-x').first();

    // Simula duas execuções CONCORRENTES do cron pegando a mesma tarefa vencida (cenário de
    // corrida real: dois ticks sobrepostos, ou um retry). Ambas chamam processDueTask() com
    // a mesma linha "fresh" ainda não atualizada. Isso testa exatamente a exigência da seção 16:
    // "tratamento de concorrência ao concluir uma tarefa no mesmo momento em que um lembrete
    // está sendo enviado" — aqui aplicado ao próprio envio do lembrete.
    const [outcomeA, outcomeB] = await Promise.all([
      processDueTask(env, taskRow, { vapidKeys, vapidSubject: 'mailto:t@example.com' }),
      processDueTask(env, taskRow, { vapidKeys, vapidSubject: 'mailto:t@example.com' })
    ]);
    const outcomes = [outcomeA.outcome, outcomeB.outcome].sort();
    check('das duas execuções concorrentes, exatamente uma envia e a outra é descartada', (
      outcomes[0] === 'duplicate_skipped' && outcomes[1] === 'sent'
    ));
    check('o Web Push só foi efetivamente enviado 1 vez, mesmo com a corrida', fetchCallCount === 1);

    const afterFirst = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('task-x').first();
    check('reminder_count incrementado para 1 (não 2)', afterFirst.reminder_count === 1);
    check('status vira reminding', afterFirst.status === 'reminding');
    check('next_reminder_at recalculado para o futuro', new Date(afterFirst.next_reminder_at) > new Date(now));

    // Concluir a tarefa e então tentar processá-la de novo: não deve enviar mais nada.
    await db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).bind(now, 'task-x').run();
    const completedRow = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('task-x').first();
    const outcome3 = await processDueTask(env, completedRow, { vapidKeys, vapidSubject: 'mailto:t@example.com' });
    check('tarefa concluída não gera mais notificações', outcome3.outcome === 'already_terminal');
    check('fetch não foi chamado de novo após a conclusão', fetchCallCount === 1);
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await testIntervals();
  testQuietHoursReschedule();
  await testProcessDueTaskIdempotent();
  console.log(`\n${passed} verificações passaram.`);
}

run().catch((err) => {
  console.error('FALHOU: reminderEngine tests');
  console.error(err);
  process.exit(1);
});
