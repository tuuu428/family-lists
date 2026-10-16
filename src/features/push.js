import { HttpError, b64url, b64urlDecode, json, readBody } from '../http.js';
import { requireUser } from './auth.js';

// Web Push（ブラウザの通知）を外部ライブラリなしで送る。
// 中身の暗号化は RFC 8291（aes128gcm）、送り主の証明は RFC 8292（VAPID）。
// ライブラリを使わないのは、Node 向けのものが Workers で動かないことが多く、WebCrypto だけで書ける量だから。

const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** 端末の公開鍵で payload を暗号化し、送れる形（ヘッダー＋暗号文）にする。 */
export async function encryptPayload(sub, payload) {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(JSON.stringify(payload)), [2]); // 2 = 最後のレコードの印
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, [asPublic.length], asPublic, cipher);
}

async function vapidAuth(env, endpoint, subject) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendOne(env, sub, payload, subject) {
  if (!validEndpoint(sub.endpoint)) return;
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    redirect: 'manual', // 送り先が別の場所へ転送しようとしても付いていかない（踏み台対策）
    headers: {
      authorization: await vapidAuth(env, sub.endpoint, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(24 * 3600), // 電源が切れていても1日以内なら届ける
      urgency: 'normal',
      topic: payload.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '_'), // 同じスペースの未配達分は最新の1件にまとめる
    },
    body: await encryptPayload(sub, payload),
  });
  // 404/410 は「その端末はもう受け取らない」（アプリを消した、通知を切った等）。台帳から外す。
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
  } else if (!res.ok) {
    console.warn('push failed', res.status, await res.text().catch(() => ''));
  }
}

/**
 * グループのメンバー（操作した本人を除く）の全端末に通知する。
 * 応答を待たせないよう、呼び出し側は ctx.waitUntil に渡す。
 */
export async function notifyGroup(c, group, actor, payload) {
  const { env, request } = c;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return;
  const { results } = await env.DB.prepare(
    `SELECT p.* FROM push_subscriptions p JOIN group_members m ON m.user_id = p.user_id
     WHERE m.group_id = ? AND p.user_id != ?`,
  )
    .bind(group.id, actor.id)
    .all();
  const subject = env.VAPID_SUBJECT || new URL(request.url).origin;
  await Promise.allSettled(results.map((sub) => sendOne(env, sub, payload, subject)));
}

// 通知の送り先として受け付けるのは、ブラウザ各社の正規の通知サービスだけ。
// 好きな URL を登録できると、このサーバーが家族の操作のたびにその URL へ送信する「踏み台」にされるため。
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome / Android / Edge の一部
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari / iPhone
  /(^|\.)notify\.windows\.com$/, // Edge (Windows)
];
const MAX_DEVICES_PER_USER = 10;

function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && !u.username && PUSH_HOSTS.some((re) => re.test(u.hostname)) && endpoint.length <= 1024;
  } catch {
    return false;
  }
}

export function register(router) {
  // この端末で通知を受け取る。端末ごとの設定なので、同じ人の別の端末には影響しない。
  router.on('POST', '/push/subscriptions', async (c) => {
    const user = await requireUser(c);
    const body = await readBody(c.request);
    const { endpoint, keys } = body;
    const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
    if (
      typeof endpoint !== 'string' ||
      !validEndpoint(endpoint) ||
      typeof keys?.p256dh !== 'string' ||
      typeof keys?.auth !== 'string' ||
      !b64.test(keys.p256dh) ||
      !b64.test(keys.auth) ||
      keys.p256dh.length > 128 ||
      keys.auth.length > 64
    ) {
      throw new HttpError(400, '通知の登録内容が正しくありません');
    }
    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
    )
      .bind(endpoint, user.id, keys.p256dh, keys.auth, Date.now())
      .run();
    // 1人の端末は新しい順に10台まで。古いものから外す
    await c.env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
         (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
    )
      .bind(user.id, user.id, MAX_DEVICES_PER_USER)
      .run();
    return json({ ok: true }, 201);
  });

  router.on('POST', '/push/subscriptions/delete', async (c) => {
    const user = await requireUser(c);
    const { endpoint } = await readBody(c.request);
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(endpoint), user.id).run();
    return json({ ok: true });
  });

  // 設定画面の「試しに通知する」。自分の端末にだけ送る。
  router.on('POST', '/push/test', async (c) => {
    const user = await requireUser(c);
    if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_JWK) throw new HttpError(500, '通知の鍵が設定されていません（README 参照）');
    const { results } = await c.env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').bind(user.id).all();
    const subject = c.env.VAPID_SUBJECT || new URL(c.request.url).origin;
    await Promise.allSettled(
      results.map((sub) => sendOne(c.env, sub, { title: '家族リスト', body: '通知はこのように届きます', url: '/', tag: 'test' }, subject)),
    );
    return json({ ok: true, count: results.length });
  });
}
