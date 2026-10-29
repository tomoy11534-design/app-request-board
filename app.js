'use strict';

// ===== 設定 =====
// Google Apps Script のウェブアプリURL（docs/setup.md の手順で取得して貼り付ける）
const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbz-5wsPbWHagg_SRyBw1ix7wDmv33HhNCm3jH9el3LPhrdEiQkeMkOa5vkDksgL8_ASRg/exec';

const STATUSES = ['未着手', '対応中', '確認待ち', '完了'];
const MAX_IMAGES = 6;
// 画像は送る前にこの大きさ（長い辺のピクセル数）まで縮める
const IMAGE_MAX_SIDE = 1280;
// 画面を開いているあいだ、この間隔で新しい返事を読み込む（ミリ秒）
const REFRESH_INTERVAL = 60000;
// 音声入力で何も聞き取れない状態がこの時間続いたら自動で止める（ミリ秒）
const SILENCE_TIMEOUT = 15000;
// 書いた本人が要望・返事を取り消せる時間（ミリ秒）
const UNDO_LIMIT = 10 * 60 * 1000;
// 送った直後の「取り消す」を出しておく時間（ミリ秒）
const UNDO_TOAST_MS = 8000;
// 取り消し・編集で Apps Script から返る理由（そのまま見せる）
const UNDO_ERRORS = ['自分が書いたものだけ取り消せます', '取り消せる時間を過ぎました', '返事がついたので取り消せません', '自分が書いたものだけ直せます'];

const NAME_KEY = 'board-name';
const PASS_KEY = 'board-passphrase';
const SEEN_KEY = 'board-seen';
const LAST_APP_KEY = 'board-last-app';

// ===== 画面の要素 =====
const $ = (id) => document.getElementById(id);
const formDialog = $('form-dialog');
const setupDialog = $('setup-dialog');

// ===== 保存（localStorage） =====
function getSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても動作は続ける
  }
}

// どの要望をいつ見たか（この端末だけに保存する）
function loadSeen() {
  try {
    return JSON.parse(getSetting(SEEN_KEY));
  } catch {
    return null;
  }
}

let seen = loadSeen();

function markSeen(item) {
  if (!item) return;
  seen = seen || {};
  seen[item.id] = Math.max(item.updatedAt || 0, Date.now());
  setSetting(SEEN_KEY, JSON.stringify(seen));
}

const myName = () => getSetting(NAME_KEY) || '';

// 相手が更新して、まだ開いていない要望
function isUnread(item) {
  return item.updatedBy !== myName() && (item.updatedAt || 0) > ((seen && seen[item.id]) || 0);
}

// ===== 状態 =====
const state = {
  items: [],
  replies: [],
  apps: [], // 登録したアプリ（名前とURL）
  loaded: false,
  loading: false,
  appFilter: 'all',
  statusFilter: 'open',
  editing: null, // 直している途中の要望・返事 { kind, id, draft }
  seenBefore: 0, // 開いている要望を、前に見た時刻
  newsClosed: new Set(), // 「前回からの新着」を閉じたときに出ていた要望（新しい動きが増えたらまた出す）
};

// ===== 通信（Google Apps Script） =====
class ApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function callApi(action, payload = {}, passphrase = getSetting(PASS_KEY)) {
  if (!ENDPOINT_URL) throw new ApiError('no_endpoint');
  let response;
  try {
    // 本文は文字列で送る（Apps Script は CORS の事前確認に対応していないため）
    response = await fetch(ENDPOINT_URL, {
      method: 'POST',
      body: JSON.stringify({ action, passphrase: passphrase || '', ...payload }),
    });
  } catch {
    throw new ApiError('network');
  }
  if (!response.ok) throw new ApiError('network');
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError('bad_response');
  }
  if (!data.ok) throw new ApiError(data.error || 'unknown');
  return data;
}

function errorMessage(error) {
  const code = error && error.code;
  if (code === 'no_endpoint') return 'まだ送り先が設定されていません。app.js の ENDPOINT_URL を設定してください。';
  if (code === 'network') return '通信できませんでした。電波のよいところで、もう一度試してください。';
  if (code === 'invalid_passphrase') return '合言葉がちがいます。';
  if (code === 'bad_response') return '送り先から正しい返事がありませんでした。Apps Script の公開設定を確かめてください。';
  if (UNDO_ERRORS.includes(code)) return code + '。';
  if (code === 'unknown_action' || code === 'old_script') return 'Apps Script が古いままです。新しい gas/code.gs を貼って、新しいバージョンでデプロイしてください。';
  return `うまくいきませんでした（${code || error}）。少し待ってから、もう一度試してください。`;
}

// ===== 読み込み =====
async function refresh({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet && !state.loaded) showBanner('読み込み中…');
  const unreadBefore = state.items.filter(isUnread).length;
  try {
    const data = await callApi('list');
    state.items = data.items;
    state.replies = data.replies;
    state.apps = data.apps || [];
    // 初めて開いた端末では、これまでの分を既読として始める
    if (seen === null) {
      seen = {};
      state.items.forEach(markSeen);
    }
    state.loaded = true;
    showBanner('');
    // 開いている要望は、更新されてもそのまま既読にする
    const current = selectedItem();
    if (current) markSeen(current);
    render();
    const unreadAfter = state.items.filter(isUnread).length;
    if (quiet && unreadAfter > unreadBefore) toast('新しい更新があります');
  } catch (error) {
    if (error.code === 'invalid_passphrase') openSetup('合言葉が変わったようです。新しい合言葉を入れてください。');
    else if (!quiet || !state.loaded) showBanner(errorMessage(error));
  } finally {
    state.loading = false;
  }
}

// ===== 表示 =====
function render() {
  renderNews();
  renderFilters();
  renderList();
  renderDetail();
  const unread = state.items.filter(isUnread).length;
  document.title = unread ? `(${unread}) アプリ要望ボード` : 'アプリ要望ボード';
  $('name-button').textContent = myName() ? `👤 ${myName()}` : '👤 名前';
}

function showBanner(message) {
  $('banner').textContent = message;
  $('banner').hidden = !message;
}

let toastTimer = null;
// action を渡すと、お知らせの横にボタンを出す（例: 送った直後の「取り消す」）
function toast(message, ms = 2400, action = null) {
  const box = $('toast');
  box.textContent = message;
  if (action) {
    const button = el('button', 'toast-action', action.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      box.hidden = true;
      action.onClick();
    });
    box.append(button);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), ms);
}

// 要素を作る小さな道具（文字は必ず textContent で入れる）
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const pad = (n) => String(n).padStart(2, '0');

function formatTime(time) {
  if (!time) return '';
  const d = new Date(time);
  const now = new Date();
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今日 ${clock}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨日 ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

// 一覧の見出しは内容の1行目から作る
function titleOf(item) {
  const first = item.body.split(/\r?\n/).find((line) => line.trim()) || item.body;
  return first.length > 50 ? first.slice(0, 50) + '…' : first;
}

// 登録したアプリと、要望に書かれたアプリをまとめる
function appNames() {
  const names = [...state.apps.map((app) => app.name), ...state.items.map((item) => item.app)];
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'ja'));
}

const findApp = (name) => state.apps.find((app) => app.name === name);

function renderFilters() {
  const appBox = $('app-filter');
  appBox.innerHTML = '';
  const names = appNames();
  appBox.hidden = names.length === 0;
  if (state.loaded && state.appFilter !== 'all' && !names.includes(state.appFilter)) state.appFilter = 'all';
  [['all', 'すべてのアプリ'], ...names.map((name) => [name, name])].forEach(([value, label]) => {
    appBox.append(makeChip(label, state.appFilter === value, () => {
      state.appFilter = value;
      render();
    }));
  });

  renderAppCard();

  const inApp = state.items.filter(matchesApp);
  const statusBox = $('status-filter');
  statusBox.innerHTML = '';
  [
    ['open', '未完了', inApp.filter((i) => i.status !== '完了').length],
    ['unread', '新着', inApp.filter(isUnread).length],
    ['done', '完了', inApp.filter((i) => i.status === '完了').length],
    ['all', 'すべて', inApp.length],
  ].forEach(([value, label, count]) => {
    statusBox.append(makeChip(`${label} ${count}`, state.statusFilter === value, () => {
      state.statusFilter = value;
      render();
    }));
  });
}

// 絞り込み中のアプリの名前と、開くリンク
function renderAppCard() {
  const card = $('app-card');
  card.innerHTML = '';
  card.hidden = state.appFilter === 'all';
  if (card.hidden) return;
  const app = findApp(state.appFilter);
  card.append(el('strong', 'app-card-name', state.appFilter));
  if (app && app.url) card.append(appLink(app, 'アプリを開く ↗'));
  else card.append(el('span', 'muted', 'URLは未登録'));
  const edit = el('button', 'text-button', app && app.url ? 'URLを変更' : 'URLを登録');
  edit.type = 'button';
  edit.addEventListener('click', () => openAppForm(state.appFilter));
  card.append(edit);
}

function appLink(app, label) {
  const link = el('a', 'app-link', label);
  link.href = app.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function makeChip(label, pressed, onClick) {
  const chip = el('button', 'chip', label);
  chip.type = 'button';
  chip.setAttribute('aria-pressed', String(pressed));
  chip.addEventListener('click', onClick);
  return chip;
}

const matchesApp = (item) => state.appFilter === 'all' || item.app === state.appFilter;

function visibleItems() {
  return state.items
    .filter(matchesApp)
    .filter((item) => {
      if (state.statusFilter === 'open') return item.status !== '完了';
      if (state.statusFilter === 'unread') return isUnread(item);
      if (state.statusFilter === 'done') return item.status === '完了';
      return true;
    })
    // 新着を先に、そのあとは更新が新しい順
    .sort((a, b) => (isUnread(b) - isUnread(a)) || (b.updatedAt - a.updatedAt));
}

function renderList() {
  const list = $('item-list');
  list.innerHTML = '';
  if (!state.loaded) return;
  const items = visibleItems();
  if (items.length === 0) {
    const empty = el('div', 'empty');
    empty.append(
      el('strong', '', state.items.length ? 'この条件の要望はありません' : 'まだ要望はありません'),
      el('span', '', '「＋ 要望を書く」から、改善してほしいことや追加してほしい機能を書き残せます。'),
    );
    list.append(empty);
    return;
  }
  items.forEach((item) => {
    const card = el('button', 'item-card');
    card.type = 'button';
    card.addEventListener('click', () => openItem(item.id));
    // 相手が新しく書いた要望と、返事などで更新された要望を、色と言葉で分けて目立たせる
    const unread = isUnread(item);
    const added = unread && !(seen && seen[item.id]);
    if (unread) card.classList.add(added ? 'is-added' : 'is-updated');

    const title = el('span', 'item-title');
    if (unread) title.append(el('span', 'new-tag', added ? '🆕 新しい要望' : '💬 更新あり'));
    title.append(el('span', 'item-title-text', titleOf(item)));

    const meta = el('span', 'item-meta');
    meta.append(el('span', 'app-tag', item.app), statusPill(item.status));
    if (item.images.length) meta.append(el('span', '', `📷 ${item.images.length}`));

    const last = el('span', 'item-last', `${item.updatedBy}・${formatTime(item.updatedAt)}　${item.lastNote}`);
    card.append(title, meta, last);
    list.append(card);
  });
}

// 状態は色と絵文字の両方で見分けられるようにする
const STATUS_ICONS = { '未着手': '⏳', '対応中': '🔧', '確認待ち': '👀', '完了': '✅' };

// ===== 前回からの新着のお知らせ =====
// 開いたときに、前回見たあとに相手が書いた・更新した要望を一覧の上にまとめて出す
const NEWS_ROWS = 3;

function renderNews() {
  const card = $('news-card');
  card.innerHTML = '';
  const unread = state.items.filter(isUnread).sort((a, b) => b.updatedAt - a.updatedAt);
  const closed = unread.every((item) => state.newsClosed.has(`${item.id}@${item.updatedAt}`));
  card.hidden = !state.loaded || unread.length === 0 || closed;
  if (card.hidden) return;

  const added = unread.filter((item) => !(seen && seen[item.id])).length;
  const head = el('div', 'news-head');
  head.append(el('strong', 'news-title', `🔔 前回見たあとに ${unread.length}件 の新しい動きがあります`));
  const close = el('button', 'news-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'お知らせを閉じる');
  close.addEventListener('click', () => {
    unread.forEach((item) => state.newsClosed.add(`${item.id}@${item.updatedAt}`));
    renderNews();
  });
  head.append(close);

  const parts = [];
  if (added) parts.push(`🆕 新しい要望 ${added}件`);
  if (unread.length - added) parts.push(`💬 更新あり ${unread.length - added}件`);
  card.append(head, el('p', 'news-summary', parts.join('　')));

  // 新しいものから数件だけ、押せばすぐ開けるように並べる
  const list = el('div', 'news-list');
  unread.slice(0, NEWS_ROWS).forEach((item) => {
    const row = el('button', 'news-row');
    row.type = 'button';
    row.append(
      el('span', 'news-row-title', `${item.app}：${titleOf(item)}`),
      el('span', 'news-row-note', `${item.updatedBy}・${formatTime(item.updatedAt)}　${item.lastNote}`),
    );
    row.addEventListener('click', () => openItem(item.id));
    list.append(row);
  });
  card.append(list);

  if (unread.length > NEWS_ROWS && state.statusFilter !== 'unread') {
    const all = el('button', 'secondary-button', `新着 ${unread.length}件 をすべて見る`);
    all.type = 'button';
    all.addEventListener('click', () => {
      state.statusFilter = 'unread';
      state.appFilter = 'all';
      render();
    });
    card.append(all);
  }
}

function statusPill(status) {
  const pill = el('span', 'status-pill', `${STATUS_ICONS[status] || ''} ${status}`.trim());
  pill.dataset.status = status;
  return pill;
}

// 要望を書くときのアプリの選択肢（最後に「ほかのアプリ」を置く）
const NEW_APP = '__new__';

function renderAppOptions(selected) {
  const select = $('item-app-select');
  select.innerHTML = '';
  const names = appNames();
  names.forEach((name) => {
    const option = el('option', '', name);
    option.value = name;
    select.append(option);
  });
  const other = el('option', '', '＋ ほかのアプリ（名前を入れる）');
  other.value = NEW_APP;
  select.append(other);
  if (names.includes(selected)) {
    select.value = selected;
  } else {
    // 一覧にない名前は「ほかのアプリ」の欄に入れておく
    select.value = names.length && !selected ? names[0] : NEW_APP;
    $('item-app').value = selected || '';
  }
  toggleNewAppField();
}

function toggleNewAppField() {
  $('item-app-new').hidden = $('item-app-select').value !== NEW_APP;
}

function formApp() {
  const value = $('item-app-select').value;
  return (value === NEW_APP ? $('item-app').value : value).trim();
}

// ===== 詳細画面 =====
function selectedId() {
  const match = /^#item\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

function selectedItem() {
  const id = selectedId();
  return id ? state.items.find((item) => item.id === id) : null;
}

function openItem(id) {
  location.hash = `item/${encodeURIComponent(id)}`;
}

// アドレスの # で一覧と詳細を切り替える（スマホの「戻る」で一覧に戻れるように）
function showView() {
  const id = selectedId();
  const item = selectedItem();
  const showDetail = Boolean(id) && (Boolean(item) || !state.loaded);
  $('view-list').hidden = showDetail;
  $('view-detail').hidden = !showDetail;
  if (!showDetail && id && state.loaded) {
    // 見つからない要望なら一覧に戻す
    history.replaceState(null, '', location.pathname + location.search);
  }
  // 開く前に見た時刻を覚えておき、それより新しい相手の返事に印をつける
  // （読み込み前で、前に見た時刻がわからないときは印をつけない）
  state.seenBefore = item && seen ? seen[item.id] || 0 : Infinity;
  if (item) markSeen(item);
  if (dictation.want) stopDictation();
  state.editing = null;
  render();
  window.scrollTo(0, 0);
}

function renderDetail() {
  // 直している途中は、読み込み直しで書きかけが消えないよう描き直さない
  if (state.editing && document.getElementById('edit-text')) return;
  const item = selectedItem();
  const box = $('detail');
  const thread = $('thread');
  box.innerHTML = '';
  thread.innerHTML = '';
  if (!item) return;

  const head = el('div', 'detail-head');
  const appInfo = el('span', 'detail-app');
  appInfo.append(el('span', 'app-tag', item.app));
  const app = findApp(item.app);
  if (app && app.url) appInfo.append(appLink(app, '開く ↗'));
  head.append(appInfo);
  const statusLabel = el('label', 'status-select');
  statusLabel.dataset.status = item.status;
  statusLabel.append('状態 ');
  const select = document.createElement('select');
  STATUSES.forEach((status) => {
    const option = el('option', '', `${STATUS_ICONS[status]} ${status}`);
    option.value = status;
    option.selected = status === item.status;
    select.append(option);
  });
  select.addEventListener('change', () => changeStatus(item, select.value, select));
  statusLabel.append(select);
  head.append(statusLabel);

  const who = el('p', 'detail-who', `${item.createdBy}が ${formatTime(item.createdAt)} に書きました${item.editedAt ? '（編集済み）' : ''}`);
  if (isMine(item.createdBy)) who.append(editButton('item', item.id, item.body));
  if (canUndo(item.createdBy, item.createdAt)) who.append(undoButton(() => undoItem(item)));
  const body = isEditing('item', item.id) ? editBox() : el('p', 'detail-body', item.body);
  box.append(head, body, imageGrid(item.images), who);

  const replies = state.replies
    .filter((reply) => reply.itemId === item.id)
    .sort((a, b) => a.at - b.at);
  if (replies.length === 0) {
    thread.append(el('p', 'muted', 'まだ返事はありません。気づいたことを書いておくと、相手が次に開いたときに読めます。'));
  }
  replies.forEach((reply) => {
    const message = el('div', reply.system ? 'message is-system' : 'message');
    if (reply.author === myName() && !reply.system) message.classList.add('is-mine');
    const isNew = !reply.system && !isMine(reply.author) && Math.max(reply.at, reply.editedAt || 0) > state.seenBefore;
    if (isNew) message.classList.add('is-new');
    const messageHead = el('div', 'message-head', `${reply.author}・${formatTime(reply.at)}${reply.editedAt ? '（編集済み）' : ''}`);
    if (isNew) messageHead.prepend(el('span', 'new-tag', 'NEW'));
    if (!reply.system && isMine(reply.author)) messageHead.append(editButton('reply', reply.id, reply.text));
    if (!reply.system && canUndo(reply.author, reply.at)) messageHead.append(undoButton(() => undoReply(reply)));
    message.append(messageHead);
    if (isEditing('reply', reply.id)) message.append(editBox());
    else if (reply.text) message.append(el('p', 'message-text', reply.text));
    const grid = imageGrid(reply.images);
    if (grid) message.append(grid);
    thread.append(message);
  });
}

// ===== 画像 =====
const imageCache = new Map();

// 画像は合言葉つきで1枚ずつ読み込む（ドライブを公開しなくて済むように）
function loadImage(id) {
  if (!imageCache.has(id)) {
    const promise = callApi('image', { id }).then((data) => data.dataUrl);
    // 失敗したら次に開いたときに読み直す
    promise.catch(() => imageCache.delete(id));
    imageCache.set(id, promise);
  }
  return imageCache.get(id);
}

function imageGrid(ids) {
  if (!ids || ids.length === 0) return '';
  const grid = el('div', 'thumbs');
  ids.forEach((id) => {
    const button = el('button', 'thumb is-loading');
    button.type = 'button';
    button.setAttribute('aria-label', '画像を拡大');
    const img = document.createElement('img');
    img.alt = '添付画像';
    button.append(img);
    loadImage(id).then((url) => {
      img.src = url;
      button.classList.remove('is-loading');
      button.addEventListener('click', () => openLightbox(url));
    }).catch(() => {
      button.classList.remove('is-loading');
      button.replaceChildren(el('span', 'thumb-error', '読み込めません'));
    });
    grid.append(button);
  });
  return grid;
}

function openLightbox(url) {
  $('lightbox-img').src = url;
  $('lightbox').hidden = false;
}

// 送る前に縮小して JPEG にする（通信量とドライブの容量を減らすため）
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const context = canvas.getContext('2d');
      // 透明な部分は白にする
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

// 送信前の画像（データURLのまま持つ）
const pendingImages = { item: [], reply: [] };

async function addPendingImages(kind, files) {
  const images = [...files].filter((file) => file.type.startsWith('image/'));
  if (images.length < files.length) toast('画像だけをつけられます');
  for (const file of images) {
    if (pendingImages[kind].length >= MAX_IMAGES) {
      toast(`画像は${MAX_IMAGES}枚までです`);
      break;
    }
    try {
      pendingImages[kind].push(await shrinkImage(file));
    } catch {
      toast('この画像は読み込めませんでした');
    }
  }
  renderPendingImages(kind);
}

function renderPendingImages(kind) {
  const box = $(`${kind}-images`);
  box.innerHTML = '';
  pendingImages[kind].forEach((url, index) => {
    const thumb = el('span', 'thumb');
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'つける画像';
    const remove = el('button', 'thumb-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'この画像を外す');
    remove.addEventListener('click', () => {
      pendingImages[kind].splice(index, 1);
      renderPendingImages(kind);
    });
    thumb.append(img, remove);
    box.append(thumb);
  });
}

async function uploadPendingImages(kind) {
  const ids = [];
  for (const dataUrl of pendingImages[kind]) {
    const data = await callApi('uploadImage', { dataUrl });
    ids.push(data.id);
  }
  return ids;
}

// 貼り付け（Ctrl + V）でも画像をつけられるようにする
function takePastedImages(event, kind) {
  const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter((file) => file.type.startsWith('image/'));
  if (files.length === 0) return;
  event.preventDefault();
  addPendingImages(kind, files);
}

// ===== 書き込み =====
let sending = false;

function setBusy(button, busy, label) {
  sending = busy;
  button.disabled = busy;
  if (label) button.textContent = label;
}

async function submitItem() {
  if (sending) return;
  const app = formApp();
  const body = $('item-body').value.trim();
  if (!app || !body) {
    toast('アプリと内容を入れてください');
    return;
  }
  if (dictation.want) stopDictation();
  const button = $('item-submit');
  setBusy(button, true, pendingImages.item.length ? '画像を送っています…' : '送っています…');
  try {
    const images = await uploadPendingImages('item');
    const data = await callApi('addItem', { app, body, author: myName(), images });
    setSetting(LAST_APP_KEY, app);
    state.items.push(data.item);
    markSeen(data.item);
    $('item-body').value = '';
    pendingImages.item = [];
    renderPendingImages('item');
    formDialog.close();
    toast('書き残しました', UNDO_TOAST_MS, { label: '取り消す', onClick: () => undoItem(data.item) });
    render();
  } catch (error) {
    toast(errorMessage(error), 4000);
  } finally {
    setBusy(button, false, '書き残す');
  }
}

async function submitReply() {
  if (sending) return;
  const item = selectedItem();
  const text = $('reply-text').value.trim();
  if (!item || (!text && pendingImages.reply.length === 0)) return;
  if (dictation.want) stopDictation();
  const button = $('reply-submit');
  setBusy(button, true, pendingImages.reply.length ? '画像を送っています…' : '送っています…');
  try {
    const images = await uploadPendingImages('reply');
    const data = await callApi('reply', { itemId: item.id, text, author: myName(), images });
    $('reply-text').value = '';
    pendingImages.reply = [];
    renderPendingImages('reply');
    toast('送りました', UNDO_TOAST_MS, { label: '取り消す', onClick: () => undoReply(data.reply) });
    await refresh({ quiet: true });
  } catch (error) {
    toast(errorMessage(error), 4000);
  } finally {
    setBusy(button, false, '返事を送る');
  }
}

// ===== 編集 =====
// 自分が書いたものは、いつでも文字を直せる（画像はそのまま）
const isMine = (author) => Boolean(myName()) && author === myName();
const isEditing = (kind, id) => Boolean(state.editing) && state.editing.kind === kind && state.editing.id === id;

function editButton(kind, id, text) {
  const button = el('button', 'undo-button', '編集');
  button.type = 'button';
  button.addEventListener('click', () => {
    state.editing = { kind, id, draft: text };
    renderDetail();
    const input = $('edit-text');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return button;
}

function editBox() {
  const box = el('div', 'edit-box');
  const input = el('textarea', 'text-input');
  input.id = 'edit-text';
  input.rows = 4;
  input.maxLength = 4000;
  input.value = state.editing.draft;
  input.setAttribute('aria-label', '内容を直す');
  input.addEventListener('input', () => (state.editing.draft = input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) saveEdit(save);
  });
  const actions = el('div', 'compose-actions');
  const cancel = el('button', 'text-button', 'やめる');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    state.editing = null;
    renderDetail();
  });
  const save = el('button', 'primary-button', '直す');
  save.type = 'button';
  save.addEventListener('click', () => saveEdit(save));
  actions.append(cancel, save);
  box.append(input, actions);
  return box;
}

async function saveEdit(button) {
  if (sending) return;
  const { kind, id, draft } = state.editing;
  const text = draft.trim();
  if (kind === 'item' && !text) {
    toast('内容を入れてください');
    return;
  }
  setBusy(button, true, '直しています…');
  try {
    if (kind === 'item') await callApi('editItem', { itemId: id, body: text, author: myName() });
    else await callApi('editReply', { replyId: id, text, author: myName() });
    state.editing = null;
    sending = false;
    toast('直しました');
    await refresh({ quiet: true });
    // 読み込み直しに失敗しても、編集の欄は閉じる
    renderDetail();
  } catch (error) {
    toast(errorMessage(error), 4000);
    setBusy(button, false, '直す');
  }
}

// ===== 取り消し =====
// 自分が書いて、まだ時間がたっていないものだけ取り消せる
function canUndo(author, at) {
  return Boolean(myName()) && author === myName() && Date.now() - at < UNDO_LIMIT;
}

// 間違って押さないよう、1回目は「本当に取り消す？」に変わり、もう1回押すと取り消す
function undoButton(onConfirm) {
  const button = el('button', 'undo-button', '取り消す');
  button.type = 'button';
  let timer = null;
  button.addEventListener('click', () => {
    if (button.dataset.confirm) {
      clearTimeout(timer);
      button.disabled = true;
      onConfirm();
      return;
    }
    button.dataset.confirm = '1';
    button.textContent = '本当に取り消す？';
    timer = setTimeout(() => {
      delete button.dataset.confirm;
      button.textContent = '取り消す';
    }, 4000);
  });
  return button;
}

async function undoItem(item) {
  try {
    await callApi('deleteItem', { itemId: item.id, author: myName() });
    state.items = state.items.filter((i) => i.id !== item.id);
    state.replies = state.replies.filter((reply) => reply.itemId !== item.id);
    toast('要望を取り消しました');
    // 詳細を開いていたら一覧に戻す
    if (selectedId() === item.id) {
      history.replaceState(null, '', location.pathname + location.search);
      showView();
    } else {
      render();
    }
  } catch (error) {
    toast(errorMessage(error), 4000);
    render();
  }
}

async function undoReply(reply) {
  try {
    await callApi('deleteReply', { replyId: reply.id, author: myName() });
    toast('返事を取り消しました');
    await refresh({ quiet: true });
  } catch (error) {
    toast(errorMessage(error), 4000);
    render();
  }
}

async function changeStatus(item, status, select) {
  select.disabled = true;
  try {
    await callApi('setStatus', { itemId: item.id, status, author: myName() });
    toast(`「${status}」にしました`);
    await refresh({ quiet: true });
  } catch (error) {
    select.value = item.status;
    toast(errorMessage(error), 4000);
  } finally {
    select.disabled = false;
  }
}

// ===== 音声入力 =====
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const dictation = {
  recognition: null,
  target: null,      // 書き込む入力欄
  want: false,       // 利用者が録音を続けたいかどうか
  running: false,    // 音声認識が実際に動いているかどうか
  before: '',        // カーソルより前の文字
  after: '',         // カーソルより後の文字
  final: '',         // 今回の認識で確定した文字
  timer: null,
};

function micHint(target) {
  return document.querySelector(`[data-mic-hint-for="${target.id}"]`);
}

function setupDictation() {
  const buttons = document.querySelectorAll('[data-mic-for]');
  if (!SpeechRecognition) {
    // 音声入力に対応していないブラウザでは手入力だけにする
    buttons.forEach((button) => (button.hidden = true));
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  // Android の Chrome は continuous=true だと文字が重複するため、1回ずつ認識して自動で再開する
  recognition.continuous = false;

  recognition.onresult = (event) => {
    let interim = '';
    dictation.final = '';
    for (let i = 0; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) dictation.final += transcript;
      else interim += transcript;
    }
    dictation.target.value = dictation.before + dictation.final + interim + dictation.after;
    resetSilenceTimer();
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stopDictation('マイクが許可されていません。ブラウザの設定でマイクを許可するか、文字で書いてください。');
    } else if (event.error === 'network') {
      stopDictation('通信できないため音声入力が使えません。文字で書いてください。');
    }
    // no-speech（無音）などは onend で再開するので何もしない
  };

  recognition.onend = () => {
    dictation.running = false;
    // 確定した文字を「カーソルより前」に取り込んでから次の認識へ
    dictation.before += dictation.final;
    dictation.final = '';
    if (dictation.want) startRecognition();
    else updateMicButtons();
  };

  dictation.recognition = recognition;

  buttons.forEach((button) => {
    const target = $(button.dataset.micFor);
    button.addEventListener('click', () => {
      if (dictation.want && dictation.target === target) stopDictation();
      else startDictation(target);
    });
    // キーボードで書きはじめたら、手入力を優先して録音を止める
    target.addEventListener('input', () => {
      if (dictation.want && dictation.target === target) stopDictation();
    });
  });
}

function startDictation(target) {
  // カーソル位置に話した内容を差し込む
  const value = target.value;
  const pos = document.activeElement === target ? target.selectionEnd : value.length;
  dictation.target = target;
  dictation.before = value.slice(0, pos);
  dictation.after = value.slice(pos);
  dictation.final = '';
  dictation.want = true;
  resetSilenceTimer();
  if (dictation.running) dictation.recognition.abort(); // onend で新しい入力欄に切り替えて再開する
  else startRecognition();
  updateMicButtons();
}

function startRecognition() {
  try {
    dictation.recognition.start();
    dictation.running = true;
  } catch {
    // すでに動いている場合などは無視する
  }
}

function stopDictation(message) {
  dictation.want = false;
  clearTimeout(dictation.timer);
  if (dictation.running) dictation.recognition.stop();
  updateMicButtons(message);
}

function resetSilenceTimer() {
  clearTimeout(dictation.timer);
  dictation.timer = setTimeout(() => stopDictation('声が聞こえなかったので止めました。もう一度🎤を押すと続きを話せます。'), SILENCE_TIMEOUT);
}

function updateMicButtons(message) {
  document.querySelectorAll('[data-mic-for]').forEach((button) => {
    const target = $(button.dataset.micFor);
    const active = dictation.want && dictation.target === target;
    button.classList.toggle('is-listening', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? '録音を止める' : '声で入力する');
    const hint = micHint(target);
    if (active) hint.textContent = '聞いています…終わったら🎤をもう一度押す';
    else if (message && dictation.target === target) hint.textContent = message;
    else hint.textContent = '';
  });
}

// ===== はじめに（名前と合言葉） =====
function openSetup(error = '') {
  $('setup-name').value = myName();
  $('setup-pass').value = getSetting(PASS_KEY) || '';
  $('setup-error').textContent = error;
  // すでに使っている人だけ「やめる」を出す
  $('setup-cancel').hidden = !(myName() && getSetting(PASS_KEY));
  if (!setupDialog.open) setupDialog.showModal();
}

async function submitSetup() {
  const name = $('setup-name').value.trim();
  const passphrase = $('setup-pass').value.trim();
  if (!name || !passphrase) {
    $('setup-error').textContent = '名前と合言葉を入れてください。';
    return;
  }
  const button = $('setup-submit');
  button.disabled = true;
  $('setup-error').textContent = 'たしかめています…';
  try {
    // 合言葉が正しいかを、読み込みで確かめてから保存する
    await callApi('list', {}, passphrase);
    setSetting(NAME_KEY, name);
    setSetting(PASS_KEY, passphrase);
    setupDialog.close();
    await refresh();
  } catch (error) {
    $('setup-error').textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

// ===== アプリの登録 =====
function openAppForm(name = '') {
  const app = findApp(name);
  $('app-name').value = name;
  $('app-url').value = app ? app.url : '';
  $('app-dialog-title').textContent = name ? 'アプリのURLを登録' : 'アプリを登録';
  $('app-dialog').showModal();
  (name ? $('app-url') : $('app-name')).focus();
}

// http/https のアドレスだけを受け付ける（空ならURLなし、形がおかしければ null）
function cleanUrl(value) {
  let url = value.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

async function submitApp() {
  if (sending) return;
  const name = $('app-name').value.trim();
  const url = cleanUrl($('app-url').value);
  if (!name) {
    toast('アプリ名を入れてください');
    return;
  }
  if (url === null) {
    toast('URLの形が正しくありません。https:// から始まるアドレスを入れてください', 4000);
    return;
  }
  const button = $('app-submit');
  setBusy(button, true, '登録しています…');
  try {
    const data = await callApi('saveApp', { name, url, author: myName() });
    if (!data.app) throw new ApiError('old_script');
    state.apps = [...state.apps.filter((app) => app.name !== name), data.app];
    state.appFilter = name;
    $('app-dialog').close();
    toast(`「${name}」を登録しました`);
    render();
  } catch (error) {
    toast(errorMessage(error), 4000);
  } finally {
    setBusy(button, false, '登録する');
  }
}

// ===== 要望を書くフォーム =====
function openForm() {
  // アドレスの ?app= か、前回書いたアプリを最初から入れておく
  const fromUrl = new URLSearchParams(location.search).get('app');
  const current = state.appFilter !== 'all' ? state.appFilter : '';
  $('item-app').value = '';
  renderAppOptions(current || fromUrl || getSetting(LAST_APP_KEY) || '');
  formDialog.showModal();
  ($('item-app-new').hidden ? $('item-body') : $('item-app')).focus();
}

// ===== イベント登録 =====
function setupEvents() {
  $('open-form').addEventListener('click', openForm);
  $('item-app-select').addEventListener('change', () => {
    toggleNewAppField();
    if (!$('item-app-new').hidden) $('item-app').focus();
  });
  $('open-app-form').addEventListener('click', () => openAppForm());
  $('app-cancel').addEventListener('click', () => $('app-dialog').close());
  $('app-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitApp();
  });
  $('form-cancel').addEventListener('click', () => {
    if (dictation.want) stopDictation();
    formDialog.close();
  });
  $('item-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitItem();
  });
  $('reply-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitReply();
  });
  // Ctrl + Enter でも返事を送れる
  $('reply-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitReply();
    }
  });

  [['item', 'item-file', 'item-body'], ['reply', 'reply-file', 'reply-text']].forEach(([kind, fileId, textId]) => {
    $(fileId).addEventListener('change', (event) => {
      addPendingImages(kind, event.target.files);
      event.target.value = '';
    });
    $(textId).addEventListener('paste', (event) => takePastedImages(event, kind));
  });

  $('back-button').addEventListener('click', () => {
    location.hash = '';
  });
  window.addEventListener('hashchange', showView);

  $('lightbox').addEventListener('click', () => {
    $('lightbox').hidden = true;
  });

  $('name-button').addEventListener('click', () => openSetup());
  $('setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitSetup();
  });
  $('setup-cancel').addEventListener('click', () => setupDialog.close());
  // 名前と合言葉が決まるまでは Esc で閉じられないようにする
  setupDialog.addEventListener('cancel', (event) => {
    if (!(myName() && getSetting(PASS_KEY))) event.preventDefault();
  });

  $('reload-button').addEventListener('click', async () => {
    await refresh({ quiet: true });
    toast('最新の内容にしました');
  });

  // 画面に戻ってきたときと、開いているあいだは定期的に読み込み直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh({ quiet: true });
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !formDialog.open && !sending) refresh({ quiet: true });
  }, REFRESH_INTERVAL);
}

// ===== 起動 =====
function init() {
  setupDictation();
  setupEvents();
  // ?app=VoiceFix のように開かれたら、そのアプリで絞り込んでおく
  const fromUrl = new URLSearchParams(location.search).get('app');
  if (fromUrl) state.appFilter = fromUrl;
  showView();

  if (!ENDPOINT_URL) {
    showBanner(errorMessage(new ApiError('no_endpoint')));
  } else if (!myName() || !getSetting(PASS_KEY)) {
    openSetup();
  } else {
    refresh();
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

init();
