// Fumaça (smoke test) de backend/worker/src/cron.js: runReminderSweep() e runMaintenance()
// não são exercitados por reminderEngine.test.mjs (que chama processDueTask diretamente),
// então este teste garante que os dois pontos de entrada usados pelo Worker de verdade
// (fetch/scheduled em src/index.js) não têm erro de digitação em nome de coluna/tabela.
//
// Também testa o roteamento de src/index.js `scheduled()` entre os dois Cron Triggers
// ("* * * * *" e "0 * * * *") via `event.cron` — ver comentário em src/index.js sobre por
// que isso substituiu um contador em memória (não confiável em runtime serverless).
//
// Rodar com: node tests/unit/cron.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeD1, loadFullSchemaSql } from '../api/fakeD1.mjs';
import { runReminderSweep, runMaintenance } from '../../backend/worker/src/cron.js';
import workerModule from '../../backend/worker/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = loadFullSchemaSql(path.join(__dirname, '../../backend/migrations'));

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

async function run() {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return new Response(null, { status: 201 }); };

  try {
    const db = createFakeD1(schemaSql);
    const now = new Date();
    const nowIso = now.toISOString();
    const pastIso = new Date(now.getTime() - 5 * 60000).toISOString();
    const oldCreatedAt = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

    await db.prepare(`INSERT INTO installations (id, token_hash, created_at, updated_at, last_seen_at) VALUES ('i1','x',?,?,?)`).bind(nowIso, nowIso, nowIso).run();

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const p256dh = Buffer.from(rawPublic).toString('base64url');
    const auth = Buffer.from('0123456789abcdef').toString('base64url');

    await db.prepare(
      `INSERT INTO push_subscriptions (installation_id, endpoint, p256dh, auth, is_valid, created_at, updated_at)
       VALUES ('i1', 'https://push.example.com/x', ?, ?, 1, ?, ?)`
    ).bind(p256dh, auth, nowIso, nowIso).run();

    // Tarefa vencida (deve ser pega pelo sweep) e uma tarefa "abandonada" há 40 dias (deve
    // ser cancelada pela manutenção).
    await db.prepare(
      `INSERT INTO tasks (id, installation_id, module, task_type, started_at, first_reminder_at, next_reminder_at,
        repeat_interval_minutes, intensity, quiet_hours_enabled, status, reminder_count, created_at, updated_at)
       VALUES ('due-1', 'i1', 'laundry', 'take_out_machine', ?, ?, ?, 15, 'normal', 0, 'scheduled', 0, ?, ?)`
    ).bind(pastIso, pastIso, pastIso, pastIso, pastIso).run();

    await db.prepare(
      `INSERT INTO tasks (id, installation_id, module, task_type, started_at, first_reminder_at, next_reminder_at,
        repeat_interval_minutes, intensity, quiet_hours_enabled, status, reminder_count, created_at, updated_at)
       VALUES ('abandoned-1', 'i1', 'laundry', 'take_out_machine', ?, ?, NULL, 15, 'normal', 0, 'scheduled', 0, ?, ?)`
    ).bind(oldCreatedAt, oldCreatedAt, oldCreatedAt, oldCreatedAt).run();

    const vapidKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const env = {
      DB: db,
      VAPID_PUBLIC_KEY: 'fake-pub',
      VAPID_PRIVATE_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey)),
      VAPID_SUBJECT: 'mailto:t@example.com'
    };

    const sweepResult = await runReminderSweep(env, { warn() {}, error() {} });
    check('runReminderSweep processa a tarefa vencida', sweepResult.processed === 1);
    check('o push foi efetivamente enviado', fetchCalls === 1);

    const dueAfter = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('due-1').first();
    check('tarefa vencida vira reminding com reminder_count = 1', dueAfter.status === 'reminding' && dueAfter.reminder_count === 1);

    await runMaintenance(env);
    const abandonedAfter = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('abandoned-1').first();
    check('tarefa abandonada há 40 dias é cancelada pela manutenção', abandonedAfter.status === 'cancelled');

    const dueStillActive = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('due-1').first();
    check('tarefa recente não é afetada pela manutenção', dueStillActive.status === 'reminding');

    // --- Roteamento de src/index.js scheduled() por event.cron ---
    console.log('index.js scheduled() — roteamento por event.cron');

    await db.prepare(
      `INSERT INTO tasks (id, installation_id, module, task_type, started_at, first_reminder_at, next_reminder_at,
        repeat_interval_minutes, intensity, quiet_hours_enabled, status, reminder_count, created_at, updated_at)
       VALUES ('due-2', 'i1', 'laundry', 'take_out_machine', ?, ?, ?, 15, 'normal', 0, 'scheduled', 0, ?, ?)`
    ).bind(pastIso, pastIso, pastIso, pastIso, pastIso).run();

    const fetchCallsBefore = fetchCalls;
    let capturedPromise = null;
    const ctx = { waitUntil: (p) => { capturedPromise = p; } };

    await workerModule.scheduled({ cron: '* * * * *' }, env, ctx);
    await capturedPromise;
    const due2AfterSweepTick = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('due-2').first();
    check('event.cron "* * * * *" aciona a varredura de lembretes (não a manutenção)', fetchCalls === fetchCallsBefore + 1 && due2AfterSweepTick.status === 'reminding');

    await db.prepare(
      `INSERT INTO tasks (id, installation_id, module, task_type, started_at, first_reminder_at, next_reminder_at,
        repeat_interval_minutes, intensity, quiet_hours_enabled, status, reminder_count, created_at, updated_at)
       VALUES ('abandoned-2', 'i1', 'laundry', 'take_out_machine', ?, ?, NULL, 15, 'normal', 0, 'scheduled', 0, ?, ?)`
    ).bind(oldCreatedAt, oldCreatedAt, oldCreatedAt, oldCreatedAt).run();

    const fetchCallsBeforeMaintenanceTick = fetchCalls;
    await workerModule.scheduled({ cron: '0 * * * *' }, env, ctx);
    await capturedPromise;
    const abandoned2After = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind('abandoned-2').first();
    check('event.cron "0 * * * *" aciona a manutenção (não a varredura)', abandoned2After.status === 'cancelled' && fetchCalls === fetchCallsBeforeMaintenanceTick);

    console.log(`\n${passed} verificações passaram.`);
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch((err) => {
  console.error('FALHOU: cron tests');
  console.error(err);
  process.exit(1);
});
