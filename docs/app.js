/* SubTutor 웹앱: 저장한 자막 목록 · 코멘트 · 녹음 · 받아쓰기 퀴즈 */
(() => {
  'use strict';
  const S = window.SubTutorSubs;
  const B = window.SubTutorBridge;
  const R = window.SubTutorRecorder;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const PLATFORM_NAMES = { netflix: '넷플릭스', prime: '프라임 비디오', disney: '디즈니+', youtube: '유튜브' };
  const README_URL = 'https://github.com/bluemuple/subtutor#readme';

  const state = {
    items: [], extOk: false, view: 'list',
    filterTitle: '', search: '', sort: 'recent',
    clip: { itemId: null, state: null, message: '' },
    recordings: new Map(), recording: null, playingRec: null,
    quiz: null, quizPrefs: { title: '', order: 'oldest', autoplay: true },
  };
  const clipWaiters = [];
  let renderPending = false;

  // ───────── 유틸 ─────────
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (k === 'disabled') n.disabled = !!v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (children != null) for (const c of [].concat(children)) if (c != null && c !== false) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  const isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const learning = () => state.items.filter((i) => (i.box || 'learning') === 'learning');
  const known = () => state.items.filter((i) => i.box === 'known');
  const fmtDate = (ms) => { const d = new Date(ms); return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0'); };
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

  // ───────── 데이터 ─────────
  // 화면에 영향을 주는 필드만으로 서명을 만들어, 실제로 바뀐 경우에만 다시 그린다 (입력 중인 내용 보호)
  const itemsSignature = (items) => items.map((i) => [i.id, i.box, i.comment, i.translation, i.reviews, i.forgot, i.savedAt, i.audio ? 1 : 0].join('\u0001')).sort().join('\u0002');
  async function loadItems(force) {
    if (!state.extOk) { render(); return; }
    let changed = !!force;
    try {
      const r = await B.request('items.list');
      const items = (r && r.items) || [];
      if (itemsSignature(items) !== itemsSignature(state.items)) changed = true;
      state.items = items;
    } catch (e) { toast(e.message); }
    updateCounts();
    if (changed) render();
  }
  function updateCounts() {
    $('#count-list').textContent = learning().length;
    $('#count-known').textContent = known().length;
  }
  async function updateItem(id, patch) {
    const it = state.items.find((i) => i.id === id);
    if (it) Object.assign(it, patch);
    updateCounts();
    try { await B.request('items.update', { id, patch }); } catch (e) { toast('저장 실패: ' + e.message); }
  }
  async function removeItem(id) {
    state.items = state.items.filter((i) => i.id !== id);
    updateCounts();
    render();
    try { await B.request('items.remove', { id }); } catch (e) { toast(e.message); }
    try { await R.clearItem(id); state.recordings.delete(id); } catch (e) { /* ignore */ }
  }

  // ───────── 플레이어 원격 재생 ─────────
  function setClip(itemId, st, message) {
    state.clip = { itemId, state: st, message: message || '' };
    renderClipStates();
    if (st === 'ended' || st === 'error' || st === 'stopped') {
      clipWaiters.splice(0).forEach((w) => w.resolve({ itemId, state: st }));
    }
  }
  const STATE_TEXT = { opening: '플레이어 준비 중…', playing: '재생 중', ended: '', stopped: '', error: '' };
  function renderClipStates() {
    document.querySelectorAll('[data-clip-item]').forEach((node) => {
      const id = node.dataset.clipItem;
      const mine = state.clip.itemId === id;
      const st = mine ? state.clip.state : null;
      node.classList.toggle('playing', mine && (st === 'opening' || st === 'playing'));
      const btn = node.querySelector('.play');
      if (btn) {
        btn.classList.toggle('busy', mine && st === 'opening');
        btn.classList.toggle('active', mine && st === 'playing');
        const icon = mine && st === 'opening' ? '…' : (mine && st === 'playing' ? '◼' : '▶');
        btn.textContent = btn.dataset.label ? icon + ' ' + btn.dataset.label : icon;
        btn.title = mine && st === 'playing' ? '정지' : '플레이어에서 이 대사 재생';
      }
      const se = node.querySelector('.state');
      if (se) {
        se.textContent = mine ? (st === 'error' ? '재생 실패: ' + (state.clip.message || '') : (STATE_TEXT[st] || '')) : '';
        se.classList.toggle('err', mine && st === 'error');
      }
    });
  }
  const audioCache = new Map(); // itemId -> Blob
  async function localAudioBlob(itemId) {
    if (audioCache.has(itemId)) return audioCache.get(itemId);
    try {
      const r = await B.request('audio.get', { itemId }, 20000);
      const b64 = r && (r.data || r.wav);
      if (b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: (r && r.mime) || 'audio/wav' });
        audioCache.set(itemId, blob);
        return blob;
      }
    } catch (e) { /* 원격 재생으로 */ }
    audioCache.set(itemId, null);
    return null;
  }
  let localAudio = null;
  function stopLocalAudio() { if (localAudio) { try { localAudio.pause(); } catch (e) { /* ignore */ } localAudio = null; } }
  async function playItem(itemId) {
    if (!state.extOk) { toast('확장 프로그램이 필요합니다'); return; }
    R.stop();
    if (state.clip.itemId === itemId && state.clip.state === 'playing') {
      stopLocalAudio();
      await B.request('clip.stop').catch(() => {});
      setClip(itemId, 'stopped');
      return;
    }
    stopLocalAudio();
    const it = state.items.find((i) => i.id === itemId);
    if (it && it.audio) {
      const blob = await localAudioBlob(itemId);
      if (blob) {
        setClip(itemId, 'playing');
        await new Promise((resolve) => {
          const url = URL.createObjectURL(blob);
          const a = new Audio(url);
          localAudio = a;
          const done = () => { URL.revokeObjectURL(url); if (localAudio === a) localAudio = null; resolve(); };
          a.onended = done; a.onerror = done;
          a.onpause = () => { if (!a.ended && localAudio !== a) done(); };
          a.play().catch(done);
        });
        if (state.clip.itemId === itemId && state.clip.state === 'playing') setClip(itemId, 'ended');
        return;
      }
    }
    setClip(itemId, 'opening');
    try {
      const r = await B.request('clip.play', { itemId }, 90000);
      if (r && r.error && state.clip.itemId === itemId && state.clip.state === 'opening') setClip(itemId, 'error', r.error === 'not-ready' ? '플레이어가 준비되지 않았습니다' : String(r.error));
    } catch (e) {
      setClip(itemId, 'error', e.message);
    }
  }
  function waitClipEnd() { return new Promise((resolve) => clipWaiters.push({ resolve })); }
  async function playTogether(itemId) {
    const recs = await getRecs(itemId);
    if (!recs.length) { toast('먼저 녹음을 해 주세요'); return; }
    const p = waitClipEnd();
    await playItem(itemId);
    const r = await p;
    if (r.itemId === itemId && r.state === 'ended') await playRecording(itemId, recs[recs.length - 1]);
  }
  B.on('clip.state', (p) => {
    if (!p || !p.itemId) return;
    setClip(p.itemId, p.state, p.message);
    if (p.state === 'error') toast('재생 실패: ' + (p.message || ''));
  });

  // ───────── 녹음 ─────────
  async function getRecs(itemId) {
    if (!state.recordings.has(itemId)) {
      try { state.recordings.set(itemId, await R.list(itemId)); } catch (e) { state.recordings.set(itemId, []); }
    }
    return state.recordings.get(itemId);
  }
  async function toggleRecord(itemId) {
    if (state.recording && state.recording.itemId === itemId) {
      const rec = state.recording;
      state.recording = null;
      clearInterval(rec.timer);
      try {
        const { blob, durationMs } = await rec.ctrl.stop();
        if (durationMs < 300) toast('녹음이 너무 짧습니다');
        else {
          const list = await R.add(itemId, blob, durationMs);
          state.recordings.set(itemId, list);
          toast('녹음 저장 ' + list.length + '/' + R.MAX + (list.length === R.MAX ? ' (다음 녹음부터 가장 오래된 것이 지워집니다)' : ''));
        }
      } catch (e) { toast('녹음 실패: ' + e.message); }
      renderRecRows();
      return;
    }
    if (state.recording) await toggleRecord(state.recording.itemId);
    try {
      R.stop();
      const ctrl = await R.start();
      state.recording = { itemId, ctrl, startedAt: Date.now(), timer: setInterval(renderRecRows, 250) };
      renderRecRows();
    } catch (e) {
      toast('마이크를 사용할 수 없습니다: ' + e.message);
    }
  }
  async function playRecording(itemId, rec) {
    state.playingRec = rec.id;
    renderRecRows();
    await R.play(rec.blob);
    if (state.playingRec === rec.id) state.playingRec = null;
    renderRecRows();
  }
  function buildRecRow(itemId) {
    const node = el('div', { class: 'rec-row', 'data-rec-item': itemId });
    fillRecRow(node);
    return node;
  }
  function fillRecRow(node) {
    const itemId = node.dataset.recItem;
    const recs = state.recordings.get(itemId);
    if (!recs) { getRecs(itemId).then(() => fillRecRow(node)); }
    node.textContent = '';
    const isRec = state.recording && state.recording.itemId === itemId;
    const secs = isRec ? Math.floor((Date.now() - state.recording.startedAt) / 1000) : 0;
    node.append(el('button', { class: 'rec-btn' + (isRec ? ' recording' : ''), title: '내 목소리 녹음 (자막당 최대 3개)', onclick: () => toggleRecord(itemId) }, isRec ? '■ 정지 ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') : '🎙 녹음'));
    (recs || []).forEach((r, k) => {
      const b = el('button', { class: 'attempt' + (k === recs.length - 1 ? ' latest' : '') + (state.playingRec === r.id ? ' playing' : ''), title: '녹음 ' + (k + 1) + ' 재생 (' + fmtDate(r.createdAt) + ', ' + Math.round(r.durationMs / 100) / 10 + '초)', onclick: () => playRecording(itemId, r) }, String(k + 1));
      b.append(el('span', { class: 'x', title: '이 녹음 삭제', onclick: async (e) => { e.stopPropagation(); await R.remove(r.id); state.recordings.set(itemId, await R.list(itemId)); renderRecRows(); } }, '×'));
      node.append(b);
    });
    if (recs && recs.length) node.append(el('button', { class: 'rec-btn', title: '플레이어 오디오를 들은 뒤 최근 녹음을 이어서 재생', onclick: () => playTogether(itemId) }, '🔊 같이 듣기'));
    else node.append(el('span', { class: 'rec-hint' }, '녹음 후 "같이 듣기"로 원음과 비교해 보세요'));
  }
  function renderRecRows() { document.querySelectorAll('[data-rec-item]').forEach(fillRecRow); }

  // ───────── 라우팅/렌더 ─────────
  function route() {
    const m = /^#\/(\w+)/.exec(location.hash);
    state.view = m && ['list', 'quiz', 'known', 'settings'].includes(m[1]) ? m[1] : 'list';
    render();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('focusout', () => { if (renderPending) setTimeout(() => { if (renderPending && !(document.activeElement && document.activeElement.classList.contains('comment'))) render(); }, 50); });

  function render() {
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('comment')) { renderPending = true; return; }
    renderPending = false;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
    const app = $('#app');
    app.textContent = '';
    const titles = { list: '저장한 자막', quiz: '퀴즈', known: '알고 있는 표현', settings: '설정' };
    document.title = 'SubTutor · ' + titles[state.view];
    switch (state.view) {
      case 'list': app.append(renderList(learning(), 'learning')); break;
      case 'known': app.append(renderList(known(), 'known')); break;
      case 'quiz': app.append(renderQuiz()); break;
      case 'settings': app.append(renderSettings()); break;
      default: break;
    }
    renderClipStates();
  }
  function renderExtStatus() {
    const pill = $('#ext-status');
    const banner = $('#banner');
    if (state.extOk) {
      pill.textContent = '확장 프로그램 연결됨 v' + (B.version || '');
      pill.className = 'ext-status ok';
      banner.classList.add('hidden');
    } else {
      pill.textContent = '확장 프로그램 없음';
      pill.className = 'ext-status bad';
      banner.textContent = '';
      banner.append('SubTutor 크롬 확장 프로그램이 감지되지 않았습니다. 저장한 자막은 확장 프로그램 안에 보관되므로, 이 사이트는 확장 프로그램이 설치된 크롬에서만 동작합니다. 설치한 뒤 이 페이지를 새로고침하세요. ', el('a', { href: README_URL, target: '_blank', rel: 'noopener' }, '설치 방법 보기'));
      banner.classList.remove('hidden');
    }
  }

  // ───────── 목록 ─────────
  function renderList(items, kind) {
    const wrap = el('div');
    const titles = Array.from(new Set(items.map((i) => i.title))).sort((a, b) => a.localeCompare(b, 'ko'));
    if (state.filterTitle && !titles.includes(state.filterTitle)) state.filterTitle = '';
    const body = el('div', { class: 'list-body' });
    const countEl = el('span', { class: 'count' });
    const renderBody = () => {
      body.textContent = '';
      const q = S.normalizeForCompare(state.search);
      const filtered = items.filter((i) => (!state.filterTitle || i.title === state.filterTitle) && (!q || S.normalizeForCompare(i.text + ' ' + (i.comment || '')).includes(q) || (i.translation || '').includes(state.search.trim())));
      countEl.textContent = filtered.length + '개';
      if (!filtered.length) {
        body.append(el('div', { class: 'empty' }, items.length ? '검색 결과가 없습니다.' : (kind === 'learning'
          ? [el('b', null, '아직 저장한 자막이 없습니다.'), el('br'), '넷플릭스에서 영상을 재생하고 자막 옆의 ', el('b', null, '☆'), ' 를 누르거나 ', el('kbd', null, 'E'), ' 키를 누르면 여기에 모입니다.']
          : [el('b', null, '아직 "알고 있어"로 옮긴 표현이 없습니다.'), el('br'), '퀴즈에서 ', el('kbd', null, 'C'), ' 를 누르면 이 상자로 이동합니다.'])));
        return;
      }
      const groups = new Map();
      for (const it of filtered) {
        const key = it.title + '\u0000' + (it.episode || '');
        if (!groups.has(key)) groups.set(key, { title: it.title, episode: it.episode || '', items: [], latest: 0 });
        const g = groups.get(key);
        g.items.push(it);
        g.latest = Math.max(g.latest, it.savedAt || 0);
      }
      const list = Array.from(groups.values());
      if (state.sort === 'recent') list.sort((a, b) => b.latest - a.latest);
      else list.sort((a, b) => a.title.localeCompare(b.title, 'ko') || a.episode.localeCompare(b.episode, 'ko', { numeric: true }));
      for (const g of list) {
        g.items.sort((a, b) => a.startMs - b.startMs);
        const gEl = el('div', { class: 'group' }, [
          el('h3', { class: 'group-title' }, [g.title, g.episode ? el('small', null, g.episode) : null, el('small', null, g.items.length + '개')]),
        ]);
        g.items.forEach((it) => gEl.append(itemEl(it, kind)));
        body.append(gEl);
      }
    };
    const sel = el('select', { onchange: (e) => { state.filterTitle = e.target.value; renderBody(); } }, [el('option', { value: '' }, '모든 작품')].concat(titles.map((t) => el('option', { value: t, selected: t === state.filterTitle }, t))));
    const search = el('input', { type: 'search', placeholder: '자막 · 번역 · 코멘트 검색', value: state.search, oninput: debounce((e) => { state.search = e.target.value; renderBody(); }, 150) });
    const sort = el('select', { onchange: (e) => { state.sort = e.target.value; renderBody(); } }, [el('option', { value: 'recent', selected: state.sort === 'recent' }, '최근 저장한 작품부터'), el('option', { value: 'title', selected: state.sort === 'title' }, '작품 이름순')]);
    wrap.append(el('div', { class: 'toolbar' }, [sel, search, sort, countEl]), body);
    renderBody();
    return wrap;
  }
  function itemEl(it, kind) {
    const node = el('div', { class: 'item' + (kind === 'known' ? ' known' : ''), 'data-clip-item': it.id, 'data-id': it.id });
    const play = el('button', { class: 'play', title: '플레이어에서 이 대사 재생', onclick: () => playItem(it.id) }, '▶');
    const body = el('div', { class: 'body' }, [
      el('div', { class: 'en', text: it.text }),
      el('div', { class: 'ko', text: it.translation || '' }),
      el('div', { class: 'meta' }, [
        el('span', null, S.formatTime(it.startMs) + ' – ' + S.formatTime(it.endMs)),
        el('span', null, PLATFORM_NAMES[it.platform] || it.platform),
        it.audio ? el('span', { class: 'has-audio', title: '확장 프로그램에 보관된 오디오로 바로 재생합니다' }, '🔊 오디오 보관') : null,
        el('span', null, '저장 ' + fmtDate(it.savedAt || Date.now())),
        it.reviews ? el('span', null, '복습 ' + it.reviews + '회' + (it.forgot ? ' · 잊음 ' + it.forgot : '')) : null,
        el('button', { class: 'link', onclick: () => B.request('item.open', { itemId: it.id }, 60000).catch((e) => toast(e.message)) }, '플레이어에서 열기 ↗'),
        el('span', { class: 'state' }),
      ]),
      buildRecRow(it.id),
    ]);
    const comment = el('textarea', { class: 'comment', placeholder: '코멘트 (뜻, 메모, 예문…)' });
    comment.value = it.comment || '';
    let timer;
    const save = () => { const v = comment.value; if (v === (it.comment || '')) return; updateItem(it.id, { comment: v }); };
    comment.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 900); });
    comment.addEventListener('blur', () => { clearTimeout(timer); save(); });
    const actions = el('div', { class: 'actions' }, [
      kind === 'learning'
        ? el('button', { class: 'btn good', onclick: () => { updateItem(it.id, { box: 'known', knownAt: Date.now() }); render(); toast('알고 있는 표현으로 이동했습니다'); } }, '✓ 알고 있어')
        : el('button', { class: 'btn', onclick: () => { updateItem(it.id, { box: 'learning' }); render(); toast('다시 학습 목록으로'); } }, '↩ 다시 학습'),
      el('button', { class: 'btn danger', onclick: () => { if (confirm('이 자막과 녹음을 삭제할까요?')) removeItem(it.id); } }, '삭제'),
    ]);
    node.append(play, body, el('div', { class: 'side' }, [comment, actions]));
    return node;
  }

  // ───────── 퀴즈 ─────────
  function renderQuiz() {
    const wrap = el('div', { class: 'quiz-wrap' });
    const q = state.quiz;
    if (!q) { wrap.append(quizSetup()); return wrap; }
    while (q.pos < q.queue.length && !state.items.find((i) => i.id === q.queue[q.pos])) q.pos++;
    if (q.pos >= q.queue.length) { wrap.append(quizSummary()); return wrap; }
    wrap.append(quizCard());
    return wrap;
  }
  function quizSetup() {
    const pool = learning();
    const titles = Array.from(new Set(pool.map((i) => i.title))).sort((a, b) => a.localeCompare(b, 'ko'));
    const box = el('div', { class: 'quiz-setup' }, [
      el('h2', null, '받아쓰기 퀴즈'),
      el('p', null, '플레이어에서 대사 오디오만 듣고 영어로 받아쓴 뒤 확인합니다. 잊어버린 카드는 다시 나오고, 알고 있는 카드는 "알고 있는 표현" 상자로 이동합니다.'),
      el('div', { class: 'row' }, [
        el('label', null, '작품 '),
        el('select', { onchange: (e) => { state.quizPrefs.title = e.target.value; } }, [el('option', { value: '' }, '모든 작품 (' + pool.length + ')')].concat(titles.map((t) => el('option', { value: t, selected: t === state.quizPrefs.title }, t + ' (' + pool.filter((i) => i.title === t).length + ')')))),
        el('label', null, '순서 '),
        el('select', { onchange: (e) => { state.quizPrefs.order = e.target.value; } }, [el('option', { value: 'oldest', selected: state.quizPrefs.order === 'oldest' }, '오래 안 본 것부터'), el('option', { value: 'random', selected: state.quizPrefs.order === 'random' }, '무작위'), el('option', { value: 'saved', selected: state.quizPrefs.order === 'saved' }, '저장한 순서')]),
        el('label', null, [el('input', { type: 'checkbox', checked: state.quizPrefs.autoplay, onchange: (e) => { state.quizPrefs.autoplay = e.target.checked; } }), ' 카드가 나오면 자동 재생']),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary big', disabled: !pool.length || !state.extOk, onclick: startQuiz }, '퀴즈 시작'),
        el('span', { class: 'count' }, !state.extOk ? '확장 프로그램이 연결되어야 오디오를 들을 수 있습니다' : (pool.length ? '학습 중 ' + pool.length + '개 · 알고 있음 ' + known().length + '개' : '먼저 자막을 저장해 주세요')),
      ]),
      el('p', null, [el('kbd', null, 'Space'), ' 듣기 · ', el('kbd', null, 'Enter'), ' 확인 · ', el('kbd', null, 'Z'), ' 잊어버렸어 · ', el('kbd', null, 'C'), ' 알고 있어 · ', el('kbd', null, 'R'), ' 녹음']),
    ]);
    return box;
  }
  function startQuiz() {
    let pool = learning().filter((i) => !state.quizPrefs.title || i.title === state.quizPrefs.title);
    if (state.quizPrefs.order === 'random') pool = shuffle(pool.slice());
    else if (state.quizPrefs.order === 'saved') pool = pool.slice().sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    else pool = pool.slice().sort((a, b) => (a.lastReviewedAt || 0) - (b.lastReviewedAt || 0) || (a.savedAt || 0) - (b.savedAt || 0));
    state.quiz = { queue: pool.map((i) => i.id), pos: 0, phase: 'listen', input: '', result: null, hint: false, revealed: false, stats: { know: 0, forgot: 0 }, requeued: {}, autoplayedFor: null };
    render();
  }
  const currentQuizItem = () => { const q = state.quiz; return q ? state.items.find((i) => i.id === q.queue[q.pos]) : null; };
  function quizCard() {
    const q = state.quiz;
    const it = currentQuizItem();
    const total = q.queue.length;
    const card = el('div', { class: 'quiz-card', 'data-clip-item': it.id });
    card.append(
      el('div', { class: 'quiz-top' }, [el('span', null, it.title + (it.episode ? ' · ' + it.episode : '')), el('span', null, (q.pos + 1) + ' / ' + total + '  ·  알고 있어 ' + q.stats.know + ' · 잊어버렸어 ' + q.stats.forgot)]),
      el('div', { class: 'progress' }, el('div', { style: 'width:' + Math.round((q.pos / total) * 100) + '%' })),
      el('div', { class: 'quiz-audio' }, [
        el('button', { class: 'btn primary big play', 'data-label': '듣기', onclick: () => playItem(it.id) }, '▶ 듣기'),
        el('span', { class: 'count' }, 'Space'),
        el('button', { class: 'btn', onclick: () => { q.hint = !q.hint; render(); } }, q.hint ? '힌트 숨기기' : '힌트: 한국어 뜻'),
        el('span', { class: 'clip-state state' }),
      ]),
    );
    if (q.hint) card.append(el('div', { class: 'quiz-hint' }, el('div', { class: 'ko', text: it.translation || '(번역 없음)' })));
    if (q.phase === 'listen') {
      const ta = el('textarea', { class: 'dictation', placeholder: '들리는 대로 영어로 입력하세요.  Enter: 확인 · Shift+Enter: 줄바꿈 · Cmd/Ctrl+Enter: 다시 듣기' });
      ta.value = q.input;
      ta.addEventListener('input', () => { q.input = ta.value; });
      card.append(ta, el('div', { class: 'quiz-actions' }, [
        el('button', { class: 'btn primary', onclick: checkAnswer }, '확인 (Enter)'),
        el('button', { class: 'btn', onclick: revealAnswer }, '모르겠어요 → 정답 보기'),
        el('button', { class: 'btn', onclick: skipCard }, '건너뛰기'),
      ]));
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    } else {
      const d = q.result;
      const diff = el('div', { class: 'diff' });
      d.ops.forEach((op, k) => { diff.append(el('span', { class: op.type }, op.word)); if (k < d.ops.length - 1) diff.append(' '); });
      const res = el('div', { class: 'quiz-result' }, [
        q.revealed ? el('div', { class: 'score' }, '정답을 확인했습니다') : diff,
        q.revealed ? null : el('div', { class: 'score' }, d.perfect ? [el('b', null, '완벽해요! 🎉'), ' 모든 단어를 맞혔습니다'] : [el('b', null, '정확도 ' + d.accuracy + '%'), ' · ' + d.equal + '/' + d.total + ' 단어 · 빨간색: 놓친 단어, 취소선: 추가로 쓴 단어']),
        el('div', { class: 'answer en', text: it.text }),
        el('div', { class: 'ko', text: it.translation || '' }),
        buildRecRow(it.id),
        el('div', { class: 'grade' }, [
          el('button', { class: 'btn forgot', onclick: () => grade('forgot') }, 'Z  잊어버렸어 — 다음에 또 나옴'),
          el('button', { class: 'btn know', onclick: () => grade('know') }, 'C  알고 있어 — 알고 있는 표현으로'),
        ]),
      ]);
      card.append(res);
    }
    if (q.autoplayedFor !== it.id) { q.autoplayedFor = it.id; if (state.quizPrefs.autoplay && state.extOk) setTimeout(() => playItem(it.id), 50); }
    return card;
  }
  function checkAnswer() {
    const q = state.quiz; const it = currentQuizItem();
    if (!q || !it || q.phase !== 'listen') return;
    if (!S.normalizeForCompare(q.input)) { toast('먼저 들은 내용을 입력하세요 (모르면 "정답 보기")'); return; }
    q.result = S.diffWords(it.text, q.input); q.phase = 'graded'; q.revealed = false;
    render();
  }
  function revealAnswer() {
    const q = state.quiz; const it = currentQuizItem();
    if (!q || !it) return;
    q.result = S.diffWords(it.text, q.input); q.phase = 'graded'; q.revealed = true;
    render();
  }
  function skipCard() {
    const q = state.quiz;
    q.queue.push(q.queue[q.pos]);
    q.pos++; q.phase = 'listen'; q.input = ''; q.result = null; q.hint = false;
    render();
  }
  function grade(kind) {
    const q = state.quiz; const it = currentQuizItem();
    if (!q || !it || q.phase !== 'graded') return;
    const patch = { reviews: (it.reviews || 0) + 1, lastReviewedAt: Date.now(), lastResult: kind };
    if (kind === 'forgot') {
      patch.forgot = (it.forgot || 0) + 1;
      q.stats.forgot++;
      const n = q.requeued[it.id] || 0;
      if (n < 2) { q.requeued[it.id] = n + 1; q.queue.splice(Math.min(q.queue.length, q.pos + 4), 0, it.id); }
    } else {
      patch.box = 'known'; patch.knownAt = Date.now();
      q.stats.know++;
    }
    updateItem(it.id, patch);
    q.pos++; q.phase = 'listen'; q.input = ''; q.result = null; q.hint = false;
    render();
  }
  function quizSummary() {
    const q = state.quiz;
    return el('div', { class: 'quiz-card summary' }, [
      el('h2', null, '오늘 퀴즈 끝!'),
      el('div', { class: 'nums' }, [el('div', null, [el('b', null, String(q.stats.know)), '알고 있어']), el('div', null, [el('b', null, String(q.stats.forgot)), '잊어버렸어'])]),
      el('p', { class: 'count' }, '잊어버린 카드는 학습 목록에 남아 다음 퀴즈에 다시 나옵니다.'),
      el('div', { class: 'row', style: 'display:flex;gap:10px;justify-content:center' }, [
        el('button', { class: 'btn primary big', onclick: () => { state.quiz = null; render(); } }, '다시 시작'),
        el('button', { class: 'btn big', onclick: () => { state.quiz = null; location.hash = '#/list'; } }, '목록으로'),
      ]),
    ]);
  }
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'quiz' || !state.quiz) return;
    const q = state.quiz;
    const it = currentQuizItem();
    if (!it) return;
    const inDictation = e.target && e.target.classList && e.target.classList.contains('dictation');
    if (inDictation) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); playItem(it.id); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); checkAnswer(); }
      else if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
    if (e.code === 'Space') { e.preventDefault(); playItem(it.id); }
    else if (e.code === 'Enter' && q.phase === 'listen') { e.preventDefault(); checkAnswer(); }
    else if (e.code === 'KeyZ' && q.phase === 'graded') grade('forgot');
    else if (e.code === 'KeyC' && q.phase === 'graded') grade('know');
    else if (e.code === 'KeyR') toggleRecord(it.id);
  });

  // ───────── 설정 ─────────
  function renderSettings() {
    const wrap = el('div', { class: 'settings' });
    const total = state.items.length;
    const reviews = state.items.reduce((a, i) => a + (i.reviews || 0), 0);
    const recCount = el('b', null, '…');
    R.listAll().then((all) => { recCount.textContent = String(all.length); }).catch(() => { recCount.textContent = '0'; });
    const fileInput = el('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const items = Array.isArray(data) ? data : data.items;
        const r = await B.request('items.import', { items });
        toast('가져오기 완료: 새 항목 ' + r.added + '개 (총 ' + r.total + '개)');
        loadItems();
      } catch (err) { toast('가져오기 실패: ' + err.message); }
      e.target.value = '';
    } });
    wrap.append(
      el('section', null, [
        el('h3', null, '확장 프로그램'),
        el('p', null, state.extOk ? '연결됨 · 버전 ' + (B.version || '') : '감지되지 않음'),
        el('p', null, ['저장한 자막·설정·보관한 대사 오디오는 크롬 확장 프로그램 안(chrome.storage)에, 내 목소리 녹음은 이 사이트의 브라우저 저장소(IndexedDB)에 보관됩니다. 확장 프로그램 ⚙ 에서 "별표 저장 시 오디오"를 켜면 대사 오디오를 보관하거나 PC에 WAV 파일로 내려받을 수 있고, 보관된 오디오가 있는 자막은 플레이어 탭 없이 바로 재생됩니다. 다른 컴퓨터로 옮기려면 아래에서 내보내기/가져오기를 사용하세요. ', el('a', { href: README_URL, target: '_blank', rel: 'noopener' }, '설치 방법·사용법 →')]),
      ]),
      el('section', null, [
        el('h3', null, '통계'),
        el('div', { class: 'stats' }, [
          el('div', null, [el('b', null, String(learning().length)), el('span', null, '학습 중')]),
          el('div', null, [el('b', null, String(known().length)), el('span', null, '알고 있는 표현')]),
          el('div', null, [el('b', null, String(total)), el('span', null, '전체')]),
          el('div', null, [el('b', null, String(reviews)), el('span', null, '총 복습 횟수')]),
          el('div', null, [recCount, el('span', null, '녹음 파일')]),
        ]),
      ]),
      el('section', null, [
        el('h3', null, '데이터'),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', disabled: !state.extOk, onclick: () => {
            const blob = new Blob([JSON.stringify({ app: 'SubTutor', exportedAt: new Date().toISOString(), items: state.items }, null, 2)], { type: 'application/json' });
            const a = el('a', { href: URL.createObjectURL(blob), download: 'subtutor-items-' + fmtDate(Date.now()).replace(/\./g, '') + '.json' });
            document.body.append(a); a.click(); a.remove();
          } }, '자막 내보내기 (JSON)'),
          el('button', { class: 'btn', disabled: !state.extOk, onclick: () => fileInput.click() }, '자막 가져오기'),
          fileInput,
          el('button', { class: 'btn danger', disabled: !state.extOk, onclick: async () => {
            if (!confirm('저장한 자막을 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
            await B.request('items.clear').catch((e) => toast(e.message));
            loadItems();
          } }, '자막 모두 삭제'),
          el('button', { class: 'btn danger', onclick: async () => {
            if (!confirm('녹음 파일을 모두 삭제할까요?')) return;
            await R.clearAll(); state.recordings.clear(); render(); toast('녹음을 모두 삭제했습니다');
          } }, '녹음 모두 삭제'),
        ]),
      ]),
      el('section', null, [
        el('h3', null, '플레이어 단축키'),
        el('p', null, [el('kbd', null, 'A'), ' 이전 자막 · ', el('kbd', null, 'S'), ' 현재 자막 무한 반복 · ', el('kbd', null, 'D'), ' 다음 자막 · ', el('kbd', null, 'F'), ' 다시 듣기 · ', el('kbd', null, 'E'), ' 별표 저장 · ', el('kbd', null, 'P'), ' 자동 일시정지(AP) · ', el('kbd', null, 'W'), ' 쉐도잉 · ', el('kbd', null, '`'), ' 패널']),
        el('p', null, 'AP: 자막이 끝나면 멈추고 F로 다시 듣기. 쉐도잉: 자막이 끝나면 설정한 시간(1~7초)만큼 쉬었다가 자동으로 다음 자막으로 이어집니다.'),
      ]),
    );
    return wrap;
  }

  // ───────── 시작 ─────────
  async function init() {
    route();
    await B.waitReady(2000);
    state.extOk = B.detect();
    renderExtStatus();
    B.on('ready', () => { if (!state.extOk) { state.extOk = true; renderExtStatus(); loadItems(); } });
    B.on('items.changed', () => loadItems());
    if (state.extOk) await loadItems(true); else render();
  }
  init();
})();
