import { HttpError, clientId, json, readBody, text } from '../http.js';
import { LIMITS, loadGroup } from './groups.js';
import { loadSpace } from './spaces.js';
import { notifyGroup } from './push.js';

const MAX_BATCH = 200;

async function loadItem(env, group, id) {
  const item = await env.DB.prepare('SELECT i.* FROM items i JOIN spaces s ON s.id = i.space_id WHERE i.id = ? AND s.group_id = ? AND i.deleted_at IS NULL')
    .bind(id, group.id)
    .first();
  if (!item) throw new HttpError(404, '項目が見つかりません（ほかの人が消したかもしれません）');
  return item;
}

export function register(router) {
  router.on('POST', '/g/:code/spaces/:id/items', async (c) => {
    const { group, user } = await loadGroup(c);
    const space = await loadSpace(c.env, group, c.params.id);
    const body = await readBody(c.request);
    const { n } = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE space_id = ?').bind(space.id).first();
    if (n >= LIMITS.itemsPerSpace) {
      throw new HttpError(400, `このスペースの項目は${LIMITS.itemsPerSpace}件までです。済みやゴミ箱の中を整理してください`);
    }
    const now = Date.now();
    const item = {
      id: clientId(body.id),
      space_id: space.id,
      text: text(body.text, { max: 200, required: true, label: '項目' }),
      note: text(body.note, { max: 1000, label: '補足' }),
      done: 0,
      done_at: null,
      // 名前の写しも残す。あとでグループを抜けた人の行でも「だれが」が分かるように
      created_by: user.display_name,
      created_by_user: user.id,
      created_at: now,
      updated_at: now,
    };
    // ON CONFLICT DO NOTHING: 同じ id が既にあれば上書きしない（よそのグループの行を書き換えられないように）。
    const inserted = await c.env.DB.prepare(
      `INSERT INTO items (id, space_id, text, note, done, done_at, created_by, created_by_user, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id`,
    )
      .bind(item.id, space.id, item.text, item.note, item.created_by, item.created_by_user, now, now)
      .first();
    // 通信の再送などで同じ id が2回来たときは、通知も1回だけにする
    if (inserted) {
      c.ctx.waitUntil(
        notifyGroup(c, group, user, {
          title: `${space.icon ? space.icon + ' ' : ''}${space.name}`,
          body: `${user.display_name || 'だれか'}が「${item.text}」を追加しました`,
          url: `/#/g/${group.code}/s/${space.id}`,
          tag: `space-${space.id}`,
        }),
      );
    }
    return json({ item }, 201);
  });

  // done は「反転」ではなく true/false をはっきり受け取る。
  // 2人がほぼ同時に押しても、押した人が見ていた向きにそろう。
  router.on('PATCH', '/g/:code/items/:id', async (c) => {
    const { group } = await loadGroup(c);
    const item = await loadItem(c.env, group, c.params.id);
    const body = await readBody(c.request);
    const next = { ...item, updated_at: Date.now() };
    if (body.text !== undefined) next.text = text(body.text, { max: 200, required: true, label: '項目' });
    if (body.note !== undefined) next.note = text(body.note, { max: 1000, label: '補足' });
    if (body.done !== undefined) {
      const done = body.done ? 1 : 0;
      if (done !== item.done) next.done_at = done ? Date.now() : null;
      next.done = done;
    }
    await c.env.DB.prepare('UPDATE items SET text = ?, note = ?, done = ?, done_at = ?, updated_at = ? WHERE id = ?')
      .bind(next.text, next.note, next.done, next.done_at, next.updated_at, item.id)
      .run();
    return json({ item: next });
  });

  // 削除はゴミ箱へ移すだけ（完全に消すのは trash.js）
  router.on('DELETE', '/g/:code/items/:id', async (c) => {
    const { group, user } = await loadGroup(c);
    const item = await loadItem(c.env, group, c.params.id);
    await c.env.DB.prepare('UPDATE items SET deleted_at = ?, deleted_by = ? WHERE id = ?').bind(Date.now(), user.id, item.id).run();
    return json({ ok: true });
  });

  // 「済みの項目を削除」（ゴミ箱へ）。条件（done=1）ではなく id で指定するのは、
  // 押した後にほかの人が済みにした項目まで巻き込まないため。
  router.on('POST', '/g/:code/spaces/:id/items/delete', async (c) => {
    const { group, user } = await loadGroup(c);
    const space = await loadSpace(c.env, group, c.params.id);
    const body = await readBody(c.request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, MAX_BATCH) : [];
    const now = Date.now();
    if (ids.length) {
      await c.env.DB.batch(ids.map((id) => c.env.DB.prepare('UPDATE items SET deleted_at = ?, deleted_by = ? WHERE id = ? AND space_id = ? AND deleted_at IS NULL').bind(now, user.id, id, space.id)));
    }
    return json({ ok: true, count: ids.length });
  });
}
