// Valida que o JWT gerado por generateVapidJwt() (ES256, Web Crypto) é aceito por uma
// verificação independente feita com o módulo 'crypto' do Node.
//
// Rodar com: node tests/unit/vapid.test.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateVapidJwt } from '../../backend/worker/src/lib/vapid.js';

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function run() {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const privateKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey);

  const jwt = await generateVapidJwt({
    audience: 'https://web.push.apple.com',
    subject: 'mailto:teste@example.com',
    privateKeyJwk
  });

  const [headerB64, payloadB64, sigB64] = jwt.split('.');
  const signature = b64urlDecode(sigB64); // raw r||s, 64 bytes (formato IEEE P1363)

  const publicKeyObj = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  const signedData = `${headerB64}.${payloadB64}`;
  const isValid = crypto.verify(
    'sha256',
    Buffer.from(signedData),
    { key: publicKeyObj, dsaEncoding: 'ieee-p1363' },
    signature
  );

  assert.equal(isValid, true, 'assinatura ES256 deveria ser válida');

  const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  assert.equal(payload.aud, 'https://web.push.apple.com');
  assert.equal(payload.sub, 'mailto:teste@example.com');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));

  console.log('OK: JWT VAPID (ES256) gerado corretamente e validado por implementação independente.');
}

run().catch((err) => {
  console.error('FALHOU: vapid jwt test');
  console.error(err);
  process.exit(1);
});
