/*
 * SubTutor – 콘텐츠 스크립트 (ISOLATED world)
 * 자막 패널, 영상 위 영어+한국어 자막, 단축키(A/S/D/F/E/P/W), 자동 일시정지, 쉐도잉, 자막 저장, 웹사이트 원격 재생.
 */
(() => {
  'use strict';
  if (window.__subtutorContent) return;
  window.__subtutorContent = true;

  const S = globalThis.SubTutorSubs;
  const A = globalThis.SubTutorAdapters;
  const adapter = A && A.detect();
  if (!S || !adapter) return;
  const page = A.page;

  const DEFAULT_SETTINGS = {
    showTranslation: true,      // 한국어 번역 표시
    translationSource: 'auto',  // auto | track | mt | off
    hideNative: true,           // 플랫폼 자막 숨기기
    overlay: true,              // 영상 위 자막 표시
    panelOpen: true,
    fontScale: 100,
    autoPause: false,
    shadowing: false,
    shadowPauseSec: 2,
    leadMs: 150,
    tailMs: 200,
    offsetMs: 0,
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  const state = {
    videoId: null, videoEl: null, active: false,
    cues: [], koCues: [], enTrack: null, koTrack: null, runToken: 0, trackRun: 0, loading: false,
    current: -1, lastShown: -1, prevIdx: -1, lastT: 0, lastPaused: null, lastDisplayIdx: -2,
    loop: false, loopIdx: -1, lastLoopSeekAt: 0,
    pausedFor: -1, pausedAt: 0, shadowTimer: null, shadowCueIdx: -1, endTimer: null, resumeByUsUntil: 0, seekByUsUntil: 0,
    clip: null,
    saved: new Map(), meta: null, metaTries: 0,
    offsetAuto: 0, alignSamples: [], lastNativeText: '',
    userScrollAt: 0, statusText: '', statusErr: false,
    ttPoll: null,
  };
  const trackCache = new Map(); // videoId -> tracks
  let pageVideoId = null;
  let pageMeta = null;
  let masterUrlPending = null;
  const ui = {};

  // ───────────── 유틸 ─────────────
  const now = () => performance.now();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) if (c != null) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  function bg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else if (res && res.error) reject(new Error(res.error));
          else resolve(res);
        });
      } catch (e) { reject(e); }
    });
  }
  const isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const effectiveOffset = () => (settings.offsetMs || 0) + (state.offsetAuto || 0);
  const nowMs = () => { const raw = adapter.timeMs(); return isFinite(raw) ? raw + effectiveOffset() : NaN; };

  function koFor(c) {
    if (!c) return '';
    switch (settings.translationSource) {
      case 'off': return '';
      case 'track': return c.koTrack || '';
      case 'mt': return c.koMt || '';
      default: return c.koTrack || c.koMt || '';
    }
  }
  function wantMT(c) {
    if (!settings.showTranslation) return false;
    const src = settings.translationSource;
    if (src === 'off' || src === 'track') return false;
    if (src === 'mt') return !c.koMt;
    return !c.koTrack && !c.koMt;
  }

  // ───────────── 설정 ─────────────
  async function loadSettings() {
    try {
      const { settings: s } = await chrome.storage.local.get('settings');
      settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
    } catch (e) { /* ignore */ }
  }
  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    chrome.storage.local.set({ settings }).catch(() => {});
    applySettings();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings && changes.settings.newValue) {
      const s = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue);
      const changedTranslation = s.translationSource !== settings.translationSource || s.showTranslation !== settings.showTranslation;
      settings = s;
      applySettings();
      if (changedTranslation) { refreshAllKo(); if (state.current >= 0) ensureTranslations(state.current); }
    }
    if (changes.items) loadSaved();
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'status':
        sendResponse({ platform: adapter.name, videoId: state.videoId, ready: isPlayerReady(), cues: state.cues.length, title: state.meta && state.meta.title });
        break;
      case 'playRange': startClip(msg); sendResponse({ ok: true }); break;
      case 'stopClip': stopClip('stopped'); sendResponse({ ok: true }); break;
      case 'seekTo': cancelModesPending(); seekTo(msg.ms); if (msg.play !== false) adapter.play(); sendResponse({ ok: true }); break;
      case 'togglePanel': setPanelOpen(!settings.panelOpen); sendResponse({ ok: true }); break;
      default: return;
    }
  });

  function isPlayerReady() {
    const v = adapter.video();
    if (!v) return false;
    if (adapter.usesPageTime) return A.shared.pageTime.at > 0;
    return v.readyState >= 1 && isFinite(v.duration) && v.duration > 0;
  }

  // ───────────── 페이지 스크립트 메시지 ─────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutor !== 'page') return;
    const d = e.data;
    switch (d.type) {
      case 'reply': page.handleReply(d); break;
      case 'tracks': onTracks(d); break;
      case 'video': if (d.videoId && d.videoId !== pageVideoId) { pageVideoId = d.videoId; checkVideo(); } break;
      case 'master': onMaster(d.url); break;
      case 'meta': if (d.meta && d.meta.title) { pageMeta = d.meta; setMeta(d.meta); } break;
      case 'time': A.shared.pageTime = { ms: d.ms, at: now(), advancing: !!d.advancing }; break;
      case 'navigate': checkVideo(); break;
      default: break;
    }
  });

  // ───────────── 영상/ID 변화 감시 ─────────────
  function currentVideoId() {
    if (adapter.name === 'prime') return pageVideoId || adapter.videoIdFromUrl();
    return adapter.videoIdFromUrl();
  }
  function checkVideo() {
    const id = currentVideoId();
    const v = adapter.video();
    if (id !== state.videoId) startVideo(id);
    if (v !== state.videoEl) attachVideo(v);
    const active = !!(id && v);
    if (active !== state.active) {
      state.active = active;
      if (active) { mountUI(); applySettings(); registerPlayer(); }
      else if (ui.root) { ui.overlay.classList.add('st-hidden'); }
    }
    if (active) ensureOverlayMounted();
  }
  function startVideo(id) {
    state.runToken++;
    state.trackRun++;
    state.videoId = id;
    state.cues = []; state.koCues = []; state.enTrack = null; state.koTrack = null;
    state.current = -1; state.lastShown = -1; state.prevIdx = -1; state.lastDisplayIdx = -2;
    state.loop = false; state.loopIdx = -1; state.pausedFor = -1; state.clip = null;
    state.saved = new Map(); state.meta = null; state.metaTries = 0; state.offsetAuto = 0; state.alignSamples = []; state.lastNativeText = '';
    clearShadow(); clearEndTimer(); stopTextTrackPoll();
    if (ui.root) { renderList(); renderOverlay(true); updateModeUI(); }
    if (!id) return;
    page.send({ type: 'hello' });
    setStatus('자막 불러오는 중…');
    loadTracks(id);
    loadSaved();
    loadMeta();
    registerPlayer();
  }
  function attachVideo(v) {
    state.videoEl = v;
    if (!v) return;
    v.addEventListener('play', () => {
      if (now() < state.resumeByUsUntil) { state.resumeByUsUntil = 0; return; }
      // 사용자가 직접 재생을 눌렀다: 쉐도잉 대기/자동 일시정지 상태를 푼다
      if (state.shadowTimer || state.pausedFor >= 0) { clearShadow(); state.pausedFor = -1; }
    });
    v.addEventListener('seeking', () => {
      if (now() < state.seekByUsUntil) return;
      clearShadow(); state.pausedFor = -1;
    });
    registerPlayer();
  }
  let registerTimer = null;
  function registerPlayer() {
    clearTimeout(registerTimer);
    registerTimer = setTimeout(() => {
      bg({ type: 'player.hello', platform: adapter.name, videoId: state.videoId, ready: isPlayerReady() }).catch(() => {});
    }, 200);
  }
  setInterval(checkVideo, 500);

  // ───────────── 자막 트랙 로딩 ─────────────
  function pickTrack(tracks, lang) {
    const want = lang.toLowerCase();
    const cands = tracks.filter((t) => t && !t.forced && String(t.lang || '').toLowerCase().split(/[-_]/)[0] === want);
    if (!cands.length) return null;
    const sdh = (t) => t.cc || /sdh|\[cc\]|closed caption|청각/i.test(t.label || '');
    cands.sort((a, b) => (sdh(a) === sdh(b) ? 0 : sdh(a) ? 1 : -1));
    return cands[0];
  }
  function onTracks(d) {
    if (d.platform !== adapter.name || !Array.isArray(d.tracks)) return;
    const vid = d.videoId || currentVideoId();
    if (!vid) return;
    trackCache.set(vid, d.tracks);
    if (vid === state.videoId) applyTracks(d.tracks);
  }
  async function fetchText(url) {
    try {
      const r = await page.request({ type: 'fetchText', url }, 25000);
      if (r && r.ok && typeof r.text === 'string') return r.text;
      throw new Error(r && r.error || 'page fetch failed');
    } catch (e) {
      const r = await bg({ type: 'fetch.text', url });
      if (r && typeof r.text === 'string') return r.text;
      throw new Error('fetch failed: ' + (e && e.message));
    }
  }
  async function loadTrackCues(track) {
    if (Array.isArray(track.urls)) {
      const texts = await mapLimit(track.urls, 6, (u) => fetchText(u));
      return S.parseSegments(texts, track.format).cues;
    }
    const text = await fetchText(track.url);
    return S.parseAny(text, track.format).cues;
  }
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    });
    await Promise.all(workers);
    return out;
  }
  async function applyTracks(tracks) {
    const token = ++state.trackRun;
    const en = pickTrack(tracks, 'en');
    const ko = pickTrack(tracks, 'ko');
    if (!en) {
      setStatus('이 영상에서 영어 자막 트랙을 찾지 못했습니다.' + (tracks.length ? ' (' + tracks.map((t) => t.label || t.lang).slice(0, 6).join(', ') + ')' : ''), true);
      return;
    }
    setStatus('영어 자막 내려받는 중…');
    try {
      const [enCues, koCues] = await Promise.all([
        loadTrackCues(en),
        ko ? loadTrackCues(ko).catch(() => []) : Promise.resolve([]),
      ]);
      if (token !== state.trackRun) return;
      setCues(enCues, koCues, en, ko);
    } catch (e) {
      if (token !== state.trackRun) return;
      setStatus('자막을 내려받지 못했습니다: ' + (e && e.message), true);
    }
  }
  function setCues(enCues, koCues, enTrack, koTrack) {
    state.cues = enCues; state.koCues = koCues || []; state.enTrack = enTrack; state.koTrack = koTrack || null;
    state.cues.forEach((c) => { c.koTrack = ''; c.koMt = ''; });
    const merged = S.mergeTranslations(state.cues, state.koCues);
    state.cues.forEach((c) => { if (c.koSource === 'track') c.koTrack = c.ko; delete c.ko; delete c.koSource; });
    state.current = -1; state.lastShown = -1; state.prevIdx = -1; state.lastDisplayIdx = -2;
    const parts = ['영어 ' + state.cues.length + '줄' + (enTrack && enTrack.cc ? ' (CC)' : '')];
    if (merged) parts.push('한국어 자막 ' + merged + '줄 연결');
    else if (settings.translationSource !== 'off' && settings.translationSource !== 'track') parts.push('한국어: 기계 번역');
    setStatus(parts.join(' · '));
    renderList();
    refreshSavedMarks();
    const t = nowMs();
    if (isFinite(t)) ensureTranslations(Math.max(0, S.lastStartedIndex(state.cues, t)));
  }
  async function loadTracks(vid) {
    const token = state.runToken;
    const cached = trackCache.get(vid);
    if (cached) { applyTracks(cached); return; }
    try {
      const r = await page.request({ type: 'getTracks', videoId: vid }, 4000);
      if (token !== state.runToken) return;
      if (r && Array.isArray(r.tracks) && r.tracks.length) { trackCache.set(vid, r.tracks); applyTracks(r.tracks); return; }
    } catch (e) { /* 페이지 스크립트가 아직 없거나 트랙이 아직 안 옴 */ }
    // 잠시 기다렸다가도 안 오면 대체 경로
    setTimeout(() => { if (token === state.runToken && !state.cues.length && !trackCache.has(vid)) fallbackTracks(vid, token); }, 7000);
  }
  async function fallbackTracks(vid, token) {
    if (adapter.name === 'netflix') {
      setStatus('자막 목록을 못 받아 플레이어에서 직접 찾는 중…');
      try {
        const enR = await page.request({ type: 'hydrate', lang: 'en', preferCC: false }, 20000);
        if (token !== state.runToken) return;
        if (!enR || !enR.track) { setStatus('영어 자막을 찾지 못했습니다. 넷플릭스 자막을 영어로 켠 뒤 새로고침해 보세요.', true); return; }
        const koR = await page.request({ type: 'hydrate', lang: 'ko', preferCC: false }, 20000).catch(() => null);
        if (token !== state.runToken) return;
        if (state.cues.length) return; // 그 사이 manifest 경로로 자막이 들어왔다
        const tracks = [enR.track].concat(koR && koR.track ? [koR.track] : []);
        trackCache.set(vid, tracks);
        applyTracks(tracks);
      } catch (e) {
        if (token === state.runToken && !state.cues.length) setStatus('자막을 찾지 못했습니다: ' + (e && e.message), true);
      }
      return;
    }
    if (adapter.supportsTextTracks && tryTextTracks()) return;
    setStatus('자막을 아직 못 찾았습니다. 플레이어에서 자막을 영어로 켜 보세요.', true);
    if (adapter.supportsTextTracks) startTextTrackPoll();
  }
  // <video>.textTracks 에 큐가 있으면 그것을 영어 자막으로 쓴다 (프라임 비디오 대체 경로)
  function readTextTrackCues() {
    const v = adapter.video();
    if (!v || !v.textTracks) return null;
    let best = null;
    for (const tt of v.textTracks) {
      if (!tt.cues || !tt.cues.length) continue;
      const lang = String(tt.language || '').toLowerCase();
      if (lang && !lang.startsWith('en')) continue;
      const cues = [];
      for (const c of tt.cues) {
        const text = S.cleanCueText(c.text || '');
        if (text) cues.push({ start: c.startTime * 1000, end: c.endTime * 1000, text });
      }
      if (!best || cues.length > best.length) best = cues;
    }
    return best && best.length ? S.finalizeCues(best) : null;
  }
  function tryTextTracks() {
    const cues = readTextTrackCues();
    if (!cues) return false;
    setCues(cues, [], { id: 'texttrack', lang: 'en', label: 'player', cc: false }, null);
    setStatus('플레이어 자막 트랙 사용 중 (영어 ' + cues.length + '줄)');
    startTextTrackPoll();
    return true;
  }
  function startTextTrackPoll() {
    stopTextTrackPoll();
    state.ttPoll = setInterval(() => {
      const cues = readTextTrackCues();
      if (!cues) return;
      if (!state.cues.length || (state.enTrack && state.enTrack.id === 'texttrack' && cues.length !== state.cues.length)) {
        const keepKo = new Map(state.cues.map((c) => [c.start + ':' + c.text, c.koMt]));
        setCues(cues, [], { id: 'texttrack', lang: 'en', label: 'player', cc: false }, null);
        state.cues.forEach((c) => { const k = keepKo.get(c.start + ':' + c.text); if (k) c.koMt = k; });
        refreshAllKo();
      }
    }, 3000);
  }
  function stopTextTrackPoll() { if (state.ttPoll) { clearInterval(state.ttPoll); state.ttPoll = null; } }

  // 디즈니+: HLS 마스터 플레이리스트에서 자막 트랙 → 세그먼트 목록
  async function onMaster(url) {
    if (adapter.name !== 'disney' || !url || url === masterUrlPending) return;
    masterUrlPending = url;
    const token = state.runToken;
    try {
      setStatus('자막 목록 읽는 중…');
      const master = S.parseM3U8(await fetchText(url), url);
      const subs = master.subtitles.filter((s) => !s.forced && !/--forced--/i.test(s.name));
      const tracks = [];
      for (const s of subs) {
        const lang = (s.lang || '').toLowerCase().split(/[-_]/)[0];
        if (lang !== 'en' && lang !== 'ko') continue;
        const pl = S.parseM3U8(await fetchText(s.uri), s.uri);
        const urls = pl.segments.map((x) => x.uri);
        if (!urls.length) continue;
        tracks.push({ id: s.uri, lang: s.lang, label: s.name || s.lang, cc: /sdh|\[cc\]|accessibility/i.test(s.name + ' ' + s.characteristics), forced: false, urls, format: 'vtt' });
      }
      if (token !== state.runToken) return;
      const vid = state.videoId || currentVideoId();
      if (vid) trackCache.set(vid, tracks);
      applyTracks(tracks);
    } catch (e) {
      if (token === state.runToken) setStatus('자막 목록을 읽지 못했습니다: ' + (e && e.message), true);
    } finally {
      masterUrlPending = null;
    }
  }

  // ───────────── 기계 번역 ─────────────
  const mt = { pending: new Set(), queue: new Set(), timer: null };
  function ensureTranslations(center) {
    const idxs = [];
    for (let i = Math.max(0, center - 3); i <= Math.min(state.cues.length - 1, center + 10); i++) {
      if (wantMT(state.cues[i]) && !mt.pending.has(i)) idxs.push(i);
    }
    requestMT(idxs);
  }
  function queueRowTranslation(i) {
    if (!wantMT(state.cues[i]) || mt.pending.has(i)) return;
    mt.queue.add(i);
    clearTimeout(mt.timer);
    mt.timer = setTimeout(() => { const idxs = Array.from(mt.queue).slice(0, 20); mt.queue.clear(); requestMT(idxs); }, 200);
  }
  async function requestMT(idxs) {
    idxs = idxs.filter((i) => state.cues[i] && !mt.pending.has(i));
    if (!idxs.length) return;
    const token = state.runToken;
    idxs.forEach((i) => mt.pending.add(i));
    const texts = idxs.map((i) => state.cues[i].text.replace(/\n/g, ' '));
    try {
      const res = await bg({ type: 'translate', texts, from: 'en', to: 'ko' });
      if (token !== state.runToken || !res || !Array.isArray(res.translations)) return;
      res.translations.forEach((t, k) => {
        const i = idxs[k];
        if (t && state.cues[i]) { state.cues[i].koMt = t; updateRowKo(i); }
      });
      renderOverlay(true);
    } catch (e) {
      setStatus('번역 실패: ' + (e && e.message), true);
    } finally {
      idxs.forEach((i) => mt.pending.delete(i));
    }
  }
  async function translateAll() {
    const idxs = state.cues.map((c, i) => i).filter((i) => wantMT(state.cues[i]));
    if (!idxs.length) { toast('번역할 줄이 없습니다'); return; }
    toast('전체 ' + idxs.length + '줄 번역 시작');
    for (let k = 0; k < idxs.length; k += 15) {
      if (!state.cues.length) return;
      await requestMT(idxs.slice(k, k + 15));
    }
    toast('번역 완료');
  }

  // ───────────── 저장(별표) ─────────────
  const itemIdFor = (c) => adapter.name + ':' + state.videoId + ':' + c.start;
  async function loadSaved() {
    if (!state.videoId) return;
    try {
      const res = await bg({ type: 'items.list', platform: adapter.name, videoId: state.videoId });
      state.saved = new Map((res && res.items || []).map((it) => [it.id, it]));
      refreshSavedMarks();
      renderOverlay(true);
    } catch (e) { /* ignore */ }
  }
  function buildItem(c, i) {
    const meta = state.meta || adapter.domTitle() || {};
    return {
      id: itemIdFor(c), platform: adapter.name, videoId: state.videoId, url: adapter.pageUrl(state.videoId),
      title: meta.title || (adapter.label + ' ' + state.videoId), episode: meta.episode || '',
      startMs: c.start, endMs: c.end, text: c.text,
      translation: koFor(c) || c.koTrack || c.koMt || '', translationSource: c.koTrack ? 'track' : (c.koMt ? 'mt' : ''),
      prevText: state.cues[i - 1] ? state.cues[i - 1].text : '', nextText: state.cues[i + 1] ? state.cues[i + 1].text : '',
      savedAt: Date.now(), box: 'learning', comment: '', reviews: 0, forgot: 0,
    };
  }
  async function toggleSave(i) {
    const c = state.cues[i];
    if (!c) return;
    const id = itemIdFor(c);
    try {
      if (state.saved.has(id)) {
        state.saved.delete(id);
        refreshSavedMarks(); renderOverlay(true);
        await bg({ type: 'items.remove', id });
        toast('저장 취소');
      } else {
        const item = buildItem(c, i);
        state.saved.set(id, item);
        refreshSavedMarks(); renderOverlay(true);
        await bg({ type: 'items.save', item });
        toast('★ 저장했습니다');
        if (!item.translation) {
          const res = await bg({ type: 'translate', texts: [c.text.replace(/\n/g, ' ')], from: 'en', to: 'ko' }).catch(() => null);
          const t = res && res.translations && res.translations[0];
          if (t) { c.koMt = t; updateRowKo(i); await bg({ type: 'items.update', id, patch: { translation: t, translationSource: 'mt' } }).catch(() => {}); }
        }
      }
    } catch (e) {
      toast('저장 실패: ' + (e && e.message));
      loadSaved();
    }
  }
  function refreshSavedMarks() {
    if (!ui.rows) return;
    for (let i = 0; i < ui.rows.length; i++) {
      const c = state.cues[i];
      const saved = c && state.saved.has(itemIdFor(c));
      ui.rows[i].classList.toggle('saved', !!saved);
      const star = ui.rows[i].lastElementChild;
      if (star) star.textContent = saved ? '★' : '☆';
    }
  }

  // ───────────── 제목 ─────────────
  function setMeta(m) {
    if (!m || !m.title) return;
    state.meta = { title: String(m.title), episode: String(m.episode || '') };
    if (ui.title) ui.title.textContent = state.meta.title + (state.meta.episode ? ' · ' + state.meta.episode : '');
    if (ui.title) ui.title.title = ui.title.textContent;
  }
  async function loadMeta() {
    const token = state.runToken;
    if (pageMeta && adapter.name === 'disney') setMeta(pageMeta);
    for (let i = 0; i < 10 && token === state.runToken; i++) {
      try {
        const r = await page.request({ type: 'getMeta', videoId: state.videoId }, 3000);
        if (token !== state.runToken) return;
        if (r && r.meta && r.meta.title) { setMeta(r.meta); return; }
      } catch (e) { /* ignore */ }
      const dom = adapter.domTitle();
      if (dom && dom.title) setMeta(dom);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // ───────────── UI ─────────────
  function mountUI() {
    if (ui.root) return;
    ui.root = true;
    const style = el('style', { id: 'st-layout-style' });
    style.textContent = (adapter.layoutCss || '') + '\n';
    document.documentElement.append(style);
    ui.layoutStyle = style;
    ui.nativeStyle = el('style', { id: 'st-native-style' });
    document.documentElement.append(ui.nativeStyle);

    // 패널
    ui.panel = el('div', { id: 'st-panel' });
    ui.title = el('div', { class: 'st-brand', text: 'SubTutor' });
    ui.btnAP = el('button', { class: 'st-mode', title: '자동 일시정지 (P): 자막이 끝나면 멈춥니다. F로 다시 듣기', onclick: () => setMode('autoPause', !settings.autoPause) }, 'AP');
    ui.btnShadow = el('button', { class: 'st-mode st-shadow', title: '쉐도잉 (W): 자막이 끝나면 쉬었다가 자동으로 이어 재생합니다', onclick: () => setMode('shadowing', !settings.shadowing) }, '쉐도잉');
    ui.shadowSec = el('select', { class: 'st-shadow-sec', title: '쉐도잉 쉬는 시간', onchange: (e) => saveSettings({ shadowPauseSec: +e.target.value }) });
    for (let s = 1; s <= 7; s++) ui.shadowSec.append(el('option', { value: s }, s + '초'));
    ui.btnSettings = el('button', { class: 'st-icon', title: '설정', onclick: () => ui.settings.classList.toggle('st-hidden') }, '⚙');
    ui.btnClose = el('button', { class: 'st-icon', title: '패널 닫기', onclick: () => setPanelOpen(false) }, '✕');
    const head = el('div', { class: 'st-head' }, [ui.title, ui.btnAP, ui.btnShadow, ui.shadowSec, ui.btnSettings, ui.btnClose]);
    ui.status = el('div', { class: 'st-status' });
    ui.list = el('div', { class: 'st-list' });
    ui.list.addEventListener('click', (e) => {
      const row = e.target.closest('.st-row');
      if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('.st-star')) { toggleSave(i); return; }
      goToCue(i);
    });
    const markScroll = () => { state.userScrollAt = now(); };
    ui.list.addEventListener('wheel', markScroll, { passive: true });
    ui.list.addEventListener('touchmove', markScroll, { passive: true });
    ui.list.addEventListener('mousedown', (e) => { if (e.offsetX > ui.list.clientWidth) markScroll(); });
    ui.foot = el('div', { class: 'st-foot' });
    ui.foot.innerHTML = '<b>A</b> 이전 · <b>S</b> 반복 · <b>D</b> 다음 · <b>F</b> 다시 듣기 · <b>E</b> 저장 · <b>P</b> AP · <b>W</b> 쉐도잉 · <b>`</b> 패널';
    ui.settings = buildSettings();
    ui.panel.append(head, ui.status, ui.list, ui.settings, ui.foot);

    ui.toggle = el('button', { id: 'st-toggle', title: 'SubTutor 자막 패널 열기 (`)', onclick: () => setPanelOpen(true) }, '‹');
    document.body.append(ui.panel, ui.toggle);

    // 영상 위 자막
    ui.overlay = el('div', { id: 'st-overlay', class: 'st-hidden' });
    ui.ovText = el('span', { class: 'st-ov-text' });
    ui.ovStar = el('button', { class: 'st-ov-star', title: '이 자막 저장 (E)', onclick: (e) => { e.stopPropagation(); const i = displayIndex(); if (i >= 0) toggleSave(i); } }, '☆');
    ui.ovEn = el('div', { class: 'st-ov-en' }, [ui.ovText, ui.ovStar]);
    ui.ovKo = el('div', { class: 'st-ov-ko' });
    ui.ovBox = el('div', { class: 'st-ov-box' }, [ui.ovEn, ui.ovKo]);
    ui.ovShadowText = el('div', { class: 'st-ov-shadow-text' });
    ui.ovShadowBar = el('div', { class: 'st-ov-shadow-bar' });
    ui.ovShadow = el('div', { class: 'st-ov-shadow' }, [ui.ovShadowText, el('div', { class: 'st-ov-shadow-track' }, ui.ovShadowBar)]);
    ui.ovModes = el('div', { class: 'st-ov-modes' });
    ui.overlay.append(ui.ovBox, ui.ovShadow, ui.ovModes);
    ui.toast = el('div', { class: 'st-toast' });
    ensureOverlayMounted();

    document.addEventListener('fullscreenchange', onFullscreenChange);
    startClearanceWatch();
    startNativeAlignWatch();
    renderList();
    updateModeUI();
    if (state.meta) setMeta(state.meta);
    if (state.statusText) setStatus(state.statusText, state.statusErr);
    refreshSavedMarks();
  }
  function ensureOverlayMounted() {
    if (!ui.overlay) return;
    const container = adapter.container();
    if (!container) return;
    if (ui.overlay.parentElement !== container) {
      const pos = getComputedStyle(container).position;
      if (pos === 'static') container.style.position = 'relative';
      container.append(ui.overlay, ui.toast);
    }
  }
  function onFullscreenChange() {
    const fs = document.fullscreenElement;
    const host = fs && fs !== document.documentElement && fs !== document.body ? fs : document.body;
    if (ui.panel && ui.panel.parentElement !== host) host.append(ui.panel, ui.toggle);
    ensureOverlayMounted();
  }
  function setPanelOpen(open) {
    saveSettings({ panelOpen: !!open });
  }
  function applySettings() {
    if (!ui.root) return;
    const open = settings.panelOpen && state.active;
    ui.panel.classList.toggle('st-closed', !open);
    ui.toggle.classList.toggle('st-hidden', open || !state.active);
    document.documentElement.classList.toggle('st-panel-open', open);
    document.documentElement.style.setProperty('--st-font-scale', String((settings.fontScale || 100) / 100));
    ui.nativeStyle.textContent = settings.hideNative && state.active ? (adapter.nativeHideCss || '') : '';
    ui.shadowSec.value = String(settings.shadowPauseSec);
    syncSettingsForm();
    updateModeUI();
    renderOverlay(true);
  }
  function updateModeUI() {
    if (!ui.root) return;
    ui.btnAP.classList.toggle('on', !!settings.autoPause);
    ui.btnShadow.classList.toggle('on', !!settings.shadowing);
    ui.btnShadow.textContent = '쉐도잉';
    ui.ovModes.textContent = '';
    if (state.loop) ui.ovModes.append(el('span', { class: 'st-ov-chip on-loop' }, '🔁 반복'));
    if (settings.autoPause) ui.ovModes.append(el('span', { class: 'st-ov-chip on-ap' }, '⏸ AP'));
    if (settings.shadowing) ui.ovModes.append(el('span', { class: 'st-ov-chip on-shadow' }, '🗣 쉐도잉 ' + settings.shadowPauseSec + '초'));
  }
  function setStatus(text, isErr) {
    state.statusText = text; state.statusErr = !!isErr;
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.classList.toggle('st-err', !!isErr);
    if (isErr) {
      ui.status.append(el('button', { onclick: () => { trackCache.delete(state.videoId); startVideo(state.videoId); } }, '다시 시도'));
    }
  }
  let toastTimer = null;
  function toast(text) {
    if (!ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1300);
  }

  function buildSettings() {
    const box = el('div', { class: 'st-settings st-hidden' });
    const f = {};
    const field = (label, input, hint) => el('div', { class: 'st-field' }, [el('label', null, [label, hint ? el('small', { text: hint }) : null]), input]);
    const sw = (key, onChange) => { const i = el('input', { type: 'checkbox', class: 'st-switch' }); i.addEventListener('change', () => (onChange || ((v) => saveSettings({ [key]: v })))(i.checked)); f[key] = i; return i; };
    f.translationSource = el('select', { onchange: (e) => { saveSettings({ translationSource: e.target.value }); refreshAllKo(); if (state.current >= 0) ensureTranslations(state.current); } });
    [['auto', '자동 (플랫폼 한국어 자막 → 없으면 기계번역)'], ['track', '플랫폼 한국어 자막만'], ['mt', '기계 번역만'], ['off', '끄기']].forEach(([v, t]) => f.translationSource.append(el('option', { value: v }, t)));
    f.fontScale = el('input', { type: 'range', min: 60, max: 160, step: 5 });
    f.fontScale.addEventListener('input', () => saveSettings({ fontScale: +f.fontScale.value }));
    f.shadowPauseSec = el('input', { type: 'range', min: 1, max: 7, step: 1 });
    f.shadowPauseSecLabel = el('span', { text: '' });
    f.shadowPauseSec.addEventListener('input', () => { f.shadowPauseSecLabel.textContent = f.shadowPauseSec.value + '초'; saveSettings({ shadowPauseSec: +f.shadowPauseSec.value }); });
    const num = (key, min, max) => { const i = el('input', { type: 'number', min, max, step: 50 }); i.addEventListener('change', () => saveSettings({ [key]: clamp(+i.value || 0, min, max) })); f[key] = i; return i; };
    f.diag = el('div', { class: 'st-diag' });
    box.append(
      el('h4', { text: '번역' }),
      field('한국어 번역 표시', sw('showTranslation', (v) => { saveSettings({ showTranslation: v }); refreshAllKo(); if (v && state.current >= 0) ensureTranslations(state.current); })),
      field('번역 출처', f.translationSource),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn', onclick: translateAll }, '이 영상 전체 기계 번역')]),
      el('h4', { text: '화면' }),
      field('영상 위 자막 표시', sw('overlay')),
      field('플랫폼 기본 자막 숨기기', sw('hideNative'), '끄면 플랫폼 자막과 겹쳐 보입니다'),
      field('자막 크기', f.fontScale),
      el('h4', { text: '재생' }),
      field('쉐도잉 쉬는 시간', el('span', null, [f.shadowPauseSec, ' ', f.shadowPauseSecLabel]), '자막이 끝난 뒤 따라 말할 시간 (1~7초)'),
      field('재생 시작 여유 (ms)', num('leadMs', 0, 2000), '자막 시작보다 이만큼 앞에서 재생'),
      field('재생 끝 여유 (ms)', num('tailMs', 0, 2000)),
      field('자막 시간 보정 (ms)', num('offsetMs', -60000, 60000), '자막이 소리보다 늦으면 음수, 빠르면 양수'),
      el('h4', { text: '저장한 자막' }),
      el('div', { class: 'st-btn-row' }, [
        el('button', { class: 'st-btn st-primary', onclick: () => bg({ type: 'openSite' }).catch(() => {}) }, '웹에서 저장 목록 · 퀴즈 열기'),
        el('button', { class: 'st-btn', onclick: () => { f.diag.textContent = diagnostics(); navigator.clipboard && navigator.clipboard.writeText(f.diag.textContent).then(() => toast('진단 정보를 복사했습니다'), () => {}); } }, '진단 정보'),
      ]),
      f.diag,
    );
    ui.form = f;
    return box;
  }
  function syncSettingsForm() {
    const f = ui.form; if (!f) return;
    f.showTranslation.checked = !!settings.showTranslation;
    f.overlay.checked = !!settings.overlay;
    f.hideNative.checked = !!settings.hideNative;
    f.translationSource.value = settings.translationSource;
    f.fontScale.value = settings.fontScale;
    f.shadowPauseSec.value = settings.shadowPauseSec;
    f.shadowPauseSecLabel.textContent = settings.shadowPauseSec + '초';
    f.leadMs.value = settings.leadMs; f.tailMs.value = settings.tailMs; f.offsetMs.value = settings.offsetMs;
  }
  function diagnostics() {
    const v = adapter.video();
    return [
      'SubTutor ' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ''),
      'platform=' + adapter.name + ' videoId=' + state.videoId + ' url=' + location.href,
      'video=' + (v ? 'yes rs=' + v.readyState + ' t=' + v.currentTime.toFixed(2) + ' dur=' + v.duration : 'no') + ' pageTime=' + (A.shared.pageTime.at ? Math.round(A.shared.pageTime.ms) : '-'),
      'cues=' + state.cues.length + ' ko=' + state.koCues.length + ' en=' + JSON.stringify(state.enTrack && { lang: state.enTrack.lang, label: state.enTrack.label, format: state.enTrack.format }) + ' ko=' + JSON.stringify(state.koTrack && { lang: state.koTrack.lang, label: state.koTrack.label }),
      'tracks=' + JSON.stringify((trackCache.get(state.videoId) || []).map((t) => t.lang + (t.cc ? '[cc]' : '') + (t.forced ? '[f]' : ''))),
      'offset=' + settings.offsetMs + ' auto=' + state.offsetAuto + ' samples=' + JSON.stringify(state.alignSamples),
      'meta=' + JSON.stringify(state.meta) + ' status=' + state.statusText,
      'modes loop=' + state.loop + ' ap=' + settings.autoPause + ' shadow=' + settings.shadowing + '/' + settings.shadowPauseSec + 's',
      'idx current=' + state.current + ' lastShown=' + state.lastShown + ' pausedFor=' + state.pausedFor + ' display=' + state.lastDisplayIdx + ' paused=' + adapter.isPaused() + ' clip=' + JSON.stringify(state.clip),
    ].join('\n');
  }

  // 목록
  let rowObserver = null;
  function renderList() {
    if (!ui.list) return;
    if (rowObserver) rowObserver.disconnect();
    ui.list.textContent = '';
    ui.rows = [];
    if (!state.cues.length) {
      ui.list.append(el('div', { class: 'st-empty' }, state.videoId ? '자막을 불러오면 여기에 목록이 표시됩니다.\n줄을 누르면 그 위치로 이동합니다.' : '영상을 재생하면 자막 목록이 표시됩니다.'));
      return;
    }
    const frag = document.createDocumentFragment();
    state.cues.forEach((c, i) => {
      const row = el('div', { class: 'st-row', 'data-i': i }, [
        el('div', { class: 'st-row-main' }, [
          el('div', { class: 'st-en', text: c.text.replace(/\n/g, ' ') }),
          el('div', { class: 'st-ko', text: settings.showTranslation ? koFor(c) : '' }),
        ]),
        el('button', { class: 'st-star', title: '저장 (E)' }, '☆'),
      ]);
      frag.append(row);
      ui.rows.push(row);
    });
    ui.list.append(frag);
    rowObserver = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) queueRowTranslation(+en.target.dataset.i);
    }, { root: ui.list, rootMargin: '200px 0px' });
    ui.rows.forEach((r) => rowObserver.observe(r));
    highlightRow(state.current, true);
  }
  function updateRowKo(i) {
    const row = ui.rows && ui.rows[i];
    if (row) row.firstElementChild.lastElementChild.textContent = settings.showTranslation ? koFor(state.cues[i]) : '';
  }
  function refreshAllKo() {
    if (!ui.rows) return;
    for (let i = 0; i < ui.rows.length; i++) updateRowKo(i);
    renderOverlay(true);
  }
  function highlightRow(i, force) {
    if (!ui.rows) return;
    const prev = ui.list.querySelector('.st-row.active');
    if (prev && +prev.dataset.i !== i) prev.classList.remove('active');
    if (i < 0 || !ui.rows[i]) return;
    ui.rows[i].classList.add('active');
    if (force || now() - state.userScrollAt > 4000) {
      const row = ui.rows[i];
      const top = row.offsetTop - ui.list.clientHeight / 2 + row.offsetHeight / 2;
      ui.list.scrollTo({ top, behavior: force ? 'auto' : 'smooth' });
    }
  }

  // 영상 위 자막
  function displayIndex() {
    if (state.current >= 0) return state.current;
    // 자동 일시정지/쉐도잉으로 멈춘 동안(멈춤 요청 직후 포함)에는 방금 끝난 자막을 계속 보여 준다
    if (state.pausedFor >= 0 && (adapter.isPaused() || now() - state.pausedAt < 1500)) return state.pausedFor;
    return -1;
  }
  function renderOverlay(force) {
    if (!ui.overlay) return;
    const i = displayIndex();
    if (!force && i === state.lastDisplayIdx) return;
    state.lastDisplayIdx = i;
    if (!settings.overlay || i < 0 || !state.cues[i]) { ui.overlay.classList.add('st-hidden'); return; }
    const c = state.cues[i];
    ui.ovText.textContent = c.text;
    ui.ovKo.textContent = settings.showTranslation ? koFor(c) : '';
    ui.ovStar.textContent = state.saved.has(itemIdFor(c)) ? '★' : '☆';
    ui.overlay.classList.remove('st-hidden');
  }
  // 플랫폼 컨트롤 바가 보이면 자막을 그만큼 올린다
  function startClearanceWatch() {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const container = ui.overlay && ui.overlay.parentElement;
      if (!container || !adapter.controlBars) return;
      const bottom = container.getBoundingClientRect().bottom;
      let top = Infinity;
      for (const sel of adapter.controlBars) {
        const bar = container.querySelector(sel) || document.querySelector(sel);
        if (!bar) continue;
        const r = bar.getBoundingClientRect();
        if (r.height > 0 && r.top < bottom) top = Math.min(top, r.top);
      }
      const px = top === Infinity ? 0 : Math.max(0, Math.round(bottom - top));
      ui.overlay.style.setProperty('--st-clearance', px + 'px');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', schedule);
    setInterval(schedule, 1000);
  }
  // 플랫폼이 그리는 자막 텍스트와 우리 큐를 맞춰 시간 보정값을 자동으로 찾는다 (프라임/디즈니)
  function startNativeAlignWatch() {
    if (adapter.name === 'netflix' || !adapter.nativeCueSelector) return;
    const check = () => {
      if (!state.cues.length) return;
      const nodes = document.querySelectorAll(adapter.nativeCueSelector);
      if (!nodes.length) { state.lastNativeText = ''; return; }
      const text = Array.from(nodes).map((n) => n.textContent.trim()).filter(Boolean).join(' ');
      if (!text || text === state.lastNativeText) return;
      state.lastNativeText = text;
      const raw = adapter.timeMs();
      if (!isFinite(raw)) return;
      const norm = S.normalizeForCompare(text);
      if (norm.split(' ').length < 3) return;
      // 현재 시간 ±90초 안에서 같은 문장을 찾는다
      let best = null;
      for (const c of state.cues) {
        if (c.start < raw - 90000 || c.start > raw + 90000) continue;
        if (S.normalizeForCompare(c.text) === norm) { if (best) { best = null; break; } best = c; }
      }
      if (!best) return;
      const sample = best.start - raw; // 우리 시간 = raw + offset 이 되게 하는 offset
      state.alignSamples.push(Math.round(sample));
      if (state.alignSamples.length > 7) state.alignSamples.shift();
      if (state.alignSamples.length >= 3) {
        const sorted = state.alignSamples.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const spread = sorted[sorted.length - 1] - sorted[0];
        if (spread < 400 && Math.abs(med - state.offsetAuto) > 250) {
          state.offsetAuto = Math.abs(med) < 250 ? 0 : med;
          toast('자막 시간 자동 보정: ' + (state.offsetAuto >= 0 ? '+' : '') + state.offsetAuto + 'ms');
        }
      }
    };
    new MutationObserver(() => check()).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ───────────── 재생 제어 ─────────────
  function seekTo(ms) {
    state.seekByUsUntil = now() + 1500;
    adapter.seek(Math.max(0, ms));
  }
  function cancelModesPending() { clearShadow(); clearEndTimer(); state.pausedFor = -1; }
  function goToCue(i, opts) {
    if (!state.cues.length) return;
    i = clamp(i, 0, state.cues.length - 1);
    const c = state.cues[i];
    if (state.clip) stopClip('user');
    cancelModesPending();
    state.lastShown = i; state.prevIdx = -1;
    if (state.loop) state.loopIdx = i;
    seekTo(c.start - settings.leadMs);
    if (!opts || opts.play !== false) { markResume(); adapter.play(); }
    highlightRow(i, true);
  }
  function anchorIndex() {
    if (state.current >= 0) return state.current;
    const t = nowMs();
    if (!isFinite(t)) return state.lastShown;
    return S.lastStartedIndex(state.cues, t);
  }
  function prevCue() {
    if (!state.cues.length) return;
    const t = nowMs();
    if (state.current >= 0) goToCue(state.current - 1);
    else { const i = S.lastStartedIndex(state.cues, isFinite(t) ? t : 0); goToCue(i < 0 ? 0 : i); }
  }
  function nextCue() {
    if (!state.cues.length) return;
    const t = nowMs();
    if (state.current >= 0) goToCue(state.current + 1);
    else { const i = S.nextStartingIndex(state.cues, isFinite(t) ? t : 0); goToCue(i < 0 ? state.cues.length - 1 : i); }
  }
  function replayCue() {
    const i = anchorIndex();
    if (i >= 0) goToCue(i);
  }
  function toggleLoop() {
    if (state.loop) { state.loop = false; state.loopIdx = -1; toast('반복 끔'); }
    else {
      const i = anchorIndex();
      if (i < 0) return;
      state.loop = true; state.loopIdx = i;
      toast('🔁 이 자막 반복');
      goToCue(i);
    }
    updateModeUI();
  }
  function setMode(mode, on) {
    const patch = {};
    if (mode === 'autoPause') { patch.autoPause = !!on; if (on) patch.shadowing = false; }
    else { patch.shadowing = !!on; if (on) patch.autoPause = false; }
    saveSettings(patch);
    if (!on) cancelModesPending();
    toast(mode === 'autoPause' ? (on ? '⏸ 자동 일시정지 켬 (F: 다시 듣기)' : '자동 일시정지 끔') : (on ? '🗣 쉐도잉 켬 · ' + settings.shadowPauseSec + '초 쉬고 다음 자막' : '쉐도잉 끔'));
    updateModeUI();
  }
  function markResume() { state.resumeByUsUntil = now() + 1500; }
  function pauseFor(i) {
    state.pausedFor = i;
    state.pausedAt = now();
    state.resumeByUsUntil = 0;
    adapter.pause();
    renderOverlay(true);
    if (settings.shadowing) startShadowWait(i);
  }
  function startShadowWait(i) {
    clearShadow();
    const sec = clamp(+settings.shadowPauseSec || 2, 1, 7);
    state.shadowCueIdx = i;
    ui.ovShadowText.textContent = '🗣 따라 말해 보세요 · ' + sec + '초 뒤 계속';
    ui.ovShadowBar.style.transition = 'none';
    ui.ovShadowBar.style.width = '100%';
    ui.ovShadow.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => { ui.ovShadowBar.style.transition = 'width ' + sec + 's linear'; ui.ovShadowBar.style.width = '0%'; }));
    state.shadowTimer = setTimeout(() => {
      state.shadowTimer = null;
      ui.ovShadow.classList.remove('on');
      if (settings.shadowing && state.pausedFor === i && adapter.isPaused()) {
        markResume();
        adapter.play();
      }
    }, sec * 1000);
  }
  function clearShadow() {
    if (state.shadowTimer) { clearTimeout(state.shadowTimer); state.shadowTimer = null; }
    if (ui.ovShadow) ui.ovShadow.classList.remove('on');
  }
  function clearEndTimer() { if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; } }
  function scheduleEndCheck(i, t) {
    clearEndTimer();
    const c = state.cues[i];
    if (!c) return;
    const v = adapter.video();
    const rate = (v && v.playbackRate) || 1;
    const wait = Math.max(0, (c.end - t) / rate - 15);
    state.endTimer = setTimeout(() => { state.endTimer = null; tick(true); }, wait);
  }

  // 원격 재생 (웹사이트에서 "재생"을 눌렀을 때)
  function startClip(msg) {
    cancelModesPending();
    state.loop = false; state.loopIdx = -1; updateModeUI();
    state.clip = { clipId: msg.clipId, startMs: msg.startMs, endMs: msg.endMs, phase: 'seeking', startedAt: now(), playTries: 0, lastPlayAt: now() };
    seekTo(msg.startMs - settings.leadMs);
    markResume();
    adapter.play();
    highlightRow(S.findCueIndex(state.cues, msg.startMs + 10), true);
  }
  function clipEvent(event, extra) {
    if (!state.clip) return;
    bg(Object.assign({ type: 'player.event', clipId: state.clip.clipId, event }, extra || {})).catch(() => {});
  }
  function stopClip(reason) {
    if (!state.clip) return;
    const c = state.clip;
    state.clip = null;
    bg({ type: 'player.event', clipId: c.clipId, event: reason === 'ended' ? 'ended' : 'stopped', reason }).catch(() => {});
  }
  function handleClip(t, paused) {
    const c = state.clip;
    if (!c) return;
    const start = c.startMs - settings.leadMs;
    if (c.phase === 'seeking') {
      if (!paused && t >= start - 600 && t < c.endMs) {
        c.phase = 'playing';
        clipEvent('playing');
        return;
      }
      if (paused && now() - c.lastPlayAt > 1500 && c.playTries < 4) {
        c.playTries++; c.lastPlayAt = now(); markResume(); adapter.play();
      }
      if (now() - c.startedAt > 25000) {
        state.clip = null;
        bg({ type: 'player.event', clipId: c.clipId, event: 'error', message: paused ? '플레이어가 재생을 시작하지 못했습니다. 플레이어 탭을 한 번 클릭한 뒤 다시 시도하세요.' : '탐색 시간 초과' }).catch(() => {});
      }
      return;
    }
    if (t >= c.endMs + settings.tailMs || t < start - 3000) {
      adapter.pause();
      state.clip = null;
      bg({ type: 'player.event', clipId: c.clipId, event: 'ended' }).catch(() => {});
      return;
    }
    if (paused && now() - c.lastPlayAt > 2500) {
      // 사용자가 멈춤
      state.clip = null;
      bg({ type: 'player.event', clipId: c.clipId, event: 'stopped' }).catch(() => {});
    }
  }

  // ───────────── 메인 루프 ─────────────
  function tick(fromTimer) {
    if (!state.active) return;
    const t = nowMs();
    if (!isFinite(t)) return;
    const paused = adapter.isPaused();
    const cues = state.cues;
    const idx = cues.length ? S.findCueIndex(cues, t) : -1;
    const prevIdx = state.prevIdx;

    if (idx !== state.current) {
      state.current = idx;
      if (idx >= 0) {
        state.lastShown = idx;
        highlightRow(idx, false);
        ensureTranslations(idx);
        if (!state.clip && !paused && (settings.autoPause || settings.shadowing) && !state.loop) scheduleEndCheck(idx, t);
      }
    }
    if (idx < 0 && !paused && Math.abs(t - state.lastT) > 1500) state.lastShown = S.lastStartedIndex(cues, t);

    if (state.clip) {
      handleClip(t, paused);
    } else if (!paused) {
      if (state.loop && state.loopIdx >= 0 && cues[state.loopIdx]) {
        const c = cues[state.loopIdx];
        if ((t >= c.end + settings.tailMs - 20 || t < c.start - settings.leadMs - 2500) && now() - state.lastLoopSeekAt > 500) {
          state.lastLoopSeekAt = now();
          seekTo(c.start - settings.leadMs);
        }
      } else if ((settings.autoPause || settings.shadowing) && prevIdx >= 0 && prevIdx !== idx && cues[prevIdx]) {
        const ended = cues[prevIdx];
        if (t >= ended.end - 80 && t < ended.end + 1500 && state.pausedFor !== prevIdx) {
          pauseFor(prevIdx);
        }
      } else if ((settings.autoPause || settings.shadowing) && fromTimer && idx >= 0 && cues[idx] && t >= cues[idx].end - 80 && state.pausedFor !== idx) {
        // 타이머가 큐 끝 직전에 깨웠는데 아직 같은 큐 안이면 조금 뒤 다시 확인
        scheduleEndCheck(idx, t);
      }
    }
    if (paused !== state.lastPaused) { state.lastPaused = paused; renderOverlay(true); }
    else renderOverlay(false);
    state.prevIdx = idx;
    state.lastT = t;
  }
  setInterval(() => tick(false), 40);

  // ───────────── 단축키 ─────────────
  const KEY_ACTIONS = { KeyA: prevCue, KeyS: toggleLoop, KeyD: nextCue, KeyF: replayCue, KeyE: () => { const i = anchorIndex(); if (i >= 0) toggleSave(i); }, KeyP: () => setMode('autoPause', !settings.autoPause), KeyW: () => setMode('shadowing', !settings.shadowing), Backquote: () => setPanelOpen(!settings.panelOpen) };
  function shouldHandleKey(e) {
    if (!state.active || !state.cues.length && e.code !== 'Backquote') return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isEditable(e.target) || (e.target && e.target.closest && e.target.closest('#st-panel input, #st-panel select, #st-panel textarea'))) return false;
    return !!KEY_ACTIONS[e.code];
  }
  window.addEventListener('keydown', (e) => {
    if (!shouldHandleKey(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    KEY_ACTIONS[e.code]();
  }, true);
  window.addEventListener('keyup', (e) => { if (shouldHandleKey(e)) { e.stopImmediatePropagation(); } }, true);
  window.addEventListener('keypress', (e) => { if (shouldHandleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

  // ───────────── 시작 ─────────────
  loadSettings().then(() => { checkVideo(); });
})();
