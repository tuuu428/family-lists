# 家族リスト

家族で買い物リストや「やること」を共有する小さな Web アプリ。

- **Google アカウントでログイン**。パスワードはこのアプリに保存しない（メールアドレスも保存しない）。
- 最初に**呼び名**（「まま」など）と**色**を決める。追加した項目には、その人の色の帯と名前が付く。
- **グループ**（= 家族）を作ると**招待リンク**（10文字のコード）が出る。開いてログインした人がメンバーになる。
- グループの中に**スペース**（「買い物」「やること」「薬局」…）を作り、その中に**リスト**と**メモ**を書く。
- リストの行は**どこを押しても済み**。**長押しで編集**（名前と補足、左端に赤い削除）。
- **通知**: 端末ごとに「家族が追加したら通知する」を入れられる（自分の追加は通知しない）。
- **削除するとゴミ箱へ**（聞き返さない）。ゴミ箱は「共有・メンバー」または各スペースの「設定」から開ける。
  選んで「元に戻す」か「完全に削除」。完全に削除だけは「本当に削除しますか？」（左「完全に削除」・右「キャンセル」）を通る。
  ゴミ箱に入って30日たったものは自動で完全に削除される。
- 4秒ごとに最新を取り直すので、家族が追加したものも自動で出てくる。

## 仕組み

Cloudflare Workers（無料枠で足りる）＋ D1（SQLite）。画面は素の HTML/CSS/JS でビルド不要。

```
public/            画面（index.html / style.css / app.js）
src/index.js       入口。/api/* を各機能に振り分ける
src/http.js        ルーターと入力チェックの小物
src/features/      機能ごとの API（auth / push / groups / spaces / items / memos / trash）
public/sw.js       通知を受け取って出す裏方（Service Worker）
scripts/           通知の鍵を作るスクリプト
migrations/        DB の形（SQL）
```

## 手元で動かす

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
npm run dev
```

http://localhost:8787 を開く。同じ Wi-Fi のスマホから試すときは `npm run dev:lan` で起動し、`http://<MacのIPアドレス>:8787` を開く。

手元では `.dev.vars` の `DEV_LOGIN=1` により、**名前だけの仮ログイン**が出る（「まま」「パパ」など何人でも作れる）。
公開版には `.dev.vars` が送られないので、仮ログインは出ない。

手元で試せないもの:
- **Google ログイン**は Google 側に登録したアドレス（`http://localhost:8787` など）でしか動かない。スマホから IP アドレスで開いたときは仮ログインを使う。
- **通知**は https（か localhost）でしか動かない。スマホでの確認は公開してから。

## Google ログインの準備

1. https://console.cloud.google.com/ で新しいプロジェクトを作る
2. 「API とサービス」→「OAuth 同意画面」: ユーザーの種類は「外部」、アプリ名を入れて保存。
   公開ステータスは「テスト」のままでよいが、その場合は「テストユーザー」に家族の Google アカウントを足す
3. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」
   - 承認済みの JavaScript 生成元: `http://localhost:8787`、`http://localhost`、公開後のアドレス（`https://lists.<サブドメイン>.workers.dev`）
4. 出てきた「クライアント ID」（`…apps.googleusercontent.com`）を `wrangler.jsonc` の `GOOGLE_CLIENT_ID` に貼る。これは公開して問題ない値

## 公開する（家族のスマホから使えるようにする）

Cloudflare のアカウント（無料）が要る。

1. ログイン

   ```bash
   npx wrangler login
   ```

2. 本番用の DB を作る。出てきた `database_id` を `wrangler.jsonc` の `database_id` に貼り替える。

   ```bash
   npx wrangler d1 create family-lists
   ```

3. 通知の鍵を作って入れる（手元用とは別に、本番用を新しく作る）

   ```bash
   node scripts/gen-vapid.mjs
   ```

   出てきた `VAPID_PUBLIC_KEY=` の値を `wrangler.jsonc` の `vars` に `"VAPID_PUBLIC_KEY": "…"` として足す。
   `VAPID_PRIVATE_JWK=` の値（`{` から `}` まで）は秘密なので、次のコマンドを実行して貼り付ける。

   ```bash
   npx wrangler secret put VAPID_PRIVATE_JWK
   ```

4. 本番 DB に表を作る

   ```bash
   npm run db:migrate:remote
   ```

5. 公開

   ```bash
   npm run deploy
   ```

   `https://lists.<あなたのサブドメイン>.workers.dev` が出るので、そこでグループを作って家族にリンクを送る。
   スマホではブラウザの「ホーム画面に追加」をしておくとアプリのように開ける。
   **iPhone で通知を受け取るには「ホーム画面に追加」が必須**（iOS 16.4 以降。Safari のタブのままでは通知を受け取れない）。

## 公開中のアドレスと、直したあとの反映

公開先: `https://<アプリ名>.<あなたのサブドメイン>.workers.dev`（`npm run deploy` の最後に表示される）

コードを直したら、次のコマンドで反映する（DB の形を変えた＝ migrations にファイルを足したときは、先に `npm run db:migrate:remote`）。

```bash
npm run deploy
```

## 守りについて

- 中身を見られるのは、ログインしてグループのメンバーになった人だけ。招待リンクを開いても、**グループ名を見て「参加する」を押すまでは参加しない**。
- グループを作った人が**持ち主**。持ち主は「共有・メンバー」から**メンバーを外す**、**招待コードを作り直す**（リンクが漏れたとき、古いリンクを無効にする）ができる。持ち主が抜けると次に古い人が引き継ぎ、最後の1人が抜けると招待コードは自動で作り直されて閉じる。
- このアプリが持つのは Google の利用者番号（sub）と、本人が付けた呼び名・色だけ。パスワードもメールアドレスも持たない。
- ログイン状態は `__Host-` 付きの HttpOnly クッキーで180日保つ。DB にはその乱数のハッシュだけを置く。
- 書き込み（追加・変更・削除）は、このサイト自身の画面から来たもの（Origin が一致し、JSON で送られたもの）しか受け付けない。同じ `<サブドメイン>.workers.dev` の別アプリからも操作できない。
- 画面には CSP などのヘッダーを付け、このサイトと Google のログイン部品以外のスクリプトは動かない。よそのページへの埋め込みも禁止。
- 通知の送り先は、ブラウザ各社の正規の通知サービスだけ登録できる。
- 回数制限（bot 対策）: 同じ送り元から1分あたり、ログイン10回・書き込み120回・読み込み300回まで。超えると1分待たされる（Cloudflare の場所ごとのおおよその数え方）。
- 検索エンジンには載せない（robots.txt・noindex）。
- だれかがグループに参加すると、通知を入れているメンバー全員に「〇〇が参加しました」と届く。
- 上限: 1人30グループ、1グループ30人・100スペース、1スペース500項目・500メモ（ゴミ箱の中も含む）、1回の送信64KB。
- 手元の開発サーバー（`npm run dev`）はこの Mac からしか開けない。スマホから試すときだけ `npm run dev:lan`（仮ログインが同じ Wi-Fi のだれにでも使えるので、家の Wi-Fi でだけ使う）。
- パスワードや口座番号のような大事な情報はメモに書かない。

## 拡張のしかた（例: 冷蔵庫の在庫）

スペースには `kind`（種類）があり、いまは `list` だけ。冷蔵庫を足すなら:

1. `migrations/0004_fridge.sql` を作り、在庫の表を足す（例: `fridge_items(id, space_id, name, qty, unit, expires_on, updated_at)`）。
   `npm run db:migrate` で手元に、`npm run db:migrate:remote` で本番に反映。
2. `src/features/fridge.js` を作り、`register(router)` の中に API を書く（`items.js` が手本）。
   `loadGroup(c)` → `loadSpace` を通せば、ログインとメンバーの確認はそのまま効く。
   ゴミ箱に対応するなら `deleted_at` / `deleted_by` 列を持たせ、`trash.js` に並べ方を足す。
   追加のたびに家族へ知らせたければ `notifyGroup` を呼ぶ（`items.js` が手本）。
3. `src/index.js` の機能の配列に `fridge` を足す。`src/features/spaces.js` の `SPACE_KINDS` に `'fridge'` を足す。
4. `public/app.js` の `showSpace` で `space.kind === 'fridge'` のときの描き方を足す。

外の在庫 DB や機械（重量センサー、レシート読み取りなど）から書き込みたい場合は、
その機械用の API（例: `POST /api/g/:code/spaces/:id/fridge`）を足す。
機械はログインできないので、そのときにスペース単位の書き込み用キー（機械専用の合言葉）を足すとよい。
