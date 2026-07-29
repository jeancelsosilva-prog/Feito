// Testes de API: exercitam os handlers reais do Worker (router.js -> handlers/*) contra
// um D1 falso em memória (fakeD1.mjs), com TODAS as migrations aplicadas (loadFullSchemaSql).
// Cobre autenticação, CRUD/transições de tarefa, push (subscribe/unsubscribe/test), CORS,
// idempotência (replay E rejeição de payload divergente), paginação real do histórico e
// validação de payloads inválidos. Não sobe o runtime do Cloudflare Workers — para um teste
// de ponta a ponta real, use `wrangler dev` (ver tests/README.md).
//
// Rodar com: node tests/api/api.test.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeD1, loadFullSchemaSql } from './fakeD1.mjs';
import { route } from '../../backend/worker/src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = loadFullSchemaSql(path.join(__dirname, '../../backend/migrations'));

const ORIGIN = 'https://test-user.github.io';

async function buildEnv() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return {
    DB: createFakeD1(schemaSql),
    ALLOWED_ORIGINS: ORIGIN,
    VAPID_SUBJECT: 'mailto:teste@example.com',
    VAPID_PUBLIC_KEY: 'fake-public-key',
    VAPID_PRIVATE_KEY_JWK: JSON.stringify(privateKeyJwk)
  };
}

function req(pathAndQuery, { method = 'GET', headers = {}, body, rawBody } = {}) {
  return new Request(`https://api.example.workers.dev${pathAndQuery}`, {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : undefined)
  });
}

async function generatePushKeys() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const p256dh = Buffer.from(rawPublic).toString('base64url');
  const auth = Buffer.from('0123456789abcdef').toString('base64url');
  return { p256dh, auth };
}

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

function validTaskPayload(overrides = {}) {
  const nowIso = new Date().toISOString();
  const firstReminderAt = new Date(Date.now() + 58 * 60 * 1000).toISOString();
  return {
    module: 'laundry',
    task_type: 'take_out_machine',
    started_at: nowIso,
    first_reminder_at: firstReminderAt,
    repeat_interval_minutes: 15,
    intensity: 'normal',
    quiet_hours_enabled: true,
    quiet_hours_start: '22:30',
    quiet_hours_end: '07:00',
    quiet_hours_timezone: 'America/Sao_Paulo',
    ...overrides
  };
}

async function run() {
  const env = await buildEnv();

  // --- 1. Instalações ---
  console.log('Instalações');
  const createRes = await route(req('/api/installations', { method: 'POST', body: {} }), env);
  const createBody = await createRes.json();
  check('POST /api/installations sem credenciais -> 201', createRes.status === 201);
  check('resposta contém installationId e token', !!createBody.installationId && !!createBody.token);

  const { installationId, token } = createBody;
  const authHeaders = { Authorization: `Bearer ${token}`, 'X-Installation-Id': installationId };

  const badAuthRes = await route(req('/api/installations', {
    method: 'POST',
    headers: { Authorization: 'Bearer token-errado', 'X-Installation-Id': installationId },
    body: {}
  }), env);
  check('POST /api/installations com token errado -> 401', badAuthRes.status === 401);

  const updateRes = await route(req('/api/installations', {
    method: 'POST', headers: authHeaders, body: { timezone: 'America/Sao_Paulo' }
  }), env);
  const updateBody = await updateRes.json();
  check('POST /api/installations com token correto -> 200, sem novo token', updateRes.status === 200 && updateBody.token === null);

  // --- 2. CORS ---
  console.log('CORS');
  const preflight = await route(new Request('https://api.example.workers.dev/api/tasks', {
    method: 'OPTIONS', headers: { Origin: ORIGIN }
  }), env);
  check('OPTIONS de origem permitida -> 204 com Allow-Origin', preflight.status === 204 && preflight.headers.get('Access-Control-Allow-Origin') === ORIGIN);

  const foreignPreflight = await route(new Request('https://api.example.workers.dev/api/tasks', {
    method: 'OPTIONS', headers: { Origin: 'https://site-malicioso.com' }
  }), env);
  check('OPTIONS de origem não permitida -> sem Allow-Origin', !foreignPreflight.headers.get('Access-Control-Allow-Origin'));

  // --- 3. Criação de tarefa: caminho feliz ---
  console.log('Tarefas — criação');
  const noAuthTask = await route(req('/api/tasks', { method: 'POST', body: {} }), env);
  check('POST /api/tasks sem auth -> 401', noAuthTask.status === 401);

  const taskPayload = validTaskPayload();
  const idemKey = crypto.randomUUID();
  const createTaskRes = await route(req('/api/tasks', {
    method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': idemKey }, body: taskPayload
  }), env);
  const createTaskBody = await createTaskRes.json();
  check('POST /api/tasks -> 201', createTaskRes.status === 201);
  check('tarefa criada com status scheduled', createTaskBody.task.status === 'scheduled');
  check('next_reminder_at = first_reminder_at na criação', createTaskBody.task.next_reminder_at === taskPayload.first_reminder_at);

  const taskId = createTaskBody.task.id;

  const replayRes = await route(req('/api/tasks', {
    method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': idemKey }, body: taskPayload
  }), env);
  const replayBody = await replayRes.json();
  check('replay da mesma Idempotency-Key (mesmo payload) -> mesma tarefa, sem duplicar', replayBody.task.id === taskId);

  const mismatchRes = await route(req('/api/tasks', {
    method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': idemKey }, body: validTaskPayload({ repeat_interval_minutes: 30 })
  }), env);
  const mismatchBody = await mismatchRes.json();
  check('reusar a mesma Idempotency-Key com payload DIFERENTE -> 409, não cria/retorna outra tarefa', mismatchRes.status === 409 && !mismatchBody.task);

  const invalidJsonRes = await route(req('/api/tasks', {
    method: 'POST', headers: authHeaders, rawBody: '{ isso não é json'
  }), env);
  check('JSON malformado no corpo -> 400', invalidJsonRes.status === 400);

  // --- 4. Validação de payload ---
  console.log('Tarefas — validação');
  const validationCases = [
    ['task_type inválido', validTaskPayload({ task_type: 'voar_de_vassoura' })],
    ['module inexistente', validTaskPayload({ module: 'jardinagem' })],
    ['intensity desconhecida', validTaskPayload({ intensity: 'furiosa' })],
    ['repeat_interval_minutes negativo', validTaskPayload({ repeat_interval_minutes: -5 })],
    ['repeat_interval_minutes excessivo', validTaskPayload({ repeat_interval_minutes: 99999 })],
    ['first_reminder_at antes de started_at', (() => {
      const p = validTaskPayload();
      const started = new Date(p.started_at);
      p.first_reminder_at = new Date(started.getTime() - 60000).toISOString();
      return p;
    })()],
    ['título personalizado vazio', validTaskPayload({ task_type: 'custom', custom_title: '   ' })],
    ['horário silencioso malformado', validTaskPayload({ quiet_hours_start: '25:99' })]
  ];
  for (const [label, payload] of validationCases) {
    const res = await route(req('/api/tasks', { method: 'POST', headers: authHeaders, body: payload }), env);
    check(`rejeita payload — ${label} (status ${res.status})`, res.status === 422);
  }

  // Título personalizado longo demais é truncado (80 chars), não rejeitado — é sanitizeText()
  // fazendo seu trabalho; confirmamos que ele nunca ultrapassa o limite salvo no banco.
  const longTitleRes = await route(req('/api/tasks', {
    method: 'POST', headers: authHeaders, body: validTaskPayload({ task_type: 'custom', custom_title: 'x'.repeat(500) })
  }), env);
  const longTitleBody = await longTitleRes.json();
  check('título personalizado muito longo é truncado, não quebra a criação', longTitleRes.status === 201 && longTitleBody.task.custom_title.length === 80);

  // --- 5. GET /api/tasks/:id ---
  console.log('Tarefas — leitura individual');
  const getOwnRes = await route(req(`/api/tasks/${taskId}`, { headers: authHeaders }), env);
  const getOwnBody = await getOwnRes.json();
  check('GET /api/tasks/:id da própria instalação -> 200', getOwnRes.status === 200 && getOwnBody.task.id === taskId);

  const getMissingRes = await route(req('/api/tasks/nao-existe', { headers: authHeaders }), env);
  check('GET /api/tasks/:id inexistente -> 404', getMissingRes.status === 404);

  const listRes = await route(req('/api/tasks/active', { headers: authHeaders }), env);
  const listBody = await listRes.json();
  check('GET /api/tasks/active retorna a tarefa criada', listBody.tasks.some((t) => t.id === taskId));

  // --- 6. Pausar / retomar ---
  console.log('Tarefas — pausar e retomar');
  const pauseRes = await route(req(`/api/tasks/${taskId}/pause`, { method: 'POST', headers: authHeaders }), env);
  const pauseBody = await pauseRes.json();
  check('POST pause -> 200, status paused, sem next_reminder_at', pauseRes.status === 200 && pauseBody.task.status === 'paused' && pauseBody.task.next_reminder_at === null);

  const pauseAgainRes = await route(req(`/api/tasks/${taskId}/pause`, { method: 'POST', headers: authHeaders }), env);
  check('pausar uma tarefa já pausada -> 409 (não é um estado ativo)', pauseAgainRes.status === 409);

  const resumeRes = await route(req(`/api/tasks/${taskId}/resume`, { method: 'POST', headers: authHeaders }), env);
  const resumeBody = await resumeRes.json();
  check('POST resume -> 200, volta a reminding com next_reminder_at definido', resumeRes.status === 200 && resumeBody.task.status === 'reminding' && !!resumeBody.task.next_reminder_at);

  const resumeAgainRes = await route(req(`/api/tasks/${taskId}/resume`, { method: 'POST', headers: authHeaders }), env);
  check('retomar uma tarefa que não está pausada -> 409', resumeAgainRes.status === 409);

  // --- 7. Reforço "estou em casa" ---
  console.log('Tarefas — home boost');
  const boostRes = await route(req(`/api/tasks/${taskId}/home-boost`, { method: 'POST', headers: authHeaders }), env);
  const boostBody = await boostRes.json();
  check('POST home-boost -> 200, home_boost_until no futuro', boostRes.status === 200 && new Date(boostBody.task.home_boost_until) > new Date());

  // --- 8. Conclusão antecipada ---
  console.log('Tarefas — conclusão');
  const completeRes = await route(req(`/api/tasks/${taskId}/complete`, { method: 'POST', headers: authHeaders }), env);
  const completeBody = await completeRes.json();
  check('POST complete -> 200, status completed', completeRes.status === 200 && completeBody.task.status === 'completed');
  check('completed_at preenchido e next_reminder_at nulo', !!completeBody.task.completed_at && completeBody.task.next_reminder_at === null);

  const completeAgainRes = await route(req(`/api/tasks/${taskId}/complete`, { method: 'POST', headers: authHeaders }), env);
  const completeAgainBody = await completeAgainRes.json();
  check('concluir tarefa já concluída -> 200 idempotente (no-op), não erro', completeAgainRes.status === 200 && completeAgainBody.alreadyTerminal === true);

  const boostAfterCompleteRes = await route(req(`/api/tasks/${taskId}/home-boost`, { method: 'POST', headers: authHeaders }), env);
  check('home-boost em tarefa já concluída -> 409', boostAfterCompleteRes.status === 409);

  const listAfterCompleteRes = await route(req('/api/tasks/active', { headers: authHeaders }), env);
  const listAfterCompleteBody = await listAfterCompleteRes.json();
  check('tarefa concluída some da lista de ativas', !listAfterCompleteBody.tasks.some((t) => t.id === taskId));

  // Reusar a mesma Idempotency-Key para concluir tarefas DIFERENTES é tratado como o mesmo
  // tipo de conflito de "payload divergente" (aqui o "payload" é o próprio taskId, passado
  // como requestHash — ver handlers/tasks.js). O importante é que a segunda chamada NUNCA
  // devolva, por engano, a resposta da primeira tarefa nem toque na segunda tarefa.
  console.log('Idempotência entre tarefas diferentes');
  const idemKeyShared = crypto.randomUUID();
  const taskA = (await (await route(req('/api/tasks', { method: 'POST', headers: authHeaders, body: validTaskPayload() }), env)).json()).task;
  const taskB = (await (await route(req('/api/tasks', { method: 'POST', headers: authHeaders, body: validTaskPayload() }), env)).json()).task;

  const completeARes = await route(req(`/api/tasks/${taskA.id}/complete`, { method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': idemKeyShared } }), env);
  const completeABody = await completeARes.json();
  check('primeira tarefa conclui normalmente com a chave nova', completeARes.status === 200 && completeABody.task.id === taskA.id);

  const completeBRes = await route(req(`/api/tasks/${taskB.id}/complete`, { method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': idemKeyShared } }), env);
  check('reusar a mesma chave para uma tarefa DIFERENTE -> 409, não "vaza" a resposta da primeira', completeBRes.status === 409);

  const taskBAfterRes = await route(req(`/api/tasks/${taskB.id}`, { headers: authHeaders }), env);
  const taskBAfterBody = await taskBAfterRes.json();
  check('a segunda tarefa continua intocada (não foi concluída por engano)', taskBAfterBody.task.status !== 'completed');

  // Com uma chave própria (ou sem nenhuma), a segunda tarefa conclui normalmente.
  const completeBRetryRes = await route(req(`/api/tasks/${taskB.id}/complete`, { method: 'POST', headers: authHeaders }), env);
  const completeBRetryBody = await completeBRetryRes.json();
  check('a mesma tarefa conclui normalmente com uma chamada sem conflito de chave', completeBRetryRes.status === 200 && completeBRetryBody.task.status === 'completed');

  // --- 9. Cancelamento ---
  console.log('Cancelamento');
  const task3 = (await (await route(req('/api/tasks', { method: 'POST', headers: authHeaders, body: validTaskPayload() }), env)).json()).task;
  const cancelRes = await route(req(`/api/tasks/${task3.id}/cancel`, { method: 'POST', headers: authHeaders }), env);
  const cancelBody = await cancelRes.json();
  check('POST cancel -> 200, status cancelled', cancelRes.status === 200 && cancelBody.task.status === 'cancelled');

  // --- 10. Push: subscribe / unsubscribe / test ---
  console.log('Push');
  const pushNoAuthRes = await route(req('/api/push/subscribe', { method: 'POST', body: {} }), env);
  check('POST /api/push/subscribe sem auth -> 401', pushNoAuthRes.status === 401);

  const { p256dh, auth } = await generatePushKeys();
  const subscribeRes = await route(req('/api/push/subscribe', {
    method: 'POST', headers: authHeaders,
    body: { endpoint: 'https://push.example.com/abc123', keys: { p256dh, auth } }
  }), env);
  check('POST /api/push/subscribe com chaves válidas -> 201', subscribeRes.status === 201);

  const subscribeInvalidRes = await route(req('/api/push/subscribe', {
    method: 'POST', headers: authHeaders,
    body: { endpoint: 'http://nao-eh-https.example.com', keys: { p256dh, auth } }
  }), env);
  check('POST /api/push/subscribe com endpoint não-https -> 422', subscribeInvalidRes.status === 422);

  const originalFetch = global.fetch;
  let pushSendCalls = 0;
  global.fetch = async () => { pushSendCalls += 1; return new Response(null, { status: 201 }); };
  try {
    const testRes = await route(req('/api/push/test', { method: 'POST', headers: authHeaders }), env);
    const testBody = await testRes.json();
    check('POST /api/push/test com assinatura ativa -> 200 e envia de fato', testRes.status === 200 && testBody.results.length === 1 && pushSendCalls === 1);
  } finally {
    global.fetch = originalFetch;
  }

  const unsubscribeRes = await route(req('/api/push/subscribe', {
    method: 'DELETE', headers: authHeaders, body: { endpoint: 'https://push.example.com/abc123' }
  }), env);
  check('DELETE /api/push/subscribe -> 200', unsubscribeRes.status === 200);

  const testAfterUnsubscribeRes = await route(req('/api/push/test', { method: 'POST', headers: authHeaders }), env);
  check('POST /api/push/test sem nenhuma assinatura -> 404', testAfterUnsubscribeRes.status === 404);

  // --- 11. Histórico com paginação real ---
  console.log('Histórico');
  // Neste ponto já existem 4 tarefas terminais (taskId, taskA, taskB, task3). Pedimos
  // limit=2 para forçar nextCursor e de fato exercitar a segunda página.
  const page1Res = await route(req('/api/history?limit=2', { headers: authHeaders }), env);
  const page1Body = await page1Res.json();
  check('primeira página do histórico respeita o limit e devolve nextCursor', page1Body.tasks.length === 2 && !!page1Body.nextCursor);

  const page2Res = await route(req(`/api/history?limit=2&cursor=${encodeURIComponent(page1Body.nextCursor)}`, { headers: authHeaders }), env);
  const page2Body = await page2Res.json();
  check('segunda página traz o restante e não repete itens da primeira', page2Body.tasks.length === 2 && page2Body.tasks.every((t) => !page1Body.tasks.some((p) => p.id === t.id)));
  check('segunda página não tem mais próxima página (nextCursor nulo)', page2Body.nextCursor === null);

  console.log(`\n${passed} verificações passaram.`);
}

run().catch((err) => {
  console.error('FALHOU: api tests');
  console.error(err);
  process.exit(1);
});
