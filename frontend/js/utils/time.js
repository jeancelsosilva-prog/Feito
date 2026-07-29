// Formatação de datas para exibição local. O backend sempre manda UTC ISO; aqui só
// convertemos para o que o usuário vê na tela, usando o fuso do próprio dispositivo.

export function formatClock(isoString) {
  if (!isoString) return '--:--';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatElapsed(startedAtIso, nowMs = Date.now()) {
  const start = new Date(startedAtIso).getTime();
  const diffMs = Math.max(0, nowMs - start);
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}`;
  return `${minutes} min`;
}

export function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Converte um Date local em ISO UTC — usado ao deixar o usuário ajustar o horário de início manualmente. */
export function localDateTimeInputToIso(value) {
  // value vem de <input type="datetime-local">, ex: "2026-07-26T14:12"
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function isoToLocalDateTimeInputValue(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
