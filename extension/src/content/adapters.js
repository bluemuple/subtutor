/*
 * SubTutor – 플랫폼 어댑터 (ISOLATED world)
 * 각 플랫폼에서 "영상 ID / video 요소 / 현재 시간 / 탐색·재생·정지 / 네이티브 자막 숨기기 / 제목" 을 같은 모양으로 제공한다.
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

  function pickVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    if (vids.length === 1) return vids[0];
    const scored = vids.map((v) => ({
      v,
      score: (v.readyState > 0 ? 4 : 0) + (!v.paused ? 4 : 0) + (isFinite(v.duration) && v.duration > 0 ? 2 : 0) + (v.currentTime > 0 ? 1 : 0) + Math.min(1, (v.clientWidth * v.clientHeight) / 1e6),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].v;
  }

  const videoTime = function () { const v = this.video(); return v ? v.currentTime * 1000 : NaN; };
  const videoPaused = function () { const v = this.video(); return v ? v.paused : true; };

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
    container() {
      const v = this.video();
      return document.querySelector('.watch-video--player-view') || (v && v.parentElement) || document.body;
    },
    nativeHideCss: '.player-timedtext { visibility: hidden !important; }',
    controlBars: ['[data-uia="controls-standard"]', '[data-uia="timeline"]'],
    layoutCss: 'html.st-panel-open .watch-video { width: calc(100vw - var(--st-panel-w, 400px)) !important; }',
    nativeCueSelector: '.player-timedtext-text-container',
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
    video: pickVideo,
    timeMs: videoTime,
    isPaused: videoPaused,
    seek(ms) { const v = this.video(); if (v) { try { v.currentTime = Math.max(0, ms / 1000); } catch (e) { /* ignore */ } } },
    play() { const v = this.video(); if (v) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } },
    pause() { const v = this.video(); if (v) v.pause(); },
    container() { const v = this.video(); return (v && v.parentElement) || document.body; },
    nativeHideCss: '.atvwebplayersdk-captions-overlay, .atvwebplayersdk-captions-text { visibility: hidden !important; }',
    controlBars: ['.atvwebplayersdk-bottompanel-container', '.atvwebplayersdk-seekbar-container'],
    layoutCss: '',
    nativeCueSelector: '.atvwebplayersdk-captions-text',
    domTitle() {
      const t = document.querySelector('.atvwebplayersdk-title-text');
      const s = document.querySelector('.atvwebplayersdk-subtitle-text');
      if (t && t.textContent.trim()) return { title: t.textContent.trim(), episode: s ? s.textContent.trim() : '' };
      const dt = document.title.replace(/^(Prime Video|Amazon\.com|Amazon\.co\.uk|Amazon\.co\.jp|Amazon\.de|Amazon\.com\.au)\s*:\s*/i, '').replace(/\s*[-|]\s*Prime Video$/i, '').trim();
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
    video: pickVideo,
    timeMs() {
      const p = shared.pageTime;
      if (!p.at) return NaN;
      return p.ms + (p.advancing ? performance.now() - p.at : 0);
    },
    isPaused() { const v = this.video(); return v ? v.paused : !shared.pageTime.advancing; },
    seek(ms) { page.send({ type: 'seek', ms: Math.max(0, Math.round(ms)) }); },
    play() { page.send({ type: 'play' }); },
    pause() { page.send({ type: 'pause' }); },
    container() { const v = this.video(); return (v && v.parentElement) || document.body; },
    nativeHideCss: '.dss-subtitle-renderer-wrapper, .dss-subtitle-renderer-cue-window { visibility: hidden !important; }',
    controlBars: ['.controls__footer', '[data-testid="player-controls"]', '.btm-media-overlays-container .controls'],
    layoutCss: '',
    nativeCueSelector: '.dss-subtitle-renderer-cue',
    domTitle() {
      const t = document.querySelector('.title-field, [data-testid="title"]');
      const s = document.querySelector('.subtitle-field, [data-testid="subtitle"]');
      if (t && t.textContent.trim()) return { title: t.textContent.trim(), episode: s ? s.textContent.trim() : '' };
      const dt = document.title.replace(/\s*[|–-]\s*Disney\+.*$/i, '').trim();
      return dt && !/^Disney\+?$/i.test(dt) ? { title: dt, episode: '' } : null;
    },
    pageUrl(videoId) { return 'https://www.disneyplus.com/play/' + videoId; },
  };

  function detect() {
    const h = location.hostname;
    if (/(^|\.)netflix\.com$/.test(h)) return netflix;
    if (/(^|\.)primevideo\.com$/.test(h) || /(^|\.)amazon\.(com|co\.uk|co\.jp|de|com\.au)$/.test(h)) return prime;
    if (/(^|\.)disneyplus\.com$/.test(h)) return disney;
    return null;
  }

  return { shared, page, detect, pickVideo };
})();
