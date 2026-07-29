// Geração do JWT VAPID (RFC 8292) usando exclusivamente Web Crypto API,
// compatível com o runtime do Cloudflare Workers (sem 'jsonwebtoken', sem Node Buffer).

function base64urlEncodeBytes(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeString(str) {
  return base64urlEncodeBytes(new TextEncoder().encode(str));
}

/**
 * Gera um JWT assinado com ES256 (ECDSA P-256 + SHA-256), no formato exigido pelo VAPID.
 * privateKeyJwk deve ser a chave privada VAPID no formato JWK (gerada por
 * scripts/generate-vapid-keys.mjs e guardada como secret VAPID_PRIVATE_KEY_JWK).
 */
export async function generateVapidJwt({ audience, subject, privateKeyJwk, ttlSeconds = 12 * 60 * 60 }) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + ttlSeconds, sub: subject };

  const encodedHeader = base64urlEncodeString(JSON.stringify(header));
  const encodedPayload = base64urlEncodeString(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // O Web Crypto retorna a assinatura ECDSA já no formato "raw" (r || s, 64 bytes),
  // que é exatamente o formato exigido pela JWS (diferente do formato DER usado em outras libs).
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = base64urlEncodeBytes(new Uint8Array(signatureBuffer));
  return `${unsignedToken}.${encodedSignature}`;
}
