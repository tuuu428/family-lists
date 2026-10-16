// API 共通の小物。フレームワークを入れずに済む程度の量なので自前で持つ。

export class HttpError extends Error {
  /** code は画面側が分岐に使う短い印（例: 'not_member' ならグループに参加させてから読み直す）。 */
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// API の応答に必ず付けるヘッダー。中身を別の種類として解釈させない・よそのページに埋め込ませない。
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// いちばん大きいのはメモ5000字。余裕を見ても 64KB を超える送信は正規の画面からは起きない。
const MAX_BODY_BYTES = 64 * 1024;

export async function readBody(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new HttpError(413, '送る内容が大きすぎます');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, '送られた内容を読めませんでした');
  }
}

/** 文字列を整えて長さを確かめる。required でなければ空は null にする。 */
export function text(value, { max, required = false, label = '内容' }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new HttpError(400, `${label}を入力してください`);
    return null;
  }
  if (s.length > max) throw new HttpError(400, `${label}は${max}文字までです`);
  return s;
}

// 端末が作った id を受け入れる。形を絞るのは、変な文字列を主キーに入れさせないため。
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const clientId = (value) => (typeof value === 'string' && ID_RE.test(value) ? value : crypto.randomUUID());

export const int = (value, fallback) => (Number.isFinite(value) ? Math.trunc(value) : fallback);

/** '/g/:code/items/:id' のような書き方で道を足せる最小のルーター。 */
export class Router {
  routes = [];
  on(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  async handle(request, env, ctx, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        throw new HttpError(400, 'アドレスが正しくありません'); // 壊れた %xx で 500 にしない
      }
      return r.handler({ request, env, ctx, params });
    }
    throw new HttpError(pathMatched ? 405 : 404, '見つかりません');
  }
}
