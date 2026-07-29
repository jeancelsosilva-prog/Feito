// Testa como o motor de lembretes reage a diferentes respostas do push service (Apple/FCM/
// Mozilla, dependendo do navegador): sucesso, falha permanente (assinatura morta) e falha
// transitória (rede/servidor). Só falhas PERMANENTES podem desativar uma assinatura — uma
// falha transitória não pode fazer o sistema desistir de um dispositivo que pode voltar a
// funcionar no próximo lembrete.
//
// Rodar com: node tests/unit/webpushFailures.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeD1, loadFullSchemaSql } from '../api/fakeD1.mjs';
import { processDueTask } from '../../backend/worker/src/lib/reminderEngine.js';
import { sendWebPush, PushSendError } from '../../backend/worker/src/lib/webpush.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = loadFullSchemaSql(path.join(__dirname, '../../backend/migrations'));

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

async function buildScenario() {
  const db = createFakeD1(schemaSql);
  const now = new Date().toISOString();

  await db.prepare(`INSERT INTO installations (id, token_hash, created_at, updated_at, last_seen_at) VALUES ('i1','x',?,?,?)`).bind(now, now, now).run();

  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ecdh.publicKey));
  const p256dh = Buffer.from(rawPublic).toString('base64url');
  const auth = Buffer.from('0123456789abcdef').toString('base64url');

  let subId;
  const insertSub = await db.prepare(
    `INSERT INTO push_subscriptions (installation_id, endpoint, p256dh, auth, is_valid, created_at, updated_at)
     VALUES ('i1', 'https://push.example.com/x', ?, ?, 1, ?, ?)`
  ).bind(p256dh, auth, now, now).run();
  subId = insertSub.meta.last_row_id;

  const taskId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO tasks (
      id, installation_id, module, task_type, started_at, first_reminder_at, next_reminder_at,
      repeat_interval_minutes, intensity, quiet_hours_enabled, status, reminder_count, created_at, updated_at
    ) VALUES (?, 'i1', 'laundry', 'take_out_machine', ?, ?, ?, 15, 'normal', 0, 'scheduled', 0, ?, ?)`
  ).bind(taskId, now, now, now, now, now).run();

  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const vapidKeys = { publicKey: 'fake-pub', privateKeyJwk: await crypto.subtle.exportKey('jwk', keyPair.privateKey) };
  const env = { DB: db };
  const taskRow = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();

  return { db, env, taskRow, vapidKeys, subId };
}

async function withStubbedFetch(responder, fn) {
  const originalFetch = global.fetch;
  global.fetch = responder;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

async function testStatus(statusCode, { expectPermanentInvalidation }) {
  const { env, taskRow, vapidKeys, db, subId } = await buildScenario();

  const outcome = await withStubbedFetch(
    async () => new Response('erro simulado', { status: statusCode }),
    () => processDueTask(env, taskRow, { vapidKeys, vapidSubject: 'mailto:t@example.com', logger: { warn() {}, error() {} } })
  );

  const subAfter = await db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind(subId).first();

  check(
    `status ${statusCode}: outcome é 'send_failed' (nenhuma assinatura válida sobrou / envio falhou)`,
    outcome.outcome === 'send_failed'
  );
  check(
    `status ${statusCode}: is_valid ${expectPermanentInvalidation ? 'é zerado (falha permanente)' : 'permanece 1 (falha transitória, pode se recuperar)'}`,
    subAfter.is_valid === (expectPermanentInvalidation ? 0 : 1)
  );

  // Mesmo com falha no envio, a tarefa é reagendada — o sistema não trava tentando de novo
  // a cada minuto indefinidamente quando o push service está com problema temporário.
  const taskAfter = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskRow.id).first();
  check(`status ${statusCode}: tarefa é reagendada mesmo após falha de envio`, !!taskAfter.next_reminder_at);
}

async function testSuccess() {
  const { env, taskRow, vapidKeys, db, subId } = await buildScenario();

  const outcome = await withStubbedFetch(
    async () => new Response(null, { status: 201 }),
    () => processDueTask(env, taskRow, { vapidKeys, vapidSubject: 'mailto:t@example.com' })
  );

  const subAfter = await db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind(subId).first();
  check('201 (aceito pelo push service): outcome é "sent"', outcome.outcome === 'sent');
  check('201: assinatura continua válida', subAfter.is_valid === 1);
}

async function testNetworkError() {
  const { env, taskRow, vapidKeys, db, subId } = await buildScenario();

  const outcome = await withStubbedFetch(
    async () => { throw new TypeError('network error simulado (offline/timeout)'); },
    () => processDueTask(env, taskRow, { vapidKeys, vapidSubject: 'mailto:t@example.com', logger: { warn() {}, error() {} } })
  );

  const subAfter = await db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind(subId).first();
  check('erro de rede/timeout: não derruba processDueTask (outcome "send_failed", sem exceção escapando)', outcome.outcome === 'send_failed');
  check('erro de rede/timeout: assinatura NÃO é invalidada (pode ser só uma falha passageira de conexão)', subAfter.is_valid === 1);
}

function testPushSendErrorClassification() {
  console.log('Classificação de erro em sendWebPush (PushSendError.isPermanent)');
  const permanent404 = new PushSendError('não encontrado', 404, true);
  const permanent410 = new PushSendError('gone', 410, true);
  const transient429 = new PushSendError('rate limited', 429, false);
  const transient500 = new PushSendError('erro do servidor', 500, false);

  check('404 é classificado como permanente', permanent404.isPermanent === true);
  check('410 é classificado como permanente', permanent410.isPermanent === true);
  check('429 é classificado como transitório', transient429.isPermanent === false);
  check('500 é classificado como transitório', transient500.isPermanent === false);
}

async function run() {
  testPushSendErrorClassification();

  console.log('sendWebPush + processDueTask contra diferentes respostas do push service');
  await testSuccess();
  await testStatus(404, { expectPermanentInvalidation: true });
  await testStatus(410, { expectPermanentInvalidation: true });
  await testStatus(429, { expectPermanentInvalidation: false });
  await testStatus(500, { expectPermanentInvalidation: false });
  await testStatus(503, { expectPermanentInvalidation: false });
  await testNetworkError();

  console.log(`\n${passed} verificações passaram.`);
}

run().catch((err) => {
  console.error('FALHOU: webpush failure scenarios');
  console.error(err);
  process.exit(1);
});
