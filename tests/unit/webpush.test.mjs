// Teste de round-trip do RFC 8291 (aes128gcm): criptografa com nosso encryptPushMessage()
// (o mesmo código usado em produção pelo Worker) e descriptografa com uma implementação de
// referência independente escrita usando o módulo 'crypto' do Node (não Web Crypto), para
// reduzir a chance de um bug em comum entre as duas implementações passar despercebido.
//
// Rodar com: node tests/unit/webpush.test.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPushMessage } from '../../backend/worker/src/lib/webpush.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function referenceDecrypt({ body: rawBody, subscriberPrivateKey, authSecret }) {
  const body = Buffer.from(rawBody);
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLen = body.readUInt8(20);
  const keyId = body.subarray(21, 21 + idLen); // chave pública efêmera do "servidor"
  const ciphertext = body.subarray(21 + idLen);

  // ECDH: deriva o segredo compartilhado usando a chave privada do "navegador" (subscriber)
  // e a chave pública efêmera que veio no cabeçalho da mensagem.
  const subscriberEcdh = crypto.createECDH('prime256v1');
  subscriberEcdh.setPrivateKey(subscriberPrivateKey);
  const sharedSecret = subscriberEcdh.computeSecret(keyId);

  const subscriberPublicKey = subscriberEcdh.getPublicKey();

  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    subscriberPublicKey,
    keyId
  ]);

  const prk = hkdf(authSecret, sharedSecret, authInfo, 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  // remove o delimitador de padding (0x02) do fim
  const withoutPadding = decrypted.subarray(0, decrypted.length - 1);
  return withoutPadding.toString('utf8');
}

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const t1 = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t1.subarray(0, length);
}

async function run() {
  // Gera um par de chaves "do navegador" (subscriber) usando Node crypto.
  const subscriberEcdh = crypto.createECDH('prime256v1');
  subscriberEcdh.generateKeys();
  const p256dh = b64url(subscriberEcdh.getPublicKey());
  const authSecretBytes = crypto.randomBytes(16);
  const auth = b64url(authSecretBytes);

  const payload = { title: 'Feito?', body: 'Teste de round-trip RFC 8291.', taskId: 'abc-123' };

  const { body } = await encryptPushMessage({
    subscription: { p256dh, auth },
    payload
  });

  const decryptedJson = await referenceDecrypt({
    body,
    subscriberPrivateKey: subscriberEcdh.getPrivateKey(),
    authSecret: authSecretBytes
  });

  const decrypted = JSON.parse(decryptedJson);
  assert.deepEqual(decrypted, payload);
  console.log('OK: webpush round-trip (RFC 8291 aes128gcm) — payload descriptografado corretamente.');
}

run().catch((err) => {
  console.error('FALHOU: webpush round-trip test');
  console.error(err);
  process.exit(1);
});
