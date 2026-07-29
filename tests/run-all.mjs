// Roda todos os testes do repositório em sequência e falha (exit code 1) se qualquer um falhar.
// Uso: node tests/run-all.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const files = [
  'unit/time.test.mjs',
  'unit/messages.test.mjs',
  'unit/reminderEngine.test.mjs',
  'unit/cron.test.mjs',
  'unit/completeVsSend.test.mjs',
  'unit/webpush.test.mjs',
  'unit/webpushFailures.test.mjs',
  'unit/vapid.test.mjs',
  'api/api.test.mjs'
];

let failures = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.status !== 0) failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} arquivo(s) de teste falharam.`);
  process.exit(1);
}
console.log('\nTodos os testes passaram.');
