/* SubTutor 웹앱: 저장한 자막 목록 · 코멘트 · 녹음 · 받아쓰기 퀴즈 */
(() => {
  'use strict';
  const S = window.SubTutorSubs;
  const B = window.SubTutorBridge;
  const R = window.SubTutorRecorder;
  const Ex = window.SubTutorExplain;
  const Sp = window.SubTutorSpeech;
  const St = window.SubTutorStretch;
  const KIWI = window.SubTutorKiwi || [];
  const NZV = window.SubTutorNZVowels;
  const F = window.SubTutorFluency;
  const DAY = 86400000;
  const WEB_DEFAULTS = { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true, dubRecRates: [0.5, 0.7, 1], fastRates: [1, 1.25, 1.5, 1] };
  // 사다리 단계 수를 바꿀 때 채워 넣는 기본값 (마지막은 1배속)
  const LADDER_PRESETS = { 1: [1], 2: [0.7, 1], 3: [0.7, 0.85, 1], 4: [0.8, 0.9, 1, 1.15], 5: [0.7, 0.8, 0.9, 1, 1.15], 6: [0.6, 0.7, 0.8, 0.9, 1, 1.15] };
  // 고속 적응 프리셋의 단계 수별 기본값 (반드시 1배로 끝난다 — 정상 속도가 느리게 들리게)
  const FAST_PRESETS = { 3: [1.25, 1.5, 1], 4: [1, 1.25, 1.5, 1], 5: [1, 1.15, 1.3, 1.5, 1], 6: [1, 1.15, 1.25, 1.4, 1.5, 1] };
  const RATE_MIN = 0.3, RATE_MAX = 2, LADDER_MAX_STEPS = 6;
  const fmtRate = (r) => String(Math.round(r * 100) / 100);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const PLATFORM_NAMES = { netflix: '넷플릭스', prime: '프라임 비디오', disney: '디즈니+', youtube: '유튜브', tvnz: 'TVNZ+', threenow: 'ThreeNow', nzonscreen: 'NZ On Screen', maoriplus: 'MĀORI+', ted: 'TED', vimeo: 'Vimeo' };
  // 사용자가 팝업에서 켠 사이트는 'site:<호스트>' → 호스트 이름
  const platformName = (p) => PLATFORM_NAMES[p] || String(p || '').replace(/^site:(www\.)?/, '');
  const README_URL = 'https://github.com/bluemuple/subtutor#readme';

  const state = {
    items: [], extOk: false, view: 'list',
    filterTitle: '', search: '', sort: loadPref('subtutor.sort', 'group-time'), filterTag: '',
    recs: [],                             // 익스텐션이 뽑은 영상 오디오(통째 MP3) 목록 — 맥 폴더에 있는 파일
    tagNames: [],                         // 저장된 태그 이름 (확장 프로그램 설정 tagNames ∪ 항목들의 태그)
    trimOpen: null,                       // 구간 조정 슬라이더가 열린 항목
    web: Object.assign({}, WEB_DEFAULTS),  // 웹 학습 기능 켜기/끄기 (확장 프로그램 설정 web 에 저장)
    stats: null, shadow: null, ladderFor: null,
    clip: { itemId: null, state: null, message: '', loop: false }, clipLocal: false,
    repeat: false,                        // 🔁 반복: ▶ 로 재생한 대사를 계속 반복
    playRate: 0,                          // 지금 재생 중인 배속 (0 = 재생 안 함, 1 = ▶ 기본) — 각 대사의 배속 버튼을 켜 보이게 한다
    theme: loadPref('subtutor.theme', 'dark'),
    hide: loadHide(), reveal: new Map(),  // 자막/뜻 감추기: 전체 기본값 + 항목별 예외
    recordings: new Map(), recording: null, playingRec: null,
    edit: { on: false, sel: new Set() },  // 편집 모드: 선택 상자로 골라 한꺼번에 삭제
    quiz: null, quizPrefs: { title: '', tag: '', order: 'due', dueOnly: true, autoplay: true }, nzQuiz: null,
    words: [], wordReview: null,          // 단어장 (패널 '단어 목록'에서 ☆ 로 저장) · 카드 복습 진행
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
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }
  // 보관된 오디오가 없어 플레이어 탭으로 가는 첫 재생에 한 번만 안내한다
  function hintStoredAudio() {
    try { if (sessionStorage.getItem('subtutor.hint.audio')) return; sessionStorage.setItem('subtutor.hint.audio', '1'); } catch (e) { /* ignore */ }
    toast('보관된 오디오가 없어 플레이어 탭에서 재생합니다. 확장 프로그램 설정의 "별표 저장 시 오디오"를 "웹 재생용으로 보관" 또는 "PC에 MP3 파일로 저장"으로 켜 두면 이후 저장하는 대사는 탭 없이 바로 재생됩니다.', 7000);
  }
  // PC 파일(⬇ MP3)만 있는 예전 항목을 폴더에서 읽지 못했을 때: 이유별 안내 (다운로드 폴더는 확장 프로그램이 읽을 수 없다)
  const FILE_HINT = {
    downloads: '이 MP3 는 다운로드 폴더에 있어 확장 프로그램이 다시 읽을 수 없습니다. 주황 ⬇ MP3 배지나 설정의 "MP3 폴더에서 불러오기"에서 다운로드 폴더 안의 SubTutor 폴더를 한 번 고르면 웹에서 바로 재생됩니다. 지금은 플레이어 탭에서 재생합니다.',
    prompt: 'MP3 폴더의 권한이 풀려 있어 플레이어 탭에서 재생합니다. 툴바의 SubTutor 아이콘 → "폴더 권한 허용"을 누른 뒤 다시 ▶ 를 누르세요.',
    denied: 'MP3 폴더 접근이 거부되어 플레이어 탭에서 재생합니다. 확장 프로그램 설정 페이지에서 폴더를 다시 고르세요.',
    none: 'MP3 를 저장했던 폴더가 지정되어 있지 않아 플레이어 탭에서 재생합니다. 설정의 "MP3 폴더에서 불러오기"로 가져올 수 있습니다.',
    'other-folder': '지금 지정된 폴더가 이 MP3 를 저장한 폴더와 달라 플레이어 탭에서 재생합니다. 설정의 "MP3 폴더에서 불러오기"로 가져올 수 있습니다.',
    missing: '지정 폴더에서 이 MP3 파일을 찾지 못해 플레이어 탭에서 재생합니다. 옮겼거나 지웠다면 "MP3 폴더에서 불러오기"로 다시 연결할 수 있습니다.',
  };
  function hintNoLocalAudio(it) {
    if (!it.file) { hintStoredAudio(); return; }
    const reason = fileIssue.get(it.id) || 'error';
    toast(FILE_HINT[reason] || ('MP3 파일을 읽지 못해 플레이어 탭에서 재생합니다 (' + reason + ')'), 8000);
  }
  const isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  // ⓘ: 설명과 학문적 근거는 화면에 늘어놓지 않고 누르면 보여 준다
  function infoBtn(key) { return el('button', { class: 'info', title: '설명 · 근거', 'data-key': key, onclick: (e) => { e.preventDefault(); e.stopPropagation(); showInfo(key); } }, 'i'); }
  function showInfo(key) {
    const x = Ex && Ex.get(key);
    if (!x) return;
    const dlg = $('#info-dialog');
    $('#info-title').textContent = x.title;
    const body = $('#info-body');
    body.textContent = '';
    body.append(el('p', { class: 'what', text: x.what }));
    if (x.why) body.append(el('h5', null, '왜 이렇게 하나 (근거)'), el('p', { class: 'why', text: x.why }));
    if (x.refs && x.refs.length) body.append(el('h5', null, '참고 문헌'), el('ul', { class: 'refs' }, x.refs.map((r) => el('li', { text: r }))));
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }
  async function loadWebPrefs() {
    try { const r = await B.request('settings.get'); const w = r && r.settings && r.settings.web; if (w && typeof w === 'object') state.web = Object.assign({}, WEB_DEFAULTS, w); } catch (e) { /* ignore */ }
  }
  async function saveWebPrefs(patch) {
    state.web = Object.assign({}, state.web, patch);
    try { await B.request('settings.set', { patch: { web: state.web } }); } catch (e) { toast('설정 저장 실패: ' + e.message); }
  }
  // 간격 반복: 복습 예정일. 아직 복습 안 한 카드는 저장한 때부터 예정
  const INTERVALS = [1, 3, 7, 14, 30];
  const dueOf = (it) => (it.review && Number.isFinite(it.review.due)) ? it.review.due : (it.savedAt || 0);
  const isDue = (it) => dueOf(it) <= Date.now();
  const dueItems = () => learning().filter(isDue);
  const learning = () => state.items.filter((i) => (i.box || 'learning') === 'learning');
  const known = () => state.items.filter((i) => i.box === 'known');
  const fmtDate = (ms) => { const d = new Date(ms); return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0'); };
  function loadPref(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : v; } catch (e) { return def; } }
  // 화면 테마: 다크(기본) · 화이트 · 시스템 설정. 이 브라우저에만 저장한다(localStorage) — 페이지가 뜰 때 바로 입혀 깜빡임이 없다
  const THEMES = [['dark', '다크'], ['light', '화이트'], ['auto', '시스템 설정']];
  function applyTheme() {
    const t = THEMES.some(([v]) => v === state.theme) ? state.theme : 'dark';
    const dark = t === 'dark' || (t === 'auto' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  function setTheme(t) { state.theme = t; savePref('subtutor.theme', t); applyTheme(); }
  function savePref(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* ignore */ } }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

  // ───────── 데이터 ─────────
  // 화면에 영향을 주는 필드만으로 서명을 만들어, 실제로 바뀐 경우에만 다시 그린다 (입력 중인 내용 보호)
  const itemsSignature = (items) => items.map((i) => [i.id, i.box, i.lastResult || '', i.missReason || '', i.comment, i.translation, i.reviews, i.forgot, i.savedAt, i.audio ? 1 : 0, i.file ? (i.file.location || '1') : 0, (i.tags || []).join(','), i.trim ? i.trim.startMs + '-' + i.trim.endMs : '', i.review ? i.review.due : '', i.missed ? 1 : 0].join('\u0001')).sort().join('\u0002');
  async function loadItems(force) {
    if (!state.extOk) { render(); return; }
    let changed = !!force;
    try {
      const r = await B.request('items.list');
      const items = (r && r.items) || [];
      if (itemsSignature(items) !== itemsSignature(state.items)) changed = true;
      for (const it of items) if (!it.audio) dropAudioCaches(it.id); // 복사본이 없어진 항목은 다음 재생 때 다시 읽는다
      state.items = items;
      mergeTagNames(items.flatMap((i) => i.tags || []));
    } catch (e) { toast(e.message); }
    updateCounts();
    if (changed) render();
  }
  function updateCounts() {
    $('#count-list').textContent = learning().length;
    $('#count-known').textContent = known().length;
    const due = $('#count-due');
    if (due) { const n = state.web.srs ? dueItems().length : 0; due.textContent = n ? String(n) : ''; due.title = n ? '오늘 복습할 카드 ' + n + '개' : ''; }
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
    dropAudioCaches(id);
  }

  // ───────── 편집 모드 (선택해서 삭제) ─────────
  let editSync = null; // 지금 그려진 목록의 선택 상태를 편집 막대와 카드에 반영 (renderList 가 넣는다)
  function setEdit(on) { state.edit.on = !!on; if (!on) state.edit.sel.clear(); render(); }
  function setPick(id, on) { if (on) state.edit.sel.add(id); else state.edit.sel.delete(id); if (editSync) editSync(); }
  function togglePickMany(ids) { const all = ids.every((id) => state.edit.sel.has(id)); ids.forEach((id) => { if (all) state.edit.sel.delete(id); else state.edit.sel.add(id); }); if (editSync) editSync(); }
  const editButton = () => el('button', { class: 'btn edit-toggle' + (state.edit.on ? ' on' : ''), title: state.edit.on ? '편집 모드 끝내기 (Esc)' : '편집: 대사를 골라 한꺼번에 삭제', onclick: () => setEdit(!state.edit.on) }, state.edit.on ? '✎ 편집 중' : '✎ 편집');
  // 편집 막대: 보이는 대사 모두 선택 · 선택 삭제 · 작품/에피소드 전체 삭제 · 완료
  function buildEditUi(items, body, getVisible) {
    const bar = el('span', { class: 'edit-bar' + (state.edit.on ? '' : ' hidden') });
    const selCount = el('b', null, '0');
    const delBtn = el('button', { class: 'btn danger del-selected', disabled: true, onclick: () => bulkDelete(Array.from(state.edit.sel), '선택한 대사') }, ['선택 ', selCount, '개 삭제']);
    const allBox = el('input', { type: 'checkbox', class: 'pick-all', onchange: (e) => { getVisible().forEach((it) => { if (e.target.checked) state.edit.sel.add(it.id); else state.edit.sel.delete(it.id); }); sync(); } });
    const scopes = []; // 드롭다운 항목: { label, ids }
    const byTitle = new Map();
    for (const it of items) { if (!byTitle.has(it.title)) byTitle.set(it.title, new Map()); const eps = byTitle.get(it.title); const ep = it.episode || ''; if (!eps.has(ep)) eps.set(ep, []); eps.get(ep).push(it.id); }
    const scopeSel = el('select', { class: 'bulk-scope', title: '작품 또는 에피소드의 대사를 모두 삭제', onchange: (e) => { const v = e.target.value; e.target.value = ''; const sc = v === '' ? null : scopes[+v]; if (sc) bulkDelete(sc.ids, sc.label); } }, [el('option', { value: '' }, '작품·에피소드 삭제…')]);
    Array.from(byTitle.keys()).sort((a, b) => a.localeCompare(b, 'ko')).forEach((t) => {
      const eps = byTitle.get(t);
      const all = Array.from(eps.values()).flat();
      const g = el('optgroup', { label: t });
      scopes.push({ label: '작품 "' + t + '"의 대사', ids: all });
      g.append(el('option', { value: String(scopes.length - 1) }, '작품 전체 · ' + all.length + '개'));
      if (eps.size > 1 || !eps.has('')) Array.from(eps.keys()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })).forEach((ep) => { scopes.push({ label: '"' + t + ' ' + ep + '"의 대사', ids: eps.get(ep) }); g.append(el('option', { value: String(scopes.length - 1) }, ep + ' · ' + eps.get(ep).length + '개')); });
      scopeSel.append(g);
    });
    bar.append(infoBtn('edit'), el('label', { class: 'pick-all-label' }, [allBox, ' 보이는 대사 모두 선택']), delBtn, scopeSel, el('button', { class: 'btn primary edit-done', onclick: () => setEdit(false) }, '완료'));
    function sync() {
      const n = state.edit.sel.size;
      selCount.textContent = String(n);
      delBtn.disabled = !n;
      const vis = getVisible();
      allBox.checked = vis.length > 0 && vis.every((it) => state.edit.sel.has(it.id));
      body.querySelectorAll('.item').forEach((node) => { const on = state.edit.sel.has(node.dataset.id); node.classList.toggle('selected', on); const cb = node.querySelector('.pick'); if (cb) cb.checked = on; });
    }
    return { bar, sync };
  }
  const FAIL_REASON = { 'not-found': '크롬 다운로드 기록에 없어 직접 지워야 함', 'file-gone': '이미 없는 파일', missing: '폴더에 없는 파일', prompt: '폴더 권한 필요', denied: '폴더 권한 거부됨', none: '폴더 미지정', 'other-folder': '다른 폴더에 저장된 파일', error: '오류' };
  // 대사 삭제(여러 개): 보관 오디오 · PC 의 MP3 파일 · 내 녹음도 함께 지운다. 확인 창에 무엇이 지워지는지 알린다
  async function bulkDelete(ids, label) {
    ids = Array.from(new Set(ids)).filter((id) => state.items.some((i) => i.id === id));
    if (!ids.length) { toast('선택한 대사가 없습니다'); return; }
    const files = ids.filter((id) => { const it = state.items.find((i) => i.id === id); return it && it.file; }).length;
    const recs = ids.reduce((a, id) => { const r = state.recordings.get(id); return a + (Array.isArray(r) ? r.length : 0); }, 0);
    if (!confirm(label + ' ' + ids.length + '개를 삭제할까요?' + (files ? ' PC 에 저장한 MP3 파일 ' + files + '개도 함께 지웁니다.' : '') + (recs ? ' 내 녹음 ' + recs + '개도 지워집니다.' : '') + ' 되돌릴 수 없습니다.')) return;
    const set = new Set(ids);
    if (set.has(state.clip.itemId) && ['playing', 'opening', 'loading'].includes(state.clip.state)) { stopLocalAudio(); if (!state.clipLocal) B.request('clip.stop').catch(() => {}); setClip(state.clip.itemId, 'stopped'); }
    state.items = state.items.filter((i) => !set.has(i.id));
    ids.forEach((id) => { state.edit.sel.delete(id); dropAudioCaches(id); fileIssue.delete(id); });
    updateCounts();
    render();
    let r = null;
    try { r = await B.request('items.removeMany', { ids }, 120000); } catch (e) { toast('삭제 실패: ' + e.message); loadItems(true); return; }
    for (const id of ids) { try { await R.clearItem(id); state.recordings.delete(id); } catch (e) { /* ignore */ } }
    const f = (r && r.files) || { deleted: 0, failed: [] };
    const failed = f.failed || [];
    toast('대사 ' + ((r && r.removed) || ids.length) + '개 삭제' + (f.deleted ? ' · MP3 파일 ' + f.deleted + '개 삭제' : '') + (failed.length ? ' · 파일 ' + failed.length + '개는 지우지 못했습니다 (' + (FAIL_REASON[failed[0].reason] || failed[0].reason) + ')' : ''), failed.length ? 8000 : 3000);
  }
  // 확장 프로그램이 읽을 수 없는 곳(다운로드 폴더 등)에 MP3 가 있는 대사
  const needsImport = (it) => !!(it.file && !it.audio && it.file.location !== 'folder');
  // 그런 대사: MP3 가 있는 폴더를 한 번 고르면 파일 이름이 같은 대사에 웹 재생용 복사본을 넣는다
  async function importMp3Folder() {
    if (!state.extOk) { toast('확장 프로그램이 필요합니다'); return; }
    const key = (n) => String(n).replace(/ \(\d+\)(\.[^.]+)$/, '$1').toLowerCase(); // 크롬이 같은 이름에 붙이는 " (1)" 무시
    const want = new Map(); // 파일 이름 → 항목들
    for (const it of state.items) if (it.file && it.file.path && !it.audio) { const k = key(it.file.path.split('/').pop()); if (!want.has(k)) want.set(k, []); want.get(k).push(it); }
    if (!want.size) { toast('불러올 MP3 가 없습니다. PC 파일만 있는 대사가 없거나 이미 복사본이 있습니다.', 4000); return; }
    if (typeof window.showDirectoryPicker !== 'function') { toast('이 브라우저는 폴더 선택을 지원하지 않습니다 (크롬 86 이상)'); return; }
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'subtutor-mp3', mode: 'read', startIn: 'downloads' }); } catch (e) { if (e && e.name !== 'AbortError') toast('폴더를 열지 못했습니다: ' + e.message); return; }
    toast('MP3 파일을 찾는 중…', 60000);
    let found = 0, scanned = 0;
    const done = new Set();
    const parentOf = (it) => { const p = it.file.path.split('/'); return p.length > 1 ? p[p.length - 2] : ''; };
    async function walk(d, depth) {
      for await (const [name, h] of d.entries()) {
        if (h.kind === 'directory') { if (depth < 6 && !name.startsWith('.')) await walk(h, depth + 1); continue; }
        scanned++;
        const k = key(name);
        if (!want.has(k) || done.has(k)) continue;
        const all = want.get(k);
        const same = all.filter((it) => parentOf(it) === d.name); // 같은 이름이 여럿이면 작품 폴더 이름이 맞는 것부터
        const targets = same.length ? same : all;
        try {
          const f = await h.getFile();
          if (f.size > 20 * 1024 * 1024) continue;
          const bytes = new Uint8Array(await f.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          const data = btoa(s);
          const format = (name.split('.').pop() || 'mp3').toLowerCase();
          for (const it of targets) {
            await B.request('audio.put', { itemId: it.id, data, mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg', format, leadMs: it.file.leadMs, source: 'import' }, 30000);
            found++; dropAudioCaches(it.id); fileIssue.delete(it.id);
          }
          if (targets === all) done.add(k);
        } catch (e) { /* 다음 파일 */ }
      }
    }
    try { await walk(dir, 0); } catch (e) { toast('폴더를 읽는 중 오류: ' + e.message); return; }
    toast(found ? 'MP3 ' + found + '개를 불러왔습니다. 이제 웹에서 바로 재생됩니다.' : '"' + dir.name + '" 폴더에서 맞는 MP3 를 찾지 못했습니다 (파일 ' + scanned + '개 확인). MP3 가 든 SubTutor 폴더(예: 다운로드 안의 SubTutor)나 그 상위 폴더를 고르세요. 크롬은 다운로드 폴더 자체는 고를 수 없습니다.', 7000);
    if (found) loadItems(true);
  }

  // ───────── 플레이어 원격 재생 ─────────
  function setClip(itemId, st, message, loop) {
    const keepLoop = loop === undefined ? (state.clip.itemId === itemId && !!state.clip.loop) : !!loop;
    state.clip = { itemId, state: st, message: message || '', loop: keepLoop };
    renderClipStates();
    if (st === 'ended' || st === 'error' || st === 'stopped') {
      clipWaiters.splice(0).forEach((w) => w.resolve({ itemId, state: st }));
    }
  }
  const STATE_TEXT = { loading: 'MP3 읽는 중…', opening: '플레이어 준비 중…', playing: '재생 중', ended: '', stopped: '', error: '' };
  function renderClipStates() {
    document.querySelectorAll('[data-clip-item]').forEach((node) => {
      const id = node.dataset.clipItem;
      const mine = state.clip.itemId === id;
      const st = mine ? state.clip.state : null;
      const busy = mine && (st === 'opening' || st === 'loading');
      node.classList.toggle('playing', busy || (mine && st === 'playing'));
      const btn = node.querySelector('.play');
      if (btn) {
        btn.classList.toggle('busy', busy);
        btn.classList.toggle('active', mine && st === 'playing');
        const icon = busy ? '…' : (mine && st === 'playing' ? '◼' : '▶');
        btn.textContent = btn.dataset.label ? icon + ' ' + btn.dataset.label : icon;
        btn.title = mine && st === 'playing' ? '정지' : '플레이어에서 이 대사 재생';
      }
      // 각 대사의 배속 버튼: 지금 그 배속으로 재생 중이면 켜진 상태, 반복 중이면 테두리로 표시
      const liveRate = mine && st === 'playing' ? (state.playRate || 1) : 0;
      node.querySelectorAll('.rate-btn').forEach((b) => {
        const on = liveRate > 0 && Math.abs(parseFloat(b.dataset.rate) - liveRate) < 0.005;
        b.classList.toggle('on', on);
        b.classList.toggle('looping', on && !!state.clip.loop);
      });
      const se = node.querySelector('.state');
      if (se) {
        se.textContent = mine ? (st === 'error' ? '재생 실패: ' + (state.clip.message || '') : (st === 'playing' && state.clip.loop ? '반복 재생 중 · ◼ 로 정지' : (STATE_TEXT[st] || ''))) : '';
        se.classList.toggle('err', mine && st === 'error');
      }
    });
  }
  const audioCache = new Map(); // itemId -> Blob
  const fileIssue = new Map();  // itemId -> PC 파일에서 읽지 못한 이유
  const stretchCache = new Map(); // itemId\0from\0to\0rate -> AudioBuffer
  // 항목의 오디오가 바뀌거나 지워지면 디코딩·배속 변환 결과도 버린다
  function dropAudioCaches(id) {
    audioCache.delete(id); bufferCache.delete(id);
    for (const k of Array.from(stretchCache.keys())) if (k.startsWith(id + '\u0000')) stretchCache.delete(k);
  }
  function b64ToBlob(b64, mime) { const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new Blob([bytes], { type: mime || 'audio/wav' }); }
  async function localAudioBlob(itemId) {
    if (audioCache.has(itemId)) return audioCache.get(itemId);
    const it = state.items.find((i) => i.id === itemId);
    try {
      const r = await B.request('audio.get', { itemId }, 20000);
      const b64 = r && (r.data || r.wav);
      if (b64) { const blob = b64ToBlob(b64, r && r.mime); audioCache.set(itemId, blob); return blob; }
    } catch (e) { /* 아래로 */ }
    // PC 파일(MP3)만 있는 예전 항목: 확장 프로그램이 지정 폴더에서 읽어 복사본을 만들어 준다 (그 뒤로는 보관 오디오처럼 바로)
    if (it && it.file && !it.audio) {
      try {
        const r = await B.request('audio.file', { itemId }, 30000);
        if (r && r.data) { fileIssue.delete(itemId); const blob = b64ToBlob(r.data, r.mime); audioCache.set(itemId, blob); return blob; }
        fileIssue.set(itemId, (r && r.reason) || 'error');
      } catch (e) { fileIssue.set(itemId, 'error'); }
      return null; // 권한을 허용하면 바로 다시 시도할 수 있게 캐시하지 않는다
    }
    audioCache.set(itemId, null);
    return null;
  }
  let localAudio = null;
  function stopLocalAudio() { if (localAudio) { const a = localAudio; localAudio = null; try { a.stop(); } catch (e) { /* ignore */ } } }
  // ───────── 재생 구간(조정) ─────────
  const TRIM_WIN_MS = 2000; // 조정 슬라이더가 원래 구간 앞뒤로 더 보여 주는 폭 (플레이어 재생일 때)
  function effRange(it) {
    const t = it.trim;
    if (t && Number.isFinite(t.startMs) && Number.isFinite(t.endMs) && t.endMs > t.startMs) return { startMs: t.startMs, endMs: t.endMs, trimmed: true };
    return { startMs: it.startMs, endMs: it.endMs + endSlopMs(it), trimmed: false };
  }
  const clipLeadMs = (it) => { const a = it.audio && it.audio.leadMs, f = it.file && it.file.leadMs; return Number.isFinite(a) ? a : (Number.isFinite(f) ? f : 250); }; // 클립은 자막 시작보다 이만큼 앞에서 시작
  // 녹음-영상 시계가 플랫폼에 따라 수백 ms 어긋나 저장된 소리가 자막 끝보다 일찍 끊기는 일이 있다.
  // 손대지 않은(조정 전) 재생은 파일에 남아 있는 꼬리만큼(최대 0.6초) 끝을 자동으로 늘려 문장 끝이 잘리지 않게 한다.
  const END_SLOP_MS = 600;
  function endSlopMs(it) {
    const audioMs = (it.audio && it.audio.ms) || (it.file && it.file.ms) || 0;
    if (!audioMs) return 0;
    const spare = audioMs - clipLeadMs(it) - (it.endMs - it.startMs);
    return Math.max(0, Math.min(END_SLOP_MS, spare));
  }
  const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));
  function fmtMs(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), frac = String(ms % 1000).padStart(3, '0');
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0') + '.' + frac;
  }
  const timeText = (it) => { const r = effRange(it); return S.formatTime(r.startMs) + ' – ' + S.formatTime(r.endMs) + (r.trimmed ? ' (조정됨)' : ''); };
  // WebAudio 로 보관 클립의 [startMs, endMs](영상 시간)를 샘플 단위로 정확히 재생. 반복은 재생 중에도 켜고 끌 수 있다
  let audioCtx = null;
  const bufferCache = new Map(); // itemId -> AudioBuffer | null
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  async function localAudioBuffer(itemId) {
    if (bufferCache.has(itemId)) return bufferCache.get(itemId);
    const blob = await localAudioBlob(itemId);
    let buf = null;
    if (blob) { try { buf = await getCtx().decodeAudioData(await blob.arrayBuffer()); } catch (e) { buf = null; } }
    if (buf || audioCache.has(itemId)) bufferCache.set(itemId, buf);
    return buf;
  }
  // 배속 재생 준비: "음높이 유지"가 켜져 있으면 구간을 미리 WSOLA 로 늘이거나 줄여 두고 1배속으로 재생한다
  // (WebAudio 의 playbackRate 만 쓰면 느릴 때 목소리가 굵어지고 빠를 때 가늘어진다)
  function prepareClip(it, buf, range, rate) {
    const clipStart = it.startMs - clipLeadMs(it);
    const from = clampNum((range.startMs - clipStart) / 1000, 0, Math.max(0, buf.duration - 0.05));
    const to = clampNum((range.endMs - clipStart) / 1000, from + 0.05, buf.duration);
    const speed = rate && rate > 0 ? rate : 1;
    const plain = { buffer: buf, from, to, speed };
    if (Math.abs(speed - 1) < 0.005 || !St || state.web.ladderPitch === false) return plain;
    const key = [it.id, Math.round(from * 1000), Math.round(to * 1000), speed].join('\u0000');
    let b = stretchCache.get(key);
    if (!b) {
      try { b = St.stretchBuffer(getCtx(), buf, from, to, speed); } catch (e) { return plain; }
      if (stretchCache.size > 24) stretchCache.clear();
      stretchCache.set(key, b);
    }
    return { buffer: b, from: 0, to: b.duration, speed: 1, pitched: true };
  }
  function noteClip(clip) {
    state.lastClip = { pitched: !!clip.pitched, speed: Math.round(clip.speed * 100) / 100, sec: Math.round((clip.to - clip.from) * 1000) / 1000 };
    return clip;
  }
  function playLocal(clip, loop) {
    return new Promise((resolve) => {
      const ctx = getCtx();
      const buf = clip.buffer, from = clip.from, to = clip.to, speed = clip.speed;
      const len = to - from;
      let src = null, startedAt = 0, startPos = from, timer = null, finished = false, looping = !!loop;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); if (localAudio === handle) localAudio = null; resolve(); };
      const position = () => from + ((startPos - from) + (ctx.currentTime - startedAt) * speed) % len;
      const begin = (pos) => {
        src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true; src.loopStart = from; src.loopEnd = to;
        src.playbackRate.value = speed;
        src.connect(ctx.destination);
        src.onended = finish;
        startPos = pos; startedAt = ctx.currentTime;
        src.start(0, pos);
        clearTimeout(timer);
        if (!looping) timer = setTimeout(() => { try { src.stop(); } catch (e) { /* ignore */ } finish(); }, Math.max(0, ((to - pos) / speed) * 1000));
      };
      const handle = {
        stop() { if (finished) return; try { if (src) { src.onended = null; src.stop(); } } catch (e) { /* ignore */ } finish(); },
        set loop(v) {
          v = !!v;
          if (v === looping || finished) return;
          looping = v;
          clearTimeout(timer);
          if (!v) timer = setTimeout(() => { try { src.stop(); } catch (e) { /* ignore */ } finish(); }, Math.max(0, ((to - position()) / speed) * 1000));
        },
      };
      localAudio = handle;
      begin(from);
    });
  }
  // ▶/◼: 같은 대사를 다시 누르면 정지, 다른 대사를 누르면 이전 것을 멈추고 재생. opts.loop 가 없으면 🔁 반복 토글을 따른다.
  async function playItem(itemId, opts) {
    opts = opts || {};
    if (!state.extOk) { toast('확장 프로그램이 필요합니다'); return; }
    R.stop();
    const cur = state.clip;
    const busy = cur.state === 'playing' || cur.state === 'opening' || cur.state === 'loading';
    if (busy) {
      // 정지 상태를 먼저 기록해 두어야, 멈추면서 끝나는 이전 재생이 '끝남'으로 덮어쓰지 않는다
      if (!opts.rate) state.ladderFor = null;
      setClip(cur.itemId, 'stopped');
      stopLocalAudio();
      if (!state.clipLocal) await B.request('clip.stop').catch(() => {});
      if (cur.itemId === itemId) { state.playRate = 0; renderClipStates(); return; }
    } else stopLocalAudio();
    const loop = opts.loop === undefined ? state.repeat : !!opts.loop;
    state.playRate = opts.rate && opts.rate > 0 ? Math.round(opts.rate * 100) / 100 : 1;
    const it = state.items.find((i) => i.id === itemId);
    if (it && (it.audio || it.file)) {
      // 보관 오디오(또는 PC 파일의 복사본)로 바로 재생. 복사본이 없는 파일 항목은 확장 프로그램이 지정 폴더에서 읽어 온다
      setClip(itemId, 'loading', '', loop);
      const buf = await localAudioBuffer(itemId);
      if (state.clip.itemId !== itemId || state.clip.state !== 'loading') return; // 그사이 다른 대사를 누르거나 멈췄다
      if (buf) {
        state.clipLocal = true;
        setClip(itemId, 'playing', '', loop);
        await playLocal(noteClip(prepareClip(it, buf, effRange(it), opts.rate)), loop);
        if (state.clip.itemId === itemId && state.clip.state === 'playing') setClip(itemId, 'ended');
        return;
      }
    }
    state.clipLocal = false;
    if (it && !it.audio) hintNoLocalAudio(it);
    setClip(itemId, 'opening', '', loop);
    try {
      const r = await B.request('clip.play', { itemId, loop, rate: opts.rate || 0 }, 90000);
      if (r && r.error && state.clip.itemId === itemId && state.clip.state === 'opening') setClip(itemId, 'error', r.error === 'not-ready' ? '플레이어가 준비되지 않았습니다' : String(r.error));
    } catch (e) {
      setClip(itemId, 'error', e.message);
    }
  }
  // 속도 사다리: 설정한 단계대로 이어서 재생 (중간에 멈추면 중단)
  function ladderRates() {
    const raw = Array.isArray(state.web.ladderRates) ? state.web.ladderRates : [];
    const out = raw.map((x) => Math.round(clampNum(+x, RATE_MIN, RATE_MAX) * 100) / 100).filter((x) => Number.isFinite(x) && x > 0).slice(0, LADDER_MAX_STEPS);
    return out.length ? out : LADDER_PRESETS[4];
  }
  const ladderTitle = () => '속도 사다리 ' + ladderRates().map(fmtRate).join(' → ') + '×' + (state.web.ladderPitch === false ? '' : ' (음높이 유지)');
  async function playLadder(itemId) {
    if (state.ladderFor) { state.ladderFor = null; await playItem(itemId); return; }
    await playRates(itemId, ladderRates());
  }
  // eslint 호환 자리 (fastRates·playFast 는 rateTitle 옆에 정의)
  // 정한 배속들로 한 번씩 이어서 재생 (중간에 멈추거나 다른 것을 누르면 false). 끝나면(중단돼도) ladderFor 를 치운다.
  // 보관 오디오는 playItem 이 끝까지 재생하고 돌아오지만, 플레이어 탭 원격 재생은 시작만 하고 돌아온다 → 끝 이벤트를 기다린다
  async function playRates(itemId, rates, mark) {
    state.ladderFor = itemId;
    const trace = (m) => { try { window.__subtutorDebug.log.push('rates ' + m + ' clip=' + state.clip.itemId + '/' + state.clip.state + ' local=' + state.clipLocal + ' ladderFor=' + state.ladderFor); } catch (e) { /* ignore */ } };
    try {
      for (const rate of rates) {
        if (state.ladderFor !== itemId) { trace('abort-ladder ' + rate); return false; }
        toast((mark || '⤴') + ' ' + fmtRate(rate) + '×', 900);
        trace('start ' + rate);
        await playItem(itemId, { loop: false, rate });
        trace('after-play ' + rate);
        if (state.ladderFor !== itemId || state.clip.itemId !== itemId) { trace('abort-mismatch ' + rate); return false; }
        if (!state.clipLocal && ['opening', 'loading', 'playing'].includes(state.clip.state)) {
          const done = await Promise.race([waitClipEnd(), new Promise((r) => setTimeout(() => r(null), 45000))]); // 이벤트가 안 오면 45초에 포기
          trace('remote-done ' + rate + ' ' + JSON.stringify(done));
          if (!done || state.ladderFor !== itemId || done.itemId !== itemId || done.state !== 'ended') return false;
        } else if (state.clip.state !== 'ended') { trace('abort-state ' + rate); return false; }
        await new Promise((r) => setTimeout(r, 250));
      }
      trace('finished');
      return true;
    } finally { if (state.ladderFor === itemId) state.ladderFor = null; }
  }
  // 대사마다 붙는 배속 버튼 ([0.8] [0.9] [1] [1.15]): 설정 › 속도 사다리에 넣은 배속이 그대로 나온다.
  // 누르면 그 배속으로 재생하고, 🔁 반복이 켜져 있으면 그 배속으로 계속 반복한다.
  // 같은 배속을 다시 누르면 정지, 다른 배속을 누르면 바로 그 배속으로 바꿔 재생한다.
  async function playAtRate(itemId, rate) {
    state.ladderFor = null;                                   // 사다리가 돌던 중이면 멈춘다
    const cur = state.clip;
    const live = cur.itemId === itemId && (cur.state === 'playing' || cur.state === 'opening' || cur.state === 'loading');
    const same = live && Math.abs((state.playRate || 1) - rate) < 0.005;
    if (live) {
      setClip(itemId, 'stopped');
      stopLocalAudio();
      if (!state.clipLocal) await B.request('clip.stop').catch(() => {});
      if (same) { state.playRate = 0; renderClipStates(); return; }
    }
    await playItem(itemId, { rate });
  }
  const rateTitle = (r) => fmtRate(r) + '배속으로 재생' + (state.web.ladderPitch === false ? '' : ' (음높이 유지)') + ' · 🔁 반복을 켜 두면 이 배속으로 계속 반복합니다 · 같은 배속을 다시 누르면 정지';
  // 고속 적응 프리셋 (Griffiths 1990): 이해를 확인한 문장을 가속해 듣고 1배로 끝낸다
  function fastRates() {
    const raw = Array.isArray(state.web.fastRates) ? state.web.fastRates : [];
    const out = raw.map((x) => Math.round(clampNum(+x, 0.5, RATE_MAX) * 100) / 100).filter((x) => Number.isFinite(x) && x > 0).slice(0, LADDER_MAX_STEPS);
    if (!out.length) return FAST_PRESETS[4].slice();
    out[out.length - 1] = 1;
    return out;
  }
  // 이해를 확인한 문장: 받아쓰기에서 "알고 있어"를 받았거나 알고 있는 표현 상자로 옮긴 것
  const understood = (it) => !!(it && (it.box === 'known' || it.lastResult === 'know'));
  const fastTitle = () => '고속 적응 ' + fastRates().map(fmtRate).join(' → ') + '× — 이해를 확인한 문장을 가속해 듣고 1배로 끝냅니다 (음높이 유지)';
  const playFast = (itemId) => playRates(itemId, fastRates(), '⏩');
  const rateBtns = (it) => (state.web.ladder === false ? [] : ladderRates().map((r) => el('button', { class: 'btn mini rate-btn', 'data-rate': fmtRate(r), title: rateTitle(r), onclick: () => playAtRate(it.id, r) }, fmtRate(r))));
  function setRepeat(on) {
    state.repeat = !!on;
    document.querySelectorAll('.repeat-toggle').forEach((b) => { b.classList.toggle('on', state.repeat); b.title = REPEAT_TITLE[state.repeat ? 1 : 0]; });
    const active = state.clip.state === 'playing' || state.clip.state === 'opening';
    if (localAudio) localAudio.loop = state.repeat;
    if (active && !state.clipLocal) B.request('clip.loop', { loop: state.repeat }).catch(() => {});
    if (active) { state.clip.loop = state.repeat; renderClipStates(); }
  }
  const REPEAT_TITLE = ['반복: 켜면 ▶ 로 재생한 대사를 계속 반복합니다', '반복 켜짐: ▶ 를 누른 대사를 계속 반복합니다. 다른 대사를 누르면 그 대사로 바뀌고, ◼ 로 멈춥니다'];
  const repeatButton = () => el('button', { class: 'btn repeat-toggle' + (state.repeat ? ' on' : ''), title: REPEAT_TITLE[state.repeat ? 1 : 0], onclick: () => setRepeat(!state.repeat) }, '🔁 반복');
  function waitClipEnd() { return new Promise((resolve) => clipWaiters.push({ resolve })); }
  async function playTogether(itemId) {
    const recs = await getRecs(itemId);
    if (!recs.length) { toast('먼저 녹음을 해 주세요'); return; }
    const p = waitClipEnd();
    await playItem(itemId, { loop: false });
    const r = await p;
    if (r.itemId === itemId && r.state === 'ended') await playRecording(itemId, recs[recs.length - 1]);
  }
  B.on('clip.state', (p) => {
    if (!p || !p.itemId) return;
    setClip(p.itemId, p.state, p.message);
    if (p.state === 'error') toast('재생 실패: ' + (p.message || ''));
  });

  // ───────── Q 원인 태깅 (왜 못 알아들었나) ─────────
  // 못 알아들은(Q) 문장을 복습할 때 원인을 원터치로 하나 고른다 (선택 사항, 재생 중에는 묻지 않는다).
  // 축약형 지각과 어휘량은 별개 예측 변수(Wong 2017), 발화 길이도 독립 요인(Medina 2020) — 원인별로 맞는 훈련이 다르다
  const MISS_REASONS = [['speed', '속도'], ['vocab', '모르는 단어'], ['reduction', '축약·연음'], ['accent', '키위 발음'], ['length', '문장이 김']];
  const MISS_RECOMMEND = {
    speed: '속도가 가장 많습니다 → 이해한 문장을 고속 적응 프리셋(목록 ⏩ · 플레이어 ⚙ › 반복 고속 적응)으로 가속해 들어 귀를 빠른 말에 맞추세요.',
    vocab: '모르는 단어가 가장 많습니다 → 패널 "단어 목록"에서 어려운 단어를 미리 훑고 ☆ 로 단어장에 모아 카드로 복습하세요.',
    reduction: '축약·연음이 가장 많습니다 → 플레이어 ⚙ 에서 "소리 나는 대로"와 "빈칸 자막(기능어)"을 켜고, 받아쓰기 퀴즈를 이어 가세요.',
    accent: '키위 발음이 가장 많습니다 → "NZ 모음 주석"으로 fish→fush, pen→pin 처럼 들리는 단어를 눈으로 확인하며 들으세요.',
    length: '긴 문장이 가장 많습니다 → ⏱ 구간 조정으로 긴 문장을 끊어 반복하고, 더빙·따라하기는 한 줄씩 하세요.',
  };
  function reasonRow(it) {
    const row = el('div', { class: 'miss-why' }, [el('span', { class: 'mw-label' }, ['왜 못 알아들었나요? (선택)', infoBtn('missReason')])]);
    for (const [k, label] of MISS_REASONS) {
      row.append(el('button', { class: 'mw' + (it.missReason === k ? ' on' : ''), 'data-why': k, title: '원인을 하나 고르면 진행 상황에 모여 다음 훈련을 고르는 재료가 됩니다 (고르지 않아도 됩니다)', onclick: async (e) => {
        const v = it.missReason === k ? null : k;
        e.target.closest('.miss-why').querySelectorAll('.mw').forEach((b) => b.classList.toggle('on', b.dataset.why === v));
        await updateItem(it.id, { missReason: v });
      } }, label));
    }
    return row;
  }

  // ───────── 태그 ─────────
  // 태그 이름은 확장 프로그램 설정(tagNames)에 저장되어 다른 자막에서도 고를 수 있고, 각 자막의 tags 에 지정된다
  const normTag = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  function mergeTagNames(names) {
    let changed = false;
    for (const raw of names) { const t = normTag(raw); if (t && !state.tagNames.includes(t)) { state.tagNames.push(t); changed = true; } }
    if (changed) state.tagNames.sort((a, b) => a.localeCompare(b, 'ko'));
    return changed;
  }
  async function loadTagNames() {
    try { const r = await B.request('settings.get'); mergeTagNames((r && r.settings && r.settings.tagNames) || []); } catch (e) { /* ignore */ }
  }
  function saveTagNames() { B.request('settings.set', { patch: { tagNames: state.tagNames.slice() } }).catch(() => {}); }
  const tagCount = (name) => state.items.filter((i) => (i.tags || []).includes(name)).length;
  async function addTag(it, raw) {
    const t = normTag(raw);
    if (!t) return;
    const tags = (it.tags || []).slice();
    if (!tags.includes(t)) { tags.push(t); await updateItem(it.id, { tags }); }
    if (mergeTagNames([t])) { saveTagNames(); refreshTagList(); }
    renderTagBars(); renderTagRows();
  }
  async function removeTag(it, t) {
    const tags = (it.tags || []).filter((x) => x !== t);
    await updateItem(it.id, { tags });
    renderTagBars(); renderTagRows();
  }
  async function deleteTagName(t) {
    if (!confirm('태그 "' + t + '" 을(를) 지울까요? 이 태그가 붙은 자막 ' + tagCount(t) + '개에서도 빠집니다.')) return;
    for (const it of state.items) if ((it.tags || []).includes(t)) await updateItem(it.id, { tags: it.tags.filter((x) => x !== t) });
    state.tagNames = state.tagNames.filter((x) => x !== t);
    saveTagNames();
    if (state.filterTag === t) state.filterTag = '';
    render();
  }
  function refreshTagList() {
    let dl = $('#st-taglist');
    if (!dl) { dl = el('datalist', { id: 'st-taglist' }); document.body.append(dl); }
    dl.textContent = '';
    state.tagNames.forEach((t) => dl.append(el('option', { value: t })));
  }
  function buildTagBar(onFilter) {
    const bar = el('div', { class: 'tagbar', 'data-tagbar': '1' });
    bar.__onFilter = onFilter;
    fillTagBar(bar);
    return bar;
  }
  function fillTagBar(bar) {
    bar.textContent = '';
    if (!state.tagNames.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.append(el('span', { class: 'tagbar-label' }, ['태그', infoBtn('tags')]));
    bar.append(el('button', { class: 'tag' + (state.filterTag ? '' : ' on'), onclick: () => { state.filterTag = ''; renderTagBars(); bar.__onFilter && bar.__onFilter(); } }, '전체'));
    for (const t of state.tagNames) {
      const chip = el('button', { class: 'tag' + (state.filterTag === t ? ' on' : ''), title: '이 태그가 붙은 자막만 보기', onclick: () => { state.filterTag = state.filterTag === t ? '' : t; renderTagBars(); bar.__onFilter && bar.__onFilter(); } }, [t, el('span', { class: 'n' }, String(tagCount(t)))]);
      chip.append(el('span', { class: 'x', title: '태그 삭제', onclick: (e) => { e.stopPropagation(); deleteTagName(t); } }, '×'));
      bar.append(chip);
    }
  }
  function renderTagBars() { document.querySelectorAll('[data-tagbar]').forEach(fillTagBar); }
  function buildTagRow(it) {
    const row = el('div', { class: 'tags-row', 'data-tag-item': it.id });
    fillTagRow(row);
    return row;
  }
  function fillTagRow(row) {
    const it = state.items.find((i) => i.id === row.dataset.tagItem);
    if (!it) return;
    row.textContent = '';
    (it.tags || []).forEach((t) => {
      const chip = el('button', { class: 'tag small', title: '이 태그가 붙은 자막만 보기', onclick: () => { state.filterTag = t; renderTagBars(); const bar = document.querySelector('[data-tagbar]'); if (bar && bar.__onFilter) bar.__onFilter(); } }, t);
      chip.append(el('span', { class: 'x', title: '이 자막에서 태그 빼기', onclick: (e) => { e.stopPropagation(); removeTag(it, t); } }, '×'));
      row.append(chip);
    });
    const add = el('button', { class: 'tag add tag-add', title: '태그 붙이기 (저장된 태그를 고르거나 새로 입력)' }, '+ 태그');
    add.addEventListener('click', () => {
      refreshTagList();
      const input = el('input', { class: 'tag-input', list: 'st-taglist', placeholder: '태그 이름', maxlength: 24 });
      const finish = async (commit) => { if (input.__done) return; input.__done = true; const v = input.value; input.replaceWith(add); if (commit) await addTag(it, v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => setTimeout(() => finish(!!input.value.trim()), 120));
      add.replaceWith(input);
      input.focus();
    });
    row.append(add);
  }
  function renderTagRows() { document.querySelectorAll('[data-tag-item]').forEach(fillTagRow); }

  // ───────── 오디오 구간 조정 슬라이더 ─────────
  function toggleTrim(it) { state.trimOpen = state.trimOpen === it.id ? null : it.id; renderTrimBoxes(); }
  function refreshMeta(it) {
    document.querySelectorAll('[data-id="' + it.id + '"] .meta .span').forEach((e) => { e.textContent = timeText(it); });
    document.querySelectorAll('.trim-toggle[data-id="' + it.id + '"]').forEach((b) => b.classList.toggle('trimmed', effRange(it).trimmed));
  }
  function buildTrimBox(it) { return el('div', { class: 'trim-box hidden', 'data-trim-item': it.id }); }
  function renderTrimBoxes() {
    document.querySelectorAll('[data-trim-item]').forEach((box) => {
      const it = state.items.find((i) => i.id === box.dataset.trimItem);
      if (!it) return;
      const open = state.trimOpen === it.id;
      box.classList.toggle('hidden', !open);
      if (open && !box.__built) { box.__built = true; fillTrimBox(box, it); } else if (open && box.__update) box.__update();
    });
    document.querySelectorAll('.trim-toggle').forEach((b) => b.classList.toggle('on', b.dataset.id === state.trimOpen));
  }
  function fillTrimBox(box, it) {
    const hasLocal = !!it.audio;
    const lead = clipLeadMs(it);
    let win = { s: Math.max(0, it.startMs - TRIM_WIN_MS), e: it.endMs + TRIM_WIN_MS };
    let buf = null;
    const cur = () => effRange(it);
    const label = el('span', { class: 'trim-label' });
    const track = el('div', { class: 'trim-track' });
    const canvas = el('canvas', { class: 'trim-wave' });
    const orig = el('div', { class: 'trim-orig', title: '원래 자막 구간' });
    const band = el('div', { class: 'trim-band' });
    const hs = el('div', { class: 'trim-handle start', tabindex: 0, title: '시작 — 드래그, ←→ 10ms, Shift+←→ 100ms' }, el('span', { class: 'trim-tip' }));
    const he = el('div', { class: 'trim-handle end', tabindex: 0, title: '끝 — 드래그, ←→ 10ms, Shift+←→ 100ms' }, el('span', { class: 'trim-tip' }));
    track.append(canvas, orig, band, hs, he);
    const width = () => Math.max(1, track.clientWidth);
    const xOf = (ms) => ((ms - win.s) / (win.e - win.s)) * width();
    const msOf = (x) => win.s + (x / width()) * (win.e - win.s);
    const layout = () => {
      const r = cur();
      const xs = clampNum(xOf(r.startMs), 0, width()), xe = clampNum(xOf(r.endMs), 0, width());
      band.style.left = xs + 'px'; band.style.width = Math.max(0, xe - xs) + 'px';
      hs.style.left = xs + 'px'; he.style.left = xe + 'px';
      hs.firstChild.textContent = fmtMs(r.startMs); he.firstChild.textContent = fmtMs(r.endMs);
      const os = clampNum(xOf(it.startMs), 0, width()), oe = clampNum(xOf(it.endMs), 0, width());
      orig.style.left = os + 'px'; orig.style.width = Math.max(0, oe - os) + 'px';
      label.textContent = fmtMs(r.startMs) + ' – ' + fmtMs(r.endMs) + ' · ' + ((r.endMs - r.startMs) / 1000).toFixed(2) + '초' + (r.trimmed ? ' · 조정됨' : '');
    };
    let saveTimer = null;
    const setRange = (sMs, eMs) => {
      sMs = Math.round(clampNum(sMs, win.s, win.e)); eMs = Math.round(clampNum(eMs, win.s, win.e));
      if (eMs - sMs < 100) { if (sMs !== cur().startMs) sMs = eMs - 100; else eMs = sMs + 100; }
      it.trim = (sMs === it.startMs && eMs === it.endMs) ? null : { startMs: sMs, endMs: eMs };
      layout(); refreshMeta(it);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => updateItem(it.id, { trim: it.trim }), 400);
    };
    const drag = (handle, which) => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        handle.classList.add('dragging');
        const move = (ev) => { const x = ev.clientX - track.getBoundingClientRect().left; const r = cur(); if (which === 'start') setRange(msOf(x), r.endMs); else setRange(r.startMs, msOf(x)); };
        const up = () => { handle.classList.remove('dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
      });
      handle.addEventListener('keydown', (e) => {
        const dir = e.key === 'ArrowLeft' ? -1 : (e.key === 'ArrowRight' ? 1 : 0);
        if (!dir) return;
        e.preventDefault();
        const step = dir * (e.shiftKey ? 100 : 10);
        const r = cur();
        if (which === 'start') setRange(r.startMs + step, r.endMs); else setRange(r.startMs, r.endMs + step);
      });
    };
    drag(hs, 'start'); drag(he, 'end');
    const nudge = (which, d) => el('button', { class: 'btn mini nudge', 'data-which': which, 'data-d': d, title: (which === 'start' ? '시작' : '끝') + ' ' + (d > 0 ? '+' : '') + d + 'ms', onclick: () => { const r = cur(); if (which === 'start') setRange(r.startMs + d, r.endMs); else setRange(r.startMs, r.endMs + d); } }, (d > 0 ? '+' : '') + d);
    const ctl = el('div', { class: 'trim-ctl' }, [
      el('span', { class: 'trim-k' }, '시작'), nudge('start', -100), nudge('start', -10), nudge('start', 10), nudge('start', 100),
      el('span', { class: 'trim-k' }, '끝'), nudge('end', -100), nudge('end', -10), nudge('end', 10), nudge('end', 100),
      el('button', { class: 'btn trim-preview', onclick: () => playItem(it.id, { loop: false }) }, '▶ 들어보기'),
      el('button', { class: 'btn trim-reset', onclick: () => setRange(it.startMs, it.endMs) }, '원래대로'),
      el('button', { class: 'btn', onclick: () => toggleTrim(it) }, '닫기'),
    ]);
    // 문장 늘리기/줄이기: 저장 때 같이 둔 자막 경계(parts)와 다음 자막 글(next)로 텍스트·구간을 한 줄씩 더하거나 뺀다
    const sentCtl = (() => {
      const parts = Array.isArray(it.parts) ? it.parts : null;
      const next = Array.isArray(it.next) ? it.next : [];
      if (!parts && !next.length) return null;
      const info = el('span', { class: 'count sent-info' });
      const apply = async () => {
        const ps = it.parts;
        it.text = ps.map((x) => x.text).join('\n');
        it.endMs = ps[ps.length - 1].endMs;
        it.trim = null; // 구간이 바뀌었으니 손 조정은 처음부터
        await updateItem(it.id, { text: it.text, endMs: it.endMs, parts: it.parts, next: it.next, trim: null });
        win = { s: Math.max(0, it.startMs - TRIM_WIN_MS), e: it.endMs + TRIM_WIN_MS };
        layout(); refreshMeta(it); fill(); loadItems();
      };
      const plus = el('button', { class: 'btn mini sent-plus', title: '다음 자막의 글과 구간을 더한다', onclick: async () => {
        if (!it.next || !it.next.length) return;
        if (!Array.isArray(it.parts) || !it.parts.length) it.parts = [{ text: it.text, startMs: it.startMs, endMs: it.endMs }];
        it.parts.push(it.next.shift());
        await apply();
      } }, '+ 문장 늘리기');
      const minus = el('button', { class: 'btn mini sent-minus', title: '마지막 자막을 뺀다', onclick: async () => {
        if (!Array.isArray(it.parts) || it.parts.length < 2) return;
        it.next = [it.parts.pop()].concat(it.next || []);
        await apply();
      } }, '− 줄이기');
      const fill = () => {
        const n = Array.isArray(it.parts) ? it.parts.length : 1;
        plus.disabled = !(it.next && it.next.length);
        minus.disabled = !(Array.isArray(it.parts) && it.parts.length > 1);
        const tailMissing = it.audio && it.audio.ms && (it.endMs - it.startMs) > it.audio.ms;
        info.textContent = '자막 ' + n + '줄' + (it.next && it.next.length ? ' · 더할 수 있는 다음 자막 ' + it.next.length + '개' : '') + (tailMissing ? ' · ⚠ 저장된 소리가 여기까지 없습니다 (저장 때의 꼬리 여유까지만)' : '');
      };
      fill();
      return el('div', { class: 'trim-sentence' }, [plus, minus, info]);
    })();
    box.append(
      el('div', { class: 'trim-head' }, [el('b', null, '오디오 구간 조정'), infoBtn('trim'), label]),
      track, sentCtl, ctl,
    );
    const draw = () => {
      const w = width(), h = track.clientHeight;
      if (!buf || !w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const data = buf.getChannelData(0), clipStart = it.startMs - lead, sr = buf.sampleRate;
      g.fillStyle = 'rgba(167,139,250,.6)';
      for (let x = 0; x < w; x++) {
        const i0 = Math.max(0, Math.floor(((msOf(x) - clipStart) / 1000) * sr)), i1 = Math.min(data.length, Math.ceil(((msOf(x + 1) - clipStart) / 1000) * sr));
        if (i1 <= i0) continue;
        let peak = 0;
        for (let i = i0; i < i1; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        const bh = Math.max(1, peak * (h - 6));
        g.fillRect(x, (h - bh) / 2, 1, bh);
      }
    };
    box.__update = () => { layout(); draw(); };
    if (hasLocal) {
      localAudioBuffer(it.id).then((b) => {
        buf = b;
        if (!b) return;
        const clipStart = it.startMs - lead;
        win = { s: clipStart, e: clipStart + b.duration * 1000 }; // 보관 클립 범위 안에서만
        layout(); draw();
      });
    }
    requestAnimationFrame(() => { layout(); draw(); });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { layout(); draw(); }).observe(track);
  }

  // ───────── 녹음 ─────────
  async function getRecs(itemId) {
    if (!state.recordings.has(itemId)) {
      try { state.recordings.set(itemId, await R.list(itemId)); } catch (e) { state.recordings.set(itemId, []); }
    }
    return state.recordings.get(itemId);
  }
  // 명료도 피드백(실험적): 녹음과 나란히 크롬 음성 인식 — 실패하면 조용히 생략 (근거 ⓘ: dubFeedback)
  function startAsr() {
    try {
      if (window.__subtutorAsrTest) return { text: String(window.__subtutorAsrTest), done: true, stop() {} }; // E2E 용 가짜 인식
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return null;
      const r = new SR();
      r.lang = 'en-NZ'; r.continuous = true; r.interimResults = false;
      const o = { text: '', done: false, stop() { try { r.stop(); } catch (e) { o.done = true; } } };
      r.onresult = (e) => { let t = ''; for (const res of e.results) t += res[0].transcript + ' '; o.text = t.trim(); };
      r.onerror = () => { o.done = true; };
      r.onend = () => { o.done = true; };
      r.start();
      return o;
    } catch (e) { return null; }
  }
  // 0.3초 넘게 조용한 구간 수 (확장 프로그램 audio.js 의 silenceGaps 와 같은 계산 — 웹은 audio.js 를 싣지 않아 여기 둔다)
  function countPauses(buf) {
    try {
      const d = buf.getChannelData(0), rate = buf.sampleRate, win = Math.round(rate * 0.02);
      const quiet = [];
      for (let i = 0; i + win <= d.length; i += win) { let s = 0; for (let k = i; k < i + win; k++) s += d[k] * d[k]; quiet.push(Math.sqrt(s / win) < 0.015); }
      let a = 0, b = quiet.length - 1;
      while (a < quiet.length && quiet[a]) a++;
      while (b >= 0 && quiet[b]) b--;
      let gaps = 0, run = 0;
      for (let i = a; i <= b; i++) { if (quiet[i]) run++; else { if (run >= 15) gaps++; run = 0; } }
      return gaps;
    } catch (e) { return 0; }
  }
  async function recFeedback(it, asr, blob, durationMs) {
    if (!asr) return null;
    asr.stop();
    for (let w = 0; w < 15 && !asr.done; w++) await new Promise((r) => setTimeout(r, 100));
    const heard = asr.text || '';
    let pauses = 0;
    try { pauses = countPauses(await getCtx().decodeAudioData(await blob.arrayBuffer())); } catch (e) { pauses = 0; }
    const myWords = heard ? heard.trim().split(/\s+/).length : 0;
    const origWords = String(it.text || '').trim().split(/\s+/).filter(Boolean).length;
    const origSecs = (effRange(it).endMs - effRange(it).startMs) / 1000;
    return { text: heard.slice(0, 300), acc: heard ? S.diffWords(it.text, heard).accuracy : null, wpm: durationMs > 300 && myWords ? Math.round((myWords / (durationMs / 1000)) * 60) : 0, origWpm: origSecs > 0.3 && origWords ? Math.round((origWords / origSecs) * 60) : 0, pauses };
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
          const it = state.items.find((i) => i.id === itemId);
          const fb = it ? await recFeedback(it, rec.asr, blob, durationMs).catch(() => null) : null;
          const list = await R.add(itemId, blob, durationMs, fb);
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
      state.recording = { itemId, ctrl, asr: startAsr(), startedAt: Date.now(), timer: setInterval(tickRecLabel, 250) };
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
      const fb = r.fb && (r.fb.acc !== null || r.fb.pauses || r.fb.wpm) ? r.fb : null;
      const b = el('button', { class: 'attempt' + (k === recs.length - 1 ? ' latest' : '') + (state.playingRec === r.id ? ' playing' : '') + (fb ? ' has-fb' : ''), title: '녹음 ' + (k + 1) + ' 재생 (' + fmtDate(r.createdAt) + ', ' + Math.round(r.durationMs / 100) / 10 + '초)' + (fb ? ' · 명료도(실험적): ' + (fb.acc !== null ? '일치 ' + fb.acc + '%' : '') + (fb.wpm ? ' · ' + fb.wpm + ' wpm (원본 ' + fb.origWpm + ')' : '') + ' · 멈춤 ' + fb.pauses + '번' + (fb.text ? ' · 인식: "' + fb.text + '"' : '') : ''), onclick: () => playRecording(itemId, r) }, String(k + 1));
      if (fb && fb.acc !== null) b.append(el('span', { class: 'fb-acc' }, fb.acc + '%'));
      b.append(el('span', { class: 'x', title: '이 녹음 삭제', onclick: async (e) => { e.stopPropagation(); await R.remove(r.id); state.recordings.set(itemId, await R.list(itemId)); renderRecRows(); } }, '×'));
      node.append(b);
    });
    if (recs && recs.length) node.append(el('button', { class: 'rec-btn', title: '원음을 들은 뒤 최근 녹음을 이어서 재생', onclick: () => playTogether(itemId) }, '🔊 같이 듣기'));
    node.append(infoBtn('recording'));
  }
  function renderRecRows() { document.querySelectorAll('[data-rec-item]').forEach(fillRecRow); }
  // 녹음 중 경과 시간은 버튼을 다시 만들지 않고 글자만 바꾼다 (클릭 중 요소가 바뀌지 않도록)
  function tickRecLabel() {
    if (!state.recording) return;
    const secs = Math.floor((Date.now() - state.recording.startedAt) / 1000);
    document.querySelectorAll('[data-rec-item="' + state.recording.itemId + '"] .rec-btn.recording').forEach((b) => { b.textContent = '■ 정지 ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'); });
  }

  // ───────── 자막/뜻 감추기 ─────────
  // 기본은 모두 감춤. 전체 토글은 이 탭(세션)에서 기억하고, 항목별로 연 것은 전체 토글을 누르면 초기화된다.
  const FIELD_LABEL = { text: '자막', ko: '뜻' };
  function loadHide() {
    try { const v = JSON.parse(sessionStorage.getItem('subtutor.hide') || 'null'); if (v && typeof v === 'object') return { text: v.text !== false, ko: v.ko !== false }; } catch (e) { /* ignore */ }
    return { text: true, ko: true };
  }
  function saveHide() { try { sessionStorage.setItem('subtutor.hide', JSON.stringify(state.hide)); } catch (e) { /* ignore */ } }
  function isVeiled(id, field) {
    const o = state.reveal.get(id);
    if (o && o[field] !== undefined) return !o[field];
    return !!state.hide[field];
  }
  function setGlobalHide(field, hidden) {
    state.hide[field] = !!hidden;
    state.reveal.forEach((o) => { delete o[field]; });
    saveHide();
    syncVeils();
  }
  function setItemVeil(id, field, hidden) {
    const o = state.reveal.get(id) || {};
    o[field] = !hidden;
    state.reveal.set(id, o);
    syncVeils();
  }
  function syncVeils() {
    document.querySelectorAll('.item[data-id]').forEach((node) => {
      const id = node.dataset.id;
      for (const f of ['text', 'ko']) {
        const v = isVeiled(id, f);
        node.classList.toggle('veil-' + f, v);
        const b = node.querySelector('.vis-' + f);
        if (b) b.textContent = FIELD_LABEL[f] + (v ? ' 보기' : ' 감추기');
      }
    });
    document.querySelectorAll('.hide-toggle').forEach((b) => {
      const f = b.dataset.field;
      b.textContent = FIELD_LABEL[f] + (state.hide[f] ? ' 모두 보이기' : ' 모두 감추기');
      b.classList.toggle('on', !state.hide[f]);
      b.title = state.hide[f] ? '모든 대사의 ' + FIELD_LABEL[f] + '을(를) 보입니다' : '모든 대사의 ' + FIELD_LABEL[f] + '을(를) 감춥니다 (항목별로 연 것도 함께)';
    });
  }


  // ───────── 입트기 (말하기 유창성 연습) ─────────
  // 프롬프트(기본 48개 내장 + 직접 추가)를 누르면 펼쳐져 자유 말하기 / 줄여 말하기(4/3/2식 다운 타이머)로 녹음한다.
  // 오디오는 이 브라우저(IndexedDB)에만 두고, 프롬프트와 기록(길이·날짜·별점·메모·받아 적기)만 Supabase 로 동기화한다.
  const SPEAK_GROUPS = [
    ['mine', '내 프롬프트'],
    ['short:boss', '짧게 답하기 · 교장·동료의 말'], ['short:student', '짧게 답하기 · 학생과 주고받기'],
    ['short:parent', '짧게 답하기 · 학부모'], ['short:etc', '짧게 답하기 · 그 외'],
    ['long:daily', '길게 말하기 · 일상 이야기'], ['long:opinion', '길게 말하기 · 내 생각'],
    ['long:class', '길게 말하기 · 수업에서'], ['long:meeting', '길게 말하기 · 회의에서'], ['long:etc', '길게 말하기 · 그 외'],
  ];
  const SPEAK_STAGE_DEFAULT = [75, 60, 45];
  function loadSpeak() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem('st.speak') || '{}') || {}; } catch (e) { o = {}; }
    const sp = {
      prompts: Array.isArray(o.prompts) ? o.prompts : [],
      takes: Array.isArray(o.takes) ? o.takes : [],
      stages: Array.isArray(o.stages) && o.stages.length ? o.stages.map(Number).filter((n) => n > 0) : SPEAK_STAGE_DEFAULT.slice(),
      lastSync: o.lastSync || 0, seeded: !!o.seeded,
      collapsed: new Set(Array.isArray(o.collapsed) ? o.collapsed : []),
      drop10: o.drop10 !== false,   // 10초 안에 끝낸 녹음은 잘못 누른 것으로 보고 버린다 (스위치로 끔)
      syncMsg: '', open: null, edit: false, importOpen: false,
      hintOpen: new Set(), memoOpen: new Set(), heardOpen: new Set(), audioIds: new Set(), audioLoaded: false,
    };
    // 내장 프롬프트 채우기: 처음 한 번 + 새 버전에서 추가된 것 (지운 것은 tombstone 이 남아 다시 생기지 않는다)
    (window.SPEAK_PROMPTS || []).forEach((b) => {
      if (!sp.prompts.some((p) => p.id === b.id)) sp.prompts.push({ id: b.id, text: b.text, kind: b.kind, cat: b.cat, hint: b.hint || '', deleted: false, editedAt: 0 });
    });
    sp.seeded = true;
    return sp;
  }
  const sp = loadSpeak();
  const saveSpeak = () => { try { localStorage.setItem('st.speak', JSON.stringify({ prompts: sp.prompts, takes: sp.takes, stages: sp.stages, lastSync: sp.lastSync, seeded: sp.seeded, collapsed: [...sp.collapsed], drop10: sp.drop10 })); } catch (e) { /* ignore */ } };
  saveSpeak();

  // 오디오는 IndexedDB (이 브라우저에만 — 다른 기기에는 기록만 간다)
  let spDbP = null;
  function spDb() {
    if (spDbP) return spDbP;
    spDbP = new Promise((resolve, reject) => {
      const req = indexedDB.open('subtutor-speak', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('audio', { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return spDbP;
  }
  async function spAudioPut(id, blob) { try { const db = await spDb(); await new Promise((res, rej) => { const t = db.transaction('audio', 'readwrite'); t.objectStore('audio').put({ id, blob }); t.oncomplete = res; t.onerror = () => rej(t.error); }); sp.audioIds.add(id); } catch (e) { /* 시크릿 창 등 — 재생만 안 될 뿐 */ } }
  async function spAudioGet(id) { try { const db = await spDb(); return await new Promise((res) => { const r = db.transaction('audio').objectStore('audio').get(id); r.onsuccess = () => res(r.result ? r.result.blob : null); r.onerror = () => res(null); }); } catch (e) { return null; } }
  async function spAudioDel(id) { try { const db = await spDb(); db.transaction('audio', 'readwrite').objectStore('audio').delete(id); } catch (e) { /* ignore */ } sp.audioIds.delete(id); }
  async function spAudioLoadIds() {
    if (sp.audioLoaded) return;
    sp.audioLoaded = true;
    try { const db = await spDb(); const keys = await new Promise((res) => { const r = db.transaction('audio').objectStore('audio').getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }); keys.forEach((k) => sp.audioIds.add(k)); if (state.view === 'speak') render(); } catch (e) { /* ignore */ }
  }

  const spTakesOf = (pid) => sp.takes.filter((t) => t.pid === pid && !t.deleted).sort((a, b) => b.at - a.at);
  const spMarkP = (p) => { p.editedAt = Date.now(); p.dirty = true; saveSpeak(); };
  const spMarkT = (t) => { t.editedAt = Date.now(); t.dirty = true; saveSpeak(); };
  const fmtWhen = (ms) => { const d = new Date(ms); return (d.getMonth() + 1) + '.' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  function spAddPrompts(text, kind) {
    const lines = F.parsePromptLines(text);
    const now = Date.now();
    lines.forEach((t, i) => sp.prompts.push({ id: 'u' + (now + i).toString(36) + Math.random().toString(36).slice(2, 6), text: t, kind, cat: 'mine', hint: '', deleted: false, editedAt: now, dirty: true }));
    saveSpeak();
    return lines.length;
  }
  function spStats() {
    const now = new Date();
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const week0 = Date.now() - 7 * DAY;
    const live = sp.takes.filter((t) => !t.deleted);
    const today = live.filter((t) => t.at >= day0);
    const week = live.filter((t) => t.at >= week0);
    const secs = (arr) => Math.round(arr.reduce((a, t) => a + (t.durMs || 0), 0) / 1000);
    return '오늘 ' + today.length + '회 · ' + F.fmtClock(secs(today)) + ' — 이번 주 ' + week.length + '회 · ' + F.fmtClock(secs(week));
  }

  // 동기화: 바뀐 것(dirty)만 올리고, lastSync 뒤에 바뀐 것을 받아 와 나중에 바뀐 쪽이 이긴다
  let speakSyncBusy = false;
  async function speakSync() {
    if (speakSyncBusy) return;
    if (!supaBase() || !supa.key.trim() || !supa.refresh) { sp.syncMsg = '설정 › 아이폰 동기화에서 로그인하면 아이폰과 동기화됩니다 (오디오 제외)'; return; }
    speakSyncBusy = true;
    if (state.view === 'speak') { const m = $('.speak-sync'); if (m) m.textContent = '동기화 중…'; }
    try {
      await supaEnsureToken();
      const H = { apikey: supa.key.trim(), Authorization: 'Bearer ' + supa.token, 'Content-Type': 'application/json' };
      const iso = (ms) => new Date(Math.max(0, ms || 0)).toISOString();   // 0(처음)은 1970 — '지금'으로 만들면 첫 받아 오기가 전부 빠진다
      const push = async (table, rows) => { if (rows.length) await supaFetch('/rest/v1/' + table, { method: 'POST', headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, H), body: JSON.stringify(rows) }); };
      await push('speak_prompts', sp.prompts.filter((p) => p.dirty).map((p) => ({ user_id: supa.userId || undefined, id: p.id, text: p.text || '', kind: p.kind || 'short', cat: p.cat || 'mine', hint: p.hint || '', deleted: !!p.deleted, updated_at: iso(p.editedAt || Date.now()) })));
      await push('speak_takes', sp.takes.filter((t) => t.dirty).map((t) => ({ user_id: supa.userId || undefined, id: t.id, prompt_id: t.pid, at: t.at, dur_ms: Math.round(t.durMs || 0), mode: t.mode, target_s: t.targetS || 0, rating: t.rating || 0, memo: t.memo || '', heard: t.heard || '', deleted: !!t.deleted, updated_at: iso(t.editedAt || Date.now()) })));
      sp.prompts.forEach((x) => { delete x.dirty; });
      sp.takes.forEach((x) => { delete x.dirty; });
      const since = encodeURIComponent(iso(Math.max(0, (sp.lastSync || 0) - 2000)));
      const pull = async (table) => (await supaFetch('/rest/v1/' + table + '?select=*&updated_at=gt.' + since, { headers: H })).json();
      for (const row of await pull('speak_prompts')) {
        const at = Date.parse(row.updated_at) || 0;
        let x = sp.prompts.find((q) => q.id === row.id);
        if (x && at <= (x.editedAt || 0)) continue;
        if (!x) { x = { id: row.id }; sp.prompts.push(x); }
        Object.assign(x, { text: row.text || '', kind: row.kind || 'short', cat: row.cat || 'mine', hint: row.hint || '', deleted: !!row.deleted, editedAt: at });
        delete x.dirty;
      }
      for (const row of await pull('speak_takes')) {
        const at = Date.parse(row.updated_at) || 0;
        let x = sp.takes.find((q) => q.id === row.id);
        if (x && at <= (x.editedAt || 0)) continue;
        if (!x) { x = { id: row.id }; sp.takes.push(x); }
        Object.assign(x, { pid: row.prompt_id || '', at: Number(row.at) || 0, durMs: Number(row.dur_ms) || 0, mode: row.mode || 'free', targetS: Number(row.target_s) || 0, rating: Number(row.rating) || 0, memo: row.memo || '', heard: row.heard || '', deleted: !!row.deleted, editedAt: at });
        delete x.dirty;
      }
      sp.lastSync = Date.now();
      sp.syncMsg = '동기화 끝 — ' + fmtWhen(sp.lastSync) + ' (오디오는 녹음한 기기에만)';
      saveSpeak();
    } catch (e) {
      const m = String((e && e.message) || e);
      sp.syncMsg = /42P01|PGRST205|does not exist|Could not find the table/i.test(m)
        ? '서버에 입트기 표가 없습니다 — 저장소 supabase/schema.sql 의 "입트기" 블록을 Supabase SQL Editor 에서 실행하세요'
        : '동기화 실패: ' + m;
    } finally {
      speakSyncBusy = false;
      if (state.view === 'speak') render();
    }
  }

  // 녹음 화면 (전체 덮개 — 목록과 따로 그려서 다시 렌더링해도 안 끊긴다)
  const spRec = { el: null, wakeLock: null };
  function spAsrStart() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    // 크롬 음성 인식은 잠깐의 무음·네트워크 출렁임에도 스스로 멈춘다 — 녹음이 끝날 때까지, 멈추면 다시 켜서 이어 받는다
    const box = { text: '', stopped: false, r: null, boots: 0 };
    const boot = () => {
      if (box.stopped || box.boots > 120) return;
      box.boots++;
      let r;
      try { r = new SR(); } catch (e) { return; }
      box.r = r;
      r.lang = 'en-NZ';
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) box.text += (box.text ? ' ' : '') + e.results[i][0].transcript.trim(); };
      r.onerror = () => { /* onend 가 따라오면 다시 켠다 */ };
      r.onend = () => { if (!box.stopped) setTimeout(boot, 250); };
      try { r.start(); } catch (e) { /* 받아 적기만 빠진다 */ }
    };
    boot();
    return {
      stop() { box.stopped = true; try { if (box.r) box.r.stop(); } catch (e) { /* ignore */ } },
      // 마치기: 아직 오는 중인 마지막 말을 잠깐(최대 1.5초) 기다렸다가 문장을 준다
      done() {
        box.stopped = true;
        return new Promise((res) => {
          const fin = () => { clearTimeout(t); res(box.text); };
          const t = setTimeout(fin, 1500);
          if (!box.r) { fin(); return; }
          box.r.onend = fin;
          try { box.r.stop(); } catch (e) { fin(); }
        });
      },
      get text() { return box.text; },
    };
  }
  function spRecClose() {
    if (spRec.el) { spRec.el.remove(); spRec.el = null; }
    if (spRec.wakeLock) { try { spRec.wakeLock.release(); } catch (e) { /* ignore */ } spRec.wakeLock = null; }
    if (state.view === 'speak') render();
  }
  async function spSaveTake(prompt, mode, targetS, blob, durMs, heard) {
    const t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), pid: prompt.id, at: Date.now(), durMs: Math.round(durMs), mode, targetS: targetS || 0, rating: 0, memo: '', heard: heard || '', deleted: false, editedAt: Date.now(), dirty: true };
    if (blob) await spAudioPut(t.id, blob);
    sp.takes.push(t);
    saveSpeak();
    return t;
  }
  async function openSpeakRec(prompt, mode) {
    let sess = null;
    try { sess = await R.session(); } catch (e) { toast('마이크를 허용해야 녹음할 수 있습니다'); return; }
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then((w) => { spRec.wakeLock = w; }).catch(() => {});
    let asr = spAsrStart();
    let stage = 0;
    let timer = 0;
    let paused = false;
    const stages = sp.stages.slice();
    const target = () => stages[stage];
    const wrap = el('div', { class: 'speak-rec' });
    spRec.el = wrap;
    document.body.append(wrap);
    const finishAll = () => { clearInterval(timer); if (asr) asr.stop(); spRecClose(); };

    const promptEl = el('div', { class: 'r-prompt', text: prompt.text });
    const stageEl = el('div', { class: 'r-stage' });
    const clockEl = el('div', { class: 'r-clock', text: '0:00' });
    const pauseBtn = el('button', { class: 'rbtn', title: '잠깐 멈춤', onclick: () => {
      paused = !paused;
      if (paused) { sess.pause(); pauseBtn.textContent = '▶'; } else { sess.resume(); pauseBtn.textContent = '⏸'; }
    } }, '⏸');
    const stopBtn = el('button', { class: 'rbtn stop', title: '마치기' }, '⏹');
    const cancelBtn = el('button', { class: 'r-cancel', onclick: async () => { clearInterval(timer); if (asr) asr.stop(); try { await sess.stop(); } catch (e) { /* ignore */ } finishAll(); } }, '✕ 버리고 나가기');

    if (mode === 'free') {
      stageEl.textContent = '자유 말하기 — 시간 제한 없음';
      const wave = el('canvas', { class: 'r-wave' });
      wrap.append(promptEl, stageEl, clockEl, wave, el('div', { class: 'r-btns' }, [pauseBtn, stopBtn]), cancelBtn);
      const ctx2 = wave.getContext('2d');
      wave.width = 560; wave.height = 72;
      const buf = sess.analyser ? new Uint8Array(sess.analyser.frequencyBinCount) : null;
      const draw = () => {
        if (!spRec.el) return;
        requestAnimationFrame(draw);
        if (!buf) return;
        sess.analyser.getByteFrequencyData(buf);
        ctx2.clearRect(0, 0, wave.width, wave.height);
        ctx2.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#8b5cf6';
        const n = 48, w = wave.width / n;
        for (let i = 0; i < n; i++) { const v = buf[Math.floor((i * buf.length) / n)] / 255; const h = Math.max(2, v * wave.height); ctx2.fillRect(i * w + 1, (wave.height - h) / 2, w - 2, h); }
      };
      draw();
      timer = setInterval(() => { clockEl.textContent = F.fmtClock(sess.activeMs / 1000); }, 200);
      stopBtn.onclick = async () => {
        clearInterval(timer);
        const heardP = asr ? asr.done() : Promise.resolve('');
        const { blob, durationMs } = await sess.stop();
        if (durationMs < 700 || (sp.drop10 && durationMs < 10000)) {
          toast(durationMs < 700 ? '너무 짧아서 저장하지 않았습니다' : '10초가 안 되어 저장하지 않았습니다 (입트기 화면의 스위치로 끌 수 있어요)');
          finishAll();
          return;
        }
        await spSaveTake(prompt, 'free', 0, blob, durationMs, await heardP);
        toast('녹음을 저장했습니다 (' + F.fmtClock(durationMs / 1000) + ')');
        finishAll();
      };
      return;
    }

    // 줄여 말하기: 포모도로식 원형 다운 타이머 — 시간이 넘으면 같은 방향으로 주황 띠가 덧칠해지며 +1초씩
    const RAD = 104, C = 2 * Math.PI * RAD;
    const mkCircle = (cls, color, width) => { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('cx', 120); c.setAttribute('cy', 120); c.setAttribute('r', RAD); c.setAttribute('fill', 'none'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', width); c.setAttribute('stroke-linecap', 'round'); c.setAttribute('class', cls); return c; };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', 240); svg.setAttribute('height', 240); svg.setAttribute('viewBox', '0 0 240 240');
    const line = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#2a2a33';
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
    const orange = getComputedStyle(document.documentElement).getPropertyValue('--orange').trim() || '#fbbf24';
    const base = mkCircle('ring-base', line, 10);
    const prog = mkCircle('ring-prog', accent, 10);
    const over = mkCircle('ring-over', orange, 10);
    [prog, over].forEach((c) => { c.setAttribute('stroke-dasharray', '0 ' + C); });
    svg.append(base, prog, over);
    const center = el('div', { class: 'r-center' }, [clockEl]);
    const ring = el('div', { class: 'speak-ring' });
    ring.append(svg, center);
    const resultEl = el('div', { class: 'r-result', style: 'display:none' });
    wrap.append(promptEl, stageEl, ring, resultEl, el('div', { class: 'r-btns' }, [pauseBtn, stopBtn]), cancelBtn);

    const setRing = (c2, frac) => c2.setAttribute('stroke-dasharray', Math.max(0, Math.min(1, frac)) * C + ' ' + C);
    const startStage = () => {
      stageEl.textContent = '줄여 말하기 ' + (stage + 1) + '/' + stages.length + ' 단계 — 목표 ' + F.fmtClock(target());
      clockEl.classList.remove('over');
      setRing(prog, 0); setRing(over, 0);
      resultEl.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';
      timer = setInterval(() => {
        const t = sess.activeMs / 1000, tg = target();
        if (t <= tg) { clockEl.textContent = F.fmtClock(Math.ceil(tg - t)); setRing(prog, t / tg); }
        else { clockEl.classList.add('over'); clockEl.textContent = '+' + Math.max(1, Math.ceil(t - tg)); setRing(prog, 1); setRing(over, Math.min(1, (t - tg) / tg)); }
      }, 100);
    };
    stopBtn.onclick = async () => {
      clearInterval(timer);
      const heardP = asr ? asr.done() : Promise.resolve('');
      const { blob, durationMs } = await sess.stop();
      const durS = durationMs / 1000, tg = target();
      const dropped = sp.drop10 && durationMs < 10000;   // 잘못 누른 짧은 녹음은 버린다 (스위치를 끄면 짧아도 저장)
      if (!dropped) await spSaveTake(prompt, 'step', tg, blob, durationMs, await heardP);
      const r = F.overUnder(tg, durS);
      const last = stage >= stages.length - 1;
      resultEl.textContent = '';
      resultEl.append(
        el('b', null, dropped ? (stage + 1) + '단계 — 10초가 안 되어 저장 안 함' : (stage + 1) + '단계 끝 — ' + r.text),
        el('div', { class: 'count' }, dropped ? '잘못 누른 녹음으로 보고 버렸어요 (입트기 화면의 스위치로 끌 수 있음)' : '목표 ' + F.fmtClock(tg) + ' · 말함 ' + F.fmtClock(durS)),
        el('div', null, last
          ? [el('button', { class: 'btn primary big', onclick: finishAll }, '끝내기')]
          : [el('button', { class: 'btn primary big', onclick: async () => {
              stage++;
              try { sess = await R.session(); } catch (e) { toast('마이크를 다시 열지 못했습니다'); finishAll(); return; }
              asr = spAsrStart();
              paused = false; pauseBtn.textContent = '⏸';
              startStage();
            } }, '다음 단계 (' + F.fmtClock(stages[stage + 1]) + ')'),
            el('button', { class: 'btn big', style: 'margin-left:8px', onclick: finishAll }, '여기서 끝')]),
      );
      resultEl.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      if (state.view === 'speak') render();   // 뒤 목록에 방금 기록이 보이게
    };
    startStage();
  }

  // 입트기 화면
  function renderSpeak() {
    spAudioLoadIds();
    if (supa.refresh && Date.now() - (sp.lastSync || 0) > SUPA_AUTO_MS && !speakSyncBusy) speakSync();
    if (!sp.syncMsg && !supa.refresh) sp.syncMsg = '설정 › 아이폰 동기화에서 로그인하면 아이폰과 동기화됩니다 (오디오 제외)';
    const wrap = el('div');
    const head = el('div', { class: 'speak-head' }, [
      el('span', { class: 'stats', text: spStats() }),
      el('button', { class: 'btn', title: '아무 프롬프트나 하나 열기', onclick: () => {
        const pool = sp.prompts.filter((p) => !p.deleted);
        if (!pool.length) return;
        const recent = Date.now() - 3 * DAY;
        const fresh = pool.filter((p) => !spTakesOf(p.id).some((t) => t.at > recent));
        const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh.length : pool.length))];
        const gk = pick.cat === 'mine' ? 'mine' : pick.kind + ':' + pick.cat;
        if (sp.collapsed.has(gk)) { sp.collapsed.delete(gk); saveSpeak(); }   // 접힌 범주는 자동으로 펼친다
        sp.open = pick.id; sp.importOpen = false; render();
        setTimeout(() => { const n = document.querySelector('[data-sp="' + pick.id + '"]'); if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
      } }, '🎲 아무거나'),
      el('button', { class: 'btn' + (sp.importOpen ? ' primary' : ''), onclick: () => { sp.importOpen = !sp.importOpen; render(); } }, '＋ 추가'),
      el('button', { class: 'btn' + (sp.edit ? ' primary' : ''), onclick: () => { sp.edit = !sp.edit; render(); } }, sp.edit ? '편집 끝' : '✎ 편집'),
      el('button', { class: 'btn', onclick: () => speakSync() }, '동기화'),
      infoBtn('speakFluency'),
    ]);
    wrap.append(head, el('p', { class: 'speak-sync', text: sp.syncMsg || '' }));
    wrap.append(el('label', { class: 'switch-row speak-drop10' }, [
      el('span', null, '10초 안에 끝낸 녹음은 저장하지 않기 (잘못 누른 녹음 거르기)'),
      el('input', { type: 'checkbox', class: 'switch', checked: sp.drop10, onchange: (e) => { sp.drop10 = e.target.checked; saveSpeak(); } }),
    ]));

    if (sp.importOpen) {
      const ta = el('textarea', { placeholder: '한 줄에 하나씩 — 여러 줄을 붙여 넣으면 줄마다 프롬프트가 됩니다.\n예)\nTell me about your weekend.\nHow do you handle a noisy class?' });
      const kindSel = el('select', { class: 'btn' }, [el('option', { value: 'short' }, '짧게 답하기'), el('option', { value: 'long' }, '길게 말하기')]);
      wrap.append(el('div', { class: 'speak-import' }, [
        ta,
        el('div', { class: 'row' }, [
          kindSel,
          el('button', { class: 'btn primary', onclick: () => {
            const n = spAddPrompts(ta.value, kindSel.value);
            if (!n) { toast('추가할 줄이 없습니다'); return; }
            toast('프롬프트 ' + n + '개를 추가했습니다');
            sp.importOpen = false; render();
          } }, '추가'),
          el('span', { class: 'count' }, '내 프롬프트로 들어갑니다 (편집에서 힌트를 적을 수 있어요)'),
        ]),
      ]));
    }

    const visible = sp.prompts.filter((p) => !p.deleted);
    SPEAK_GROUPS.forEach(([gkey, gtitle]) => {
      const list = visible.filter((p) => (gkey === 'mine' ? p.cat === 'mine' : p.kind + ':' + p.cat === gkey));
      if (!list.length) return;
      const closed = sp.collapsed.has(gkey);
      wrap.append(el('div', { class: 'speak-group' + (closed ? ' closed' : ''), 'data-g': gkey, title: closed ? '펼치기' : '접기', onclick: () => {
        if (closed) sp.collapsed.delete(gkey); else sp.collapsed.add(gkey);
        saveSpeak(); render();
      } }, (closed ? '▸ ' : '▾ ') + gtitle + ' · ' + list.length));
      if (!closed) list.forEach((p) => wrap.append(speakPromptCard(p)));
    });
    return wrap;
  }

  function speakPromptCard(p) {
    const takes = spTakesOf(p.id);
    const open = sp.open === p.id && !sp.edit;
    const card = el('div', { class: 'speak-p' + (open ? ' open' : ''), 'data-sp': p.id });
    if (sp.edit) {
      const ti = el('input', { value: p.text, placeholder: '프롬프트 (영어 문장)' });
      ti.oninput = () => { p.text = ti.value; spMarkP(p); };
      const hi = el('input', { value: p.hint || '', placeholder: '힌트 — 쓰면 좋은 표현·단어 (비워도 됨)' });
      hi.oninput = () => { p.hint = hi.value; spMarkP(p); };
      card.append(el('div', { class: 'speak-edit-row' }, [ti, hi,
        el('div', null, [el('button', { class: 'btn danger', onclick: () => { p.deleted = true; spMarkP(p); render(); } }, '🗑 이 프롬프트 지우기')])]));
      return card;
    }
    const headRow = el('div', { class: 'p-head', onclick: () => { sp.open = open ? null : p.id; render(); } }, [
      el('span', { class: 'p-text', text: p.text }),
      el('span', { class: 'p-meta', text: takes.length ? takes.length + '회 · ' + fmtWhen(takes[0].at) : '' }),
    ]);
    card.append(headRow);
    if (!open) return card;

    const body = el('div', { class: 'speak-body' });
    body.append(el('div', { class: 'speak-bigbtns' }, [
      el('button', { class: 'btn primary', onclick: () => openSpeakRec(p, 'free') }, '🎙 자유 말하기'),
      el('button', { class: 'btn', onclick: () => openSpeakRec(p, 'step') }, '⏱ 줄여 말하기 ' + sp.stages.map((s2) => F.fmtClock(s2)).join('→')),
    ]));
    const hintOn = sp.hintOpen.has(p.id);
    body.append(el('button', { class: 'btn', style: 'justify-self:start', onclick: () => { if (hintOn) sp.hintOpen.delete(p.id); else sp.hintOpen.add(p.id); render(); } }, hintOn ? '💡 힌트 감추기' : '💡 힌트 보이기'));
    if (hintOn) body.append(el('div', { class: 'speak-hint', text: p.hint || '힌트가 없습니다 — ✎ 편집에서 적어 둘 수 있어요.' }));
    takes.forEach((t) => body.append(speakTakeRow(t)));
    card.append(body);
    return card;
  }

  // 기록 줄을 왼쪽으로 밀면(마우스로 끌어도) 오른쪽에 빨간 삭제 버튼이 나온다 — 아이폰과 같은 몸짓
  function spAttachSwipe(row, inner, onDelete) {
    const del = el('button', { class: 't-del', onclick: (e) => { e.stopPropagation(); onDelete(); } }, '삭제');
    row.append(del);
    const W = 76;
    let sx = 0, sy = 0, base = 0, cur = 0, drag = false, horiz = false;
    const apply = (anim) => {
      inner.style.transition = anim ? 'transform .16s' : 'none';
      inner.style.transform = cur ? 'translateX(' + cur + 'px)' : '';
      row.dataset.swiped = cur <= -W / 2 ? '1' : '';
    };
    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.t-del') || e.target.closest('textarea')) return;
      drag = true; horiz = false; sx = e.clientX; sy = e.clientY; base = cur;
      try { row.setPointerCapture(e.pointerId); } catch (e2) { /* 합성 이벤트 */ }
    });
    row.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!horiz) { if (Math.abs(dx) < 9 || Math.abs(dx) <= Math.abs(dy)) return; horiz = true; }
      cur = Math.min(0, Math.max(-W - 14, base + dx));
      apply(false);
    });
    let swallowUntil = 0;
    const settle = () => {
      if (!drag) return;
      drag = false;
      if (!horiz) return;
      horiz = false;
      swallowUntil = performance.now() + 350;   // 밀고 손을 뗀 그 자리의 클릭이 바로 지우기를 누르지 않게
      cur = cur < -W / 2 ? -W : 0;
      apply(true);
    };
    row.addEventListener('pointerup', settle);
    row.addEventListener('pointercancel', settle);
    // 민 직후의 클릭은 삼키고, 열려 있을 때 아무 데나 누르면 닫는다
    row.addEventListener('click', (e) => {
      if (performance.now() < swallowUntil) { e.stopPropagation(); e.preventDefault(); return; }
      if (cur && !e.target.closest('.t-del')) { cur = 0; apply(true); e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  function speakTakeRow(t) {
    const row = el('div', { class: 'speak-take' });
    const inner = el('div', { class: 't-inner' });
    const line = el('div', { class: 't-line' });
    line.append(el('span', { class: 't-when', text: fmtWhen(t.at) }));
    line.append(el('span', { class: 't-badge', text: (t.mode === 'step' ? '줄여 ' + F.fmtClock(t.targetS) : '자유') + ' · ' + F.fmtClock(t.durMs / 1000) }));
    if (t.mode === 'step' && t.targetS) {
      const r = F.overUnder(t.targetS, t.durMs / 1000);
      line.append(el('span', { class: r.diff > 0 ? 't-over' : r.diff < 0 ? 't-under' : 'count', text: r.text }));
    }
    const w = F.wpm(t.heard, t.durMs);
    if (w) line.append(el('span', { class: 't-wpm', text: w + ' wpm' }));
    if (sp.audioIds.has(t.id)) {
      line.append(el('button', { class: 'icon', title: '재생', onclick: async () => { const b = await spAudioGet(t.id); if (b) R.play(b); else toast('소리 파일이 없습니다'); } }, '▶'));
    } else {
      line.append(el('span', { class: 'speak-nolocal', title: '오디오는 동기화하지 않습니다', text: '소리는 녹음한 기기에' }));
    }
    const heardOn = sp.heardOpen.has(t.id);
    line.append(el('button', { class: 'icon' + (heardOn ? ' on' : ''), title: '받아 적은 문장 (음성 인식)', onclick: () => { if (heardOn) sp.heardOpen.delete(t.id); else sp.heardOpen.add(t.id); render(); } }, 'T'));
    const memoOn = sp.memoOpen.has(t.id);
    line.append(el('button', { class: 'icon' + (t.memo ? ' on' : ''), title: '메모', onclick: () => { if (memoOn) sp.memoOpen.delete(t.id); else sp.memoOpen.add(t.id); render(); } }, '📝'));
    const stars = el('span', { class: 'speak-stars', title: '스스로 평가 (별점)' });
    for (let i = 1; i <= 5; i++) stars.append(el('button', { class: (t.rating || 0) >= i ? 'on' : '', onclick: () => { t.rating = t.rating === i ? 0 : i; spMarkT(t); render(); } }, '★'));
    line.append(stars);
    inner.append(line);
    if (memoOn) {
      const ta = el('textarea', { class: 't-memo', placeholder: '메모 — 막힌 데, 다음에 쓸 표현…' });
      ta.value = t.memo || '';
      ta.onchange = () => { t.memo = ta.value; spMarkT(t); };
      inner.append(ta);
    }
    if (heardOn) inner.append(el('p', { class: 't-heard', text: t.heard ? '들린 문장: ' + t.heard : '이 녹음은 받아 적지 못했습니다 (조용했거나 이 브라우저의 음성 인식이 지원되지 않음)' }));
    row.append(inner);
    spAttachSwipe(row, inner, () => { t.deleted = true; spMarkT(t); spAudioDel(t.id); render(); });
    return row;
  }

  // ───────── 라우팅/렌더 ─────────
  function route() {
    if (state.shadow && state.view === 'shadow') { state.shadow.gen++; state.shadow.busy = false; }
    const m = /^#\/(\w+)/.exec(location.hash);
    state.view = m && ['list', 'quiz', 'words', 'known', 'settings', 'shadow', 'today', 'speak'].includes(m[1]) ? m[1] : 'list';
    render();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.edit.on && !isEditable(e.target)) setEdit(false); });
  document.addEventListener('focusout', () => { if (renderPending) setTimeout(() => { if (renderPending && !(document.activeElement && document.activeElement.classList.contains('comment'))) render(); }, 50); });

  function render() {
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('comment')) { renderPending = true; return; }
    renderPending = false;
    editSync = null;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
    const app = $('#app');
    app.textContent = '';
    const titles = { list: '저장한 자막', quiz: '퀴즈', words: '단어장', known: '알고 있는 표현', settings: '설정', shadow: '쉐도잉', today: '오늘의 훈련', speak: '입트기' };
    document.title = 'SubTutor · ' + titles[state.view];
    switch (state.view) {
      case 'list': app.append(renderList(learning(), 'learning')); break;
      case 'known': app.append(renderList(known(), 'known')); break;
      case 'quiz': app.append(renderQuiz()); break;
      case 'words': app.append(renderWords()); break;
      case 'settings': app.append(renderSettings()); break;
      case 'shadow': app.append(renderShadow()); break;
      case 'today': app.append(renderToday()); break;
      case 'speak': app.append(renderSpeak()); break;
      default: break;
    }
    renderClipStates();
    syncVeils(); // 목록이 문서에 붙은 뒤에 감추기 상태를 입힌다
    renderTrimBoxes();
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
  // ── 에피소드 오디오 플레이어: 익스텐션이 뽑은 통째 MP3 를 그 작품 묶음 맨 위에서 듣는다 ──
  const recSkipS = () => clampNum(+(localStorage.getItem('st.recSkip') || 3) || 3, 1, 60);
  const recRate = () => clampNum(+(localStorage.getItem('st.recRate') || 1) || 1, 0.5, 2);
  const epi = { audio: null, id: null, paint: null };   // 한 번에 하나만 재생
  function epiStop() {
    if (epi.audio) { try { epi.audio.pause(); } catch (e) { /* ignore */ } }
    const paint = epi.paint;
    epi.audio = null; epi.id = null; epi.paint = null;
    if (paint) paint();
  }
  function epiRowEl(rec) {
    const row = el('div', { class: 'epi-audio' });
    const playBtn = el('button', { class: 'btn mini ea-play', title: '이 에피소드의 통째 오디오 재생 (맥 폴더의 MP3)' }, '▶');
    const seek = el('input', { type: 'range', class: 'ea-seek', min: 0, max: Math.max(1, Math.round(rec.durMs / 1000)), step: 1, value: 0 });
    const timeEl = el('span', { class: 'count ea-time', text: '0:00 / ' + F.fmtClock(rec.durMs / 1000) });
    const rateEl = el('span', { class: 'count ea-rate', title: '재생 속도', text: recRate().toFixed(1) + '×' });
    let dragging = false;
    const mine = () => (epi.id === rec.id ? epi.audio : null);
    const paint = () => {
      const a = mine();
      playBtn.textContent = a && !a.paused ? '⏸' : '▶';
      if (a && !dragging) { seek.value = Math.round(a.currentTime); timeEl.textContent = F.fmtClock(a.currentTime) + ' / ' + F.fmtClock(a.duration && isFinite(a.duration) ? a.duration : rec.durMs / 1000); }
    };
    const ensure = async () => {
      if (mine()) return epi.audio;
      epiStop();
      playBtn.textContent = '…';
      const blob = await recsFetchBlob(rec);
      const a = new Audio(URL.createObjectURL(blob));
      a.playbackRate = recRate();
      try { a.preservesPitch = true; } catch (e) { /* ignore */ }
      a.addEventListener('timeupdate', paint);
      a.addEventListener('ended', paint);
      a.addEventListener('pause', paint);
      a.addEventListener('play', paint);
      epi.audio = a; epi.id = rec.id; epi.paint = paint;
      return a;
    };
    playBtn.onclick = async () => {
      try {
        const a = await ensure();
        if (a.paused) a.play(); else a.pause();
        paint();
      } catch (e) { playBtn.textContent = '▶'; toast(String((e && e.message) || e), 7000); }
    };
    const skip = async (d) => { try { const a = await ensure(); a.currentTime = Math.max(0, a.currentTime + d); if (a.paused) a.play(); paint(); } catch (e) { toast(String((e && e.message) || e), 6000); } };
    seek.oninput = () => { dragging = true; };
    seek.onchange = async () => { try { const a = await ensure(); a.currentTime = +seek.value; } catch (e) { /* ignore */ } dragging = false; };
    const rateBtn = (d, label, title) => el('button', { class: 'btn mini', title, onclick: () => {
      const v = Math.round(clampNum(recRate() + d, 0.5, 2) * 10) / 10;
      try { localStorage.setItem('st.recRate', String(v)); } catch (e) { /* ignore */ }
      const a = mine();
      if (a) a.playbackRate = v;
      rateEl.textContent = v.toFixed(1) + '×';
    } }, label);
    row.append(
      el('span', { class: 'ea-label', text: '🎧 에피소드 오디오 · ' + F.fmtClock(rec.durMs / 1000) }),
      playBtn,
      el('button', { class: 'btn mini', title: recSkipS() + '초 뒤로 (설정 › 아이폰 동기화에서 초 변경)', onclick: () => skip(-recSkipS()) }, '⏪'),
      el('button', { class: 'btn mini', title: recSkipS() + '초 앞으로', onclick: () => skip(recSkipS()) }, '⏩'),
      seek, timeEl,
      rateBtn(-0.1, '−', '더 늦게 듣기'), rateEl, rateBtn(0.1, '＋', '더 빠르게 듣기'),
    );
    return row;
  }

  function renderList(items, kind) {
    const wrap = el('div');
    const titles = Array.from(new Set(items.map((i) => i.title))).sort((a, b) => a.localeCompare(b, 'ko'));
    if (state.filterTitle && !titles.includes(state.filterTitle)) state.filterTitle = '';
    const body = el('div', { class: 'list-body' });
    const countEl = el('span', { class: 'count' });
    let lastFiltered = [];
    const renderBodyInner = () => {
      body.textContent = '';
      const q = S.normalizeForCompare(state.search);
      const filtered = items.filter((i) => (!state.filterTitle || i.title === state.filterTitle) && (!state.filterTag || (i.tags || []).includes(state.filterTag)) && (!q || S.normalizeForCompare(i.text + ' ' + (i.comment || '')).includes(q) || (i.translation || '').includes(state.search.trim())));
      lastFiltered = filtered;
      countEl.textContent = filtered.length + '개' + (state.filterTag ? ' · 태그 "' + state.filterTag + '"' : '');
      if (!filtered.length) {
        body.append(el('div', { class: 'empty' }, items.length ? (state.filterTag ? '이 태그가 붙은 자막이 없습니다.' : '검색 결과가 없습니다.') : (kind === 'learning'
          ? [el('b', null, '아직 저장한 자막이 없습니다.'), el('br'), '넷플릭스에서 영상을 재생하고 자막 옆의 ', el('b', null, '☆'), ' 를 누르거나 ', el('kbd', null, 'E'), ' 키를 누르면 여기에 모입니다.']
          : [el('b', null, '아직 "알고 있어"로 옮긴 표현이 없습니다.'), el('br'), '퀴즈에서 ', el('kbd', null, 'C'), ' 를 누르면 이 상자로 이동합니다.'])));
        return;
      }
      const sort = state.sort;
      const bySaved = (dir) => (a, b) => dir * ((a.savedAt || 0) - (b.savedAt || 0)) || (a.startMs - b.startMs);
      if (sort === 'flat-new-top' || sort === 'flat-new-bottom') {
        // 작품 구분 없이 저장 시각순 (각 항목에 작품 이름을 표시)
        const flat = filtered.slice().sort(bySaved(sort === 'flat-new-top' ? -1 : 1));
        const gEl = el('div', { class: 'group' });
        flat.forEach((it) => gEl.append(itemEl(it, kind, { showWork: true })));
        body.append(gEl);
        syncVeils();
        return;
      }
      const groups = new Map();
      for (const it of filtered) {
        const key = it.title + '\u0000' + (it.episode || '');
        if (!groups.has(key)) groups.set(key, { title: it.title, episode: it.episode || '', items: [], latest: 0, earliest: Infinity });
        const g = groups.get(key);
        g.items.push(it);
        g.latest = Math.max(g.latest, it.savedAt || 0);
        g.earliest = Math.min(g.earliest, it.savedAt || 0);
      }
      const list = Array.from(groups.values());
      if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'ko') || a.episode.localeCompare(b.episode, 'ko', { numeric: true }));
      else if (sort === 'group-new-bottom') list.sort((a, b) => a.latest - b.latest); // 최신 작품이 아래
      else list.sort((a, b) => b.latest - a.latest); // 최신 작품이 위
      for (const g of list) {
        if (sort === 'group-new-top') g.items.sort(bySaved(-1));
        else if (sort === 'group-new-bottom') g.items.sort(bySaved(1));
        else g.items.sort((a, b) => a.startMs - b.startMs);
        const plat = g.items.every((i) => i.platform === g.items[0].platform) ? platformName(g.items[0].platform) : '';
        const gEl = el('div', { class: 'group' }, [
          el('h3', { class: 'group-title' }, [g.title + (plat ? ' (' + plat + ')' : ''), g.episode ? el('small', null, g.episode) : null, el('small', null, g.items.length + '개'), state.edit.on ? el('button', { class: 'btn mini group-pick', title: '이 묶음의 대사를 모두 선택/해제', onclick: () => togglePickMany(g.items.map((i) => i.id)) }, '묶음 선택') : null]),
        ]);
        if (kind === 'learning' && !state.edit.on && state.recs.length) {   // 이 에피소드의 통째 오디오가 있으면 맨 위에 플레이어
          const full = g.title + (g.episode ? ' ' + g.episode : '');
          const rec = state.recs.filter((r) => !r.skip && r.title === full && r.file && r.file.location === 'folder').sort((a, b) => (b.at || 0) - (a.at || 0))[0];
          if (rec) gEl.append(epiRowEl(rec));
        }
        g.items.forEach((it) => gEl.append(itemEl(it, kind)));
        body.append(gEl);
      }
      syncVeils();
    };
    const renderBody = () => { renderBodyInner(); if (editSync) editSync(); };
    const sel = el('select', { onchange: (e) => { state.filterTitle = e.target.value; renderBody(); } }, [el('option', { value: '' }, '모든 작품')].concat(titles.map((t) => el('option', { value: t, selected: t === state.filterTitle }, t))));
    const search = el('input', { type: 'search', placeholder: '자막 · 번역 · 코멘트 검색', value: state.search, oninput: debounce((e) => { state.search = e.target.value; renderBody(); }, 150) });
    const SORTS = [['group-time', '작품별 · 영상 시간순'], ['group-new-top', '작품별 · 최신 저장이 위'], ['group-new-bottom', '작품별 · 최신 저장이 아래'], ['flat-new-top', '전체 · 최신 저장이 위'], ['flat-new-bottom', '전체 · 최신 저장이 아래'], ['title', '작품 이름순 · 영상 시간순']];
    if (!SORTS.some(([v]) => v === state.sort)) state.sort = 'group-time';
    const sort = el('select', { class: 'sort', title: '정렬', onchange: (e) => { state.sort = e.target.value; savePref('subtutor.sort', state.sort); renderBody(); } }, SORTS.map(([v, t]) => el('option', { value: v, selected: state.sort === v }, t)));
    const hideBtn = (f) => el('button', { class: 'btn hide-toggle', 'data-field': f, onclick: () => setGlobalHide(f, !state.hide[f]) }, '');
    const editUi = buildEditUi(items, body, () => lastFiltered);
    editSync = editUi.sync;
    wrap.classList.toggle('editing', state.edit.on);
    const viewCtl = state.edit.on ? [] : [infoBtn('sort'), hideBtn('text'), hideBtn('ko'), infoBtn('veil'), repeatButton(), infoBtn('repeat')]; // 편집 중에는 자리를 비워 한 줄에 들어가게
    if (kind === 'learning' && !state.edit.on) { const tc = todayCard(); if (tc) wrap.append(tc); } // 첫 화면 맨 위: 오늘의 훈련
    wrap.append(buildTagBar(renderBody), el('div', { class: 'toolbar' }, [sel, search, sort].concat(viewCtl, [countEl, el('span', { class: 'spacer' }), editButton(), editUi.bar])), body);
    renderBody();
    syncVeils();
    return wrap;
  }
  function itemEl(it, kind, opts) {
    opts = opts || {};
    const node = el('div', { class: 'item' + (kind === 'known' ? ' known' : '') + (it.translation ? '' : ' no-ko'), 'data-clip-item': it.id, 'data-id': it.id });
    const play = el('button', { class: 'play', title: '이 대사 재생', onclick: () => playItem(it.id) }, '▶');
    const pick = state.edit.on ? el('input', { type: 'checkbox', class: 'pick', title: '선택', checked: state.edit.sel.has(it.id), onchange: (e) => setPick(it.id, e.target.checked) }) : null;
    if (state.edit.on) {
      node.classList.toggle('selected', state.edit.sel.has(it.id));
      node.addEventListener('click', (e) => { if (e.target.closest('button, input, textarea, select, a, label, .trim-box, .rec-row, .tags-row')) return; setPick(it.id, !state.edit.sel.has(it.id)); });
    }
    const playCol = el('div', { class: 'play-col' }, [pick, play, state.web.ladder ? el('button', { class: 'ladder', title: ladderTitle(), onclick: () => playLadder(it.id) }, '⤴') : null, state.web.ladder && understood(it) ? el('button', { class: 'ladder fast', title: fastTitle(), onclick: () => playFast(it.id) }, '⏩') : null]);
    const rates = rateBtns(it); // 설정한 배속이 그대로: [0.8] [0.9] [1] [1.15]
    const body = el('div', { class: 'body' }, [
      el('div', { class: 'vis-btns' }, [
        el('button', { class: 'btn mini vis-text', title: '이 대사의 자막 보기/감추기', onclick: () => setItemVeil(it.id, 'text', !isVeiled(it.id, 'text')) }, '자막'),
        el('button', { class: 'btn mini vis-ko', title: '이 대사의 뜻 보기/감추기', onclick: () => setItemVeil(it.id, 'ko', !isVeiled(it.id, 'ko')) }, '뜻'),
        rates.length ? el('span', { class: 'rate-btns' }, rates) : null,
      ]),
      el('div', { class: 'en', text: it.text }),
      el('button', { class: 'veil veil-text-btn', title: '자막 보기', onclick: () => setItemVeil(it.id, 'text', false) }, '자막 감춤 · 눌러서 보기'),
      el('div', { class: 'ko', text: it.translation || '' }),
      el('button', { class: 'veil veil-ko-btn', title: '뜻 보기', onclick: () => setItemVeil(it.id, 'ko', false) }, '뜻 감춤 · 눌러서 보기'),
      el('div', { class: 'meta' }, [
        opts.showWork ? el('span', { class: 'work' }, it.title + ' (' + platformName(it.platform) + ')' + (it.episode ? ' · ' + it.episode : '')) : null,
        el('span', { class: 'span' }, timeText(it)),
        fmtBadge(it),
        el('span', null, '저장 ' + fmtDate(it.savedAt || Date.now())),
        it.reviews ? el('span', null, '복습 ' + it.reviews + '회' + (it.forgot ? ' · 잊음 ' + it.forgot : '')) : null,
        el('button', { class: 'link', onclick: () => B.request('item.open', { itemId: it.id }, 60000).catch((e) => toast(e.message)) }, '플레이어에서 열기 ↗'),
        el('span', { class: 'state' }),
      ]),
      el('div', { class: 'item-actions' }, [buildTagRow(it), buildRecRow(it.id)]), // + 태그 · 녹음 · 1 · 같이 듣기 · ⓘ 를 한 줄에
      it.missed && !state.edit.on ? reasonRow(it) : null, // Q 문장: 못 알아들은 원인 원터치 (선택)
      buildTrimBox(it),
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
      el('button', { class: 'btn trim-toggle' + (state.trimOpen === it.id ? ' on' : '') + (effRange(it).trimmed ? ' trimmed' : ''), 'data-id': it.id, title: '오디오 재생 구간을 ms 단위로 조정', onclick: () => toggleTrim(it) }, '⏱ 구간 조정'),
      el('button', { class: 'btn danger', onclick: () => bulkDelete([it.id], '이 대사') }, '삭제'),
    ]);
    node.append(playCol, body, el('div', { class: 'side' }, [comment, actions]));
    return node;
  }
  // 작은 오디오 형식 배지: ♪ 보관 오디오 · ⬇ PC 파일(복사본 있음) · 주황 ⬇ PC 파일만(누르면 MP3 폴더에서 불러오기)
  function fmtBadge(it) {
    const up = (s, d) => String(s || d).toUpperCase();
    const khz = (a) => (a && a.rate ? ' · ' + Math.round(a.rate / 1000) + 'kHz' : '');
    if (it.file) {
      const readable = it.file.location === 'folder' || !!it.audio; // 지정 폴더면 재생할 때 읽어 오고, 복사본이 있으면 그것으로 재생
      const title = 'PC 파일 ' + up(it.file.format, 'mp3') + ': ' + (it.file.path || '') + (it.audio
        ? ' · 웹 재생용 복사본도 있음' + khz(it.audio)
        : (readable ? ' — 재생할 때 이 파일을 읽습니다 (MP3 는 이 파일 하나)' : ' · 확장 프로그램이 읽을 수 없는 곳입니다 — 여기를 눌러 MP3 폴더에서 불러오세요'));
      return el(readable ? 'span' : 'button', { class: 'fmt file' + (readable ? ' stored' : ' only'), title, onclick: readable ? null : () => importMp3Folder() }, '⬇ ' + up(it.file.format, 'mp3'));
    }
    if (it.audio) return el('span', { class: 'fmt stored', title: '보관 오디오 ' + up(it.audio.format, 'wav') + khz(it.audio) + (it.audio.ms ? ' · ' + (it.audio.ms / 1000).toFixed(1) + '초' : '') + ' — 플레이어 탭 없이 바로 재생' }, '♪ ' + up(it.audio.format, 'wav'));
    return null;
  }

  // ───────── 퀴즈 ─────────
  function renderQuiz() {
    const wrap = el('div', { class: 'quiz-wrap' });
    if (state.nzQuiz) { wrap.append(state.nzQuiz.pos >= state.nzQuiz.queue.length ? nzSummary() : nzCard()); return wrap; }
    const q = state.quiz;
    if (!q) { wrap.append(quizSetup()); return wrap; }
    while (q.pos < q.queue.length && !state.items.find((i) => i.id === q.queue[q.pos])) q.pos++;
    if (q.pos >= q.queue.length) { wrap.append(quizSummary()); return wrap; }
    wrap.append(quizCard());
    return wrap;
  }
  // ── NZ 모음 미니 퀴즈: 저장한 오디오를 듣고 들린 단어를 2지선다로 (pen vs pin) ──
  // 헷갈리는 짝이 있는 단어(pen/pin, bat/bet, ear/air …)가 든 저장 문장 가운데 오디오가 있는 것으로 문제를 만든다. 적으면 적은 대로
  function nzQuestions() {
    if (!NZV) return [];
    const out = [];
    for (const it of state.items) {
      if (!(it.audio || (it.file && it.file.location === 'folder'))) continue; // 바로 재생할 소리가 있는 것만
      const hit = NZV.find(it.text || '', 3).find((h) => h.pair);
      if (!hit) continue;
      out.push({ itemId: it.id, word: hit.word, pair: hit.pair, hint: hit.hint, typeLabel: hit.typeLabel, sentence: it.text });
      if (out.length >= 12) break;
    }
    return out;
  }
  function startNzQuiz() {
    const qs = shuffle(nzQuestions().slice());
    if (!qs.length) { toast('해당 단어(pen·pin 같은 짝)가 든, 오디오 있는 저장 문장이 아직 없습니다'); return; }
    state.nzQuiz = { queue: qs, pos: 0, picked: null, stats: { ok: 0, bad: 0 }, playedFor: null };
    render();
  }
  function nzCard() {
    const z = state.nzQuiz;
    const q = z.queue[z.pos];
    const options = z.optionsFor === z.pos ? z.options : (z.options = shuffle([q.word, q.pair]), z.optionsFor = z.pos, z.options);
    const picked = z.picked;
    const card = el('div', { class: 'quiz-card nz-card', 'data-clip-item': q.itemId }, [
      el('div', { class: 'quiz-top' }, [el('span', null, ['NZ 모음 미니 퀴즈', infoBtn('nzVowels')]), el('span', null, (z.pos + 1) + ' / ' + z.queue.length + '  ·  맞음 ' + z.stats.ok + ' · 틀림 ' + z.stats.bad)]),
      el('div', { class: 'progress' }, el('div', { style: 'width:' + Math.round((z.pos / z.queue.length) * 100) + '%' })),
      el('p', { class: 'step-desc' }, '듣고, 문장에 나온 단어를 고르세요 (뉴질랜드 발음은 두 단어가 비슷하게 들립니다)'),
      el('div', { class: 'quiz-audio' }, [el('button', { class: 'btn primary big play', 'data-label': '듣기', onclick: () => playItem(q.itemId, { loop: false }) }, '▶ 듣기'), el('span', { class: 'count' }, 'Space'), el('span', { class: 'clip-state state' })]),
      el('div', { class: 'nz-opts' }, options.map((w) => el('button', { class: 'btn big nz-opt' + (picked ? (w === q.word ? ' right' : (w === picked ? ' wrong' : '')) : ''), disabled: !!picked, onclick: () => pickNz(w) }, w))),
    ]);
    if (picked) {
      card.append(
        el('div', { class: 'quiz-result' }, [
          el('div', { class: 'score' }, picked === q.word ? [el('b', null, '맞았습니다!')] : [el('b', null, '정답: ' + q.word), ' — NZ 발음에서는 ' + q.pair + ' 와 비슷하게 들립니다']),
          el('div', { class: 'answer en' }, sentenceWithWord(q.sentence, q.word)),
          el('p', { class: 'count' }, q.hint + ' · ' + q.typeLabel),
          el('div', { class: 'quiz-actions' }, [el('button', { class: 'btn primary', onclick: nextNz }, (z.pos + 1 < z.queue.length ? '다음' : '결과 보기') + ' (Enter)')]),
        ]),
      );
    }
    if (z.playedFor !== z.pos) { z.playedFor = z.pos; if (state.extOk) setTimeout(() => playItem(q.itemId, { loop: false }), 60); }
    return card;
  }
  function pickNz(w) {
    const z = state.nzQuiz;
    if (!z || z.picked) return;
    z.picked = w;
    if (w === z.queue[z.pos].word) z.stats.ok++; else z.stats.bad++;
    render();
  }
  function nextNz() {
    const z = state.nzQuiz;
    if (!z || !z.picked) return;
    stopLocalAudio();
    z.picked = null;
    z.pos++;
    render();
  }
  function nzSummary() {
    const z = state.nzQuiz;
    return el('div', { class: 'quiz-card summary' }, [
      el('h2', null, 'NZ 모음 퀴즈 끝!'),
      el('div', { class: 'nums' }, [el('div', null, [el('b', null, String(z.stats.ok)), '맞음']), el('div', null, [el('b', null, String(z.stats.bad)), '틀림'])]),
      el('p', { class: 'count' }, '틀린 짝은 플레이어의 NZ 모음 주석(점선 밑줄)으로 눈으로 확인하며 들어 보세요.'),
      el('div', { class: 'row', style: 'display:flex;gap:10px;justify-content:center' }, [
        el('button', { class: 'btn primary big', onclick: () => { state.nzQuiz = null; render(); } }, '퀴즈로'),
        el('button', { class: 'btn big', onclick: startNzQuiz }, '한 번 더'),
      ]),
    ]);
  }
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'quiz' || !state.nzQuiz || isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const z = state.nzQuiz;
    if (z.pos >= z.queue.length) return;
    if (e.code === 'Space') { e.preventDefault(); playItem(z.queue[z.pos].itemId, { loop: false }); }
    else if (e.code === 'Enter' && z.picked) { e.preventDefault(); nextNz(); }
  });

  function quizSetup() {
    const pool = learning();
    const titles = Array.from(new Set(pool.map((i) => i.title))).sort((a, b) => a.localeCompare(b, 'ko'));
    const due = dueItems().length;
    const box = el('div', { class: 'quiz-setup' }, [
      el('h2', null, ['받아쓰기 퀴즈', infoBtn('dictation'), state.web.srs ? infoBtn('srs') : null]),
      el('div', { class: 'row' }, [
        el('label', null, '작품 '),
        el('select', { onchange: (e) => { state.quizPrefs.title = e.target.value; } }, [el('option', { value: '' }, '모든 작품 (' + pool.length + ')')].concat(titles.map((t) => el('option', { value: t, selected: t === state.quizPrefs.title }, t + ' (' + pool.filter((i) => i.title === t).length + ')')))),
        state.tagNames.length ? el('label', null, '태그 ') : null,
        state.tagNames.length ? el('select', { onchange: (e) => { state.quizPrefs.tag = e.target.value; } }, [el('option', { value: '' }, '모든 태그')].concat(state.tagNames.map((t) => el('option', { value: t, selected: t === state.quizPrefs.tag }, t + ' (' + pool.filter((i) => (i.tags || []).includes(t)).length + ')')))) : null,
        el('label', null, '순서 '),
        el('select', { onchange: (e) => { state.quizPrefs.order = e.target.value; } }, [state.web.srs ? el('option', { value: 'due', selected: state.quizPrefs.order === 'due' }, '복습 예정순') : null, el('option', { value: 'oldest', selected: state.quizPrefs.order === 'oldest' }, '오래 안 본 것부터'), el('option', { value: 'random', selected: state.quizPrefs.order === 'random' }, '무작위'), el('option', { value: 'saved', selected: state.quizPrefs.order === 'saved' }, '저장한 순서')]),
        state.web.srs ? el('label', null, [el('input', { type: 'checkbox', checked: state.quizPrefs.dueOnly, onchange: (e) => { state.quizPrefs.dueOnly = e.target.checked; } }), ' 복습 예정인 카드만 (' + due + ')']) : null,
        el('label', null, [el('input', { type: 'checkbox', checked: state.quizPrefs.autoplay, onchange: (e) => { state.quizPrefs.autoplay = e.target.checked; } }), ' 자동 재생']),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary big', disabled: !pool.length || !state.extOk, onclick: startQuiz }, '퀴즈 시작'),
        el('button', { class: 'btn big nz-start', disabled: !state.extOk || !nzQuestions().length, title: 'pen·pin 처럼 NZ 발음에서 비슷해지는 짝 단어가 든, 오디오 있는 저장 문장으로 만듭니다', onclick: startNzQuiz }, 'NZ 모음 미니 퀴즈' + (nzQuestions().length ? ' (' + nzQuestions().length + ')' : '')),
        el('span', { class: 'count' }, !state.extOk ? '확장 프로그램이 연결되어야 오디오를 들을 수 있습니다' : (pool.length ? (state.web.srs ? '오늘 복습 ' + due + '개 · ' : '') + '학습 중 ' + pool.length + '개 · 알고 있음 ' + known().length + '개' : '먼저 자막을 저장해 주세요')),
        infoBtn('keys'),
      ]),
    ]);
    return box;
  }
  function startQuiz() {
    let pool = learning().filter((i) => (!state.quizPrefs.title || i.title === state.quizPrefs.title) && (!state.quizPrefs.tag || (i.tags || []).includes(state.quizPrefs.tag)));
    if (state.web.srs && state.quizPrefs.dueOnly) { const d = pool.filter(isDue); if (d.length) pool = d; else toast('복습 예정인 카드가 없어 전체를 냅니다'); }
    if (!state.web.srs && state.quizPrefs.order === 'due') state.quizPrefs.order = 'oldest';
    if (state.quizPrefs.order === 'due') pool = pool.slice().sort((a, b) => dueOf(a) - dueOf(b));
    else if (state.quizPrefs.order === 'random') pool = shuffle(pool.slice());
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
        repeatButton(),
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
        it.missed ? reasonRow(it) : null,
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
    if (state.web.weakWords) {
      const missing = q.result.ops.filter((o) => o.type === 'missing').map((o) => String(o.word).toLowerCase().replace(/[^a-z']/g, '')).filter(Boolean);
      if (missing.length) B.request('stats.weak', { words: missing }).catch(() => {});
      // 놓친 단어가 축약·연음 구간이면 패턴(gonna, didja …)으로도 센다
      const red = Sp && Sp.reductionMisses ? Sp.reductionMisses(it.text, missing) : [];
      if (red.length) B.request('stats.reduction', { patterns: red.map((r) => ({ to: r.pattern, src: r.src })) }).catch(() => {});
    }
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
    const rv = it.review || {};
    if (kind === 'forgot') {
      patch.forgot = (it.forgot || 0) + 1;
      q.stats.forgot++;
      const n = q.requeued[it.id] || 0;
      if (n < 2) { q.requeued[it.id] = n + 1; q.queue.splice(Math.min(q.queue.length, q.pos + 4), 0, it.id); }
      if (state.web.srs) patch.review = { due: Date.now() + DAY, interval: 1, reps: 0, lapses: (rv.lapses || 0) + 1 };
    } else {
      q.stats.know++;
      if (state.web.srs) {
        const reps = (rv.reps || 0) + 1;
        const interval = INTERVALS[Math.min(INTERVALS.length - 1, reps - 1)];
        patch.review = { due: Date.now() + interval * DAY, interval, reps, lapses: rv.lapses || 0 };
        if (interval >= 30) { patch.box = 'known'; patch.knownAt = Date.now(); toast('30일 간격까지 통과 → 알고 있는 표현으로'); }
        else toast('다음 복습: ' + interval + '일 뒤');
      } else { patch.box = 'known'; patch.knownAt = Date.now(); }
    }
    B.request('stats.review', { kind }).catch(() => {});
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
    if (state.view === 'shadow' && state.shadow) {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const it = currentShadowItem();
      if (!it) return;
      if (e.code === 'Space') { e.preventDefault(); shadowPlay(); }
      else if (e.code === 'KeyN') { e.preventDefault(); shadowNext(); }
      else if (e.code === 'KeyR') toggleRecord(it.id);
      return;
    }
    if ((state.view !== 'quiz' && todayStageKind() !== 'dict') || !state.quiz) return; // 오늘의 훈련의 받아쓰기 단계도 같은 키
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

  // ───────── 단어장: 플레이어 패널의 '단어 목록'에서 ☆ 로 저장한 단어 → 카드 복습 ─────────
  // 앞면: 단어 + 그 단어가 쓰인 자막 문장 / 뒷면: 뜻(기계 번역) + 문장 번역. 다음 복습 시각은 확장 프로그램이 정한다
  // (알고 있어요 → 1·3·7·14·30·60·120일 뒤, 잘 모름 → 10분 뒤 다시, 간격은 처음부터)
  const WORD_STEPS = [1, 3, 7, 14, 30, 60, 120];
  const wordDue = (w) => (w.review && Number.isFinite(w.review.due) ? w.review.due : (w.savedAt || 0));
  const dueWords = () => state.words.filter((w) => wordDue(w) <= Date.now());
  const isEditingWord = () => !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('word-meaning'));
  const wordsSignature = (ws) => ws.map((w) => [w.word, w.meaning, w.sentence, wordDue(w), w.review ? w.review.level : 0].join('\u0001')).join('\u0002');
  async function loadWords() {
    if (!state.extOk) return;
    let list;
    try { const r = await B.request('words.list'); list = (r && r.words) || []; } catch (e) { return; }
    const changed = wordsSignature(list) !== wordsSignature(state.words);
    state.words = list;
    updateWordCount();
    if (changed && state.view === 'words' && !isEditingWord()) render();
  }
  function updateWordCount() {
    const b = $('#count-words');
    if (!b) return;
    const n = dueWords().length;
    b.textContent = n ? String(n) : '';
    b.title = n ? '오늘 복습할 단어 ' + n + '개' : '';
  }
  function fmtDueIn(ms) {
    const d = ms - Date.now();
    if (d <= 0) return '지금';
    if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + '분 뒤';
    if (d < DAY - 1800000) return Math.round(d / 3600000) + '시간 뒤'; // 하루에서 몇 초 모자란 것은 "1일 뒤" (24시간 뒤가 아니라)
    return Math.max(1, Math.round(d / DAY)) + '일 뒤';
  }
  const nextKnowDays = (w) => WORD_STEPS[Math.min(WORD_STEPS.length, ((w.review && w.review.level) || 0) + 1) - 1];
  const wordSource = (w) => (w.source && w.source.title ? w.source.title + (w.source.episode ? ' · ' + w.source.episode : '') : '');
  // 예문에서 그 단어를 강조한다
  function sentenceWithWord(sentence, word) {
    const out = el('span', { class: 'word-sent' });
    for (const part of String(sentence || '').split(/(\s+)/)) {
      const bare = part.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z]+|[^a-z]+$/g, '');
      out.append(bare && bare === word ? el('b', { class: 'hl' }, part) : part);
    }
    return out;
  }
  function renderWords() {
    const wrap = el('div', { class: 'quiz-wrap words-wrap' });
    const rv = state.wordReview;
    if (rv) {
      while (rv.pos < rv.queue.length && !state.words.find((w) => w.word === rv.queue[rv.pos])) rv.pos++;
      wrap.append(rv.pos >= rv.queue.length ? wordSummary() : wordCard());
      return wrap;
    }
    const due = dueWords().length;
    wrap.append(el('div', { class: 'quiz-setup' }, [
      el('h2', null, ['단어장', infoBtn('words')]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary big', disabled: !due || !state.extOk, onclick: () => startWordReview(false) }, '복습 시작' + (due ? ' (' + due + ')' : '')),
        el('button', { class: 'btn big', disabled: !state.words.length || !state.extOk, onclick: () => startWordReview(true) }, '모두 복습'),
        el('span', { class: 'count' }, !state.extOk ? '확장 프로그램이 연결되어야 단어장을 볼 수 있습니다' : (state.words.length ? '저장 ' + state.words.length + '개 · 오늘 복습 ' + due + '개' : '플레이어 패널의 "단어 목록"에서 ☆ 로 단어를 저장하세요')),
        infoBtn('keys'),
      ]),
    ]));
    if (!state.words.length) return wrap;
    const list = el('div', { class: 'word-list' });
    state.words.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).forEach((w) => {
      list.append(el('div', { class: 'word-row', 'data-word': w.word }, [
        el('div', { class: 'word-main' }, [
          el('b', { class: 'word-w' }, w.word),
          el('input', { class: 'word-meaning', value: w.meaning || '', placeholder: '뜻', title: '뜻 고치기 (자동 저장)', onchange: (e) => saveWordMeaning(w.word, e.target.value), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
        ]),
        el('div', { class: 'word-ex' }, [
          w.sentence ? sentenceWithWord(w.sentence, w.word) : null,
          el('div', { class: 'word-meta' }, [wordSource(w), (wordSource(w) ? ' · ' : '') + '다음 복습 ' + fmtDueIn(wordDue(w))].join('')),
        ]),
        el('button', { class: 'word-del', title: '단어장에서 지우기', onclick: () => removeWord(w.word) }, '✕'),
      ]));
    });
    wrap.append(list);
    return wrap;
  }
  async function saveWordMeaning(word, meaning) {
    const w = state.words.find((x) => x.word === word);
    if (w) w.meaning = meaning;
    try { await B.request('words.update', { word, patch: { meaning } }); } catch (e) { toast('저장 실패: ' + e.message); }
  }
  async function removeWord(word) {
    state.words = state.words.filter((x) => x.word !== word);
    updateWordCount();
    render();
    try { await B.request('words.remove', { word }); } catch (e) { toast('삭제 실패: ' + e.message); loadWords(); }
  }
  function startWordReview(all) {
    const pool = (all ? state.words.slice() : dueWords()).sort((a, b) => wordDue(a) - wordDue(b));
    if (!pool.length) { toast('복습할 단어가 없습니다'); return; }
    state.wordReview = { queue: pool.map((w) => w.word), pos: 0, flipped: false, stats: { know: 0, forgot: 0 }, requeued: {} };
    render();
  }
  function wordCard() {
    const rv = state.wordReview;
    const w = state.words.find((x) => x.word === rv.queue[rv.pos]);
    const total = rv.queue.length;
    const card = el('div', { class: 'quiz-card word-card' + (rv.flipped ? ' flipped' : '') });
    card.append(
      el('div', { class: 'quiz-top' }, [el('span', null, wordSource(w) || '단어장'), el('span', null, (rv.pos + 1) + ' / ' + total + '  ·  알고 있어요 ' + rv.stats.know + ' · 잘 모름 ' + rv.stats.forgot)]),
      el('div', { class: 'progress' }, el('div', { style: 'width:' + Math.round((rv.pos / total) * 100) + '%' })),
      el('div', { class: 'word-front' }, [
        el('div', { class: 'word-big' }, w.word),
        w.sentence ? el('div', { class: 'word-example' }, sentenceWithWord(w.sentence, w.word)) : null,
      ]),
    );
    if (!rv.flipped) {
      card.append(el('div', { class: 'quiz-actions center' }, [el('button', { class: 'btn primary big word-flip', onclick: flipWord }, '뜻 보기 (Space)')]));
    } else {
      card.append(el('div', { class: 'word-back' }, [
        el('div', { class: 'word-mean' }, w.meaning || '(뜻 없음)'),
        w.sentenceKo ? el('div', { class: 'ko' }, w.sentenceKo) : null,
        el('div', { class: 'grade' }, [
          el('button', { class: 'btn forgot', onclick: () => gradeWord('forgot') }, 'Z  잘 모름 — 10분 뒤 다시'),
          el('button', { class: 'btn know', onclick: () => gradeWord('know') }, 'C  알고 있어요 — ' + nextKnowDays(w) + '일 뒤'),
        ]),
      ]));
    }
    return card;
  }
  function flipWord() {
    const rv = state.wordReview;
    if (!rv || rv.flipped || rv.pos >= rv.queue.length) return;
    rv.flipped = true;
    render();
  }
  async function gradeWord(result) {
    const rv = state.wordReview;
    if (!rv || !rv.flipped || rv.pos >= rv.queue.length) return;
    const word = rv.queue[rv.pos];
    if (result === 'forgot') {
      rv.stats.forgot++;
      const n = rv.requeued[word] || 0; // 이번 복습 안에서도 몇 장 뒤에 다시 (두 번까지)
      if (n < 2) { rv.requeued[word] = n + 1; rv.queue.splice(Math.min(rv.queue.length, rv.pos + 4), 0, word); }
    } else rv.stats.know++;
    rv.pos++; rv.flipped = false;
    render();
    try { await B.request('words.review', { word, result }); } catch (e) { toast('저장 실패: ' + e.message); }
  }
  function wordSummary() {
    const rv = state.wordReview;
    return el('div', { class: 'quiz-card summary' }, [
      el('h2', null, '단어 복습 끝!'),
      el('div', { class: 'nums' }, [el('div', null, [el('b', null, String(rv.stats.know)), '알고 있어요']), el('div', null, [el('b', null, String(rv.stats.forgot)), '잘 모름'])]),
      el('div', { class: 'row', style: 'display:flex;gap:10px;justify-content:center' }, [
        el('button', { class: 'btn primary big', onclick: () => { state.wordReview = null; render(); } }, '단어장으로'),
      ]),
    ]);
  }
  document.addEventListener('keydown', (e) => {
    if ((state.view !== 'words' && todayStageKind() !== 'words') || !state.wordReview) return; // 오늘의 훈련의 단어 단계도 같은 키
    if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
    const rv = state.wordReview;
    if (rv.pos >= rv.queue.length) return;
    if ((e.code === 'Space' || e.code === 'Enter') && !rv.flipped) { e.preventDefault(); flipWord(); }
    else if (e.code === 'KeyZ' && rv.flipped) gradeWord('forgot');
    else if (e.code === 'KeyC' && rv.flipped) gradeWord('know');
  });

  // ───────── 설정 ─────────
  function renderSettings() {
    const wrap = el('div', { class: 'settings' });
    const total = state.items.length;
    const reviews = state.items.reduce((a, i) => a + (i.reviews || 0), 0);
    const fileOnly = state.items.filter(needsImport).length; // 확장 프로그램이 읽을 수 없는 곳(다운로드 폴더 등)에 MP3 만 있는 대사
    const fileCount = state.items.filter((i) => i.file).length;
    const recCount = el('b', null, '…');
    R.listAll().then((all) => { recCount.textContent = String(all.length); }).catch(() => { recCount.textContent = '0'; });
    const fileInput = el('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const items = Array.isArray(data) ? data : (data.items || []);
        const r = await B.request('items.import', { items });
        const w = data && Array.isArray(data.words) ? await B.request('words.import', { words: data.words }) : null;
        toast('가져오기 완료: 새 항목 ' + r.added + '개 (총 ' + r.total + '개)' + (w ? ' · 새 단어 ' + w.added + '개' : ''));
        loadItems(); loadWords();
      } catch (err) { toast('가져오기 실패: ' + err.message); }
      e.target.value = '';
    } });
    const toggle = (key, label, infoKey) => el('label', { class: 'switch-row' }, [el('span', null, [label, infoBtn(infoKey || key)]), el('input', { type: 'checkbox', class: 'switch', 'data-pref': key, checked: !!state.web[key], onchange: (e) => { saveWebPrefs({ [key]: e.target.checked }).then(() => { updateCounts(); render(); }); } })]);
    const goal = el('input', { type: 'date', class: 'goal', value: state.web.goalDate || '', onchange: (e) => saveWebPrefs({ goalDate: e.target.value }).then(() => render()) });
    wrap.append(
      el('section', null, [
        el('h3', null, ['학습 기능', infoBtn('twoPass')]),
        el('div', { class: 'switches' }, [toggle('srs', '간격 반복 복습'), toggle('weakWords', '약점 단어'), toggle('dashboard', '진행 상황'), toggle('recommend', '추천 콘텐츠'), toggle('shadow', '쉐도잉 세션', 'shadowSession'), toggle('ladder', '속도 사다리 ⤴', 'ladder')]),
        state.web.ladder ? renderLadderCfg() : null,
        renderDubRecCfg(),
        el('div', { class: 'row' }, [el('label', null, ['근무 시작일 ', goal]), infoBtn('dashboard')]),
      ]),
      state.web.dashboard ? renderDashboard() : null,
      state.web.weakWords ? renderWeakWords() : null,
      state.web.recommend ? renderRecommend() : null,
      el('section', null, [
        el('h3', null, '화면'),
        el('div', { class: 'row' }, [el('label', null, ['테마 ', el('select', { class: 'theme-sel', onchange: (e) => setTheme(e.target.value) }, THEMES.map(([v, t]) => el('option', { value: v, selected: state.theme === v }, t)))])]),
      ]),
      el('section', null, [
        el('h3', null, '통계'),
        el('div', { class: 'stats' }, [
          el('div', null, [el('b', null, String(learning().length)), el('span', null, '학습 중')]),
          el('div', null, [el('b', null, String(state.web.srs ? dueItems().length : 0)), el('span', null, '오늘 복습')]),
          el('div', null, [el('b', null, String(known().length)), el('span', null, '알고 있는 표현')]),
          el('div', null, [el('b', null, String(total)), el('span', null, '전체')]),
          el('div', null, [el('b', null, String(reviews)), el('span', null, '총 복습 횟수')]),
          el('div', null, [recCount, el('span', null, '녹음 파일')]),
        ]),
      ]),
      el('section', null, [
        el('h3', null, ['데이터', infoBtn('storedAudio')]),
        renderBackupLine(),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', disabled: !state.extOk, onclick: () => {
            const blob = new Blob([JSON.stringify({ app: 'SubTutor', exportedAt: new Date().toISOString(), items: state.items, words: state.words }, null, 2)], { type: 'application/json' });
            const a = el('a', { href: URL.createObjectURL(blob), download: 'subtutor-items-' + fmtDate(Date.now()).replace(/\./g, '') + '.json' });
            document.body.append(a); a.click(); a.remove();
          } }, '자막·단어장 내보내기 (JSON)'),
          el('button', { class: 'btn', disabled: !state.extOk, onclick: () => fileInput.click() }, '자막·단어장 가져오기'),
          fileInput,
          el('button', { class: 'btn mp3-import', disabled: !state.extOk, onclick: () => importMp3Folder() }, 'MP3 폴더에서 불러오기' + (fileOnly ? ' (' + fileOnly + '개 대기)' : '')),
          infoBtn('mp3Import'),
          el('button', { class: 'btn danger', disabled: !state.extOk, onclick: async () => {
            if (!confirm('저장한 자막 ' + total + '개를 모두 삭제할까요? 보관 오디오' + (fileCount ? '와 PC 에 저장한 MP3 파일 ' + fileCount + '개' : '') + '도 함께 지워집니다. 되돌릴 수 없습니다.')) return;
            const r = await B.request('items.clear', {}, 120000).catch((e) => { toast(e.message); return null; });
            if (r && r.files && r.files.failed && r.files.failed.length) toast('자막은 모두 지웠지만 MP3 파일 ' + r.files.failed.length + '개는 지우지 못했습니다 (' + (FAIL_REASON[r.files.failed[0].reason] || r.files.failed[0].reason) + ')', 8000);
            audioCache.clear(); bufferCache.clear(); stretchCache.clear(); fileIssue.clear();
            loadItems();
          } }, '자막 모두 삭제'),
          el('button', { class: 'btn danger', onclick: async () => {
            if (!confirm('녹음 파일을 모두 삭제할까요?')) return;
            await R.clearAll(); state.recordings.clear(); render(); toast('녹음을 모두 삭제했습니다');
          } }, '녹음 모두 삭제'),
        ]),
      ]),
      renderPhoneSync(),
      renderSiteLinks(),
      el('section', null, [
        el('h3', null, ['확장 프로그램', infoBtn('audioStore')]),
        el('p', null, [state.extOk ? '연결됨 · 버전 ' + (B.version || '') : '감지되지 않음', ' · ', el('a', { href: README_URL, target: '_blank', rel: 'noopener' }, '설치 방법·사용법'), ' · ', el('button', { class: 'link', onclick: () => showInfo('keys') }, '⌨ 단축키')]),
      ]),
    );
    return wrap;
  }

  // ── 지원 사이트: 전용 어댑터 4곳 + 범용 어댑터 사이트(sites.js) + "아무 사이트" 안내 ──
  function renderSiteLinks() {
    const dedicated = [
      ['Netflix', 'https://www.netflix.com/', '영화·드라마 (구독)'],
      ['YouTube', 'https://www.youtube.com/', '무료 — 자막(CC) 있는 영상이면 어디든'],
      ['Prime Video', 'https://www.primevideo.com/', '영화·드라마 (구독)'],
      ['Disney+', 'https://www.disneyplus.com/', '영화·드라마 (구독, 실험적 지원)'],
    ];
    const generic = ((typeof SubTutorSites !== 'undefined' && SubTutorSites.SITES) || []).filter((x) => x.home);
    const row = (label, href, about) => el('li', { class: 'site-row' }, [
      el('a', { class: 'site-link', href, target: '_blank', rel: 'noopener' }, label),
      about ? el('span', { class: 'site-about' }, about) : null,
    ]);
    return el('section', null, [
      el('h3', null, ['확장 프로그램이 되는 사이트', infoBtn('anySite')]),
      el('p', { class: 'count' }, '확장 프로그램을 켠 크롬에서 아래 사이트의 영상을 재생하면 자막 패널이 뜹니다. 저장한 대사는 이 웹과 아이폰으로 이어집니다.'),
      el('ul', { class: 'site-links' }, dedicated.map((d) => row(d[0], d[1], d[2]))),
      el('ul', { class: 'site-links' }, generic.map((x) => row(x.label, x.home, x.about))),
      el('p', { class: 'count' }, '여기 없는 영상 사이트는 그 사이트를 연 채 확장 아이콘(팝업)에서 "이 사이트에서 켜기"를 누르면 똑같이 동작합니다 (플레이어가 자막을 글(WebVTT·DASH·HLS 등)로 받는 사이트).'),
    ]);
  }

  // ── 아이폰 동기화 (SubTutor Pocket): 대사·단어장·보관 MP3 를 Supabase 로 올린다. 아이폰 앱이 같은 계정으로 내려받는다 ──
  // 기본 접속 정보: 본인 Supabase 프로젝트(supabase/schema.sql 참고)를 만들면 아래 두 상수에 넣는다.
  // 그러면 웹·아이폰 모두 이메일·비밀번호만 입력하면 된다 (anon 키는 공개용 키 — RLS 가 본인 데이터만 지킨다)
  const SUPA_DEFAULT_URL = 'https://fovhngfqueolqhemymqa.supabase.co';
  const SUPA_DEFAULT_KEY = 'sb_publishable_vfA8_n_-kbOoBuTSKahwwg_G-0cPMfN'; // publishable 키 — 공개용 (데이터는 RLS 로 본인 것만)
  const supa = {
    url: localStorage.getItem('st.supaUrl') || SUPA_DEFAULT_URL,
    key: localStorage.getItem('st.supaKey') || SUPA_DEFAULT_KEY,
    email: localStorage.getItem('st.supaEmail') || '',
    refresh: localStorage.getItem('st.supaRefresh') || '',   // 로그인 유지용 (비밀번호는 저장하지 않는다)
    auto: localStorage.getItem('st.supaAuto') !== '0',       // 자동 동기화 (기본 켬)
    lastAt: +(localStorage.getItem('st.supaLastAt') || 0),   // 마지막 올리기 (자동이든 버튼이든)
    token: null, userId: null, exp: 0, busy: false,
    advOpen: false, // "고급" 펼침 — 설정 화면이 다시 그려져도 유지
  };
  // 이미 올라간 오디오 id (자동 동기화 때 새 소리만 올리려고 기억해 둔다)
  const supaUploaded = new Set(JSON.parse(localStorage.getItem('st.supaUp') || '[]'));
  // 마지막으로 올린 태그·box (3-way 비교의 기준) — {id: {t: [...], b: 'learning'|'known'}}
  const loadSupaBase = () => { try { return JSON.parse(localStorage.getItem('st.supaBase') || '{}') || {}; } catch (e) { return {}; } };
  const saveSupaBase = (b) => { try { localStorage.setItem('st.supaBase', JSON.stringify(b)); } catch (e) { /* 용량 */ } };
  const saveSupaUploaded = () => { try { localStorage.setItem('st.supaUp', JSON.stringify(Array.from(supaUploaded))); } catch (e) { /* 용량 초과면 다음에 다시 올린다 */ } };
  const supaSafeName = (x) => String(x).replace(/[^A-Za-z0-9._-]/g, '_'); // 아이폰 앱 Item.safeName 과 같은 규칙이어야 한다
  // 영상 오디오(통째 MP3) 서버 파일 이름: rec/<id>.<길이 base36>.<제목 base64url>.mp3 — 표 없이 Storage 목록만으로 제목·길이를 안다
  const b64u = (x) => btoa(unescape(encodeURIComponent(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (x) => { try { return decodeURIComponent(escape(atob(String(x).replace(/-/g, '+').replace(/_/g, '/')))); } catch (e) { return ''; } };
  const recStoreName = (r) => 'rec/' + r.id + '.' + Math.max(0, Math.round(r.durMs)).toString(36) + '.' + b64u(String(r.title || '').slice(0, 60)) + '.mp3';
  const parseRecStore = (name) => {
    const m = /^(r[0-9a-z]+)\.([0-9a-z]+)\.([A-Za-z0-9_-]*)\.mp3$/.exec(String(name || ''));
    if (!m) return null;
    return { id: m[1], durMs: parseInt(m[2], 36) || 0, title: unb64u(m[3]) || '영상 오디오', at: parseInt(m[1].slice(1), 36) || 0 };
  };
  function supaBase() { return supa.url.trim().replace(/\/+$/, ''); }
  // Supabase 의 흔한 영어 오류를 한글로
  function supaKo(m) {
    const s = String(m || '');
    if (/Invalid login credentials/i.test(s)) return '이메일 또는 비밀번호가 틀렸습니다';
    if (/already registered|already exists/i.test(s)) return '이미 가입된 이메일입니다 — "로그인"을 누르세요';
    const pw = /Password should be at least (\d+)/i.exec(s);
    if (pw) return '비밀번호는 ' + pw[1] + '자 이상이어야 합니다';
    if (/Signups not allowed/i.test(s)) return '새 가입이 꺼져 있습니다 — 이미 만든 계정으로 "로그인"하세요';
    if (/Email not confirmed/i.test(s)) return '이메일 확인이 켜진 설정입니다 — Supabase 에서 Confirm email 을 끄세요';
    if (/rate limit/i.test(s)) return '요청이 너무 잦습니다 — 잠시 뒤에 다시 해 보세요';
    if (/validate email|invalid format|email address .* invalid/i.test(s)) return '이메일 형식이 올바르지 않습니다';
    return s;
  }
  async function supaFetch(path, opts) {
    let r;
    try { r = await fetch(supaBase() + path, opts); }
    catch (e) { throw new Error('서버에 닿지 못했습니다 — URL 을 확인하세요'); }
    if (!r.ok) {
      let msg = '';
      try { const j = await r.json(); msg = j.error_description || j.msg || j.message || j.error || ''; } catch (e) { /* 본문 없음 */ }
      throw new Error(supaKo(msg) || ('HTTP ' + r.status));
    }
    return r;
  }
  async function supaSignIn(password, signup) {
    if (!supaBase() || !supa.key.trim()) throw new Error('프로젝트 URL 과 anon 키를 먼저 넣으세요');
    if (!supa.email.trim() || !password) throw new Error('이메일과 비밀번호를 넣으세요');
    const r = await supaFetch(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: supa.key.trim() },
      body: JSON.stringify({ email: supa.email.trim(), password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error('확인 메일이 켜진 프로젝트입니다 — 메일함에서 확인한 뒤 "로그인"을 누르세요');
    supaSession(j);
  }
  function supaSession(j) {
    supa.token = j.access_token;
    supa.userId = (j.user && j.user.id) || supa.userId || '';
    supa.exp = Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000;
    if (j.refresh_token) { supa.refresh = j.refresh_token; try { localStorage.setItem('st.supaRefresh', j.refresh_token); } catch (e) { /* ignore */ } }
  }
  // 로그인 유지: 저장해 둔 refresh 토큰으로 조용히 다시 로그인한다 (만료 전이면 그대로)
  async function supaEnsureToken() {
    if (supa.token && Date.now() < supa.exp) return;
    if (!supa.refresh) throw new Error('먼저 로그인하세요');
    const r = await supaFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: supa.key.trim() },
      body: JSON.stringify({ refresh_token: supa.refresh }),
    }).catch((e) => { supa.refresh = ''; localStorage.removeItem('st.supaRefresh'); throw new Error('로그인이 풀렸습니다 — 다시 로그인하세요 (' + e.message + ')'); });
    supaSession(await r.json().catch(() => ({})));
    if (!supa.token) throw new Error('로그인이 풀렸습니다 — 다시 로그인하세요');
  }
  function supaSignOut() {
    supa.token = null; supa.userId = null; supa.refresh = ''; supa.exp = 0;
    localStorage.removeItem('st.supaRefresh');
  }
  async function supaUpload(onStep, opts) {
    await supaEnsureToken();
    if (supa.busy) throw new Error('이미 올리는 중입니다');
    supa.busy = true;
    try { return await supaUploadInner(onStep, opts || {}); } finally { supa.busy = false; }
  }
  async function supaUploadInner(onStep, opts) {
    const H = { apikey: supa.key.trim(), Authorization: 'Bearer ' + supa.token };
    // 0) 아이폰에서 바꾼 태그·알아요(box)를 먼저 받아 온다. 필드마다 3-way 로 비교한다:
    //    base = 마지막으로 올린 값, remote = 서버(아이폰이 바꿨을 수 있다), local = 확장 프로그램(웹에서 바꿨을 수 있다).
    //    remote 만 바뀌었으면 remote 를 받고, 둘 다 바뀌었으면 나중에 바꾼 쪽(서버 updated_at ↔ 확장 tagsAt/boxAt).
    //    base 가 없는 대사(처음)는 시각만 비교한다. 서버 updated_at 은 웹이 올릴 때는 그대로이고 아이폰이 바꿀 때만 새로 찍힌다
    const supaBase = loadSupaBase();
    try {
      const since = new Date(Math.max(0, (supa.lastAt || 0) - 1000)).toISOString();
      const pr = await supaFetch('/rest/v1/items?select=id,tags,box,updated_at&updated_at=gt.' + encodeURIComponent(since), { headers: H });
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      for (const row of await pr.json()) {
        const it = state.items.find((x) => x.id === row.id);
        if (!it) continue;
        const at = Date.parse(row.updated_at) || 0;
        const base = supaBase[it.id];
        const take = (remote, local, baseVal, localAt) => {
          if (same(remote, local)) return false;
          if (!base) return at > (localAt || 0);
          const remoteChanged = !same(remote, baseVal), localChanged = !same(local, baseVal);
          return remoteChanged && (!localChanged || at > (localAt || 0));
        };
        const patch = {};
        const rTags = Array.isArray(row.tags) ? row.tags : [];
        if (take(rTags, it.tags || [], base && base.t, it.tagsAt)) { patch.tags = rTags; patch.tagsAt = at; }
        const rBox = row.box || 'learning';
        if (take(rBox, it.box || 'learning', base && base.b, it.boxAt)) { patch.box = rBox; patch.boxAt = at; }
        if (Object.keys(patch).length) {
          await B.request('items.update', { id: it.id, patch });
          Object.assign(it, patch);
          if (patch.tags && mergeTagNames(patch.tags)) saveTagNames();
        }
      }
    } catch (e) { /* 받아 오기에 실패해도 올리기는 계속 */ }
    // 1) 보관(또는 폴더) MP3 — 올라간 것만 has_audio 로 표시한다. 자동(incremental)일 때는 아직 안 올라간 소리만
    let audioOk = 0, audioFail = 0;
    for (let k = 0; k < state.items.length; k++) {
      const it = state.items[k];
      if (opts.incremental && supaUploaded.has(it.id)) continue;
      if (onStep) onStep('소리 올리는 중 ' + (k + 1) + '/' + state.items.length + '…');
      let blob = null;
      try { blob = await localAudioBlob(it.id); } catch (e) { blob = null; }
      if (!blob) continue; // 소리 없는 대사
      try {
        await supaFetch('/storage/v1/object/audio/' + encodeURIComponent(supa.userId) + '/' + encodeURIComponent(supaSafeName(it.id)) + '.mp3', {
          method: 'POST', headers: Object.assign({ 'Content-Type': blob.type || 'audio/mpeg', 'x-upsert': 'true' }, H), body: blob,
        });
        supaUploaded.add(it.id); audioOk++;
      } catch (e) { audioFail++; }
    }
    saveSupaUploaded();
    // 2) 대사 목록 upsert (아이폰 앱이 읽는 컬럼으로)
    if (onStep) onStep('대사 목록 올리는 중…');
    if (!supa.userId) throw new Error('로그인 정보가 없습니다 — 다시 로그인하세요');
    const rows = state.items.map((it) => { const r = effRange(it); return {
      user_id: supa.userId, id: it.id, title: it.title || '', episode: it.episode || '', platform: it.platform || '',
      text: it.text || '', translation: it.translation || '',
      start_ms: Math.round(r.startMs || 0), end_ms: Math.round(r.endMs || 0), saved_at: it.savedAt || 0,
      box: it.box || 'learning', comment: it.comment || '', tags: it.tags || [],
      missed: !!it.missed, miss_reason: it.missReason || '',
      has_audio: supaUploaded.has(it.id), audio_ms: supaUploaded.has(it.id) ? Math.max(0, Math.round((r.endMs || 0) - (r.startMs || 0))) : 0,
    }; });
    if (rows.length) await supaFetch('/rest/v1/items', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, H), body: JSON.stringify(rows) });
    const nextBase = {};
    for (const r of rows) nextBase[r.id] = { t: r.tags, b: r.box };
    saveSupaBase(nextBase);   // 다음 받아 오기의 기준 = 방금 올린 값
    // 3) 단어장 upsert
    let wordCount = 0;
    if (state.words.length) {
      if (onStep) onStep('단어장 올리는 중…');
      const ws = state.words.map((w) => ({ user_id: supa.userId, word: w.word, meaning: w.meaning || '', sentence: w.sentence || '', sentence_ko: w.sentenceKo || '', review: w.review || {}, saved_at: w.savedAt || 0 }));
      await supaFetch('/rest/v1/words', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, H), body: JSON.stringify(ws) });
      wordCount = ws.length;
    }
    supa.lastAt = Date.now();
    try { localStorage.setItem('st.supaLastAt', String(supa.lastAt)); } catch (e) { /* ignore */ }
    try { await speakSync(); } catch (e) { /* 입트기 동기화가 실패해도 올리기는 성공 */ }
    let recsUp = null;
    try { recsUp = await recsUpload(onStep); } catch (e) { /* 영상 오디오가 실패해도 올리기는 성공 */ }
    if (recsUp && recsUp.ok) toast('영상 오디오 ' + recsUp.ok + '개를 아이폰으로 올렸습니다');
    return { items: rows.length, words: wordCount, audioOk, audioFail };
  }
  // ── 영상 오디오(통째 MP3): 익스텐션 폴더에서 읽어 Supabase Storage(rec/)로 올린다 — 아이폰이 내려받아 듣는다 ──
  async function loadRecs() {
    try { state.recs = ((await B.request('recs.list')) || {}).recs || []; } catch (e) { state.recs = []; }
    if (state.view === 'list') render();
  }
  const recBlobCache = new Map();   // rec.id → Blob (한 번 읽은 파일은 다시 안 읽는다)
  async function recsFetchBlob(rec) {
    if (recBlobCache.has(rec.id)) return recBlobCache.get(rec.id);
    const parts = [];
    for (let seq = 0; seq < 60; seq++) {
      const r = await B.request('recs.data', { id: rec.id, seq }, 60000);
      if (!r || r.reason || !r.data) {
        throw new Error(r && r.reason === 'none' ? '저장 폴더가 지정돼 있지 않습니다 (팝업 › 저장 폴더)'
          : r && r.reason === 'downloads' ? '크롬 다운로드 폴더에 있어 읽지 못합니다 — 저장 폴더를 지정하면 다음 녹음부터 됩니다'
          : r && (r.reason === 'prompt' || r.reason === 'denied') ? '폴더 권한이 풀렸습니다 — 팝업의 "폴더 권한 허용"을 누르세요'
          : r && r.reason === 'missing' ? '파일이 없습니다 (지워졌거나 옮겨짐)' : '파일을 읽지 못했습니다');
      }
      parts.push(b64ToBlob(r.data, 'audio/mpeg'));
      if (r.done) break;
    }
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    recBlobCache.set(rec.id, blob);
    return blob;
  }
  // 아직 안 올라간 녹음을 올린다 (전체/자동 올리기와 같은 자리에서) — 성공하면 익스텐션 목록에 sent 표시
  async function recsUpload(onStep) {
    if (!supa.userId || !state.extOk) return { ok: 0, fail: 0 };
    let recs = [];
    try { recs = ((await B.request('recs.list')) || {}).recs || []; } catch (e) { return { ok: 0, fail: 0 }; }
    state.recs = recs;
    const todo = recs.filter((r) => !r.sent && !r.skip && r.file && r.file.location === 'folder');
    if (todo.length) await supaEnsureToken();
    let ok = 0, fail = 0, lastErr = '';
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i];
      if (onStep) onStep('영상 오디오 올리는 중 ' + (i + 1) + '/' + todo.length + ' — ' + (r.title || ''));
      try {
        const blob = await recsFetchBlob(r);
        const H = { apikey: supa.key.trim(), Authorization: 'Bearer ' + supa.token };
        await supaFetch('/storage/v1/object/audio/' + encodeURIComponent(supa.userId) + '/' + recStoreName(r).split('/').map(encodeURIComponent).join('/'), {
          method: 'POST', headers: Object.assign({ 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' }, H), body: blob,
        });
        await B.request('recs.mark', { id: r.id, patch: { sent: Date.now(), key: recStoreName(r) } });
        ok++;
      } catch (e) { fail++; lastErr = String((e && e.message) || e); }
    }
    if (ok || fail) { try { state.recs = ((await B.request('recs.list')) || {}).recs || state.recs; } catch (e) { /* ignore */ } }
    return { ok, fail, lastErr };
  }

  // 자동 동기화: 접속하고 잠시 뒤 + 15분마다, 로그인이 유지돼 있으면 조용히 올린다
  // (목록·단어 upsert 는 요청 두어 개, 소리는 새것만 — Supabase 무료 한도에 부담이 없다)
  const SUPA_AUTO_MS = 15 * 60 * 1000;
  async function supaAutoSync(force) {
    if ((!supa.auto && !force) || supa.busy || !state.extOk) return;
    if (!supaBase() || !supa.key.trim() || !supa.refresh) return;
    if (!force && Date.now() - supa.lastAt < SUPA_AUTO_MS) return;
    if (!state.items.length && !state.words.length) return;
    try {
      const r = await supaUpload(null, { incremental: true });
      const lineEl = document.querySelector('.supa-line');
      if (lineEl) lineEl.textContent = '자동 동기화 끝 (' + fmtDate(supa.lastAt) + ') — 대사 ' + r.items + '개' + (r.audioOk ? ' · 새 소리 ' + r.audioOk + '개' : '') + ' · 단어 ' + r.words + '개';
    } catch (e) { console.warn('[SubTutor] 자동 동기화 실패:', e.message); }
  }
  setTimeout(() => supaAutoSync(false), 8000);
  setInterval(() => supaAutoSync(false), 5 * 60 * 1000);
  function renderPhoneSync() {
    const line = el('p', { class: 'count supa-line' },
      supa.refresh ? ('로그인 유지 중' + (supa.lastAt ? ' · 마지막 올리기 ' + fmtDate(supa.lastAt) : '') + (supa.auto ? '' : ' — 자동 동기화 꺼짐')) : '');
    const save = () => { try { localStorage.setItem('st.supaUrl', supa.url); localStorage.setItem('st.supaKey', supa.key); localStorage.setItem('st.supaEmail', supa.email); } catch (e) { /* 시크릿 창 등 */ } };
    const input = (cls, ph, key, type) => el('input', { class: 'supa-in ' + cls, type: type || 'text', placeholder: ph, value: supa[key] || '', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { supa[key] = e.target.value; save(); } });
    const pass = el('input', { class: 'supa-in supa-pass', type: 'password', placeholder: '비밀번호 (저장하지 않음)', autocomplete: 'new-password' });
    const loginBtn = el('button', { class: 'btn supa-login' }, '로그인');
    const signupBtn = el('button', { class: 'btn supa-signup' }, '회원가입');
    const pushBtn = el('button', { class: 'btn primary supa-push' }, '아이폰으로 올리기 (전체)');
    const outBtn = supa.refresh ? el('button', { class: 'btn supa-logout', onclick: () => { supaSignOut(); render(); toast('로그아웃했습니다 (아이폰에 받아 둔 것은 그대로)'); } }, '로그아웃') : null;
    const busyBtns = [loginBtn, signupBtn, pushBtn];
    const withBusy = (fn) => async () => { busyBtns.forEach((b) => { b.disabled = true; }); try { await fn(); } finally { busyBtns.forEach((b) => { b.disabled = false; }); } };
    // 로그인하면 바로 한 번 올린다 — 유저는 이메일·비밀번호만 누르면 끝
    const afterLogin = async () => {
      line.textContent = '로그인됨 — 지금 것을 올립니다…';
      try {
        const r = await supaUpload((t) => { line.textContent = t; }, {});
        line.textContent = '올렸습니다 — 대사 ' + r.items + '개 · 소리 ' + r.audioOk + '개' + (r.audioFail ? ' (실패 ' + r.audioFail + '개)' : '') + ' · 단어 ' + r.words + '개. 아이폰 앱에서 같은 이메일로 로그인하면 내려받습니다.';
      } catch (e) { line.textContent = '로그인됨 — 올리기 실패: ' + e.message; }
    };
    loginBtn.onclick = withBusy(async () => { line.textContent = '로그인 중…'; try { await supaSignIn(pass.value, false); pass.value = ''; await afterLogin(); } catch (e) { line.textContent = '로그인 실패: ' + e.message; } });
    signupBtn.onclick = withBusy(async () => { line.textContent = '회원가입 중…'; try { await supaSignIn(pass.value, true); pass.value = ''; await afterLogin(); } catch (e) { line.textContent = '회원가입 실패: ' + e.message; } });
    pushBtn.onclick = withBusy(async () => {
      try {
        const r = await supaUpload((t) => { line.textContent = t; }, {});
        line.textContent = '올렸습니다 — 대사 ' + r.items + '개 · 소리 ' + r.audioOk + '개' + (r.audioFail ? ' (실패 ' + r.audioFail + '개)' : '') + ' · 단어 ' + r.words + '개. 아이폰 앱에서 "동기화"를 누르세요.';
        toast('아이폰으로 올렸습니다');
      } catch (e) { line.textContent = '올리기 실패: ' + e.message; }
    });
    const autoSw = el('label', { class: 'switch-row supa-auto-row' }, [el('span', null, '자동 동기화 — 접속할 때와 15분마다, 새 소리만'), el('input', { type: 'checkbox', class: 'switch supa-auto', checked: supa.auto, onchange: (e) => { supa.auto = e.target.checked; try { localStorage.setItem('st.supaAuto', supa.auto ? '1' : '0'); } catch (err) { /* ignore */ } if (supa.auto) supaAutoSync(false); } })]);
    const haveDefaults = !!(SUPA_DEFAULT_URL && SUPA_DEFAULT_KEY);
    const urlKeyRow = el('div', { class: 'row supa-row' }, [input('supa-url', '프로젝트 URL (https://xxxx.supabase.co)', 'url', 'url'), input('supa-key', 'anon public 키', 'key')]);
    return el('section', null, [
      el('h3', null, ['아이폰 동기화 (SubTutor Pocket)', infoBtn('phoneSync')]),
      el('p', { class: 'count' }, '여기 저장한 대사·단어장·보관 소리를 Supabase 로 올리면, 아이폰 앱이 같은 계정으로 내려받아 인터넷 없이도 듣습니다. 한 번 로그인하면 유지됩니다.'),
      haveDefaults ? el('details', { class: 'supa-adv', open: supa.advOpen, ontoggle: (e) => { supa.advOpen = e.target.open; } }, [el('summary', null, '고급 — 다른 Supabase 서버 쓰기'), urlKeyRow]) : urlKeyRow,
      el('div', { class: 'row supa-row' }, [input('supa-email', '이메일', 'email', 'email'), pass, loginBtn, signupBtn, pushBtn, outBtn]),
      autoSw,
      renderServerAudio(),
      line,
    ]);
  }

  // 서버 소리 관리: Supabase Storage 에 올라간 대사 MP3(작품별)와 영상 오디오(통째 MP3)를 보고 지운다 — 무료 1GB 관리용
  function renderServerAudio() {
    const box = el('details', { class: 'supa-storage' }, [el('summary', null, '서버 소리 관리 — 올라간 MP3 보기·지우기 · 영상 오디오 올리기')]);
    const body = el('div', { class: 'supa-storage-body count' }, '…');
    const skipRow = el('label', { class: 'switch-row' }, [
      el('span', null, '에피소드 오디오 플레이어 — ⏪⏩ 건너뛰는 초'),
      el('input', { type: 'number', min: 1, max: 60, step: 1, value: recSkipS(), style: 'width:70px', onchange: (e) => { try { localStorage.setItem('st.recSkip', String(clampNum(+e.target.value || 3, 1, 60))); } catch (err) { /* ignore */ } } }),
    ]);
    box.append(skipRow, body);
    let busy = false;
    const H = () => ({ apikey: supa.key.trim(), Authorization: 'Bearer ' + supa.token });
    const fmtMB = (b) => (b / 1048576 >= 100 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + 'MB';
    async function listDir(prefix) {
      const r = await supaFetch('/storage/v1/object/list/audio', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
        body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'desc' } }),
      });
      return (await r.json()) || [];
    }
    async function removeObjects(names) {
      for (let i = 0; i < names.length; i += 80) {
        await supaFetch('/storage/v1/object/audio', {
          method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
          body: JSON.stringify({ prefixes: names.slice(i, i + 80) }),
        });
      }
    }
    async function fill() {
      if (!supa.refresh || !supa.key.trim()) { body.textContent = '로그인하면 서버에 올라간 소리가 보입니다'; return; }
      body.textContent = '서버 목록 읽는 중…';
      try {
        await supaEnsureToken();
        if (!supa.userId) throw new Error('로그인 정보가 없습니다 — 다시 로그인하세요');
        const uid = supa.userId;
        const top = (await listDir(uid + '/')).filter((x) => x && x.id && /\.mp3$/i.test(x.name));
        const recsRemote = (await listDir(uid + '/rec/')).filter((x) => x && x.id);
        const size = (x) => Number((x.metadata && (x.metadata.size || x.metadata.contentLength)) || 0);
        body.textContent = '';
        // ① 대사 소리 → 작품·에피소드 묶음
        const byWork = new Map();
        const stray = { n: 0, bytes: 0, names: [] };
        let itemBytes = 0;
        for (const o of top) {
          itemBytes += size(o);
          const base = o.name.replace(/\.mp3$/i, '');
          const it = state.items.find((x) => supaSafeName(x.id) === base);
          if (!it) { stray.n++; stray.bytes += size(o); stray.names.push(uid + '/' + o.name); continue; }
          const k = (it.title || '') + (it.episode ? ' · ' + it.episode : '');
          const g = byWork.get(k) || { n: 0, bytes: 0, names: [], ids: [] };
          g.n++; g.bytes += size(o); g.names.push(uid + '/' + o.name); g.ids.push(it.id);
          byWork.set(k, g);
        }
        const delRow = (label, meta, onDel) => el('div', { class: 'row supa-obj' }, [
          el('span', { class: 'supa-obj-name', text: label }),
          el('span', { class: 'count', text: meta }),
          el('button', { class: 'btn mini danger', onclick: async (e) => {
            if (busy) return;
            busy = true;
            e.target.disabled = true;
            try { await onDel(); toast('서버에서 지웠습니다'); } catch (err) { toast('지우기 실패: ' + err.message, 6000); }
            busy = false;
            fill();
          } }, '서버에서 지우기'),
        ]);
        if (byWork.size || stray.n) {
          body.append(el('h4', null, '대사 소리 (별표 저장 MP3) — ' + fmtMB(itemBytes)));
          body.append(el('p', { class: 'count' }, '지워도 이 맥과 이미 내려받은 아이폰에는 남습니다. "아이폰으로 올리기 (전체)"를 누르면 다시 올라갑니다.'));
          for (const [k, g] of byWork) {
            body.append(delRow(k, g.n + '개 · ' + fmtMB(g.bytes), async () => {
              await removeObjects(g.names);
              for (let i = 0; i < g.ids.length; i += 50) {   // 아이폰이 내려받기 단추를 더는 보여 주지 않게
                const part = g.ids.slice(i, i + 50).map((x) => '"' + String(x).replace(/"/g, '') + '"').join(',');
                await supaFetch('/rest/v1/items?id=in.(' + encodeURIComponent(part) + ')', {
                  method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, H()),
                  body: JSON.stringify({ has_audio: false, audio_ms: 0 }),
                });
              }
            }));
          }
          if (stray.n) body.append(delRow('지워진 대사의 소리', stray.n + '개 · ' + fmtMB(stray.bytes), () => removeObjects(stray.names)));
        }
        // ② 영상 오디오 (통째 MP3)
        body.append(el('h4', null, '영상 오디오 (통째 MP3)'));
        let extRecs = [];
        try { extRecs = ((await B.request('recs.list')) || {}).recs || []; } catch (e) { extRecs = []; }
        state.recs = extRecs;
        let recBytes = 0;
        const remoteIds = new Set();
        for (const o of recsRemote) {
          const info = parseRecStore(o.name);
          if (!info) continue;
          remoteIds.add(info.id);
          recBytes += size(o);
          body.append(delRow(info.title + ' — ' + fmtWhen(info.at), F.fmtClock(info.durMs / 1000) + ' · ' + fmtMB(size(o)), async () => {
            await removeObjects([uid + '/rec/' + o.name]);
            const ext = extRecs.find((x) => x.id === info.id);
            if (ext) await B.request('recs.mark', { id: ext.id, patch: { skip: true, sent: 0 } }).catch(() => {});   // 다시 자동으로 올라가지 않게
          }));
        }
        if (recBytes) body.append(el('p', { class: 'count' }, '영상 오디오 합계 ' + fmtMB(recBytes) + ' · 아이폰 앱 목록 맨 위(에피소드 제목 아래)에서 내려받아 듣습니다'));
        const pending = extRecs.filter((r) => !r.sent && !r.skip && r.file && r.file.location === 'folder');
        const stuck = extRecs.filter((r) => !r.sent && !r.skip && (!r.file || r.file.location !== 'folder'));
        const skipped = extRecs.filter((r) => r.skip);
        if (pending.length) {
          body.append(el('div', { class: 'row' }, [
            el('span', { class: 'count' }, '아직 안 올라간 녹음 ' + pending.length + '개 — ' + pending.map((r) => r.title).slice(0, 3).join(', ') + (pending.length > 3 ? ' …' : '')),
            el('button', { class: 'btn mini primary', onclick: async (e) => {
              e.target.disabled = true;
              const st = el('span', { class: 'count' });
              e.target.after(st);
              const r = await recsUpload((m) => { st.textContent = ' ' + m; }).catch((err) => ({ ok: 0, fail: 1, lastErr: err.message }));
              toast(r.ok ? '영상 오디오 ' + r.ok + '개를 올렸습니다' : '올리지 못했습니다' + (r.lastErr ? ': ' + r.lastErr : ''), 6000);
              fill();
            } }, '지금 올리기'),
          ]));
        }
        if (stuck.length) body.append(el('p', { class: 'count' }, '크롬 다운로드 폴더라 못 읽는 녹음 ' + stuck.length + '개 — 팝업에서 저장 폴더를 지정하면 다음 녹음부터 올라갑니다'));
        for (const r of skipped) {
          body.append(el('div', { class: 'row supa-obj' }, [
            el('span', { class: 'supa-obj-name', text: r.title }),
            el('span', { class: 'count', text: '서버에서 지움 (다시 안 올라감)' }),
            el('button', { class: 'btn mini', onclick: async () => { await B.request('recs.mark', { id: r.id, patch: { skip: false } }).catch(() => {}); fill(); } }, '다시 올리기 허용'),
          ]));
        }
        if (!remoteIds.size && !pending.length && !stuck.length && !skipped.length) body.append(el('p', { class: 'count' }, '영상 오디오가 없습니다 — 플레이어 패널 아래의 "⏺ MP3" 로 뽑으면 여기서 올립니다'));
        const total = itemBytes + recBytes;
        body.append(el('p', { class: 'count' }, '서버 사용량 합계 ≈ ' + fmtMB(total) + ' (Supabase 무료 저장 1GB)'));
      } catch (e) {
        body.textContent = '서버 목록을 읽지 못했습니다: ' + ((e && e.message) || e);
      }
    }
    let loaded = false;
    box.addEventListener('toggle', () => { if (box.open && !loaded) { loaded = true; fill(); } });
    return box;
  }

  // 자동 백업 상태 줄: 폴더가 지정돼 있으면 마지막 백업·다음 조건, 아니면 백업 권장 안내
  function renderBackupLine() {
    const line = el('p', { class: 'backup-line count' });
    const btn = el('button', { class: 'btn mini backup-now', disabled: true, onclick: async () => {
      btn.disabled = true;
      try {
        const r = await B.request('backup.now', {}, 30000);
        toast(r && r.ok ? '백업 완료: ' + r.path : '백업하지 못했습니다' + (r && r.reason === 'none' ? ' — 먼저 팝업에서 저장 폴더를 지정하세요' : (r && (r.reason === 'prompt' || r.reason === 'denied') ? ' — 팝업 "폴더 권한 허용"을 누르세요' : '')), 6000);
      } catch (e) { toast('백업 실패: ' + e.message); }
      btn.disabled = false;
      fill();
    } }, '지금 백업');
    const wrap = el('div', { class: 'row backup-row' }, [line, btn, infoBtn('backup')]);
    line.textContent = state.extOk ? '자동 백업 확인 중…' : '확장 프로그램이 연결되면 자동 백업 상태가 보입니다';
    async function fill() {
      try {
        const r = await B.request('backup.status');
        const dir = r.dir || { state: 'none' };
        const m = r.meta || {};
        btn.disabled = !state.extOk;
        if (dir.state === 'none') line.textContent = '자동 백업 꺼짐 — 팝업의 "저장 폴더 → 변경…"에서 폴더를 지정하면 학습 데이터가 7일마다 JSON 으로 백업됩니다 (지금은 이 크롬 안에만 있습니다)';
        else if (dir.state !== 'granted') line.textContent = '자동 백업 멈춤 — "' + (dir.name || '') + '" 폴더 권한이 풀려 있습니다. 팝업의 "폴더 권한 허용"을 누르세요' + (m.lastAt ? ' · 마지막 백업 ' + fmtDate(m.lastAt) : '');
        else line.textContent = '자동 백업: ' + (dir.name || '') + '/SubTutor/백업 — 7일마다 또는 변경 50건마다' + (m.lastAt ? ' · 마지막 ' + fmtDate(m.lastAt) : ' · 아직 없음') + (m.changes ? ' · 그 뒤 변경 ' + m.changes + '건' : '');
      } catch (e) { line.textContent = '자동 백업 상태를 읽지 못했습니다'; }
    }
    if (state.extOk) fill();
    return wrap;
  }

  // 속도 사다리 세부 설정: 단계 수 · 단계별 배속(0.3~2.0) · 음높이 유지
  function renderLadderCfg() {
    const rates = ladderRates();
    const box = el('div', { class: 'ladder-cfg' });
    const steps = el('select', { class: 'ladder-steps', title: '사다리 단계 수', onchange: (e) => {
      // 단계 수를 바꾸면 그 단계의 기본값으로 채운다 (단순히 잘라내면 마지막이 1배속에 닿지 않는 사다리가 된다). 값은 아래에서 하나씩 고친다
      const n = +e.target.value;
      saveWebPrefs({ ladderRates: (LADDER_PRESETS[n] || LADDER_PRESETS[4]).slice() }).then(render);
    } }, Array.from({ length: LADDER_MAX_STEPS }, (_, k) => el('option', { value: k + 1, selected: rates.length === k + 1 }, (k + 1) + '단계')));
    const inputs = rates.map((r, k) => el('label', { class: 'rate-cell' }, [
      el('span', { class: 'rate-n' }, String(k + 1)),
      el('input', { type: 'number', class: 'rate', 'data-step': k, min: RATE_MIN, max: RATE_MAX, step: 0.05, value: fmtRate(r), onchange: (e) => {
        const v = Math.round(clampNum(parseFloat(e.target.value), RATE_MIN, RATE_MAX) * 100) / 100;
        const next = ladderRates().slice();
        next[k] = Number.isFinite(v) ? v : 1;
        e.target.value = fmtRate(next[k]);
        saveWebPrefs({ ladderRates: next }).then(render);
      } }),
      el('span', { class: 'rate-x' }, '×'),
    ]));
    box.append(
      el('div', { class: 'row' }, [
        el('label', null, ['단계 수 ', steps]),
        el('label', { class: 'switch-inline' }, ['음높이 유지 ', el('input', { type: 'checkbox', class: 'switch', 'data-pref': 'ladderPitch', checked: state.web.ladderPitch !== false, onchange: (e) => saveWebPrefs({ ladderPitch: e.target.checked }).then(render) })]),
        infoBtn('ladder'),
      ]),
      el('div', { class: 'rates' }, inputs),
      el('div', { class: 'row' }, [el('button', { class: 'btn mini ladder-reset', onclick: () => saveWebPrefs({ ladderRates: LADDER_PRESETS[4].slice(), ladderPitch: true }).then(render) }, '기본값 (0.8 → 0.9 → 1 → 1.15)')]),
      renderFastCfg(),
    );
    return box;
  }
  // 고속 적응 프리셋 편집: 이해 확인한 문장용 가속 단계. 마지막 단계는 1배 고정 (정상 속도가 느리게 들리게)
  function renderFastCfg() {
    const rates = fastRates();
    const steps = el('select', { class: 'fast-steps', title: '고속 적응 단계 수', onchange: (e) => saveWebPrefs({ fastRates: (FAST_PRESETS[+e.target.value] || FAST_PRESETS[4]).slice() }).then(render) },
      [3, 4, 5, 6].map((n) => el('option', { value: n, selected: rates.length === n }, n + '단계')));
    const inputs = rates.map((r, k) => {
      const last = k === rates.length - 1;
      return el('label', { class: 'rate-cell' + (last ? ' fixed' : '') }, [
        el('span', { class: 'rate-n' }, String(k + 1)),
        el('input', { type: 'number', class: 'rate fast-rate', 'data-step': k, min: 0.5, max: RATE_MAX, step: 0.05, value: fmtRate(r), disabled: last, title: last ? '마지막 단계는 1배 고정 — 정상 속도가 느리게 들리도록' : undefined, onchange: (e) => {
          const v = Math.round(clampNum(parseFloat(e.target.value), 0.5, RATE_MAX) * 100) / 100;
          const next = fastRates().slice();
          next[k] = Number.isFinite(v) ? v : 1;
          next[next.length - 1] = 1;
          e.target.value = fmtRate(next[k]);
          saveWebPrefs({ fastRates: next }).then(render);
        } }),
        el('span', { class: 'rate-x' }, '×'),
      ]);
    });
    return el('div', { class: 'fast-cfg' }, [
      el('div', { class: 'row' }, [el('b', { class: 'fast-cfg-title' }, '고속 적응 프리셋'), el('label', null, ['단계 수 ', steps]), infoBtn('fastLadder')]),
      el('p', { class: 'fast-cfg-hint' }, '이해를 확인한 문장(받아쓰기 통과 · 알고 있어)에만 목록의 ⏩ 버튼이 나오고, 플레이어 ⚙ › 반복 고속 적응을 켜면 그 줄의 S 반복이 이 단계로 올라갑니다. 마지막은 1배 고정.'),
      el('div', { class: 'rates' }, inputs),
    ]);
  }
  // 더빙 녹음 배속: 플레이어 더빙 칸 ② 의 배속 버튼 (0.5~1배, 1~3개). 0.5배로 녹음하면 영상도 0.5배로 흐르고, 저장할 때 원래 속도로 맞춘다
  const DUB_REC_PRESETS = { 1: [1], 2: [0.5, 1], 3: [0.5, 0.7, 1] };
  function dubRecRates() {
    const raw = Array.isArray(state.web.dubRecRates) ? state.web.dubRecRates : [];
    const out = raw.map((x) => Math.round(clampNum(+x, 0.5, 1) * 100) / 100).filter((x) => Number.isFinite(x) && x > 0).slice(0, 3);
    return out.length ? out : DUB_REC_PRESETS[3].slice();
  }
  function renderDubRecCfg() {
    const rates = dubRecRates();
    const steps = el('select', { class: 'dub-rec-steps', title: '버튼 수', onchange: (e) => saveWebPrefs({ dubRecRates: (DUB_REC_PRESETS[+e.target.value] || DUB_REC_PRESETS[3]).slice() }).then(render) },
      [1, 2, 3].map((n) => el('option', { value: n, selected: rates.length === n }, n + '개')));
    const inputs = rates.map((r, k) => el('label', { class: 'rate-cell' }, [
      el('span', { class: 'rate-n' }, String(k + 1)),
      el('input', { type: 'number', class: 'rate dub-rec-rate', 'data-step': k, min: 0.5, max: 1, step: 0.05, value: fmtRate(r), onchange: (e) => {
        const v = Math.round(clampNum(parseFloat(e.target.value), 0.5, 1) * 100) / 100;
        const next = dubRecRates().slice();
        next[k] = Number.isFinite(v) ? v : 1;
        e.target.value = fmtRate(next[k]);
        saveWebPrefs({ dubRecRates: next }).then(render);
      } }),
      el('span', { class: 'rate-x' }, '×'),
    ]));
    return el('div', { class: 'dub-rec-cfg' }, [
      el('div', { class: 'row' }, [el('label', null, ['더빙 녹음 배속 ', steps]), infoBtn('dub')]),
      el('div', { class: 'rates' }, inputs),
    ]);
  }
  // 진행 상황: 목표일까지 남은 날, 주별 저장·복습, 에피소드별 1회차 이해율·말 속도·어휘 난도
  function renderDashboard() {
    const sec = el('section', null, [el('h3', null, ['진행 상황', infoBtn('dashboard')])]);
    const body = el('div', { class: 'dash' }, '불러오는 중…');
    sec.append(body);
    B.request('stats.get').then((r) => { state.stats = (r && r.stats) || {}; fillDashboard(body); }).catch(() => { body.textContent = '통계를 불러오지 못했습니다'; });
    return sec;
  }
  function fillDashboard(body) {
    const st = state.stats || {};
    body.textContent = '';
    const goal = state.web.goalDate ? new Date(state.web.goalDate + 'T00:00:00') : null;
    const days = goal && !isNaN(goal) ? Math.ceil((goal - Date.now()) / DAY) : null;
    // D-day 옆에 오늘의 훈련 연속 일수 (🔥)
    body.append(el('div', { class: 'dday' }, [days === null ? '근무 시작일을 정하세요' : (days > 0 ? 'D-' + days : (days === 0 ? 'D-day' : 'D+' + (-days))) + ' · ' + state.web.goalDate, el('span', { class: 'dday-streak' }, streakLine()), infoBtn('today')]));
    const weeks = 8, nowT = Date.now();
    const bucket = (t) => Math.floor((nowT - t) / (7 * DAY));
    const saved = new Array(weeks).fill(0), rev = new Array(weeks).fill(0), train = new Array(weeks).fill(0);
    state.items.forEach((i) => { const b = bucket(i.savedAt || 0); if (b >= 0 && b < weeks) saved[weeks - 1 - b]++; });
    (st.reviews || []).forEach((r) => { const b = bucket(r.t); if (b >= 0 && b < weeks) rev[weeks - 1 - b]++; });
    // 훈련한 날: 그날 정오를 기준으로 주에 넣는다 (0~7일). 오늘 오전이면 (지금 - 오늘 정오)가 음수라 -1주가 되므로 0으로 끌어올린다
    Object.keys(st.training || {}).forEach((d) => { const b = Math.max(0, bucket(new Date(d + 'T12:00:00').getTime())); if (b < weeks) train[weeks - 1 - b]++; });
    const max = Math.max(1, ...saved, ...rev);
    const bars = el('div', { class: 'bars' }, saved.map((n, k) => el('div', { class: 'bar-col', title: (k === weeks - 1 ? '이번 주' : (weeks - 1 - k) + '주 전') + ': 저장 ' + n + ' · 복습 ' + rev[k] + ' · 오늘의 훈련 ' + train[k] + '일' }, [
      el('div', { class: 'bar-pair' }, [el('div', { class: 'bar saved', style: 'height:' + Math.max(2, Math.round((n / max) * 60)) + 'px' }), el('div', { class: 'bar rev', style: 'height:' + Math.max(2, Math.round((rev[k] / max) * 60)) + 'px' }), el('div', { class: 'bar train', 'data-days': String(train[k]), style: 'height:' + Math.max(2, Math.round((train[k] / 7) * 60)) + 'px' })]),
      el('span', { class: 'bar-l' }, k === weeks - 1 ? '이번 주' : (k === 0 ? (weeks - 1) + '주 전' : '')),
    ])));
    body.append(el('div', { class: 'bars-wrap' }, [bars, el('div', { class: 'legend' }, [el('span', { class: 'lg saved' }, '저장'), el('span', { class: 'lg rev' }, '복습'), el('span', { class: 'lg train' }, '오늘의 훈련 (일, 7일 = 가득)')])]));
    // 못 알아들은 원인별 비율 + 다음 훈련 추천 (Q 문장 복습에서 고른 원인)
    const reasons = {};
    state.items.forEach((i) => { if (i.missReason) reasons[i.missReason] = (reasons[i.missReason] || 0) + 1; });
    const totalR = Object.values(reasons).reduce((a, b) => a + b, 0);
    const miss = el('div', { class: 'miss-stats' }, [el('h4', null, ['못 알아들은 원인', infoBtn('missReason')])]);
    if (!totalR) miss.append(el('p', { class: 'count' }, '받아쓰기·오늘의 훈련·목록에서 Q 문장의 원인을 고르면 여기에 모입니다.'));
    else {
      const top = MISS_REASONS.map(([k, label]) => [k, label, reasons[k] || 0]).filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2]);
      for (const [k, label, n] of top) {
        miss.append(el('div', { class: 'miss-row' }, [
          el('span', { class: 'miss-name' }, label),
          el('div', { class: 'miss-bar-track' }, el('div', { class: 'miss-bar', 'data-why': k, style: 'width:' + Math.round((n / totalR) * 100) + '%' })),
          el('span', { class: 'miss-n' }, n + '개 · ' + Math.round((n / totalR) * 100) + '%'),
        ]));
      }
      miss.append(el('p', { class: 'miss-advice' }, '다음 훈련 추천: ' + MISS_RECOMMEND[top[0][0]]));
    }
    body.append(miss);
    const eps = Object.values(st.episodes || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
    if (!eps.length) { body.append(el('p', { class: 'count' }, '플레이어에서 자막을 보면 에피소드별 기록이 쌓입니다.')); return; }
    const row = (e) => {
      const rate = e.watched ? Math.max(0, Math.round((1 - (e.missed || 0) / e.watched) * 100)) : null;
      return el('tr', null, [
        el('td', null, (e.title || e.videoId) + (e.episode ? ' · ' + e.episode : '')),
        el('td', { class: 'num' }, (e.watched || 0) + ' / ' + (e.lines || 0)),
        el('td', { class: 'num' }, rate === null ? '-' : rate + '%' + (e.missed ? ' (❓' + e.missed + ')' : '')),
        el('td', { class: 'num' }, e.wpm ? e.wpm + ' wpm' : '-'),
        el('td', { class: 'num' }, e.outside3k != null ? '3천 밖 ' + e.outside3k + '% · ' + (e.difficulty || '') : '-'),
      ]);
    };
    body.append(el('table', { class: 'eps' }, [el('thead', null, el('tr', null, ['작품', '본 줄', '1회차 이해율', '말 속도', '어휘'].map((h) => el('th', null, h)))), el('tbody', null, eps.map(row))]));
  }
  // 약점 단어: 받아쓰기에서 놓친 단어 누적 + 자주 놓치는 축약 패턴 top 10
  function renderWeakWords() {
    const sec = el('section', null, [el('h3', null, ['약점 단어', infoBtn('weakWords')])]);
    const body = el('div', { class: 'weak' }, '…');
    const redBox = el('div', { class: 'weak reductions' });
    sec.append(body, el('h4', { class: 'red-title' }, ['자주 놓치는 축약 패턴', infoBtn('reductionStats')]), redBox);
    B.request('stats.get').then((r) => {
      const weak = (r && r.stats && r.stats.weak) || {};
      const top = Object.entries(weak).sort((a, b) => b[1] - a[1]).slice(0, 24);
      body.textContent = '';
      if (!top.length) body.append(el('span', { class: 'count' }, '받아쓰기 퀴즈를 하면 놓친 단어가 쌓입니다.'));
      else {
        const fn = Sp ? Sp.FUNCTION_WORDS : null;
        top.forEach(([w, n]) => body.append(el('span', { class: 'tag weak-w' + (fn && fn.has(w) ? ' fnw' : ''), title: fn && fn.has(w) ? '기능어(약형): 연음·약화 때문에 놓치기 쉬움' : '' }, [w, el('span', { class: 'n' }, String(n))])));
        body.append(el('button', { class: 'btn mini', onclick: async () => { if (confirm('약점 단어·축약 패턴 기록을 지울까요?')) { await B.request('stats.weakReset').catch(() => {}); render(); } } }, '초기화'));
      }
      // 축약 패턴: didja ×3 — 누르면 그 패턴("did you")이 든 저장 문장만 보여 준다
      const red = (r && r.stats && r.stats.reductions) || {};
      const rtop = Object.entries(red).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
      redBox.textContent = '';
      if (!rtop.length) { redBox.append(el('span', { class: 'count' }, '받아쓰기에서 축약·연음 구간(gonna, didja, ’em …)의 단어를 놓치면 패턴별로 쌓입니다.')); return; }
      rtop.forEach(([to, v]) => redBox.append(el('button', { class: 'tag red-pattern', 'data-src': v.src, title: '원래 모양: ' + v.src + ' — 누르면 이 패턴이 든 저장 문장을 봅니다', onclick: () => { state.search = v.src; state.filterTitle = ''; state.filterTag = ''; if (state.view !== 'list') location.hash = '#/list'; else render(); } }, [to, el('span', { class: 'n' }, String(v.n))])));
    }).catch(() => { body.textContent = ''; });
    return sec;
  }
  // 추천 콘텐츠: 뉴질랜드·호주 억양과 학교 말
  const RECOMMEND = [
    ['Little Lunch', 'Netflix', '호주 초등 아이들의 쉬는 시간 코미디. 학교 어휘와 아이 말투 — 시작점', 'https://www.netflix.com/search?q=Little%20Lunch'],
    ['Bluey', '디즈니+', '호주 가족 애니메이션. 쉬운 일상 대화', 'https://www.disneyplus.com/search?q=Bluey'],
    ['What Now', 'YouTube · TVNZ', '뉴질랜드 어린이 TV. 키위 아이들과 진행자의 말', 'https://www.youtube.com/results?search_query=What+Now+NZ'],
    ['How to Dad', 'YouTube', '키위 아빠의 유머 채널. 전형적인 뉴질랜드 억양', 'https://www.youtube.com/results?search_query=How+to+Dad'],
    ['Educators', 'ThreeNow(NZ) · YouTube 클립', '뉴질랜드 교사들의 코미디. 교직원실 말', 'https://www.youtube.com/results?search_query=Educators+NZ+comedy+series'],
    ['Taskmaster NZ', 'YouTube', '빠른 키위 대화와 농담', 'https://www.youtube.com/results?search_query=Taskmaster+NZ'],
    ['Wellington Paranormal', 'Netflix · YouTube 클립', '뉴질랜드 경찰 코미디. 무표정 키위 유머', 'https://www.youtube.com/results?search_query=Wellington+Paranormal'],
    ['Hunt for the Wilderpeople · Boy', '영화', '타이카 와이티티. 키위 아이와 어른의 말', 'https://www.youtube.com/results?search_query=Hunt+for+the+Wilderpeople+scene'],
    ['The Breaker Upperers', 'Netflix', '뉴질랜드 코미디 영화', 'https://www.netflix.com/search?q=The%20Breaker%20Upperers'],
    ['Shortland Street', 'TVNZ+', '뉴질랜드 일일 드라마(병원). 빠른 일상 대화 · SubTutor 가 TVNZ+ 자막(광고 사이)을 그대로 읽는다', 'https://www.tvnz.co.nz/tvseries/shortland-street'],
    ['TVNZ+ 뉴스 · 1News', 'TVNZ+', '뉴질랜드 뉴스 클립. 학교·교육 소식으로 교사 대화의 배경지식', 'https://www.tvnz.co.nz/news'],
    ['Westside', 'NZ On Screen', '오클랜드 서부 가족 드라마(Outrageous Fortune 앞 이야기). 가입 없이 자막 포함', 'https://www.nzonscreen.com/title/westside-episode-one-2015'],
    ['NZ On Screen 교육·다큐', 'NZ On Screen', '뉴질랜드 학교·교육을 다룬 다큐와 드라마 보관소', 'https://www.nzonscreen.com/'],
    ['Kiri and Lou', 'MĀORI+', '마오리 말과 영어가 섞인 어린이 애니메이션. 교실에서 쓰는 마오리 단어', 'https://www.maoriplus.co.nz/show/kiri-and-lou'],
    ['Do schools kill creativity? (Ken Robinson)', 'TED', '교육 강연. 영어·한국어 자막이 다 있어 시작하기 좋다', 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity'],
    ['뉴질랜드 교실 영상', 'YouTube · Vimeo', '"structured literacy New Zealand classroom", "PB4L classroom NZ" 검색 — 실제 교실 말 (Vimeo 의 교사 연수 영상도 SubTutor 로 볼 수 있다)', 'https://www.youtube.com/results?search_query=structured+literacy+New+Zealand+classroom'],
  ];
  function renderRecommend() {
    return el('section', null, [
      el('h3', null, ['추천 콘텐츠', infoBtn('recommend')]),
      el('div', { class: 'recs' }, RECOMMEND.map(([name, where, why, url]) => el('div', { class: 'rec' }, [el('a', { href: url, target: '_blank', rel: 'noopener' }, name), el('span', { class: 'where' }, where), el('span', { class: 'why' }, why)]))),
    ]);
  }

  // ───────── 쉐도잉 세션 ─────────
  const SHADOW_STEPS = [['듣기', '글 없이 듣기만 합니다'], ['속으로 따라 하기', '들으면서 입 모양으로 조용히 따라 합니다'], ['글 보며 따라 하기', '자막을 보며 소리 내어 따라 합니다'], ['억양 따라 하며 녹음', '글 없이 억양과 리듬을 따라 말하며 녹음합니다 (헤드폰을 쓰면 원음이 섞이지 않습니다)'], ['비교', '원음 뒤에 내 녹음이 이어집니다']];
  function renderShadow() {
    const wrap = el('div', { class: 'quiz-wrap' });
    if (!state.web.shadow) { wrap.append(el('div', { class: 'empty' }, '쉐도잉 세션이 꺼져 있습니다. 설정 → 학습 기능에서 켜세요.')); return wrap; }
    const sh = state.shadow;
    if (!sh) { wrap.append(shadowSetup()); return wrap; }
    while (sh.pos < sh.queue.length && !state.items.find((i) => i.id === sh.queue[sh.pos])) sh.pos++;
    if (sh.pos >= sh.queue.length) {
      wrap.append(el('div', { class: 'quiz-card summary' }, [el('h2', null, '쉐도잉 끝!'), el('p', { class: 'count' }, sh.queue.length + '개 대사를 마쳤습니다.'), el('div', { class: 'row', style: 'display:flex;gap:10px;justify-content:center' }, [el('button', { class: 'btn primary big', onclick: () => { state.shadow = null; render(); } }, '다시'), el('button', { class: 'btn big', onclick: () => { state.shadow = null; location.hash = '#/list'; } }, '목록으로')])]));
      return wrap;
    }
    wrap.append(shadowCard());
    return wrap;
  }
  function shadowSetup() {
    const pool = learning();
    const prefs = state.shadowPrefs || (state.shadowPrefs = { title: '', tag: '', missedOnly: false });
    const titles = Array.from(new Set(pool.map((i) => i.title))).sort((a, b) => a.localeCompare(b, 'ko'));
    const count = () => pool.filter((i) => (!prefs.title || i.title === prefs.title) && (!prefs.tag || (i.tags || []).includes(prefs.tag)) && (!prefs.missedOnly || i.missed)).length;
    const countEl = el('span', { class: 'count' }, count() + '개');
    const refresh = () => { countEl.textContent = count() + '개'; };
    return el('div', { class: 'quiz-setup' }, [
      el('h2', null, ['쉐도잉 세션', infoBtn('shadowSession')]),
      el('div', { class: 'row' }, [
        el('label', null, '작품 '),
        el('select', { onchange: (e) => { prefs.title = e.target.value; refresh(); } }, [el('option', { value: '' }, '모든 작품')].concat(titles.map((t) => el('option', { value: t, selected: t === prefs.title }, t)))),
        state.tagNames.length ? el('label', null, '태그 ') : null,
        state.tagNames.length ? el('select', { onchange: (e) => { prefs.tag = e.target.value; refresh(); } }, [el('option', { value: '' }, '모든 태그')].concat(state.tagNames.map((t) => el('option', { value: t, selected: t === prefs.tag }, t)))) : null,
        el('label', null, [el('input', { type: 'checkbox', checked: prefs.missedOnly, onchange: (e) => { prefs.missedOnly = e.target.checked; refresh(); } }), ' 못 알아들음 표시만']),
      ]),
      el('div', { class: 'row' }, [el('button', { class: 'btn primary big', disabled: !pool.length || !state.extOk, onclick: startShadow }, '시작'), countEl, infoBtn('keys')]),
    ]);
  }
  function startShadow() {
    const prefs = state.shadowPrefs || {};
    const pool = learning().filter((i) => (!prefs.title || i.title === prefs.title) && (!prefs.tag || (i.tags || []).includes(prefs.tag)) && (!prefs.missedOnly || i.missed)).sort((a, b) => a.startMs - b.startMs);
    if (!pool.length) { toast('조건에 맞는 대사가 없습니다'); return; }
    state.shadow = { queue: pool.map((i) => i.id), pos: 0, step: 0, busy: false, autoplayFor: null, gen: 0 };
    render();
  }
  const currentShadowItem = () => { const sh = state.shadow; return sh ? state.items.find((i) => i.id === sh.queue[sh.pos]) : null; };
  function shadowCard() {
    const sh = state.shadow;
    const it = currentShadowItem();
    const step = sh.step;
    const [name, desc] = SHADOW_STEPS[step];
    const card = el('div', { class: 'quiz-card shadow-card', 'data-clip-item': it.id });
    const showText = step === 2 || step === 4;
    card.append(
      el('div', { class: 'quiz-top' }, [el('span', null, it.title + (it.episode ? ' · ' + it.episode : '')), el('span', null, (sh.pos + 1) + ' / ' + sh.queue.length)]),
      el('div', { class: 'steps' }, SHADOW_STEPS.map(([n], k) => el('span', { class: 'step' + (k === step ? ' on' : (k < step ? ' done' : '')) }, (k + 1) + ' ' + n))),
      el('p', { class: 'step-desc' }, [desc, infoBtn('shadowSession')]),
      el('div', { class: 'answer en' + (showText ? '' : ' veiled-text'), text: showText ? it.text : '자막 숨김' }),
      el('div', { class: 'ko' + (step === 4 ? '' : ' hidden'), text: it.translation || '' }),
      el('div', { class: 'quiz-audio' }, [
        el('button', { class: 'btn primary big play', 'data-label': step === 3 ? '녹음하며 듣기' : '듣기', onclick: () => shadowPlay() }, '▶ ' + (step === 3 ? '녹음하며 듣기' : '듣기')),
        el('span', { class: 'count' }, 'Space'),
        el('span', { class: 'clip-state state' }),
      ]),
      el('div', { class: 'quiz-actions' }, [
        el('button', { class: 'btn primary', onclick: () => shadowNext() }, step < 4 ? '다음 단계 (N)' : '다음 대사 (N)'),
        el('button', { class: 'btn', onclick: () => { stopLocalAudio(); sh.gen++; sh.busy = false; sh.pos++; sh.step = 0; render(); } }, '이 대사 건너뛰기'),
      ]),
      step >= 3 ? buildRecRow(it.id) : null,
    );
    const key = it.id + ':' + step;
    if (sh.autoplayFor !== key && step !== 3) { sh.autoplayFor = key; if (state.extOk) setTimeout(shadowPlay, 80); }
    return card;
  }
  async function shadowPlay() {
    const sh = state.shadow;
    if (!sh || sh.busy) return;
    const it = currentShadowItem();
    if (!it) return;
    sh.busy = true;
    const gen = sh.gen;
    const alive = () => state.shadow === sh && sh.gen === gen && state.view === 'shadow'; // 다음 단계·다음 대사·화면 이탈 뒤에는 이어 가지 않는다
    try {
      if (sh.step === 3) {
        R.stop();
        let ctrl;
        try { ctrl = await R.start(); } catch (e) { toast('마이크를 사용할 수 없습니다: ' + e.message); return; }
        await playItem(it.id, { loop: false });
        await new Promise((r) => setTimeout(r, 400));
        const { blob, durationMs } = await ctrl.stop();
        if (durationMs >= 300) { const list = await R.add(it.id, blob, durationMs); state.recordings.set(it.id, list); }
        if (!alive()) return;
        sh.step = 4; sh.autoplayFor = it.id + ':4'; sh.gen++;
        render();
        await new Promise((r) => setTimeout(r, 300));
        if (state.shadow !== sh || state.view !== 'shadow' || sh.step !== 4) return;
        await playTogether(it.id);
      } else if (sh.step === 4) {
        await playTogether(it.id);
      } else {
        await playItem(it.id, { loop: false });
      }
    } finally { if (state.shadow === sh) sh.busy = false; }
  }
  function shadowNext() {
    const sh = state.shadow;
    if (!sh) return;
    stopLocalAudio();
    sh.gen++; sh.busy = false;
    if (sh.step < 4) sh.step++; else { sh.pos++; sh.step = 0; }
    render();
  }

  // ───────── 오늘의 훈련 (분산 연습: 매일 15분쯤, 버튼 하나로 이어서) ─────────
  // 복습 때가 된 받아쓰기 → 단어장 카드 → 못 알아들은(Q) 문장 3개를 속도 사다리로 → 더빙 한 구간 권유 → 완료 기록(연속 일수·주별 그래프·D-day 옆)
  // 그날 복습할 받아쓰기가 없으면 Q 문장과 최근 저장 문장으로 채운다. 근거: McBride (2011) — 같은 양이면 여러 날에 나눠 들은 쪽이 더 늘었다
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const TODAY_MIN = { dict: 1.2, words: 0.25, ladder: 0.6, dub: 2 }; // 하나에 걸리는 대략의 분
  const TODAY_STAGE = { dict: '받아쓰기', words: '단어 카드', ladder: 'Q 문장 사다리', dub: '더빙' };
  async function loadStats() {
    try { const r = await B.request('stats.get'); state.stats = (r && r.stats) || {}; } catch (e) { /* ignore */ }
  }
  function planToday() {
    const L = learning();
    const missed = L.filter((i) => i.missed);
    const recent = L.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const add = (arr, from, n) => { for (const it of from) { if (arr.length >= n) break; if (it && !arr.includes(it)) arr.push(it); } return arr; };
    let dict = state.web.srs !== false ? L.filter(isDue).sort((a, b) => dueOf(a) - dueOf(b)).slice(0, 5) : [];
    const filled = !dict.length;
    if (filled) dict = add([], missed.concat(recent), 4);
    const words = dueWords().sort((a, b) => wordDue(a) - wordDue(b)).slice(0, 12).map((w) => w.word);
    const byOld = (a, b) => (a.lastReviewedAt || a.savedAt || 0) - (b.lastReviewedAt || b.savedAt || 0);
    const ladder = add([], missed.slice().sort(byOld), 3);
    if (ladder.length < 3) add(ladder, recent, 3);
    const dub = missed.find((i) => !ladder.includes(i)) || missed[0] || recent[0] || null;
    const stages = [];
    if (dict.length) stages.push({ kind: 'dict', ids: dict.map((i) => i.id), filled });
    if (words.length) stages.push({ kind: 'words', words });
    if (ladder.length) stages.push({ kind: 'ladder', ids: ladder.map((i) => i.id) });
    if (dub) stages.push({ kind: 'dub', id: dub.id });
    const minutes = dict.length * TODAY_MIN.dict + words.length * TODAY_MIN.words + ladder.length * TODAY_MIN.ladder + (dub ? TODAY_MIN.dub : 0);
    return { stages, minutes: Math.max(1, Math.round(minutes)), counts: { dict: dict.length, words: words.length, ladder: ladder.length, dub: dub ? 1 : 0 }, filled };
  }
  function trainingStreak() {
    const tr = (state.stats && state.stats.training) || {};
    const d = new Date();
    const doneToday = !!tr[dayKey(d)];
    if (!doneToday) d.setDate(d.getDate() - 1);
    let n = 0;
    while (tr[dayKey(d)] && n < 2000) { n++; d.setDate(d.getDate() - 1); }
    return { n, doneToday };
  }
  function ddayText() {
    const goal = state.web.goalDate ? new Date(state.web.goalDate + 'T00:00:00') : null;
    const days = goal && !isNaN(goal) ? Math.ceil((goal - Date.now()) / DAY) : null;
    return days === null ? '' : (days > 0 ? 'D-' + days : (days === 0 ? 'D-day' : 'D+' + (-days)));
  }
  // 🔥 연속 일수 한 줄: 오늘 했으면 오늘까지, 아직이면 어제까지 이어진 날 수
  function streakLine() {
    const s = trainingStreak();
    if (s.doneToday) return '오늘 완료 ✓ · 🔥 ' + s.n + '일 연속';
    return s.n ? '🔥 ' + s.n + '일 연속 · 오늘 하면 ' + (s.n + 1) + '일' : '오늘부터 연속 기록을 시작하세요';
  }
  const todayPlanText = (plan) => [plan.counts.dict ? '받아쓰기 ' + plan.counts.dict : '', plan.counts.words ? '단어 ' + plan.counts.words : '', plan.counts.ladder ? 'Q 문장 사다리 ' + plan.counts.ladder : '', plan.counts.dub ? '더빙 1' : ''].filter(Boolean).join(' · ') + ' · 약 ' + plan.minutes + '분';
  // 첫 화면(저장한 자막) 맨 위의 카드
  function todayCard() {
    if (!state.extOk) return null;
    const plan = planToday();
    const s = trainingStreak();
    const running = state.today && !state.today.finished;
    return el('div', { class: 'today-card' + (s.doneToday ? ' done' : '') }, [
      el('div', { class: 'today-main' }, [
        el('div', { class: 'today-title' }, ['오늘의 훈련', infoBtn('today'), el('span', { class: 'today-dday' }, ddayText())]),
        el('div', { class: 'today-plan' }, plan.stages.length ? todayPlanText(plan) : '먼저 플레이어에서 자막을 저장하세요 (☆ 또는 E)'),
        el('div', { class: 'today-streak' }, streakLine()),
      ]),
      el('button', { class: 'btn primary big today-start', disabled: !plan.stages.length && !running, onclick: () => (running ? (location.hash = '#/today') : startToday()) }, running ? '이어 하기' : (s.doneToday ? '한 번 더' : '▶ 시작')),
    ]);
  }
  function stopPlayback() {
    state.ladderFor = null;
    const cur = state.clip;
    if (cur && ['playing', 'opening', 'loading'].includes(cur.state)) { setClip(cur.itemId, 'stopped'); stopLocalAudio(); if (!state.clipLocal) B.request('clip.stop').catch(() => {}); }
    try { R.stop(); } catch (e) { /* ignore */ }
  }
  function startToday() {
    const plan = planToday();
    if (!plan.stages.length) { toast('훈련할 것이 없습니다 — 먼저 플레이어에서 자막을 저장하세요'); return; }
    stopPlayback();
    state.today = { plan, stages: plan.stages, idx: -1, startedAt: Date.now(), done: { dict: 0, words: 0, ladder: 0, dub: 0 }, finished: false };
    if (location.hash !== '#/today') location.hash = '#/today';
    nextTodayStage();
  }
  const todayStage = () => (state.today && !state.today.finished && state.today.idx >= 0 ? state.today.stages[state.today.idx] || null : null);
  const todayStageKind = () => (state.view === 'today' && todayStage() ? todayStage().kind : '');
  function nextTodayStage() {
    const t = state.today;
    if (!t || t.finished) return;
    stopPlayback();
    if (state.quiz && state.quiz.today) state.quiz = null;
    if (state.wordReview && state.wordReview.today) state.wordReview = null;
    t.idx++;
    if (t.idx >= t.stages.length) { finishToday(); return; }
    const st = t.stages[t.idx];
    if (st.kind === 'dict') state.quiz = { queue: st.ids.slice(), pos: 0, phase: 'listen', input: '', result: null, hint: false, revealed: false, stats: { know: 0, forgot: 0 }, requeued: {}, autoplayedFor: null, today: true };
    else if (st.kind === 'words') state.wordReview = { queue: st.words.slice(), pos: 0, flipped: false, stats: { know: 0, forgot: 0 }, requeued: {}, today: true };
    else if (st.kind === 'ladder') { st.pos = 0; st.playedFor = null; st.finishedFor = null; }
    render();
  }
  function todayHeader(t) {
    return el('div', { class: 'today-head' }, [
      el('b', null, ['오늘의 훈련', infoBtn('today')]),
      el('div', { class: 'steps today-steps' }, t.stages.map((s, k) => el('span', { class: 'step' + (k === t.idx ? ' on' : (k < t.idx ? ' done' : '')), 'data-stage': s.kind }, (k + 1) + ' ' + TODAY_STAGE[s.kind]))),
      el('button', { class: 'btn mini today-skip', title: '이 단계를 건너뛰고 다음 단계로', onclick: () => nextTodayStage() }, '이 단계 건너뛰기'),
    ]);
  }
  function renderToday() {
    const wrap = el('div', { class: 'quiz-wrap today-wrap' });
    const t = state.today;
    if (!t) {
      const plan = planToday();
      wrap.append(el('div', { class: 'quiz-setup' }, [
        el('h2', null, ['오늘의 훈련', infoBtn('today')]),
        el('p', null, plan.stages.length ? todayPlanText(plan) + (plan.filled ? ' (오늘 복습할 받아쓰기가 없어 Q 문장·최근 저장 문장으로 채움)' : '') : '먼저 플레이어에서 자막을 저장하세요.'),
        el('p', { class: 'today-streak' }, streakLine() + (ddayText() ? ' · ' + ddayText() : '')),
        el('div', { class: 'row' }, [el('button', { class: 'btn primary big today-start', disabled: !plan.stages.length || !state.extOk, onclick: startToday }, '▶ 시작')]),
      ]));
      return wrap;
    }
    if (t.finished) { wrap.append(todaySummary()); return wrap; }
    const st = todayStage();
    if (!st) return wrap;
    wrap.append(todayHeader(t));
    if (st.kind === 'dict') {
      const q = state.quiz;
      while (q && q.pos < q.queue.length && !state.items.find((i) => i.id === q.queue[q.pos])) q.pos++;
      if (!q || q.pos >= q.queue.length) { t.done.dict = q ? q.stats.know + q.stats.forgot : t.done.dict; setTimeout(nextTodayStage, 0); return wrap; }
      wrap.append(quizCard());
    } else if (st.kind === 'words') {
      const rv = state.wordReview;
      while (rv && rv.pos < rv.queue.length && !state.words.find((w) => w.word === rv.queue[rv.pos])) rv.pos++;
      if (!rv || rv.pos >= rv.queue.length) { t.done.words = rv ? rv.stats.know + rv.stats.forgot : t.done.words; setTimeout(nextTodayStage, 0); return wrap; }
      wrap.append(wordCard());
    } else if (st.kind === 'ladder') wrap.append(todayLadderCard(st));
    else if (st.kind === 'dub') wrap.append(todayDubCard(st));
    return wrap;
  }
  // Q 문장 사다리: 자막을 감춘 채 느린 배속부터 차례로 듣고, 다 들으면 글·뜻을 보여 준다
  function todayLadderCard(st) {
    const id = st.ids[st.pos];
    const it = state.items.find((i) => i.id === id);
    if (!it) { setTimeout(() => todayLadderNext(st), 0); return el('div'); }
    const heard = st.finishedFor === id;
    const card = el('div', { class: 'quiz-card today-ladder', 'data-clip-item': it.id }, [
      el('div', { class: 'quiz-top' }, [el('span', null, it.title + (it.episode ? ' · ' + it.episode : '')), el('span', null, 'Q 문장 ' + (st.pos + 1) + ' / ' + st.ids.length)]),
      el('p', { class: 'step-desc' }, ['못 알아들은 문장을 느린 배속부터 차례로 다시 듣습니다: ' + ladderRates().map(fmtRate).join(' → ') + '×', infoBtn('ladder')]),
      el('div', { class: 'answer en' + (heard ? '' : ' veiled-text'), text: heard ? it.text : '다 들을 때까지 자막은 감춰 둡니다' }),
      heard && it.translation ? el('div', { class: 'ko', text: it.translation }) : null,
      heard && it.missed ? reasonRow(it) : null,
      el('div', { class: 'quiz-audio' }, [
        el('button', { class: 'btn primary big play', 'data-label': '사다리 다시', onclick: () => runTodayLadder(st, it.id) }, '⤴ 사다리 다시'),
        el('span', { class: 'count' }, 'Space'),
        el('span', { class: 'clip-state state' }),
      ]),
      el('div', { class: 'quiz-actions' }, [el('button', { class: 'btn primary today-next', onclick: () => todayLadderNext(st) }, (st.pos + 1 < st.ids.length ? '다음 문장' : '다음 단계') + ' (N)')]),
    ]);
    if (st.playedFor !== id) { st.playedFor = id; setTimeout(() => runTodayLadder(st, id), 80); }
    return card;
  }
  async function runTodayLadder(st, id) {
    if (todayStage() !== st || st.ids[st.pos] !== id) return;
    stopPlayback();
    const ok = await playRates(id, ladderRates());
    // 끝까지 들었을 때만 자막·뜻을 연다. 중간에 끊겼으면(재생 실패 등) 감춘 채 두어 Space 로 다시 들을 수 있다
    if (todayStage() === st && st.ids[st.pos] === id && ok && st.finishedFor !== id) { st.finishedFor = id; render(); }
  }
  function todayLadderNext(st) {
    if (todayStage() !== st) return;
    stopPlayback();
    state.today.done.ladder++;
    st.pos++;
    if (st.pos >= st.ids.length) nextTodayStage(); else render();
  }
  // 더빙 권유: 플레이어 탭에서 그 줄의 더빙 칸(R)을 바로 연다
  function todayDubCard(st) {
    const it = state.items.find((i) => i.id === st.id);
    return el('div', { class: 'quiz-card today-dub' }, [
      el('div', { class: 'quiz-top' }, [el('span', null, it ? it.title + (it.episode ? ' · ' + it.episode : '') : ''), el('span', null, '마지막 단계')]),
      el('h3', { class: 'today-dub-title' }, ['오늘의 더빙 한 구간', infoBtn('dub')]),
      it ? el('div', { class: 'answer en', text: it.text }) : el('p', null, '더빙할 문장이 없습니다'),
      it && it.translation ? el('div', { class: 'ko', text: it.translation }) : null,
      el('p', { class: 'step-desc' }, '플레이어에서 이 줄의 더빙 칸이 열립니다: ① 배속 연습(J) → ② 녹음(K) → 내 목소리로 다시 보기. 하고 나서 여기로 돌아와 마치세요.'),
      el('div', { class: 'quiz-actions' }, [
        it ? el('button', { class: 'btn primary today-dub-open', onclick: () => openTodayDub(st, it) }, '🎙 플레이어에서 더빙하기 ↗') : null,
        el('button', { class: 'btn today-finish', onclick: () => nextTodayStage() }, '오늘의 훈련 마치기'),
      ]),
      el('div', { class: 'count today-dub-state' }, st.msg || ''),
    ]);
  }
  async function openTodayDub(st, it) {
    stopPlayback();
    st.msg = '플레이어 여는 중…';
    render();
    try {
      const r = await B.request('item.dub', { itemId: it.id }, 60000);
      if (r && r.ok) { state.today.done.dub = 1; st.msg = '플레이어에서 더빙 칸을 열었습니다 (플레이어 탭을 보세요)'; } else st.msg = '열지 못했습니다: ' + ((r && r.error) || '');
    } catch (e) { st.msg = '열지 못했습니다: ' + e.message; }
    if (todayStage() === st) render();
  }
  async function finishToday() {
    const t = state.today;
    if (!t || t.finished) return;
    t.finished = true;
    t.endedAt = Date.now();
    stopPlayback();
    const data = { dict: t.done.dict, words: t.done.words, ladder: t.done.ladder, dub: t.done.dub, minutes: Math.max(1, Math.round((t.endedAt - t.startedAt) / 60000)), planned: t.plan.counts };
    try {
      const r = await B.request('stats.training', { day: dayKey(new Date()), data });
      if (r && r.training) { state.stats = state.stats || {}; state.stats.training = r.training; }
    } catch (e) { toast('훈련 기록을 저장하지 못했습니다: ' + e.message); }
    render();
  }
  function todaySummary() {
    const t = state.today;
    const s = trainingStreak();
    const num = (n, label) => el('div', null, [el('b', null, String(n)), label]);
    return el('div', { class: 'quiz-card summary today-summary' }, [
      el('h2', null, '오늘의 훈련 끝! 🎉'),
      el('div', { class: 'nums' }, [num(t.done.dict, '받아쓰기'), num(t.done.words, '단어 카드'), num(t.done.ladder, 'Q 문장 사다리'), num(t.done.dub ? '✓' : '–', '더빙')]),
      el('p', { class: 'today-streak-big' }, '🔥 ' + s.n + '일 연속' + (ddayText() ? ' · ' + ddayText() : '')),
      el('p', { class: 'count' }, '매일 짧게 나눠 하는 것이 몰아서 하는 것보다 듣기 발달에 좋습니다 (ⓘ).'),
      el('div', { class: 'row', style: 'display:flex;gap:10px;justify-content:center' }, [
        el('button', { class: 'btn primary big', onclick: () => { state.today = null; location.hash = '#/list'; } }, '목록으로'),
        el('button', { class: 'btn big', onclick: () => { state.today = null; location.hash = '#/settings'; } }, '진행 상황 보기'),
      ]),
    ]);
  }
  document.addEventListener('keydown', (e) => {
    const st = todayStage();
    if (state.view !== 'today' || !st || st.kind !== 'ladder') return;
    if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
    if (e.code === 'KeyN' || e.code === 'Enter') { e.preventDefault(); todayLadderNext(st); }
    else if (e.code === 'Space') { e.preventDefault(); runTodayLadder(st, st.ids[st.pos]); }
  });

  // ───────── 시작 ─────────
  window.__subtutorDebug = { get state() { return state; }, log: [] }; // 테스트·진단용
  async function init() {
    applyTheme();
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'auto') applyTheme(); }); } catch (e) { /* ignore */ }
    route();
    await B.waitReady(2000);
    state.extOk = B.detect();
    renderExtStatus();
    if (state.extOk) loadRecs();
    B.on('ready', () => { if (!state.extOk) { state.extOk = true; renderExtStatus(); loadStats().then(() => loadItems()); loadWords(); loadRecs(); } });
    B.on('items.changed', () => loadItems());
    B.on('words.changed', () => loadWords());
    setInterval(updateWordCount, 60000);
    $('#info-close').addEventListener('click', () => $('#info-dialog').close());
    $('#info-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    if (state.extOk) { await loadWebPrefs(); await loadTagNames(); await loadWords(); await loadStats(); await loadItems(true); } else render();
  }
  init();
})();
