-- ゴミ箱。削除してもすぐには消さず、deleted_at に日時を入れて画面から隠すだけにする。
-- ゴミ箱から「元に戻す」と NULL に戻し、「完全に削除」で初めて行を消す。
-- 30日たったものは、ゴミ箱を開いたときに自動で完全に削除する。
ALTER TABLE spaces ADD COLUMN deleted_at INTEGER;
ALTER TABLE spaces ADD COLUMN deleted_by TEXT;
ALTER TABLE items ADD COLUMN deleted_at INTEGER;
ALTER TABLE items ADD COLUMN deleted_by TEXT;
ALTER TABLE memos ADD COLUMN deleted_at INTEGER;
ALTER TABLE memos ADD COLUMN deleted_by TEXT;
CREATE INDEX spaces_trash ON spaces(group_id, deleted_at);
CREATE INDEX items_trash ON items(space_id, deleted_at);
CREATE INDEX memos_trash ON memos(space_id, deleted_at);
