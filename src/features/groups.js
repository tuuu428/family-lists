import { HttpError, json, readBody, text } from '../http.js';
import { myGroups, publicUser, requireUser } from './auth.js';
import { notifyGroup } from './push.js';

// 読み間違えやすい i l o 0 1 を抜いた 31 文字 × 10 桁（約 49 ビット）。
// 今はログインした人しか参加できないので、コードは「招待状」の役目。口頭でも伝えられる短さにしてある。
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LEN = 10;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN * 2));
  let code = '';
  // 248 以上を捨てて偏りを無くす（256 は 31 で割り切れないため）。
  for (const b of bytes) {
    if (b < 248) code += ALPHABET[b % 31];
    if (code.length === CODE_LEN) return code;
  }
  return newCode();
}

export const normalizeCode = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function findGroup(env, code) {
  const group = await env.DB.prepare('SELECT * FROM groups WHERE code = ?').bind(normalizeCode(code)).first();
  if (!group) throw new HttpError(404, 'グループが見つかりません。コードを確かめてください');
  return group;
}

/**
 * ログインしていて、かつそのグループのメンバーであることを確かめる。グループ内のAPIはすべてここを通る。
 * メンバーでなければ 403 'not_member' を返し、画面側が「参加する」を挟んでから読み直す。
 */
export async function loadGroup(c) {
  const user = await requireUser(c);
  const group = await findGroup(c.env, c.params.code);
  const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, user.id).first();
  if (!member) throw new HttpError(403, 'このグループにはまだ参加していません', 'not_member');
  return { group, user };
}

export async function loadMembers(env, groupId) {
  const { results } = await env.DB.prepare(
    'SELECT u.* FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined_at',
  )
    .bind(groupId)
    .all();
  return results.map(publicUser);
}

// 上限。家族で使うには十分に大きく、だれかに DB を埋め尽くされない程度に小さく。
export const LIMITS = { groupsPerUser: 30, membersPerGroup: 30, spacesPerGroup: 100, itemsPerSpace: 500, memosPerSpace: 500 };

async function countMyGroups(env, userId) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?').bind(userId).first();
  return n;
}

// 作ってすぐ使えるように最初から置いておく箱。
const STARTER_SPACES = [
  { name: '買い物', icon: '🛒' },
  { name: 'やること', icon: '🔧' },
];

export function register(router) {
  router.on('POST', '/groups', async (c) => {
    const user = await requireUser(c);
    const body = await readBody(c.request);
    const name = text(body.name, { max: 40, required: true, label: 'グループ名' });
    if ((await countMyGroups(c.env, user.id)) >= LIMITS.groupsPerUser) {
      throw new HttpError(400, `入れるグループは${LIMITS.groupsPerUser}個までです`);
    }
    const now = Date.now();
    const group = await c.env.DB.prepare('INSERT INTO groups (code, name, created_at, owner_id) VALUES (?, ?, ?, ?) RETURNING *')
      .bind(newCode(), name, now, user.id)
      .first();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').bind(group.id, user.id, now),
      ...STARTER_SPACES.map((s, i) =>
        c.env.DB.prepare('INSERT INTO spaces (id, group_id, name, icon, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), group.id, s.name, s.icon, 'list', i, now),
      ),
    ]);
    return json({ group: publicGroup(group) }, 201);
  });

  // 招待リンクを開いた人に「どのグループに入ろうとしているか」を見せるための情報。
  // 勝手に参加させず、本人が名前を見て「参加する」を押してから join する。
  router.on('GET', '/g/:code/invite', async (c) => {
    await requireUser(c);
    const group = await findGroup(c.env, c.params.code);
    const { n } = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').bind(group.id).first();
    return json({ group: { name: group.name }, memberCount: n });
  });

  // 招待コード（リンク）を開いた人を加える。何度呼ばれても同じ結果になる。
  router.on('POST', '/g/:code/join', async (c) => {
    const user = await requireUser(c);
    const group = await findGroup(c.env, c.params.code);
    const already = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, user.id).first();
    if (already) return json({ group: publicGroup(group) });
    const { n } = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').bind(group.id).first();
    if (n >= LIMITS.membersPerGroup) throw new HttpError(400, `このグループは${LIMITS.membersPerGroup}人までです`);
    if ((await countMyGroups(c.env, user.id)) >= LIMITS.groupsPerUser) {
      throw new HttpError(400, `入れるグループは${LIMITS.groupsPerUser}個までです`);
    }
    // 持ち主のいない（全員が抜けた）グループに入った人は、そのまま持ち主になる
    if (!group.owner_id) await c.env.DB.prepare('UPDATE groups SET owner_id = ? WHERE id = ? AND owner_id IS NULL').bind(user.id, group.id).run();
    await c.env.DB.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(group.id, user.id, Date.now())
      .run();
    // 新しく入った人がいたら、家族全員に知らせる。リンクが漏れて知らない人が入ったときに、すぐ気づけるように。
    c.ctx.waitUntil(
      notifyGroup(c, group, user, {
        title: `👤 ${group.name}`,
        body: `「${user.display_name || '名前未設定'}」がグループに参加しました。知らない人なら「共有・メンバー」から外してください`,
        url: `/#/g/${group.code}`,
        tag: `members-${group.code}`,
      }),
    );
    return json({ group: publicGroup(group) });
  });

  router.on('POST', '/g/:code/leave', async (c) => {
    const { group, user } = await loadGroup(c);
    const env = c.env;
    await env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, user.id).run();
    const next = await env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1').bind(group.id).first();
    if (!next) {
      // 最後の1人が抜けたら、招待コードを作り直して閉じる。
      // 古いリンクが残っていても、もうだれもこのグループのデータを見られない。
      await env.DB.prepare('UPDATE groups SET code = ?, owner_id = NULL WHERE id = ?').bind(newCode(), group.id).run();
    } else if (group.owner_id === user.id) {
      // 持ち主が抜けたら、次に古くからいる人が引き継ぐ
      await env.DB.prepare('UPDATE groups SET owner_id = ? WHERE id = ?').bind(next.user_id, group.id).run();
    }
    return json({ groups: await myGroups(env, user.id) });
  });

  // 招待コードの作り直し（持ち主だけ）。リンクが家族以外に漏れたときに、古いリンクを使えなくする。
  // すでに入っているメンバーはそのまま。
  router.on('POST', '/g/:code/code', async (c) => {
    const { group, user } = await loadGroup(c);
    if (group.owner_id !== user.id) throw new HttpError(403, '招待コードを作り直せるのはグループの持ち主だけです');
    const code = newCode();
    await c.env.DB.prepare('UPDATE groups SET code = ? WHERE id = ?').bind(code, group.id).run();
    return json({ group: publicGroup({ ...group, code }) });
  });

  // メンバーを外す（持ち主だけ・自分は外せない）。外された人の端末には、そのグループの通知も届かなくなる。
  router.on('DELETE', '/g/:code/members/:userId', async (c) => {
    const { group, user } = await loadGroup(c);
    if (group.owner_id !== user.id) throw new HttpError(403, 'メンバーを外せるのはグループの持ち主だけです');
    if (c.params.userId === user.id) throw new HttpError(400, '自分を外すときは「このグループから抜ける」を使ってください');
    await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, c.params.userId).run();
    return json({ members: await loadMembers(c.env, group.id) });
  });

  router.on('GET', '/g/:code', async (c) => {
    const { group } = await loadGroup(c);
    const { results: spaces } = await c.env.DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.space_id = s.id AND i.done = 0 AND i.deleted_at IS NULL) AS open_count
       FROM spaces s WHERE s.group_id = ? AND s.deleted_at IS NULL ORDER BY s.position, s.created_at`,
    )
      .bind(group.id)
      .all();
    return json({ group: publicGroup(group), spaces: spaces.map(publicSpace), members: await loadMembers(c.env, group.id) });
  });

  router.on('PATCH', '/g/:code', async (c) => {
    const { group } = await loadGroup(c);
    const body = await readBody(c.request);
    const name = text(body.name, { max: 40, required: true, label: 'グループ名' });
    await c.env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, group.id).run();
    return json({ group: publicGroup({ ...group, name }) });
  });
}

// 内部の連番 id は外に出さない。
const publicGroup = (g) => ({ code: g.code, name: g.name, ownerId: g.owner_id ?? null });
export const publicSpace = ({ group_id, deleted_at, deleted_by, ...s }) => s;
