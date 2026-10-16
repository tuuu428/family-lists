import { HttpError, clientId, json, readBody, text } from '../http.js';
import { LIMITS, loadGroup } from './groups.js';
import { loadSpace } from './spaces.js';
import { notifyGroup } from './push.js';

async function loadMemo(env, group, id) {
  const memo = await env.DB.prepare('SELECT m.* FROM memos m JOIN spaces s ON s.id = m.space_id WHERE m.id = ? AND s.group_id = ? AND m.deleted_at IS NULL')
    .bind(id, group.id)
    .first();
  if (!memo) throw new HttpError(404, 'メモが見つかりません（ほかの人が消したかもしれません）');
  return memo;
}

export function register(router) {
  router.on('POST', '/g/:code/spaces/:id/memos', async (c) => {
    const { group, user } = await loadGroup(c);
    const space = await loadSpace(c.env, group, c.params.id);
    const body = await readBody(c.request);
    const { n } = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM memos WHERE space_id = ?').bind(space.id).first();
    if (n >= LIMITS.memosPerSpace) throw new HttpError(400, `このスペースのメモは${LIMITS.memosPerSpace}件までです（ゴミ箱の中も含みます）`);
    const now = Date.now();
    const memo = {
      id: clientId(body.id),
      space_id: space.id,
      body: text(body.body, { max: 5000, required: true, label: 'メモ' }),
      created_by: user.display_name,
      created_by_user: user.id,
      created_at: now,
      updated_at: now,
    };
    const inserted = await c.env.DB.prepare(
      `INSERT INTO memos (id, space_id, body, created_by, created_by_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
    )
      .bind(memo.id, memo.space_id, memo.body, memo.created_by, memo.created_by_user, now, now)
      .first();
    if (inserted) {
      const preview = memo.body.length > 60 ? `${memo.body.slice(0, 60)}…` : memo.body;
      c.ctx.waitUntil(
        notifyGroup(c, group, user, {
          title: `${space.icon ? space.icon + ' ' : ''}${space.name}（メモ）`,
          body: `${user.display_name || 'だれか'}: ${preview}`,
          url: `/#/g/${group.code}/s/${space.id}`,
          tag: `space-${space.id}`,
        }),
      );
    }
    return json({ memo }, 201);
  });

  router.on('PATCH', '/g/:code/memos/:id', async (c) => {
    const { group } = await loadGroup(c);
    const memo = await loadMemo(c.env, group, c.params.id);
    const body = await readBody(c.request);
    const next = { ...memo, body: text(body.body, { max: 5000, required: true, label: 'メモ' }), updated_at: Date.now() };
    await c.env.DB.prepare('UPDATE memos SET body = ?, updated_at = ? WHERE id = ?').bind(next.body, next.updated_at, memo.id).run();
    return json({ memo: next });
  });

  // 削除はゴミ箱へ移すだけ（完全に消すのは trash.js）
  router.on('DELETE', '/g/:code/memos/:id', async (c) => {
    const { group, user } = await loadGroup(c);
    const memo = await loadMemo(c.env, group, c.params.id);
    await c.env.DB.prepare('UPDATE memos SET deleted_at = ?, deleted_by = ? WHERE id = ?').bind(Date.now(), user.id, memo.id).run();
    return json({ ok: true });
  });
}
