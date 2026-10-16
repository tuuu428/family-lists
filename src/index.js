import { HttpError, Router, json } from './http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 書き込み（POST/PATCH/DELETE）は、このサイト自身の画面から来たものだけを通す。
 * *.<サブドメイン>.workers.dev の別のアプリは「同じサイト」扱いになり SameSite クッキーでは防げないので、
 * ブラウザが必ず付ける Origin ヘッダーで送り元を確かめる。
 */
function checkOrigin(request, url) {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.get('origin');
  if (origin !== url.origin) throw new HttpError(403, 'このサイトの画面以外からの操作は受け付けません');
  const type = request.headers.get('content-type') || '';
  if (request.method !== 'DELETE' && !type.startsWith('application/json')) throw new HttpError(415, '送る形式が正しくありません');
}
import * as auth from './features/auth.js';
import * as push from './features/push.js';
import * as groups from './features/groups.js';
import * as spaces from './features/spaces.js';
import * as items from './features/items.js';
import * as memos from './features/memos.js';
import * as trash from './features/trash.js';

// 機能ごとにファイルを分け、ここで登録するだけにしてある。
// 冷蔵庫の在庫などを足すときは features/ に1ファイル足して、この配列に加える。
const router = new Router();
for (const feature of [auth, push, groups, spaces, items, memos, trash]) feature.register(router);

/**
 * 回数制限。ログインまわりは特に厳しく（Google のトークンを総当たりで試されないように）。
 * Cloudflare の場所ごとのおおよその数え方なので、厳密な上限ではなく「機械的な連打を止める」ためのもの。
 */
async function checkRate(request, env, url) {
  if (!env.RL_AUTH) return; // 古い設定で動かしたときも落ちないように
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const limiter = url.pathname.startsWith('/api/auth/') ? env.RL_AUTH : SAFE_METHODS.has(request.method) ? env.RL_READ : env.RL_WRITE;
  const { success } = await limiter.limit({ key: ip });
  if (!success) throw new HttpError(429, '操作が多すぎます。1分ほど待ってからもう一度試してください');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // 本番は https だけ。（.dev のアドレスはブラウザが必ず https にするが、それ以外の道具からの http も断る）
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || /^192\.168\./.test(url.hostname);
    if (url.protocol !== 'https:' && !local) return json({ error: 'https で開いてください' }, 403);
    try {
      await checkRate(request, env, url);
      checkOrigin(request, url);
      return await router.handle(request, env, ctx, url.pathname.slice('/api'.length));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
      console.error(err);
      return json({ error: 'サーバーで問題が起きました。少し待ってからもう一度試してください' }, 500);
    }
  },
};
