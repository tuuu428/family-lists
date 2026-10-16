-- グループ = 家族。code が「合言葉」で、知っている人だけが中を見られる。
-- アカウント登録を作らないのは、家族に配るときの手間を最小にしたいから。
CREATE TABLE groups (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- スペース = 「買い物」「やること」などの箱。
-- kind で中身の種類を分ける。いまは 'list' だけだが、冷蔵庫の在庫なら 'fridge' を足して
-- 専用のテーブルと画面をぶら下げる想定（README の「拡張のしかた」参照）。
CREATE TABLE spaces (
  id         TEXT PRIMARY KEY,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  icon       TEXT,
  kind       TEXT NOT NULL DEFAULT 'list',
  position   REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX spaces_group ON spaces(group_id, position);

-- リストの1行。id は端末側で作る（押した瞬間に画面へ出して、あとから保存するため）。
CREATE TABLE items (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  note       TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  done_at    INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX items_space ON items(space_id, done, created_at);

-- スペースごとの自由なメモ（「母の携帯: 機種は〜、症状は〜」など）。
CREATE TABLE memos (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memos_space ON memos(space_id, created_at);
