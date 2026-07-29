// Testes do seletor de mensagens (backend/worker/src/lib/messages.js).
// Rodar com: node tests/unit/messages.test.mjs

import assert from 'node:assert/strict';
import { pickMessage, resolveStage, MESSAGE_POOLS } from '../../backend/worker/src/lib/messages.js';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

function run() {
  check('resolveStage: 0 avisos anteriores -> first', resolveStage({ reminderCountBeforeThisSend: 0, isHomeBoostActive: false }) === 'first');
  check('resolveStage: 1-2 avisos anteriores -> follow_up', resolveStage({ reminderCountBeforeThisSend: 2, isHomeBoostActive: false }) === 'follow_up');
  check('resolveStage: 3+ avisos anteriores -> later', resolveStage({ reminderCountBeforeThisSend: 5, isHomeBoostActive: false }) === 'later');
  check('resolveStage: home boost ativo sempre vence -> home_boost', resolveStage({ reminderCountBeforeThisSend: 0, isHomeBoostActive: true }) === 'home_boost');

  // Nunca repete a mesma mensagem duas vezes seguidas (roda 200x para reduzir chance de falso positivo).
  let sawDifferentKey = true;
  let lastKey = null;
  for (let i = 0; i < 200; i++) {
    const msg = pickMessage({ module: 'laundry', stage: 'later', lastMessageKey: lastKey });
    if (lastKey && msg.key === lastKey) sawDifferentKey = false;
    lastKey = msg.key;
  }
  check('pickMessage nunca repete a mesma chave duas vezes seguidas (200 iterações)', sawDifferentKey);

  for (const [module, pools] of Object.entries(MESSAGE_POOLS)) {
    for (const [stage, pool] of Object.entries(pools)) {
      check(`pool ${module}.${stage} tem pelo menos 1 mensagem`, pool.length >= 1);
      const keys = pool.map((m) => m.key);
      check(`pool ${module}.${stage} não tem chaves duplicadas`, new Set(keys).size === keys.length);
    }
  }

  console.log(`\n${passed} verificações passaram.`);
}

run();
