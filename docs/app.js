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
  const DAY = 86400000;
  const WEB_DEFAULTS = { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true, dubRecRates: [0.5, 0.7, 1] };
  // 사다리 단계 수를 바꿀 때 채워 넣는 기본값 (마지막은 1배속)
  const LADDER_PRESETS = { 1: [1], 2: [0.7, 1], 3: [0.7, 0.85, 1], 4: [0.8, 0.9, 1, 1.15], 5: [0.7, 0.8, 0.9, 1, 1.15], 6: [0.6, 0.7, 0.8, 0.9, 1, 1.15] };
  const RATE_MIN = 0.3, RATE_MAX = 2, LADDER_MAX_STEPS = 6;
  const fmtRate = (r) => String(Math.round(r * 100) / 100);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const PLATFORM_NAMES = { netflix: '넷플릭스', prime: '프라임 비디오', disney: '디즈니+', youtube: '유튜브' };
  const README_URL = 'https://github.com/bluemuple/subtutor#readme';

  const state = {
    items: [], extOk: false, view: 'list',
    filterTitle: '', search: '', sort: loadPref('subtutor.sort', 'group-time'), filterTag: '',
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
    quiz: null, quizPrefs: { title: '', tag: '', order: 'due', dueOnly: true, autoplay: true },
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
  const itemsSignature = (items) => items.map((i) => [i.id, i.box, i.comment, i.translation, i.reviews, i.forgot, i.savedAt, i.audio ? 1 : 0, i.file ? (i.file.location || '1') : 0, (i.tags || []).join(','), i.trim ? i.trim.startMs + '-' + i.trim.endMs : '', i.review ? i.review.due : '', i.missed ? 1 : 0].join('\u0001')).sort().join('\u0002');
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
    return { startMs: it.startMs, endMs: it.endMs, trimmed: false };
  }
  const clipLeadMs = (it) => { const a = it.audio && it.audio.leadMs, f = it.file && it.file.leadMs; return Number.isFinite(a) ? a : (Number.isFinite(f) ? f : 250); }; // 클립은 자막 시작보다 이만큼 앞에서 시작
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
    state.ladderFor = itemId;
    for (const rate of ladderRates()) {
      if (state.ladderFor !== itemId) break;
      toast('⤴ ' + rate + '×', 900);
      await playItem(itemId, { loop: false, rate });
      if (state.ladderFor !== itemId || state.clip.itemId !== itemId || state.clip.state !== 'ended') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (state.ladderFor === itemId) state.ladderFor = null;
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
    box.append(
      el('div', { class: 'trim-head' }, [el('b', null, '오디오 구간 조정'), infoBtn('trim'), label]),
      track, ctl,
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
      state.recording = { itemId, ctrl, startedAt: Date.now(), timer: setInterval(tickRecLabel, 250) };
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

  // ───────── 라우팅/렌더 ─────────
  function route() {
    if (state.shadow && state.view === 'shadow') { state.shadow.gen++; state.shadow.busy = false; }
    const m = /^#\/(\w+)/.exec(location.hash);
    state.view = m && ['list', 'quiz', 'known', 'settings', 'shadow'].includes(m[1]) ? m[1] : 'list';
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
    const titles = { list: '저장한 자막', quiz: '퀴즈', known: '알고 있는 표현', settings: '설정', shadow: '쉐도잉' };
    document.title = 'SubTutor · ' + titles[state.view];
    switch (state.view) {
      case 'list': app.append(renderList(learning(), 'learning')); break;
      case 'known': app.append(renderList(known(), 'known')); break;
      case 'quiz': app.append(renderQuiz()); break;
      case 'settings': app.append(renderSettings()); break;
      case 'shadow': app.append(renderShadow()); break;
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
        const plat = g.items.every((i) => i.platform === g.items[0].platform) ? (PLATFORM_NAMES[g.items[0].platform] || g.items[0].platform) : '';
        const gEl = el('div', { class: 'group' }, [
          el('h3', { class: 'group-title' }, [g.title + (plat ? ' (' + plat + ')' : ''), g.episode ? el('small', null, g.episode) : null, el('small', null, g.items.length + '개'), state.edit.on ? el('button', { class: 'btn mini group-pick', title: '이 묶음의 대사를 모두 선택/해제', onclick: () => togglePickMany(g.items.map((i) => i.id)) }, '묶음 선택') : null]),
        ]);
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
    const playCol = el('div', { class: 'play-col' }, [pick, play, state.web.ladder ? el('button', { class: 'ladder', title: ladderTitle(), onclick: () => playLadder(it.id) }, '⤴') : null]);
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
        opts.showWork ? el('span', { class: 'work' }, it.title + ' (' + (PLATFORM_NAMES[it.platform] || it.platform) + ')' + (it.episode ? ' · ' + it.episode : '')) : null,
        el('span', { class: 'span' }, timeText(it)),
        fmtBadge(it),
        el('span', null, '저장 ' + fmtDate(it.savedAt || Date.now())),
        it.reviews ? el('span', null, '복습 ' + it.reviews + '회' + (it.forgot ? ' · 잊음 ' + it.forgot : '')) : null,
        el('button', { class: 'link', onclick: () => B.request('item.open', { itemId: it.id }, 60000).catch((e) => toast(e.message)) }, '플레이어에서 열기 ↗'),
        el('span', { class: 'state' }),
      ]),
      el('div', { class: 'item-actions' }, [buildTagRow(it), buildRecRow(it.id)]), // + 태그 · 녹음 · 1 · 같이 듣기 · ⓘ 를 한 줄에
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
    const fileOnly = state.items.filter(needsImport).length; // 확장 프로그램이 읽을 수 없는 곳(다운로드 폴더 등)에 MP3 만 있는 대사
    const fileCount = state.items.filter((i) => i.file).length;
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
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', disabled: !state.extOk, onclick: () => {
            const blob = new Blob([JSON.stringify({ app: 'SubTutor', exportedAt: new Date().toISOString(), items: state.items }, null, 2)], { type: 'application/json' });
            const a = el('a', { href: URL.createObjectURL(blob), download: 'subtutor-items-' + fmtDate(Date.now()).replace(/\./g, '') + '.json' });
            document.body.append(a); a.click(); a.remove();
          } }, '자막 내보내기 (JSON)'),
          el('button', { class: 'btn', disabled: !state.extOk, onclick: () => fileInput.click() }, '자막 가져오기'),
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
      el('section', null, [
        el('h3', null, ['확장 프로그램', infoBtn('audioStore')]),
        el('p', null, [state.extOk ? '연결됨 · 버전 ' + (B.version || '') : '감지되지 않음', ' · ', el('a', { href: README_URL, target: '_blank', rel: 'noopener' }, '설치 방법·사용법'), ' · ', el('button', { class: 'link', onclick: () => showInfo('keys') }, '⌨ 단축키')]),
      ]),
    );
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
    );
    return box;
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
    body.append(el('div', { class: 'dday' }, days === null ? '근무 시작일을 정하세요' : (days > 0 ? 'D-' + days : (days === 0 ? 'D-day' : 'D+' + (-days))) + ' · ' + state.web.goalDate));
    const weeks = 8, nowT = Date.now();
    const bucket = (t) => Math.floor((nowT - t) / (7 * DAY));
    const saved = new Array(weeks).fill(0), rev = new Array(weeks).fill(0);
    state.items.forEach((i) => { const b = bucket(i.savedAt || 0); if (b >= 0 && b < weeks) saved[weeks - 1 - b]++; });
    (st.reviews || []).forEach((r) => { const b = bucket(r.t); if (b >= 0 && b < weeks) rev[weeks - 1 - b]++; });
    const max = Math.max(1, ...saved, ...rev);
    const bars = el('div', { class: 'bars' }, saved.map((n, k) => el('div', { class: 'bar-col', title: (k === weeks - 1 ? '이번 주' : (weeks - 1 - k) + '주 전') + ': 저장 ' + n + ' · 복습 ' + rev[k] }, [
      el('div', { class: 'bar-pair' }, [el('div', { class: 'bar saved', style: 'height:' + Math.max(2, Math.round((n / max) * 60)) + 'px' }), el('div', { class: 'bar rev', style: 'height:' + Math.max(2, Math.round((rev[k] / max) * 60)) + 'px' })]),
      el('span', { class: 'bar-l' }, k === weeks - 1 ? '이번 주' : (k === 0 ? (weeks - 1) + '주 전' : '')),
    ])));
    body.append(el('div', { class: 'bars-wrap' }, [bars, el('div', { class: 'legend' }, [el('span', { class: 'lg saved' }, '저장'), el('span', { class: 'lg rev' }, '복습')])]));
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
  // 약점 단어: 받아쓰기에서 놓친 단어 누적
  function renderWeakWords() {
    const sec = el('section', null, [el('h3', null, ['약점 단어', infoBtn('weakWords')])]);
    const body = el('div', { class: 'weak' }, '…');
    sec.append(body);
    B.request('stats.get').then((r) => {
      const weak = (r && r.stats && r.stats.weak) || {};
      const top = Object.entries(weak).sort((a, b) => b[1] - a[1]).slice(0, 24);
      body.textContent = '';
      if (!top.length) { body.append(el('span', { class: 'count' }, '받아쓰기 퀴즈를 하면 놓친 단어가 쌓입니다.')); return; }
      const fn = Sp ? Sp.FUNCTION_WORDS : null;
      top.forEach(([w, n]) => body.append(el('span', { class: 'tag weak-w' + (fn && fn.has(w) ? ' fnw' : ''), title: fn && fn.has(w) ? '기능어(약형): 연음·약화 때문에 놓치기 쉬움' : '' }, [w, el('span', { class: 'n' }, String(n))])));
      body.append(el('button', { class: 'btn mini', onclick: async () => { if (confirm('약점 단어 기록을 지울까요?')) { await B.request('stats.weakReset').catch(() => {}); render(); } } }, '초기화'));
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
    ['Shortland Street', 'TVNZ+ · YouTube 클립', '뉴질랜드 일일 드라마. 일상 대화', 'https://www.youtube.com/results?search_query=Shortland+Street'],
    ['뉴질랜드 교실 영상', 'YouTube', '"structured literacy New Zealand classroom", "PB4L classroom NZ" 검색 — 실제 교실 말', 'https://www.youtube.com/results?search_query=structured+literacy+New+Zealand+classroom'],
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

  // ───────── 시작 ─────────
  window.__subtutorDebug = { get state() { return state; }, log: [] }; // 테스트·진단용
  async function init() {
    applyTheme();
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'auto') applyTheme(); }); } catch (e) { /* ignore */ }
    route();
    await B.waitReady(2000);
    state.extOk = B.detect();
    renderExtStatus();
    B.on('ready', () => { if (!state.extOk) { state.extOk = true; renderExtStatus(); loadItems(); } });
    B.on('items.changed', () => loadItems());
    $('#info-close').addEventListener('click', () => $('#info-dialog').close());
    $('#info-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    if (state.extOk) { await loadWebPrefs(); await loadTagNames(); await loadItems(true); } else render();
  }
  init();
})();
