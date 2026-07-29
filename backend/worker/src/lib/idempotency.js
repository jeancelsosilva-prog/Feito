// Idempotência para endpoints de escrita da API pública (ex: criar tarefa, concluir tarefa).
// O cliente envia o header `Idempotency-Key` (um UUID gerado uma vez por ação do usuário).
// Se a mesma chave chegar de novo (ex: retry de rede no iPhone), devolvemos a resposta salva
// em vez de repetir o efeito colateral.
//
// requestHash (opcional): hash do payload que originou a chamada. Se a MESMA chave for
// reutilizada com um payload DIFERENTE (bug de cliente, ou tentativa de manipular a API
// diretamente), isso é tratado como erro em vez de silenciosamente devolver a resposta da
// primeira chamada — que poderia corresponder a uma tarefa/ação completamente diferente.

import { nowIso } from './time.js';

export async function withIdempotency(env, { installationId, endpoint, idempotencyKey, requestHash = null }, handlerFn) {
  if (!idempotencyKey) {
    // Endpoint chamado sem chave: segue sem proteção de idempotência (ex: GETs).
    return handlerFn();
  }

  const existing = await env.DB.prepare(
    'SELECT response_status, response_body, request_hash FROM idempotency_keys WHERE key = ?'
  ).bind(idempotencyKey).first();

  if (existing) {
    if (requestHash && existing.request_hash && existing.request_hash !== requestHash) {
      return {
        status: 409,
        body: { error: 'Esta Idempotency-Key já foi usada com um payload diferente.' },
        replayed: false,
        conflict: true
      };
    }
    return {
      status: existing.response_status,
      body: JSON.parse(existing.response_body),
      replayed: true
    };
  }

  const result = await handlerFn();

  try {
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (key, installation_id, endpoint, response_status, response_body, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(idempotencyKey, installationId, endpoint, result.status, JSON.stringify(result.body), requestHash, nowIso()).run();
  } catch (err) {
    // Corrida rara (duas requisições simultâneas com a mesma chave): não é crítico,
    // a segunda apenas não terá cache de replay. O efeito colateral já é idempotente
    // no domínio de negócio (ex: concluir tarefa já concluída é no-op).
  }

  return result;
}
