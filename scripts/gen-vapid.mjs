// 通知（Web Push）用の鍵を1組作る。公開鍵は wrangler.jsonc の vars に、秘密鍵は secret に入れる。
// 使い方: node scripts/gen-vapid.mjs
const { subtle } = globalThis.crypto;
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
const pub = Buffer.from(raw).toString('base64url');
const jwk = await subtle.exportKey('jwk', kp.privateKey);
console.log(`VAPID_PUBLIC_KEY=${pub}`);
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify(jwk)}`);
