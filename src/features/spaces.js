import { HttpError, clientId, json, readBody, text } from '../http.js';
import { LIMITS, loadGroup, loadMembers, publicSpace } from './groups.js';

// いま画面が知っている種類。冷蔵庫などを足すときはここに増やす。
export const SPACE_KINDS = ['list'];

export async function loadSpace(env, group, spaceId) {
  const space = await env.DB.prepare('SELECT * FROM spaces WHERE id = ? AND group_id = ? AND deleted_at IS NULL').bind(spaceId, group.id).first();
  if (!space) throw new HttpError(404, 'スペースが見つかりません（消されたかもしれません）');
  return space;
}

export function register(router) {
  router.on('POST', '/g/:code/spaces', async (c) => {
    const { request, env, params } = c;
    const { group } = await loadGroup(c);
    const body = await readBody(request);
    const name = text(body.name, { max: 40, required: true, label: 'スペース名' });
    const icon = text(body.icon, { max: 8, label: 'アイコン' });
    const kind = SPACE_KINDS.includes(body.kind) ? body.kind : 'list';
    // ゴミ箱の中のものも数える（ゴミ箱経由で上限をすり抜けられないように）
    const { pos, n } = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos, COUNT(*) AS n FROM spaces WHERE group_id = ?')
      .bind(group.id)
      .first();
    if (n >= LIMITS.spacesPerGroup) throw new HttpError(400, `スペースは${LIMITS.spacesPerGroup}個までです（ゴミ箱の中も含みます）`);
    const space = await env.DB.prepare(
      `INSERT INTO spaces (id, group_id, name, icon, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING RETURNING *`,
    )
      .bind(clientId(body.id), group.id, name, icon, kind, pos, Date.now())
      .first();
    if (!space) throw new HttpError(409, '同じ id のスペースがすでにあります');
    return json({ space: publicSpace({ ...space, open_count: 0 }) }, 201);
  });

  // スペースを開いたときに、中身（リストとメモ）をまとめて返す。往復を1回で済ませるため。
  router.on('GET', '/g/:code/spaces/:id', async (c) => {
    const { env, params } = c;
    const { group } = await loadGroup(c);
    const space = await loadSpace(env, group, params.id);
    const [items, memos] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM items WHERE space_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(space.id),
      env.DB.prepare('SELECT * FROM memos WHERE space_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').bind(space.id),
    ]);
    return json({ space: publicSpace(space), items: items.results, memos: memos.results, members: await loadMembers(env, group.id) });
  });

  router.on('PATCH', '/g/:code/spaces/:id', async (c) => {
    const { request, env, params } = c;
    const { group } = await loadGroup(c);
    const space = await loadSpace(env, group, params.id);
    const body = await readBody(request);
    const name = body.name === undefined ? space.name : text(body.name, { max: 40, required: true, label: 'スペース名' });
    const icon = body.icon === undefined ? space.icon : text(body.icon, { max: 8, label: 'アイコン' });
    await env.DB.prepare('UPDATE spaces SET name = ?, icon = ? WHERE id = ?').bind(name, icon, space.id).run();
    return json({ space: publicSpace({ ...space, name, icon }) });
  });

  // スペースをゴミ箱へ。中のリストとメモはそのまま残し、スペースごと見えなくするだけ。
  router.on('DELETE', '/g/:code/spaces/:id', async (c) => {
    const { env, params } = c;
    const { group, user } = await loadGroup(c);
    const space = await loadSpace(env, group, params.id);
    await env.DB.prepare('UPDATE spaces SET deleted_at = ?, deleted_by = ? WHERE id = ?').bind(Date.now(), user.id, space.id).run();
    return json({ ok: true });
  });
}
