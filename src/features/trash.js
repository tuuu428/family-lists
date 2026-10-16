import { HttpError, json, readBody } from '../http.js';
import { loadGroup, loadMembers } from './groups.js';

// ゴミ箱。削除されたスペース・項目・メモを並べ、選んで「元に戻す」か「完全に削除」する。
// グループ単位で1つ（家族のだれが消したものも、だれでも戻せる）。

const KEEP_DAYS = 30; // これより古いものは、ゴミ箱を開いたときに完全に削除する
const MAX_IDS = 500;

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_IDS) : []);
const GROUP_SPACES = 'SELECT id FROM spaces WHERE group_id = ?';

async function purgeOld(env, groupId) {
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  const oldSpaces = `SELECT id FROM spaces WHERE group_id = ? AND deleted_at < ?`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE deleted_at < ? AND space_id IN (${GROUP_SPACES})`).bind(cutoff, groupId),
    env.DB.prepare(`DELETE FROM memos WHERE deleted_at < ? AND space_id IN (${GROUP_SPACES})`).bind(cutoff, groupId),
    env.DB.prepare(`DELETE FROM items WHERE space_id IN (${oldSpaces})`).bind(groupId, cutoff),
    env.DB.prepare(`DELETE FROM memos WHERE space_id IN (${oldSpaces})`).bind(groupId, cutoff),
    env.DB.prepare('DELETE FROM spaces WHERE group_id = ? AND deleted_at < ?').bind(groupId, cutoff),
  ]);
}

export function register(router) {
  router.on('GET', '/g/:code/trash', async (c) => {
    const { group } = await loadGroup(c);
    const { env } = c;
    await purgeOld(env, group.id);
    // 項目とメモは「スペースが生きているもの」だけを出す。スペースごと消えたものは、スペースの行にまとめて見せる
    const [spaces, items, memos] = await env.DB.batch([
      env.DB.prepare(
        `SELECT s.id, s.name, s.icon, s.deleted_at, s.deleted_by,
           (SELECT COUNT(*) FROM items i WHERE i.space_id = s.id AND i.deleted_at IS NULL) AS item_count,
           (SELECT COUNT(*) FROM memos m WHERE m.space_id = s.id AND m.deleted_at IS NULL) AS memo_count
         FROM spaces s WHERE s.group_id = ? AND s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`,
      ).bind(group.id),
      env.DB.prepare(
        `SELECT i.id, i.text, i.note, i.done, i.created_by, i.created_by_user, i.deleted_at, i.deleted_by, s.name AS space_name, s.icon AS space_icon
         FROM items i JOIN spaces s ON s.id = i.space_id
         WHERE s.group_id = ? AND s.deleted_at IS NULL AND i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC`,
      ).bind(group.id),
      env.DB.prepare(
        `SELECT m.id, m.body, m.created_by, m.created_by_user, m.deleted_at, m.deleted_by, s.name AS space_name, s.icon AS space_icon
         FROM memos m JOIN spaces s ON s.id = m.space_id
         WHERE s.group_id = ? AND s.deleted_at IS NULL AND m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC`,
      ).bind(group.id),
    ]);
    return json({
      keepDays: KEEP_DAYS,
      spaces: spaces.results,
      items: items.results,
      memos: memos.results,
      members: await loadMembers(env, group.id),
    });
  });

  router.on('POST', '/g/:code/trash/restore', async (c) => {
    const { group } = await loadGroup(c);
    const body = await readBody(c.request);
    const { env } = c;
    const stmts = [
      ...ids(body.spaces).map((id) =>
        env.DB.prepare('UPDATE spaces SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND group_id = ?').bind(id, group.id),
      ),
      ...ids(body.items).map((id) =>
        env.DB.prepare(`UPDATE items SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND space_id IN (${GROUP_SPACES})`).bind(id, group.id),
      ),
      ...ids(body.memos).map((id) =>
        env.DB.prepare(`UPDATE memos SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND space_id IN (${GROUP_SPACES})`).bind(id, group.id),
      ),
    ];
    if (!stmts.length) throw new HttpError(400, '元に戻すものを選んでください');
    await env.DB.batch(stmts);
    return json({ ok: true, count: stmts.length });
  });

  // 完全に削除。ゴミ箱に入っているもの（deleted_at があるもの）しか消さない。
  // 画面から直接ここを呼ばれても、使っている最中の行が消えることはない。
  router.on('POST', '/g/:code/trash/purge', async (c) => {
    const { group } = await loadGroup(c);
    const body = await readBody(c.request);
    const { env } = c;
    const trashedSpace = 'SELECT id FROM spaces WHERE id = ? AND group_id = ? AND deleted_at IS NOT NULL';
    const stmts = [
      ...ids(body.spaces).flatMap((id) => [
        env.DB.prepare(`DELETE FROM items WHERE space_id IN (${trashedSpace})`).bind(id, group.id),
        env.DB.prepare(`DELETE FROM memos WHERE space_id IN (${trashedSpace})`).bind(id, group.id),
        env.DB.prepare('DELETE FROM spaces WHERE id = ? AND group_id = ? AND deleted_at IS NOT NULL').bind(id, group.id),
      ]),
      ...ids(body.items).map((id) =>
        env.DB.prepare(`DELETE FROM items WHERE id = ? AND deleted_at IS NOT NULL AND space_id IN (${GROUP_SPACES})`).bind(id, group.id),
      ),
      ...ids(body.memos).map((id) =>
        env.DB.prepare(`DELETE FROM memos WHERE id = ? AND deleted_at IS NOT NULL AND space_id IN (${GROUP_SPACES})`).bind(id, group.id),
      ),
    ];
    if (!stmts.length) throw new HttpError(400, '削除するものを選んでください');
    await env.DB.batch(stmts);
    return json({ ok: true });
  });
}
