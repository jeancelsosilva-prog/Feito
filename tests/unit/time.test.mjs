// Testes do motor de horário/silêncio (backend/worker/src/lib/time.js).
// Rodar com: node tests/unit/time.test.mjs

import assert from 'node:assert/strict';
import { isWithinQuietHours, nextQuietHoursEnd, addMinutesIso, localHourMinute } from '../../backend/worker/src/lib/time.js';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok - ${label}`);
}

function run() {
  // Janela que cruza a meia-noite: 22:30 -> 07:00, timezone America/Sao_Paulo (UTC-3).
  // 23:00 local = 02:00 UTC do dia seguinte.
  const within = isWithinQuietHours({
    isoString: '2026-07-27T02:00:00.000Z', // 23:00 em São Paulo
    quietHoursStart: '22:30',
    quietHoursEnd: '07:00',
    timeZone: 'America/Sao_Paulo'
  });
  check('23:00 local está dentro de 22:30-07:00', within === true);

  const outside = isWithinQuietHours({
    isoString: '2026-07-27T18:00:00.000Z', // 15:00 em São Paulo
    quietHoursStart: '22:30',
    quietHoursEnd: '07:00',
    timeZone: 'America/Sao_Paulo'
  });
  check('15:00 local está fora de 22:30-07:00', outside === false);

  const edgeStart = isWithinQuietHours({
    isoString: '2026-07-27T01:30:00.000Z', // 22:30 em São Paulo (início exato)
    quietHoursStart: '22:30',
    quietHoursEnd: '07:00',
    timeZone: 'America/Sao_Paulo'
  });
  check('22:30 local (início exato) conta como dentro da janela', edgeStart === true);

  const edgeEnd = isWithinQuietHours({
    isoString: '2026-07-27T10:00:00.000Z', // 07:00 em São Paulo (fim exato)
    quietHoursStart: '22:30',
    quietHoursEnd: '07:00',
    timeZone: 'America/Sao_Paulo'
  });
  check('07:00 local (fim exato) já conta como fora da janela', edgeEnd === false);

  const resumeAt = nextQuietHoursEnd({
    isoString: '2026-07-27T02:00:00.000Z', // 23:00 em São Paulo
    quietHoursEnd: '07:00',
    timeZone: 'America/Sao_Paulo'
  });
  const resumeLocal = localHourMinute(resumeAt, 'America/Sao_Paulo');
  check('nextQuietHoursEnd cai exatamente às 07:00 locais', resumeLocal === '07:00');

  const disabled = isWithinQuietHours({
    isoString: '2026-07-27T02:00:00.000Z',
    quietHoursStart: '10:00',
    quietHoursEnd: '10:00', // janela de duração zero = desativada
    timeZone: 'America/Sao_Paulo'
  });
  check('janela start === end é tratada como desativada', disabled === false);

  check('addMinutesIso soma minutos corretamente', addMinutesIso('2026-07-26T14:12:00.000Z', 58) === '2026-07-26T15:10:00.000Z');

  console.log(`\n${passed} verificações passaram.`);
}

run();
