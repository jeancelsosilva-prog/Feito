// Gera um par de chaves VAPID (ECDSA P-256) usando o Web Crypto do próprio Node.js
// (Node 19+ expõe `globalThis.crypto` compatível com o navegador — não precisa de libs externas).
//
// Uso:
//   cd backend/worker
//   node scripts/generate-vapid-keys.mjs
//
// A saída traz:
//  - VAPID_PUBLIC_KEY: vai em wrangler.toml [vars] (não é segredo, é enviado ao navegador)
//  - VAPID_PRIVATE_KEY_JWK: vai como secret (`wrangler secret put VAPID_PRIVATE_KEY_JWK`)

function base64urlFromBytes(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return Buffer.from(str, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  const publicKeyB64url = base64urlFromBytes(publicKeyRaw);

  console.log('\n===== Chaves VAPID geradas com sucesso =====\n');
  console.log('1) Chave pública (cole em backend/worker/wrangler.toml, dentro de [vars] VAPID_PUBLIC_KEY):\n');
  console.log(publicKeyB64url);
  console.log('\n2) Chave privada em formato JWK (NÃO cole em nenhum arquivo do repositório).');
  console.log('   Cadastre como secret executando o comando abaixo dentro de backend/worker,');
  console.log('   e cole o JSON de uma linha só quando o terminal pedir o valor:\n');
  console.log('   npx wrangler secret put VAPID_PRIVATE_KEY_JWK\n');
  console.log(JSON.stringify(privateKeyJwk));
  console.log('\n=============================================\n');
}

main().catch((err) => {
  console.error('Falha ao gerar as chaves VAPID:', err);
  process.exit(1);
});
