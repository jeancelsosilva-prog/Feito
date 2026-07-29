// Utilidades de tempo. Regra do projeto: tudo é armazenado e calculado em UTC.
// A conversão para horário local acontece apenas na exibição (frontend) ou,
// no caso do horário silencioso, usando o timezone IANA salvo na tarefa.

/** ISO 8601 UTC "agora", ex: 2026-07-26T17:12:00.000Z */
export function nowIso() {
  return new Date().toISOString();
}

export function addMinutesIso(isoString, minutes) {
  const date = new Date(isoString);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString();
}

export function isValidIso(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

/**
 * Retorna a hora local 'HH:MM' de um instante UTC para um timezone IANA,
 * usando Intl.DateTimeFormat (suportado nativamente no runtime do Cloudflare Workers).
 */
export function localHourMinute(isoString, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return formatter.format(new Date(isoString)); // "HH:MM"
  } catch {
    // timezone inválido/desconhecido: cai para UTC em vez de derrubar a requisição
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false
    });
    return formatter.format(new Date(isoString));
  }
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Verifica se um instante (isoString) cai dentro do horário silencioso configurado.
 * Suporta janelas que cruzam a meia-noite (ex: 22:30 -> 07:00).
 */
export function isWithinQuietHours({ isoString, quietHoursStart, quietHoursEnd, timeZone }) {
  if (!quietHoursStart || !quietHoursEnd) return false;

  const current = hhmmToMinutes(localHourMinute(isoString, timeZone));
  const start = hhmmToMinutes(quietHoursStart);
  const end = hhmmToMinutes(quietHoursEnd);

  if (start === end) return false; // janela de duração zero = desativada
  if (start < end) {
    // janela dentro do mesmo dia, ex: 13:00 -> 14:00
    return current >= start && current < end;
  }
  // janela cruza a meia-noite, ex: 22:30 -> 07:00
  return current >= start || current < end;
}

/**
 * Dado um instante dentro do horário silencioso, calcula quando ele termina
 * (o próximo horário local igual a quietHoursEnd), em UTC ISO.
 * Implementação por busca incremental (minuto a minuto, limitada a 24h) — simples e robusta
 * o suficiente para o volume de tarefas do MVP, sem depender de libs de timezone externas.
 */
export function nextQuietHoursEnd({ isoString, quietHoursEnd, timeZone }) {
  let cursor = new Date(isoString);
  const endMinutes = hhmmToMinutes(quietHoursEnd);
  for (let i = 0; i < 24 * 60; i++) {
    cursor = new Date(cursor.getTime() + 60_000);
    const current = hhmmToMinutes(localHourMinute(cursor.toISOString(), timeZone));
    if (current === endMinutes) {
      return cursor.toISOString();
    }
  }
  // fallback de segurança: 8 horas à frente
  return addMinutesIso(isoString, 8 * 60);
}
