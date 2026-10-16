-- グループの持ち主。招待コードの作り直しと、メンバーを外すことができるのは持ち主だけ。
-- （だれでもできると、招待リンクから入り込んだ人が家族を外せてしまうため）
ALTER TABLE groups ADD COLUMN owner_id TEXT;
-- すでにあるグループは、いちばん最初に入った人を持ち主にする
UPDATE groups SET owner_id = (
  SELECT m.user_id FROM group_members m WHERE m.group_id = groups.id ORDER BY m.joined_at LIMIT 1
);
