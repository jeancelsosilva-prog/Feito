// Autenticação simples baseada em token por instalação (sem contas de usuário).
//
// Fluxo:
// 1. Cliente chama POST /api/installations sem token -> backend gera installationId + token
//    secreto, devolve os dois UMA VEZ, e guarda apenas o hash do token no D1.
// 2. Requisições seguintes enviam:
//      X-Installation-Id: <id>
//      Authorization: Bearer <token>
// 3. Backend recalcula o hash do token recebido e compara com o hash salvo.
//
// Isso impede que um cliente forje/assuma o installationId de outra pessoa sem
// conhecer o token secreto correspondente.

import { sha256Hex } from './hash.js';

export function generateInstallationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token) {
  return sha256Hex(token);
}

/**
 * Extrai e valida a instalação autenticada da requisição.
 * Retorna { installationId } em caso de sucesso, ou lança um objeto { status, message }.
 */
export async function requireInstallation(request, env) {
  const installationId = request.headers.get('X-Installation-Id');
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!installationId || !token) {
    throw { status: 401, message: 'Cabeçalhos de autenticação ausentes.' };
  }

  const row = await env.DB.prepare(
    'SELECT id, token_hash FROM installations WHERE id = ?'
  ).bind(installationId).first();

  if (!row) {
    throw { status: 401, message: 'Instalação não encontrada.' };
  }

  const incomingHash = await hashToken(token);
  if (incomingHash !== row.token_hash) {
    throw { status: 401, message: 'Token inválido.' };
  }

  return { installationId };
}

/** Timing-safe-ish compare para strings de mesmo tamanho esperado (hashes hex). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
