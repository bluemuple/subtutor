/*
 * SubTutor – 플랫폼 어댑터 (ISOLATED world)
 * 각 플랫폼에서 "영상 ID / video 요소 / 현재 시간 / 탐색·재생·정지 / 네이티브 자막 숨기기 / 제목 / 컨트롤 바" 를 같은 모양으로 제공한다.
 */
globalThis.SubTutorAdapters = (() => {
  'use strict';

  // MAIN world 페이지 스크립트가 보내주는 시간(디즈니+)
  const shared = { pageTime: { ms: 0, at: 0, advancing: false } };

  // MAIN world 와의 요청/응답
  const page = {
    reqId: 0,
    pending: new Map(),
    send(msg) {
      try { window.postMessage(Object.assign({ __subtutor: 'content' }, msg), '*'); } catch (e) { /* ignore */ }
    },
    request(msg, timeout) {
      return new Promise((resolve, reject) => {
        const id = ++this.reqId;
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout: ' + msg.type)); }, timeout || 15000);
        this.pending.set(id, { resolve, timer });
        this.send(Object.assign({ reqId: id }, msg));
      });
    },
    handleReply(d) {
      const p = this.pending.get(d.reqId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(d.reqId);
      p.resolve(d);
    },
  };

  // 열린 shadow DOM 까지 찾는다 (디즈니+ 플레이어는 web component 안에 자막·컨트롤을 그린다). 어댑터가 deep 이면 켜진다
  const roots = { at: 0, list: [document], deep: false };
  function collectShadowRoots(start, acc, budget) {
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n && budget.n-- > 0) {
      if (n.shadowRoot && !acc.has(n.shadowRoot)) { acc.add(n.shadowRoot); collectShadowRoots(n.shadowRoot, acc, budget); }
      n = walker.nextNode();
    }
    return acc;
  }
  function deepRoots() {
    if (!roots.deep) return [document];
    const t = performance.now();
    if (t - roots.at < 1000) return roots.list;
    const acc = collectShadowRoots(document.documentElement, new Set(), { n: 20000 });
    roots.list = [document].concat(Array.from(acc));
    roots.at = t;
    return roots.list;
  }
  // from(문서 또는 요소) 안에서 selector 를 찾되, deep 이면 열린 shadow root 들도 함께 본다
  function qsaDeep(selector, from) {
    const base = from || document;
    const out = Array.from(base.querySelectorAll(selector));
    if (!roots.deep) return out;
    for (const r of deepRoots()) {
      if (r === document) continue;
      if (base !== document && !(base.contains && (base.contains(r.host) || base === r.host))) continue;
      for (const e of r.querySelectorAll(selector)) if (!out.includes(e)) out.push(e);
    }
    return out;
  }

  function scoreVideo(v) {
    return (v.readyState > 0 ? 4 : 0) + (!v.paused ? 4 : 0) + (isFinite(v.duration) && v.duration > 0 ? 2 : 0) + (v.currentTime > 0 ? 1 : 0) + Math.min(1, (v.clientWidth * v.clientHeight) / 1e6);
  }
  function pickVideo(list) {
    const vids = list || qsaDeep('video');
    if (!vids.length) return null;
    if (vids.length === 1) return vids[0];
    return vids.map((v) => ({ v, score: scoreVideo(v) })).sort((a, b) => b.score - a.score)[0].v;
  }
  // 우리 패널/오버레이 안의 버튼(예: 'AP: 자막이 끝나면…')은 플랫폼 버튼으로 오인하지 않는다
  const isOurs = (e) => !!(e.closest && e.closest('#st-panel, #st-overlay, #st-toggle, .st-ctl-wrap, .st-ctl'));
  const findButton = (root, re) => qsaDeep('button, [role="button"]', root || document).find((b) => !isOurs(b) && re.test((b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()));

  const videoTime = function () { const v = this.video(); return v ? v.currentTime * 1000 : NaN; };
  const videoPaused = function () { const v = this.video(); return v ? v.paused : true; };
  const elementPlay = function () { const v = this.video(); if (v) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } };
  const elementPause = function () { const v = this.video(); if (v) v.pause(); };
  const elementSeek = function (ms) { const v = this.video(); if (v) { try { v.currentTime = Math.max(0, ms / 1000); } catch (e) { /* ignore */ } } };

  const netflix = {
    name: 'netflix',
    label: '넷플릭스',
    usesPageTime: false,
    supportsTextTracks: false,
    videoIdFromUrl() { const m = /\/watch\/(\d+)/.exec(location.pathname); return m ? m[1] : null; },
    video() { return document.querySelector('.watch-video video') || document.querySelector('video'); },
    timeMs: videoTime,
    isPaused: videoPaused,
    seek(ms) { page.send({ type: 'seek', ms: Math.max(0, Math.round(ms)) }); },
    play() { page.send({ type: 'play' }); },
    pause() { page.send({ type: 'pause' }); },
    setRate(rate) { page.send({ type: 'setRate', rate }); },
    controlRoot() { return document.querySelector('.watch-video') || document.body; },
    nativeHideCss: '.player-timedtext { visibility: hidden !important; }',
    controlBars: ['[data-uia="controls-standard"]', '[data-uia="timeline"]'],
    layoutCss: 'html.st-panel-open:not(.st-fs-hidden) .watch-video { width: calc(100vw - var(--st-panel-w, 400px)) !important; }',
    fitVideo: true, // 패널이 열리면 영상(플레이어 영역)을 패널 왼쪽까지로 줄인다
    nativeCueSelector: '.player-timedtext-text-container',
    // ST 버튼은 오른쪽 묶음의 맨 왼쪽(다음 회차 버튼 왼쪽)에 둔다. 영화처럼 다음 회차가 없으면 그다음 버튼 앞
    controlAnchor() { return ['control-next', 'control-episodes', 'control-audio-subtitle', 'control-speed', 'control-fullscreen-enter'].map((k) => document.querySelector('[data-uia="' + k + '"]')).find(Boolean) || null; },
    controlPlace: 'before',
    domTitle() {
      const el = document.querySelector('[data-uia="video-title"]');
      if (!el) return null;
      const h4 = el.querySelector('h4');
      const spans = Array.from(el.querySelectorAll('span')).map((s) => s.textContent.trim()).filter(Boolean);
      const title = h4 ? h4.textContent.trim() : (spans.shift() || '');
      return title ? { title, episode: spans.join(' ') } : null;
    },
    pageUrl(videoId) { return 'https://www.netflix.com/watch/' + videoId; },
  };

  const prime = {
    name: 'prime',
    label: '프라임 비디오',
    usesPageTime: false,
    supportsTextTracks: true,
    videoIdFromUrl() {
      const m = /\/(?:detail|gp\/video\/detail)\/([A-Z0-9]{8,})/i.exec(location.pathname);
      return m ? m[1] : null;
    },
    playerRoot() { return document.getElementById('dv-web-player') || document.body; },
    controlRoot() { return document.getElementById('dv-web-player') || document.body; },
    // 플레이어 오버레이가 닫히면(상세/메인 페이지) video 요소가 남아 있어도 비활성으로 본다
    isPlayerActive(v) {
      const root = document.getElementById('dv-web-player');
      if (!root || !v || !root.contains(v)) return false;
      const r = root.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) return false;
      const cs = getComputedStyle(root);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    },
    video() {
      // 상세 페이지의 예고편 플레이어가 아니라 본편 플레이어(#dv-web-player)의 video 를 쓴다
      const inPlayer = Array.from(document.querySelectorAll('#dv-web-player video'));
      return inPlayer.length ? pickVideo(inPlayer) : pickVideo();
    },
    timeMs: videoTime,
    isPaused: videoPaused,
    seek: elementSeek,
    showControls() {
      const root = this.playerRoot();
      const ev = (x, y) => new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y });
      root.dispatchEvent(ev(400 + Math.round(Math.random() * 40), 300));
      document.dispatchEvent(ev(420, 310));
    },
    playPauseButton() { return findButton(this.playerRoot(), /^(play|pause|재생|일시 ?정지|再生|一時停止|播放|暂停)$/i); },
    clickPlayPause() {
      this.showControls();
      setTimeout(() => { const b = this.playPauseButton(); if (b) b.click(); }, 80);
    },
    // 프라임 플레이어는 자기 상태와 다른 외부 play()를 되돌리는 경우가 있어, 안 되면 플레이어의 버튼을 눌러 준다
    play() {
      const v = this.video();
      if (!v) return;
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      setTimeout(() => { if (this.video() === v && v.paused) this.clickPlayPause(); }, 600);
    },
    pause() {
      const v = this.video();
      if (!v) return;
      v.pause();
      setTimeout(() => { if (this.video() === v && !v.paused) this.clickPlayPause(); }, 600);
    },
    nativeHideCss: '.atvwebplayersdk-captions-overlay, .atvwebplayersdk-captions-text { visibility: hidden !important; }',
    controlBars: ['.atvwebplayersdk-episode-timing-container', '.atvwebplayersdk-bottompanel-container', '.atvwebplayersdk-seekbar-container'],
    layoutCss: 'html.st-panel-open:not(.st-fs-hidden) #dv-web-player { width: calc(100vw - var(--st-panel-w, 400px)) !important; }',
    fitVideo: true,
    nativeCueSelector: '.atvwebplayersdk-captions-text',
    controlAnchor() {
      const root = this.playerRoot();
      return findButton(root, /자막|subtitle|audio|오디오|字幕|音声/i) || findButton(root, /전체 ?화면|full ?screen|全画面/i);
    },
    controlPlace: 'groupStart',
    domTitle() {
      const t = document.querySelector('.atvwebplayersdk-title-text');
      const s = document.querySelector('.atvwebplayersdk-subtitle-text');
      if (t && t.textContent.trim()) return { title: t.textContent.trim(), episode: s ? s.textContent.trim() : '' };
      const dt = document.title.replace(/^(Prime Video|프라임 비디오|Amazon\.com|Amazon\.co\.uk|Amazon\.co\.jp|Amazon\.de|Amazon\.com\.au)\s*:\s*/i, '').replace(/\s*[-|]\s*Prime Video$/i, '').trim();
      return dt ? { title: dt, episode: '' } : null;
    },
    pageUrl() { return location.origin + location.pathname + '?autoplay=1'; },
  };

  const disney = {
    name: 'disney',
    label: '디즈니+',
    usesPageTime: true,
    supportsTextTracks: false,
    videoIdFromUrl() { const m = /\/(?:play|video)\/([^/?#]+)/.exec(location.pathname); return m ? m[1] : null; },
    video: () => pickVideo(),
    timeMs() {
      const p = shared.pageTime;
      if (!p.at) return NaN;
      if (!p.advancing) return p.ms;
      // 보고 사이를 이어 붙일 때 배속을 곱한다 — 0.5배로 재생하면 위치도 0.5배로 흐른다 (예전에는 1배로 가정해 앞서 갔다가 되돌아왔다)
      const v = pickVideo();
      const rate = v && v.playbackRate > 0 ? v.playbackRate : 1;
      return p.ms + (performance.now() - p.at) * rate;
    },
    isPaused() { const v = this.video(); return v ? v.paused : !shared.pageTime.advancing; },
    seek(ms) { page.send({ type: 'seek', ms: Math.max(0, Math.round(ms)) }); },
    play() { page.send({ type: 'play' }); },
    pause() { page.send({ type: 'pause' }); },
    deep: true, // 자막·컨트롤이 disney-web-player 요소의 열린 shadow DOM 안에 있다
    nativeHideCss: '.dss-subtitle-renderer-wrapper, .dss-subtitle-renderer-cue-window, .hive-subtitle-renderer-wrapper, .hive-subtitle-renderer-cue-positioning-box, .hive-subtitle-renderer-cue-window, timed-text-override-region, .timed-text-override-region, #timed-text-override-region, .TimedTextOverlay { visibility: hidden !important; opacity: 0 !important; }',
    controlBars: ['.controls__footer', '[data-testid="player-controls"]', '.btm-media-overlays-container .controls', '[class*="controls-footer"]', '[class*="progress-bar"]', '[class*="scrubber"]'],
    layoutCss: 'html.st-panel-open:not(.st-fs-hidden) .video_view--theater { width: calc(100vw - var(--st-panel-w, 400px)) !important; left: 0 !important; right: auto !important; }',
    fitVideo: true,
    nativeCueSelector: '.hive-subtitle-renderer-cue-window, .dss-subtitle-renderer-cue, .TimedTextOverlay',
    // 오른쪽 묶음(experience-controls: 라이브 가이드·음소거·설정·전체 화면)의 맨 왼쪽. 설정 메뉴 안의 '자막' 버튼은 앵커로 쓰지 않는다
    controlAnchor() { return findButton(document, /full ?screen|전체 ?화면/i) || findButton(document, /^(settings|설정)$/i) || findButton(document, /mute|음소거/i) || null; },
    controlPlace: 'groupStart',
    domTitle() {
      const t = document.querySelector('.title-field, [data-testid="title"]');
      const s = document.querySelector('.subtitle-field, [data-testid="subtitle"]');
      if (t && t.textContent.trim()) return { title: t.textContent.trim(), episode: s ? s.textContent.trim() : '' };
      const dt = document.title.replace(/\s*[|–-]\s*Disney\+.*$/i, '').trim();
      return dt && !/^Disney\+?$/i.test(dt) ? { title: dt, episode: '' } : null;
    },
    pageUrl(videoId) { return 'https://www.disneyplus.com/play/' + videoId; },
  };

  const youtube = {
    name: 'youtube',
    label: '유튜브',
    usesPageTime: false,
    supportsTextTracks: false,
    videoIdFromUrl() {
      if (location.pathname !== '/watch') return null;
      return new URLSearchParams(location.search).get('v');
    },
    video() { return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video'); },
    timeMs: videoTime,
    isPaused: videoPaused,
    seek: elementSeek,
    play: elementPlay,
    pause: elementPause,
    isAdPlaying() { const mp = document.getElementById('movie_player'); return !!(mp && mp.classList.contains('ad-showing')); },
    controlRoot() { return document.getElementById('movie_player') || document.body; },
    nativeHideCss: '.ytp-caption-window-container, .caption-window { visibility: hidden !important; }',
    controlBars: [],
    clearance(rect) {
      const mp = document.getElementById('movie_player');
      if (!mp || mp.classList.contains('ytp-autohide')) return 0;
      const bar = mp.querySelector('.ytp-chrome-bottom');
      if (!bar) return 0;
      const r = bar.getBoundingClientRect();
      return r.height > 0 && r.top > rect.top ? Math.max(0, Math.round(rect.bottom - r.top)) + 8 : 0;
    },
    // 패널은 페이지를 밀지 않고 오른쪽 추천 영상 영역 위에 겹친다. 마스트헤드(검색창)는 가리지 않고, 전체화면에서는 맨 위부터
    layoutCss: 'html:not(:fullscreen) #st-panel.st-pf-youtube { top: 56px; }',
    fitVideo: false,
    // 오른쪽 추천 영상 칸(#secondary)을 통째로 덮는 너비. 극장 모드처럼 칸이 아래로 내려가면 기본 400
    panelWidth() {
      const sec = document.querySelector('ytd-watch-flexy #secondary, #secondary');
      if (!sec) return 400;
      const r = sec.getBoundingClientRect();
      if (r.width < 100 || r.left < window.innerWidth * 0.5) return 400;
      return Math.ceil(window.innerWidth - r.left) + 2;
    },
    nativeCueSelector: '.ytp-caption-segment',
    controlAnchor() { const rc = document.querySelector('#movie_player .ytp-right-controls'); return (rc && rc.firstElementChild) || document.querySelector('#movie_player .ytp-subtitles-button'); },
    controlPlace: 'before',
    domTitle() {
      const h = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, h1.title yt-formatted-string');
      const ch = document.querySelector('#owner ytd-channel-name a, ytd-video-owner-renderer ytd-channel-name a');
      const title = (h && h.textContent.trim()) || document.title.replace(/\s*-\s*YouTube$/, '').trim();
      return title && title !== 'YouTube' ? { title, episode: ch ? ch.textContent.trim() : '' } : null;
    },
    pageUrl(videoId) { return 'https://www.youtube.com/watch?v=' + videoId; },
  };

  function detect() {
    const h = location.hostname;
    let a = null;
    if (/(^|\.)netflix\.com$/.test(h)) a = netflix;
    else if (/(^|\.)primevideo\.com$/.test(h) || /(^|\.)amazon\.(com|co\.uk|co\.jp|de|com\.au)$/.test(h)) a = prime;
    else if (/(^|\.)disneyplus\.com$/.test(h)) a = disney;
    else if (h === 'www.youtube.com' || h === 'youtube.com' || h === 'm.youtube.com') a = youtube;
    roots.deep = !!(a && a.deep);
    return a;
  }

  return { shared, page, detect, pickVideo, findButton, qsaDeep, deepRoots };
})();
