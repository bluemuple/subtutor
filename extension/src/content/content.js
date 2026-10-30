/*
 * SubTutor – 콘텐츠 스크립트 (ISOLATED world)
 * 자막 패널, 영상 위 영어+한국어 자막, 단축키(A/S/D/F/E/P/W), 자동 일시정지, 쉐도잉, 자막 저장(+오디오 캡처), 웹사이트 원격 재생.
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
    shadowPauseSec: 2,          // 고정 시간으로 쉴 때의 초 (1~7)
    shadowPauseMode: 'ratio',   // ratio = 자막 길이 × 배율(따라하기) | sec = 고정 초
    shadowPauseRatio: 1,        // 자막 길이의 몇 배를 쉴지 (0.5~3.0)
    dubPlayback: true,          // 더빙 재생: ★ 로 고른 녹음이 있는 구간은 원래 소리 대신 내 녹음 (☆ 를 고르면 자동으로 켜진다)
    dubRecRate: 1,              // 더빙 녹음 배속 (고른 값을 기억한다, 처음은 1배)
    leadMs: 150,
    tailMs: 200,
    audioMode: 'off',           // off | store | download | both : 별표 저장 시 오디오 처리
    enabled: {},                // 플랫폼별 켜기/끄기 { netflix: true, ... }
    // 듣기 훈련 (근거는 lib/explain.js)
    koMode: 'hold',             // always | hold(T 키를 누르는 동안) | afterRepeat(같은 줄 N회 반복 뒤)
    koRepeats: 3,
    secondPass: false,          // 2회차: 못 알아들음(Q) 표시한 줄만 한국어 바로 보임 + 강조
    cloze: 'off',               // off | function | random : 영상 위 자막 빈칸
    soundsLike: false,          // 소리 나는 대로 줄
    kiwiNotes: true,            // 키위·마오리·학교 용어 주석
    vocabProfile: true,         // 어휘 프로파일·말 속도
    loopLadder: false,          // S 반복 때 속도 사다리
    missedTag: '못 알아들음',
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  const state = {
    videoId: null, videoEl: null, active: false, tabId: null,
    cues: [], koCues: [], enTrack: null, koTrack: null, runToken: 0, trackRun: 0,
    current: -1, lastShown: -1, prevIdx: -1, lastT: 0, lastPaused: null, lastDisplayIdx: -2,
    loop: false, loopIdx: -1, lastLoopSeekAt: 0,
    pausedFor: -1, pausedAt: 0, shadowTimer: null, endTimer: null, resumeByUsUntil: 0, pauseByUsUntil: 0, seekByUsUntil: 0, lastSeekAt: 0, lastSeekTarget: NaN, playRequestedAt: 0, ensureTimer: null,
    clip: null, capturing: null,
    saved: new Map(), meta: null,
    offsetMs: 0, offsetSource: '', alignSamples: [], lastNativeText: '',
    userScrollAt: 0, statusText: '', statusErr: false,
    ttPoll: null, tickCount: 0,
    rate: 1, rateReapplyUntil: 0, clearanceCur: 0, clearanceLowSince: 0,
    koHold: false, clozeRevealIdx: -1, loopCount: 0, loopBaseRate: 1, profile: null, watched: new Set(), missed: new Set(), statsSavedAt: 0, seriesSaved: false,
    dubSegs: [], dubRange: [0, 0], dubBoxFor: -1, dubRec: null, dubLadder: null, dubPreview: null, dubPlay: null, dubMic: null, dubLoopRate: 1, dubPrevRate: 1, // 더빙
  };
  const Sp = globalThis.SubTutorSpeech, Voc = globalThis.SubTutorVocab, Ex = globalThis.SubTutorExplain, Kiwi = globalThis.SubTutorKiwi || [], Freq = globalThis.SubTutorFreq || '';
  const trackCache = new Map(); // videoId -> tracks
  let pageVideoId = null;
  let pageMeta = null;
  let masterUrlPending = null;
  const ui = {};

  // ───────────── 유틸 ─────────────
  const now = () => performance.now();
  const wall = () => performance.timeOrigin + performance.now();
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
  const isEnabled = () => !settings.enabled || settings.enabled[adapter.name] !== false;
  const effectiveOffset = () => state.offsetMs || 0;
  const rawMs = () => adapter.timeMs();
  const nowMs = () => { const raw = rawMs(); return isFinite(raw) ? raw + effectiveOffset() : NaN; };
  const cueVideoMs = (c) => c.start - effectiveOffset();
  const cueVideoEndMs = (c) => c.end - effectiveOffset();
  const offsetKey = () => adapter.name + ':' + state.videoId;

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
  function setEnabled(on) {
    const enabled = Object.assign({}, settings.enabled || {}, { [adapter.name]: !!on });
    saveSettings({ enabled });
    if (!on) { cancelModesPending(); closeDubBox(); stopDubPlay(); state.loop = false; state.loopIdx = -1; }
    toast(on ? 'SubTutor 켬' : 'SubTutor 끔 (컨트롤 바의 ST 버튼이나 팝업에서 다시 켤 수 있어요)');
    updateModeUI();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings && changes.settings.newValue) {
      const s = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue);
      const changedTranslation = s.translationSource !== settings.translationSource || s.showTranslation !== settings.showTranslation;
      const prev = settings;
      settings = s;
      applySettings();
      if (changedTranslation) { refreshAllKo(); if (state.current >= 0) ensureTranslations(state.current); }
      if (['koMode', 'secondPass', 'cloze', 'soundsLike', 'kiwiNotes', 'vocabProfile'].some((k) => prev[k] !== s[k])) { renderList(); renderOverlay(true); if (prev.vocabProfile !== s.vocabProfile) refreshProfileStatus(); }
    }
    if (changes.items) loadSaved();
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'status':
        sendResponse({ platform: adapter.name, videoId: state.videoId, ready: isPlayerReady(), cues: state.cues.length, title: state.meta && state.meta.title, enabled: isEnabled(), offsetMs: state.offsetMs });
        break;
      case 'playRange': startClip(msg); sendResponse({ ok: true }); break;
      case 'stopClip': stopClip('stopped'); sendResponse({ ok: true }); break;
      case 'clipLoop': if (state.clip) state.clip.loop = !!msg.loop; sendResponse({ ok: true }); break;
      case 'seekTo': cancelModesPending(); playFrom(msg.ms, msg.play === false); sendResponse({ ok: true }); break;
      case 'togglePanel': setPanelOpen(!settings.panelOpen); sendResponse({ ok: true }); break;
      case 'setEnabled': setEnabled(!!msg.enabled); sendResponse({ ok: true }); break;
      case 'popupOpened': onPopupOpened(); sendResponse({ ok: true, pending: false }); break;
      case 'invoke': sendResponse(onInvoke(msg)); break;
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
      case 'meta': if (d.meta && d.meta.title && (!d.videoId || d.videoId === state.videoId)) { pageMeta = d.meta; setMeta(d.meta); } break;
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
    const playerShown = typeof adapter.isPlayerActive === 'function' ? adapter.isPlayerActive(v) : true;
    const active = !!(id && v && playerShown);
    if (active !== state.active) {
      state.active = active;
      if (active) { mountUI(); applySettings(); registerPlayer(); }
      else { cancelModesPending(); closeDubBox(); stopDubPlay(); state.loop = false; state.loopIdx = -1; if (ui.root) { ui.overlay.classList.add('st-hidden'); applySettings(); } }
    }
    if (active) { ensureOverlayMounted(); mountControlButton(); if (adapter.deep && (state.tickCount % 4 === 0)) syncShadowNativeStyles(); }
    if (ui.root) { syncPanelWidth(); fitVideoBesidePanel(); }
  }
  function startVideo(id) {
    state.runToken++;
    state.trackRun++;
    state.videoId = id;
    state.cues = []; state.koCues = []; state.enTrack = null; state.koTrack = null;
    state.current = -1; state.lastShown = -1; state.prevIdx = -1; state.lastDisplayIdx = -2;
    state.loop = false; state.loopIdx = -1; state.pausedFor = -1; state.clip = null; state.capturing = null;
    state.saved = new Map(); state.meta = null; state.offsetMs = 0; state.offsetSource = ''; state.alignSamples = []; state.lastNativeText = '';
    clearShadow(); clearEndTimer(); stopTextTrackPoll(); clearTimeout(state.ensureTimer);
    closeDubBox(); stopDubPlay();
    state.dubSegs = [];
    dubBuffers.clear(); dubReady.clear(); dubBroken.clear();
    state.userScrollAt = 0; // 새 에피소드에서는 패널이 지금 줄로 바로 따라가게 (이전 에피소드에서 손으로 스크롤한 기록은 버린다)
    if (ui.root) { renderList(); renderOverlay(true); updateModeUI(); }
    if (!id) return;
    page.send({ type: 'hello' });
    setStatus('자막 불러오는 중…');
    loadOffset();
    loadTracks(id);
    loadSaved();
    loadDubs();
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
    v.addEventListener('pause', () => {
      // 우리가 play() 를 건 직후의 pause 는 플레이어의 되돌림이므로 재시도를 유지하고, 그 밖의 pause 는 사용자의 뜻으로 보고 재시도를 멈춘다
      if (now() - state.playRequestedAt > 400 && now() > state.pauseByUsUntil) clearTimeout(state.ensureTimer);
    });
    v.addEventListener('seeking', () => {
      state.seekingAt = now(); // 우리 것이든 사용자 것이든: 디즈니+ 는 이 뒤 새 위치를 알려 줄 때까지 예전 위치가 남는다 (dubTick 참고)
      if (now() < state.seekByUsUntil) return;
      state.lastSeekAt = now();
      clearShadow(); state.pausedFor = -1;
      clearTimeout(state.ensureTimer); // 사용자가 직접 옮겼으면, 우리가 걸어 둔 "그 자리에서 재생되는지 확인" 재시도가 다시 끌고 가지 않게 한다
      // 더빙: 옮긴 순간 지금 소리를 멈추고 시계를 새로 잰다 (디즈니+ 는 새 위치를 조금 늦게 알려 준다 → 아래 dubTick 에서 기다린다)
      state.userSeekAt = now();
      stopDubPlay();
      if (dubClock) dubClock.reset();
    });
    registerPlayer();
  }
  let registerTimer = null;
  function registerPlayer() {
    clearTimeout(registerTimer);
    registerTimer = setTimeout(() => {
      bg({ type: 'player.hello', platform: adapter.name, videoId: state.videoId, ready: isPlayerReady() }).then((r) => { if (r && Number.isInteger(r.tabId)) state.tabId = r.tabId; }).catch(() => {});
    }, 200);
  }
  setInterval(checkVideo, 500);

  // ───────────── 영상별 자막 시간 보정 ─────────────
  const platformOffsetKey = () => adapter.name + ':__last';
  async function loadOffset() {
    const key = offsetKey();
    try {
      const { offsets } = await chrome.storage.local.get('offsets');
      if (key !== offsetKey()) return;
      const saved = offsets && offsets[key];
      if (saved && Number.isFinite(saved.ms)) { state.offsetMs = saved.ms; state.offsetSource = saved.source || 'saved'; }
      else {
        // 같은 플랫폼에서 마지막으로 쓴 보정값을 먼저 적용해 두고(프라임은 보통 비슷함), 자막 대조로 다시 확정한다
        const last = offsets && offsets[platformOffsetKey()];
        if (last && Number.isFinite(last.ms) && last.ms) { state.offsetMs = last.ms; state.offsetSource = 'guess'; }
      }
      updateStatusOffset();
    } catch (e) { /* ignore */ }
  }
  async function saveOffset(ms, source) {
    state.offsetMs = Math.round(ms);
    state.offsetSource = source;
    try {
      const { offsets } = await chrome.storage.local.get('offsets');
      const map = offsets && typeof offsets === 'object' ? offsets : {};
      if (state.offsetMs) map[offsetKey()] = { ms: state.offsetMs, source, at: Date.now() }; else delete map[offsetKey()];
      if (source === 'auto' || source === 'manual') map[platformOffsetKey()] = { ms: state.offsetMs, source, at: Date.now() };
      const keys = Object.keys(map);
      if (keys.length > 300) keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0)).slice(0, keys.length - 300).forEach((k) => delete map[k]);
      await chrome.storage.local.set({ offsets: map });
    } catch (e) { /* ignore */ }
    state.current = -1; state.prevIdx = -1;
    updateStatusOffset();
    syncSettingsForm();
    renderOverlay(true);
  }
  function updateStatusOffset() { if (ui.status) setStatus(state.statusText, state.statusErr); }

  // ───────────── 자막 트랙 로딩 ─────────────
  function pickTrack(tracks, lang) {
    const want = lang.toLowerCase();
    const cands = tracks.filter((t) => t && !t.forced && String(t.lang || '').toLowerCase().split(/[-_]/)[0] === want);
    if (!cands.length) return null;
    const sdh = (t) => t.cc || /sdh|\[cc\]|closed caption|청각/i.test(t.label || '');
    const score = (t) => (t.translated ? 4 : 0) + (sdh(t) ? 2 : 0) + (t.asr ? 1 : 0);
    cands.sort((a, b) => score(a) - score(b));
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
      throw new Error((r && r.error) || 'page fetch failed');
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
      if (!ko && adapter.name === 'netflix') netflixKoFallback(token);
    } catch (e) {
      if (token !== state.trackRun) return;
      setStatus('자막을 내려받지 못했습니다: ' + (e && e.message), true);
    }
  }
  // manifest 에 한국어가 없어도 플레이어 트랙 목록에 있으면 잠시 트랙을 바꿔 받아온다
  async function netflixKoFallback(token) {
    try {
      const r = await page.request({ type: 'hydrate', lang: 'ko', preferCC: false }, 25000);
      if (token !== state.trackRun || !r || !r.track) return;
      const koCues = await loadTrackCues(r.track);
      if (token !== state.trackRun || !koCues.length) return;
      state.koCues = koCues; state.koTrack = r.track;
      const merged = S.mergeTranslations(state.cues, koCues);
      state.cues.forEach((c) => { if (c.koSource === 'track') c.koTrack = c.ko; delete c.ko; delete c.koSource; });
      if (merged) { setStatus('영어 ' + state.cues.length + '줄' + (state.enTrack && state.enTrack.cc ? ' (CC)' : '') + ' · 한국어 자막 ' + merged + '줄 연결'); refreshAllKo(); }
    } catch (e) { /* 기계 번역으로 계속 */ }
  }
  function setCues(enCues, koCues, enTrack, koTrack) {
    state.cues = enCues; state.koCues = koCues || []; state.enTrack = enTrack; state.koTrack = koTrack || null;
    state.cues.forEach((c) => { c.koTrack = ''; c.koMt = ''; });
    const merged = S.mergeTranslations(state.cues, state.koCues);
    state.cues.forEach((c) => { if (c.koSource === 'track') c.koTrack = c.ko; delete c.ko; delete c.koSource; });
    state.current = -1; state.lastShown = -1; state.prevIdx = -1; state.lastDisplayIdx = -2;
    const parts = ['영어 ' + state.cues.length + '줄' + (enTrack && enTrack.cc ? ' (CC)' : '') + (enTrack && enTrack.asr ? ' (자동 생성)' : '')];
    if (merged) parts.push('한국어 ' + merged + '줄 연결' + (koTrack && koTrack.translated ? ' (유튜브 번역)' : ''));
    else if (settings.translationSource !== 'off' && settings.translationSource !== 'track') parts.push('한국어: 기계 번역');
    state.baseStatus = parts.join(' · ');
    state.watched = new Set();
    computeProfile();
    setStatus(statusWithProfile());
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
        if (token !== state.runToken || state.cues.length) return;
        const tracks = [enR.track].concat(koR && koR.track ? [koR.track] : []);
        trackCache.set(vid, tracks);
        applyTracks(tracks);
      } catch (e) {
        if (token === state.runToken && !state.cues.length) setStatus('자막을 찾지 못했습니다: ' + (e && e.message), true);
      }
      return;
    }
    if (adapter.supportsTextTracks && tryTextTracks()) return;
    setStatus(adapter.name === 'youtube' ? '이 영상에는 자막 트랙이 없습니다.' : '자막을 아직 못 찾았습니다. 플레이어에서 자막을 영어로 켜 보세요.', true);
    if (adapter.supportsTextTracks) startTextTrackPoll();
  }
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
      state.saved = new Map(((res && res.items) || []).map((it) => [it.id, it]));
      state.missed = new Set(Array.from(state.saved.values()).filter((it) => it.missed).map((it) => it.id));
      refreshSavedMarks();
      renderOverlay(true);
    } catch (e) { /* ignore */ }
  }
  function buildItem(c, i) {
    const meta = state.meta || adapter.domTitle() || {};
    return {
      id: itemIdFor(c), platform: adapter.name, videoId: state.videoId, url: adapter.pageUrl(state.videoId),
      title: meta.title || (adapter.label + ' ' + state.videoId), episode: meta.episode || '',
      startMs: Math.round(cueVideoMs(c)), endMs: Math.round(cueVideoEndMs(c)), subStartMs: c.start, offsetMs: effectiveOffset(),
      text: c.text,
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
        chip('unsaved', '저장 취소');
      } else {
        const item = buildItem(c, i);
        state.saved.set(id, item);
        refreshSavedMarks(); renderOverlay(true);
        await bg({ type: 'items.save', item });
        chip('saved', '저장했습니다' + (settings.audioMode !== 'off' ? ' · 오디오 녹음 준비' : ''));
        if (!item.translation) {
          bg({ type: 'translate', texts: [c.text.replace(/\n/g, ' ')], from: 'en', to: 'ko' }).then((res) => {
            const t = res && res.translations && res.translations[0];
            if (t) { c.koMt = t; updateRowKo(i); bg({ type: 'items.update', id, patch: { translation: t, translationSource: 'mt' } }).catch(() => {}); }
          }).catch(() => {});
        }
        if (settings.audioMode && settings.audioMode !== 'off') queueCapture(i, item);
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

  // ───────────── 오디오 캡처 (별표 저장 시) ─────────────
  const capture = { queue: [], busy: false, pendingGrant: null };
  function queueCapture(i, item) {
    capture.queue.push({ i, item });
    if (!capture.busy) runCaptureQueue();
  }
  async function runCaptureQueue() {
    capture.busy = true;
    while (capture.queue.length) {
      const job = capture.queue.shift();
      try { await captureCue(job.i, job.item); } catch (e) { chipHide(); toast('오디오 저장 실패: ' + (e && e.message)); }
    }
    capture.busy = false;
  }
  function fileNameFor(item, ext) {
    const Au = globalThis.SubTutorAudio;
    const safe = (s, n) => (Au ? Au.safeFileName(s, n) : String(s).replace(/[\\/:*?"<>|]/g, ' ').slice(0, n));
    const clock = Au ? Au.fmtClock(item.startMs) : String(Math.floor(item.startMs / 1000));
    return 'SubTutor/' + safe(item.title + (item.episode ? ' ' + item.episode : ''), 60) + '/' + clock + ' ' + safe(item.text.replace(/\n/g, ' '), 60) + '.' + (ext || 'mp3');
  }
  // 대사 구간을 재생하면서 (벽시계, 영상시간) 쌍을 모은다. 끝나면 resolve.
  function playSegmentForCapture(startV, endV) {
    return new Promise((resolve) => {
      state.capturing = { startV, endV, anchors: [], done: resolve, startedAt: now() };
      playFrom(startV - 400);
      setTimeout(() => { if (state.capturing && state.capturing.done === resolve) finishCapturing('timeout'); }, Math.min(30000, (endV - startV) + 12000));
    });
  }
  function finishCapturing(reason) {
    const cap = state.capturing;
    if (!cap) return;
    state.capturing = null;
    cap.reason = reason;
    cap.done(cap);
  }
  async function captureCue(i, item) {
    const c = state.cues[i];
    if (!c) return;
    const startV = cueVideoMs(c), endV = cueVideoEndMs(c);
    const mode = settings.audioMode;
    let result;
    chip('rec', '대사 오디오 녹음 중…', 0);
    if (adapter.name === 'youtube' || !chrome.runtime.getURL) result = await captureViaElement(startV, endV);
    else result = await captureViaTab(startV, endV, item, i);
    if (!result) { if (!capture.pendingGrant) chipHide(); return; }
    if (result.silent) { chipHide(); toast('이 영상의 오디오는 캡처가 차단되어 있습니다(보호된 재생)'); return; }
    const r = await bg({ type: 'audio.save', id: item.id, mode, store: result.store, storeFormat: result.storeFormat || 'wav', storeMime: result.storeMime || 'audio/wav', storeRate: result.storeRate || 16000, download: result.download, downloadMime: result.downloadMime || 'audio/wav', downloadRate: result.downloadRate || 0, fileName: fileNameFor(item, result.downloadFormat || 'wav'), durationMs: result.durationMs, leadMs: Number.isFinite(result.leadMs) ? result.leadMs : 250, stats: result.stats || null });
    const fmt = (result.downloadFormat || 'wav').toUpperCase();
    // 성공 알림은 화면을 가리지 않게 구석 아이콘으로만 (마우스를 올리면 저장 위치). 폴더 권한 문제처럼 손이 필요한 일만 토스트로
    if (mode === 'store') chip('audio', '오디오를 웹 재생용으로 보관했습니다', 3000);
    else {
      const where = r && r.location === 'folder' ? (r.fileName || '') : '다운로드 폴더/' + ((r && r.fileName) || 'SubTutor');
      const extra = r && r.folderIssue === 'prompt' ? '지정한 폴더의 권한이 풀려 다운로드 폴더에 저장했습니다. 툴바의 SubTutor 아이콘 → "폴더 권한 허용"'
        : (r && r.folderIssue === 'error' ? '지정한 폴더에 쓰지 못해 다운로드 폴더에 저장했습니다 (' + (r.folderError || '') + ')' : '');
      chip('audio', fmt + ' 파일 저장: ' + where + (r && r.webCopy ? ' · 다운로드 폴더는 확장 프로그램이 읽을 수 없어 웹 재생용 복사본도 함께 보관했습니다' : ' · 웹에서 이 파일을 읽어 재생합니다 (MP3 는 이 파일 하나)') + (extra ? ' · ' + extra : ''), extra ? 7000 : 3000);
      if (extra) toast('⚠ ' + extra, 6000);
    }
    if (state.saved.has(item.id)) state.saved.get(item.id).audio = { ms: result.durationMs };
  }
  // 탭 오디오 캡처: 서비스 워커가 스트림 ID 를 받아 offscreen 문서에서 녹음한다 (탭 안에서 녹음하면 되먹임이 생긴다)
  async function captureViaTab(startV, endV, item, i) {
    const started = await bg({ type: 'capture.start', limitMs: 60000, test: settings.captureTest || undefined });
    if (!started || !started.ok) {
      if (started && started.unavailable === 'grant') {
        capture.pendingGrant = { i, item };
        const hint = grantHint(started.shortcut);
        chip('wait', '오디오 녹음 허용 대기 — ' + hint, 0);
        toast('🎙 ' + hint, 8000);
        return null;
      }
      throw new Error((started && started.error) || '캡처 시작 실패');
    }
    const cap = await playSegmentForCapture(startV, endV);
    if (cap.reason === 'timeout' && cap.anchors.length < 3) { await bg({ type: 'capture.stop' }).catch(() => {}); throw new Error('재생이 진행되지 않아 녹음을 중단했습니다'); }
    const res = await bg({ type: 'capture.finish', startMs: startV, endMs: endV, anchors: cap.anchors, downloadRate: 0, storeRate: 32000 });
    if (!res || !res.ok) throw new Error((res && res.error) || '녹음 마무리 실패');
    return res;
  }
  // 크롬 규칙: 탭 오디오 녹음은 사용자가 이 탭에서 확장 프로그램을 호출(단축키·우클릭 메뉴·툴바 아이콘)해야 허용된다. 탭마다 한 번이면 된다
  function grantHint(shortcut) {
    const ways = [];
    if (shortcut) ways.push(shortcut + ' (저장 단축키)');
    ways.push('영상 우클릭 → "SubTutor: 지금 자막 저장"', '툴바의 SubTutor 아이콘');
    return '오디오 녹음은 크롬 규칙상 이 탭에서 한 번 허용해야 합니다: ' + ways.join(' · ') + (shortcut ? '' : ' (단축키는 chrome://extensions/shortcuts 에서 지정)') + '. 허용되면 바로 녹음합니다';
  }
  // 호출(단축키·메뉴·팝업)로 이 탭의 녹음이 허용되면 기다리던 녹음을 바로 이어서 한다 → true 면 처리함
  function resumePendingCapture() {
    const p = capture.pendingGrant;
    if (!p) return false;
    capture.pendingGrant = null;
    if (!state.saved.has(p.item.id)) { chipHide(); return true; }
    chip('rec', '오디오 녹음 허용됨 · 녹음 중…', 0);
    queueCapture(p.i, p.item);
    return true;
  }
  function onPopupOpened() { resumePendingCapture(); }
  // 단축키(Alt+E 등 크롬 명령)·우클릭 메뉴: 기다리던 녹음이 있으면 잇고, 아니면 지금 자막을 저장한다(저장된 줄인데 오디오가 없으면 녹음만 다시)
  function onInvoke(msg) {
    if (resumePendingCapture()) return { ok: true, did: 'resume' };
    if (!state.active || !isEnabled()) return { ok: false, error: '재생 화면이 아닙니다' };
    const shown = displayIndex();
    const i = shown >= 0 ? shown : anchorIndex();
    if (i < 0) { chip('info', '저장할 자막이 없습니다'); return { ok: true, did: 'none' }; }
    const id = itemIdFor(state.cues[i]);
    if (!state.saved.has(id)) { toggleSave(i); return { ok: true, did: 'save' }; }
    const it = state.saved.get(id);
    if (settings.audioMode && settings.audioMode !== 'off' && !(it && it.audio)) { queueCapture(i, it); return { ok: true, did: 'capture' }; }
    chip('saved', '이미 저장된 대사');
    return { ok: true, did: 'already' };
  }
  async function captureViaElement(startV, endV) {
    const Au = globalThis.SubTutorAudio;
    if (!Au) throw new Error('오디오 유틸을 불러오지 못했습니다 (확장 프로그램을 다시 로드하세요)');
    const v = adapter.video();
    if (!v) throw new Error('video 없음');
    const stream = v.captureStream ? v.captureStream() : (v.mozCaptureStream ? v.mozCaptureStream() : null);
    if (!stream) throw new Error('이 브라우저는 영상 스트림 캡처를 지원하지 않습니다');
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error('오디오 트랙을 찾지 못했습니다 (재생을 시작한 뒤 다시 시도)');
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    const recStartWall = wall();
    const cap = await playSegmentForCapture(startV, endV);
    await new Promise((r) => setTimeout(r, 350));
    rec.stop();
    await stopped;
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
    if (!blob.size) throw new Error('녹음 데이터가 비었습니다');
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let audio;
    try { audio = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close().catch(() => {}); }
    const n = audio.length, rate = audio.sampleRate;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) { const d = audio.getChannelData(ch); for (let k = 0; k < n; k++) mono[k] += d[k] / audio.numberOfChannels; }
    const offset = Au.mediaClockOffset(cap.anchors);
    if (offset === null) throw new Error('재생이 진행되지 않아 녹음하지 못했습니다');
    const PAD = 250;
    const samples = Au.clipSamples([{ startFrame: 0, samples: mono }], { originMs: recStartWall, sampleRate: rate, startMs: startV - PAD + offset, endMs: endV + PAD + offset });
    if (!samples) throw new Error('대사 구간이 녹음되지 않았습니다');
    if (Au.isSilent(samples)) return { silent: true };
    const norm = Au.normalize(samples, 0.95);
    const dl = Au.encodeClip(norm, rate, { kbps: 128 });
    const st = Au.encodeClip(norm, rate, { rate: 32000, kbps: 64 });
    const leadMs = Math.max(0, Math.round(Math.min(PAD, startV + offset - recStartWall)));
    const stats = { source: 'element', reason: cap.reason, entered: !!cap.entered, anchors: cap.anchors.length, recordedMs: Math.round(audio.duration * 1000), windowStartMs: Math.round(startV - PAD + offset - recStartWall), windowEndMs: Math.round(endV + PAD + offset - recStartWall), capMs: Math.round(wall() - recStartWall) };
    return { ok: true, durationMs: Math.round((samples.length * 1000) / rate), leadMs, stats, download: Au.bytesToBase64(dl.bytes), downloadFormat: dl.format, downloadMime: dl.mime, downloadRate: dl.rate, store: Au.bytesToBase64(st.bytes), storeFormat: st.format, storeMime: st.mime, storeRate: st.rate };
  }

  // ───────────── 제목 ─────────────
  function setMeta(m) {
    if (!m || !m.title) return;
    state.meta = { title: String(m.title), episode: String(m.episode || '') };
    if (ui.title) { ui.title.textContent = state.meta.title + (state.meta.episode ? ' · ' + state.meta.episode : ''); ui.title.title = ui.title.textContent; }
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

    ui.panel = el('div', { id: 'st-panel', class: 'st-pf-' + adapter.name });
    ui.title = el('div', { class: 'st-brand', text: 'SubTutor' });
    ui.btnAP = el('button', { class: 'st-mode', title: '자동 일시정지 (P): 자막이 끝나면 멈춥니다. F로 다시 듣기', onclick: () => setMode('autoPause', !settings.autoPause) }, 'AP');
    ui.btnShadow = el('button', { class: 'st-mode st-shadow', title: '따라하기 (W): 자막이 끝나면 그 자막 길이만큼 쉬었다가 다음 자막으로 이어 재생합니다', onclick: () => setMode('shadowing', !settings.shadowing) }, '따라하기');
    ui.shadowSec = el('select', { class: 'st-shadow-sec', title: '따라하기: 자막이 끝난 뒤 쉬는 시간', onchange: (e) => saveSettings(shadowPausePatch(e.target.value)) });
    shadowPauseOptions(false).forEach((g) => ui.shadowSec.append(g));
    ui.btnSettings = el('button', { class: 'st-icon', title: '설정', onclick: () => { ui.settings.classList.toggle('st-hidden'); syncSettingsForm(); } }, '⚙');
    ui.btnClose = el('button', { class: 'st-icon', title: '패널 닫기 (`)', onclick: () => setPanelOpen(false) }, '✕');
    const head = el('div', { class: 'st-head' }, [ui.title, ui.btnAP, ui.btnShadow, ui.shadowSec, ui.btnSettings, ui.btnClose]);
    ui.status = el('div', { class: 'st-status' });
    ui.list = el('div', { class: 'st-list' });
    ui.list.addEventListener('click', (e) => {
      const row = e.target.closest('.st-row');
      if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('.st-star')) { toggleSave(i); return; }
      if (e.target.closest('.st-dub-mark')) { openDubBox(i); return; }
      goToCue(i);
    });
    const markScroll = () => { state.userScrollAt = now(); };
    ui.list.addEventListener('wheel', markScroll, { passive: true });
    ui.list.addEventListener('touchmove', markScroll, { passive: true });
    ui.list.addEventListener('mousedown', (e) => { if (e.offsetX > ui.list.clientWidth) markScroll(); });
    ui.foot = el('div', { class: 'st-foot' }, [
      el('button', { class: 'st-foot-btn', title: '단축키', onclick: () => showInfo('keys') }, '⌨ 단축키'),
      el('button', { class: 'st-foot-btn', title: '두 번 보기 순서', onclick: () => showInfo('twoPass') }, '두 번 보기'),
      el('button', { class: 'st-foot-btn', title: '이 에피소드의 어휘', onclick: showVocab }, '어휘'),
      el('button', { class: 'st-foot-btn st-foot-dub', title: '지금 자막으로 더빙 (R)', onclick: () => toggleDubBox() }, '🎙 더빙'),
    ]);
    ui.dubbox = el('div', { class: 'st-dubbox st-hidden', 'data-mic': 'closed' });
    ui.settings = buildSettings();
    ui.panel.append(head, ui.status, ui.list, ui.settings, ui.foot);

    ui.toggle = el('button', { id: 'st-toggle', title: 'SubTutor 자막 패널 열기 (`)', onclick: () => setPanelOpen(true) }, '‹');
    document.body.append(ui.panel, ui.toggle);

    ui.overlay = el('div', { id: 'st-overlay', class: 'st-hidden' });
    ui.ovText = el('span', { class: 'st-ov-text' });
    ui.ovStar = el('button', { class: 'st-ov-star', title: '이 자막 저장 (E)', onclick: (e) => { e.stopPropagation(); const i = displayIndex(); if (i >= 0) toggleSave(i); } }, '☆');
    ui.ovEn = el('div', { class: 'st-ov-en' }, [ui.ovText, ui.ovStar]);
    ui.ovKo = el('div', { class: 'st-ov-ko' });
    ui.ovSound = el('div', { class: 'st-ov-sound' });
    ui.ovKiwi = el('div', { class: 'st-ov-kiwi' });
    ui.ovBox = el('div', { class: 'st-ov-box' }, [ui.ovEn, ui.ovSound, ui.ovKo, ui.ovKiwi]);
    ui.ovShadowText = el('div', { class: 'st-ov-shadow-text' });
    ui.ovShadowBar = el('div', { class: 'st-ov-shadow-bar' });
    ui.ovShadow = el('div', { class: 'st-ov-shadow' }, [ui.ovShadowText, el('div', { class: 'st-ov-shadow-track' }, ui.ovShadowBar)]);
    ui.ovModes = el('div', { class: 'st-ov-modes' });
    ui.ovDub = el('div', { class: 'st-ov-dub', title: '이 구간은 내 더빙으로 재생 중' }, '🎙 내 더빙');
    ui.overlay.append(ui.ovBox, ui.ovShadow, ui.ovModes, ui.ovDub);
    ui.toast = el('div', { class: 'st-toast' });
    ui.chip = el('div', { class: 'st-chip', 'aria-live': 'polite' });
    ensureOverlayMounted();

    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('resize', () => positionOverlay(true));
    startNativeAlignWatch();
    renderList();
    updateModeUI();
    if (state.meta) setMeta(state.meta);
    if (state.statusText) setStatus(state.statusText, state.statusErr);
    refreshSavedMarks();
  }
  function overlayHost() {
    const fs = document.fullscreenElement;
    return fs && fs !== document.documentElement && fs !== document.body ? fs : document.body;
  }
  function ensureOverlayMounted() {
    if (!ui.overlay) return;
    const host = overlayHost();
    if (ui.overlay.parentElement !== host) { host.append(ui.overlay, ui.toast, ui.chip); positionOverlay(true); }
  }
  function onFullscreenChange() {
    const host = overlayHost();
    if (ui.panel && ui.panel.parentElement !== host) host.append(ui.panel, ui.toggle);
    ensureOverlayMounted();
    setTimeout(() => positionOverlay(true), 300);
  }
  function visibleBar(elm) {
    let e = elm;
    for (let i = 0; e && i < 4; i++) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false; e = e.parentElement; }
    return true;
  }
  function measureClearanceRaw(rect) {
    if (typeof adapter.clearance === 'function') return adapter.clearance(rect) || 0;
    if (!adapter.controlBars || !adapter.controlBars.length) return 0;
    const root = (typeof adapter.controlRoot === 'function' && adapter.controlRoot()) || document;
    const lowest = rect.top + rect.height * 0.55; // 영상 아래쪽 45% 안에 있는 컨트롤만 인정
    let top = Infinity;
    for (const sel of adapter.controlBars) {
      for (const bar of A.qsaDeep(sel, root)) {
        const r = bar.getBoundingClientRect();
        if (r.height > 0 && r.width > 40 && r.top > lowest && r.top < rect.bottom && visibleBar(bar)) top = Math.min(top, r.top);
      }
    }
    if (top === Infinity) return 0;
    return Math.min(Math.round(rect.height * 0.4), Math.max(0, Math.round(rect.bottom - top)) + 6);
  }
  // 컨트롤이 잠깐 다시 그려질 때 자막이 아래로 떨어졌다 올라오지 않도록, 값이 낮아질 때는 1.2초 뒤에만 반영한다
  function measureClearance(rect) {
    const raw = measureClearanceRaw(rect);
    const t = now();
    if (raw >= state.clearanceCur) { state.clearanceCur = raw; state.clearanceLowSince = 0; return raw; }
    if (!state.clearanceLowSince) state.clearanceLowSince = t;
    if (t - state.clearanceLowSince > 1200) { state.clearanceCur = raw; state.clearanceLowSince = 0; return raw; }
    return state.clearanceCur;
  }
  let lastRectKey = '';
  // 오버레이는 플레이어 DOM 안에 넣지 않고(플랫폼 CSS 간섭 방지) 화면에 고정한 채 <video>의 위치를 따라간다
  function positionOverlay(force) {
    if (!ui.overlay) return;
    const v = adapter.video();
    if (!v) return;
    const r = v.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const clearance = measureClearance(r);
    const key = [r.left, r.top, r.width, r.height, clearance].map(Math.round).join(',');
    if (!force && key === lastRectKey) return;
    lastRectKey = key;
    const s = ui.overlay.style;
    s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    s.setProperty('--st-unit', (r.width / 100) + 'px');
    s.setProperty('--st-clearance', clearance + 'px');
    if (ui.toast) { ui.toast.style.left = (r.left + r.width / 2) + 'px'; ui.toast.style.top = (r.top + r.height * 0.1) + 'px'; }
    if (ui.chip) { ui.chip.style.left = (r.left + r.width - 14) + 'px'; ui.chip.style.top = (r.top + 14) + 'px'; }
  }
  function setPanelOpen(open) { saveSettings({ panelOpen: !!open }); }
  // 디즈니+처럼 자막을 열린 shadow DOM 안에 그리는 플레이어는 문서의 <style> 이 닿지 않으므로, 각 shadow root 에도 같은 스타일을 넣는다
  const shadowStyles = new WeakMap(); // ShadowRoot -> <style>
  function nativeHideCssNow() { return settings.hideNative && state.active && isEnabled() ? (adapter.nativeHideCss || '') : ''; }
  function syncShadowNativeStyles() {
    if (!adapter.deep || !ui.root) return;
    const css = nativeHideCssNow();
    for (const r of A.deepRoots()) {
      if (r === document) continue;
      let st = shadowStyles.get(r);
      if (!css) { if (st) { st.remove(); shadowStyles.delete(r); } continue; }
      if (!st || !st.isConnected) { st = el('style', { class: 'st-native-style' }); r.append(st); shadowStyles.set(r, st); }
      if (st.textContent !== css) st.textContent = css;
    }
  }
  // 플랫폼 CSS(adapter.layoutCss)로 영상이 안 줄어들면, video 의 조상 중 화면을 꽉 채우는 요소를 바깥쪽부터 골라 너비를 패널만큼 줄여 본다 (효과를 확인하며 다음 후보로)
  const fit = { el: null, prev: null, appliedAt: 0, tried: 0, cycleAt: 0, phase: 0 };
  const FIT_ANCHOR_PROPS = [['left', '0px'], ['right', 'auto'], ['margin-left', '0px'], ['margin-right', '0px'], ['transform', 'none']];
  function panelWidth() { const w = ui.panel ? ui.panel.getBoundingClientRect().width : 0; return w > 50 ? w : 400; }
  // 어댑터가 panelWidth(기본 400) 를 주면 그 값을 쓴다 (유튜브: 오른쪽 추천 영상 칸 전체를 덮는 너비)
  let lastPanelW = 0;
  function syncPanelWidth() {
    let w = 400;
    try { if (typeof adapter.panelWidth === 'function') w = adapter.panelWidth() || 400; } catch (e) { w = 400; }
    w = Math.round(Math.min(Math.max(w, 400), Math.max(400, window.innerWidth * 0.6)));
    if (w === lastPanelW) return;
    lastPanelW = w;
    document.documentElement.style.setProperty('--st-panel-w', w + 'px');
  }
  function videoOverlapsPanel(v) { const r = v.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth - panelWidth() + 4; }
  function fitCandidates(v) {
    const out = [];
    const up = (e) => e.parentElement || (e.getRootNode && e.getRootNode().host) || null; // shadow host 를 넘어 올라간다
    for (let e = up(v); e && e !== document.body && e !== document.documentElement; e = up(e)) {
      const r = e.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.6) out.push(e);
    }
    return out.reverse(); // body 에 가까운 것부터
  }
  function restoreFit() {
    if (fit.el) {
      try {
        for (const [prop, saved] of Object.entries(fit.prev || {})) { if (saved.value) fit.el.style.setProperty(prop, saved.value, saved.priority); else fit.el.style.removeProperty(prop); }
      } catch (e) { /* ignore */ }
    }
    fit.el = null; fit.prev = null; fit.appliedAt = 0; fit.phase = 0;
  }
  function fitSet(el, prop, value) {
    if (!fit.prev[prop]) fit.prev[prop] = { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) };
    el.style.setProperty(prop, value, 'important');
  }
  function fitVideoBesidePanel() {
    const v = adapter.video();
    const open = settings.panelOpen && state.active && isEnabled();
    if (!open || !adapter.fitVideo || !v || !panelVisibleInFullscreen()) { if (fit.el) restoreFit(); fit.tried = 0; return; }
    if (!videoOverlapsPanel(v)) { fit.tried = 0; return; } // CSS 규칙이나 이전 적용으로 이미 맞음
    if (fit.el && now() - fit.appliedAt < 700) return; // 적용 직후: 반영을 기다린다
    if (now() < fit.cycleAt) return;
    // 너비를 줄였는데도 겹치면(요소가 오른쪽에 붙어 있어 오른쪽으로 밀린 경우) 같은 요소를 왼쪽에 붙여 본다
    if (fit.el && fit.el.isConnected && fit.phase === 1) {
      fit.phase = 2; fit.appliedAt = now();
      for (const [prop, value] of FIT_ANCHOR_PROPS) fitSet(fit.el, prop, value);
      return;
    }
    const cands = fitCandidates(v);
    if (!cands.length) return;
    let idx = fit.el ? cands.indexOf(fit.el) + 1 : 0;
    restoreFit();
    if (idx >= cands.length) { fit.cycleAt = now() + 4000; return; } // 모두 실패: 잠시 뒤 처음부터
    const target = cands[idx];
    fit.el = target; fit.prev = {}; fit.phase = 1;
    fit.appliedAt = now();
    fitSet(target, 'width', 'calc(100vw - ' + panelWidth() + 'px)');
  }
  window.addEventListener('resize', () => { if (fit.el) { restoreFit(); fit.cycleAt = 0; } });
  // 플레이어 요소만 전체화면이 되면 문서에 붙은 패널은 보이지 않으므로, 그때는 영상을 줄이지 않는다
  function panelVisibleInFullscreen() { const fs = document.fullscreenElement; return !fs || !ui.panel || fs.contains(ui.panel); }
  document.addEventListener('fullscreenchange', () => {
    document.documentElement.classList.toggle('st-fs-hidden', !panelVisibleInFullscreen());
    if (fit.el) restoreFit();
    fit.cycleAt = 0;
    positionOverlay(true);
  });
  function applySettings() {
    if (!ui.root) return;
    const enabled = isEnabled();
    const open = settings.panelOpen && state.active && enabled;
    ui.panel.classList.toggle('st-closed', !open);
    ui.toggle.classList.toggle('st-hidden', open || !state.active || !enabled);
    document.documentElement.classList.toggle('st-panel-open', open);
    document.documentElement.style.setProperty('--st-font-scale', String((settings.fontScale || 100) / 100));
    ui.nativeStyle.textContent = nativeHideCssNow();
    syncShadowNativeStyles();
    if (!open && fit.el) restoreFit();
    setTimeout(fitVideoBesidePanel, 250);
    ui.shadowSec.value = shadowPauseValue();
    syncSettingsForm();
    updateModeUI();
    renderOverlay(true);
  }
  function updateModeUI() {
    if (!ui.root) return;
    ui.btnAP.classList.toggle('on', !!settings.autoPause);
    ui.btnShadow.classList.toggle('on', !!settings.shadowing);
    ui.ovModes.textContent = '';
    if (state.loop) ui.ovModes.append(el('span', { class: 'st-ov-chip on-loop' }, '🔁 반복'));
    if (settings.autoPause) ui.ovModes.append(el('span', { class: 'st-ov-chip on-ap' }, '⏸ AP'));
    if (settings.shadowing) ui.ovModes.append(el('span', { class: 'st-ov-chip on-shadow' }, '🗣 따라하기 ' + shadowPauseText()));
    if (Math.abs(state.rate - 1) > 0.01) ui.ovModes.append(el('span', { class: 'st-ov-chip on-rate' }, '⏩ ' + rateText(state.rate) + '×'));
    if (ui.rateNow) { ui.rateNow.textContent = rateText(state.rate) + '×'; ui.rateNow.classList.toggle('on', Math.abs(state.rate - 1) > 0.01); ui.rateNow.title = '지금 ' + rateText(state.rate) + '배속 · 누르면 보통 속도로 (\\)'; }
    if (settings.cloze && settings.cloze !== 'off') ui.ovModes.append(el('span', { class: 'st-ov-chip on-cloze' }, '▭ 빈칸 (V 공개)'));
    if (settings.secondPass) ui.ovModes.append(el('span', { class: 'st-ov-chip on-pass' }, '2회차'));
    if (ui.ctlBtn) { ui.ctlBtn.classList.toggle('off', !isEnabled()); ui.ctlBtn.title = isEnabled() ? 'SubTutor 끄기' : 'SubTutor 켜기'; }
    if (ui.rateCtl) ui.rateCtl.style.display = isEnabled() ? '' : 'none'; // SubTutor 를 끄면 배속 버튼도 숨긴다 (단축키도 같이 꺼진다)
  }
  function computeProfile() {
    state.profile = null;
    if (!Voc || !Freq || !state.cues.length) return;
    try { state.profile = Voc.profile(state.cues, Freq); } catch (e) { state.profile = null; }
    state.seriesSaved = false;
    saveEpisodeStats(true);
  }
  function statusWithProfile() {
    const base = state.baseStatus || state.statusText || '';
    const p = state.profile;
    if (!settings.vocabProfile || !p || !p.tokens) return base;
    const d = Voc.difficulty(p);
    return base + ' · ' + (p.wpm ? p.wpm + ' wpm · ' : '') + '3천 밖 ' + Math.round(d.outside) + '% (' + d.label + ')';
  }
  function refreshProfileStatus() { if (state.baseStatus) setStatus(statusWithProfile()); }
  function setStatus(text, isErr) {
    state.statusText = text; state.statusErr = !!isErr;
    if (!ui.status) return;
    ui.status.textContent = '';
    ui.status.append(text);
    if (state.offsetMs) ui.status.append(el('span', { class: 'st-offset', title: '자막 시간 보정 (' + (state.offsetSource === 'auto' ? '자동 감지' : state.offsetSource === 'guess' ? '이전 영상 값, 확인 중' : '수동') + ')' }, ' · 보정 ' + (state.offsetMs > 0 ? '+' : '') + (state.offsetMs / 1000).toFixed(1) + '초' + (state.offsetSource === 'guess' ? '?' : '')));
    ui.status.classList.toggle('st-err', !!isErr);
    if (isErr) ui.status.append(el('button', { onclick: () => { trackCache.delete(state.videoId); startVideo(state.videoId); } }, '다시 시도'));
  }
  let toastTimer = null;
  function toast(text, ms) {
    if (!ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms || 1400);
  }
  // 구석 상태 아이콘: 저장·녹음처럼 자주 뜨는 알림은 화면을 가리는 토스트 대신 영상 오른쪽 위에 작은 아이콘으로만 (마우스를 올리면 설명). ms 0 = 다음 알림까지 유지
  const CHIP_ICON = { saved: '★', unsaved: '☆', missed: 'Q', rec: '●', wait: '●', audio: '♪', info: 'i', error: '!' };
  let chipTimer;
  function chip(kind, title, ms) {
    if (!ui.chip) return;
    ui.chip.textContent = CHIP_ICON[kind] || '•';
    ui.chip.title = title || '';
    ui.chip.className = 'st-chip show st-chip-' + kind;
    clearTimeout(chipTimer);
    if (ms !== 0) chipTimer = setTimeout(chipHide, ms || 2200);
  }
  function chipHide() { clearTimeout(chipTimer); if (ui.chip) ui.chip.classList.remove('show'); }

  // 컨트롤 바에 넣는 것들의 스타일. content.css 가 아니라 여기에 두는 이유: 디즈니+ 는 컨트롤이
  // disney-web-player 의 shadow DOM 안이라 바깥 스타일시트가 닿지 않는다 → 같은 CSS 를 그 루트에도 넣는다.
  const CONTROL_CSS = [
    '.st-ctl { all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; vertical-align: top; color: #fff; opacity: .95; transition: transform .12s ease, opacity .12s ease; }',
    '.st-ctl-svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }',
    '.st-ctl .st-ctl-slash { display: none; }',
    '.st-ctl:hover { transform: scale(1.12); opacity: 1; }',
    '.st-ctl.off { opacity: .5; }',
    '.st-ctl.off .st-ctl-slash { display: block; }',
    '.st-ctl-wrap { display: flex; align-items: center; justify-content: center; }',
    '.st-ctl-netflix { width: 100%; height: 100%; min-width: 2.4em; } .st-ctl-netflix .st-ctl-svg { width: 2em; height: 2em; min-width: 30px; min-height: 30px; }',
    '.st-ctl-youtube { width: 48px; height: 100%; } .st-ctl-youtube .st-ctl-svg { width: 26px; height: 26px; }',
    '.st-ctl-prime, .st-ctl-disney { width: 2.6em; height: 100%; margin: 0 .2em; min-width: 40px; } .st-ctl-prime .st-ctl-svg, .st-ctl-disney .st-ctl-svg { width: 32px; height: 32px; }',
    /* 배속 조절 (ST 버튼 왼쪽): ‹ 1× › */
    '.st-rate { display: inline-flex; align-items: center; gap: 1px; height: 100%; color: #fff; font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; text-shadow: 0 1px 2px rgba(0,0,0,.55); }',
    '.st-rate button { all: unset; cursor: pointer; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; color: #fff; opacity: .92; border-radius: 4px; font: inherit; transition: background .12s ease, opacity .12s ease; }',
    '.st-rate button:hover { opacity: 1; background: rgba(255,255,255,.22); }',
    '.st-rate .st-rate-step { width: 1.5em; height: 2em; font-size: 19px; font-weight: 700; padding-bottom: .12em; }',
    '.st-rate .st-rate-now { min-width: 3.2em; height: 2em; font-size: 13px; letter-spacing: -.02em; }',
    '.st-rate .st-rate-now.on { color: #ffd166; }',
    '.st-rate-netflix { margin-right: .3em; } .st-rate-prime, .st-rate-disney { margin: 0 .2em; }',
  ].join('\n');
  // 배속 버튼은 자체 배속 메뉴가 없는 플랫폼에만 (유튜브는 Shift+< , Shift+> 가 이미 유튜브 기능이다)
  const RATE_UI = adapter.name !== 'youtube';
  const ctlStyled = new WeakMap();
  function ensureControlStyle(node) {
    const root = node && node.getRootNode ? node.getRootNode() : document;
    const host = (root === document || root === document.documentElement || !root.appendChild) ? document.documentElement : root;
    const cur = ctlStyled.get(host);
    if (cur && cur.isConnected) return;
    const st = el('style', { class: 'st-ctl-style' });
    st.textContent = CONTROL_CSS;
    host.append(st);
    ctlStyled.set(host, st);
  }

  // 플레이어 컨트롤 바의 켜기/끄기 버튼 (Language Reactor 식)
  // 플랫폼 아이콘과 비슷한 흰색 선 아이콘. 꺼짐 상태는 반투명 + 사선
  const CTL_ICON = '<svg class="st-ctl-svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">'
    + '<rect x="2.5" y="6.5" width="27" height="19" rx="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/>'
    + '<text x="16" y="20.6" text-anchor="middle" font-size="11.5" font-weight="800" font-family="-apple-system, \'Helvetica Neue\', Arial, sans-serif" fill="currentColor" stroke="none">ST</text>'
    + '<line class="st-ctl-slash" x1="5" y1="28" x2="27" y2="4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  // 버튼을 감싼 단일 자식 래퍼들을 타고 올라가, 가로로 늘어선 버튼 묶음의 직접 자식(래퍼)을 찾는다
  function controlWrapperOf(btn) {
    const up = (x) => x.parentElement || (x.getRootNode && x.getRootNode().host) || null; // shadow host 를 넘어 올라간다
    let e = btn;
    for (let i = 0; i < 8; i++) {
      const p = up(e);
      if (!p || p === document.body || p === document.documentElement) break;
      if (p.children.length !== 1) break;
      e = p;
    }
    return e;
  }
  function controlInsertPoint() {
    let anchor = null;
    try { anchor = adapter.controlAnchor(); } catch (e) { anchor = null; }
    if (!anchor || !anchor.parentElement) return null;
    const wrapper = controlWrapperOf(anchor);
    if (adapter.controlPlace === 'groupStart' && wrapper.parentElement) {
      const first = Array.from(wrapper.parentElement.children).find((c) => c !== ui.ctlMount && c !== ui.rateCtl); // 우리가 넣은 것들은 기준에서 뺀다 (매 틱 다시 꽂히는 것을 막는다)
      return { before: first || wrapper, wrapper };
    }
    if (!wrapper.parentElement) return null;
    return { before: wrapper, wrapper };
  }
  // 배속 조절: ‹ 느리게 · 지금 배속(누르면 1배속) · 빠르게 ›  (단계는 설정 › 속도 사다리의 배속)
  function buildRateCtl() {
    ui.rateDown = el('button', { class: 'st-rate-step st-rate-down', type: 'button', title: '한 단계 느리게 (Shift+<)', 'aria-label': '재생 속도 한 단계 느리게' }, '‹');
    ui.rateNow = el('button', { class: 'st-rate-now', type: 'button', title: '보통 속도로 (\\)', 'aria-label': '재생 속도' }, '1×');
    ui.rateUp = el('button', { class: 'st-rate-step st-rate-up', type: 'button', title: '한 단계 빠르게 (Shift+>)', 'aria-label': '재생 속도 한 단계 빠르게' }, '›');
    ui.rateCtl = el('div', { class: 'st-rate st-rate-' + adapter.name }, [ui.rateDown, ui.rateNow, ui.rateUp]);
  }
  function mountControlButton() {
    if (!adapter.controlAnchor) return;
    const pt = controlInsertPoint();
    if (!pt) return;
    const parent = pt.before.parentElement || (pt.before.getRootNode && pt.before.getRootNode().host ? null : null);
    if (!parent) return;
    const rateOk = !RATE_UI || (ui.rateCtl && ui.rateCtl.isConnected && ui.rateCtl.nextElementSibling === ui.ctlMount);
    if (ui.ctlMount && ui.ctlMount.isConnected && ui.ctlMount.nextElementSibling === pt.before && rateOk) return;
    if (!ui.ctlBtn) {
      ui.ctlBtn = el('button', { class: 'st-ctl st-ctl-' + adapter.name, title: 'SubTutor 끄기', 'aria-label': 'SubTutor 켜기/끄기', type: 'button' });
      ui.ctlBtn.innerHTML = CTL_ICON;
      ui.ctlWrap = el('div', { class: 'st-ctl-wrap' });
    }
    // 이웃 버튼이 래퍼(div)로 감싸져 있으면 같은 래퍼 클래스를 따라 해 간격·크기를 맞추고, 버튼이 바로 늘어선 묶음이면 버튼만 끼워 넣는다
    const useWrap = pt.wrapper.tagName !== 'BUTTON';
    if (useWrap) {
      const cls = typeof pt.wrapper.className === 'string' ? pt.wrapper.className.trim() : '';
      ui.ctlWrap.className = 'st-ctl-wrap' + (cls ? ' ' + cls : '');
      if (ui.ctlBtn.parentElement !== ui.ctlWrap) ui.ctlWrap.append(ui.ctlBtn);
      ui.ctlMount = ui.ctlWrap;
    } else {
      if (ui.ctlBtn.parentElement === ui.ctlWrap) ui.ctlWrap.removeChild(ui.ctlBtn);
      ui.ctlMount = ui.ctlBtn;
    }
    parent.insertBefore(ui.ctlMount, pt.before);
    if (RATE_UI) {
      if (!ui.rateCtl) buildRateCtl();
      parent.insertBefore(ui.rateCtl, ui.ctlMount); // ST 버튼 왼쪽
    }
    ensureControlStyle(parent);
    updateModeUI();
  }
  // 프라임처럼 컨트롤을 자주 다시 그리거나 포인터 이벤트를 가로채는 플레이어에서도 토글이 되도록, 창 수준 캡처 단계에서 우리 버튼을 향한 첫 이벤트에 바로 반응한다
  // 한 번의 누름에서 pointerdown → mousedown → click 이 모두 오므로 하나만 처리해야 한다.
  // 시간으로 거르면(예: 250ms 안의 중복 무시) 빠르게 두 번 누른 것까지 삼켜 버리므로,
  // 이 브라우저가 가장 먼저 알려 주는 종류 하나를 골라 그것만 쓴다 (뒤따르는 종류는 무시).
  const CTL_EVENT_RANK = { pointerdown: 3, mousedown: 2, click: 1 };
  let ctlEventKind = '';
  function ctlTargets() {
    return [[ui.ctlBtn, () => setEnabled(!isEnabled())], [ui.rateDown, () => stepRate(-1)], [ui.rateNow, () => changeRate(0)], [ui.rateUp, () => stepRate(1)]];
  }
  function onCtlPointer(e) {
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.length) return;
    const hit = ctlTargets().find((t) => t[0] && path.includes(t[0]));
    if (!hit) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const rank = CTL_EVENT_RANK[e.type] || 0;
    if (!rank || rank < (CTL_EVENT_RANK[ctlEventKind] || 0)) return;
    ctlEventKind = e.type;
    hit[1]();
  }
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => window.addEventListener(t, onCtlPointer, true));

  // ⓘ: 설명과 학문적 근거를 패널 안 상자로 보여 준다 (화면에는 설명을 늘어놓지 않는다)
  function infoBtn(key) { return el('button', { class: 'st-info', title: '설명 · 근거', 'data-key': key, onclick: (e) => { e.preventDefault(); e.stopPropagation(); showInfo(key); } }, 'i'); }
  function showBox(title, bodyNodes) {
    if (!ui.panel) return;
    if (!ui.infobox) {
      ui.infoTitle = el('b', null);
      ui.infoBody = el('div', { class: 'st-infobox-body' });
      ui.infobox = el('div', { class: 'st-infobox' }, [el('div', { class: 'st-infobox-head' }, [ui.infoTitle, el('button', { class: 'st-icon', title: '닫기', onclick: () => ui.infobox.classList.add('st-hidden') }, '✕')]), ui.infoBody]);
      ui.panel.append(ui.infobox);
    }
    ui.infoTitle.textContent = title;
    ui.infoBody.textContent = '';
    for (const n of [].concat(bodyNodes)) if (n) ui.infoBody.append(n);
    ui.infobox.classList.remove('st-hidden');
  }
  function showInfo(key) {
    const x = Ex && Ex.get(key);
    if (!x) return;
    showBox(x.title, [
      el('p', { class: 'st-info-what', text: x.what }),
      x.why ? el('h5', { text: '왜 이렇게 하나 (근거)' }) : null,
      x.why ? el('p', { class: 'st-info-why', text: x.why }) : null,
      x.refs && x.refs.length ? el('h5', { text: '참고 문헌' }) : null,
      x.refs && x.refs.length ? el('ul', { class: 'st-info-refs' }, x.refs.map((r) => el('li', { text: r }))) : null,
    ]);
  }
  // 이 에피소드의 어휘 프로파일: 3천 밖 단어와 재출현 횟수
  async function showVocab() {
    const p = state.profile;
    if (!p || !p.tokens) { showBox('어휘', el('p', { text: '자막을 불러오면 어휘 프로파일이 계산됩니다.' })); return; }
    const d = Voc.difficulty(p);
    const meta = state.meta || {};
    let series = null;
    try { const r = await bg({ type: 'stats.get' }); series = r && r.stats && r.stats.series && r.stats.series[adapter.name + ':' + (meta.title || '')]; } catch (e) { series = null; }
    const nEp = series ? series.episodes.length : 1;
    const words = p.beyond3k.slice(0, 80);
    const example = (w) => { const c = state.cues.find((x) => Voc.tokenize(x.text).some((t) => Voc.norm(t) === w)); return c ? c.text.replace(/\n/g, ' ') : ''; };
    const rows = words.map((e) => {
      const seen = series && series.words[e.word] ? series.words[e.word] : 1;
      return el('div', { class: 'st-vocab-row' }, [el('b', null, e.word), el('span', { class: 'st-vocab-meta' }, ' ×' + e.n + ' · ' + Voc.band(e.rank) + (nEp > 1 && seen > 1 ? ' · 이전 ' + (seen - 1) + '편에도' : '')), el('div', { class: 'st-vocab-ex', text: example(e.word) })]);
    });
    const copy = () => {
      const text = words.map((e) => e.word + '\t' + e.n + '\t' + Voc.band(e.rank) + '\t' + example(e.word)).join('\n');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('어휘 목록을 복사했습니다 (단어·횟수·밴드·예문)'), () => toast('복사 실패'));
    };
    showBox('이 에피소드 어휘', [
      el('p', { class: 'st-info-what', text: '단어 ' + p.tokens + '개(서로 다른 ' + p.types + '개) · ' + (p.wpm ? p.wpm + ' wpm · ' : '') + '3천 밖 ' + Math.round(d.outside) + '% (' + d.label + ')' + (p.need95 ? ' · 95% 이해에 약 ' + p.need95.toLocaleString() + '단어 필요' : '') + (nEp > 1 ? ' · 이 작품 ' + nEp + '편 기준 재출현 표시' : '') }),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn st-primary', onclick: copy }, '목록 복사 (사전 학습용)'), infoBtn('vocabProfile')]),
      el('div', { class: 'st-vocab-list' }, rows.length ? rows : [el('p', { text: '3천 단어 밖의 단어가 없습니다.' })]),
    ]);
  }
  function buildSettings() {
    const box = el('div', { class: 'st-settings st-hidden' });
    const f = {};
    const field = (label, input, key) => el('div', { class: 'st-field' }, [el('label', null, [label, key ? infoBtn(key) : null]), input]);
    const sw = (key, onChange) => { const i = el('input', { type: 'checkbox', class: 'st-switch' }); i.addEventListener('change', () => (onChange || ((v) => saveSettings({ [key]: v })))(i.checked)); f[key] = i; return i; };
    f.translationSource = el('select', { onchange: (e) => { saveSettings({ translationSource: e.target.value }); refreshAllKo(); if (state.current >= 0) ensureTranslations(state.current); } });
    [['auto', '자동 (플랫폼 한국어 자막 → 없으면 기계번역)'], ['track', '플랫폼 한국어 자막만'], ['mt', '기계 번역만'], ['off', '끄기']].forEach(([v, t]) => f.translationSource.append(el('option', { value: v }, t)));
    f.audioMode = el('select', { onchange: (e) => saveSettings({ audioMode: e.target.value }) });
    [['off', '저장 안 함'], ['store', '웹 재생용으로 보관 (확장 프로그램 안)'], ['download', 'PC에 MP3 파일로 저장 (웹은 그 파일로 재생)']].forEach(([v, t]) => f.audioMode.append(el('option', { value: v }, t)));
    f.koMode = el('select', { onchange: (e) => saveSettings({ koMode: e.target.value }) });
    [['always', '항상 보임'], ['hold', 'T 키를 누르는 동안만'], ['afterRepeat', '같은 줄 3회 반복 뒤']].forEach(([v, t]) => f.koMode.append(el('option', { value: v }, t)));
    f.cloze = el('select', { onchange: (e) => saveSettings({ cloze: e.target.value }) });
    [['off', '끄기'], ['function', '기능어(약형) 가리기'], ['random', '아무 단어나 가리기']].forEach(([v, t]) => f.cloze.append(el('option', { value: v }, t)));
    f.fontScale = el('input', { type: 'range', min: 60, max: 160, step: 5 });
    f.fontScale.addEventListener('input', () => saveSettings({ fontScale: +f.fontScale.value }));
    f.shadowPause = el('select', { onchange: (e) => saveSettings(shadowPausePatch(e.target.value)) });
    shadowPauseOptions(true).forEach((g) => f.shadowPause.append(g));
    const num = (key, min, max) => { const i = el('input', { type: 'number', min, max, step: 50 }); i.addEventListener('change', () => saveSettings({ [key]: clamp(+i.value || 0, min, max) })); f[key] = i; return i; };
    f.offset = el('input', { type: 'number', min: -120000, max: 120000, step: 100 });
    f.offset.addEventListener('change', () => saveOffset(clamp(+f.offset.value || 0, -120000, 120000), 'manual'));
    f.offsetHint = el('small', { text: '' });
    f.diag = el('div', { class: 'st-diag' });
    box.append(
      el('h4', { text: '번역' }),
      field('한국어 번역 표시', sw('showTranslation', (v) => { saveSettings({ showTranslation: v }); refreshAllKo(); if (v && state.current >= 0) ensureTranslations(state.current); }), 'translation'),
      field('번역 출처', f.translationSource, 'translation'),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn', onclick: translateAll }, '이 영상 전체 기계 번역')]),
      el('h4', { text: '화면' }),
      field('영상 위 자막 표시', sw('overlay'), 'overlay'),
      field('플랫폼 기본 자막 숨기기', sw('hideNative'), 'hideNative'),
      field('자막 크기', f.fontScale, 'fontScale'),
      el('h4', { text: '듣기 훈련' }),
      field('한국어 표시 방식', f.koMode, 'koMode'),
      field('2회차 모드', sw('secondPass'), 'secondPass'),
      field('빈칸 자막', f.cloze, 'cloze'),
      field('소리 나는 대로', sw('soundsLike'), 'soundsLike'),
      field('키위·마오리·학교 용어 주석', sw('kiwiNotes'), 'kiwiNotes'),
      field('어휘 프로파일 · 말 속도', sw('vocabProfile'), 'vocabProfile'),
      field('반복 속도 사다리', sw('loopLadder'), 'loopLadder'),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn', onclick: showVocab }, '이 에피소드 어휘 목록'), el('button', { class: 'st-btn', onclick: () => showInfo('missed') }, 'Q 못 알아들음 표시란?'), el('button', { class: 'st-btn', onclick: () => showInfo('twoPass') }, '두 번 보기 순서')]),
      el('h4', { text: '재생' }),
      field('따라하기 쉬는 시간', f.shadowPause, 'shadowing'),
      field('더빙 재생 (★ 녹음 구간은 내 목소리)', sw('dubPlayback'), 'dub'),
      field('재생 시작 여유 (ms)', num('leadMs', 0, 2000), 'leadTail'),
      field('재생 끝 여유 (ms)', num('tailMs', 0, 2000), 'leadTail'),
      el('div', { class: 'st-field' }, [el('label', null, ['이 영상 자막 시간 보정 (ms)', infoBtn('offset')]), el('span', { class: 'st-offset-ctl' }, [el('button', { class: 'st-btn st-mini', onclick: () => saveOffset(state.offsetMs - 500, 'manual') }, '−0.5초'), f.offset, el('button', { class: 'st-btn st-mini', onclick: () => saveOffset(state.offsetMs + 500, 'manual') }, '+0.5초')])]),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn', onclick: () => { state.alignSamples = []; saveOffset(0, 'manual'); toast('보정값을 지웠습니다. 플랫폼 자막이 켜져 있으면 다시 자동 감지합니다'); } }, '보정 초기화')]),
      el('h4', { text: '저장' }),
      field('별표 저장 시 오디오', f.audioMode, 'audioStore'),
      el('div', { class: 'st-btn-row' }, [
        el('button', { class: 'st-btn st-primary', onclick: () => bg({ type: 'openSite' }).catch(() => {}) }, '웹에서 저장 목록 · 퀴즈 열기'),
        el('button', { class: 'st-btn', onclick: () => setEnabled(false) }, '이 사이트에서 SubTutor 끄기'),
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
    f.audioMode.value = settings.audioMode === 'both' ? 'download' : (settings.audioMode || 'off');
    f.koMode.value = settings.koMode || 'hold';
    f.cloze.value = settings.cloze || 'off';
    f.secondPass.checked = !!settings.secondPass; f.soundsLike.checked = !!settings.soundsLike; f.kiwiNotes.checked = !!settings.kiwiNotes; f.vocabProfile.checked = !!settings.vocabProfile; f.loopLadder.checked = !!settings.loopLadder;
    f.fontScale.value = settings.fontScale;
    f.shadowPause.value = shadowPauseValue();
    f.dubPlayback.checked = settings.dubPlayback !== false;
    f.leadMs.value = settings.leadMs; f.tailMs.value = settings.tailMs;
    f.offset.value = state.offsetMs;
    f.offset.title = state.offsetMs ? (state.offsetSource === 'auto' ? '플랫폼 자막과 대조해 자동 감지한 값' : '직접 입력한 값') + ' · 자막이 소리보다 빠르면 음수' : '자막이 소리보다 빠르면 음수, 늦으면 양수. 플랫폼 자막이 켜져 있으면 자동 감지';
  }
  function diagnostics() {
    const v = adapter.video();
    return [
      'SubTutor ' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ''),
      'platform=' + adapter.name + ' videoId=' + state.videoId + ' enabled=' + isEnabled() + ' url=' + location.href,
      'video=' + (v ? 'yes rs=' + v.readyState + ' t=' + v.currentTime.toFixed(2) + ' dur=' + v.duration + ' paused=' + v.paused : 'no') + ' videos=' + document.querySelectorAll('video').length + ' pageTime=' + (A.shared.pageTime.at ? Math.round(A.shared.pageTime.ms) : '-'),
      'cues=' + state.cues.length + ' ko=' + state.koCues.length + ' en=' + JSON.stringify(state.enTrack && { lang: state.enTrack.lang, label: state.enTrack.label, format: state.enTrack.format }) + ' ko=' + JSON.stringify(state.koTrack && { lang: state.koTrack.lang, label: state.koTrack.label }),
      'tracks=' + JSON.stringify((trackCache.get(state.videoId) || []).map((t) => t.lang + (t.cc ? '[cc]' : '') + (t.asr ? '[asr]' : '') + (t.forced ? '[f]' : ''))),
      'offset=' + state.offsetMs + ' (' + state.offsetSource + ') samples=' + JSON.stringify(state.alignSamples),
      'meta=' + JSON.stringify(state.meta) + ' status=' + state.statusText,
      'modes loop=' + state.loop + ' ap=' + settings.autoPause + ' shadow=' + settings.shadowing + '/' + shadowPauseValue() + ' audio=' + settings.audioMode + ' rate=' + state.rate + ' clearance=' + state.clearanceCur,
      'dub segs=' + state.dubSegs.length + ' chosen=' + state.dubSegs.filter((s) => chosenTake(s)).length + ' playback=' + (settings.dubPlayback !== false) + ' play=' + (state.dubPlay ? state.dubPlay.take.id + '@' + state.dubPlay.offset.toFixed(2) : '-') + ' rec=' + (state.dubRec ? state.dubRec.phase : '-') + ' ladder=' + (state.dubLadder ? state.dubLadder.step : '-') + ' mic=' + (state.dubMic ? 'open' : 'closed') + ' ctx=' + (dubCtx ? dubCtx.state : '-') + ' resyncs=' + dubRestartsTotal,
      'idx current=' + state.current + ' lastShown=' + state.lastShown + ' pausedFor=' + state.pausedFor + ' display=' + state.lastDisplayIdx + ' clip=' + JSON.stringify(state.clip) + ' capturing=' + !!state.capturing + ' tabId=' + state.tabId,
      'layout panel=' + !!(settings.panelOpen && state.active) + ' videoRight=' + (v ? Math.round(v.getBoundingClientRect().right) : '-') + '/' + window.innerWidth + ' fit=' + (fit.el ? describeEl(fit.el) : '-') + ' shadowRoots=' + (adapter.deep ? A.deepRoots().length - 1 : 0) + ' nativeHidden=' + nativeHiddenCount() + ' cueEl=' + (adapter.nativeCueSelector ? A.qsaDeep(adapter.nativeCueSelector).map(describeEl).slice(0, 2).join(',') : '-'),
    ].join('\n');
  }

  function describeEl(e) {
    if (!e || !e.tagName) return '-';
    const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls ? '.' + cls : '');
  }
  function nativeHiddenCount() {
    const css = adapter.nativeHideCss || '';
    const sel = css.split('{')[0].trim();
    if (!sel) return 0;
    try { return A.qsaDeep(sel).length; } catch (e) { return -1; }
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
    ui.list.classList.toggle('st-ko-veiled', settings.koMode !== 'always');
    const frag = document.createDocumentFragment();
    state.cues.forEach((c, i) => {
      const en = el('div', { class: 'st-en' });
      fillMarked(en, c.text.replace(/\n/g, ' '), settings.kiwiNotes ? kiwiHits(c) : []);
      const main = el('div', { class: 'st-row-main' }, [en, el('div', { class: 'st-ko', text: settings.showTranslation ? koFor(c) : '' })]);
      if (settings.soundsLike && Sp) { const sl = Sp.soundsLike(c.text.replace(/\n/g, ' ')); if (sl && sl !== c.text) main.append(el('div', { class: 'st-sound', text: sl })); }
      if (settings.kiwiNotes) { const hits = kiwiHits(c); if (hits.length) main.append(el('div', { class: 'st-kiwi-line', text: hits.slice(0, 3).map((h) => h.term + ' = ' + h.ko).join(' · ') })); }
      const row = el('div', { class: 'st-row' + (settings.secondPass && state.missed.has(itemIdFor(c)) ? ' st-missed' : ''), 'data-i': i }, [main, el('button', { class: 'st-star', title: '저장 (E)' }, '☆')]);
      frag.append(row);
      ui.rows.push(row);
    });
    ui.list.append(frag);
    rowObserver = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) queueRowTranslation(+en.target.dataset.i);
    }, { root: ui.list, rootMargin: '200px 0px' });
    ui.rows.forEach((r) => rowObserver.observe(r));
    highlightRow(state.current, true);
    markDubRows();
    placeDubBox(false); // 목록을 다시 그리면 더빙 칸도 그 자막 아래로 다시 넣는다
  }
  function updateRowKo(i) {
    const row = ui.rows && ui.rows[i];
    const ko = row && row.querySelector('.st-ko');
    if (ko) ko.textContent = settings.showTranslation ? koFor(state.cues[i]) : '';
  }
  const kiwiCache = new WeakMap();
  function kiwiHits(c) {
    if (!Sp || !Kiwi.length) return [];
    let h = kiwiCache.get(c);
    if (!h) { h = Sp.findKiwi(c.text, Kiwi); kiwiCache.set(c, h); }
    return h;
  }
  // 텍스트에 키위 용어 밑줄을 넣는다 (텍스트 노드 + <u>)
  function fillMarked(node, text, hits) {
    node.textContent = '';
    if (!hits || !hits.length) { node.textContent = text; return; }
    let pos = 0;
    for (const h of hits) {
      if (h.start > pos) node.append(document.createTextNode(text.slice(pos, h.start)));
      node.append(el('u', { class: 'st-kiwi', title: h.term + ' = ' + h.ko }, text.slice(h.start, h.end)));
      pos = h.end;
    }
    if (pos < text.length) node.append(document.createTextNode(text.slice(pos)));
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
    if (state.pausedFor >= 0 && (adapter.isPaused() || now() - state.pausedAt < 1500)) return state.pausedFor;
    return -1;
  }
  function renderOverlay(force) {
    if (!ui.overlay) return;
    const i = displayIndex();
    if (!force && i === state.lastDisplayIdx) return;
    state.lastDisplayIdx = i;
    if (!settings.overlay || !isEnabled() || i < 0 || !state.cues[i] || (adapter.isAdPlaying && adapter.isAdPlaying())) { ui.overlay.classList.add('st-hidden'); return; }
    const c = state.cues[i];
    const id = itemIdFor(c);
    const missed = state.missed.has(id);
    const clozed = settings.cloze !== 'off' && Sp && state.clozeRevealIdx !== i;
    const text = clozed ? Sp.clozeLine(c.text, settings.cloze, i).text : c.text;
    fillMarked(ui.ovText, text, settings.kiwiNotes && !clozed ? kiwiHits(c) : []);
    let showKo = !!settings.showTranslation;
    if (settings.koMode === 'hold') showKo = showKo && (state.koHold || (settings.secondPass && missed));
    else if (settings.koMode === 'afterRepeat') showKo = showKo && (state.koHold || (settings.secondPass && missed) || (state.loop && state.loopIdx === i && state.loopCount >= (settings.koRepeats || 3)));
    ui.ovKo.textContent = showKo ? koFor(c) : '';
    ui.ovSound.textContent = settings.soundsLike && Sp && !clozed ? Sp.soundsLike(c.text) : '';
    const hits = settings.kiwiNotes ? kiwiHits(c) : [];
    ui.ovKiwi.textContent = hits.length ? hits.slice(0, 3).map((h) => h.term + ' = ' + h.ko).join(' · ') : '';
    ui.ovStar.textContent = state.saved.has(id) ? '★' : '☆';
    ui.ovStar.classList.toggle('missed', missed);
    if (!showKo && settings.koMode === 'hold' && settings.showTranslation && !settings.koHintShown && !state.koHintDone) { state.koHintDone = true; toast('한국어 뜻은 T 키를 누르는 동안만 보입니다 (⚙ → 한국어 표시 방식에서 바꿀 수 있어요)', 6000); saveSettings({ koHintShown: true }); }
    ui.ovStar.title = missed ? '못 알아들음으로 표시됨 (Q 로 해제)' : '이 자막 저장 (E) · 못 알아들음 표시 (Q)';
    ui.overlay.classList.remove('st-hidden');
  }
  // Q: 지금 보이는 자막을 "못 알아들음"으로 표시 (별표 저장 + 태그). 다시 누르면 해제
  async function toggleMissed() {
    const shown = displayIndex();
    const i = shown >= 0 ? shown : anchorIndex();
    if (i < 0) { chip('info', '표시할 자막이 없습니다'); return; }
    const c = state.cues[i];
    const id = itemIdFor(c);
    const tag = settings.missedTag || '못 알아들음';
    try {
      if (state.missed.has(id)) {
        state.missed.delete(id);
        const it = state.saved.get(id);
        const tags = ((it && it.tags) || []).filter((t) => t !== tag);
        if (it) { it.missed = false; it.tags = tags; }
        await bg({ type: 'items.update', id, patch: { missed: false, tags } });
        chip('unsaved', '못 알아들음 표시 해제');
      } else {
        if (!state.saved.has(id)) {
          const item = buildItem(c, i);
          item.missed = true; item.tags = [tag];
          state.saved.set(id, item);
          await bg({ type: 'items.save', item });
          if (!item.translation) bg({ type: 'translate', texts: [c.text.replace(/\n/g, ' ')], from: 'en', to: 'ko' }).then((res) => { const t = res && res.translations && res.translations[0]; if (t) { c.koMt = t; updateRowKo(i); bg({ type: 'items.update', id, patch: { translation: t, translationSource: 'mt' } }).catch(() => {}); } }).catch(() => {});
          if (settings.audioMode && settings.audioMode !== 'off') queueCapture(i, item);
        } else {
          const it = state.saved.get(id);
          const tags = ((it && it.tags) || []).concat(tag).filter((t, k, a) => a.indexOf(t) === k);
          if (it) { it.missed = true; it.tags = tags; }
          await bg({ type: 'items.update', id, patch: { missed: true, tags } });
        }
        state.missed.add(id);
        const names = Array.isArray(settings.tagNames) ? settings.tagNames : [];
        if (!names.includes(tag)) bg({ type: 'settings.set', patch: { tagNames: names.concat(tag) } }).catch(() => {});
        chip('missed', '못 알아들음 · 저장했습니다 (태그 "' + tag + '")');
      }
      refreshSavedMarks();
      if (ui.rows && ui.rows[i]) ui.rows[i].classList.toggle('st-missed', settings.secondPass && state.missed.has(id));
      renderOverlay(true);
      saveEpisodeStats(false);
    } catch (e) { toast('표시 실패: ' + (e && e.message)); }
  }
  // 에피소드별 통계 (웹의 진행 대시보드): 본 줄 수·못 알아들음·말 속도·어휘 난도. 시리즈별 3천 밖 단어 재출현도 기록
  function saveEpisodeStats(withSeries) {
    if (!state.videoId || !state.cues.length) return;
    const p = state.profile;
    const d = p ? Voc.difficulty(p) : null;
    const meta = state.meta || adapter.domTitle() || {};
    const data = { platform: adapter.name, videoId: state.videoId, title: meta.title || '', episode: meta.episode || '', lines: state.cues.length, watched: state.watched.size, missed: state.missed.size, wpm: p ? p.wpm : 0, outside3k: d ? Math.round(d.outside * 10) / 10 : null, need95: p ? p.need95 : null, difficulty: d ? d.label : '', updatedAt: Date.now() };
    const msg = { type: 'stats.episode', key: adapter.name + ':' + state.videoId, data };
    if (withSeries && p && meta.title && !state.seriesSaved) {
      state.seriesSaved = true;
      msg.series = { key: adapter.name + ':' + meta.title, videoId: state.videoId, words: p.beyond3k.slice(0, 400).map((e) => e.word) };
    }
    state.statsSavedAt = now();
    bg(msg).catch(() => {});
  }
  // 플랫폼이 그리는 자막 문장과 우리 큐를 대조해 자막 시간 보정값을 자동으로 찾는다 (프라임/디즈니/유튜브)
  function startNativeAlignWatch() {
    if (adapter.name === 'netflix' || !adapter.nativeCueSelector) return;
    const check = () => {
      if (!state.cues.length) return;
      const nodes = document.querySelectorAll(adapter.nativeCueSelector);
      if (!nodes.length) { state.lastNativeText = ''; return; }
      const text = Array.from(nodes).map((n) => n.textContent.trim()).filter(Boolean).join(' ');
      if (!text || text === state.lastNativeText) return;
      state.lastNativeText = text;
      if (adapter.isPaused() || now() - state.lastSeekAt < 2500 || now() - state.pausedAt < 2500) return;
      const raw = rawMs();
      if (!isFinite(raw)) return;
      const norm = S.normalizeForCompare(text);
      if (norm.split(' ').length < 3) return;
      let best = null;
      for (const c of state.cues) {
        if (c.start < raw - 120000 || c.start > raw + 120000) continue;
        if (S.normalizeForCompare(c.text) === norm) { if (best) { best = null; break; } best = c; }
      }
      if (!best) return;
      state.alignSamples.push(Math.round(best.start - raw));
      if (state.alignSamples.length > 9) state.alignSamples.shift();
      const need = state.offsetSource === 'auto' || state.offsetSource === 'manual' ? 3 : 2;
      if (state.alignSamples.length >= need) {
        const sorted = state.alignSamples.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const agree = sorted.filter((x) => Math.abs(x - med) <= 400).length;
        if (agree >= need) {
          const target = Math.abs(med) < 250 ? 0 : Math.round(med / 10) * 10;
          if (Math.abs(target - state.offsetMs) > 300) {
            saveOffset(target, 'auto');
            toast('자막 시간 자동 보정: ' + (target >= 0 ? '+' : '') + (target / 1000).toFixed(1) + '초');
          } else if (state.offsetSource !== 'auto' && state.offsetSource !== 'manual') {
            saveOffset(state.offsetMs, 'auto');
          }
        }
      }
    };
    new MutationObserver(() => check()).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ───────────── 재생 제어 ─────────────
  function seekTo(ms) {
    state.seekByUsUntil = now() + 1500;
    state.lastSeekAt = now();
    state.lastSeekTarget = ms;
    adapter.seek(Math.max(0, ms));
    if (state.rate !== 1) state.rateReapplyUntil = now() + 2500; // 일부 플레이어는 탐색 뒤 속도를 되돌린다
  }
  function applyRate(quiet) {
    const v = adapter.video();
    const r = state.rate;
    if (typeof adapter.setRate === 'function') adapter.setRate(r);
    if (v) {
      // 속도를 바꿔도 목소리 높이는 그대로 (크롬 기본값이지만 플레이어가 꺼 두는 경우가 있어 직접 켠다)
      try { for (const k of ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch']) if (k in v && v[k] !== true) v[k] = true; } catch (e) { /* ignore */ }
      try { if (Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r; } catch (e) { /* ignore */ }
    }
    state.rateReapplyUntil = now() + 2500;
    if (!quiet) toast('⏩ 재생 속도 ' + rateText(r) + '×');
    updateModeUI();
  }
  function changeRate(delta) {
    const next = delta === 0 ? 1 : Math.round(clamp(state.rate + delta, 0.5, 2) * 100) / 100;
    state.rate = next;
    applyRate(false);
  }
  function markResume() { state.resumeByUsUntil = now() + 1500; }
  function requestPlay() { markResume(); state.playRequestedAt = now(); adapter.play(); }
  // 정지 상태면 재생을 먼저 걸고 탐색한다 (프라임은 정지 중 탐색 뒤의 play 가 취소된다). 그 뒤 실제로 재생되는지 확인하고 재시도.
  function playFrom(videoMs, keepPaused) {
    const wasPaused = adapter.isPaused();
    if (!keepPaused && wasPaused) requestPlay();
    seekTo(videoMs);
    if (!keepPaused) ensurePlaying(videoMs);
  }
  function ensurePlaying(targetMs) {
    clearTimeout(state.ensureTimer);
    let tries = 0;
    const check = () => {
      state.ensureTimer = null;
      if (!state.active) return;
      const raw = rawMs();
      const farOff = isFinite(raw) && Math.abs(raw - targetMs) > 4000 && now() - state.lastSeekAt < 8000;
      if (adapter.isPaused() || farOff) {
        if (tries++ >= 4) return;
        if (farOff) seekTo(targetMs);
        requestPlay();
        state.ensureTimer = setTimeout(check, 700 + tries * 400);
      }
    };
    state.ensureTimer = setTimeout(check, 700);
  }
  function cancelModesPending() { clearShadow(); clearEndTimer(); state.pausedFor = -1; cancelDubLadder(true); stopDubPreview(); if (state.dubRec) state.dubRec.cancel = true; }
  function goToCue(i, opts) {
    if (!state.cues.length) return;
    i = clamp(i, 0, state.cues.length - 1);
    if (dubModeOn()) {
      if (i >= state.dubRange[0] && i <= state.dubRange[1]) { cancelDubLadder(true); stopDubPreview(); startDubLoop(); }
      else openDubBox(i);
      return;
    }
    const c = state.cues[i];
    if (state.clip) stopClip('user');
    cancelModesPending();
    state.lastShown = i; state.prevIdx = -1;
    if (state.loop) { if (state.loopIdx !== i) { state.loopCount = 0; if (settings.loopLadder) { state.rate = ladderRates()[0]; applyRate(true); } } state.loopIdx = i; }
    state.clozeRevealIdx = -1;
    playFrom(cueVideoMs(c) - settings.leadMs, !!(opts && opts.play === false));
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
  // 반복 속도 사다리: 웹 설정(속도 사다리)의 단계를 그대로 쓴다
  const LADDER_FALLBACK = [0.8, 0.9, 1, 1.15];
  function ladderRates() {
    const raw = settings.web && Array.isArray(settings.web.ladderRates) ? settings.web.ladderRates : [];
    const out = raw.map((x) => Math.round(clamp(+x, 0.3, 2) * 100) / 100).filter((x) => Number.isFinite(x) && x > 0).slice(0, 6);
    return out.length ? out : LADDER_FALLBACK;
  }
  const rateText = (r) => String(Math.round(r * 100) / 100);
  // Shift+< / Shift+> 와 컨트롤 바의 ‹ › 가 오르내리는 단계: 설정 › 속도 사다리에 넣은 배속(+ 보통 속도 1배)
  function rateSteps() {
    const set = new Set(ladderRates().concat([1]).map((r) => Math.round(clamp(r, 0.3, 2) * 100) / 100));
    return Array.from(set).sort((a, b) => a - b);
  }
  function stepRate(dir) {
    const L = rateSteps();
    const cur = state.rate;
    const next = dir > 0 ? L.find((r) => r > cur + 0.005) : L.filter((r) => r < cur - 0.005).pop();
    if (next === undefined) { toast('⏩ ' + (dir > 0 ? '가장 빠른' : '가장 느린') + ' 단계입니다 · ' + rateText(cur) + '× (단계는 설정에서)'); return; }
    state.rate = next;
    applyRate(false);
  }
  function toggleLoop() {
    if (state.loop) {
      state.loop = false; state.loopIdx = -1; toast('반복 끔');
      if (settings.loopLadder && Math.abs(state.rate - state.loopBaseRate) > 0.01) { state.rate = state.loopBaseRate; applyRate(true); }
    } else {
      const i = anchorIndex();
      if (i < 0) return;
      state.loop = true; state.loopIdx = i; state.loopCount = 0; state.loopBaseRate = state.rate;
      if (settings.loopLadder) { const L = ladderRates(); state.rate = L[0]; applyRate(true); toast('🔁 반복 · 속도 사다리 ' + L.map(rateText).join('→') + '×'); } else toast('🔁 이 자막 반복');
      goToCue(i);
    }
    updateModeUI();
    renderOverlay(true);
  }
  function setMode(mode, on) {
    const patch = {};
    if (mode === 'autoPause') { patch.autoPause = !!on; if (on) patch.shadowing = false; }
    else { patch.shadowing = !!on; if (on) patch.autoPause = false; }
    saveSettings(patch);
    if (!on) cancelModesPending();
    toast(mode === 'autoPause' ? (on ? '⏸ 자동 일시정지 켬 (F: 다시 듣기)' : '자동 일시정지 끔') : (on ? '🗣 따라하기 켬 · ' + shadowPauseText() + '만큼 쉬고 다음 자막' : '따라하기 끔'));
    updateModeUI();
  }
  function pauseFor(i) {
    state.pausedFor = i;
    state.pausedAt = now();
    state.resumeByUsUntil = 0;
    state.pauseByUsUntil = now() + 1500;
    clearTimeout(state.ensureTimer);
    adapter.pause();
    renderOverlay(true);
    if (settings.shadowing) startShadowWait(i);
  }
  // 따라하기(쉐도잉)에서 자막이 끝난 뒤 쉬는 시간.
  // 기본은 "그 자막이 떠 있던 시간 × 배율" — 긴 대사는 길게, 짧은 대사는 짧게 쉬므로 따로 맞출 필요가 없다.
  // 아주 짧은 대사("Yeah.")도 따라 할 틈이 있도록 0.8초 이상, 너무 오래 멈추지 않도록 10초 이하로 둔다.
  const SHADOW_RATIOS = [0.8, 1, 1.1, 1.2, 1.3, 1.5, 2];
  const SHADOW_MIN_MS = 800, SHADOW_MAX_MS = 10000;
  // 고를 수 있는 배율 중 가장 가까운 값으로 맞춘다. 목록에 없는 값이 저장돼 있으면 선택 상자가 빈칸으로 보인다.
  const shadowRatio = () => {
    const v = clamp(+settings.shadowPauseRatio || 1, 0.5, 3);
    return SHADOW_RATIOS.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), SHADOW_RATIOS[0]);
  };
  const shadowSecs = () => clamp(+settings.shadowPauseSec || 2, 1, 7);
  const shadowByRatio = () => settings.shadowPauseMode !== 'sec';
  const shadowPauseValue = () => (shadowByRatio() ? 'r' + shadowRatio() : 's' + shadowSecs());
  function shadowPausePatch(v) {
    const s = String(v || '');
    if (s.charAt(0) === 's') return { shadowPauseMode: 'sec', shadowPauseSec: clamp(+s.slice(1) || 2, 1, 7) };
    return { shadowPauseMode: 'ratio', shadowPauseRatio: clamp(+s.slice(1) || 1, 0.5, 3) };
  }
  function shadowPauseMs(i) {
    const c = state.cues[i];
    if (!shadowByRatio() || !c) return shadowSecs() * 1000;
    return Math.round(clamp((c.end - c.start) * shadowRatio(), SHADOW_MIN_MS, SHADOW_MAX_MS));
  }
  const shadowPauseText = () => (shadowByRatio() ? '자막 길이 ×' + rateText(shadowRatio()) : shadowSecs() + '초');
  // 패널 헤더는 자리가 좁아 짧게(×1), 설정 화면은 길게(자막 길이 ×1). 묶음 이름이 무슨 뜻인지 알려 준다.
  function shadowPauseOptions(long) {
    return [
      el('optgroup', { label: '자막 길이 기준' }, SHADOW_RATIOS.map((r) => el('option', { value: 'r' + r }, (long ? '자막 길이 ×' : '×') + rateText(r)))),
      el('optgroup', { label: '고정 시간' }, Array.from({ length: 7 }, (_, k) => el('option', { value: 's' + (k + 1) }, (long ? '고정 ' : '') + (k + 1) + '초'))),
    ];
  }
  function startShadowWait(i) {
    clearShadow();
    const ms = shadowPauseMs(i);
    const sec = Math.round(ms / 100) / 10;
    ui.ovShadowText.textContent = '🗣 따라 말해 보세요 · ' + sec + '초 뒤 다음 자막';
    ui.ovShadowBar.style.transition = 'none';
    ui.ovShadowBar.style.width = '100%';
    ui.ovShadow.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => { ui.ovShadowBar.style.transition = 'width ' + (ms / 1000) + 's linear'; ui.ovShadowBar.style.width = '0%'; }));
    state.shadowTimer = setTimeout(() => {
      state.shadowTimer = null;
      ui.ovShadow.classList.remove('on');
      if (settings.shadowing && state.pausedFor === i && adapter.isPaused()) requestPlay();
    }, ms);
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
    const waitMs = Math.max(0, (c.end - t) / rate - 15);
    state.endTimer = setTimeout(() => { state.endTimer = null; tick(true); }, waitMs);
  }

  // 원격 재생 (웹사이트에서 "재생"을 눌렀을 때). startMs/endMs 는 영상 시간.
  function startClip(msg) {
    cancelModesPending();
    state.loop = false; state.loopIdx = -1; updateModeUI();
    state.clip = { clipId: msg.clipId, startMs: msg.startMs, endMs: msg.endMs, loop: !!msg.loop, loops: 0, lastLoopAt: 0, phase: 'seeking', startedAt: now(), playTries: 0, lastPlayAt: now(), prevRate: state.rate, rate: msg.rate > 0 ? msg.rate : 0 };
    if (state.clip.rate && Math.abs(state.clip.rate - state.rate) > 0.01) { state.rate = state.clip.rate; applyRate(true); }
    playFrom(msg.startMs - settings.leadMs);
    highlightRow(S.findCueIndex(state.cues, msg.startMs + effectiveOffset() + 10), true);
  }
  function clipEvent(event, extra) {
    if (!state.clip) return;
    bg(Object.assign({ type: 'player.event', clipId: state.clip.clipId, event }, extra || {})).catch(() => {});
  }
  function restoreClipRate(c) { if (c && c.rate && Math.abs(state.rate - c.prevRate) > 0.01) { state.rate = c.prevRate; applyRate(true); } }
  function stopClip(reason) {
    if (!state.clip) return;
    const c = state.clip;
    state.clip = null;
    restoreClipRate(c);
    clearTimeout(state.ensureTimer);
    // 웹사이트의 정지(또는 다른 대사 재생)로 멈출 때는 플레이어도 멈춘다. 플레이어에서 직접 이동한 경우('user')는 그대로 둔다
    if (reason === 'stopped') { state.pauseByUsUntil = now() + 1500; adapter.pause(); }
    bg({ type: 'player.event', clipId: c.clipId, event: reason === 'ended' ? 'ended' : 'stopped', reason }).catch(() => {});
  }
  function handleClip(raw, paused) {
    const c = state.clip;
    if (!c) return;
    const start = c.startMs - settings.leadMs;
    if (c.phase === 'seeking') {
      if (!paused && raw >= start - 600 && raw < c.endMs) { c.phase = 'playing'; clipEvent('playing'); return; }
      if (now() - c.startedAt > 25000) {
        state.clip = null;
        bg({ type: 'player.event', clipId: c.clipId, event: 'error', message: paused ? '플레이어가 재생을 시작하지 못했습니다. 플레이어 탭을 한 번 클릭한 뒤 다시 시도하세요.' : '탐색 시간 초과' }).catch(() => {});
      }
      return;
    }
    if (c.loop && raw >= c.endMs + settings.tailMs && raw < c.endMs + 4000) {
      // 반복 재생: 구간 끝에서 처음으로 되돌린다 (탐색이 반영되기 전의 중복 탐색은 막는다)
      if (now() - c.lastLoopAt > 500) { c.lastLoopAt = now(); c.loops++; c.lastPlayAt = now(); c.playTries = 0; seekTo(start); }
      return;
    }
    if (raw >= c.endMs + settings.tailMs || raw < start - 3000) {
      state.pauseByUsUntil = now() + 1500;
      adapter.pause();
      state.clip = null;
      restoreClipRate(c);
      bg({ type: 'player.event', clipId: c.clipId, event: 'ended' }).catch(() => {});
      return;
    }
    if (paused) {
      // 백그라운드 탭에서는 브라우저가 탐색 직후 영상을 멈추기도 한다: 반복 탐색 뒤 잠깐 사이의 멈춤은 다시 재생을 건다
      if (c.loop && now() - c.lastLoopAt < 2500 && c.playTries < 3 && now() - c.lastPlayAt > 300) { c.playTries++; c.lastPlayAt = now(); requestPlay(); return; }
      if (now() - c.lastPlayAt > 2500) {
        state.clip = null;
        bg({ type: 'player.event', clipId: c.clipId, event: 'stopped' }).catch(() => {});
      }
    }
  }

  // ───────────── 더빙 ─────────────
  // 더빙 모드(R): 지금 자막 줄 바로 아래(오른쪽 패널 안, 팝업 아님)에 더빙 칸이 열리고 그 구간만 계속 반복 재생된다.
  // ① 배속 연습(설정한 단계대로 한 번씩) · 배속 버튼으로 반복 속도 바꾸기
  // ② 고른 배속으로 녹음 — 0.5배로 고르면 영상도 0.5배로 흐르며 녹음하고, 저장할 때 음높이를 지킨 채(WSOLA) 원래 길이로 줄여 1배속 영상에 맞춘다
  // ③ ☆ 로 고르면 그 구간은 원래 소리 대신 내 녹음으로 재생된다 (✕ 로 지우기). 녹음은 구간마다 3개까지
  // 녹음은 플레이어 페이지에서 마이크로 받는다(사이트마다 처음 한 번 허용). 재생은 WebAudio 로 해 페이지의 CSP 와 상관없다.
  const DUB_MAX_TAKES = 3, DUB_PAD_MS = 250, DUB_LEAD_MS = 700, DUB_MAX_LINES = 8, DUB_MAX_MS = 30000;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const dubKey = () => 'dubs:' + adapter.name + ':' + state.videoId;
  const dubAudioKey = (takeId) => 'dubaudio:' + takeId;
  const dubBuffers = new Map();   // takeId -> Promise<AudioBuffer|null>
  const dubReady = new Map();     // takeId -> AudioBuffer (디코딩이 끝난 것)
  const dubBroken = new Set();    // 읽지 못한 녹음
  let dubCtx = null;
  const dubClock = globalThis.SubTutorAudio && globalThis.SubTutorAudio.mediaClock ? globalThis.SubTutorAudio.mediaClock() : null;
  const dubGuarded = new WeakSet(); // volumechange 감시를 붙인 video
  let dubRestartsTotal = 0;
  const fmtT = (ms) => { const s = Math.max(0, ms) / 1000; const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
  const dubModeOn = () => state.dubBoxFor >= 0;
  // 더빙 모드이거나 연습·녹음·들어보기 중이면 자동 일시정지·따라하기·S 반복이 끼어들지 않는다
  const dubBusy = () => !!(state.dubRec || state.dubLadder || state.dubPreview || dubModeOn());
  const uniqRates = (xs) => { const out = []; for (const x of xs) if (!out.some((y) => Math.abs(y - x) < 0.005)) out.push(x); return out; };
  // ① 의 배속 버튼 = 설정한 속도 사다리의 배속 (같은 값은 한 번만)
  const dubPracticeRates = () => uniqRates(ladderRates());
  // ② 의 녹음 배속 = 웹 설정 › 더빙 녹음 배속 (0.5~1, 기본 0.5·0.7·1). 0.5 보다 느리면 원래 길이로 줄일 때 소리가 망가진다
  function dubRecRates() {
    const raw = settings.web && Array.isArray(settings.web.dubRecRates) ? settings.web.dubRecRates : [0.5, 0.7, 1];
    const out = uniqRates(raw.map((x) => Math.round(clamp(+x || 1, 0.5, 1) * 100) / 100)).sort((a, b) => a - b);
    return out.length ? out : [1];
  }
  // 고른 녹음 배속은 기억한다 (다른 자막으로 옮겨도 그대로). 처음은 1배
  function dubRecRate() {
    const opts = dubRecRates(), r = +settings.dubRecRate || 1;
    const hit = opts.find((x) => Math.abs(x - r) < 0.005);
    return hit !== undefined ? hit : (opts.find((x) => Math.abs(x - 1) < 0.005) || opts[opts.length - 1]);
  }
  const chosenTake = (seg) => (seg && seg.chosen ? seg.takes.find((t) => t.id === seg.chosen) || null : null);
  // el() 은 setAttribute 라 disabled:false 도 켜 버린다 → disabled·checked 는 속성으로 넣는다
  function withProps(n, props) { for (const k of Object.keys(props)) n[k] = props[k]; return n; }
  function dubAudioCtx() {
    if (!dubCtx) dubCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (dubCtx.state === 'suspended') dubCtx.resume().catch(() => {});
    return dubCtx;
  }
  async function loadDubs() {
    const token = state.runToken, key = dubKey();
    let segs = [];
    try { const got = await chrome.storage.local.get(key); const d = got[key]; segs = d && Array.isArray(d.segs) ? d.segs : []; } catch (e) { segs = []; }
    if (token !== state.runToken) return;
    state.dubSegs = segs.filter((s) => s && Array.isArray(s.takes) && Number.isFinite(s.startMs) && Number.isFinite(s.endMs));
    markDubRows();
    renderDubBox();
    for (const s of state.dubSegs) { const t = chosenTake(s); if (t) dubBuffer(t.id); } // 고른 녹음은 미리 풀어 두어 구간 첫머리를 놓치지 않는다
  }
  async function saveDubs() {
    const key = dubKey();
    state.dubSegs = state.dubSegs.filter((s) => s.takes.length); // 녹음이 없는 구간은 남기지 않는다
    try {
      if (state.dubSegs.length) await chrome.storage.local.set({ [key]: { segs: state.dubSegs, savedAt: Date.now() } });
      else await chrome.storage.local.remove(key);
    } catch (e) { toast('더빙 저장 실패: ' + e.message); }
    markDubRows();
  }
  // 자막 i..j 를 영상 시간 구간으로 (녹음·재생은 영상 시간, 목록과의 연결은 자막 시간으로 한다)
  function dubRangeOf(i, j) {
    const a = state.cues[i], b = state.cues[j];
    if (!a || !b) return null;
    return { startMs: Math.round(cueVideoMs(a)), endMs: Math.round(cueVideoEndMs(b)), cueStart: a.start, cueEnd: b.end, text: state.cues.slice(i, j + 1).map((c) => c.text.replace(/\n/g, ' ')).join(' ') };
  }
  const currentDubRange = () => (state.dubBoxFor >= 0 ? dubRangeOf(state.dubRange[0], state.dubRange[1]) : null);
  function dubSegFor(r, create) {
    let seg = state.dubSegs.find((s) => s.cueStart === r.cueStart && s.cueEnd === r.cueEnd);
    if (!seg && create) {
      seg = { id: 'g' + Date.now().toString(36), startMs: r.startMs, endMs: r.endMs, cueStart: r.cueStart, cueEnd: r.cueEnd, text: r.text, takes: [], chosen: null };
      state.dubSegs.push(seg);
      state.dubSegs.sort((x, y) => x.startMs - y.startMs);
    }
    return seg || null;
  }
  // 목록: 더빙 녹음이 있는 줄에 🎙 (★ 로 고른 구간은 진하게 + 왼쪽 노란 줄)
  function markDubRows() {
    if (!ui.rows || !ui.rows.length) return;
    const has = new Map();
    for (const s of state.dubSegs) if (s.takes.length) has.set(s.cueStart, has.get(s.cueStart) === 'chosen' || chosenTake(s) ? 'chosen' : 'takes');
    state.cues.forEach((c, i) => {
      const row = ui.rows[i];
      if (!row) return;
      const st = has.get(c.start);
      let mark = row.querySelector('.st-dub-mark');
      if (!st) { if (mark) mark.remove(); row.classList.remove('st-dubbed'); return; }
      if (!mark) { mark = el('button', { class: 'st-dub-mark', title: '더빙 (R)' }, '🎙'); row.insertBefore(mark, row.querySelector('.st-star')); }
      mark.classList.toggle('on', st === 'chosen');
      mark.title = st === 'chosen' ? '이 구간은 내 더빙으로 재생됩니다 · 눌러서 더빙 상자 열기 (R)' : '더빙 녹음이 있습니다 (☆ 로 고르면 재생) · 눌러서 열기 (R)';
      row.classList.toggle('st-dubbed', st === 'chosen');
    });
  }
  // 더빙 모드 열기: i 번째 자막(없으면 지금 보이는 자막) 바로 아래에 더빙 칸을 펴고 그 구간을 반복 재생한다
  function openDubBox(i) {
    if (!ui.dubbox) return;
    if (!state.cues.length) { toast('자막을 불러온 뒤에 더빙할 수 있습니다'); return; }
    if (!(i >= 0)) { const s = displayIndex(); i = s >= 0 ? s : anchorIndex(); }
    i = clamp(i < 0 ? 0 : i, 0, state.cues.length - 1);
    let j = i;
    // 이 줄에서 시작하는 녹음이 있으면 그 범위로 연다 (☆ 로 고른 구간 우선)
    const segs = state.dubSegs.filter((s) => s.cueStart === state.cues[i].start && s.takes.length);
    const pick = segs.find((s) => s.chosen) || segs[segs.length - 1];
    if (pick) { const k = state.cues.findIndex((c, x) => x >= i && c.end === pick.cueEnd); if (k >= i) j = k; }
    if (!dubModeOn()) { state.dubPrevRate = state.rate; state.dubLoopRate = 1; }
    if (state.dubRec) state.dubRec.cancel = true;
    state.dubBoxFor = i; state.dubRange = [i, j];
    cancelDubLadder(true);
    prepDubAction();
    if (!settings.panelOpen) setPanelOpen(true);
    if (ui.settings) ui.settings.classList.add('st-hidden');
    renderDubBox();
    placeDubBox(true);
    startDubLoop();
  }
  function closeDubBox() {
    if (!dubModeOn()) return;
    cancelDubLadder(true);
    stopDubPreview();
    if (state.dubRec) state.dubRec.cancel = true;
    state.dubBoxFor = -1;
    clearTimeout(state.ensureTimer); // 반복을 위해 걸어 둔 재생 확인을 멈춘다 (닫은 뒤 다른 곳으로 옮겨도 끌려오지 않게)
    placeDubBox(false);
    if (Math.abs(state.rate - state.dubPrevRate) > 0.01) { state.rate = state.dubPrevRate; applyRate(true); }
  }
  function toggleDubBox() { if (dubModeOn()) closeDubBox(); else openDubBox(); }
  function moveDubRange(d) { openDubBox(clamp(state.dubRange[0] + d, 0, state.cues.length - 1)); }
  function growDubRange(d) {
    const [i, j] = state.dubRange;
    let k = clamp(j + d, i, Math.min(state.cues.length - 1, i + DUB_MAX_LINES - 1));
    while (k > i && cueVideoEndMs(state.cues[k]) - cueVideoMs(state.cues[i]) > DUB_MAX_MS) k--;
    state.dubRange = [i, k];
    renderDubBox();
    placeDubBox(true);
    startDubLoop();
  }
  // 더빙 칸을 그 구간 마지막 줄 바로 아래(패널 목록 안)에 둔다. 구간 줄은 노랗게 표시하고, 칸이 패널 안에 보이게 스크롤한다
  function placeDubBox(scroll) {
    if (!ui.dubbox || !ui.list) return;
    ui.list.querySelectorAll('.st-row.st-dub-on').forEach((r) => r.classList.remove('st-dub-on'));
    if (!dubModeOn() || !ui.rows || !ui.rows.length) { ui.dubbox.classList.add('st-hidden'); if (ui.dubbox.parentElement) ui.dubbox.remove(); return; }
    const [i, j] = state.dubRange;
    for (let k = i; k <= j; k++) if (ui.rows[k]) ui.rows[k].classList.add('st-dub-on');
    const row = ui.rows[Math.min(j, ui.rows.length - 1)];
    if (!row) return;
    if (row.nextSibling !== ui.dubbox) row.after(ui.dubbox);
    ui.dubbox.classList.remove('st-hidden');
    if (scroll) {
      const L = ui.list, top = ui.rows[i].offsetTop - 6, bottom = ui.dubbox.offsetTop + ui.dubbox.offsetHeight + 6;
      if (top < L.scrollTop || bottom > L.scrollTop + L.clientHeight) L.scrollTo({ top: Math.max(0, Math.min(top, bottom - L.clientHeight)), behavior: 'auto' });
    }
  }
  // 더빙 모드에서는 그 구간만 계속 반복한다 (① 의 배속 버튼으로 고른 속도로)
  function startDubLoop() {
    const r = currentDubRange();
    if (!r || !dubModeOn()) return;
    if (Math.abs(state.rate - state.dubLoopRate) > 0.01) { state.rate = state.dubLoopRate; applyRate(true); }
    playFrom(r.startMs - settings.leadMs);
  }
  function dubLoopTick(raw, paused) {
    if (!dubModeOn() || paused || state.dubRec || state.dubLadder || state.dubPreview || state.capturing || state.clip) return;
    const r = currentDubRange();
    if (!r) return;
    if ((raw >= r.endMs + settings.tailMs || raw < r.startMs - settings.leadMs - 2500) && now() - state.lastLoopSeekAt > 500) {
      state.lastLoopSeekAt = now();
      seekTo(r.startMs - settings.leadMs);
    }
  }
  function setDubLoopRate(x) {
    if (state.dubRec) return;
    stopDubPreview();
    state.dubLoopRate = x;
    cancelDubLadder(true);
    renderDubBox();
    startDubLoop();
  }
  function setDubRecRate(x) {
    if (state.dubRec) return;
    saveSettings({ dubRecRate: x });
    renderDubBox();
  }
  // 연습·녹음·들어보기 전에 다른 재생 모드를 정리한다
  function prepDubAction() {
    stopDubPreview();
    if (state.clip) stopClip('user');
    if (state.loop) { state.loop = false; state.loopIdx = -1; updateModeUI(); }
    clearShadow(); clearEndTimer(); state.pausedFor = -1;
    stopDubPlay();
  }
  function pauseByUs() { state.pauseByUsUntil = now() + 1500; clearTimeout(state.ensureTimer); if (!adapter.isPaused()) adapter.pause(); }
  // 구간을 한 번 재생하고 끝에서 멈춘다. alive() 가 거짓이 되거나 사용자가 멈추면 false
  function playDubRange(r, lead, alive, onTick) {
    return new Promise((resolve) => {
      const target = r.startMs - lead;
      playFrom(target);
      const t0 = now();
      const limit = (r.endMs - target) / Math.max(0.3, state.rate) + 10000;
      let entered = false, pausedSince = 0;
      const finish = (ok) => { pauseByUs(); resolve(ok); };
      const step = () => {
        if (!alive()) { finish(false); return; }
        const raw = rawMs();
        const paused = adapter.isPaused();
        if (isFinite(raw)) {
          // 되감기가 반영된 뒤부터 끝을 본다 (예전 위치가 구간 끝 근처면 첫 측정에서 바로 끝났다고 착각한다)
          if (!entered && now() - t0 > 100 && raw >= target - 400 && raw < r.startMs + 200) entered = true;
          if (!entered && now() - t0 > 1500 && raw >= target - 400 && raw < r.endMs) entered = true;
          if (entered && onTick) onTick(raw, paused);
          if (entered && raw >= r.endMs + settings.tailMs) { finish(true); return; }
        }
        if (entered && paused) { if (!pausedSince) pausedSince = now(); else if (now() - pausedSince > 1500) { finish(false); return; } } else pausedSince = 0;
        if (now() - t0 > limit) { finish(false); return; }
        setTimeout(step, 30);
      };
      setTimeout(step, 60);
    });
  }
  // ① 배속 연습: 설정 › 속도 사다리의 단계대로 구간을 한 번씩 (예: 0.5 → 0.5 → 0.7 → 1배). 다시 누르면 멈춤. 끝나면 다시 그 구간 반복
  function cancelDubLadder(noResume) {
    const L = state.dubLadder;
    if (!L) return;
    state.dubLadder = null;
    if (dubModeOn()) { renderDubBox(); if (!noResume) startDubLoop(); return; }
    if (Math.abs(state.rate - L.prevRate) > 0.01) { state.rate = L.prevRate; applyRate(true); }
    renderDubBox();
  }
  async function runDubLadder() {
    if (state.dubLadder) { cancelDubLadder(); return; }
    if (state.dubRec) return;
    const r = currentDubRange();
    if (!r) return;
    prepDubAction();
    const L = { prevRate: state.rate, rates: ladderRates(), step: 0 };
    state.dubLadder = L;
    for (let k = 0; k < L.rates.length; k++) {
      if (state.dubLadder !== L) return;
      L.step = k;
      state.rate = L.rates[k]; applyRate(true);
      renderDubBox();
      const ok = await playDubRange(r, settings.leadMs, () => state.dubLadder === L);
      if (!ok || state.dubLadder !== L) { if (state.dubLadder === L) cancelDubLadder(); return; }
      if (k < L.rates.length - 1) await sleepMs(400);
    }
    if (state.dubLadder === L) cancelDubLadder(); // 다 들었으면 원래 속도로
  }
  // ② 녹음: 구간 앞에 세워 3·2·1 → 원래 소리를 끄고 고른 배속으로 구간을 재생하며 마이크를 녹음 → 구간에 맞춰 자르고
  //    (느리게 녹음했으면 음높이를 지킨 채 원래 길이로 줄여) MP3 로. 저장된 녹음은 언제나 1배속 영상 시간에 맞춰져 있다
  async function recordDubTake() {
    if (state.dubRec) { state.dubRec.cancel = true; return; } // 녹음 중에 다시 누르면 취소
    if (state.dubLadder) return;
    const r = currentDubRange();
    const Au = globalThis.SubTutorAudio;
    if (!r) return;
    if (!Au) { toast('오디오 유틸을 불러오지 못했습니다 (확장 프로그램을 다시 로드하세요)'); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('이 브라우저에서는 마이크 녹음을 쓸 수 없습니다'); return; }
    prepDubAction();
    const rec = { phase: 'mic', cancel: false, count: 0 };
    state.dubRec = rec;
    renderDubBox();
    const v = adapter.video();
    const prevMuted = v ? v.muted : false;
    const prevRate = state.rate;
    const recRate = dubRecRate();
    let stream = null, mr = null, mutedByUs = false;
    try {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch (e) { throw new Error(e && e.name === 'NotAllowedError' ? '마이크 사용이 막혀 있습니다. 주소창 왼쪽 아이콘에서 마이크를 허용한 뒤 다시 누르세요' : '마이크를 열지 못했습니다 (' + ((e && (e.message || e.name)) || '') + ')'); }
      state.dubMic = stream;
      if (ui.dubbox) ui.dubbox.dataset.mic = 'open';
      if (rec.cancel) throw new Error('cancel');
      pauseByUs();
      seekTo(r.startMs - DUB_LEAD_MS);
      if (Math.abs(state.rate - recRate) > 0.01) { state.rate = recRate; applyRate(true); } // 고른 녹음 배속으로 재생하며 녹음한다
      for (let n = 3; n >= 1; n--) { rec.phase = 'count'; rec.count = n; renderDubBox(); await sleepMs(600); if (rec.cancel) throw new Error('cancel'); }
      if (v) { v.muted = true; mutedByUs = true; } // 원래 소리를 끈다 (스피커 소리가 녹음에 섞이지 않게)
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { mr.onstop = res; });
      mr.start(100);
      const recStartWall = wall();
      const anchors = [];
      let lastRaw = NaN;
      rec.phase = 'rec'; renderDubBox();
      const ok = await playDubRange(r, DUB_LEAD_MS, () => !rec.cancel, (raw, paused) => {
        if (!paused && raw !== lastRaw) { anchors.push([wall(), raw]); lastRaw = raw; } // 멈춘 동안의 같은 값은 맞춤을 치우치게 하므로 버린다
        if (v && !v.muted) v.muted = true;
      });
      await sleepMs(200);
      if (mr.state !== 'inactive') mr.stop();
      await stopped;
      if (!ok) throw new Error(rec.cancel ? 'cancel' : '재생이 멈춰 이번 녹음은 저장하지 않았습니다');
      rec.phase = 'save'; renderDubBox();
      const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
      if (!blob.size) throw new Error('녹음 데이터가 비었습니다');
      const audio = await dubAudioCtx().decodeAudioData(await blob.arrayBuffer());
      const n = audio.length, sr = audio.sampleRate;
      const mono = new Float32Array(n);
      for (let ch = 0; ch < audio.numberOfChannels; ch++) { const d = audio.getChannelData(ch); for (let k = 0; k < n; k++) mono[k] += d[k] / audio.numberOfChannels; }
      // 벽시계 = offset + 영상 시각 / 배속 (배속으로 재생했으므로 영상 1ms 가 벽시계 1/배속 ms)
      const offs = anchors.map(([w, m]) => w - m / recRate).sort((a, b) => a - b);
      if (!offs.length) throw new Error('재생 위치를 읽지 못해 녹음을 구간에 맞추지 못했습니다');
      const offset = offs.length % 2 ? offs[offs.length >> 1] : (offs[offs.length / 2 - 1] + offs[offs.length / 2]) / 2;
      let samples = Au.clipSamples([{ startFrame: 0, samples: mono }], { originMs: recStartWall, sampleRate: sr, startMs: offset + (r.startMs - DUB_PAD_MS) / recRate, endMs: offset + (r.endMs + DUB_PAD_MS) / recRate });
      if (!samples || samples.length < sr * 0.2) throw new Error('구간이 녹음되지 않았습니다');
      let peak = 0;
      for (let k = 0; k < samples.length; k++) { const a = Math.abs(samples[k]); if (a > peak) peak = a; }
      if (peak < 0.003) throw new Error('마이크 소리가 들어오지 않았습니다 (마이크 연결·입력 음량을 확인하세요)');
      // 녹음이 시작된 순간의 영상 시각을 기준으로 앞 여유를 잰다 (녹음 시작이 늦었으면 여유가 줄어든다)
      const leadMs = Math.round(Math.min(DUB_PAD_MS, r.startMs - (recStartWall - offset) * recRate));
      // 느리게 녹음했으면 원래 길이로 줄인다 — 음높이는 그대로 (0.5배 녹음 → 2배 빠르게, 목소리가 가늘어지지 않음)
      if (Math.abs(recRate - 1) > 0.005) {
        const St = globalThis.SubTutorStretch;
        if (!St) throw new Error('속도 변환 모듈을 불러오지 못했습니다 (확장 프로그램을 다시 로드하세요)');
        samples = St.stretch(samples, sr, 1 / recRate);
      }
      const enc = Au.encodeClip(Au.normalize(samples, 0.9), sr, { rate: 32000, kbps: 64 });
      // clipStartMs: 이 녹음의 첫 샘플이 놓일 영상 시각 (재생은 이 값만 본다 — 나중에 자막 보정값이 바뀌어도 소리는 제자리)
      const take = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ms: Math.round((samples.length * 1000) / sr), clipStartMs: r.startMs - leadMs, format: enc.format, recRate };
      await chrome.storage.local.set({ [dubAudioKey(take.id)]: { b64: Au.bytesToBase64(enc.bytes), mime: enc.mime } });
      const seg = dubSegFor(r, true);
      seg.takes.push(take);
      // 구간마다 3개까지: 넘치면 가장 오래된 것부터 지운다 (☆ 로 고른 더빙은 남긴다)
      while (seg.takes.length > DUB_MAX_TAKES) {
        let k = seg.takes.findIndex((t) => t.id !== seg.chosen);
        if (k < 0) k = 0;
        dropDubTakeAudio(seg.takes.splice(k, 1)[0].id);
      }
      await saveDubs();
      chip('audio', '더빙 녹음 ' + seg.takes.length + '/' + DUB_MAX_TAKES + ' 저장' + (recRate !== 1 ? ' (' + rateText(recRate) + '배로 녹음 → 원래 속도로 맞춤)' : '') + ' · ☆ 를 누르면 이 구간의 더빙이 됩니다', 3000);
    } catch (e) {
      if (!e || e.message !== 'cancel') toast('🎙 ' + ((e && e.message) || e), 7000);
    } finally {
      try { if (mr && mr.state !== 'inactive') mr.stop(); } catch (x) { /* ignore */ }
      if (stream) stream.getTracks().forEach((t) => { try { t.stop(); } catch (x) { /* ignore */ } }); // 마이크를 바로 놓는다 (탭의 녹음 표시가 남지 않게)
      state.dubMic = null;
      if (ui.dubbox) ui.dubbox.dataset.mic = 'closed';
      if (v && mutedByUs) v.muted = prevMuted;
      const mine = state.dubRec === rec;
      if (mine) state.dubRec = null;
      if (dubModeOn()) { renderDubBox(); if (mine) startDubLoop(); } // 더빙 모드면 다시 그 구간 반복
      else { if (Math.abs(state.rate - prevRate) > 0.01) { state.rate = prevRate; applyRate(true); } renderDubBox(); }
    }
  }
  function dropDubTakeAudio(id) { dubBuffers.delete(id); dubReady.delete(id); chrome.storage.local.remove(dubAudioKey(id)).catch(() => {}); }
  // ③ ☆ : 이 녹음을 이 구간의 더빙으로 (다시 누르면 해제)
  async function chooseDubTake(seg, t) {
    seg.chosen = seg.chosen === t.id ? null : t.id;
    if (seg.chosen) { dubBuffer(t.id); if (settings.dubPlayback === false) saveSettings({ dubPlayback: true }); } // ☆ 를 고르면 더빙 재생은 자동으로 켜진다
    if (state.dubPlay && state.dubPlay.seg === seg) stopDubPlay();
    await saveDubs();
    renderDubBox();
    chip('audio', seg.chosen ? '이 구간은 원래 소리 대신 내 녹음으로 재생됩니다' : '더빙 해제 · 원래 소리로 재생', 2600);
  }
  async function deleteDubTake(seg, t) {
    if (state.dubPreview && state.dubPreview.take.id === t.id) stopDubPreview();
    if (state.dubPlay && state.dubPlay.take.id === t.id) stopDubPlay();
    seg.takes = seg.takes.filter((x) => x.id !== t.id);
    if (seg.chosen === t.id) seg.chosen = null;
    dropDubTakeAudio(t.id);
    await saveDubs();
    renderDubBox();
  }
  // 들어보기: 영상을 구간 조금 앞부터 재생하고, 구간에서는 원래 소리 대신 이 녹음 (☆ 를 고르기 전에 확인)
  async function previewDubTake(seg, t) {
    if (state.dubPreview && state.dubPreview.take.id === t.id) { stopDubPreview(); if (dubModeOn()) startDubLoop(); else pauseByUs(); return; }
    if (state.dubRec || state.dubLadder) return;
    prepDubAction();
    const buf = await dubBuffer(t.id);
    if (!buf) { toast('이 녹음을 읽지 못했습니다'); return; }
    const pv = { seg, take: t };
    state.dubPreview = pv;
    renderDubBox();
    await playDubRange({ startMs: seg.startMs, endMs: seg.endMs }, DUB_LEAD_MS, () => state.dubPreview === pv);
    if (state.dubPreview === pv) { stopDubPreview(); if (dubModeOn()) startDubLoop(); }
  }
  function stopDubPreview() {
    if (!state.dubPreview) return;
    state.dubPreview = null;
    stopDubPlay();
    renderDubBox();
  }
  // ④ 더빙 재생: ☆ 로 고른 녹음이 있는 구간에 들어서면 원래 소리를 끄고 그 녹음을 같은 자리부터 튼다. 구간을 벗어나면 원래대로
  function dubBuffer(takeId) {
    if (dubBuffers.has(takeId)) return dubBuffers.get(takeId);
    const p = (async () => {
      if (dubBroken.has(takeId)) return null;
      const key = dubAudioKey(takeId);
      const got = await chrome.storage.local.get(key);
      const a = got[key];
      if (!a || !a.b64) return null;
      const bytes = globalThis.SubTutorAudio.base64ToBytes(a.b64);
      const buf = await dubAudioCtx().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      dubReady.set(takeId, buf);
      return buf;
    })().catch(() => { dubBroken.add(takeId); return null; });
    dubBuffers.set(takeId, p);
    return p;
  }
  function dubTarget(raw) {
    const inWin = (t) => Number.isFinite(t.clipStartMs) && raw >= t.clipStartMs && raw < t.clipStartMs + t.ms - 40;
    const pv = state.dubPreview;
    if (pv) return inWin(pv.take) ? pv : null;
    if (settings.dubPlayback === false || state.dubRec || state.dubLadder || state.capturing || state.clip) return null;
    if (dubModeOn() && Math.abs(state.rate - 1) > 0.01) return null; // 더빙 모드에서 느리게 반복할 때는 원래 소리로 듣는다
    for (const seg of state.dubSegs) {
      const take = chosenTake(seg);
      if (take && inWin(take)) return { seg, take };
    }
    return null;
  }
  let dubLastRaw = NaN, dubStall = 0;
  function dubTick(raw, paused) {
    const v = adapter.video();
    const rate = (v && v.playbackRate) || 1;
    // 재생 중인데 위치가 그대로면 멈춘 것으로 본다: 디즈니+ 는 탐색 직후 새 위치를 조금 늦게 알려 주고(그사이 예전 위치가 남는다), 버퍼링 때도 그렇다
    dubStall = !paused && raw === dubLastRaw ? dubStall + 1 : 0;
    dubLastRaw = raw;
    // 디즈니+ 는 재생 위치를 0.5초쯤 간격으로 끊어서 알려 줘, 그대로 쓰면 시각이 톱니처럼 뒤로 튄다.
    // 예전에는 그때마다 녹음을 되감아 "Na-naice to-to" 처럼 말머리가 반복됐다 → 최근 1.5초의 중앙값으로 고른 시계를 쓴다
    const t = dubClock ? dubClock.update(raw, now(), paused || dubStall >= 3, rate) : raw;
    // 디즈니+: 사용자가 옮긴 뒤 플레이어가 새 위치를 알려 줄 때까지는 예전 위치가 계속 흘러간다 → 그동안은 더빙을 시작하지도 이어 가지도 않는다
    const staleAfterSeek = adapter.usesPageTime && state.seekingAt > 0 && A.shared.pageTime.at < state.seekingAt && now() - state.seekingAt < 1500;
    const tgt = paused || dubStall >= 6 || staleAfterSeek ? null : dubTarget(t); // 0.24초 넘게 멈춰 있으면 더빙도 멈춘다 (영상이 다시 흐르면 그 자리부터)
    const cur = state.dubPlay;
    if (!tgt) { if (cur) stopDubPlay(); return; }
    const want = (t - tgt.take.clipStartMs) / 1000; // 녹음 안에서 지금 나와야 할 위치(초)
    if (cur && cur.take.id === tgt.take.id && dubCtx) {
      if (dubStall > 0) return; // 위치가 멈춰 있는 동안에는 맞추지 않는다 (낡은 값으로 되감지 않게)
      const pos = cur.offset + (dubCtx.currentTime - cur.ctxAt) * cur.rate;
      const d = want - pos;
      // 정말 어긋났을 때만(탐색·버퍼링) 다시 맞춘다: 큰 점프는 바로, 0.45초 넘는 어긋남은 세 번 연달아일 때. 작은 흔들림에 되감으면 같은 소리가 반복된다
      cur.off = Math.abs(d) > 0.45 ? (cur.off || 0) + 1 : 0;
      if (Math.abs(d) > 1.5 || cur.off >= 3 || Math.abs(cur.rate - rate) > 0.01) { dubRestartsTotal++; startDubSource(tgt, want, rate, true); }
      else if (cur.videoEl && !cur.videoEl.muted) cur.videoEl.muted = true; // 플레이어가 소리를 되살리면 다시 끈다
      return;
    }
    if (dubStall > 0) return; // 새 더빙은 위치가 실제로 흐를 때만 시작한다 (탐색 직후 예전 위치로 잘못 시작하지 않게)
    startDubSource(tgt, want, rate, false);
  }
  function startDubSource(tgt, offsetSec, rate, isRestart) {
    const buf = dubReady.get(tgt.take.id);
    if (!buf) { dubBuffer(tgt.take.id); return; } // 디코딩이 끝나면 다음 틱에 시작한다
    if (offsetSec >= buf.duration - 0.04) return;
    const ctx = dubAudioCtx();
    if (ctx.state !== 'running') return; // 소리를 낼 수 없으면 원래 소리를 끄지 않는다 (페이지를 한 번 누르면 풀린다)
    const prev = state.dubPlay;
    const v = adapter.video();
    if (prev && prev.src) { try { prev.src.stop(); } catch (e) { /* ignore */ } }
    const restoreMuted = prev && prev.videoEl === v ? prev.restoreMuted : (v ? v.muted : false);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(ctx.destination);
    const at = Math.max(0, offsetSec);
    src.start(0, at);
    if (v) {
      v.muted = true;
      // 플레이어가 음소거를 풀면(volumechange) 그 자리에서 다시 끈다 — 틱(40ms)을 기다리면 원래 소리가 잠깐 새어 나온다
      if (!dubGuarded.has(v)) { dubGuarded.add(v); v.addEventListener('volumechange', () => { const p = state.dubPlay; if (p && p.videoEl === v && !v.muted) v.muted = true; }); }
    }
    const restarts = isRestart && prev ? (prev.restarts || 0) + 1 : 0;
    state.dubPlay = { seg: tgt.seg, take: tgt.take, src, ctxAt: ctx.currentTime, offset: at, rate, restoreMuted, videoEl: v, restarts, off: 0 };
    if (ui.ovDub) { ui.ovDub.classList.add('on'); ui.ovDub.dataset.take = tgt.take.id; ui.ovDub.dataset.restarts = String(restarts); }
  }
  function stopDubPlay() {
    const p = state.dubPlay;
    if (!p) return;
    state.dubPlay = null;
    try { p.src.stop(); } catch (e) { /* ignore */ }
    if (p.videoEl) p.videoEl.muted = p.restoreMuted;
    if (ui.ovDub) { ui.ovDub.classList.remove('on'); ui.ovDub.dataset.take = ''; }
  }
  // 더빙 칸 (패널 목록 안, 그 자막 바로 아래). 자막 글은 바로 위 줄과 같으므로 다시 쓰지 않는다
  function renderDubBox() {
    const box = ui.dubbox;
    if (!box || !dubModeOn()) return;
    box.textContent = '';
    const r = currentDubRange();
    if (!r) return;
    const seg = dubSegFor(r, false);
    const [i, j] = state.dubRange;
    const L = state.dubLadder, R = state.dubRec, P = state.dubPreview;
    const busy = !!(L || R);
    box.append(el('div', { class: 'st-dub-nav' }, [
      withProps(el('button', { class: 'st-btn st-mini st-dub-prev', onclick: () => moveDubRange(-1) }, '◀ 이전 줄'), { disabled: busy || i <= 0 }),
      withProps(el('button', { class: 'st-btn st-mini st-dub-next', onclick: () => moveDubRange(1) }, '다음 줄 ▶'), { disabled: busy || j >= state.cues.length - 1 }),
      withProps(el('button', { class: 'st-btn st-mini st-dub-grow', title: '다음 줄까지 한 구간으로 (최대 ' + DUB_MAX_LINES + '줄 · 30초)', onclick: () => growDubRange(1) }, '+ 다음 줄 포함'), { disabled: busy || j >= state.cues.length - 1 || j - i >= DUB_MAX_LINES - 1 }),
      j > i ? withProps(el('button', { class: 'st-btn st-mini st-dub-shrink', onclick: () => growDubRange(-1) }, '− 한 줄'), { disabled: busy }) : null,
      el('span', { class: 'st-dub-sp' }),
      infoBtn('dub'),
      el('button', { class: 'st-icon st-dub-close', title: '더빙 모드 끝내기 (R)', onclick: closeDubBox }, '✕'),
    ]));
    // ① 배속 연습 · 반복 배속
    const nowRate = L ? L.rates[L.step] : state.dubLoopRate;
    box.append(el('div', { class: 'st-dub-step' }, [
      el('span', { class: 'st-dub-n' }, '1'),
      withProps(el('button', { class: 'st-btn st-mini st-dub-ladder' + (L ? ' on' : ''), title: '설정한 단계대로 한 번씩: ' + ladderRates().map(rateText).join(' → ') + '배', onclick: runDubLadder }, L ? '◼ 멈춤' : '▶ 배속 연습'), { disabled: !!R }),
    ].concat(dubPracticeRates().map((x) => withProps(el('button', { class: 'st-dub-rate st-dub-play-rate' + (Math.abs(x - nowRate) < 0.005 ? ' on' : ''), 'data-rate': rateText(x), title: rateText(x) + '배속으로 이 구간 반복', onclick: () => setDubLoopRate(x) }, rateText(x)), { disabled: busy })))));
    // ② 녹음 · 녹음 배속
    const recRate = dubRecRate();
    const recLabel = !R ? '● 녹음' : (R.phase === 'count' ? String(R.count) : (R.phase === 'rec' ? '◼ 녹음 중' : (R.phase === 'save' ? '저장 중…' : '마이크…')));
    box.append(el('div', { class: 'st-dub-step' }, [
      el('span', { class: 'st-dub-n' }, '2'),
      withProps(el('button', { class: 'st-btn st-mini st-dub-rec' + (R ? ' on' : ''), title: rateText(recRate) + '배속으로 녹음 (원래 소리는 끄고, 다시 누르면 취소)', onclick: recordDubTake }, recLabel), { disabled: !!L || !!(R && R.phase === 'save') }),
    ].concat(dubRecRates().map((x) => withProps(el('button', { class: 'st-dub-rate st-dub-rec-rate' + (Math.abs(x - recRate) < 0.005 ? ' on' : ''), 'data-rate': rateText(x), title: rateText(x) + '배속으로 녹음' + (x !== 1 ? ' — 저장할 때 원래 속도로 맞춥니다' : ''), onclick: () => setDubRecRate(x) }, rateText(x)), { disabled: busy })))));
    // ③ 녹음 목록 (있을 때만)
    if (seg && seg.takes.length) {
      box.append(el('div', { class: 'st-dub-step' }, [
        el('span', { class: 'st-dub-n' }, '3'),
        el('div', { class: 'st-dub-takes' }, seg.takes.map((t, k) => {
          const chosen = seg.chosen === t.id;
          const pv = !!(P && P.take.id === t.id);
          return el('div', { class: 'st-dub-take' + (chosen ? ' chosen' : ''), 'data-take': t.id }, [
            el('span', { class: 'st-dub-k', text: String(k + 1) }),
            el('span', { class: 'st-dub-len', text: (t.ms / 1000).toFixed(1) + '초' + (t.recRate && t.recRate !== 1 ? ' · ' + rateText(t.recRate) + '배 녹음' : '') + ' · ' + new Date(t.at).toTimeString().slice(0, 5) }),
            withProps(el('button', { class: 'st-btn st-mini st-dub-play' + (pv ? ' on' : ''), onclick: () => previewDubTake(seg, t) }, pv ? '◼' : '▶ 들어보기'), { disabled: busy }),
            el('button', { class: 'st-dub-star' + (chosen ? ' on' : ''), title: chosen ? '더빙 해제' : '이 녹음을 이 구간의 더빙으로 (원래 소리 대신 재생)', onclick: () => chooseDubTake(seg, t) }, chosen ? '★' : '☆'),
            withProps(el('button', { class: 'st-dub-del', title: '이 녹음 지우기', onclick: () => deleteDubTake(seg, t) }, '✕'), { disabled: busy }),
          ]);
        })),
      ]));
    }
    if (box.parentElement) placeDubBox(false);
  }

  // ───────────── 메인 루프 ─────────────
  function tick(fromTimer) {
    if (!state.active) return;
    state.tickCount++;
    if (state.tickCount % 3 === 0) positionOverlay(false);
    const raw = rawMs();
    if (!isFinite(raw)) return;
    const paused = adapter.isPaused();
    const t = raw + effectiveOffset();
    const cues = state.cues;
    const idx = cues.length ? S.findCueIndex(cues, t) : -1;
    const prevIdx = state.prevIdx;
    const capturing = state.capturing;

    if (now() < state.rateReapplyUntil && state.tickCount % 6 === 0) {
      const v = adapter.video();
      if (v && Math.abs(v.playbackRate - state.rate) > 0.01) applyRate(true);
    }
    if (capturing) {
      if (!paused && now() - state.lastSeekAt > 150 && raw !== capturing.lastAnchorRaw) { capturing.anchors.push([wall(), raw]); capturing.lastAnchorRaw = raw; } // 미디어 시계가 멈춘 동안(탐색 대기·버퍼링)의 중복 앵커는 오프셋을 치우치게 하므로 버린다
      // 구간 안에 들어온 뒤에만 '끝'으로 본다: 별표를 누른 순간 재생 위치가 이미 구간 끝을 지나 있으면, 되감기 탐색이 반영되기 전 첫 tick 에서 끝났다고 착각해 0.3초짜리 녹음이 된다
      if (raw >= capturing.startV - 1500 && raw < capturing.endV + 300) capturing.entered = true;
      if ((capturing.entered && raw >= capturing.endV + 300) || raw < capturing.startV - 8000) finishCapturing('done');
    }
    if (idx !== state.current) {
      state.current = idx;
      if (idx >= 0) {
        state.lastShown = idx;
        if (!paused) state.watched.add(idx);
        highlightRow(idx, false);
        ensureTranslations(idx);
        if (!state.clip && !capturing && !paused && (settings.autoPause || settings.shadowing) && !state.loop && !dubBusy()) scheduleEndCheck(idx, t);
      }
    }
    if (idx < 0 && !paused && Math.abs(t - state.lastT) > 1500) state.lastShown = S.lastStartedIndex(cues, t);

    if (state.clip) {
      handleClip(raw, paused);
    } else if (!paused && isEnabled() && !capturing && !dubBusy()) {
      if (state.loop && state.loopIdx >= 0 && cues[state.loopIdx]) {
        const c = cues[state.loopIdx];
        if ((t >= c.end + settings.tailMs - 20 || t < c.start - settings.leadMs - 2500) && now() - state.lastLoopSeekAt > 500) {
          state.lastLoopSeekAt = now();
          state.loopCount++;
          if (settings.loopLadder) { const L = ladderRates(); const r = L[Math.min(L.length - 1, state.loopCount)]; if (Math.abs(r - state.rate) > 0.01) { state.rate = r; applyRate(true); } }
          seekTo(cueVideoMs(c) - settings.leadMs);
          if (settings.koMode === 'afterRepeat') renderOverlay(true);
        }
      } else if ((settings.autoPause || settings.shadowing) && prevIdx >= 0 && prevIdx !== idx && cues[prevIdx]) {
        const ended = cues[prevIdx];
        if (t >= ended.end - 80 && t < ended.end + 1500 && state.pausedFor !== prevIdx) pauseFor(prevIdx);
      } else if ((settings.autoPause || settings.shadowing) && fromTimer && idx >= 0 && cues[idx] && t >= cues[idx].end - 80 && state.pausedFor !== idx) {
        scheduleEndCheck(idx, t);
      }
    }
    if (isEnabled() && dubModeOn()) dubLoopTick(raw, paused);
    if (isEnabled() && (state.dubPlay || state.dubPreview || state.dubSegs.length)) dubTick(raw, paused);
    else if (state.dubPlay) stopDubPlay();
    if (paused !== state.lastPaused) { state.lastPaused = paused; renderOverlay(true); }
    else renderOverlay(false);
    if (state.watched.size && now() - state.statsSavedAt > 20000) saveEpisodeStats(false);
    state.prevIdx = idx;
    state.lastT = t;
  }
  setInterval(() => tick(false), 40);

  // ───────────── 단축키 ─────────────
  // 화면에 보이는 자막(없으면 방금 지나간 자막)을 별표 저장
  function saveShownCue() {
    const shown = displayIndex();
    const i = shown >= 0 ? shown : anchorIndex();
    if (i >= 0) toggleSave(i); else chip('info', '저장할 자막이 없습니다');
  }
  const KEY_ACTIONS = { KeyA: prevCue, KeyS: toggleLoop, KeyD: nextCue, KeyF: replayCue, KeyE: saveShownCue, Enter: saveShownCue, KeyQ: toggleMissed, KeyR: () => toggleDubBox(), KeyV: () => { state.clozeRevealIdx = displayIndex(); renderOverlay(true); }, KeyT: () => { if (!state.koHold) { state.koHold = true; renderOverlay(true); } }, KeyP: () => setMode('autoPause', !settings.autoPause), KeyW: () => setMode('shadowing', !settings.shadowing), Backquote: () => setPanelOpen(!settings.panelOpen), BracketLeft: () => changeRate(-0.1), BracketRight: () => changeRate(0.1), Backslash: () => changeRate(0) };
  // Shift 와 함께: < 한 단계 느리게 · > 한 단계 빠르게. 단계는 설정 › 속도 사다리의 배속을 그대로 쓴다.
  // 유튜브는 Shift+< , Shift+> 가 이미 유튜브 자체 기능이라 건드리지 않는다 (두 번 적용되는 것을 막는다).
  const SHIFT_ACTIONS = RATE_UI ? { Comma: () => stepRate(-1), Period: () => stepRate(1) } : {};
  function keyAction(e) {
    if (e.code === 'Comma' || e.code === 'Period') return (e.shiftKey && SHIFT_ACTIONS[e.code]) || null;
    return KEY_ACTIONS[e.code] || null;
  }
  function shouldHandleKey(e) {
    if (!state.active || !isEnabled()) return false;
    if (!state.cues.length && !/^(Backquote|BracketLeft|BracketRight|Backslash|Comma|Period)$/.test(e.code)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isEditable(e.target) || (e.target && e.target.closest && e.target.closest('#st-panel input, #st-panel select, #st-panel textarea'))) return false;
    if (e.code === 'Enter') return e.target === document.body || e.target === document.documentElement || (e.target && e.target.tagName === 'VIDEO') ? displayIndex() >= 0 : false; // Enter 는 자막이 보일 때, 버튼 등에 포커스가 없을 때만
    return !!keyAction(e);
  }
  window.addEventListener('keydown', (e) => {
    if (!shouldHandleKey(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    const fn = keyAction(e);
    if (fn) fn();
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyT' && state.koHold) { state.koHold = false; renderOverlay(true); }
    if (shouldHandleKey(e)) e.stopImmediatePropagation();
  }, true);
  window.addEventListener('blur', () => { if (state.koHold) { state.koHold = false; renderOverlay(true); } });
  window.addEventListener('keypress', (e) => { if (shouldHandleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

  // ───────────── 시작 ─────────────
  loadSettings().then(() => { checkVideo(); });
})();
