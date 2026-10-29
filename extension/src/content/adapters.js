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

  function scoreVideo(v) {
    return (v.readyState > 0 ? 4 : 0) + (!v.paused ? 4 : 0) + (isFinite(v.duration) && v.duration > 0 ? 2 : 0) + (v.currentTime > 0 ? 1 : 0) + Math.min(1, (v.clientWidth * v.clientHeight) / 1e6);
  }
  function pickVideo(list) {
    const vids = list || Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    if (vids.length === 1) return vids[0];
    return vids.map((v) => ({ v, score: scoreVideo(v) })).sort((a, b) => b.score - a.score)[0].v;
  }
  const findButton = (root, re) => Array.from((root || document).querySelectorAll('button, [role="button"]')).find((b) => re.test((b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()));

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
    nativeHideCss: '.player-timedtext { visibility: hidden !important; }',
    controlBars: ['[data-uia="controls-standard"]', '[data-uia="timeline"]'],
    layoutCss: 'html.st-panel-open .watch-video { width: calc(100vw - var(--st-panel-w, 400px)) !important; }',
    nativeCueSelector: '.player-timedtext-text-container',
    controlAnchor() { return document.querySelector('[data-uia="control-audio-subtitle"]'); },
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
    controlBars: ['.atvwebplayersdk-episode-timing-container', '.atvwebplayersdk-bottompanel-container'],
    layoutCss: '',
    nativeCueSelector: '.atvwebplayersdk-captions-text',
    controlAnchor() {
      const root = this.playerRoot();
      return findButton(root, /자막|subtitle|audio|오디오|字幕|音声/i) || findButton(root, /전체 ?화면|full ?screen|全画面/i);
    },
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
      return p.ms + (p.advancing ? performance.now() - p.at : 0);
    },
    isPaused() { const v = this.video(); return v ? v.paused : !shared.pageTime.advancing; },
    seek(ms) { page.send({ type: 'seek', ms: Math.max(0, Math.round(ms)) }); },
    play() { page.send({ type: 'play' }); },
    pause() { page.send({ type: 'pause' }); },
    nativeHideCss: '.dss-subtitle-renderer-wrapper, .dss-subtitle-renderer-cue-window { visibility: hidden !important; }',
    controlBars: ['.controls__footer', '[data-testid="player-controls"]', '.btm-media-overlays-container .controls'],
    layoutCss: '',
    nativeCueSelector: '.dss-subtitle-renderer-cue',
    controlAnchor() { return findButton(document, /subtitle|자막|audio|오디오|字幕/i) || null; },
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
    layoutCss: 'html.st-panel-open ytd-app { margin-right: var(--st-panel-w, 400px); } html.st-panel-open #masthead-container { width: calc(100% - var(--st-panel-w, 400px)) !important; } ytd-app:fullscreen { margin-right: 0 !important; }',
    nativeCueSelector: '.ytp-caption-segment',
    controlAnchor() { return document.querySelector('#movie_player .ytp-subtitles-button') || document.querySelector('#movie_player .ytp-settings-button'); },
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
    if (/(^|\.)netflix\.com$/.test(h)) return netflix;
    if (/(^|\.)primevideo\.com$/.test(h) || /(^|\.)amazon\.(com|co\.uk|co\.jp|de|com\.au)$/.test(h)) return prime;
    if (/(^|\.)disneyplus\.com$/.test(h)) return disney;
    if (h === 'www.youtube.com' || h === 'youtube.com' || h === 'm.youtube.com') return youtube;
    return null;
  }

  return { shared, page, detect, pickVideo, findButton };
})();
