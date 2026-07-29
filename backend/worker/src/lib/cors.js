// CORS restrito ao(s) domínio(s) do GitHub Pages configurado(s) via variável de ambiente
// ALLOWED_ORIGIN (uma origem) ou ALLOWED_ORIGINS (lista separada por vírgula).
// Configurado em wrangler.toml [vars] — não é secreto.

function getAllowedOrigins(env) {
  const list = env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '';
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

export function resolveCorsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = getAllowedOrigins(env);
  if (origin && allowed.includes(origin)) return origin;
  // Sem correspondência: não ecoa a origem (o browser vai bloquear a resposta, como esperado).
  return null;
}

export function corsHeaders(request, env) {
  const origin = resolveCorsOrigin(request, env);
  const headers = {
    'Vary': 'Origin'
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Installation-Id, Idempotency-Key';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

export function handlePreflight(request, env) {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
