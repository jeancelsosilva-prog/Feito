// Envio de Web Push criptografado (RFC 8291, content-encoding aes128gcm) + autenticação
// VAPID (RFC 8292), implementado inteiramente com Web Crypto API (sem dependências Node).
//
// Isso é necessário porque a maioria das libs npm de web-push (ex: 'web-push') dependem de
// Buffer e do módulo 'crypto' do Node, que não existem no runtime do Cloudflare Workers.

import { generateVapidJwt } from './vapid.js';

function b64urlToUint8Array(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(padLength);
  const raw = atob(padded);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function uint8ArrayToB64url(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

export class PushSendError extends Error {
  constructor(message, statusCode, isPermanent) {
    super(message);
    this.statusCode = statusCode;
    this.isPermanent = isPermanent; // true = assinatura morta (410/404), deve ser removida
  }
}

/**
 * Criptografa `payload` conforme RFC 8291 (aes128gcm) e devolve o corpo binário pronto
 * para ser enviado ao push service, junto com os headers necessários. Extraída como
 * função independente (sem fetch) para poder ser testada isoladamente — ver
 * tests/unit/webpush.test.js, que faz o round-trip completo (criptografa aqui,
 * descriptografa com uma implementação de referência baseada no Node 'crypto').
 *
 * subscription: { p256dh, auth } — como salvos em push_subscriptions.
 */
export async function encryptPushMessage({ subscription, payload }) {
  const { p256dh, auth } = subscription;

  const userPublicKeyBytes = b64urlToUint8Array(p256dh);
  const userAuthSecret = b64urlToUint8Array(auth);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  // 1. Par de chaves efêmero do servidor (ECDH P-256), um novo por mensagem.
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const serverPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // 2. Chave pública do navegador (subscription.keys.p256dh)
  const userPublicKey = await crypto.subtle.importKey(
    'raw', userPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // 3. Segredo ECDH compartilhado
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: userPublicKey }, serverKeyPair.privateKey, 256)
  );

  // 4. Salt aleatório de 16 bytes (único por mensagem)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 5. PRK = HKDF-Extract com o auth secret do navegador como salt, "info" ligando as duas chaves públicas
  const authInfo = concatBytes(
    new TextEncoder().encode('WebPush: info\0'),
    userPublicKeyBytes,
    serverPublicKeyBytes
  );
  const prk = await hkdf(userAuthSecret, sharedSecret, authInfo, 32);

  // 6. Content Encryption Key (16 bytes) e Nonce (12 bytes), derivados do PRK usando o salt da mensagem
  const cek = await hkdf(salt, prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // 7. Delimitador de registro único (0x02) — não há padding adicional além do mínimo exigido
  const paddedPlaintext = concatBytes(plaintext, new Uint8Array([2]));

  // 8. AES-128-GCM (a tag de 16 bytes vai automaticamente no fim do ciphertext retornado pelo Web Crypto)
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, paddedPlaintext)
  );

  // 9. Cabeçalho do formato aes128gcm (RFC 8188): salt(16) | record size(4, big-endian) | keyid_len(1) | keyid
  const recordSizeBytes = new Uint8Array(4);
  new DataView(recordSizeBytes.buffer).setUint32(0, ciphertext.length, false);

  const header = concatBytes(
    salt,
    recordSizeBytes,
    new Uint8Array([serverPublicKeyBytes.length]),
    serverPublicKeyBytes
  );

  const body = concatBytes(header, ciphertext);
  return { body };
}

/**
 * Criptografa e envia via fetch diretamente para o endpoint do push service do
 * navegador (ex: web.push.apple.com). subscription: { endpoint, p256dh, auth }.
 * vapidKeys: { publicKey (base64url raw), privateKeyJwk (objeto JWK) }.
 */
export async function sendWebPush({ subscription, payload, vapidKeys, vapidSubject, ttlSeconds = 1800 }) {
  const { endpoint } = subscription;
  const { body } = await encryptPushMessage({ subscription, payload });

  const audience = new URL(endpoint).origin;
  const jwt = await generateVapidJwt({ audience, subject: vapidSubject, privateKeyJwk: vapidKeys.privateKeyJwk });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': String(ttlSeconds),
      'Authorization': `vapid t=${jwt}, k=${vapidKeys.publicKey}`
    },
    body
  });

  if (response.status === 201 || response.status === 200 || response.status === 204) {
    return { ok: true, status: response.status };
  }

  // 404/410: assinatura não existe mais / expirou definitivamente no push service.
  const isPermanent = response.status === 404 || response.status === 410;
  const text = await response.text().catch(() => '');
  throw new PushSendError(`Push service respondeu ${response.status}: ${text.slice(0, 200)}`, response.status, isPermanent);
}

export { uint8ArrayToB64url, b64urlToUint8Array };
