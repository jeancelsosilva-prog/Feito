import { handlePreflight } from './lib/cors.js';
import { errorResponse, json } from './lib/response.js';
import { handleCreateOrUpdateInstallation } from './handlers/installations.js';
import { handleSubscribe, handleUnsubscribe, handlePushTest } from './handlers/push.js';
import {
  handleListActiveTasks, handleGetTask, handleCreateTask,
  handleCompleteTask, handleCancelTask, handlePauseTask, handleResumeTask, handleHomeBoost
} from './handlers/tasks.js';
import { handleHistory } from './handlers/history.js';

// Roteador minimalista — sem framework, para manter o bundle pequeno e fácil de auditar.
export async function route(request, env) {
  const preflight = handlePreflight(request, env);
  if (preflight) return preflight;

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  try {
    if (path === '/api/health' && method === 'GET') {
      return json(request, env, { ok: true, time: new Date().toISOString() }, 200);
    }

    if (path === '/api/installations' && method === 'POST') {
      return await handleCreateOrUpdateInstallation(request, env);
    }

    if (path === '/api/push/subscribe' && method === 'POST') {
      return await handleSubscribe(request, env);
    }
    if (path === '/api/push/subscribe' && method === 'DELETE') {
      return await handleUnsubscribe(request, env);
    }
    if (path === '/api/push/test' && method === 'POST') {
      return await handlePushTest(request, env);
    }

    if (path === '/api/tasks/active' && method === 'GET') {
      return await handleListActiveTasks(request, env);
    }
    if (path === '/api/tasks' && method === 'POST') {
      return await handleCreateTask(request, env);
    }

    const taskActionMatch = path.match(/^\/api\/tasks\/([^/]+)\/(complete|cancel|pause|resume|home-boost)$/);
    if (taskActionMatch && method === 'POST') {
      const [, taskId, action] = taskActionMatch;
      switch (action) {
        case 'complete': return await handleCompleteTask(request, env, taskId);
        case 'cancel': return await handleCancelTask(request, env, taskId);
        case 'pause': return await handlePauseTask(request, env, taskId);
        case 'resume': return await handleResumeTask(request, env, taskId);
        case 'home-boost': return await handleHomeBoost(request, env, taskId);
      }
    }

    const taskGetMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskGetMatch && method === 'GET') {
      return await handleGetTask(request, env, taskGetMatch[1]);
    }

    if (path === '/api/history' && method === 'GET') {
      return await handleHistory(request, env);
    }

    return errorResponse(request, env, { status: 404, message: 'Rota não encontrada.' });
  } catch (err) {
    if (err && typeof err.status === 'number') {
      return errorResponse(request, env, err);
    }
    return errorResponse(request, env, { status: 500, message: 'Erro interno.', _internal: err });
  }
}
