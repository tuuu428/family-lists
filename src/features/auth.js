import { HttpError, b64url, b64urlDecode, json, readBody, text } from '../http.js';

// 人ごとの色。リストの行の左端と名前の横の点に使う。
// 文字ではなく「印」なので、明るい背景・暗い背景のどちらにも 3:1 以上で見える中間の明るさに揃えた。
export const COLORS = ['#d64545', '#cc6619', '#2f9e58', '#14958f', '#3a78d8', '#7a5ad0', '#d0508a', '#9a6a3a'];

const SESSION_DAYS = 180; // 家族のスマホで毎回ログインさせたくないので長め

// https では __Host- を付ける。これが付いたクッキーは「このホストだけ・Secure 必須・Domain 指定不可」になり、
// 同じ *.<サブドメイン>.workers.dev の別アプリからログイン状態を上書き（すり替え）されなくなる。
// http://localhost の開発中は __Host- が使えない（Secure 必須のため）ので素の名前にする。
const isHttps = (request) => new URL(request.url).protocol === 'https:';
const cookieName = (request) => (isHttps(request) ? '__Host-sid' : 'sid');
const nonceCookieName = (request) => (isHttps(request) ? '__Host-gnonce' : 'gnonce');
const NONCE_SEC = 600;

function nonceCookie(request, value, maxAgeSec) {
  const secure = isHttps(request) ? '; Secure' : '';
  return `${nonceCookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export const publicUser = (u) => (u ? { id: u.id, name: u.display_name, color: u.color } : null);

async function sha256(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function sessionCookie(request, value, maxAgeSec) {
  const secure = isHttps(request) ? '; Secure' : '';
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

async function startSession(c, userId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  // 期限切れのログイン状態は、ログインのついでに片付ける（表が増え続けないように）
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256(token),
      userId,
      now,
      now + SESSION_DAYS * 86400e3,
    ),
  ]);
  return sessionCookie(c.request, token, SESSION_DAYS * 86400);
}

/** ログイン中の人を返す（いなければ null）。1リクエストの中では1回だけ引く。 */
export async function currentUser(c) {
  if (c.user !== undefined) return c.user;
  const token = readCookie(c.request, cookieName(c.request));
  c.user = token && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? await c.env.DB.prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
      )
        .bind(await sha256(token), Date.now())
        .first()
    : null;
  return c.user;
}

export async function requireUser(c) {
  const user = await currentUser(c);
  if (!user) throw new HttpError(401, 'ログインしてください', 'login_required');
  return user;
}

// ---------------------------------------------------------------------------
// Google の ID トークン（ログインボタンが返す署名付きの身分証）を確かめる。
// 公開鍵は Google が配っていて、数時間ごとに入れ替わるので、指示された時間だけ覚えておく。
let googleKeys = { keys: [], until: 0, fetchedAt: 0 };
async function fetchGoogleKeys(force) {
  // 知らない鍵番号のトークンを送りつけられるたびに取り直すと、Google への大量アクセスの踏み台にされる。
  // 強制の取り直しは1分に1回まで。
  if (force && Date.now() - googleKeys.fetchedAt < 60e3) return googleKeys.keys;
  if (!force && Date.now() < googleKeys.until) return googleKeys.keys;
  // 転送には付いていかない（Cloudflare では 'error' が使えないので 'manual' にして、200 以外は失敗扱い）
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { redirect: 'manual' });
  if (res.status !== 200) throw new HttpError(502, 'Google に接続できませんでした。少し待ってから試してください');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  googleKeys = { keys: (await res.json()).keys, until: Date.now() + maxAge * 1000, fetchedAt: Date.now() };
  return googleKeys.keys;
}

async function verifyGoogleIdToken(token, clientId, expectedNonce) {
  if (typeof token !== 'string' || token.length > 4096) throw new HttpError(401, 'ログイン情報が正しくありません');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'ログイン情報が正しくありません');
  const [h, p, s] = parts;
  const decode = (x) => JSON.parse(new TextDecoder().decode(b64urlDecode(x)));
  let header, payload, sig;
  try {
    header = decode(h);
    payload = decode(p);
    sig = b64urlDecode(s);
  } catch {
    throw new HttpError(401, 'ログイン情報が正しくありません');
  }
  if (!header || !payload || typeof header !== 'object' || typeof payload !== 'object') {
    throw new HttpError(401, 'ログイン情報が正しくありません');
  }
  let jwk = (await fetchGoogleKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await fetchGoogleKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') throw new HttpError(401, 'ログイン情報を確かめられませんでした');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${h}.${p}`));
  const validIssuer = payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com';
  const now = Date.now();
  const fresh = payload.exp * 1000 > now && (!payload.iat || payload.iat * 1000 < now + 5 * 60e3);
  // nonce: ログイン画面を開いたこの端末のクッキーと、トークンの中の値が一致すること。
  // 盗まれたトークンを別の端末で使い回す（リプレイ）を防ぐ。
  const nonceOk = typeof expectedNonce === 'string' && expectedNonce.length > 20 && payload.nonce === expectedNonce;
  if (!ok || !validIssuer || payload.aud !== clientId || !fresh || !nonceOk || typeof payload.sub !== 'string') {
    throw new HttpError(401, 'ログイン情報を確かめられませんでした');
  }
  return payload;
}

async function findOrCreateUser(env, sub) {
  const found = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first();
  if (found) return found;
  // 名前は最初のログイン後に本人に決めてもらう（「まま」など、家族の中での呼び名にしたいので Google の名前は使わない）
  const color = COLORS[crypto.getRandomValues(new Uint8Array(1))[0] % COLORS.length];
  return env.DB.prepare('INSERT INTO users (id, google_sub, display_name, color, created_at) VALUES (?, ?, NULL, ?, ?) RETURNING *')
    .bind(crypto.randomUUID(), sub, color, Date.now())
    .first();
}

export async function myGroups(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT g.code, g.name FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY m.joined_at',
  )
    .bind(userId)
    .all();
  return results;
}

export function register(router) {
  // 画面が最初に読む設定。どれも公開してよい値だけ（秘密鍵は返さない）。
  router.on('GET', '/config', async ({ env }) =>
    json({
      googleClientId: env.GOOGLE_CLIENT_ID || null,
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
      devLogin: env.DEV_LOGIN === '1',
      colors: COLORS,
    }),
  );

  router.on('GET', '/me', async (c) => {
    const user = await currentUser(c);
    return json({ user: publicUser(user), groups: user ? await myGroups(c.env, user.id) : [] });
  });

  router.on('PATCH', '/me', async (c) => {
    const user = await requireUser(c);
    const body = await readBody(c.request);
    const name = body.name === undefined ? user.display_name : text(body.name, { max: 20, required: true, label: '名前' });
    const color = body.color === undefined ? user.color : COLORS.includes(body.color) ? body.color : user.color;
    await c.env.DB.prepare('UPDATE users SET display_name = ?, color = ? WHERE id = ?').bind(name, color, user.id).run();
    return json({ user: publicUser({ ...user, display_name: name, color }) });
  });

  // ログインボタンを出す前に、この端末だけの使い捨ての合言葉（nonce）を発行する。
  // 同じ値をクッキーにも入れておき、Google から戻ってきたトークンの中身と突き合わせる。
  router.on('POST', '/auth/nonce', async (c) => {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
    return json({ nonce }, 200, { 'set-cookie': nonceCookie(c.request, nonce, NONCE_SEC) });
  });

  router.on('POST', '/auth/google', async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID) throw new HttpError(500, 'GOOGLE_CLIENT_ID が設定されていません（README 参照）');
    const body = await readBody(c.request);
    const expected = readCookie(c.request, nonceCookieName(c.request));
    const payload = await verifyGoogleIdToken(body.credential, c.env.GOOGLE_CLIENT_ID, expected);
    const user = await findOrCreateUser(c.env, `google:${payload.sub}`);
    const res = json({ user: publicUser(user) }, 200, { 'set-cookie': await startSession(c, user.id) });
    res.headers.append('set-cookie', nonceCookie(c.request, '', 0)); // 合言葉は使い捨て
    return res;
  });

  // 手元で何人分も試すための仮ログイン。.dev.vars に DEV_LOGIN=1 があるときだけ動く。
  // .dev.vars は公開時に送られないので、本番では必ず無効になる。
  router.on('POST', '/auth/dev', async (c) => {
    if (c.env.DEV_LOGIN !== '1') throw new HttpError(404, '見つかりません');
    const body = await readBody(c.request);
    const name = text(body.name, { max: 20, required: true, label: '名前' });
    const user = await findOrCreateUser(c.env, `dev:${name}`);
    return json({ user: publicUser(user) }, 200, { 'set-cookie': await startSession(c, user.id) });
  });

  router.on('POST', '/auth/logout', async (c) => {
    const token = readCookie(c.request, cookieName(c.request));
    if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(c.request, '', 0) });
  });
}
