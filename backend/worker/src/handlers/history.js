import { json } from '../lib/response.js';
import { requireInstallation } from '../lib/auth.js';

/**
 * GET /api/history?limit=20&cursor=<created_at ISO>
 * Retorna tarefas terminais (concluídas/canceladas), paginadas por cursor de data,
 * mais alguns indicadores neutros (nunca valores financeiros inventados — ver seção 15).
 */
export async function handleHistory(request, env) {
  const { installationId } = await requireInstallation(request, env);
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const cursor = url.searchParams.get('cursor');

  let query = `SELECT * FROM tasks WHERE installation_id = ? AND status IN ('completed','cancelled')`;
  const binds = [installationId];
  if (cursor) {
    query += ' AND created_at < ?';
    binds.push(cursor);
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit + 1);

  const rows = await env.DB.prepare(query).bind(...binds).all();
  const results = rows.results || [];
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;

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
