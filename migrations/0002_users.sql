-- ログインした人。パスワードは持たない（Google が本人確認をし、こちらは Google の利用者番号 sub だけを覚える）。
-- メールアドレスも保存しない。画面に出すのは本人が付けた名前（「まま」など）と色だけ。
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT UNIQUE,
  display_name TEXT,
  color        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- ログイン状態。クッキーには乱数を入れ、ここにはそのハッシュだけを置く
-- （DB が漏れても、そのままログインには使えないように）。
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- だれがどのグループに入っているか。参加コードは「招待状」になり、
-- コードを開いてログインした人がここに加わる。
CREATE TABLE group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

-- 通知を受け取る端末。1人が複数の端末を持てる。端末ごとに通知を入れたり切ったりできる。
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_user ON push_subscriptions(user_id);

-- だれが追加したかを、名前の文字列ではなく人で持つ（名前や色を変えたら過去の行にも反映されるように）。
ALTER TABLE items ADD COLUMN created_by_user TEXT;
ALTER TABLE memos ADD COLUMN created_by_user TEXT;
