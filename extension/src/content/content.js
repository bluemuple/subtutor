/*
 * SubTutor – 콘텐츠 스크립트 (ISOLATED world)
 * 자막 패널, 영상 위 영어+한국어 자막, 단축키(왼손 묶음 — ⌨ 단축키), 자동 일시정지, 쉐도잉, 자막 저장(+오디오 캡처), 웹사이트 원격 재생.
 */
(() => {
  'use strict';
  if (window.__subtutorContent) return;
  window.__subtutorContent = true;

  const S = globalThis.SubTutorSubs;
  const A = globalThis.SubTutorAdapters;
  const Sites = globalThis.SubTutorSites;   // 사이트 목록 + 자동 녹음 캡슐 판단 (lib/sites.js)
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
    dubListenFirst: false,      // ● 녹음: 먼저 원래 소리(원어민)를 들려준 뒤 녹음
    dubAutoPreview: false,      // 녹음 뒤 내 녹음을 영상에 맞춰 바로 들려주기
    dubAutoNext: false,         // 그다음 자막으로 넘어가 녹음 준비
    dubFeedback: true,          // 더빙 명료도 피드백(실험적): 녹음과 나란히 크롬 음성 인식 → 일치율·속도·멈춤 (근거: lib/explain.js dubFeedback)
    wordSort: 'hard',           // 단어 목록 정렬: hard · easy · easyNoBasic
    leadMs: 150,
    tailMs: 200,
    audioMode: 'off',           // off | store | download | both : 별표 저장 시 오디오 처리
    recAuto: false,             // (예전 스위치) 모든 서비스에서 자동 녹음 — 이제는 아래 캡슐로 고른다 (lib/sites.js recAutoWhy)
    recAutoSites: null,         // 자동 녹음할 서비스 캡슐 ['netflix', 'tvnz', …] — null 이면 아직 안 고름(예전 스위치를 따른다)
    recTitles: [],              // 최근 본 작품 캡슐 [{ site, title, at, on }] — on 이면 그 작품만 자동 녹음 (목록은 서비스 워커가 고친다)
    recAutoSync: true,          // 녹음을 마치면 바로 아이폰으로 올리기 (SubTutor 웹 탭이 올린다)
    saveSentence: true,         // 문장 단위 저장: 자막이 문장 중간에서 끝나면 문장이 끝나는 자막까지 묶어서 저장 (근거: lib/explain.js saveSentence)
    savePick: true,             // 한 자막에 문장이 여러 개면, 저장할 때 영상을 멈추고 어떤 문장을 저장할지 고른다 (뒷문장만도 가능)
    saveTailSec: 4,             // MP3 에 자막 끝 뒤 여유를 담는 초 (0~10) — 웹에서 구간을 늘려도 들을 소리가 파일에 있게
    saveNextTexts: true,        // 다음 자막 3개의 글도 함께 저장 — 웹 구간 조정에서 문장을 한 줄씩 늘릴 수 있게
    enabled: {},                // 플랫폼별 켜기/끄기 { netflix: true, ... }
    // 듣기 훈련 (근거는 lib/explain.js)
    koMode: 'hold',             // always | hold(T 키를 누르는 동안) | afterRepeat(같은 줄 N회 반복 뒤)
    koRepeats: 3,
    secondPass: false,          // 2회차: 못 알아들음(Q) 표시한 줄만 한국어 바로 보임 + 강조
    cloze: 'off',               // off | function | random : 영상 위 자막 빈칸
    soundsLike: false,          // 소리 나는 대로 줄
    kiwiNotes: true,            // 키위·마오리·학교 용어 주석
    nzNotes: true,              // NZ 모음 주석: fish→fush, pen→pin, ear=air 처럼 들리는 단어에 점선 밑줄 (근거: lib/explain.js nzVowels)
    vocabProfile: true,         // 어휘 프로파일·말 속도
    missedTag: '못 알아들음',
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  const state = {
    videoId: null, videoEl: null, active: false, tabId: null,
    cues: [], koCues: [], enTrack: null, koTrack: null, runToken: 0, trackRun: 0,
    current: -1, lastShown: -1, prevIdx: -1, lastT: 0, lastPaused: null, lastDisplayIdx: -2,
    loop: false, loopIdx: -1, lastLoopSeekAt: 0,
    pausedFor: -1, pausedAt: 0, shadowTimer: null, endTimer: null, resumeByUsUntil: 0, pauseByUsUntil: 0, seekByUsUntil: 0, lastSeekAt: 0, lastSeekTarget: NaN, seekingAt: 0, userSeekAt: 0, lastCT: NaN, seekTarget: null, ourSeeksPending: 0, lastEdgeAt: -1e9, freshReportAt: 0, lastPauseEvAt: -1e9, playRequestedAt: 0, ensureTimer: null,
    clip: null, capturing: null,
    saved: new Map(), meta: null,
    offsetMs: 0, offsetSource: '', alignSamples: [], lastNativeText: '',
    userScrollAt: 0, statusText: '', statusErr: false,
    ttPoll: null, tickCount: 0,
    rate: 1, rateReapplyUntil: 0, clearanceCur: 0, clearanceLowSince: 0,
    koHold: false, clozeRevealIdx: -1, loopCount: 0, loopBaseRate: 1, loopLadderOn: false, pickOpen: null, profile: null, watched: new Set(), missed: new Set(), statsSavedAt: 0, seriesSaved: false,
    dubSegs: [], dubRange: [0, 0], dubBoxFor: -1, dubRec: null, dubLadder: null, dubPreview: null, dubPlay: null, dubMic: null, dubLoopRate: 1, dubPrevRate: 1, // 더빙
  };
  const Sp = globalThis.SubTutorSpeech, Voc = globalThis.SubTutorVocab, Ex = globalThis.SubTutorExplain, Kiwi = globalThis.SubTutorKiwi || [], Freq = globalThis.SubTutorFreq || '', NZV = globalThis.SubTutorNZVowels;
  const trackCache = new Map(); // videoId -> tracks
  let pageVideoId = null;
  let pageMeta = null;
  let masterUrlPending = null;
  const ui = {};

  // ───────────── 유틸 ─────────────
  const now = () => performance.now();
  const wall = () => performance.timeOrigin + performance.now();
  // 더빙 진단 기록: 더빙이 끊기거나 깜빡이면 ⚙ › 진단 정보로 최근 기록(재생 위치·플레이어 보고·영상 이벤트·더빙을 켜고 끈 까닭)을 복사해 보낼 수 있다
  const dlog = [];
  let dlLast = '';
  function dl(msg) { dlog.push([now(), msg]); dlLast = msg; if (dlog.length > 2000) dlog.splice(0, dlog.length - 1500); }
  function dlOnce(msg) { if (msg !== dlLast) dl(msg); } // 틱마다 같은 줄이 쌓이지 않게
  function dlogText(sec) {
    const end = now(), from = end - sec * 1000;
    return dlog.filter(([t]) => t >= from).map(([t, m]) => ((t - end) / 1000).toFixed(2).padStart(7) + ' ' + m).join('\n');
  }
  const fx = (x, d) => (Number.isFinite(x) ? x.toFixed(d || 0) : '-');
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
    // patch 만 보낸다 — 이 탭의 스냅샷으로 통째 저장하면 다른 탭·웹·테스트가 막 바꾼 설정을 옛값으로 되덮는다
    bg({ type: 'settings.set', patch }).catch(() => chrome.storage.local.set({ settings }).catch(() => {}));
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
      if (['koMode', 'secondPass', 'cloze', 'soundsLike', 'kiwiNotes', 'nzNotes', 'vocabProfile'].some((k) => prev[k] !== s[k])) { renderList(); renderOverlay(true); if (prev.vocabProfile !== s.vocabProfile) refreshProfileStatus(); }
    }
    if (changes.items) loadSaved();
    if (changes.words && state.wordView) { const before = savedWords; loadSavedWords().then(() => updateWordCells([...new Set([...before, ...savedWords])].filter((w) => before.has(w) !== savedWords.has(w)))); }
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'status':
        sendResponse({ platform: adapter.name, label: adapter.label, generic: !!adapter.generic, custom: !!adapter.custom, videoId: state.videoId, ready: isPlayerReady(), cues: state.cues.length, title: state.meta && state.meta.title, enabled: isEnabled(), offsetMs: state.offsetMs });
        break;
      case 'playRange': startClip(msg); sendResponse({ ok: true }); break;
      case 'stopClip': stopClip('stopped'); sendResponse({ ok: true }); break;
      case 'clipLoop': if (state.clip) state.clip.loop = !!msg.loop; sendResponse({ ok: true }); break;
      case 'seekTo': cancelModesPending(); playFrom(msg.ms, msg.play === false); sendResponse({ ok: true }); break;
      case 'togglePanel': setPanelOpen(!settings.panelOpen); sendResponse({ ok: true }); break;
      case 'setEnabled': setEnabled(!!msg.enabled); sendResponse({ ok: true }); break;
      case 'popupOpened': onPopupOpened(); sendResponse({ ok: true, pending: false }); break;
      case 'invoke': sendResponse(onInvoke(msg)); break;
      case 'rec.saved': {
        recEndUi();
        const r = msg.result || {};
        toast(r.ok ? '⏹ 영상 오디오 MP3 저장: ' + (r.location === 'folder' ? r.fileName : '다운로드 폴더/' + r.fileName) + ' (' + fmtMinSec(r.durMs) + ')' : '영상 오디오 저장 실패: ' + (r.error || ''), 9000);
        sendResponse({ ok: true });
        break;
      }
      case 'dubAt': dubAt(msg.ms).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })); return true;
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
      case 'master': onMaster(d.url, d); break;
      case 'dash': onDash(d); break;
      case 'meta':
        if (adapter.generic) { if (d.meta && d.meta.title && forThisVideo(d)) { pageMeta = d.meta; setMeta(d.meta); } break; }
        if (d.meta && d.meta.title && (!d.videoId || d.videoId === state.videoId)) { pageMeta = d.meta; setMeta(d.meta); }
        break;
      case 'time': {
        const v = adapter.usesPageTime ? adapter.video() : null;
        // 재생 중인지는 영상 요소로 본다. 플레이어의 '재생 중' 이벤트(MEDIA_RESUMED 등)는 실제 디즈니+ 에서 오지 않는다(진단 기록: 재생 이벤트 0번).
        // 예전에는 그 이벤트만 믿어 시계가 0.5초 계단이 됐고, 더빙이 보고 사이마다 "멈춤"으로 보여 0.4초 틀고 0.1초 끄기를 되풀이했다
        const playing = !!(v && !v.paused && !v.seeking && v.readyState >= 2);
        const ctNow = v ? v.currentTime * 1000 : NaN;
        const ctAt = Number.isFinite(d.ct) && Math.abs(d.ct - ctNow) < 400 ? d.ct : ctNow; // 위치가 바뀐 순간 페이지 쪽에서 함께 읽은 영상 시각 (같은 영상 요소일 때만)
        // 우리가 옮긴 탐색이 끝나기 전, 그리고 끝난 직후 0.6초 동안 목표에서 2초 넘게 떨어진 보고는 옮기기 전의 낡은 위치다
        // (진단 기록: 79.85초로 옮긴 뒤 83.6초 보고) → 버린다. 그 뒤에도 먼 보고는 사용자가 다른 곳으로 옮긴 것이므로 받아들인다
        const tgt = state.seekTarget;
        const fresh = tgt && (tgt.doneAt ? now() - tgt.doneAt < 600 : now() - tgt.at < 2500);
        if (adapter.usesPageTime && fresh && Number.isFinite(d.ms) && Math.abs(d.ms - tgt.ms) > 2000) { dl('time(stale) ms=' + fx(d.ms) + ' target=' + fx(tgt.ms) + ' ct=' + fx(ctAt)); break; }
        A.shared.pageTime = { ms: d.ms, at: now(), advancing: !!d.advancing || playing };
        if (v && !v.seeking) state.freshReportAt = now(); // 탐색이 끝난 뒤의 보고 — 어림 시계는 이것부터 믿는다 (진단 기록: 탐색이 끝난 순간의 값이 이미 정확)
        if (d.evc) A.shared.pageEv = d.evc;
        // 영상 시각과 콘텐츠 시간의 차이(정밀 시계)는 재생 중, 위치 값이 바뀐 순간의 보고(edge)로만 잰다 — 0.5초 간격 보고는 계단 하나만큼 늦을 수 있다.
        // 그런 보고가 2초 넘게 없으면(위치가 매끈하게 바뀌는 플레이어) 아무 보고나 쓴다
        if (d.edge) state.lastEdgeAt = now();
        let note = '';
        if (adapter.usesPageTime && playing && Number.isFinite(d.ms) && (d.edge || now() - state.lastEdgeAt > 2000)) note = A.noteContentTime(d.ms, ctAt, now());
        if (adapter.usesPageTime) { const m = A.shared.ctMap; dl('time' + (d.edge ? '* ' : ' ') + 'ms=' + fx(d.ms) + ' ct=' + fx(ctAt) + ' k=' + fx(m.k) + '/' + m.samples.length + (note ? ' ' + note : '') + (playing ? '' : ' (not playing)')); }
        break;
      }
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
      if (active) { state.activeAt = now(); mountUI(); applySettings(); registerPlayer(); }
      else { cancelModesPending(); closeDubBox(); stopDubPlay(); state.loop = false; state.loopIdx = -1; if (ui.root) { ui.overlay.classList.add('st-hidden'); applySettings(); } }
    }
    if (active) { ensureOverlayMounted(); mountControlButton(); if (adapter.deep && (state.tickCount % 4 === 0)) syncShadowNativeStyles(); }
    if (adapter.generic) syncFloatToggle();
    if (ui.root) { syncPanelWidth(); fitVideoBesidePanel(); }
  }
  function startVideo(id) {
    if (recFull.on) recToggle();     // 에피소드가 바뀌면 담던 영상 오디오를 저장하고
    recFull.autoFor = null;          // 자동 녹음이 새 에피소드에서 다시 시작하게
    state.runToken++;
    state.trackRun++;
    state.videoId = id;
    state.cues = []; state.koCues = []; state.enTrack = null; state.koTrack = null;
    state.current = -1; state.lastShown = -1; state.prevIdx = -1; state.lastDisplayIdx = -2;
    state.loop = false; state.loopIdx = -1; state.pausedFor = -1; state.clip = null; state.capturing = null;
    state.saved = new Map(); state.known = new Map(); state.meta = null; state.offsetMs = 0; state.offsetSource = ''; state.alignSamples = []; state.lastNativeText = '';
    clearShadow(); clearEndTimer(); stopTextTrackPoll(); clearTimeout(state.ensureTimer);
    closeDubBox(); stopDubPlay(); closeWordView();
    state.dubSegs = [];
    dubBuffers.clear(); dubReady.clear(); dubBroken.clear();
    state.pageTracks = []; state.videoStartedWall = Date.now(); clearTimeout(state.pageTracksTimer);
    if (adapter.generic) A.shared.dash = null; // 광고 기간 표는 영상마다 (새 MPD 가 오면 다시 만든다)
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
  const attachedVideos = new WeakSet();
  function attachVideo(v) {
    state.videoEl = v;
    if (!v) return;
    { const all = A.qsaDeep('video'); dl('video attached ' + (all.indexOf(v) + 1) + '/' + all.length + ' ' + describeEl(v) + ' rs=' + v.readyState); }
    if (attachedVideos.has(v)) { registerPlayer(); return; } // 같은 영상 요소에 감시를 두 번 붙이지 않는다
    attachedVideos.add(v);
    // 진단 기록: 영상 요소 이벤트 (더빙이 끊길 때 플레이어가 무엇을 했는지 보려고)
    ['play', 'pause', 'waiting', 'playing', 'seeked', 'ratechange', 'volumechange', 'emptied', 'stalled'].forEach((type) => v.addEventListener(type, () => {
      dl('ev ' + type + ' ct=' + fx(v.currentTime * 1000) + ' rs=' + v.readyState + (type === 'volumechange' ? ' muted=' + (v.muted ? 1 : 0) + ' vol=' + fx(v.volume, 2) + (state.dubPlay ? ' (dub)' : '') : '') + (type === 'ratechange' ? ' rate=' + v.playbackRate : ''));
    }));
    v.addEventListener('play', () => {
      if (now() < state.resumeByUsUntil) { state.resumeByUsUntil = 0; return; }
      // 사용자가 직접 재생을 눌렀다: 쉐도잉 대기/자동 일시정지 상태를 푼다
      state.holding = false;
      if (state.shadowTimer || state.pausedFor >= 0) { clearShadow(); state.pausedFor = -1; }
    });
    v.addEventListener('pause', () => {
      state.lastPauseEvAt = now();
      // 우리가 play() 를 건 직후의 pause 는 플레이어의 되돌림이므로 재시도를 유지하고, 그 밖의 pause 는 사용자의 뜻으로 보고 재시도를 멈춘다
      if (now() - state.playRequestedAt > 400 && now() > state.pauseByUsUntil) clearTimeout(state.ensureTimer);
    });
    v.addEventListener('seeking', () => {
      // 스트리밍 플레이어는 재생 중에 스스로 아주 작게 위치를 고친다(버퍼 틈 건너뛰기 등). 사람이 옮긴 것이 아니므로 아무것도 건드리지 않는다
      // (이것을 탐색으로 보면 그때마다 더빙을 멈췄다가 다시 튼다)
      const jump = Number.isFinite(state.lastCT) ? Math.abs(v.currentTime - state.lastCT) : Infinity;
      // 우리가 옮긴 탐색인가: 디즈니+ 는 우리 탐색 한 번에 seeking 이 한 번 온다 → 우리가 요청한 횟수만큼만 우리 것으로 센다
      // (바로 뒤에 사용자가 옮긴 것을 우리 것으로 착각하면, 낡은 보고를 거르는 기준이 남아 시계가 2초 넘게 어긋났다)
      if (now() >= state.seekByUsUntil) state.ourSeeksPending = 0;
      const ours = now() < state.seekByUsUntil && (!adapter.usesPageTime || state.ourSeeksPending > 0);
      if (state.ourSeeksPending > 0) state.ourSeeksPending--;
      if (adapter.usesPageTime) {
        // 디즈니+: 탐색할 때마다 영상 시각이 20초에서 다시 시작해 시각의 차이로는 얼마나 옮겼는지 알 수 없고, 콘텐츠 시간과의 차이도 바뀐다 → 차이를 새로 잰다.
        // 디즈니+ 의 탐색은 늘 멈춤(pause) 바로 뒤에 온다(진단 기록). 우리 탐색도, 0.75초 넘게 움직인 것도, 멈춤 뒤도 아니면 플레이어 안쪽의 작은 조정으로 보고 건드리지 않는다
        if (!ours && jump < 0.75 && now() - state.lastPauseEvAt > 300) { dl('ev seeking ct=' + fx(v.currentTime * 1000) + ' jump=' + fx(jump * 1000) + ' micro(ignored)'); return; }
        dl('ev seeking ct=' + fx(v.currentTime * 1000) + ' jump=' + fx(jump * 1000) + ' ' + (ours ? 'ours' : 'user') + ' (clock re-measured)');
        A.resetContentTime();
        if (dubClock) dubClock.reset();
      } else {
        dl('ev seeking ct=' + fx(v.currentTime * 1000) + ' jump=' + fx(jump * 1000) + ' ' + (jump < 0.75 ? 'small(ignored)' : ours ? 'ours' : 'user'));
        if (jump < 0.75) return;
      }
      state.seekingAt = now(); // 디즈니+ 는 이 뒤 새 위치를 알려 줄 때까지 예전 위치가 남는다 (dubTick 참고)
      if (ours) return;
      state.seekTarget = null; // 사용자가 플레이어에서 직접 옮겼다 — 우리가 옮긴 목표는 더 이상 기준이 아니다
      state.holding = false;
      state.lastSeekAt = now();
      clearShadow(); state.pausedFor = -1;
      clearTimeout(state.ensureTimer); // 사용자가 직접 옮겼으면, 우리가 걸어 둔 "그 자리에서 재생되는지 확인" 재시도가 다시 끌고 가지 않게 한다
      // 더빙: 옮긴 순간 지금 소리를 멈추고 시계를 새로 잰다 (디즈니+ 는 새 위치를 조금 늦게 알려 준다 → 아래 dubTick 에서 기다린다)
      state.userSeekAt = now();
      stopDubPlay('seek');
      if (dubClock) dubClock.reset();
    });
    // 디즈니+: 우리가 옮긴 탐색이 끝나면 새 시계가 잡힐 때까지는 목표 위치에서부터 센다 (시작 시각을 탐색이 끝난 순간으로)
    v.addEventListener('seeked', () => {
      const t = state.seekTarget;
      if (!adapter.usesPageTime || !t || now() - t.at > 3000) return;
      if (!t.doneAt) t.doneAt = now();
      if (!A.preciseClock()) A.shared.pageTime = { ms: t.ms, at: now(), advancing: false };
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
    if (adapter.generic && d.platform === 'generic' && Array.isArray(d.tracks)) { mergePageTracks(d.tracks.filter((t) => forThisVideo(t))); return; }
    if (d.platform !== adapter.name || !Array.isArray(d.tracks)) return;
    const vid = d.videoId || currentVideoId();
    if (!vid) return;
    trackCache.set(vid, d.tracks);
    if (vid === state.videoId) applyTracks(d.tracks);
  }
  // ───────── 범용 사이트: 페이지 스크립트가 잡은 자막 모으기 ─────────
  // 페이지 스크립트는 받은 것마다 그 순간의 주소(href)를 붙여 보낸다. 지금 영상의 주소에서 받은 것만 쓴다.
  // 영상 주소가 아닌 곳(작품 페이지 등)에서 미리 받아 둔 것은 이 영상을 연 앞뒤 15초 안에 받은 것만 쓴다
  function forThisVideo(d) {
    if (!d || !state.videoId) return false;
    let vid = null;
    try { vid = d.href ? adapter.videoIdFromUrl(d.href) : state.videoId; } catch (e) { vid = null; }
    if (vid) return vid === state.videoId;
    return Number.isFinite(d.at) && Math.abs(d.at - (state.videoStartedWall || 0)) < 15000;
  }
  const langOf = (t) => String((t && t.lang) || '').toLowerCase().split(/[-_]/)[0];
  // 같은 트랙은 하나로 (DASH 자막은 재생 목록을 다시 받으면 주소의 세션 값만 바뀌므로 언어·역할·이름으로 묶는다)
  function mergePageTracks(list) {
    let changed = false;
    for (const t of list || []) {
      if (!t || !(t.url || t.text || t.dash)) continue;
      const id = t.id || t.url;
      const i = state.pageTracks.findIndex((x) => x.id === id);
      if (i >= 0) { if ((t.text && !state.pageTracks[i].text) || t.dash) { state.pageTracks[i] = Object.assign({}, state.pageTracks[i], t, { id }); } continue; }
      state.pageTracks.push(Object.assign({}, t, { id }));
      changed = true;
    }
    if (!changed) return;
    clearTimeout(state.pageTracksTimer);
    state.pageTracksTimer = setTimeout(applyPageTracks, 400); // 여러 곳에서 잇달아 오므로 잠깐 모았다가 고른다
  }
  function applyPageTracks() {
    const all = state.pageTracks.slice();
    if (!all.length) return;
    // 언어를 모르는 자막('und')은 영어 자막이 따로 없을 때만 영어로 본다
    const hasEn = all.some((t) => langOf(t) === 'en');
    const list = all.map((t) => (!hasEn && langOf(t) === 'und' ? Object.assign({}, t, { lang: 'en' }) : t));
    const en = pickTrack(list, 'en'), ko = pickTrack(list, 'ko');
    // 이미 같은 영어 트랙으로 보여 주고 있으면, 한국어 트랙이 새로 생긴 경우에만 다시 불러온다
    if (state.cues.length && state.enTrack && en && en.id === state.enTrack.id && (!ko || (state.koTrack && state.koTrack.id === ko.id))) return;
    trackCache.set(state.videoId, list);
    applyTracks(list);
  }
  // DASH 재생 목록(MPD): 광고 기간을 뺀 본편 시간 표를 어댑터에 주고, 자막 세트를 트랙으로
  let pendingDash = null;
  function onDash(d) {
    if (!adapter.generic || !d || typeof d.text !== 'string') return;
    if (!forThisVideo(d)) { pendingDash = d; return; }
    let mpd;
    try { mpd = S.parseMPD(d.text, d.url); } catch (e) { dl('mpd parse failed: ' + (e && e.message)); return; }
    A.shared.dash = mpd.map.length ? { map: mpd.map, hasAds: mpd.hasAds, url: d.url, periods: mpd.periods.length } : null;
    dl('mpd periods=' + mpd.periods.length + ' content=' + mpd.map.length + ' ads=' + mpd.hasAds + ' text=' + mpd.textTracks.map((t) => t.lang + '/' + t.codecs + '/' + (t.url ? 'file' : t.parts.reduce((a, p) => a + p.segUrls.length, 0))).join(','));
    mergePageTracks(mpd.textTracks.map((t) => ({ id: 'dash:' + t.lang + ':' + t.role + ':' + t.label, lang: t.lang, label: t.label || t.lang, cc: /caption/i.test(t.role + ' ' + t.label), dash: t, format: t.codecs, href: d.href, at: d.at })));
  }
  // <video> 의 <track> 요소 (Vimeo 등): 파일 주소가 있으면 통째로 받는다
  function trackElementTracks() {
    const v = adapter.video();
    if (!v) return [];
    return Array.from(v.querySelectorAll('track[src]')).filter((t) => /captions|subtitles/i.test(t.kind || 'subtitles')).map((t) => ({ id: t.src, url: t.src, lang: String(t.srclang || '').toLowerCase() || 'und', label: t.label || t.srclang || '', cc: t.kind === 'captions', format: /\.srt(?:[?#]|$)/i.test(t.src) ? 'srt' : 'vtt' }));
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
  // 바이너리(MP4 자막 조각): 페이지 출처로 받고(CORS), 안 되면 서비스 워커로
  async function fetchBytes(url) {
    try {
      const r = await page.request({ type: 'fetchBytes', url }, 25000);
      if (r && r.ok && r.bytes && r.bytes.byteLength !== undefined) return new Uint8Array(r.bytes);
      throw new Error((r && r.error) || 'page fetch failed');
    } catch (e) {
      const r = await bg({ type: 'fetch.bytes', url });
      if (r && typeof r.b64 === 'string' && globalThis.SubTutorAudio) return globalThis.SubTutorAudio.base64ToBytes(r.b64);
      throw new Error('fetch failed: ' + (e && e.message));
    }
  }
  async function loadTrackCues(track) {
    if (track.dash) return loadDashCues(track.dash);
    if (typeof track.text === 'string' && track.text) return S.parseAny(track.text, track.format).cues; // 페이지 스크립트가 플레이어 응답에서 이미 읽어 둔 파일
    if (Array.isArray(track.urls)) {
      const texts = await mapLimit(track.urls, 6, (u) => fetchText(u));
      return S.parseSegments(texts, track.format).cues;
    }
    const text = await fetchText(track.url);
    return S.parseAny(text, track.format).cues;
  }
  // DASH 자막: 본편 기간마다 조각(wvtt·stpp)을 받아 큐로 만들고, 조각의 미디어 시각을 본편 시간으로 옮긴다 (TVNZ+ 는 6초 조각 200여 개)
  async function loadDashCues(t) {
    if (t.url) {
      const off = (t.urlContentStart || 0) * 1000;
      return S.parseAny(await fetchText(t.url), t.codecs).cues.map((c) => ({ start: c.start + off, end: c.end + off, text: c.text }));
    }
    const total = t.parts.reduce((a, p) => a + p.segUrls.length, 0);
    let done = 0;
    const all = [];
    for (const part of t.parts) {
      const init = part.initUrl ? await fetchBytes(part.initUrl).catch(() => null) : null;
      const segs = await mapLimit(part.segUrls, 8, async (u) => {
        const b = await fetchBytes(u).catch(() => null);
        if (++done % 25 === 0 && !state.cues.length) setStatus('자막 조각 받는 중… ' + done + '/' + total);
        return b;
      });
      const off = (part.contentStart - part.pto) * 1000; // 조각의 미디어 시각 → 본편 시간
      for (const c of S.parseMp4Text(segs.filter(Boolean), init, { timescale: part.timescale, codecs: t.codecs })) all.push({ start: c.start + off, end: c.end + off, text: c.text });
    }
    return S.finalizeCues(S.mergeSplitCues(all));
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
    if (adapter.generic) {
      // 범용 사이트: 페이지 스크립트가 지금까지 잡은 것(재생 목록·자막 파일) + <track> 요소. 더 오면 그때마다 모은다
      try {
        const r = await page.request({ type: 'getTracks' }, 4000);
        if (token !== state.runToken) return;
        if (r && r.dash) onDash(r.dash);
        if (r && r.master) onMaster(r.master.url, r.master);
        if (r && Array.isArray(r.tracks)) mergePageTracks(r.tracks.filter((t) => forThisVideo(t)));
      } catch (e) { /* 페이지 스크립트가 아직 없음 */ }
      if (pendingDash && forThisVideo(pendingDash)) { const d = pendingDash; pendingDash = null; onDash(d); }
      mergePageTracks(trackElementTracks());
      setTimeout(() => { if (token === state.runToken && !state.cues.length) fallbackTracks(vid, token); }, 7000);
      return;
    }
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
    if (adapter.generic) {
      // 범용 사이트: 그사이 생긴 <track> 요소 → 플레이어의 텍스트 트랙(꺼져 있으면 숨김 상태로 켜서 큐를 받는다)
      mergePageTracks(trackElementTracks());
      if (state.pageTracks.length) return;
      if (tryTextTracks()) return;
      setStatus('이 영상에서 아직 자막을 찾지 못했습니다. 플레이어에서 자막(CC)을 켜거나 새로고침해 보세요.', true);
      startTextTrackPoll();
      return;
    }
    if (adapter.supportsTextTracks && tryTextTracks()) return;
    setStatus(adapter.name === 'youtube' ? '이 영상에는 자막 트랙이 없습니다.' : '자막을 아직 못 찾았습니다. 플레이어에서 자막을 영어로 켜 보세요.', true);
    if (adapter.supportsTextTracks) startTextTrackPoll();
  }
  function readTextTrackCues() {
    const v = adapter.video();
    if (!v || !v.textTracks) return null;
    // 범용 사이트: 꺼진(disabled) 영어 트랙은 큐를 받지 않으므로 '숨김'으로 켠다 (화면에는 그대로 안 보인다)
    if (adapter.generic) for (const tt of v.textTracks) { const l = String(tt.language || '').toLowerCase(); if (tt.mode === 'disabled' && /captions|subtitles/.test(tt.kind) && (!l || l.startsWith('en'))) { try { tt.mode = 'hidden'; } catch (e) { /* ignore */ } } }
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
      if (adapter.generic && !state.cues.length) { const fresh = trackElementTracks().filter((t) => !state.pageTracks.some((x) => x.id === t.id)); if (fresh.length) { mergePageTracks(fresh); return; } }
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

  async function onMaster(url, d) {
    if (!(adapter.name === 'disney' || adapter.generic) || !url || url === masterUrlPending) return;
    if (adapter.generic && !forThisVideo(d)) return;
    masterUrlPending = url;
    const token = state.runToken;
    try {
      if (!state.cues.length) setStatus('자막 목록 읽는 중…');
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
      if (adapter.generic) { mergePageTracks(tracks); return; }
      const vid = state.videoId || currentVideoId();
      if (vid) trackCache.set(vid, tracks);
      applyTracks(tracks);
    } catch (e) {
      if (token === state.runToken && !state.cues.length) setStatus('자막 목록을 읽지 못했습니다: ' + (e && e.message), true);
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
      const all = (res && res.items) || [];
      state.saved = new Map(all.filter((it) => it.box !== 'known').map((it) => [it.id, it]));
      state.known = new Map(all.filter((it) => it.box === 'known').map((it) => [it.id, it]));   // 별표를 해제해 "알고 있는 표현"으로 보낸 것들
      state.missed = new Set(all.filter((it) => it.missed).map((it) => it.id));
      refreshSavedMarks();
      renderOverlay(true);
    } catch (e) { /* ignore */ }
  }
  function buildItem(c, i, pick) {
    const meta = state.meta || adapter.domTitle() || {};
    // 문장 단위 저장: 이 자막이 문장 중간에서 끝나면(쉼표·구두점 없음) 문장이 끝나는 자막까지 묶는다.
    // 저장할 문장을 골랐으면(pick) 마지막 문장을 골랐을 때만 다음 자막으로 이어 본다 — 중간 문장에서 끝났으면 거기까지가 선택이다
    // pick: { text, tail } — 고른 문장들(tail: 자막의 마지막 문장까지 골랐는가). 없으면 자막 전부
    const mayExtend = settings.saveSentence !== false && (!pick || pick.tail);
    const headText = pick ? pick.text : c.text;
    const last = mayExtend && !Sp.sentenceComplete(headText) ? Sp.sentenceEnd(state.cues, i, 3) : i;
    const span = state.cues.slice(i, last + 1);
    const part = (x) => ({ text: x.text, startMs: Math.round(cueVideoMs(x)), endMs: Math.round(cueVideoEndMs(x)) });
    const ko = span.map((x) => koFor(x) || x.koTrack || x.koMt || '').filter(Boolean).join('\n');
    return {
      id: itemIdFor(c), platform: adapter.name, videoId: state.videoId, url: adapter.pageUrl(state.videoId),
      title: meta.title || (adapter.label + ' ' + state.videoId), episode: meta.episode || '',
      startMs: Math.round(cueVideoMs(c)), endMs: Math.round(cueVideoEndMs(state.cues[last])), subStartMs: c.start, offsetMs: effectiveOffset(),
      text: [headText].concat(span.slice(1).map((x) => x.text)).join('\n'),
      parts: span.map((x, k) => Object.assign(part(x), k === 0 ? { text: headText } : null)),                                                                        // 묶인 자막 경계 — 웹에서 한 줄씩 뺄 수 있게 (첫 칸은 고른 문장)
      next: settings.saveNextTexts !== false ? state.cues.slice(last + 1, last + 4).map(part) : [], // 다음 자막 글 — 웹에서 한 줄씩 더할 수 있게
      translation: ko, translationSource: span.some((x) => x.koTrack) ? 'track' : (span.some((x) => x.koMt) ? 'mt' : ''),
      prevText: state.cues[i - 1] ? state.cues[i - 1].text : '', nextText: state.cues[last + 1] ? state.cues[last + 1].text : '',
      savedAt: Date.now(), box: 'learning', comment: '', reviews: 0, forgot: 0,
    };
  }
  // 저장 순간의 장면 썸네일 (가로 150px JPEG, 4~8KB). 보호된 재생(DRM)은 디코더가 픽셀을 주지 않아
  // 검게 나오거나 막히므로(크기를 줄여도 같다) 조용히 건너뛴다. CORS 없는 다른 출처 mp4 도 canvas 가 잠겨 건너뛴다
  function captureThumb() {
    try {
      const v = adapter.video();
      if (!v || !v.videoWidth || v.readyState < 2) return null;
      const w = 150, h = Math.max(2, Math.round((v.videoHeight / v.videoWidth) * 150));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(v, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let lit = 0;
      for (let k = 0; k < d.length; k += 64) if (d[k] + d[k + 1] + d[k + 2] > 24) lit++;
      if (lit < (d.length / 64) * 0.02) return null;   // 사실상 전부 검정 — 버린다
      return cv.toDataURL('image/jpeg', 0.6);
    } catch (e) { return null; }
  }

  async function toggleSave(i) {
    const c = state.cues[i];
    if (!c) return;
    const id = itemIdFor(c);
    try {
      if (state.saved.has(id)) {
        // 별표 해제: 지우지 않고 "알고 있는 표현"으로 옮긴다 — 소리·태그·썸네일은 그대로 (완전히 지우려면 웹 목록에서)
        const it = state.saved.get(id);
        state.saved.delete(id);
        it.box = 'known';
        state.known.set(id, it);
        refreshSavedMarks(); renderOverlay(true);
        await bg({ type: 'items.update', id, patch: { box: 'known', boxAt: Date.now() } });
        chip('known', '알고 있는 표현으로 옮겼습니다 — 다시 ★ 누르면 학습으로');
      } else if (state.known.has(id)) {
        // 알고 있는 표현에 있던 자막을 다시 별표: 학습으로 되돌린다
        const it = state.known.get(id);
        state.known.delete(id);
        it.box = 'learning';
        state.saved.set(id, it);
        refreshSavedMarks(); renderOverlay(true);
        await bg({ type: 'items.update', id, patch: { box: 'learning', boxAt: Date.now() } });
        chip('saved', '다시 학습 목록으로');
      } else {
        const picked = await pickSentences(i); // 문장이 여러 개면 영상을 멈추고 고른다 (아니면 바로 null)
        if (picked === false) return;          // 취소
        const item = buildItem(c, i, picked);
        const thumb = captureThumb();   // 이 장면의 작은 썸네일 (DRM·프레임 없음이면 없음)
        if (thumb) item.thumb = thumb;
        state.saved.set(id, item);
        refreshSavedMarks(); renderOverlay(true);
        await bg({ type: 'items.save', item });
        chip('saved', '저장했습니다' + (settings.audioMode !== 'off' ? ' · 오디오 녹음 준비' : ''));
        if (!item.translation) {
          bg({ type: 'translate', texts: [item.text.replace(/\n/g, ' ')], from: 'en', to: 'ko' }).then((res) => {
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
  // 저장할 문장 고르기: 한 자막에 문장이 2개 이상이면 영상을 멈추고 체크로 고른다 (기본 전부, 뒷문장만도 가능)
  // 돌려주는 값: null = 전부(그대로) · false = 취소 · { text, tail } = 고른 문장들
  function pickSentences(i) {
    const c = state.cues[i];
    if (settings.savePick === false || !c) return Promise.resolve(null);
    const sents = Sp.sentenceSplit(c.text);
    if (sents.length < 2) return Promise.resolve(null);
    return new Promise((resolve) => {
      closePickBox();
      const v = adapter.video();
      const wasPlaying = !!(v && !v.paused);
      adapter.pause();
      const boxes = sents.map((t, k) => el('label', { class: 'st-pick-row' }, [el('input', { type: 'checkbox', checked: true, 'data-k': k }), el('span', null, t)]));
      const finish = (val) => {
        closePickBox();
        state.pickOpen = null;
        if (wasPlaying) requestPlay(); // 멈춘 상태(autoPause 등) 추적까지 함께 푼다
        resolve(val);
      };
      const okBtn = el('button', { class: 'st-btn st-primary st-pick-ok', onclick: () => {
        const on = boxes.map((b) => b.querySelector('input').checked);
        if (!on.some(Boolean)) { toast('문장을 하나는 골라야 합니다'); return; }
        if (on.every(Boolean)) { finish(null); return; }
        finish({ text: sents.filter((_, k) => on[k]).join(' '), tail: on[sents.length - 1] });
      } }, '저장 (Enter)');
      const cancelBtn = el('button', { class: 'st-btn st-pick-cancel', onclick: () => finish(false) }, '취소 (Esc)');
      const box = el('div', { class: 'st-pick' }, [
        el('div', { class: 'st-pick-head' }, ['이 자막엔 문장이 ' + sents.length + '개 — 저장할 문장을 고르세요', infoBtn('savePick')]),
        el('div', { class: 'st-pick-list' }, boxes),
        el('div', { class: 'st-pick-btns' }, [okBtn, cancelBtn]),
      ]);
      state.pickOpen = { box, ok: () => okBtn.click(), cancel: () => cancelBtn.click() };
      const row = ui.rows && ui.rows[i];
      if (row && row.parentNode) row.after(box); else (ui.list || document.body).append(box);
      box.scrollIntoView({ block: 'nearest' });
    });
  }
  function closePickBox() {
    document.querySelectorAll('.st-pick').forEach((b) => b.remove());
  }
  function refreshSavedMarks() {
    if (!ui.rows) return;
    for (let i = 0; i < ui.rows.length; i++) {
      const c = state.cues[i];
      const id = c && itemIdFor(c);
      const saved = c && state.saved.has(id);
      const known = c && state.known.has(id);
      const missed = c && state.missed.has(id);
      ui.rows[i].classList.toggle('saved', !!saved);
      ui.rows[i].classList.toggle('known-mark', !!known);     // 별표 해제로 "알고 있는 표현"에 둔 줄: 초록 ☆
      ui.rows[i].classList.toggle('missed-star', !!missed);   // Q: 빨간 별 (오디오 없이 표시만)
      const star = ui.rows[i].lastElementChild;
      if (star) {
        star.textContent = saved ? '★' : '☆';
        star.title = missed ? '못 알아들음 (Q 로 해제) — 오디오 없이 표시만'
          : known ? '알고 있는 표현에 있음 — ★ 누르면 다시 학습으로' : '저장 (E)';
      }
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
    // 묶어 저장한 문장은 끝 자막까지, 그 뒤에 "꼬리 여유"를 더 담는다 — 웹에서 구간을 늘려도 들을 소리가 파일에 있게 (기본 재생은 자막 구간까지)
    const tail = Math.round(clamp(+settings.saveTailSec || 0, 0, 10) * 1000);
    const startV = item.startMs, endV = item.endMs + tail;
    const mode = settings.audioMode;
    let result;
    chip('rec', '대사 오디오 녹음 중…', 0);
    // DRM 없는 사이트는 영상 요소에서 바로 녹음한다 — 확장 프로그램 아이콘을 누르는(허용) 단계가 필요 없다.
    // 보호된 재생이라 무음이거나 캡처가 막히면 그 영상은 탭 캡처(탭마다 한 번 허용)로 넘어간다
    const tryElement = !chrome.runtime.getURL || (!DRM_SITES.includes(adapter.name) && state.elemCapSilent !== state.videoId);
    if (tryElement) {
      try { result = await captureViaElement(startV, endV); }
      catch (e) { if (!chrome.runtime.getURL) throw e; result = { silent: true, elemError: String((e && e.message) || e) }; }
      if (result && result.silent && chrome.runtime.getURL) {
        state.elemCapSilent = state.videoId;
        result = await captureViaTab(startV, endV, item, i);
      }
    } else {
      result = await captureViaTab(startV, endV, item, i);
    }
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
  // ── 지금 보는 영상의 오디오를 통째로 MP3 로 (보는 동안 실시간 녹음 — 멈춘 시간은 건너뛴다) ──
  // DRM 없는 사이트(유튜브·TVNZ+·일반)는 영상 요소에서 바로 담아 허용 단계가 없고,
  // 보호된 재생(넷플릭스·프라임·디즈니+)만 크롬 규칙상 탭 캡처(탭마다 한 번 허용 — Control+R(Mac) 한 번이면 허용+녹음)를 쓴다
  const DRM_SITES = ['netflix', 'prime', 'disney'];
  const IS_MAC = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const REC_KEY_TEXT = IS_MAC ? 'Control+R' : 'Alt+R';   // 에피소드 통째 녹음 단축키 (Mac 은 ⌃R)
  const recFull = { on: false, startedAt: 0, timer: null, tick: 0, pending: false, elem: null, title0: '', autoFor: null, seenFor: null };
  // AudioData 한 조각 → 모노 Float32
  function recElemMono(ad) {
    const n = ad.numberOfFrames, nch = ad.numberOfChannels || 1;
    try {
      const mono = new Float32Array(n);
      const plane = new Float32Array(n);
      for (let ch = 0; ch < nch; ch++) {
        ad.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        for (let k = 0; k < n; k++) mono[k] += plane[k];
      }
      if (nch > 1) for (let k = 0; k < n; k++) mono[k] /= nch;
      return mono;
    } catch (e) { return null; }
  }
  // 영상 요소에서 PCM 을 받아 그 자리에서 64kbps 모노 MP3 로 눌러 담는다 (영상이 멈춘 동안은 담지 않는다)
  function recElemStart() {
    const Au = globalThis.SubTutorAudio;
    const v = adapter.video();
    if (!v || !Au || !Au.hasMp3() || typeof MediaStreamTrackProcessor !== 'function') return null;
    let stream = null;
    try { stream = v.captureStream ? v.captureStream() : null; } catch (e) { stream = null; }
    const track = stream && stream.getAudioTracks()[0];
    if (!track) return null;
    const cur = { track, reader: null, enc: null, sampleRate: 0, parts: [], bytes: 0, frames: 0, skipped: 0, closed: false, soundSeen: false };
    try { cur.reader = new MediaStreamTrackProcessor({ track }).readable.getReader(); } catch (e) { try { track.stop(); } catch (e2) { /* ignore */ } return null; }
    const loop = () => cur.reader.read().then(({ done, value }) => {
      if (done || cur.closed) { if (value) { try { value.close(); } catch (e) { /* ignore */ } } return; }
      try {
        if (!cur.sampleRate && value.sampleRate) {
          cur.sampleRate = value.sampleRate;
          cur.enc = new (globalThis.lamejs).Mp3Encoder(1, value.sampleRate, 64);
        }
        if (value.sampleRate === cur.sampleRate && cur.enc) {
          const mono = recElemMono(value);
          const vd = adapter.video();
          if (!mono) { /* 형식을 못 읽은 조각은 버린다 */ }
          else if (vd && vd.paused) { cur.skipped += value.numberOfFrames; }
          else {
            const b = cur.enc.encodeBuffer(Au.floatToInt16(mono));
            if (b.length) { cur.parts.push(new Uint8Array(b)); cur.bytes += b.length; }
            cur.frames += value.numberOfFrames;
            if (!cur.soundSeen && !Au.isSilent(mono)) cur.soundSeen = true;
          }
        }
      } catch (e) { /* 조각 하나 실패해도 계속 */ }
      finally { try { value.close(); } catch (e) { /* ignore */ } }
      return loop();
    }).catch(() => {});
    loop();
    return cur;
  }
  async function recElemFinish(cur, reason) {
    cur.closed = true;
    try { cur.reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
    try { cur.track.stop(); } catch (e) { /* ignore */ }
    const Au = globalThis.SubTutorAudio;
    if (cur.enc) {
      const end = cur.enc.flush();
      if (end.length) { cur.parts.push(new Uint8Array(end)); cur.bytes += end.length; }
    }
    const durMs = Math.round((cur.frames / (cur.sampleRate || 48000)) * 1000);
    if (!cur.bytes || durMs < 1000) return { ok: false, error: '담긴 오디오가 너무 짧습니다 (' + durMs + 'ms) — 영상이 재생되는 동안 담깁니다' };
    const bytes = new Uint8Array(cur.bytes);
    let off = 0;
    for (const x of cur.parts) { bytes.set(x, off); off += x.length; }
    cur.parts = [];
    const SLICE = 6 * 1024 * 1024;   // 3의 배수 — base64 조각을 그대로 이어 붙인다
    const recId = 'rec' + Math.floor(Math.random() * 1e9).toString(36);
    for (let o = 0, seq = 0; o < bytes.length; o += SLICE, seq++) {
      await bg({ type: 'rec.part', recId, seq, data: Au.bytesToBase64(bytes.subarray(o, o + SLICE)) });
    }
    return bg({ type: 'rec.elemSave', title: recFull.title0 || recTitle(), meta: { recId, bytes: bytes.length, durMs, skippedMs: Math.round((cur.skipped / (cur.sampleRate || 48000)) * 1000), reason } });
  }
  // 자동 녹음 캡슐의 "작품": 유튜브는 영상마다 제목이 달라 채널을 작품으로 본다 (채널을 고르면 그 채널 영상을 모두 담는다)
  function recWork() {
    const m = state.meta;
    if (!m || !m.title) return null;
    const title = adapter.name === 'youtube' ? (m.episode || m.title) : m.title;
    return { site: adapter.name, title: String(title).trim() };
  }
  // 에피소드를 재생하면 자동으로 담기 시작 (⚙ 캡슐로 고른 서비스·작품 · 에피소드마다 한 번 — 사용자가 멈추면 그 에피소드에서는 다시 켜지 않는다)
  function recAutoTick() {
    if (!state.active || !isEnabled() || !state.videoId) return;
    const v = adapter.video();
    if (!v || v.paused || v.ended) return;
    const work = recWork();
    // 최근 본 작품에 올린다 (에피소드마다 한 번) — ⚙ 에서 서비스를 고르지 않고 그 작품만 고를 수 있게
    if (work && recFull.seenFor !== state.videoId) {
      recFull.seenFor = state.videoId;
      bg({ type: 'recAuto.seen', site: work.site, title: work.title }).catch(() => {});
    }
    if (recFull.on || recFull.pending || recFull.autoFor === state.videoId) return;
    if (!Sites || !Sites.recAutoWhy(settings, adapter.name, work && work.title)) return;
    recFull.autoFor = state.videoId;
    recToggle();
  }
  setInterval(recAutoTick, 2000);
  // 확장 프로그램을 새로 불러오면(⟳·업데이트) 이미 열려 있던 탭의 이 스크립트는 끊긴다 — 크롬은 열린 탭에 새 코드를 넣어 주지 않는다.
  // 끊긴 것을 알아차리면 화면 위쪽에 새로고침 안내를 띄운다 (안 그러면 옛 패널이 그대로 남아 새 기능이 안 보인다)
  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  const orphanTimer = setInterval(() => {
    if (extAlive()) return;
    clearInterval(orphanTimer);
    const bar = el('div', { class: 'st-orphan', style: 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;align-items:center;background:#7c3aed;color:#fff;font:600 14px/1.4 -apple-system,system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.45)' }, [
      el('span', null, 'SubTutor 가 새로 설치됐습니다 — 이 탭을 새로고침해야 새 기능이 켜집니다'),
      el('button', { style: 'all:unset;cursor:pointer;background:#fff;color:#4c1d95;padding:4px 10px;border-radius:7px;font-weight:700', onclick: () => location.reload() }, '새로고침'),
    ]);
    (document.fullscreenElement || document.body || document.documentElement).append(bar);
  }, 3000);
  const fmtMinSec = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return (t >= 60 ? Math.floor(t / 60) + '분 ' : '') + (t % 60) + '초'; };
  function recTitle() {
    const m = state.meta || {};
    return (m.title || document.title || '영상').trim() + (m.episode ? ' ' + m.episode : '');
  }
  function recSetUi() {
    if (!ui.btnRec) return;
    ui.btnRec.classList.toggle('st-on', recFull.on);
    if (!recFull.on) { ui.btnRec.textContent = '⏺ MP3'; return; }
    const t = Math.max(0, Math.floor((now() - recFull.startedAt) / 1000));
    ui.btnRec.textContent = '⏹ ' + Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }
  function recBegin(startedAt) {
    recFull.on = true;
    recFull.startedAt = startedAt || now();
    recFull.tick = 0;
    recFull.title0 = recTitle();   // 에피소드가 바뀌며 저장될 때도 담기 시작한 제목으로
    clearInterval(recFull.timer);
    recFull.timer = setInterval(() => {
      recSetUi();
      recFull.tick++;
      if (recFull.tick % 3 !== 0) return;             // 3초에 한 번
      const v = adapter.video();
      if (recFull.elem) {
        // 요소 캡처가 5초 넘게 무음이면(뜻밖의 보호된 재생) 탭 캡처로 넘어간다
        const c = recFull.elem;
        if (!c.soundSeen && c.sampleRate && c.frames / c.sampleRate > 5) {
          c.closed = true;
          try { c.track.stop(); } catch (e) { /* ignore */ }
          recFull.elem = null;
          recEndUi();
          toast('이 영상은 보호된 재생이라 탭 캡처로 넘어갑니다');
          recTabStart();
          return;
        }
      } else {
        bg({ type: 'rec.beat', paused: !!(v && v.paused), title: recTitle() })
          .then((r) => { if (r && r.recording === false && recFull.on) recEndUi(); })   // 저쪽이 이미 끝냈으면(자동 저장 등) 버튼을 되돌린다
          .catch(() => { /* ignore */ });
      }
      if (v && v.ended) recToggle();                   // 영상이 끝나면 알아서 저장
    }, 1000);
    recSetUi();
  }
  function recEndUi() {
    recFull.on = false;
    clearInterval(recFull.timer);
    recSetUi();
  }
  async function recToggle() {
    if (recFull.on) {
      const elem = recFull.elem;
      recFull.elem = null;
      recEndUi();
      chip('rec', '영상 오디오를 MP3 파일로 묶는 중…', 0);
      try {
        const r = elem ? await recElemFinish(elem, 'user') : await bg({ type: 'rec.stop' });
        chipHide();
        if (!r || !r.ok) { toast('영상 오디오 저장 실패: ' + ((r && r.error) || '알 수 없음'), 7000); return; }
        const where = r.location === 'folder' ? r.fileName : '다운로드 폴더/' + r.fileName;
        toast('⏹ 영상 오디오 MP3 저장: ' + where + ' (' + fmtMinSec(r.durMs) + (r.skippedMs > 2000 ? ', 멈춘 ' + fmtMinSec(r.skippedMs) + ' 건너뜀' : '') + ')', 9000);
      } catch (e) { chipHide(); toast('영상 오디오 저장 실패: ' + (e && e.message), 7000); }
      return;
    }
    // DRM 없는 사이트: 영상 요소에서 바로 — 확장 프로그램 아이콘을 누르는(허용) 단계가 없다
    if (!DRM_SITES.includes(adapter.name)) {
      const cur = recElemStart();
      if (cur) {
        recFull.elem = cur;
        recBegin(now());
        toast('⏺ 영상 오디오를 MP3 로 담는 중 — 보는 동안 실시간으로 담기고, 일시정지한 시간은 건너뜁니다. 같은 버튼으로 저장', 7000);
        return;
      }
    }
    return recTabStart();
  }
  // 보호된 재생(넷플릭스류): 탭 캡처 — 크롬 규칙상 이 탭에서 한 번 허용해야 한다 (Control+R·Option+E·우클릭 메뉴·아이콘 — 허용되면 바로 이어서)
  async function recTabStart() {
    let started = null;
    try { started = await bg({ type: 'rec.start', title: recTitle() }); }
    catch (e) { toast('영상 오디오 녹음 시작 실패: ' + (e && e.message), 7000); return; }
    if (started && started.unavailable === 'grant') {
      recFull.pending = true;
      const hint = grantHint(started.shortcut, started.recShortcut);
      chip('wait', '영상 오디오 녹음 허용 대기 — ' + hint, 0);
      toast('🎙 ' + hint, 8000);
      return;
    }
    if (!started || !started.ok) { toast('영상 오디오 녹음을 시작하지 못했습니다' + (started && started.error ? ': ' + started.error : ''), 7000); return; }
    recBegin(now());
    toast('⏺ 영상 오디오를 MP3 로 담는 중 — 보는 동안 실시간으로 담기고, 일시정지한 시간은 건너뜁니다. 같은 버튼으로 저장', 7000);
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
  function grantHint(shortcut, recShortcut) {
    const ways = [];
    if (recShortcut) ways.push(recShortcut + ' (MP3 녹음 단축키 — 허용과 녹음을 한 번에)');
    else if (recShortcut === '') ways.push('chrome://extensions/shortcuts 에서 "영상 오디오 통째 MP3 녹음"에 ' + REC_KEY_TEXT + ' 을 지정하면 다음부터 허용과 녹음이 한 번에');
    if (shortcut) ways.push(shortcut + ' (저장 단축키)');
    ways.push('영상 우클릭 → "SubTutor: 지금 자막 저장"', '툴바의 SubTutor 아이콘');
    return '오디오 녹음은 크롬 규칙상 이 탭에서 한 번 허용해야 합니다: ' + ways.join(' · ') + (shortcut ? '' : ' (단축키는 chrome://extensions/shortcuts 에서 지정)') + '. 허용되면 바로 녹음합니다';
  }
  // 호출(단축키·메뉴·팝업)로 이 탭의 녹음이 허용되면 기다리던 녹음을 바로 이어서 한다 → true 면 처리함
  function resumePendingCapture() {
    if (recFull.pending) { recFull.pending = false; chipHide(); recToggle(); return true; }
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
    if (msg && msg.action === 'rec') {
      // 단축키를 누른 것 자체가 이 탭의 녹음 허용 — 기다리던 대사 녹음이 있으면 그것도 이어서 한다
      if (capture.pendingGrant) {
        const p = capture.pendingGrant;
        capture.pendingGrant = null;
        if (state.saved.has(p.item.id)) queueCapture(p.i, p.item);
      }
      if (recFull.pending) { recFull.pending = false; chipHide(); recToggle(); return { ok: true, did: 'rec-resume' }; }
      if (!state.active || !isEnabled()) return { ok: false, error: '재생 화면이 아닙니다' };
      const was = recFull.on;
      recToggle();
      return { ok: true, did: was ? 'rec-stop' : 'rec-start' };
    }
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
    const name = state.meta.title + (state.meta.episode ? ' · ' + state.meta.episode : '');
    if (ui.panel) ui.panel.dataset.title = name;
    if (ui.status) ui.status.title = name;
    renderRecAutoCaps();
  }
  async function loadMeta() {
    const token = state.runToken;
    if (pageMeta && adapter.name === 'disney') setMeta(pageMeta);
    for (let i = 0; i < 10 && token === state.runToken; i++) {
      try {
        const r = await page.request({ type: 'getMeta', videoId: state.videoId }, 3000);
        if (token !== state.runToken) return;
        // 범용 사이트의 페이지 스크립트는 마지막으로 본 제목을 그 주소와 함께 준다 → 이 영상의 것일 때만
        if (r && r.meta && r.meta.title && (!adapter.generic || forThisVideo({ href: r.meta.href, at: NaN }))) { setMeta(r.meta); return; }
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
    // 맨 왼쪽: 내 더빙 재생 켬/끔 (예전에는 작품 이름이 있던 자리 — 이름은 상태줄에 마우스를 올리면 보인다)
    ui.dubToggle = el('button', { class: 'st-dub-toggle', role: 'switch', onclick: () => setDubPlayback(settings.dubPlayback === false) }, [el('span', { class: 'st-dub-toggle-knob' }), el('span', { class: 'st-dub-toggle-text' })]);
    ui.btnAP = el('button', { class: 'st-mode', title: '자동 일시정지 (Z): 자막이 끝나면 멈춥니다. F로 다시 듣기', onclick: () => setMode('autoPause', !settings.autoPause) }, 'AP');
    ui.btnShadow = el('button', { class: 'st-mode st-shadow st-switchy', role: 'switch', title: '따라하기 켜기/끄기 (단축키 W): 켜면 자막이 끝날 때마다 옆에서 고른 시간만큼 쉬었다가 다음 자막으로 이어 재생합니다', onclick: () => setMode('shadowing', !settings.shadowing) }, [el('span', { class: 'st-dub-toggle-knob' }), el('span', { class: 'st-shadow-text' }, '따라하기')]);
    // 쉬는 시간을 고르면 따라하기도 켠다 — 시간만 바꾸고 모드는 꺼져 있어 그냥 재생되던 혼동을 막는다
    ui.shadowSec = el('select', { class: 'st-shadow-sec', title: '따라하기: 자막이 끝난 뒤 쉬는 시간 (고르면 따라하기가 켜집니다)', onchange: (e) => { saveSettings(shadowPausePatch(e.target.value)); if (!settings.shadowing) setMode('shadowing', true); } });
    shadowPauseOptions(false).forEach((g) => ui.shadowSec.append(g));
    ui.btnSettings = el('button', { class: 'st-icon', title: '설정', onclick: () => { ui.settings.classList.toggle('st-hidden'); syncSettingsForm(); if (!ui.settings.classList.contains('st-hidden')) refreshRecCustomSites(); } }, '⚙');
    ui.btnClose = el('button', { class: 'st-icon', title: '패널 닫기 (`)', onclick: () => setPanelOpen(false) }, '✕');
    const head = el('div', { class: 'st-head' }, [ui.dubToggle, ui.btnAP, ui.btnShadow, ui.shadowSec, ui.btnSettings, ui.btnClose]);
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
      el('button', { class: 'st-foot-btn', title: '이 에피소드의 어휘 통계 (3천 밖 단어·말 속도)', onclick: showVocab }, '어휘 통계'),
      el('button', { class: 'st-foot-btn st-foot-words', title: '이 영상의 단어 목록 (어려운 단어부터 · 뜻 · 단어장 저장)', onclick: () => toggleWordView() }, '단어 목록'),
      el('button', { class: 'st-foot-btn st-foot-dub', title: '지금 자막으로 더빙 (R)', onclick: () => toggleDubBox() }, '🎙 더빙'),
      (ui.btnRec = el('button', { class: 'st-foot-btn st-rec-btn', title: '지금 보는 영상의 오디오를 통째로 MP3 로 저장 — 보는 동안 실시간으로 담기고, 일시정지한 시간은 건너뜁니다. 다시 누르면 저장', onclick: () => recToggle() }, '⏺ MP3')),
      el('span', { class: 'st-copy-wrap' }, [
        el('button', { class: 'st-foot-btn st-copy-btn', title: '이 영상의 자막 전체를 복사', onclick: (e) => { e.stopPropagation(); ui.copyMenu.classList.toggle('st-hidden'); } }, '⧉ 복사 ▾'),
        (ui.copyMenu = el('div', { class: 'st-copy-menu st-hidden' }, [
          el('button', { class: 'st-copy-item', 'data-copy': 'en', onclick: () => copyCues('en', false) }, '영어 자막 전체'),
          el('button', { class: 'st-copy-item', 'data-copy': 'en-t', onclick: () => copyCues('en', true) }, '영어 + 시간'),
          el('button', { class: 'st-copy-item', 'data-copy': 'ko', onclick: () => copyCues('ko', false) }, '한글 해석만'),
          el('button', { class: 'st-copy-item', 'data-copy': 'ko-t', onclick: () => copyCues('ko', true) }, '한글 + 시간'),
        ])),
      ]),
    ]);
    document.addEventListener('click', (e) => { if (ui.copyMenu && !ui.copyMenu.classList.contains('st-hidden') && !e.target.closest('.st-copy-wrap')) ui.copyMenu.classList.add('st-hidden'); });
    ui.dubbox = el('div', { class: 'st-dubbox st-hidden', 'data-mic': 'closed' });
    ui.settings = buildSettings();
    ui.wordView = el('div', { class: 'st-wordview st-hidden' });
    ui.panel.append(head, ui.status, ui.list, ui.wordView, ui.settings, ui.foot);
    if (state.meta) setMeta(state.meta); // 패널보다 제목을 먼저 알았으면 지금 붙인다

    ui.toggle = el('button', { id: 'st-toggle', title: 'SubTutor 자막 패널 열기 (`)', onclick: () => setPanelOpen(true) }, '‹');
    document.body.append(ui.panel, ui.toggle);
    bg({ type: 'rec.status' }).then((r) => { if (r && r.on) recBegin(r.startedAt || now()); }).catch(() => { /* ignore */ });
    bg({ type: 'commands.get' }).then((r) => {
      const key = (r && r.rec) || '';
      recFull.shortcut = key;
      if (ui.btnRec) ui.btnRec.title += ' · 단축키 ' + REC_KEY_TEXT + (key ? (key.replace(/\s/g, '') === '⌃R' || /^(Ctrl|MacCtrl)\+R$/i.test(key) || !IS_MAC ? ' (넷플릭스류는 누르는 순간 녹음 허용까지)' : ' — 크롬 단축키는 지금 ' + key + ' 로 지정돼 있음: chrome://extensions/shortcuts 에서 ' + REC_KEY_TEXT + ' 로 바꾸면 넷플릭스류도 허용까지 한 번에') : ' — 크롬 단축키로는 아직 지정 안 됨: chrome://extensions/shortcuts 에서 지정하면 넷플릭스류도 허용까지 한 번에');
    }).catch(() => { /* ignore */ });

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
  // 창에 실제로 보이는 영상 부분: <video> 사각형을 창(뷰포트) 안으로 자른다. 넷플릭스는 패널을 열어 플레이어를 줄이면 <video> 요소가
  // 창 아래로 삐져나가서, 컨트롤이 사라져 자막이 영상 아래 끝으로 내려갈 때 화면 밖으로 떨어졌다(컨트롤이 보일 땐 컨트롤 위에 붙어 멀쩡해 보임).
  // 스크롤로 영상이 거의 다 창 밖이면 예전처럼 <video> 사각형을 그대로 따라간다
  function shownVideoRect(v) {
    const r = v.getBoundingClientRect();
    const left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    const right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight);
    if (right - left < Math.min(r.width * 0.5, 320) || bottom - top < Math.min(r.height * 0.3, 240)) return r;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  let lastRectKey = '';
  // 오버레이는 플레이어 DOM 안에 넣지 않고(플랫폼 CSS 간섭 방지) 화면에 고정한 채 <video>의 위치(창에 보이는 부분)를 따라간다
  function positionOverlay(force) {
    if (!ui.overlay) return;
    const v = adapter.video();
    if (!v) return;
    const r = shownVideoRect(v);
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
    positionFloat();
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
    ui.overlay.classList.toggle('st-off', !(state.active && enabled)); // 끄면 영상 위 상태 캡슐(반복·AP 등)·더빙 표시도 함께 감춘다
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
  // 패널 맨 위의 더빙 켬/끔: 켜면 ★ 로 고른 녹음이 있는 줄은 내 목소리, 끄면 원래 소리만
  function setDubPlayback(on) {
    saveSettings({ dubPlayback: !!on });
    if (!on) stopDubPlay('toggle');
    dl('toggle dubPlayback=' + !!on);
  }
  function updateDubToggle() {
    if (!ui.dubToggle) return;
    const on = settings.dubPlayback !== false;
    const n = state.dubSegs.filter((s) => chosenTake(s)).length;
    ui.dubToggle.classList.toggle('on', on);
    ui.dubToggle.setAttribute('aria-checked', String(on));
    ui.dubToggle.querySelector('.st-dub-toggle-text').textContent = on ? '더빙 켬' : '더빙 끔';
    ui.dubToggle.title = (on ? '더빙 켬: 녹음한 줄(★)은 내 목소리로 재생합니다' : '더빙 끔: 원래 영상 소리만 재생합니다') + ' · 이 영상에서 더빙한 줄 ' + n + '개 · 누르면 ' + (on ? '끕니다' : '켭니다') + ' (Shift+R)';
  }
  function updateModeUI() {
    if (!ui.root) return;
    updateDubToggle();
    ui.btnAP.classList.toggle('on', !!settings.autoPause);
    ui.btnShadow.classList.toggle('on', !!settings.shadowing);
    ui.btnShadow.setAttribute('aria-checked', String(!!settings.shadowing));
    { const tx = ui.btnShadow.querySelector('.st-shadow-text'); if (tx) tx.textContent = settings.shadowing ? '따라하기 켬' : '따라하기 끔'; }
    ui.ovModes.textContent = '';
    if (state.loop) ui.ovModes.append(el('span', { class: 'st-ov-chip on-loop' }, '🔁 반복'));
    if (settings.autoPause) ui.ovModes.append(el('span', { class: 'st-ov-chip on-ap' }, '⏸ AP'));
    if (settings.shadowing) ui.ovModes.append(el('span', { class: 'st-ov-chip on-shadow' }, '🗣 따라하기 ' + shadowPauseText()));
    if (Math.abs(state.rate - 1) > 0.01) ui.ovModes.append(el('span', { class: 'st-ov-chip on-rate' }, '⏩ ' + rateText(state.rate) + '×'));
    if (ui.rateNow) { ui.rateNow.textContent = rateText(state.rate) + '×'; ui.rateNow.classList.toggle('on', Math.abs(state.rate - 1) > 0.01); ui.rateNow.title = '지금 ' + rateText(state.rate) + '배속 · 누르면 보통 속도로 (\\)'; }
    if (!settings.overlay) ui.ovModes.append(el('span', { class: 'st-ov-chip on-subs-off' }, '🙈 자막 감춤 (G)'));
    if (settings.secondPass) ui.ovModes.append(el('span', { class: 'st-ov-chip on-pass' }, '2회차'));
    if (ui.ctlBtn) { ui.ctlBtn.classList.toggle('off', !isEnabled()); ui.ctlBtn.title = isEnabled() ? 'SubTutor 끄기' : 'SubTutor 켜기'; }
    if (ui.floatBtn) { ui.floatBtn.classList.toggle('off', !isEnabled()); ui.floatBtn.title = isEnabled() ? 'SubTutor 끄기' : 'SubTutor 켜기'; }
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
  const CHIP_ICON = { saved: '★', unsaved: '☆', known: '✓', missed: 'Q', rec: '●', wait: '●', audio: '♪', info: 'i', error: '!' };
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
    '.st-ctl-generic { width: 2.6em; min-width: 38px; height: 100%; margin: 0 .15em; } .st-ctl-generic .st-ctl-svg { width: 28px; height: 28px; }',
    '.st-ctl-float { width: 44px; height: 34px; border-radius: 8px; background: rgba(0,0,0,.45); opacity: .6; } .st-ctl-float:hover { opacity: 1; } .st-ctl-float .st-ctl-svg { width: 30px; height: 30px; }',
    '.st-rate-generic { margin: 0 .2em; }',
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
    if (adapter.controlPlace === 'exact') return { before: anchor, wrapper: anchor }; // 앵커 바로 앞 (TVNZ+: 오른쪽 묶음 안, 전체 화면 버튼 왼쪽)
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
    ui.rateCtl = el('div', { class: 'st-rate st-rate-' + adapter.name + (adapter.generic ? ' st-rate-generic' : '') }, [ui.rateDown, ui.rateNow, ui.rateUp]);
  }
  // 컨트롤 바에서 ST 버튼 자리를 못 찾은 범용 사이트: 영상 왼쪽 위에 떠 있는 ST 버튼으로 켜고 끈다 (꺼도 남아 있어 다시 켤 수 있다)
  function syncFloatToggle() {
    const want = adapter.generic && state.active && !(ui.ctlMount && ui.ctlMount.isConnected) && now() - (state.activeAt || 0) > 2500;
    if (!want) { if (ui.floatBtn && ui.floatBtn.isConnected) ui.floatBtn.remove(); return; }
    if (!ui.floatBtn) {
      ui.floatBtn = el('button', { id: 'st-float', class: 'st-ctl st-ctl-float', type: 'button', 'aria-label': 'SubTutor 켜기/끄기' });
      ui.floatBtn.innerHTML = CTL_ICON;
    }
    const host = overlayHost();
    if (ui.floatBtn.parentElement !== host) { host.append(ui.floatBtn); ensureControlStyle(ui.floatBtn); }
    ui.floatBtn.classList.toggle('off', !isEnabled());
    ui.floatBtn.title = isEnabled() ? 'SubTutor 끄기' : 'SubTutor 켜기';
    positionFloat();
  }
  function positionFloat() {
    if (!ui.floatBtn || !ui.floatBtn.isConnected) return;
    const v = adapter.video();
    if (!v) return;
    const r = shownVideoRect(v);
    ui.floatBtn.style.left = Math.round(r.left + 10) + 'px';
    ui.floatBtn.style.top = Math.round(r.top + 10) + 'px';
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
      ui.ctlBtn = el('button', { class: 'st-ctl st-ctl-' + adapter.name + (adapter.generic ? ' st-ctl-generic' : ''), title: 'SubTutor 끄기', 'aria-label': 'SubTutor 켜기/끄기', type: 'button' });
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
    return [[ui.ctlBtn, () => setEnabled(!isEnabled())], [ui.floatBtn, () => setEnabled(!isEnabled())], [ui.rateDown, () => stepRate(-1)], [ui.rateNow, () => changeRate(0)], [ui.rateUp, () => stepRate(1)]];
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
  // ── ⚙ › 에피소드를 재생하면 자동으로 오디오 MP3 녹음: 서비스 캡슐(그 서비스 전부) · 최근 본 작품 캡슐(그 작품만) ──
  let recCustomSites = [];   // 팝업에서 켠 사이트("아무 사이트") — 서비스 캡슐에 함께 둔다
  function refreshRecCustomSites() {
    bg({ type: 'sites.list' }).then((r) => {
      recCustomSites = ((r && r.sites) || []).filter((x) => x && x.host).map((x) => ({ key: 'site:' + x.host, label: String(x.host).replace(/^www\./, '') }));
      renderRecAutoCaps();
    }).catch(() => {});
  }
  function buildRecAutoField(f) {
    f.recCapsSites = el('div', { class: 'st-caps st-caps-sites' });
    f.recCapsTitles = el('div', { class: 'st-caps st-caps-titles' });
    f.recCapsNow = el('div', { class: 'st-caps-now' });
    refreshRecCustomSites();
    return el('div', { class: 'st-field st-field-stack st-recauto' }, [
      el('label', null, ['에피소드를 재생하면 자동으로 오디오 MP3 녹음', infoBtn('recFull')]),
      f.recCapsSites,
      el('div', { class: 'st-caps-head', text: '최근 본 작품' }),
      f.recCapsTitles,
      f.recCapsNow,
    ]);
  }
  const recSiteName = (key) => (key === 'youtube' ? '유튜브 채널' : (Sites ? Sites.serviceLabel(key) : key));
  function recCap(text, sub, on, opts) {
    const cls = 'st-cap' + (on ? ' st-on' : '') + (opts.covered ? ' st-covered' : '') + (opts.here ? ' st-here' : '');
    return el('button', { type: 'button', class: cls, 'aria-pressed': on ? 'true' : 'false', title: opts.title || '', 'data-key': opts.key || '', onclick: opts.onclick }, [(on ? '✓ ' : '') + text, sub ? el('span', { class: 'st-cap-sub' }, sub) : null]);
  }
  function recPickSite(key, on) {
    // 바로 다시 그리고(누른 느낌), 저장은 서비스 워커가 — 돌아오는 설정으로 한 번 더 그린다
    const known = Sites.SERVICES.map((x) => x.key).concat(recCustomSites.map((x) => x.key));
    const set = new Set(Sites.recAutoSiteKeys(settings, known));
    if (on) set.add(key); else set.delete(key);
    settings = Object.assign({}, settings, { recAutoSites: Array.from(set), recAuto: false });
    renderRecAutoCaps();
    bg({ type: 'recAuto.site', site: key, on }).then((r) => { if (r && r.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, r.settings); renderRecAutoCaps(); } }).catch((e) => toast('저장하지 못했습니다: ' + (e && e.message), 4000));
  }
  function recPickTitle(site, title, on) {
    settings = Object.assign({}, settings, { recTitles: Sites.recentSet(settings.recTitles, site, title, on, Date.now()) || settings.recTitles });
    renderRecAutoCaps();
    bg({ type: 'recAuto.title', site, title, on }).then((r) => { if (r && r.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, r.settings); renderRecAutoCaps(); } }).catch((e) => toast('저장하지 못했습니다: ' + (e && e.message), 4000));
  }
  function renderRecAutoCaps() {
    const f = ui.form;
    if (!f || !f.recCapsSites || !Sites) return;
    const legacyAll = !Array.isArray(settings.recAutoSites) && !!settings.recAuto;   // 예전 스위치를 켜 둔 채 = 모든 서비스
    const picked = new Set(Array.isArray(settings.recAutoSites) ? settings.recAutoSites : []);
    const siteOn = (k) => legacyAll || picked.has(k);
    const sites = Sites.SERVICES.map((x) => ({ key: x.key, label: x.label }));
    const addSite = (k, lab) => { if (!sites.some((x) => x.key === k)) sites.push({ key: k, label: lab }); };
    recCustomSites.forEach((x) => addSite(x.key, x.label));
    if (adapter.custom) addSite(adapter.name, adapter.label);
    picked.forEach((k) => addSite(k, Sites.serviceLabel(k)));
    f.recCapsSites.replaceChildren(...sites.map((x) => {
      const on = siteOn(x.key), here = x.key === adapter.name;
      return recCap(x.label, '', on, { key: x.key, here, onclick: () => recPickSite(x.key, !on),
        title: (on ? x.label + '에서 재생하는 에피소드를 모두 자동으로 녹음합니다 — 누르면 끕니다' : '누르면 ' + x.label + '에서 재생하는 에피소드를 모두 자동으로 녹음합니다') + (here ? ' (지금 보는 곳)' : '') });
    }));
    const work = recWork();
    const titles = (Array.isArray(settings.recTitles) ? settings.recTitles : []).filter((x) => x && x.site && x.title);
    const isHere = (x) => !!work && x.site === work.site && Sites.workMatches(x.title, work.title);
    // 지금 보는 작품은 아직 목록에 없어도(재생 전) 맨 앞에 보여 바로 고를 수 있게
    const list = work && !titles.some(isHere) ? [{ site: work.site, title: work.title, on: false }].concat(titles) : titles;
    f.recCapsTitles.replaceChildren(...(list.length ? list.map((x) => {
      const covered = !x.on && siteOn(x.site);
      const name = recSiteName(x.site);
      return recCap(x.title, name, !!x.on, { key: x.site + '|' + x.title, here: isHere(x), covered, onclick: () => recPickTitle(x.site, x.title, !x.on),
        title: x.on ? '이 작품의 에피소드를 자동으로 녹음합니다 — 누르면 끕니다'
          : (covered ? Sites.serviceLabel(x.site) + ' 전체를 골라 이 작품도 자동으로 녹음합니다 (서비스를 꺼도 이 작품만 담으려면 누르세요)' : '누르면 이 작품(' + name + ')의 에피소드만 자동으로 녹음합니다') });
    }) : [el('span', { class: 'st-caps-empty', text: '아직 없음' })]));
    // 지금 영상을 담는가 (짧은 상태만 — 설명은 ⓘ)
    let line = '';
    if (state.videoId) {
      const why = Sites.recAutoWhy(settings, adapter.name, work && work.title);
      if (why === 'site') line = '● 지금 영상: 자동 녹음 (' + Sites.serviceLabel(adapter.name) + ' 전체)';
      else if (why === 'title') line = '● 지금 영상: 자동 녹음 (작품 ' + work.title + ')';
      else line = '지금 영상: 자동 녹음 안 함';
      f.recCapsNow.classList.toggle('st-caps-now-on', !!why);
    }
    f.recCapsNow.textContent = line;
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
    f.shadowPause = el('select', { onchange: (e) => { saveSettings(shadowPausePatch(e.target.value)); if (!settings.shadowing) setMode('shadowing', true); } });
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
      field('영상 위 자막 표시 (G)', sw('overlay'), 'overlay'),
      field('플랫폼 기본 자막 숨기기', sw('hideNative'), 'hideNative'),
      field('자막 크기', f.fontScale, 'fontScale'),
      el('h4', { text: '듣기 훈련' }),
      field('한국어 표시 방식', f.koMode, 'koMode'),
      field('2회차 모드', sw('secondPass'), 'secondPass'),
      field('빈칸 자막', f.cloze, 'cloze'),
      field('소리 나는 대로', sw('soundsLike'), 'soundsLike'),
      field('키위·마오리·학교 용어 주석', sw('kiwiNotes'), 'kiwiNotes'),
      field('NZ 모음 주석 (fush·pin 처럼 들리는 단어)', sw('nzNotes'), 'nzVowels'),
      field('어휘 프로파일 · 말 속도', sw('vocabProfile'), 'vocabProfile'),
      field('반복 속도 사다리 (X 키 배속)', (f.ladderCfg = el('span', { class: 'st-ladder-cfg' })), 'loopLadder'),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn', onclick: showVocab }, '이 에피소드 어휘 목록'), el('button', { class: 'st-btn', onclick: () => showInfo('missed') }, 'Q 못 알아들음 표시란?'), el('button', { class: 'st-btn', onclick: () => showInfo('twoPass') }, '두 번 보기 순서')]),
      el('h4', { text: '재생' }),
      field('따라하기 쉬는 시간', f.shadowPause, 'shadowing'),
      field('재생 시작 여유 (ms)', num('leadMs', 0, 2000), 'leadTail'),
      field('재생 끝 여유 (ms)', num('tailMs', 0, 2000), 'leadTail'),
      el('div', { class: 'st-field' }, [el('label', null, ['이 영상 자막 시간 보정 (ms)', infoBtn('offset')]), el('span', { class: 'st-offset-ctl' }, [el('button', { class: 'st-btn st-mini', onclick: () => saveOffset(state.offsetMs - 500, 'manual') }, '−0.5초'), f.offset, el('button', { class: 'st-btn st-mini', onclick: () => saveOffset(state.offsetMs + 500, 'manual') }, '+0.5초')])]),
      el('div', { class: 'st-btn-row' }, [el('button', { class: 'st-btn', onclick: () => { state.alignSamples = []; saveOffset(0, 'manual'); toast('보정값을 지웠습니다. 플랫폼 자막이 켜져 있으면 다시 자동 감지합니다'); } }, '보정 초기화')]),
      el('h4', { text: '더빙' }),
      field('더빙 재생 (★ 녹음 구간은 내 목소리)', sw('dubPlayback'), 'dub'),
      field('녹음 전에 원래 소리 먼저 듣기', sw('dubListenFirst'), 'dub'),
      field('녹음 뒤 내 녹음 바로 들어보기', sw('dubAutoPreview'), 'dub'),
      field('그다음 자막으로 넘어가 녹음 준비', sw('dubAutoNext'), 'dub'),
      field('명료도 피드백 (실험적 · 인터넷 필요)', sw('dubFeedback'), 'dubFeedback'),
      el('h4', { text: '저장' }),
      field('별표 저장 시 오디오', f.audioMode, 'audioStore'),
      buildRecAutoField(f),
      field('녹음을 마치면 바로 아이폰으로 올리기', sw('recAutoSync'), 'recFull'),
      field('문장 단위로 저장 (다음 자막으로 이어지면 함께)', sw('saveSentence'), 'saveSentence'),
      field('저장할 문장 고르기 (한 자막에 여러 문장일 때)', sw('savePick'), 'savePick'),
      field('MP3 꼬리 여유 (자막 끝 뒤 초, 0=끄기)', (f.saveTailSec = el('input', { type: 'number', min: 0, max: 10, step: 1, onchange: (e) => saveSettings({ saveTailSec: clamp(+e.target.value || 0, 0, 10) }) })), 'saveSentence'),
      field('다음 자막 3개 글도 저장 (웹에서 문장 늘리기)', sw('saveNextTexts'), 'saveSentence'),
      el('div', { class: 'st-btn-row' }, [
        el('button', { class: 'st-btn st-primary', onclick: () => bg({ type: 'openSite' }).catch(() => {}) }, '웹에서 저장 목록 · 퀴즈 열기'),
        el('button', { class: 'st-btn', onclick: () => setEnabled(false) }, '이 사이트에서 SubTutor 끄기'),
        el('button', { class: 'st-btn st-diag-btn', title: '지금 상태와 최근 40초의 더빙·재생 기록을 복사합니다 (문제가 생긴 직후에 누르세요)', onclick: copyDiagnostics }, '진단 정보'),
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
    f.secondPass.checked = !!settings.secondPass; f.soundsLike.checked = !!settings.soundsLike; f.kiwiNotes.checked = !!settings.kiwiNotes; f.nzNotes.checked = settings.nzNotes !== false; f.vocabProfile.checked = !!settings.vocabProfile; renderLadderCfgExt();
    renderRecAutoCaps();
    f.recAutoSync.checked = settings.recAutoSync !== false;
    f.saveSentence.checked = settings.saveSentence !== false; f.saveNextTexts.checked = settings.saveNextTexts !== false; f.savePick.checked = settings.savePick !== false;
    f.saveTailSec.value = String(clamp(+settings.saveTailSec || 0, 0, 10));
    f.fontScale.value = settings.fontScale;
    f.shadowPause.value = shadowPauseValue();
    f.dubPlayback.checked = settings.dubPlayback !== false;
    f.dubListenFirst.checked = !!settings.dubListenFirst; f.dubAutoPreview.checked = !!settings.dubAutoPreview; f.dubAutoNext.checked = !!settings.dubAutoNext; f.dubFeedback.checked = settings.dubFeedback !== false;
    f.leadMs.value = settings.leadMs; f.tailMs.value = settings.tailMs;
    f.offset.value = state.offsetMs;
    f.offset.title = state.offsetMs ? (state.offsetSource === 'auto' ? '플랫폼 자막과 대조해 자동 감지한 값' : '직접 입력한 값') + ' · 자막이 소리보다 빠르면 음수' : '자막이 소리보다 빠르면 음수, 늦으면 양수. 플랫폼 자막이 켜져 있으면 자동 감지';
  }
  // 패널 아래 "⧉ 복사 ▾": 이 에피소드·영화의 자막 전체를 영어/한글(+시간)로 클립보드에 복사한다
  function copyCues(kind, withTime) {
    if (ui.copyMenu) ui.copyMenu.classList.add('st-hidden');
    if (!state.cues.length) { toast('자막을 불러온 뒤에 복사할 수 있습니다'); return; }
    let missingKo = 0;
    const lines = state.cues.map((c) => {
      let t;
      if (kind === 'ko') { t = String(c.koTrack || c.koMt || '').replace(/\n/g, ' '); if (!t) missingKo++; }
      else t = c.text.replace(/\n/g, ' ');
      return (withTime ? '[' + S.formatTime(c.start) + '] ' : '') + t;
    });
    const head = state.meta && state.meta.title ? state.meta.title + (state.meta.episode ? ' · ' + state.meta.episode : '') : adapter.label + ' ' + (state.videoId || '');
    copyText(head + '\n\n' + lines.join('\n'),
      (kind === 'ko' ? '한글 해석 ' : '영어 자막 ') + state.cues.length + '줄을 복사했습니다' + (withTime ? ' (시간 포함)' : '') + (missingKo ? ' · 한글 없는 ' + missingKo + '줄은 빈 칸 — ⚙ "이 영상 전체 기계 번역"을 먼저 누르면 채워집니다' : ''));
  }
  function copyText(text, okMsg) {
    const fallback = () => {
      try {
        const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
        ta.value = text; document.body.append(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        toast(ok ? okMsg : '복사하지 못했습니다 — 화면을 한 번 누른 뒤 다시 해 보세요', 4000);
      } catch (e) { toast('복사하지 못했습니다 — 화면을 한 번 누른 뒤 다시 해 보세요', 4000); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg, 4000), fallback);
    else fallback();
  }
  function copyDiagnostics() {
    const f = ui.form;
    const text = diagnostics();
    if (f && f.diag) f.diag.textContent = text;
    const fallback = () => { // 클립보드 API 가 막히면 상자의 글을 골라 복사한다
      try {
        const r = document.createRange(); r.selectNodeContents(f.diag);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        toast(document.execCommand('copy') ? '진단 정보를 복사했습니다' : '복사하지 못했습니다 — 상자의 글을 직접 복사하세요', 3000);
      } catch (e) { toast('복사하지 못했습니다 — 상자의 글을 직접 복사하세요', 3000); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('진단 정보를 복사했습니다 (최근 40초 기록 포함) — 그대로 붙여 넣어 보내 주세요', 3000), fallback);
    else fallback();
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
      'clock ' + (adapter.usesPageTime ? 'k=' + fx(A.shared.ctMap.k) + ' samples=' + A.shared.ctMap.samples.length + ' resets=' + A.shared.ctMap.resets + ' precise=' + A.preciseClock() + (A.shared.ctMap.cand ? ' cand=' + fx(A.shared.ctMap.cand[1]) : '') + ' playerEvents=' + JSON.stringify(A.shared.pageEv) + ' report=' + fx(A.shared.pageTime.ms) + ' (' + fx(now() - A.shared.pageTime.at) + 'ms ago, adv=' + A.shared.pageTime.advancing + ')' + (state.seekTarget ? ' lastSeek=' + fx(state.seekTarget.ms) + ' (' + fx(now() - state.seekTarget.at) + 'ms ago)' : '') : 'video element') + ' raw=' + fx(rawMs()) + ' videosDeep=' + A.qsaDeep('video').length + (v ? ' muted=' + v.muted + ' vol=' + fx(v.volume, 2) + ' rate=' + v.playbackRate : ''),
      'dub segs=' + state.dubSegs.length + ' chosen=' + state.dubSegs.filter((s) => chosenTake(s)).length + ' playback=' + (settings.dubPlayback !== false) + ' play=' + (state.dubPlay ? state.dubPlay.take.id + '@' + state.dubPlay.offset.toFixed(2) : '-') + ' rec=' + (state.dubRec ? state.dubRec.phase : '-') + ' ladder=' + (state.dubLadder ? state.dubLadder.step : '-') + ' mic=' + (state.dubMic ? 'open' : 'closed') + ' ctx=' + (dubCtx ? dubCtx.state : '-') + ' resyncs=' + dubRestartsTotal,
      'idx current=' + state.current + ' lastShown=' + state.lastShown + ' pausedFor=' + state.pausedFor + ' display=' + state.lastDisplayIdx + ' clip=' + JSON.stringify(state.clip) + ' capturing=' + !!state.capturing + ' tabId=' + state.tabId,
      'layout panel=' + !!(settings.panelOpen && state.active) + ' video=' + (v ? rectText(v.getBoundingClientRect()) + ' shown=' + rectText(shownVideoRect(v)) : '-') + ' window=' + window.innerWidth + 'x' + window.innerHeight + ' fs=' + describeEl(document.fullscreenElement) + ' fit=' + (fit.el ? describeEl(fit.el) : '-') + ' shadowRoots=' + (adapter.deep ? A.deepRoots().length - 1 : 0) + ' nativeHidden=' + nativeHiddenCount() + ' cueEl=' + (adapter.nativeCueSelector ? A.qsaDeep(adapter.nativeCueSelector).map(describeEl).slice(0, 2).join(',') : '-'),
      adapter.generic ? 'site=' + adapter.name + ' pageTracks=' + JSON.stringify(state.pageTracks.map((t) => t.lang + ':' + (t.dash ? 'dash' : (t.text ? 'text' : (t.urls ? 'hls' : 'url'))) + (t.source ? '/' + t.source : ''))) + ' dash=' + (A.shared.dash ? 'periods ' + A.shared.dash.periods + ' content ' + A.shared.dash.map.map((m) => fx(m.presStart, 1) + '-' + fx(m.presEnd, 1) + '→' + fx(m.contentStart, 1)).join(' ') + (A.shared.dash.hasAds ? ' (ads)' : '') : '-') + ' ad=' + !!(adapter.isAdPlaying && adapter.isAdPlaying()) + ' ctl=' + !!(ui.ctlMount && ui.ctlMount.isConnected) + ' float=' + !!(ui.floatBtn && ui.floatBtn.isConnected) : null,
      '── 최근 40초 기록 (초 · 0 = 복사한 순간) ──',
      dlogText(40) || '(기록 없음)',
    ].filter((x) => x !== null).join('\n');
  }

  function rectText(r) { return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }
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
      fillMarked(en, c.text.replace(/\n/g, ' '), lineMarks(c));
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
  // NZ 모음 주석: 아는 단어인데 NZ 발음 때문에 못 알아듣는 고빈도 단어 (fish→fush, pen→pin, ear=air, milk→miwk …)
  const nzCache = new WeakMap();
  function nzHits(c) {
    if (!NZV) return [];
    let h = nzCache.get(c);
    if (!h) { h = NZV.find(c.text, 3); nzCache.set(c, h); }
    return h;
  }
  // 한 줄에 그릴 밑줄 모음: 키위 용어(실선) + NZ 모음(점선). 겹치면 키위 용어가 이긴다
  function lineMarks(c) {
    const kiwi = (settings.kiwiNotes ? kiwiHits(c) : []).map((h) => ({ start: h.start, end: h.end, cls: 'st-kiwi', title: h.term + ' = ' + h.ko }));
    const nz = (settings.nzNotes !== false ? nzHits(c) : []).map((h) => ({ start: h.start, end: h.end, cls: 'st-nzv', title: h.hint + ' · ' + h.typeLabel }));
    return Sp && Sp.mergeAnnotations ? Sp.mergeAnnotations(kiwi, nz) : kiwi.concat(nz);
  }
  // 텍스트에 주석 밑줄을 넣는다 (텍스트 노드 + <u>)
  function fillMarked(node, text, hits) {
    node.textContent = '';
    if (!hits || !hits.length) { node.textContent = text; return; }
    let pos = 0;
    for (const h of hits) {
      if (h.start > pos) node.append(document.createTextNode(text.slice(pos, h.start)));
      node.append(el('u', { class: h.cls || 'st-kiwi', title: h.title !== undefined ? h.title : (h.term + ' = ' + h.ko) }, text.slice(h.start, h.end)));
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
    if (dubModeOn()) return; // 더빙 모드에서는 목록이 지금 줄을 따라 움직이지 않는다 — 스크롤은 더빙 칸에 맡긴다 (placeDubBox)
    if (force || now() - state.userScrollAt > 4000) {
      const row = ui.rows[i];
      const top = row.offsetTop - ui.list.clientHeight / 2 + row.offsetHeight / 2;
      ui.list.scrollTo({ top, behavior: force ? 'auto' : 'smooth' });
    }
  }

  // 영상 위 자막
  function displayIndex() {
    // 따라하기·자동 일시정지로 멈춘 동안에는 그 자막을 계속 보여 준다 — 멈추는 사이 영상이 다음 자막으로 조금 넘어가도 화면은 따라 할 자막 그대로
    if (state.holding && state.pausedFor >= 0) return state.pausedFor;
    if (state.current >= 0) return state.current;
    if (state.pausedFor >= 0 && (adapter.isPaused() || now() - state.pausedAt < 1500)) return state.pausedFor;
    return -1;
  }
  function renderOverlay(force) {
    if (!ui.overlay) return;
    const i = displayIndex();
    if (!force && i === state.lastDisplayIdx) return;
    state.lastDisplayIdx = i;
    // G 로 자막을 감춘 동안에도 T 를 누르고 있으면 그 줄만 잠깐 보인다
    if ((!settings.overlay && !state.koHold) || !isEnabled() || i < 0 || !state.cues[i] || (adapter.isAdPlaying && adapter.isAdPlaying())) { ui.overlay.classList.add('st-hidden'); return; }
    const c = state.cues[i];
    const id = itemIdFor(c);
    const missed = state.missed.has(id);
    const clozed = settings.cloze !== 'off' && Sp && state.clozeRevealIdx !== i;
    const text = clozed ? Sp.clozeLine(c.text, settings.cloze, i).text : c.text;
    fillMarked(ui.ovText, text, clozed ? [] : lineMarks(c));
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
          // Q 는 "못 알아들음" 표시만 — 오디오는 녹음하지 않는다 (소리까지 담고 싶으면 E 별표 저장)
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
    state.seekingAt = now();
    state.seekByUsUntil = now() + 1500;
    state.lastSeekAt = now();
    state.lastSeekTarget = ms;
    state.seekTarget = { ms: Math.max(0, ms), at: now(), doneAt: 0 };
    state.ourSeeksPending++;
    // 디즈니+: 탐색하면 영상 시각과 콘텐츠 시간의 차이가 바뀐다 → 새로 잴 때까지는 목표 위치를 지금 위치로 쓴다 (예전 시계로 계산하면 10초씩 어긋났다)
    if (adapter.usesPageTime) { A.resetContentTime(); A.shared.pageTime = { ms: Math.max(0, ms), at: now(), advancing: false }; dl('seek to ' + fx(ms)); }
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
  function cancelModesPending() { clearShadow(); clearEndTimer(); state.pausedFor = -1; state.holding = false; cancelDubLadder(true); stopDubPreview(); if (state.dubRec) state.dubRec.cancel = true; }
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
    if (state.loop) { if (state.loopIdx !== i) { state.loopCount = 0; const lr = loopRatesFor(); if (lr) { state.rate = lr.rates[0]; applyRate(true); } } state.loopIdx = i; }
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
    else if (!isFinite(t)) goToCue(Math.max(0, state.lastShown)); // 광고 중(TVNZ+ 처럼 본편 시간이 없는 동안): 광고 앞에서 보던 줄로
    else { const i = S.lastStartedIndex(state.cues, t); goToCue(i < 0 ? 0 : i); }
  }
  function nextCue() {
    if (!state.cues.length) return;
    const t = nowMs();
    if (state.current >= 0) goToCue(state.current + 1);
    else if (!isFinite(t)) goToCue(Math.min(state.cues.length - 1, Math.max(0, state.lastShown) + 1)); // 광고 중: 광고 앞 줄의 다음 줄로 (광고를 건너뛴다)
    else {
      let i = S.nextStartingIndex(state.cues, t);
      // 방금 D 로 옮긴 줄의 앞 여유(자막 시작 전) 동안 다시 누르면 같은 줄이 다시 잡힌다 → 그다음 줄로 (연달아 누르면 그만큼 넘어간다)
      if (i >= 0 && i === state.lastShown && now() - state.lastSeekAt < 2000) i = Math.min(state.cues.length - 1, i + 1);
      goToCue(i < 0 ? state.cues.length - 1 : i);
    }
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
  // X 반복 속도 사다리가 켜져 있을 때 반복마다 올라갈 단계 (S 일정한 속도 반복이면 없음)
  function loopRatesFor() {
    return state.loop && state.loopLadderOn ? { rates: ladderRates() } : null;
  }
  // 설정 ⚙ 의 사다리 배속 편집: 웹 설정 › 속도 사다리와 같은 값을 고친다 (더빙 ▶ 배속 연습도 같은 단계)
  function saveLadderRates(rates) {
    const clean = rates.map((x) => Math.round(clamp(+x || 1, 0.3, 2) * 100) / 100).slice(0, 6);
    saveSettings({ web: Object.assign({}, settings.web, { ladderRates: clean }) });
  }
  function renderLadderCfgExt() {
    const box = ui.form && ui.form.ladderCfg; if (!box) return;
    box.textContent = '';
    const rates = ladderRates();
    rates.forEach((r, k) => {
      box.append(el('input', { class: 'st-ladder-rate', type: 'number', min: '0.3', max: '2', step: '0.05', value: String(r), title: (k + 1) + '번째 배속 (0.3~2)', onchange: (e) => { const next = ladderRates().slice(); next[k] = +e.target.value || 1; saveLadderRates(next); } }));
    });
    if (rates.length > 1) box.append(el('button', { class: 'st-btn st-mini st-ladder-del', title: '마지막 단계 빼기', onclick: () => saveLadderRates(ladderRates().slice(0, -1)) }, '−'));
    if (rates.length < 6) box.append(el('button', { class: 'st-btn st-mini st-ladder-add', title: '단계 추가', onclick: () => { const cur = ladderRates(); saveLadderRates(cur.concat(Math.min(2, Math.round((cur[cur.length - 1] + 0.15) * 100) / 100))); } }, '+ 추가'));
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
  // S: 일정한 속도 반복 (지금 배속 그대로) · X: 반복 속도 사다리 (설정한 배속 단계대로). 반복 중 서로 누르면 모드만 바뀐다
  function stopLoop() {
    state.loop = false; state.loopIdx = -1;
    if (state.loopLadderOn && Math.abs(state.rate - state.loopBaseRate) > 0.01) { state.rate = state.loopBaseRate; applyRate(true); }
    state.loopLadderOn = false;
    toast('반복 끔');
    updateModeUI();
    renderOverlay(true);
  }
  function startLoop(ladder) {
    const i = anchorIndex();
    if (i < 0) return;
    state.loop = true; state.loopIdx = i; state.loopCount = 0; state.loopBaseRate = state.rate; state.loopLadderOn = !!ladder;
    if (ladder) { const rates = ladderRates(); state.rate = rates[0]; applyRate(true); toast('🪜 반복 속도 사다리 · ' + rates.map(rateText).join('→') + '× (배속은 ⚙ 설정에서)'); }
    else toast('🔁 이 자막 반복 · ' + rateText(state.rate) + '×');
    goToCue(i);
    updateModeUI();
    renderOverlay(true);
  }
  function toggleLoop() { // S
    if (!state.loop) { startLoop(false); return; }
    if (!state.loopLadderOn) { stopLoop(); return; }
    // 사다리 반복 중 S → 일정한 속도 반복으로 (사다리를 시작한 배속으로 되돌린다)
    state.loopLadderOn = false;
    if (Math.abs(state.rate - state.loopBaseRate) > 0.01) { state.rate = state.loopBaseRate; applyRate(true); }
    toast('🔁 이 자막 반복 · ' + rateText(state.rate) + '×');
    updateModeUI();
    renderOverlay(true);
  }
  function toggleLoopLadder() { // X
    if (!state.loop) { startLoop(true); return; }
    if (state.loopLadderOn) { stopLoop(); return; }
    // 일정 반복 중 X → 사다리 반복으로 (1단계부터)
    state.loopLadderOn = true; state.loopCount = 0;
    const rates = ladderRates(); state.rate = rates[0]; applyRate(true);
    toast('🪜 반복 속도 사다리 · ' + rates.map(rateText).join('→') + '×');
    updateModeUI();
    renderOverlay(true);
  }
  function setMode(mode, on) {
    const patch = {};
    if (mode === 'autoPause') { patch.autoPause = !!on; if (on) patch.shadowing = false; }
    else { patch.shadowing = !!on; if (on) patch.autoPause = false; }
    saveSettings(patch);
    if (!on) cancelModesPending();
    toast(mode === 'autoPause' ? (on ? '⏸ 자동 일시정지 켬 (F 다시 듣기 · Z 로 끄기)' : '자동 일시정지 끔 (Z 로 켜기)') : (on ? '🗣 따라하기 켬 · 자막이 끝나면 ' + shadowPauseText() + '만큼 쉬고 다음 자막 (W 로 끄기)' : '따라하기 끔 (W 로 켜기)'));
    updateModeUI();
  }
  function pauseFor(i) {
    state.pausedFor = i;
    state.pausedAt = now();
    state.holding = true;
    state.resumeByUsUntil = 0;
    state.pauseByUsUntil = now() + 1500;
    clearTimeout(state.ensureTimer);
    adapter.pause();
    highlightRow(i, false);
    renderOverlay(true);
    if (settings.shadowing) startShadowWait(i);
    // 멈추는 명령이 늦게 먹어(디즈니+ 등) 다음 자막으로 넘어갔으면 그 자막 끝으로 되돌린다 → 다시 재생할 때 다음 자막이 처음부터 나온다
    const c = state.cues[i];
    setTimeout(() => {
      if (!state.holding || state.pausedFor !== i || !c) return;
      const t = nowMs();
      if (isFinite(t) && t > c.end + 60) seekTo(cueVideoEndMs(c) - 40);
    }, 350);
  }
  // 따라하기(쉐도잉)에서 자막이 끝난 뒤 쉬는 시간.
  // 기본은 "그 자막이 떠 있던 시간 × 배율" — 긴 대사는 길게, 짧은 대사는 짧게 쉬므로 따로 맞출 필요가 없다.
  // ×1 이면 그 자막이 떠 있던 시간과 똑같이 쉰다 (0.3초 미만·30초 초과만 막는다).
  const SHADOW_RATIOS = [0.8, 1, 1.1, 1.2, 1.3, 1.5, 2];
  const SHADOW_MIN_MS = 300, SHADOW_MAX_MS = 30000;
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
    // 자막이 화면에 떠 있던 시간 × 배율 (0.8배속으로 보면 그만큼 길게 떠 있었으므로 쉬는 시간도 그만큼). ×1 이면 똑같은 길이로 쉰다
    const v = adapter.video();
    const rate = (v && v.playbackRate > 0) ? v.playbackRate : 1;
    return Math.round(clamp(((c.end - c.start) / rate) * shadowRatio(), SHADOW_MIN_MS, SHADOW_MAX_MS));
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
      state.holding = false;
      if (settings.shadowing && state.pausedFor === i && adapter.isPaused()) requestPlay();
      renderOverlay(true);
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
  // 브라우저는 사용자가 페이지를 누르거나 키를 치기 전에는 소리를 못 내게 한다(새로고침 직후 자동 재생 등).
  // 아무 클릭·키 입력이 있으면 그 자리에서 더빙 소리를 깨운다 — 그 뒤로는 고른 더빙이 언제나 나온다
  function unlockDubAudio() {
    if (!state.dubSegs.some((sg) => sg.chosen) && !dubModeOn()) return;
    try { dubAudioCtx(); } catch (e) { /* ignore */ }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((t) => window.addEventListener(t, unlockDubAudio, true));
  let dubLockHinted = false;
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
    updateDubToggle();
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
  // 웹의 오늘의 훈련 › "플레이어에서 더빙하기": 그 대사(영상 시간 ms)의 줄에서 더빙 칸을 연다 (탭을 막 열었으면 자막이 올 때까지 기다린다)
  async function dubAt(ms) {
    for (let k = 0; k < 60 && (!state.cues.length || !state.active); k++) await sleepMs(250);
    if (!state.cues.length) return { ok: false, error: '자막을 불러오지 못했습니다' };
    const t = ms + effectiveOffset();
    let i = S.findCueIndex(state.cues, t + 10);
    if (i < 0) i = S.nextStartingIndex(state.cues, t - 300);
    if (i < 0) i = state.cues.length - 1;
    if (!isEnabled()) setEnabled(true);
    openDubBox(i);
    return { ok: true, index: i };
  }
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
    // 칸이 패널 안에 다 보이는 동안은 목록을 움직이지 않는다 (줄을 넘길 때마다 조금씩 움직이면 정신없고 녹음 버튼을 누르기 힘들다).
    // 칸 아랫변이 패널 바닥에 닿거나 구간 첫 줄이 위로 가려졌을 때만 구간 첫 줄을 패널 맨 위로 한 번에 올린다.
    // scroll: true = 줄을 옮겼을 때(늘 적용), 'auto' = 칸 내용만 바뀌었을 때(방금 손으로 스크롤했으면 건드리지 않는다)
    if (scroll === true || (scroll === 'auto' && now() - state.userScrollAt > 4000)) {
      const L = ui.list, lr = L.getBoundingClientRect();
      const rowTop = ui.rows[i].getBoundingClientRect().top, boxBottom = ui.dubbox.getBoundingClientRect().bottom;
      if (lr.height > 0 && (rowTop < lr.top || boxBottom > lr.bottom)) L.scrollTo({ top: Math.max(0, L.scrollTop + rowTop - lr.top - 6), behavior: 'smooth' });
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
    // 디즈니+: 옮긴 직후 시계를 새로 재는 동안(최대 2.5초)에는 되감지 않는다. 예전에는 옮기기 전의 시계로 "구간 밖"이라 보고 0.5초마다 다시 옮겨,
    // 다음 줄의 첫 0.4초만 끝없이 되풀이됐다 (진단 기록 2026-10-31)
    if (adapter.usesPageTime && !A.preciseClock() && now() - state.seekingAt < 2500) return;
    const r = currentDubRange();
    if (!r) return;
    const before = raw < r.startMs - settings.leadMs - 2500;
    if ((raw >= r.endMs + settings.tailMs || before) && now() - state.lastLoopSeekAt > 500) {
      // 구간 앞에서의 되감기가 5초 안에 두 번이면 시계가 어긋난 것이다 → 더 되감지 않는다 (끝없는 되풀이를 막는 안전장치)
      if (before) {
        dubEarlySeeks = dubEarlySeeks.filter((x) => now() - x < 5000);
        if (dubEarlySeeks.length >= 2) { dlOnce('loop guard: still before the range (raw=' + fx(raw) + ')'); return; }
        dubEarlySeeks.push(now());
      }
      state.lastLoopSeekAt = now();
      dl('loop seek (' + (before ? 'before range' : 'end') + ') raw=' + fx(raw));
      seekTo(r.startMs - settings.leadMs);
    }
  }
  let dubEarlySeeks = [];
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
  // 더빙 명료도(실험적): 녹음과 나란히 크롬 음성 인식을 돌려 내 발음이 영어로 어떻게 들렸는지 받아 둔다.
  // 실패(미지원·오프라인·권한 거부)는 조용히 없던 일로 — 피드백만 빠지고 녹음은 그대로. 원본 소리는 녹음 중 꺼져 있어 섞이지 않는다
  function startDubAsr() {
    try {
      if (settings.dubAsrTest) { const o = { text: String(settings.dubAsrTest), done: true, stop() {} }; return o; } // E2E 용 가짜 인식
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return null;
      const r = new SR();
      r.lang = 'en-NZ';
      r.continuous = true;
      r.interimResults = false;
      r.maxAlternatives = 1;
      const o = { text: '', done: false, stop() { try { r.stop(); } catch (e) { o.done = true; } } };
      r.onresult = (e) => { let t = ''; for (const res of e.results) t += res[0].transcript + ' '; o.text = t.trim(); };
      r.onerror = () => { o.done = true; };
      r.onend = () => { o.done = true; };
      r.start();
      return o;
    } catch (e) { return null; }
  }
  // 저장된 녹음(1배 시간축)으로 명료도 지표를 만든다: 인식 문장과의 단어 일치율 · 내 wpm vs 원본 wpm · 0.3초 넘는 멈춤 수
  function dubFeedbackOf(asr, r, samples, sr) {
    const Au = globalThis.SubTutorAudio;
    const secs = samples.length / sr;
    const heard = (asr && asr.text) || '';
    const myWords = heard ? heard.trim().split(/\s+/).length : 0;
    const origWords = String(r.text || '').trim().split(/\s+/).filter(Boolean).length;
    const origSecs = (r.endMs - r.startMs) / 1000;
    return {
      text: heard.slice(0, 300),
      acc: heard ? S.diffWords(r.text, heard).accuracy : null,
      wpm: secs > 0.3 && myWords ? Math.round((myWords / secs) * 60) : 0,
      origWpm: origSecs > 0.3 && origWords ? Math.round((origWords / origSecs) * 60) : 0,
      pauses: Au.silenceGaps ? Au.silenceGaps(samples, sr, 300) : 0,
    };
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
    let stream = null, mr = null, mutedByUs = false, saved = null;
    try {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch (e) { throw new Error(e && e.name === 'NotAllowedError' ? '마이크 사용이 막혀 있습니다. 주소창 왼쪽 아이콘에서 마이크를 허용한 뒤 다시 누르세요' : '마이크를 열지 못했습니다 (' + ((e && (e.message || e.name)) || '') + ')'); }
      state.dubMic = stream;
      if (ui.dubbox) ui.dubbox.dataset.mic = 'open';
      if (rec.cancel) throw new Error('cancel');
      if (Math.abs(state.rate - recRate) > 0.01) { state.rate = recRate; applyRate(true); } // 고른 녹음 배속으로 재생하며 녹음한다
      // (설정) 녹음 전에 원래 소리 먼저 듣기: 같은 배속으로 원어민 목소리를 한 번 들려준 뒤 녹음한다
      if (settings.dubListenFirst) {
        rec.phase = 'listen'; renderDubBox();
        const heard = await playDubRange(r, settings.leadMs, () => !rec.cancel);
        if (rec.cancel) throw new Error('cancel');
        if (!heard) throw new Error('원래 소리를 들려주지 못했습니다');
        await sleepMs(300);
      }
      pauseByUs();
      seekTo(r.startMs - DUB_LEAD_MS);
      for (let n = 3; n >= 1; n--) { rec.phase = 'count'; rec.count = n; renderDubBox(); await sleepMs(600); if (rec.cancel) throw new Error('cancel'); }
      if (v) { v.muted = true; mutedByUs = true; } // 원래 소리를 끈다 (스피커 소리가 녹음에 섞이지 않게)
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const asr = settings.dubFeedback !== false ? startDubAsr() : null; // 명료도(실험적): 녹음과 나란히 음성 인식
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
      if (asr) { asr.stop(); for (let w = 0; w < 15 && !asr.done; w++) await sleepMs(100); } // 마지막 인식 결과를 잠깐만 기다린다
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
      const fb = asr ? dubFeedbackOf(asr, r, samples, sr) : null;
      const enc = Au.encodeClip(Au.normalize(samples, 0.9), sr, { rate: 32000, kbps: 64 });
      // clipStartMs: 이 녹음의 첫 샘플이 놓일 영상 시각 (재생은 이 값만 본다 — 나중에 자막 보정값이 바뀌어도 소리는 제자리)
      const take = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ms: Math.round((samples.length * 1000) / sr), clipStartMs: r.startMs - leadMs, format: enc.format, recRate, fb };
      await chrome.storage.local.set({ [dubAudioKey(take.id)]: { b64: Au.bytesToBase64(enc.bytes), mime: enc.mime } });
      const seg = dubSegFor(r, true);
      seg.takes.push(take);
      // 구간마다 3개까지: 넘치면 가장 오래된 것부터 지운다 (☆ 로 고른 더빙은 남긴다)
      while (seg.takes.length > DUB_MAX_TAKES) {
        let k = seg.takes.findIndex((t) => t.id !== seg.chosen);
        if (k < 0) k = 0;
        dropDubTakeAudio(seg.takes.splice(k, 1)[0].id);
      }
      // 방금 녹음한 것을 자동으로 ★ — 따로 고르지 않아도 이 구간은 최근 녹음으로 재생된다 (다른 것을 ☆ 로 고를 수 있음)
      seg.chosen = take.id;
      saved = { seg, take };
      if (settings.dubPlayback === false) saveSettings({ dubPlayback: true });
      dubBuffer(take.id);
      await saveDubs();
      chip('audio', '더빙 녹음 ' + seg.takes.length + '/' + DUB_MAX_TAKES + ' 저장 · ★ 이 구간의 더빙으로 골랐습니다' + (recRate !== 1 ? ' (' + rateText(recRate) + '배로 녹음 → 원래 속도로 맞춤)' : ''), 3000);
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
      if (dubModeOn()) {
        renderDubBox();
        if (mine) { if (saved && (settings.dubAutoPreview || settings.dubAutoNext)) afterDubTake(saved.seg, saved.take); else startDubLoop(); } // 더빙 모드면 다시 그 구간 반복
      }
      else { if (Math.abs(state.rate - prevRate) > 0.01) { state.rate = prevRate; applyRate(true); } renderDubBox(); }
    }
  }
  // 녹음 뒤 (설정에 따라) 내 녹음을 영상에 맞춰 바로 들려주고, 그다음 자막으로 넘어가 녹음 준비 (그 줄을 반복하며 ● 녹음을 기다린다)
  async function afterDubTake(seg, take) {
    if (settings.dubAutoPreview) await previewDubTake(seg, take);
    if (!dubModeOn() || state.dubRec || state.dubLadder || state.dubPreview) return;
    if (settings.dubAutoNext) {
      const j = state.dubRange[1];
      if (j < state.cues.length - 1) { openDubBox(j + 1); chip('info', '다음 자막 · ● 녹음을 누르면 녹음합니다', 2000); }
      else { chip('info', '마지막 자막입니다', 2000); startDubLoop(); }
    } else if (!settings.dubAutoPreview) startDubLoop();
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
  let dubLastRaw = NaN, dubLastCT = NaN, dubStall = 0, dubLogTick = 0, dubLastTgt = '', dubClockGen = 0, dubPendingMute = null;
  function dubTick(raw, paused) {
    const v = adapter.video();
    const rate = (v && v.playbackRate) || 1;
    // 재생 중인데 영상 위치가 그대로면 멈춘 것(버퍼링·탐색 대기)으로 본다. 판단은 영상 요소의 시계로 한다 —
    // 디즈니+ 가 알려 주는 위치는 0.5초마다 끊어서 오므로, 그것으로 판단하면 보고 사이마다 "멈춤"이 되어 더빙을 끊었다 다시 틀었다
    const ct = v ? v.currentTime : NaN;
    const same = Number.isFinite(ct) ? ct === dubLastCT : raw === dubLastRaw;
    dubStall = !paused && same ? dubStall + 1 : 0;
    dubLastRaw = raw; dubLastCT = ct;
    // 디즈니+ 는 재생 위치를 0.5초쯤 간격으로 끊어서 알려 줘, 그대로 쓰면 시각이 톱니처럼 뒤로 튄다.
    // 예전에는 그때마다 녹음을 되감아 "Na-naice to-to" 처럼 말머리가 반복됐다 → 최근 1.5초의 중앙값으로 고른 시계를 쓴다
    // 디즈니+ 시계를 새로 잡았으면(탐색 뒤) 고른 시계도 처음부터 — 예전 값과 섞으면 바로잡힌 위치가 1.5초에 걸쳐 천천히 따라온다
    if (adapter.usesPageTime && A.shared.ctMap.gen !== dubClockGen) { dubClockGen = A.shared.ctMap.gen; if (dubClock) dubClock.reset(); }
    const t = dubClock ? dubClock.update(raw, now(), paused || dubStall >= 3, rate) : raw;
    // 디즈니+: 정밀 시계(영상 요소 시각 + 차이)를 아직 못 쓰면, 사용자가 옮긴 뒤 플레이어가 새 위치를 알려 줄 때까지 예전 위치가 계속 흘러간다
    // → 그동안은 더빙을 시작하지도 이어 가지도 않는다 (정밀 시계는 옮기는 즉시 새 위치를 따라가므로 기다리지 않는다)
    // (디즈니+ 는 탐색마다 시계를 새로 잰다. 정밀 시계가 잡히기 전이라도 탐색이 끝난 뒤의 보고가 하나 오면 그것으로 시작하고, 정밀 시계가 잡히는 순간 위치를 다시 맞춘다)
    const staleAfterSeek = adapter.usesPageTime && !A.preciseClock() && state.seekingAt > 0 && state.freshReportAt < state.seekingAt && now() - state.seekingAt < 1500;
    const tgt = paused || dubStall >= 6 || staleAfterSeek ? null : dubTarget(t); // 0.24초 넘게 멈춰 있으면 더빙도 멈춘다 (영상이 다시 흐르면 그 자리부터)
    const cur = state.dubPlay;
    // 디즈니+: 우리가 옮긴 뒤 새 시계를 기다리는 동안 더빙할 구간 안이면 원래 소리를 미리 꺼 둔다 (기다리는 사이 원어민 목소리가 새어 나오지 않게).
    // 우리가 옮긴 탐색만 — 그때는 어림 시계가 옮긴 목표 위치라 믿을 만하다. 사용자가 플레이어에서 옮겼으면 어림 시계는 옮기기 전 위치라 엉뚱한 곳에서 소리를 끈다
    const ourTarget = state.seekTarget && now() - state.seekTarget.at < 3000;
    const waitMute = !!(staleAfterSeek && ourTarget && !paused && v && dubTarget(t));
    if (waitMute) { if (!dubPendingMute || dubPendingMute.v !== v) dubPendingMute = { v, restore: cur && cur.videoEl === v ? cur.restoreMuted : v.muted }; if (!v.muted) v.muted = true; }
    else if (dubPendingMute && !cur && !tgt) releasePendingMute();
    // 진단 기록: 더빙할 구간에 들고 날 때, 그리고 더빙 중에는 0.24초마다 시계 상태를 남긴다
    const tgtId = tgt ? tgt.take.id : '';
    if (tgtId !== dubLastTgt || ((cur || tgt) && ++dubLogTick % 6 === 0)) {
      const pos = cur && dubCtx ? (cur.offset + (dubCtx.currentTime - cur.ctxAt) * cur.rate) * 1000 : NaN;
      dl((tgtId !== dubLastTgt ? 'tgt ' + (tgtId || 'none') : 's') + ' raw=' + fx(raw) + ' t=' + fx(t) + ' ct=' + fx(ct * 1000) + ' p=' + (paused ? 1 : 0) + ' stall=' + dubStall + (staleAfterSeek ? ' stale' : '') +
        (cur ? ' want=' + fx(t - cur.take.clipStartMs) + ' pos=' + fx(pos) + ' miss=' + (cur.miss || 0) : '') + (v ? ' m=' + (v.muted ? 1 : 0) + ' rs=' + v.readyState : '') + (adapter.usesPageTime ? ' precise=' + (A.preciseClock() ? 1 : 0) : ''));
      dubLastTgt = tgtId;
    }
    if (!tgt) {
      if (cur) {
        const beyond = t >= cur.take.clipStartMs + cur.take.ms - 40 || t < cur.take.clipStartMs - 300;
        cur.miss = (cur.miss || 0) + 1;
        if (paused || beyond || cur.miss >= 4) {
          stopDubPlay(paused ? 'paused' : beyond ? 'beyond' : 'miss:' + (dubStall >= 6 ? 'stall' : staleAfterSeek ? 'stale' : 'nowin')); // 잠깐 빈 틱 하나로 끊었다 다시 틀면 소리가 깜빡인다
          if (waitMute) v.muted = true; // 새 시계를 기다리는 동안에는 원래 소리를 계속 꺼 둔다
        }
      }
      return;
    }
    if (cur) cur.miss = 0;
    const want = (t - tgt.take.clipStartMs) / 1000; // 녹음 안에서 지금 나와야 할 위치(초)
    if (cur && cur.take.id === tgt.take.id && dubCtx) {
      if (dubStall > 0) return; // 위치가 멈춰 있는 동안에는 맞추지 않는다 (낡은 값으로 되감지 않게)
      const pos = cur.offset + (dubCtx.currentTime - cur.ctxAt) * cur.rate;
      const d = want - pos;
      // 정말 어긋났을 때만(탐색·버퍼링) 다시 맞춘다: 큰 점프는 바로, 0.45초 넘는 어긋남은 세 번 연달아일 때. 작은 흔들림에 되감으면 같은 소리가 반복된다
      cur.off = Math.abs(d) > 0.45 ? (cur.off || 0) + 1 : 0;
      // 디즈니+ 시계가 새로 잡힌 순간에는 0.12초만 어긋나도 다시 맞춘다 (잡히기 전 어림값으로 시작했으면 그만큼 어긋나 있다)
      const clockMoved = adapter.usesPageTime && cur.gen !== A.shared.ctMap.gen;
      if (clockMoved) cur.gen = A.shared.ctMap.gen;
      if (Math.abs(d) > 1.5 || cur.off >= 3 || (clockMoved && Math.abs(d) > 0.12) || Math.abs(cur.rate - rate) > 0.01) { dubRestartsTotal++; startDubSource(tgt, want, rate, true, 'd=' + fx(d * 1000) + (clockMoved ? ' clock' : '') + (Math.abs(cur.rate - rate) > 0.01 ? ' rate' : '')); }
      else if (cur.videoEl && !cur.videoEl.muted) cur.videoEl.muted = true; // 플레이어가 소리를 되살리면 다시 끈다
      return;
    }
    if (dubStall > 0) return; // 새 더빙은 위치가 실제로 흐를 때만 시작한다 (탐색 직후 예전 위치로 잘못 시작하지 않게)
    startDubSource(tgt, want, rate, false);
  }
  function releasePendingMute() {
    const p = dubPendingMute;
    dubPendingMute = null;
    if (p && p.v) p.v.muted = p.restore;
  }
  function startDubSource(tgt, offsetSec, rate, isRestart, why) {
    const buf = dubReady.get(tgt.take.id);
    if (!buf) { dubBuffer(tgt.take.id); dlOnce('dub wait decode ' + tgt.take.id + (dubBroken.has(tgt.take.id) ? ' (broken)' : '')); return; } // 디코딩이 끝나면 다음 틱에 시작한다
    if (offsetSec >= buf.duration - 0.04) return;
    const ctx = dubAudioCtx();
    if (ctx.state !== 'running') { // 소리를 낼 수 없으면 원래 소리를 끄지 않는다 (페이지를 한 번 누르면 풀린다)
      dlOnce('dub wait audio ' + ctx.state);
      releasePendingMute(); // 내 더빙을 낼 수 없으면 원래 소리는 들려준다
      if (!dubLockHinted) { dubLockHinted = true; chip('info', '🎙 내 더빙을 들으려면 화면을 한 번 누르세요 (브라우저가 클릭 전에는 소리를 막습니다)', 6000); }
      return;
    }
    const prev = state.dubPlay;
    const v = adapter.video();
    if (prev && prev.src) { try { prev.src.stop(); } catch (e) { /* ignore */ } }
    const restoreMuted = prev && prev.videoEl === v ? prev.restoreMuted : (dubPendingMute && dubPendingMute.v === v ? dubPendingMute.restore : (v ? v.muted : false));
    dubPendingMute = null;
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
    dl('dub ' + (isRestart ? 'restart ' + (why || '') : 'start') + ' take=' + tgt.take.id + ' at=' + fx(at * 1000) + ' rate=' + rate);
    if (!isRestart) noteDubBlink(tgt.take.id);
    state.dubPlay = { seg: tgt.seg, take: tgt.take, src, ctxAt: ctx.currentTime, offset: at, rate, restoreMuted, videoEl: v, restarts, off: 0, gen: A.shared.ctMap.gen };
    if (ui.ovDub) { ui.ovDub.classList.add('on'); ui.ovDub.dataset.take = tgt.take.id; ui.ovDub.dataset.restarts = String(restarts); }
  }
  // 깜빡임 감지: 멈춘 까닭이 탐색·멈춤·구간 끝이 아닌데 1초 안에 같은 녹음을 다시 틀면 한 번의 "깜빡임"이다. 5초 안에 두 번이면 기록하고 알린다
  let dubLastStop = null, dubBlinkToastAt = -1e9;
  const dubBlinks = [];
  function noteDubBlink(takeId) {
    const s = dubLastStop, t = now();
    if (!s || s.take !== takeId || t - s.at > 1000 || /^(seek|paused|beyond)/.test(s.reason)) return;
    dubBlinks.push(t);
    while (dubBlinks.length && t - dubBlinks[0] > 5000) dubBlinks.shift();
    if (dubBlinks.length < 2) return;
    dl('FLICKER ' + dubBlinks.length + ' blinks in 5s (last stop: ' + s.reason + ')');
    if (t - dubBlinkToastAt > 60000) { dubBlinkToastAt = t; toast('🐞 내 더빙이 자꾸 끊깁니다. ⚙ 설정 › 진단 정보를 누르면 기록이 복사돼요 — 붙여 넣어 보내 주세요', 8000); }
  }
  function stopDubPlay(reason) {
    const p = state.dubPlay;
    if (!p) return;
    // 부른 곳을 기록한다 (까닭을 넘기지 않은 곳은 함수 이름으로)
    const why = reason || ((/\n[^\n]*\n\s*at (?:Object\.)?([\w$.]+)/.exec(new Error().stack || '') || [])[1] || 'other');
    dl('dub stop ' + why + ' take=' + p.take.id);
    dubLastStop = { take: p.take.id, at: now(), reason: why };
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
      withProps(el('button', { class: 'st-btn st-mini st-dub-ladder' + (L ? ' on' : ''), 'data-key': 'J', title: '설정한 단계대로 한 번씩: ' + ladderRates().map(rateText).join(' → ') + '배 (J)', onclick: runDubLadder }, L ? '◼ 멈춤' : '▶ 배속 연습'), { disabled: !!R }),
    ].concat(dubPracticeRates().map((x) => withProps(el('button', { class: 'st-dub-rate st-dub-play-rate' + (Math.abs(x - nowRate) < 0.005 ? ' on' : ''), 'data-rate': rateText(x), title: rateText(x) + '배속으로 이 구간 반복', onclick: () => setDubLoopRate(x) }, rateText(x)), { disabled: busy })))));
    // ② 녹음 · 녹음 배속
    const recRate = dubRecRate();
    const recLabel = !R ? '● 녹음' : (R.phase === 'listen' ? '듣는 중…' : (R.phase === 'count' ? String(R.count) : (R.phase === 'rec' ? '◼ 녹음 중' : (R.phase === 'save' ? '저장 중…' : '마이크…'))));
    box.append(el('div', { class: 'st-dub-step' }, [
      el('span', { class: 'st-dub-n' }, '2'),
      withProps(el('button', { class: 'st-btn st-mini st-dub-rec' + (R ? ' on' : ''), 'data-key': 'K', title: rateText(recRate) + '배속으로 녹음 (K · 원래 소리는 끄고, 다시 누르면 취소)', onclick: recordDubTake }, recLabel), { disabled: !!L || !!(R && R.phase === 'save') }),
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
            t.fb && (t.fb.acc !== null || t.fb.pauses || t.fb.wpm) ? el('span', { class: 'st-dub-fb', title: '명료도 피드백(실험적)' + (t.fb.text ? ' · 인식된 문장: "' + t.fb.text + '"' : '') + (t.fb.origWpm ? ' · 원본 ' + t.fb.origWpm + ' wpm' : '') + ' · 0.3초 넘는 멈춤 ' + t.fb.pauses + '번' }, [t.fb.acc !== null ? '일치 ' + t.fb.acc + '%' : '', t.fb.wpm ? (t.fb.acc !== null ? ' · ' : '') + t.fb.wpm + 'wpm' : '', t.fb.pauses ? ' · 멈춤 ' + t.fb.pauses : ''].join('')) : null,
            withProps(el('button', { class: 'st-btn st-mini st-dub-play' + (pv ? ' on' : ''), onclick: () => previewDubTake(seg, t) }, pv ? '◼' : '▶ 들어보기'), { disabled: busy }),
            el('button', { class: 'st-dub-star' + (chosen ? ' on' : ''), title: chosen ? '더빙 해제' : '이 녹음을 이 구간의 더빙으로 (원래 소리 대신 재생)', onclick: () => chooseDubTake(seg, t) }, chosen ? '★' : '☆'),
            withProps(el('button', { class: 'st-dub-del', title: '이 녹음 지우기', onclick: () => deleteDubTake(seg, t) }, '✕'), { disabled: busy }),
          ]);
        })),
      ]));
    }
    if (box.parentElement) placeDubBox('auto');
  }

  // ───────────── 단어 목록 (패널) ─────────────
  // 이 영상 자막의 모든 단어를 중복·이름 없이 모아 패널에 2칸으로 보여 준다. 기본은 어려운(드문) 단어부터.
  // 뜻은 기계 번역(한꺼번에 보기·단어별 보기), ☆ 로 저장하면 웹 › 단어장에서 카드로 복습한다 (망각 곡선 간격)
  const WORD_SORTS = [['hard', '어려운 단어부터'], ['easy', '쉬운 단어부터'], ['easyNoBasic', '쉬운 단어부터 (to·I 빼고)']];
  const wordMeaning = new Map(); // 단어 -> 기계 번역 뜻
  let savedWords = new Set();
  const sortWords = (list, mode) => Voc.sortWords(list, mode);
  async function loadSavedWords() {
    try { const r = await bg({ type: 'words.list' }); savedWords = new Set(((r && r.words) || []).map((w) => String(w.word).toLowerCase())); } catch (e) { /* ignore */ }
  }
  function openWordView() {
    if (!ui.wordView) return;
    if (!state.cues.length || !Voc || !Voc.wordList) { toast('자막을 불러온 뒤에 단어 목록을 볼 수 있습니다'); return; }
    if (dubModeOn()) closeDubBox();
    state.wordView = { sort: WORD_SORTS.some(([v]) => v === settings.wordSort) ? settings.wordSort : 'hard', showAll: false, shown: new Set(), list: Voc.wordList(state.cues, Freq) };
    if (!settings.panelOpen) setPanelOpen(true);
    if (ui.settings) ui.settings.classList.add('st-hidden');
    ui.list.classList.add('st-hidden');
    ui.wordView.classList.remove('st-hidden');
    renderWordView();
    loadSavedWords().then(() => { if (state.wordView) updateWordCells([...savedWords]); });
  }
  function closeWordView() {
    if (!state.wordView) return;
    state.wordView = null;
    if (!ui.wordView) return;
    ui.wordView.classList.add('st-hidden');
    ui.wordView.textContent = '';
    ui.list.classList.remove('st-hidden');
    highlightRow(state.current, true);
  }
  function toggleWordView() { if (state.wordView) closeWordView(); else openWordView(); }
  function wordCell(e) {
    const W = state.wordView;
    const shown = W.showAll || W.shown.has(e.word);
    const saved = savedWords.has(e.word);
    const m = wordMeaning.get(e.word);
    return el('div', { class: 'st-word' + (saved ? ' saved' : '') + (shown ? ' open' : ''), 'data-word': e.word, title: (e.rank ? '흔한 순서 ' + e.rank + '위' : '빈도 목록 밖 (드문 단어)') + ' · 이 영상에 ' + e.n + '번' }, [
      el('span', { class: 'st-word-w', text: e.word }),
      shown ? el('span', { class: 'st-word-m', text: m || '…' }) : el('span', { class: 'st-word-sp' }),
      el('button', { class: 'st-word-btn st-word-mean' + (shown ? ' on' : ''), title: shown ? '뜻 감추기' : '뜻 보기', onclick: () => toggleMeaning(e.word) }, '뜻'),
      el('button', { class: 'st-word-btn st-word-save' + (saved ? ' on' : ''), title: saved ? '단어장에서 빼기' : '단어장에 저장 (웹 › 단어장에서 카드로 복습)', onclick: () => toggleSaveWord(e) }, saved ? '★' : '☆'),
    ]);
  }
  // 다시 그려도 보던 자리를 지킨다 (정렬을 바꿀 때만 맨 위로)
  function renderWordView(toTop) {
    const W = state.wordView, box = ui.wordView;
    if (!W || !box) return;
    const prevGrid = box.querySelector('.st-word-grid');
    const scroll = prevGrid && !toTop ? prevGrid.scrollTop : 0;
    const list = sortWords(W.list, W.sort);
    const sortSel = el('select', { class: 'st-word-sort', title: '정렬 (to·I 빼고 = 아주 쉬운 단어 300개를 뺀 쉬운 단어부터)', onchange: (e) => { W.sort = e.target.value; saveSettings({ wordSort: W.sort }); renderWordView(true); if (W.showAll) fetchMeanings(sortWords(W.list, W.sort).map((x) => x.word)); } },
      WORD_SORTS.map(([v, t]) => withProps(el('option', { value: v }, t), { selected: W.sort === v })));
    box.textContent = '';
    box.append(
      el('div', { class: 'st-word-head' }, [
        el('b', { class: 'st-word-count', text: '단어 ' + list.length + '개' }),
        sortSel,
        el('button', { class: 'st-btn st-mini st-word-all' + (W.showAll ? ' on' : ''), title: W.showAll ? '모든 뜻 감추기' : '모든 단어의 뜻 보기 (기계 번역)', onclick: toggleAllMeanings }, W.showAll ? '뜻 감추기' : '뜻 모두 보기'),
        el('span', { class: 'st-dub-sp' }),
        infoBtn('words'),
        el('button', { class: 'st-icon st-word-close', title: '자막 목록으로', onclick: closeWordView }, '✕'),
      ]),
      el('div', { class: 'st-word-grid' }, list.map(wordCell)),
    );
    if (scroll) box.querySelector('.st-word-grid').scrollTop = scroll;
  }
  function updateWordCells(words) {
    const W = state.wordView;
    if (!W || !ui.wordView) return;
    for (const w of words) {
      const old = ui.wordView.querySelector('.st-word[data-word="' + CSS.escape(w) + '"]');
      const e = W.list.find((x) => x.word === w);
      if (old && e) old.replaceWith(wordCell(e));
    }
  }
  // 뜻: 기계 번역을 120개씩 받아 온다 (백그라운드가 40개씩 묶어 번역하고 캐시한다)
  async function fetchMeanings(words) {
    const need = words.filter((w) => !wordMeaning.has(w));
    for (let i = 0; i < need.length; i += 120) {
      const chunk = need.slice(i, i + 120);
      let r = null;
      try { r = await bg({ type: 'words.translate', words: chunk }); } catch (e) { r = null; }
      if (r && Array.isArray(r.meanings)) r.meanings.forEach((m, k) => { if (m) wordMeaning.set(chunk[k], m); });
      updateWordCells(chunk);
      if (!r || r.error) { toast((r && r.error) || '뜻을 받아 오지 못했습니다'); break; }
      if (!state.wordView) break;
    }
  }
  function toggleAllMeanings() {
    const W = state.wordView;
    if (!W) return;
    W.showAll = !W.showAll;
    if (!W.showAll) W.shown.clear();
    renderWordView();
    if (W.showAll) fetchMeanings(sortWords(W.list, W.sort).map((e) => e.word));
  }
  function toggleMeaning(w) {
    const W = state.wordView;
    if (!W) return;
    if (W.showAll) { W.showAll = false; W.shown = new Set(W.list.map((e) => e.word)); renderWordView(); }
    if (W.shown.has(w)) W.shown.delete(w); else W.shown.add(w);
    updateWordCells([w]);
    if (W.shown.has(w)) fetchMeanings([w]);
  }
  async function toggleSaveWord(e) {
    if (savedWords.has(e.word)) {
      await bg({ type: 'words.remove', word: e.word }).catch(() => {});
      savedWords.delete(e.word);
    } else {
      if (!wordMeaning.has(e.word)) await fetchMeanings([e.word]);
      const c = state.cues[e.cue];
      const card = { word: e.word, meaning: wordMeaning.get(e.word) || '', sentence: c ? c.text.replace(/\n/g, ' ') : '', sentenceKo: c ? koFor(c) : '',
        source: { platform: adapter.name, videoId: state.videoId, title: (state.meta && state.meta.title) || '', episode: (state.meta && state.meta.episode) || '', startMs: c ? Math.round(cueVideoMs(c)) : 0 } };
      const r = await bg({ type: 'words.save', card }).catch(() => null);
      if (!r || !r.ok) { toast('단어를 저장하지 못했습니다'); return; }
      savedWords.add(e.word);
    }
    updateWordCells([e.word]);
  }

  // ───────────── 메인 루프 ─────────────
  function tick(fromTimer) {
    if (!state.active) return;
    state.tickCount++;
    if (state.tickCount % 3 === 0) positionOverlay(false);
    const raw = rawMs();
    if (!isFinite(raw)) {
      // 광고 중(TVNZ+ 처럼 광고가 영상에 이어 붙은 곳은 본편 시간이 없다): 영상 위 자막을 감추고 내 더빙도 멈춘다
      if (adapter.isAdPlaying && adapter.isAdPlaying()) {
        if (state.dubPlay) stopDubPlay('ad');
        if (state.lastDisplayIdx !== -3 && ui.overlay) { state.lastDisplayIdx = -3; ui.overlay.classList.add('st-hidden'); }
      }
      return;
    }
    if (state.videoEl) state.lastCT = state.videoEl.currentTime;
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
        if (!(state.holding && state.pausedFor >= 0)) highlightRow(idx, false);
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
          const lr = loopRatesFor();
          if (lr) { const r = lr.rates[Math.min(lr.rates.length - 1, state.loopCount)]; if (Math.abs(r - state.rate) > 0.01) { state.rate = r; applyRate(true); } }
          seekTo(cueVideoMs(c) - settings.leadMs);
          if (settings.koMode === 'afterRepeat') renderOverlay(true);
        }
      } else if ((settings.autoPause || settings.shadowing) && prevIdx >= 0 && prevIdx !== idx && cues[prevIdx]) {
        const ended = cues[prevIdx];
        if (t >= ended.end - 80 && t < ended.end + 1500 && state.pausedFor !== prevIdx) pauseFor(prevIdx);
      } else if ((settings.autoPause || settings.shadowing) && fromTimer && idx >= 0 && cues[idx] && t >= cues[idx].end - 80 && state.pausedFor !== idx) {
        pauseFor(idx); // 자막 끝 바로 앞에서 멈춘다 (예전에는 다음 자막이 시작된 뒤에야 멈춰, 이어 붙은 자막에서 다음 줄이 화면에 나왔다)
      }
    }
    if (isEnabled() && dubModeOn()) dubLoopTick(raw, paused);
    if (isEnabled() && (state.dubPlay || state.dubPreview || state.dubSegs.length)) dubTick(raw, paused);
    else if (state.dubPlay) stopDubPlay('disabled');
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
  // G: 영상 위 자막 보이기/감추기 (⚙ "영상 위 자막 표시" 와 같은 설정) — 감춘 동안에도 T 를 누르고 있으면 그 줄만 잠깐 보인다
  function toggleOverlaySubs() {
    const on = !settings.overlay;
    saveSettings({ overlay: on });
    toast(on ? '자막 보임 (G 로 감추기)' : '🙈 자막 감춤 — T 를 누르고 있으면 그 줄만 잠깐 · G 로 다시 보이기', 2500);
  }
  // Shift+R: 더빙 켬/끔 (패널 맨 위 스위치와 같다 — ★ 녹음한 줄을 내 목소리로 ↔ 원래 소리)
  function toggleDubPlaybackKey() {
    const on = settings.dubPlayback === false;
    setDubPlayback(on);
    const n = state.dubSegs.filter((s) => chosenTake(s)).length;
    toast((on ? '🎙 더빙 켬 — ★ 녹음한 줄은 내 목소리' : '더빙 끔 — 원래 소리만') + (n ? '' : ' (이 영상에는 아직 더빙한 줄이 없어요)') + ' · Shift+R', 2500);
  }
  // 배치: 왼손만으로 쓰도록 하는 일이 같은 키끼리 붙여 둔다 (⌨ 단축키 목록 = lib/explain.js keys 도 같이 고칠 것)
  //   줄 이동 A·D·F | 줄 끝 동작 W·S·X·Z (따라하기·반복·사다리 반복·자동 일시정지) | 저장 E·Q
  //   자막 보기 T·G·V (위아래로 붙은 한 줄: 한국어 잠깐·자막 보이기/감추기·빈칸 공개) | 더빙·녹음은 R 키 하나에 (Shift+R 더빙 켬/끔 · Control+R 통째 MP3)
  const KEY_ACTIONS = { KeyA: prevCue, KeyD: nextCue, KeyF: replayCue, KeyW: () => setMode('shadowing', !settings.shadowing), KeyS: toggleLoop, KeyX: toggleLoopLadder, KeyZ: () => setMode('autoPause', !settings.autoPause), KeyE: saveShownCue, Enter: saveShownCue, KeyQ: toggleMissed, KeyT: () => { if (!state.koHold) { state.koHold = true; renderOverlay(true); } }, KeyG: toggleOverlaySubs, KeyV: () => { state.clozeRevealIdx = displayIndex(); renderOverlay(true); }, KeyR: () => toggleDubBox(), Backquote: () => setPanelOpen(!settings.panelOpen), BracketLeft: () => changeRate(-0.1), BracketRight: () => changeRate(0.1), Backslash: () => changeRate(0) };
  // Shift 와 함께: < 한 단계 느리게 · > 한 단계 빠르게. 단계는 설정 › 속도 사다리의 배속을 그대로 쓴다.
  // 유튜브는 Shift+< , Shift+> 가 이미 유튜브 자체 기능이라 건드리지 않는다 (두 번 적용되는 것을 막는다).
  const SHIFT_ACTIONS = RATE_UI ? { Comma: () => stepRate(-1), Period: () => stepRate(1) } : {};
  // 더빙 칸이 열려 있을 때만: J ▶ 배속 연습 · K ● 녹음 (버튼과 같다 — 한 번 더 누르면 멈춤/취소). 그 밖에서는 플레이어에 그대로 넘긴다 (유튜브는 J·K 가 자체 단축키)
  const DUB_KEYS = {
    KeyJ: () => { if (!state.dubRec) runDubLadder(); },
    KeyK: () => { if (!state.dubLadder && !(state.dubRec && state.dubRec.phase === 'save')) recordDubTake(); },
  };
  // Control+R(Mac) · Alt+R(윈도우 등 — 거기선 Ctrl+R 이 새로고침): 영상 오디오 통째 MP3 켜기/끄기.
  // 크롬 단축키로 지정돼 있으면 크롬이 먼저 받아(그때는 녹음 허용까지) 여기로는 안 온다 —
  // 지정이 안 돼 있어도 패널에서 똑같이 먹게 받아 둔다 (보호된 재생은 이 경우 "단축키를 지정하면 허용까지 한 번에" 안내)
  const isRecKey = (e) => e.code === 'KeyR' && !e.metaKey && !e.shiftKey && (IS_MAC ? (e.ctrlKey && !e.altKey) : (e.altKey && !e.ctrlKey));
  function keyAction(e) {
    if (isRecKey(e)) return recToggle;
    if (e.code === 'Comma' || e.code === 'Period') return (e.shiftKey && SHIFT_ACTIONS[e.code]) || null;
    if (e.code === 'KeyR' && e.shiftKey) return toggleDubPlaybackKey;
    if (DUB_KEYS[e.code]) return dubModeOn() ? DUB_KEYS[e.code] : null;
    return KEY_ACTIONS[e.code] || null;
  }
  function shouldHandleKey(e) {
    if (!state.active || !isEnabled()) return false;
    if (isRecKey(e)) return !(isEditable(e.target) || (e.target && e.target.closest && e.target.closest('#st-panel input, #st-panel select, #st-panel textarea')));   // 자막이 없어도 녹음은 된다
    if (!state.cues.length && !/^(Backquote|BracketLeft|BracketRight|Backslash|Comma|Period)$/.test(e.code)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isEditable(e.target) || (e.target && e.target.closest && e.target.closest('#st-panel input, #st-panel select, #st-panel textarea'))) return false;
    if (e.code === 'Enter') return e.target === document.body || e.target === document.documentElement || (e.target && e.target.tagName === 'VIDEO') ? displayIndex() >= 0 : false; // Enter 는 자막이 보일 때, 버튼 등에 포커스가 없을 때만
    return !!keyAction(e);
  }
  window.addEventListener('keydown', (e) => {
    if (state.pickOpen) { // 저장할 문장 고르는 중: Enter 저장 · Esc 취소, 다른 단축키는 상자가 닫힐 때까지 쉰다
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) (e.code === 'Escape' ? state.pickOpen.cancel : state.pickOpen.ok)();
      }
      return;
    }
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
