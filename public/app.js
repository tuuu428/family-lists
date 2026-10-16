'use strict';
// 家族リストの画面。ビルド不要にしたくて、素の JavaScript 1 ファイルにしている。
// 画面は「押した瞬間に変える → 裏で保存 → 定期的に最新を取り直す」で動く。

const $app = document.getElementById('app');
const POLL_MS = 4000;
const TOAST_MS = 3000;
const LONG_PRESS_MS = 450; // これより長く押したら「編集」。短いと完了を押すつもりの指で開いてしまう
const MOVE_TOLERANCE = 10; // 長押し中にこれ以上動いたらスクロールとみなして取りやめる（px）

let config = null; // サーバーの公開設定（Google のクライアント ID、通知の公開鍵など）
let me = { user: null, groups: [] }; // ログイン中の人と、入っているグループ

// ---------------------------------------------------------------------------
// この端末だけの覚え書き（開いていたタブなど）。消えても困らないものだけを置く。
const local = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// ---------------------------------------------------------------------------
// 小物
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const normalizeCode = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fmtCode = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;
const fmtTime = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// crypto.randomUUID は https か localhost でしか使えない。家のWi-Fiで http://192.168.x.x から
// スマホで試すときにも動くよう、無いときは自前で組み立てる。
const uuid = () =>
  crypto.randomUUID?.() ??
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw Object.assign(new Error('つながりません。電波を確かめてください'), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || `うまくいきませんでした (${res.status})`), { status: res.status, code: data.code });
    // ログインが切れていたら、どの画面にいてもログイン画面へ（開いていた場所はアドレスに残るので、戻れる）
    if (data.code === 'login_required' && me.user) {
      me = { user: null, groups: [] };
      setTimeout(route, 0);
    }
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// 人の名前と色。行の左端の色の帯と、名前の横の点に使う。
function memberMap() {
  return new Map((state.data?.members || []).map((m) => [m.id, m]));
}
function whoHtml(userId, fallbackName, members) {
  const m = members.get(userId);
  const name = m?.name || fallbackName;
  if (!name) return '';
  return `<span class="who"><i class="dot" style="background:${esc(m?.color || 'var(--muted)')}"></i>${esc(name)}</span>`;
}
const whoColor = (userId, members) => members.get(userId)?.color || 'transparent';

// ---------------------------------------------------------------------------
// 画面の状態。view が変わるたびに作り直す。
// cache は一度開いた画面を覚えておき、戻ったときに通信を待たず即座に出すためのもの。
const cache = { group: {}, space: {} };
let state = {};
let pollTimer = null;

// 自分の操作が通信中のあいだ、または通信開始後に自分が何か変えたときは、
// 取り直した結果で画面を上書きしない（押した直後の表示が一瞬戻る「ちらつき」を防ぐ）。
function touch() {
  state.version = (state.version || 0) + 1;
}
function send(method, path, body) {
  touch();
  state.pending = (state.pending || 0) + 1;
  const owner = state;
  return api(method, path, body)
    .catch((e) => {
      showToast(e.message);
      // 失敗したらサーバーの正しい状態に戻す
      if (owner === state) setTimeout(() => state.refresh?.(true), 0);
      throw e;
    })
    .finally(() => {
      owner.pending--;
    });
}

// 変わっていなければ描き直さない。4秒ごとに作り直すと、押している途中の行が差し替わって
// タップが空振りすることがあるため。比べるのは高々数百行なので文字列化で十分速い。
const sameData = (a, b) => !!a && JSON.stringify(a) === JSON.stringify(b);

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden) state.refresh?.();
  }, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) state.refresh?.();
});

// ---------------------------------------------------------------------------
// お知らせ（失敗したとき・保存したときなど）
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return alert(message);
  clearTimeout(toastTimer);
  el.textContent = message;
  el.hidden = false;
  toastTimer = setTimeout(() => (el.hidden = true), TOAST_MS);
}

// ---------------------------------------------------------------------------
// 削除の確認。取り消しの効かない操作は必ずここを通す。
// 「完全に削除」は左、「キャンセル」は右。最初に指が乗るのは（Enter で押されるのは）キャンセル。
// ネイティブの confirm() にしないのは、文言と赤い見た目とボタンの左右を決められないから。
function confirmDanger({ title = '本当に削除しますか？', message, action = '完全に削除' }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-msg">
        <h2 id="dlg-title" class="modal-title">${esc(title)}</h2>
        <p id="dlg-msg" class="modal-msg">${esc(message)}</p>
        <div class="modal-actions">
          <button type="button" class="danger-fill" data-answer="yes">${esc(action)}</button>
          <button type="button" data-answer="no">キャンセル</button>
        </div>
      </div>`;
    const close = (answer) => {
      document.removeEventListener('keydown', onKey, true);
      el.remove();
      before?.focus?.();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Tab') {
        // 2つのボタンの間だけを行き来させる（後ろの画面に出ていかないように）
        const [yes, no] = el.querySelectorAll('button');
        (document.activeElement === no ? yes : no).focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-answer]');
      if (b) close(b.dataset.answer === 'yes');
      else if (e.target === el) close(false); // 外側を押したらやめる
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(el);
    el.querySelector('[data-answer="no"]').focus();
  });
}

// 下の入力欄の高さに合わせて、一覧の余白とお知らせの位置を決める
const dockObserver = new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--dock-h', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
});

function mount(html) {
  dockObserver.disconnect();
  $app.innerHTML = html;
  const dock = $app.querySelector('.dock');
  if (dock) dockObserver.observe(dock);
  else document.documentElement.style.setProperty('--dock-h', '0px');
}

// ---------------------------------------------------------------------------
// 画面の切り替え
//   #/            ホーム（入っているグループ）
//   #/me          自分の名前・色・この端末の通知
//   #/g/コード     グループ（招待リンクもこれ。開いた人は自動で参加する）
//   #/g/コード/s/ID スペース
//   #/g/コード/trash ゴミ箱
function route() {
  stopPolling();
  if (!me.user) return showLogin();
  if (!me.user.name) return showProfile(true);
  const [a, code, b, spaceId] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'me') return showProfile(false);
  if (a === 'g' && code && b === 's' && spaceId) return showSpace(normalizeCode(code), spaceId);
  if (a === 'g' && code && b === 'trash') return showTrash(normalizeCode(code));
  if (a === 'g' && code) return showGroup(normalizeCode(code));
  showHome();
}
window.addEventListener('hashchange', route);

function showLoadError(e) {
  const main = document.getElementById('main');
  if (main && !main.querySelector('ul, .edit')) main.innerHTML = `<p class="empty">${esc(e.message)}<br><a href="#/">最初の画面へ</a></p>`;
  else showToast(e.message);
}

/**
 * まだ参加していないグループの画面を開いたら（招待リンクを開いたとき）、参加の確認画面に切り替える。
 * 勝手に参加させないのは、知らない人から届いたリンクを開いただけで、その人のグループに入ってしまわないように。
 */
async function loadWithJoin(path, code) {
  try {
    return await api('GET', path);
  } catch (e) {
    if (e.code === 'not_member') showJoin(code);
    throw e; // 呼び出し側は state が変わったのを見て何もしない
  }
}

function showJoin(code) {
  stopPolling();
  state = { view: 'join', code };
  mount(`
    <header class="bar">
      <a class="icon-btn back" href="#/" aria-label="最初の画面へ">‹</a>
      <h1>グループへの招待</h1>
    </header>
    <main class="page no-dock" id="main"><p class="empty">確かめています…</p></main>
    <div id="toast" class="toast" hidden></div>`);
  const s = state;
  api('GET', `/g/${code}/invite`)
    .then(({ group, memberCount }) => {
      if (s !== state) return;
      document.getElementById('main').innerHTML = `
        <p class="lead">「<strong>${esc(group.name)}</strong>」（メンバー ${memberCount} 人）に招待されています。</p>
        <p class="muted">参加すると、このグループのリストとメモを見たり書いたりできるようになり、メンバーにもあなたの呼び名が見えます。
          知らない人から届いたリンクなら、参加しないでください。</p>
        <div class="row end" style="margin-top:24px">
          <a class="button" href="#/">参加しない</a>
          <button type="button" class="primary" data-action="join" data-code="${esc(code)}">参加する</button>
        </div>`;
    })
    .catch((e) => {
      if (s === state) document.getElementById('main').innerHTML = `<p class="empty">${esc(e.message)}<br><a href="#/">最初の画面へ</a></p>`;
    });
}

// ===========================================================================
// ログイン
function showLogin() {
  state = { view: 'login' };
  const google = config?.googleClientId;
  mount(`
    <header class="bar"><h1>家族リスト</h1></header>
    <main class="page no-dock" id="main">
      <p class="lead">家族で買い物リストや「やること」を共有するアプリです。<br>
        Google アカウントでログインします。パスワードはこのアプリに保存されません。</p>
      ${google ? `<div id="google-btn" class="google-btn"></div>` : ''}
      ${
        config?.devLogin
          ? `<section><h2>仮ログイン（手元の試験用・公開版には出ません）</h2>
              <form class="row" data-form="dev-login">
                <input name="name" placeholder="例: まま" aria-label="仮ログインの名前" maxlength="20" required>
                <button>ログイン</button>
              </form></section>`
          : ''
      }
      ${!google && !config?.devLogin ? `<p class="empty">ログインの設定がまだです（README の「Google ログインの準備」を参照）</p>` : ''}
    </main>
    <div id="toast" class="toast" hidden></div>`);
  if (google) renderGoogleButton(google);
}

function renderGoogleButton(clientId) {
  const draw = async () => {
    const el = document.getElementById('google-btn');
    if (!el || !window.google?.accounts?.id) return;
    // この端末だけの使い捨ての合言葉。Google から戻るトークンに入り、サーバーが突き合わせる
    let nonce;
    try {
      ({ nonce } = await api('POST', '/auth/nonce'));
    } catch (e) {
      return showToast(e.message);
    }
    google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential, ux_mode: 'popup', nonce });
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja' });
  };
  if (window.google?.accounts?.id) return draw();
  // Google のログイン部品はログイン画面でだけ読み込む（ふだんの画面を軽く保つため）
  if (!document.getElementById('gsi')) {
    const s = document.createElement('script');
    s.id = 'gsi';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = draw;
    s.onerror = () => showToast('Google のログイン部品を読み込めませんでした');
    document.head.append(s);
  }
}

async function onGoogleCredential(response) {
  try {
    await api('POST', '/auth/google', { credential: response.credential });
    me = await api('GET', '/me');
    route();
  } catch (e) {
    showToast(e.message);
  }
}

// ===========================================================================
// 自分の名前・色・この端末の通知
function showProfile(first) {
  state = { view: 'profile' };
  const u = me.user;
  mount(`
    <header class="bar">
      ${first ? '' : `<a class="icon-btn back" href="#/" aria-label="最初の画面へ">‹</a>`}
      <h1>${first ? 'はじめに' : 'あなたの設定'}</h1>
    </header>
    <main class="page no-dock" id="main">
      ${first ? `<p class="lead">家族の中での呼び名と、あなたの色を決めてください。追加した項目に、この名前と色が付きます。</p>` : ''}
      <form data-form="profile">
        <section>
          <h2>呼び名</h2>
          <input name="name" value="${esc(u.name)}" placeholder="例: まま、パパ、はると" aria-label="呼び名" maxlength="20" required>
        </section>
        <section>
          <h2>あなたの色</h2>
          <div class="swatches" role="radiogroup" aria-label="あなたの色">
            ${config.colors
              .map(
                (c, i) => `<label class="swatch" style="--c:${c}">
                  <input type="radio" name="color" value="${c}" ${c === u.color ? 'checked' : ''} aria-label="色 ${i + 1}">
                  <span></span></label>`,
              )
              .join('')}
          </div>
        </section>
        <div class="row end" style="margin-top:20px"><button class="primary">${first ? 'はじめる' : '保存'}</button></div>
      </form>
      ${
        first
          ? ''
          : `<section>
              <h2>この端末の通知</h2>
              <div id="push-area"><p class="muted">確かめています…</p></div>
            </section>
            <section class="quiet-zone">
              <button type="button" class="quiet" data-action="logout">ログアウト</button>
            </section>`
      }
    </main>
    <div id="toast" class="toast" hidden></div>`);
  if (!first) renderPushArea();
}

// ---------------------------------------------------------------------------
// 通知（端末ごとに入れる／切る）
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** この端末で通知が使えるか。使えないなら、その理由を本人が分かる言葉で返す。 */
function pushBlocker() {
  if (!config.vapidPublicKey) return '通知の鍵がサーバーに設定されていません（README 参照）。';
  if (!window.isSecureContext) return 'https で開いたときだけ通知を使えます（公開後、または localhost で試してください）。';
  if (isIos() && !isStandalone())
    return 'iPhone では、Safari の共有ボタン →「ホーム画面に追加」で置いたアイコンから開くと、通知を使えるようになります。';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'このブラウザは通知に対応していません。';
  if (Notification.permission === 'denied')
    return '通知がブロックされています。ブラウザ（または端末）の設定で、このサイトの通知を許可してください。';
  return null;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function renderPushArea() {
  const el = document.getElementById('push-area');
  if (!el) return;
  const blocker = pushBlocker();
  if (blocker) return (el.innerHTML = `<p class="muted">${esc(blocker)}</p>`);
  const on = !!(await currentSubscription().catch(() => null)) && Notification.permission === 'granted';
  el.innerHTML = `
    <label class="switch-row">
      <span>家族が追加したら、この端末に通知する<br><span class="muted">自分で追加したものは通知しません</span></span>
      <input type="checkbox" role="switch" data-action="toggle-push" ${on ? 'checked' : ''} aria-label="この端末に通知する">
    </label>
    ${on ? `<div class="row" style="margin-top:12px"><button type="button" data-action="test-push">試しに通知する</button></div>` : ''}`;
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(config.vapidPublicKey) }));
  await api('POST', '/push/subscriptions', sub.toJSON());
}

async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api('POST', '/push/subscriptions/delete', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// サーバー側の台帳が消えていても（DB の作り直しなど）、この端末で通知が入っていれば登録し直す
async function resyncPush() {
  if (pushBlocker() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription().catch(() => null);
  if (sub) api('POST', '/push/subscriptions', sub.toJSON()).catch(() => {});
}

// ===========================================================================
// ホーム: 入っているグループ／作る／コードで参加
function showHome() {
  state = { view: 'home' };
  state.refresh = async () => {
    const next = await api('GET', '/me').catch(() => null);
    if (next && state.view === 'home' && !sameData(me, next)) {
      me = next;
      showHome();
    }
  };
  const groups = me.groups;
  mount(`
    <header class="bar">
      <h1>家族リスト</h1>
      <a class="icon-btn me-btn" href="#/me" aria-label="あなたの設定（${esc(me.user.name)}）">
        <i class="dot" style="background:${esc(me.user.color)}"></i>${esc(me.user.name)}</a>
    </header>
    <main class="page no-dock" id="main">
      ${
        groups.length
          ? `<section><h2>参加中のグループ</h2><ul class="cards">${groups
              .map(
                (g) => `<li><a class="card" href="#/g/${g.code}">
                  <span class="card-title">${esc(g.name)}</span><span class="muted">${fmtCode(g.code)}</span></a></li>`,
              )
              .join('')}</ul></section>`
          : `<p class="lead">家族で使うグループを作るか、家族から届いたリンク（またはコード）で参加してください。</p>`
      }
      <section>
        <h2>コードで参加</h2>
        <form class="row" data-form="join-group">
          <input name="code" placeholder="xxxxx-xxxxx" aria-label="参加コード" autocapitalize="off" autocomplete="off" spellcheck="false" required>
          <button>参加</button>
        </form>
      </section>
      <section>
        <h2>新しくグループを作る</h2>
        <form class="row" data-form="create-group">
          <input name="name" placeholder="例: わが家" aria-label="グループ名" maxlength="40" required>
          <button>作る</button>
        </form>
      </section>
    </main>
    <div id="toast" class="toast" hidden></div>`);
}

// ===========================================================================
// グループ: スペース（買い物・やること…）の一覧
function showGroup(code) {
  state = { view: 'group', code, data: cache.group[code] || null, panel: false };
  state.refresh = (force) => refreshGroup(force);
  mount(`
    <header class="bar">
      <a class="icon-btn back" href="#/" aria-label="グループ一覧へ">‹</a>
      <h1 id="title"></h1>
      <button class="icon-btn" data-action="toggle-share" aria-expanded="false">共有・メンバー</button>
    </header>
    <div id="panel"></div>
    <main class="page" id="main"></main>
    <div id="toast" class="toast" hidden></div>
    <footer class="dock">
      <form class="row" data-form="add-space">
        <input name="name" placeholder="スペースを追加（例: 薬局）" aria-label="新しいスペースの名前" maxlength="40" required>
        <button>追加</button>
      </form>
    </footer>`);
  renderGroup();
  refreshGroup();
  startPolling();
}

async function refreshGroup(force = false) {
  const s = state;
  const v = s.version;
  try {
    const data = await loadWithJoin(`/g/${s.code}`, s.code);
    if (s !== state || (!force && (s.pending || v !== s.version))) return;
    if (!force && sameData(s.data, data)) return;
    s.data = cache.group[s.code] = data;
    renderGroup();
  } catch (e) {
    if (s === state) showLoadError(e);
  }
}

function renderGroup() {
  const { data, code } = state;
  document.getElementById('title').textContent = data?.group.name ?? '';
  document.title = data ? `${data.group.name} - 家族リスト` : '家族リスト';
  const main = document.getElementById('main');
  if (!data) return;
  main.innerHTML = data.spaces.length
    ? `<ul class="cards">${data.spaces
        .map(
          (sp) => `<li><a class="card" href="#/g/${code}/s/${sp.id}">
            <span class="card-icon" aria-hidden="true">${esc(sp.icon || sp.name.slice(0, 1))}</span>
            <span class="card-title">${esc(sp.name)}</span>
            ${sp.open_count ? `<span class="badge" aria-label="未完了 ${sp.open_count} 件">${sp.open_count}</span>` : ''}
          </a></li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">スペースがありません。下の欄から「買い物」などを追加してください。</p>`;
  if (state.panel) renderSharePanel();
}

// パネルは入力中の文字を消さないよう一度だけ描くので、中身が変わったときは明示的に描き直す
function rerenderSharePanel() {
  document.getElementById('panel').innerHTML = '';
  renderSharePanel();
}

function renderSharePanel() {
  const panel = document.getElementById('panel');
  const btn = $app.querySelector('[data-action="toggle-share"]');
  btn.setAttribute('aria-expanded', String(state.panel));
  if (!state.panel) return (panel.innerHTML = '');
  // 入力中に定期更新でパネルを描き直すと文字が消えるので、一度だけ描く
  if (panel.childElementCount) return;
  const { code, data } = state;
  const url = `${location.origin}/#/g/${code}`;
  const isOwner = data?.group.ownerId === me.user.id;
  panel.innerHTML = `<div class="panel">
    <div class="field"><span>メンバー</span>
      <ul class="members">${(data?.members || [])
        .map(
          (m) => `<li>${
            isOwner && m.id !== me.user.id
              ? `<button type="button" class="quiet" data-action="remove-member" data-id="${esc(m.id)}" data-name="${esc(m.name || '名前未設定')}">外す</button>`
              : ''
          }<i class="dot" style="background:${esc(m.color)}"></i>${esc(m.name || '（名前未設定）')}${
            m.id === me.user.id ? '<span class="muted">（あなた）</span>' : ''
          }${m.id === data.group.ownerId ? '<span class="muted">・持ち主</span>' : ''}</li>`,
        )
        .join('')}</ul>
    </div>
    <div class="field"><span>家族にこのリンク（またはコード）を送ると、ログインしてそのまま参加できます</span>
      <div class="code">${fmtCode(code)}</div>
      <div class="row"><button type="button" class="primary" data-action="share-link" data-url="${esc(url)}">リンクを送る</button></div>
    </div>
    <form class="field" data-form="rename-group"><span>グループ名</span>
      <div class="row"><input name="name" value="${esc(data?.group.name)}" aria-label="グループ名" maxlength="40" required><button>変更</button></div>
    </form>
    <p class="muted"><a href="#/g/${code}/trash">ゴミ箱 →</a></p>
    <p class="muted"><a href="#/me">あなたの呼び名・色・通知の設定 →</a></p>
    <div class="quiet-zone">
      ${isOwner ? `<button type="button" class="quiet" data-action="rotate-code">招待コードを作り直す（リンクが漏れたとき）</button>` : ''}
      <button type="button" class="quiet" data-action="leave-group">このグループから抜ける</button>
    </div>
  </div>`;
}

// ===========================================================================
// スペース: リストとメモ
function showSpace(code, spaceId) {
  const cached = cache.space[spaceId];
  // 一覧から来たときは、名前だけでも先に出しておく
  const fromGroup = cache.group[code]?.spaces.find((sp) => sp.id === spaceId);
  state = {
    view: 'space',
    code,
    spaceId,
    data: cached || (fromGroup ? { space: fromGroup, items: null, memos: null, members: cache.group[code].members } : null),
    tab: local.get(`tab:${spaceId}`, 'list'),
    editing: null,
    panel: false,
  };
  state.refresh = (force) => refreshSpace(force);
  mount(`
    <header class="bar">
      <a class="icon-btn back" href="#/g/${code}" aria-label="スペース一覧へ">‹</a>
      <h1 id="title"></h1>
      <button class="icon-btn" data-action="toggle-space-menu" aria-expanded="false">設定</button>
    </header>
    <div id="panel"></div>
    <main class="page" id="main"></main>
    <div id="toast" class="toast" hidden></div>
    <footer class="dock">
      <div class="seg" role="tablist" id="tabs"></div>
      <div id="composer"></div>
    </footer>
    <div id="sheet"></div>`);
  renderSpaceHeader();
  renderComposer();
  renderSpaceMain();
  refreshSpace();
  startPolling();
}

async function refreshSpace(force = false) {
  const s = state;
  const v = s.version;
  try {
    const data = await loadWithJoin(`/g/${s.code}/spaces/${s.spaceId}`, s.code);
    // 編集中に描き直すと書きかけの文字が消えるので、そのあいだは取り込まない
    if (s !== state || (!force && (s.pending || v !== s.version || s.editing))) return;
    if (!force && sameData(s.data, data)) return;
    s.data = cache.space[s.spaceId] = data;
    renderSpaceHeader();
    renderSpaceMain();
  } catch (e) {
    if (s === state) showLoadError(e);
  }
}

function renderSpaceHeader() {
  const sp = state.data?.space;
  document.getElementById('title').textContent = sp ? `${sp.icon ? sp.icon + ' ' : ''}${sp.name}` : '';
  document.title = sp ? `${sp.name} - 家族リスト` : '家族リスト';
  const items = state.data?.items;
  const memos = state.data?.memos;
  const openCount = items ? items.filter((i) => !i.done).length : '';
  const tabs = [
    ['list', `リスト${openCount ? ` ${openCount}` : ''}`],
    ['memo', `メモ${memos?.length ? ` ${memos.length}` : ''}`],
  ];
  document.getElementById('tabs').innerHTML = tabs
    .map(([key, label]) => `<button type="button" role="tab" data-action="tab" data-tab="${key}" aria-selected="${state.tab === key}">${label}</button>`)
    .join('');
}

function renderComposer() {
  const el = document.getElementById('composer');
  el.innerHTML =
    state.tab === 'list'
      ? `<form class="row" data-form="add-item">
           <input name="text" placeholder="追加する（例: 牛乳）" aria-label="リストに追加" maxlength="200" enterkeyhint="done" autocomplete="off" required>
           <button>追加</button>
         </form>`
      : `<form class="row" data-form="add-memo">
           <textarea name="body" rows="1" placeholder="メモを書く" aria-label="メモを書く" maxlength="5000" required></textarea>
           <button>追加</button>
         </form>`;
}

function renderSpaceMain() {
  const main = document.getElementById('main');
  const { data } = state;
  if (!data?.items) {
    if (!main.children.length) main.innerHTML = `<p class="empty">読み込み中…</p>`;
    return;
  }
  const members = memberMap();
  main.innerHTML = state.tab === 'list' ? listHtml(data.items, members) : memosHtml(data.memos, members);
  const editor = main.querySelector('[data-autofocus]');
  if (editor) {
    editor.focus();
    editor.setSelectionRange?.(editor.value.length, editor.value.length);
  }
  if (state.panel) renderSpacePanel();
}

function listHtml(items, members) {
  const open = items.filter((i) => !i.done);
  // 済みは新しく済ませた順。さっき押したものがすぐ上に見えるように
  const done = items.filter((i) => i.done).sort((a, b) => (b.done_at || 0) - (a.done_at || 0));
  if (!items.length) return `<p class="empty">まだ何もありません。<br>下の欄から追加してください。</p>`;
  const row = (it) => itemHtml(it, members);
  return `
    ${open.length ? `<ul class="items">${open.map(row).join('')}</ul>` : `<p class="empty">ぜんぶ済みました</p>`}
    ${done.length ? `<h2 class="done-head">済み ${done.length}</h2><ul class="items">${done.map(row).join('')}</ul>` : ''}
    <p class="hint">${hasMouse() ? '丸を押すと済み／行を押すと編集' : '押すと済み／長押しで編集'}</p>`;
}

// スマホ: 行のどこを押しても「済み／戻す」、長押しで編集。買い物中に片手でどんどん消していけるように。
// パソコン（マウス）: 長押しはしにくいので、丸のクリックで済み、行のそれ以外のクリックで編集。
// 端末の種類ではなく「いま押したのがマウスか指か」で分けるので、タッチ画面つきのパソコンでも指なら指の動きになる。
function itemHtml(it, members) {
  const who = whoHtml(it.created_by_user, it.created_by, members);
  const when = it.done && it.done_at ? `<span>${fmtTime(it.done_at)} 済み</span>` : '';
  return `<li class="item${it.done ? ' done' : ''}" style="--who:${esc(whoColor(it.created_by_user, members))}">
    <button type="button" class="item-row" data-action="set-done" data-longpress="edit-item" data-id="${it.id}" data-done="${it.done ? 0 : 1}"
      role="checkbox" aria-checked="${!!it.done}" aria-description="長押しで編集">
      <span class="check" aria-hidden="true"><span></span></span>
      <span class="item-body">
        <span class="item-text">${esc(it.text)}</span>
        ${it.note ? `<span class="item-note">${esc(it.note)}</span>` : ''}
        ${who || when ? `<span class="item-meta">${who}${when}</span>` : ''}
      </span>
    </button>
  </li>`;
}

// 項目の編集画面（下から出す）。名前はいつもの大きさ、補足は小さめ。削除は左端に赤で。
function openItemSheet(id) {
  const it = findItem(id);
  if (!it) return;
  state.editing = id;
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = `<div class="sheet-backdrop" data-action="cancel-edit"></div>
    <form class="sheet" data-form="edit-item" data-id="${it.id}" role="dialog" aria-modal="true" aria-label="項目の編集">
      <input name="text" class="sheet-name" value="${esc(it.text)}" aria-label="名前" maxlength="200" required>
      <textarea name="note" class="sheet-note" rows="3" placeholder="補足（任意）例: 低脂肪のほう／機種は〜" aria-label="補足" maxlength="1000">${esc(it.note)}</textarea>
      ${editActions('item', it.id)}
    </form>`;
  const input = sheet.querySelector('.sheet-name');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet) sheet.innerHTML = '';
}

// 削除は左端に赤で。よく押す「保存」は右端なので、指の通り道から離れる。
function editActions(kind, id) {
  return `<div class="edit-actions">
    <button type="button" class="danger-outline" data-action="delete-${kind}" data-id="${id}">削除</button>
    <span class="spacer"></span>
    <button type="button" data-action="cancel-edit">やめる</button>
    <button class="primary">保存</button>
  </div>`;
}

function memosHtml(memos, members) {
  if (!memos.length) return `<p class="empty">メモはまだありません。<br>症状や型番など、覚えておきたいことを残せます。</p>`;
  return `<ul class="memos">${memos
    .map((m) =>
      state.editing === m.id
        ? `<li class="memo editing"><form class="edit" data-form="edit-memo" data-id="${m.id}">
             <textarea name="body" rows="6" aria-label="メモ" maxlength="5000" required data-autofocus>${esc(m.body)}</textarea>
             ${editActions('memo', m.id)}
           </form></li>`
        : `<li class="memo" style="--who:${esc(whoColor(m.created_by_user, members))}">
             <button type="button" class="memo-body" data-action="edit-memo" data-id="${m.id}">
               <span class="memo-text">${esc(m.body)}</span>
               <span class="item-meta">${whoHtml(m.created_by_user, m.created_by, members)}<span>${fmtTime(m.updated_at)}</span></span>
             </button></li>`,
    )
    .join('')}</ul>`;
}

function renderSpacePanel() {
  const panel = document.getElementById('panel');
  $app.querySelector('[data-action="toggle-space-menu"]').setAttribute('aria-expanded', String(state.panel));
  if (!state.panel) return (panel.innerHTML = '');
  if (panel.childElementCount) return;
  const sp = state.data?.space;
  const doneCount = state.data?.items?.filter((i) => i.done).length || 0;
  panel.innerHTML = `<div class="panel">
    <form data-form="rename-space">
      <div class="field"><span>名前</span><input name="name" value="${esc(sp?.name)}" aria-label="スペースの名前" maxlength="40" required></div>
      <div class="field"><span>アイコン（絵文字1つ・任意）</span><input name="icon" value="${esc(sp?.icon)}" aria-label="アイコン" maxlength="8"></div>
      <div class="row end"><button class="primary">保存</button></div>
    </form>
    <p class="muted"><a href="#/g/${state.code}/trash">ゴミ箱を開く →</a></p>
    <div class="quiet-zone">
      ${doneCount ? `<button type="button" class="quiet" data-action="clear-done">済みの項目をゴミ箱へ（${doneCount}件）</button>` : ''}
      <button type="button" class="quiet" data-action="delete-space">このスペースをゴミ箱へ</button>
    </div>
  </div>`;
}

// ===========================================================================
// ゴミ箱: 選んで「元に戻す」か「完全に削除」
function showTrash(code) {
  state = { view: 'trash', code, data: null, selected: new Set() };
  document.title = 'ゴミ箱 - 家族リスト';
  state.refresh = (force) => refreshTrash(force);
  mount(`
    <header class="bar">
      <a class="icon-btn back" href="#/g/${code}" aria-label="スペース一覧へ">‹</a>
      <h1>ゴミ箱</h1>
    </header>
    <main class="page" id="main"><p class="empty">読み込み中…</p></main>
    <div id="toast" class="toast" hidden></div>
    <footer class="dock">
      <p class="trash-count" id="trash-count" aria-live="polite"></p>
      <div class="trash-actions">
        <button type="button" class="danger-outline" data-action="trash-purge" disabled>完全に削除</button>
        <span class="spacer"></span>
        <button type="button" class="primary" data-action="trash-restore" disabled>元に戻す</button>
      </div>
    </footer>`);
  refreshTrash();
  startPolling();
}

async function refreshTrash(force = false) {
  const s = state;
  const v = s.version;
  try {
    const data = await loadWithJoin(`/g/${s.code}/trash`, s.code);
    if (s !== state || (!force && (s.pending || v !== s.version))) return;
    if (!force && sameData(s.data, data)) return;
    s.data = data;
    // ほかの人が戻した／消したものは、選択からも外す
    const alive = new Set(trashKeys(data));
    s.selected = new Set([...s.selected].filter((k) => alive.has(k)));
    renderTrash();
  } catch (e) {
    if (s === state) showLoadError(e);
  }
}

const trashKeys = (d) => (d ? [...d.spaces.map((x) => `space:${x.id}`), ...d.items.map((x) => `item:${x.id}`), ...d.memos.map((x) => `memo:${x.id}`)] : []);

function renderTrash() {
  const { data, selected } = state;
  const main = document.getElementById('main');
  const n = selected.size;
  document.getElementById('trash-count').textContent = n ? `${n}件を選択中` : '戻す、または完全に削除するものを選んでください';
  $app.querySelectorAll('[data-action="trash-restore"], [data-action="trash-purge"]').forEach((b) => (b.disabled = !n));
  if (!data) return;
  const members = new Map(data.members.map((m) => [m.id, m]));
  const deletedBy = (x) => {
    const who = members.get(x.deleted_by)?.name;
    return `${who ? `${who}が` : ''}${fmtTime(x.deleted_at)} に削除`;
  };
  const row = (kind, x, title, sub) => {
    const on = selected.has(`${kind}:${x.id}`);
    return `<li class="item"><button type="button" class="item-row trash-row" data-action="toggle-trash" data-kind="${kind}" data-id="${x.id}"
        role="checkbox" aria-checked="${on}">
      <span class="check square${on ? ' on' : ''}" aria-hidden="true"><span></span></span>
      <span class="item-body"><span class="item-text">${esc(title)}</span>
        <span class="item-meta"><span>${esc(sub)}</span><span>${esc(deletedBy(x))}</span></span></span>
    </button></li>`;
  };
  const place = (x) => `${x.space_icon ? x.space_icon + ' ' : ''}${x.space_name}`;
  const section = (label, list) => (list.length ? `<h2 class="trash-head">${label}</h2><ul class="items">${list.join('')}</ul>` : '');
  const total = data.spaces.length + data.items.length + data.memos.length;
  if (!total) {
    main.innerHTML = `<p class="empty">ゴミ箱は空です</p>`;
    return;
  }
  const allOn = trashKeys(data).every((k) => selected.has(k));
  main.innerHTML = `
    <div class="trash-top">
      <span class="muted">${data.keepDays}日たったものは自動で完全に削除されます</span>
      <button type="button" class="link" data-action="trash-select-all">${allOn ? '選択をやめる' : 'すべて選択'}</button>
    </div>
    ${section('スペース', data.spaces.map((x) => row('space', x, `${x.icon ? x.icon + ' ' : ''}${x.name}`, `リスト ${x.item_count}・メモ ${x.memo_count}`)))}
    ${section('リストの項目', data.items.map((x) => row('item', x, x.text, place(x))))}
    ${section('メモ', data.memos.map((x) => row('memo', x, x.body.length > 40 ? `${x.body.slice(0, 40)}…` : x.body, place(x))))}`;
}

async function trashAction(kind) {
  const picked = { spaces: [], items: [], memos: [] };
  for (const key of state.selected) {
    const [k, id] = key.split(':');
    picked[`${k}s`].push(id);
  }
  const n = state.selected.size;
  if (!n) return;
  if (kind === 'purge') {
    const ok = await confirmDanger({ message: `選んだ ${n} 件を完全に削除します。家族全員の画面から消え、もう元には戻せません。` });
    if (!ok || state.view !== 'trash') return;
  }
  try {
    await send('POST', `/g/${state.code}/trash/${kind}`, picked);
    state.selected = new Set();
    // 戻したものが一覧に出るよう、覚えている画面は読み直させる
    Object.keys(cache.group).forEach((k) => delete cache.group[k]);
    Object.keys(cache.space).forEach((k) => delete cache.space[k]);
    showToast(kind === 'purge' ? `${n} 件を完全に削除しました` : `${n} 件を元に戻しました`);
    await refreshTrash(true);
  } catch {}
}

// ---------------------------------------------------------------------------
// リストとメモの操作。どれも「先に画面を変えて、裏で保存」。
// 削除はゴミ箱へ移すだけなので聞き返さない。聞き返すのはゴミ箱の「完全に削除」だけ。
const findItem = (id) => state.data.items.find((i) => i.id === id);
const findMemo = (id) => state.data.memos.find((m) => m.id === id);
const spacePath = () => `/g/${state.code}/spaces/${state.spaceId}`;

function rerenderSpace() {
  renderSpaceHeader();
  renderSpaceMain();
}

function stopEditing() {
  state.editing = null;
  closeSheet();
  renderSpaceMain();
}

// 反転ではなく「済みにする／戻す」をはっきり送る。連打や同時操作でも向きがぶれない。
function setDone(id, done) {
  const it = findItem(id);
  if (!it || !!it.done === done) return;
  it.done = done ? 1 : 0;
  it.done_at = done ? Date.now() : null;
  rerenderSpace();
  send('PATCH', `/g/${state.code}/items/${id}`, { done }).catch(() => {});
}

function addItem(text) {
  const now = Date.now();
  const item = { id: uuid(), text, note: null, done: 0, done_at: null, created_by: me.user.name, created_by_user: me.user.id, created_at: now };
  state.data.items.push(item);
  rerenderSpace();
  window.scrollTo({ top: document.body.scrollHeight });
  send('POST', `${spacePath()}/items`, item).catch(() => {});
}

async function deleteItem(id) {
  const it = findItem(id);
  if (!it) return;
  state.data.items = state.data.items.filter((i) => i !== it);
  state.editing = null;
  closeSheet();
  rerenderSpace();
  send('DELETE', `/g/${state.code}/items/${id}`).catch(() => {});
  showToast(`「${it.text}」をゴミ箱に移しました`);
}

async function clearDone() {
  const done = state.data.items.filter((i) => i.done);
  if (!done.length) return;
  state.data.items = state.data.items.filter((i) => !done.includes(i));
  state.panel = false;
  renderSpacePanel();
  rerenderSpace();
  send('POST', `${spacePath()}/items/delete`, { ids: done.map((i) => i.id) }).catch(() => {});
  showToast(`済みの項目 ${done.length} 件をゴミ箱に移しました`);
}

function saveItem(id, text, note) {
  const it = findItem(id);
  state.editing = null;
  closeSheet();
  if (!it) return rerenderSpace();
  it.text = text;
  it.note = note || null;
  rerenderSpace();
  send('PATCH', `/g/${state.code}/items/${id}`, { text, note }).catch(() => {});
}

function addMemo(body) {
  const now = Date.now();
  const memo = { id: uuid(), body, created_by: me.user.name, created_by_user: me.user.id, created_at: now, updated_at: now };
  state.data.memos.unshift(memo);
  rerenderSpace();
  window.scrollTo({ top: 0 });
  send('POST', `${spacePath()}/memos`, memo).catch(() => {});
}

function saveMemo(id, body) {
  const m = findMemo(id);
  state.editing = null;
  if (!m) return rerenderSpace();
  m.body = body;
  m.updated_at = Date.now();
  rerenderSpace();
  send('PATCH', `/g/${state.code}/memos/${id}`, { body }).catch(() => {});
}

async function deleteMemo(id) {
  const m = findMemo(id);
  if (!m) return;
  state.data.memos = state.data.memos.filter((x) => x !== m);
  state.editing = null;
  rerenderSpace();
  send('DELETE', `/g/${state.code}/memos/${id}`).catch(() => {});
  showToast('メモをゴミ箱に移しました');
}

// ---------------------------------------------------------------------------
// 長押し。指を置いて LONG_PRESS_MS たったら編集を開き、そのあとの「離した＝クリック」は捨てる。
// 指が動いたらスクロールとみなして何もしない。
let press = null;
let suppressClickUntil = 0;
let lastPointerType = '';
const hasMouse = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
$app.addEventListener('pointerdown', (e) => {
  lastPointerType = e.pointerType;
  const el = e.target.closest('[data-longpress]');
  // マウスは長押しではなくクリックで編集を開くので、タイマーは指（とペン）のときだけ
  if (!el || e.button > 0 || e.pointerType === 'mouse') return;
  press = {
    el,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      press = null;
      suppressClickUntil = Date.now() + 800;
      navigator.vibrate?.(15); // Android では軽く震わせて「開いた」ことを指に伝える
      if (el.dataset.longpress === 'edit-item') openItemSheet(el.dataset.id);
    }, LONG_PRESS_MS),
  };
});
const cancelPress = () => {
  if (press) clearTimeout(press.timer);
  press = null;
};
$app.addEventListener('pointermove', (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => $app.addEventListener(t, cancelPress));
// Android の長押しやパソコンの右クリックで出るメニューの代わりに編集を開く
$app.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('[data-longpress]');
  if (!el) return;
  e.preventDefault();
  cancelPress();
  if (state.editing !== el.dataset.id) openItemSheet(el.dataset.id);
});

// ---------------------------------------------------------------------------
// 押す操作（ひとまとめに受ける）
$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.longpress && Date.now() < suppressClickUntil) return; // 長押しの指を離したときのクリック
  const { id } = el.dataset;
  switch (el.dataset.action) {
    case 'set-done':
      // マウスで丸以外を押したら編集。キーボード（Enter・スペース）はこれまでどおり済み
      if ((e.pointerType || lastPointerType) === 'mouse' && e.detail > 0 && !e.target.closest('.check')) openItemSheet(id);
      else setDone(id, el.dataset.done === '1');
      break;
    case 'edit-memo':
      state.editing = id;
      renderSpaceMain();
      break;
    case 'cancel-edit':
      stopEditing();
      break;
    case 'delete-item':
      deleteItem(id);
      break;
    case 'delete-memo':
      deleteMemo(id);
      break;
    case 'clear-done':
      clearDone();
      break;
    case 'tab':
      if (state.tab === el.dataset.tab) break;
      state.tab = el.dataset.tab;
      state.editing = null;
      local.set(`tab:${state.spaceId}`, state.tab);
      renderSpaceHeader();
      renderComposer();
      renderSpaceMain();
      window.scrollTo({ top: 0 });
      break;
    case 'toggle-share':
      state.panel = !state.panel;
      renderSharePanel();
      break;
    case 'toggle-space-menu':
      state.panel = !state.panel;
      renderSpacePanel();
      break;
    case 'share-link': {
      const url = el.dataset.url;
      const title = state.data?.group.name ?? '家族リスト';
      try {
        if (navigator.share) await navigator.share({ title, text: `「${title}」の家族リストに参加してください`, url });
        else {
          await navigator.clipboard.writeText(url);
          showToast('リンクをコピーしました');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') prompt('このリンクをコピーして送ってください', url);
      }
      break;
    }
    case 'leave-group': {
      const name = state.data?.group.name ?? 'このグループ';
      const ok = await confirmDanger({
        title: 'グループから抜けますか？',
        message: `「${name}」のリストが見られなくなります。もう一度入るには、家族からリンクを送ってもらう必要があります。`,
        action: '抜ける',
      });
      if (!ok) break;
      try {
        me.groups = (await api('POST', `/g/${state.code}/leave`)).groups;
        delete cache.group[state.code];
        location.hash = '#/';
      } catch (err) {
        showToast(err.message);
      }
      break;
    }
    case 'delete-space': {
      try {
        await api('DELETE', spacePath());
        delete cache.space[state.spaceId];
        location.hash = `#/g/${state.code}`;
      } catch (err) {
        showToast(err.message);
      }
      break;
    }
    case 'join':
      try {
        await api('POST', `/g/${normalizeCode(el.dataset.code)}/join`);
        me = await api('GET', '/me');
        route(); // アドレスはそのままなので、開こうとしていた画面に進む
      } catch (err) {
        showToast(err.message);
      }
      break;
    case 'remove-member': {
      const name = el.dataset.name;
      const ok = await confirmDanger({
        title: 'メンバーを外しますか？',
        message: `「${name}」をこのグループから外します。リストが見られなくなり、通知も届かなくなります。招待リンクを知っていれば入り直せるので、必要なら招待コードも作り直してください。`,
        action: '外す',
      });
      if (!ok) break;
      try {
        const { members } = await api('DELETE', `/g/${state.code}/members/${encodeURIComponent(id)}`);
        state.data.members = members;
        rerenderSharePanel();
        showToast(`「${name}」を外しました`);
      } catch (err) {
        showToast(err.message);
      }
      break;
    }
    case 'rotate-code': {
      const ok = await confirmDanger({
        title: '招待コードを作り直しますか？',
        message: '今の招待リンクとコードは使えなくなります。すでに入っているメンバーはそのままです。',
        action: '作り直す',
      });
      if (!ok) break;
      try {
        const { group } = await api('POST', `/g/${state.code}/code`);
        delete cache.group[state.code];
        me = await api('GET', '/me');
        location.hash = `#/g/${group.code}`;
        showToast('招待コードを作り直しました');
      } catch (err) {
        showToast(err.message);
      }
      break;
    }
    case 'toggle-trash': {
      const key = `${el.dataset.kind}:${id}`;
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
      renderTrash();
      break;
    }
    case 'trash-select-all': {
      const all = trashKeys(state.data);
      const everything = all.length && all.every((k) => state.selected.has(k));
      state.selected = new Set(everything ? [] : all);
      renderTrash();
      break;
    }
    case 'trash-restore':
      trashAction('restore');
      break;
    case 'trash-purge':
      trashAction('purge');
      break;
    case 'toggle-push': {
      el.disabled = true;
      try {
        if (el.checked) await enablePush();
        else await disablePush();
      } catch (err) {
        showToast(err.message);
      }
      renderPushArea();
      break;
    }
    case 'test-push':
      try {
        const { count } = await api('POST', '/push/test');
        showToast(count ? '送りました。数秒で届きます' : 'この端末の通知が登録されていません');
      } catch (err) {
        showToast(err.message);
      }
      break;
    case 'logout':
      // この端末に届く通知も止める（別の人がこの端末でログインしたとき、前の人の通知が来ないように）
      await disablePush().catch(() => {});
      await api('POST', '/auth/logout').catch(() => {});
      me = { user: null, groups: [] };
      Object.keys(cache.group).forEach((k) => delete cache.group[k]);
      Object.keys(cache.space).forEach((k) => delete cache.space[k]);
      location.hash = '#/';
      route();
      break;
  }
});

// 入力の送信（Enter でも、ボタンでも）
$app.addEventListener('submit', async (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const val = (k) => String(f[k] ?? '').trim();

  switch (kind) {
    case 'add-item': {
      if (!val('text') || !state.data?.items) return;
      addItem(val('text'));
      form.reset();
      form.elements.text.focus(); // 続けて入れられるように
      break;
    }
    case 'add-memo': {
      if (!val('body') || !state.data?.memos) return;
      addMemo(val('body'));
      form.reset();
      autosize(form.elements.body);
      break;
    }
    case 'edit-item':
      if (val('text')) saveItem(form.dataset.id, val('text'), val('note'));
      break;
    case 'edit-memo':
      if (val('body')) saveMemo(form.dataset.id, val('body'));
      break;
    case 'dev-login':
      try {
        await api('POST', '/auth/dev', { name: val('name') });
        me = await api('GET', '/me');
        route();
      } catch (err) {
        showToast(err.message);
      }
      break;
    case 'profile':
      try {
        const first = !me.user.name;
        me.user = (await api('PATCH', '/me', { name: val('name'), color: val('color') })).user;
        // 名前と色は一覧の表示にも出るので、覚えている画面は読み直させる
        Object.keys(cache.space).forEach((k) => delete cache.space[k]);
        if (first) route();
        else showToast('保存しました');
      } catch (err) {
        showToast(err.message);
      }
      break;
    case 'create-group':
      try {
        const { group } = await api('POST', '/groups', { name: val('name') });
        me.groups.push(group);
        location.hash = `#/g/${group.code}`;
      } catch (err) {
        showToast(err.message);
      }
      break;
    case 'join-group': {
      const code = normalizeCode(val('code'));
      if (code.length !== 10) return showToast('コードは英数字10文字です（ハイフンは無くても大丈夫）');
      location.hash = `#/g/${code}`;
      break;
    }
    case 'rename-group':
      try {
        const { group } = await api('PATCH', `/g/${state.code}`, { name: val('name') });
        state.data.group = group;
        renderGroup();
        showToast('グループ名を変えました');
      } catch (err) {
        showToast(err.message);
      }
      break;
    case 'add-space': {
      const sp = { id: uuid(), name: val('name'), icon: null, kind: 'list', open_count: 0 };
      if (!sp.name || !state.data) return;
      state.data.spaces.push(sp);
      renderGroup();
      form.reset();
      send('POST', `/g/${state.code}/spaces`, sp).catch(() => {});
      break;
    }
    case 'rename-space':
      try {
        const { space } = await api('PATCH', spacePath(), { name: val('name'), icon: val('icon') });
        state.data.space = space;
        state.panel = false;
        renderSpacePanel();
        renderSpaceHeader();
      } catch (err) {
        showToast(err.message);
      }
      break;
  }
});

// メモ入力欄は書いた量に合わせて伸ばす（上限は CSS の max-height）
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}
$app.addEventListener('input', (e) => {
  if (e.target.matches('.dock textarea')) autosize(e.target);
});

// 編集中に Esc でやめる
$app.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.editing) stopEditing();
});

// ---------------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    [config, me] = await Promise.all([api('GET', '/config'), api('GET', '/me')]);
  } catch (e) {
    $app.innerHTML = `<p class="empty">${esc(e.message)}<br><button type="button" id="retry">もう一度</button></p>`;
    document.getElementById('retry').addEventListener('click', () => location.reload());
    return;
  }
  route();
  if (me.user) resyncPush();
}
boot();
