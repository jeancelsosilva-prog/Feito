import { json } from '../lib/response.js';
import { requireInstallation } from '../lib/auth.js';

// O cursor precisa ser uma dupla (created_at, id), não só created_at. Duas tarefas criadas
// no mesmo milissegundo (colisão de timestamp — rara em uso real, mas fácil de reproduzir em
// testes automatizados que criam várias tarefas em sequência rápida) teriam o mesmo
// created_at; com um corte estrito só por created_at, a segunda delas seria silenciosamente
// PULADA sempre que caísse exatamente na fronteira entre duas páginas. O id (UUID) desempata.
function encodeCursor(task) {
  return `${task.created_at}|${task.id}`;
}

function decodeCursor(raw) {
  const sep = raw.lastIndexOf('|');
  if (sep === -1) return null;
  return { createdAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
}

/**
 * GET /api/history?limit=20&cursor=<created_at>|<id>
 * Retorna tarefas terminais (concluídas/canceladas), paginadas por cursor composto
 * (created_at, id) — estável mesmo com timestamps empatados — mais alguns indicadores
 * neutros (nunca valores financeiros inventados — ver seção 15).
 */
export async function handleHistory(request, env) {
  const { installationId } = await requireInstallation(request, env);
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  let query = `SELECT * FROM tasks WHERE installation_id = ? AND status IN ('completed','cancelled')`;
  const binds = [installationId];
  if (cursor) {
    query += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  binds.push(limit + 1);

  const rows = await env.DB.prepare(query).bind(...binds).all();
  const results = rows.results || [];
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

  // Indicadores neutros e explicáveis — nenhuma estimativa financeira/ambiental "inventada".
  const completedTasks = page.filter((t) => t.status === 'completed');
  const completedBeforeThirdReminder = completedTasks.filter((t) => t.reminder_count < 3).length;
  const avgReminders = completedTasks.length
    ? completedTasks.reduce((sum, t) => sum + t.reminder_count, 0) / completedTasks.length
    : 0;

  return json(request, env, {
    tasks: page,
    nextCursor,
    indicators: {
      completedInPage: completedTasks.length,
      completedBeforeThirdReminder,
      averageRemindersPerTask: Math.round(avgReminders * 10) / 10
    }
  }, 200);
}
