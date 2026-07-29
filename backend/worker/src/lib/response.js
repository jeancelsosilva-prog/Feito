// Helpers de resposta HTTP em JSON, sempre com os headers de CORS corretos anexados.

import { corsHeaders } from './cors.js';

export function json(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
      ...extraHeaders
    }
  });
}

export function errorResponse(request, env, error) {
  const status = error?.status || 500;
  const message = status === 500 ? 'Erro interno.' : (error?.message || 'Erro.');
  if (status === 500) {
    // Nunca vazar detalhes internos/stack para o cliente; log server-side não deve
    // conter dados sensíveis (tokens, endpoints de push completos, etc).
    console.error('unhandled_error', error?.message || error);
  }
  return json(request, env, { error: message, field: error?.field }, status);
}
