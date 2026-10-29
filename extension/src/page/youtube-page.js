/*
 * SubTutor – 유튜브 페이지 스크립트 (MAIN world, document_start)
 * 플레이어 응답(ytInitialPlayerResponse / yt-navigate-finish / youtubei player / movie_player.getPlayerResponse)에서
 * 자막 트랙 목록(captionTracks)과 제목을 꺼내 콘텐츠 스크립트에 넘긴다. 한국어 자막이 없으면 유튜브 자동 번역(tlang=ko) 트랙을 더한다.
 */
(() => {
  'use strict';
  if (window.__subtutorYT) return;
  window.__subtutorYT = true;

  const post = (msg) => { try { window.postMessage(Object.assign({ __subtutor: 'page' }, msg), '*'); } catch (e) { /* ignore */ } };
  const byVideo = new Map(); // videoId -> { tracks, meta }
  const currentId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);

  function trackName(t) {
    if (!t.name) return t.languageCode || '';
    if (t.name.simpleText) return t.name.simpleText;
    if (Array.isArray(t.name.runs)) return t.name.runs.map((r) => r.text).join('');
    return t.languageCode || '';
  }
  function handlePlayerResponse(pr) {
    try {
      const vd = pr && pr.videoDetails;
      const vid = vd && vd.videoId;
      if (!vid) return false;
      const renderer = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      const list = renderer && renderer.captionTracks;
      const tracks = [];
      if (Array.isArray(list)) {
        for (const t of list) {
          if (!t || !t.baseUrl) continue;
          const lang = String(t.languageCode || '');
          const asr = t.kind === 'asr';
          tracks.push({ id: t.vssId || (lang + (asr ? '.asr' : '')), lang, label: trackName(t) + (asr ? ' (자동 생성)' : ''), cc: false, forced: false, asr, url: t.baseUrl + '&fmt=json3', format: asr ? 'json3-asr' : 'json3' });
        }
      }
      const hasKo = tracks.some((t) => /^ko/i.test(t.lang));
      const canTranslate = renderer && Array.isArray(renderer.translationLanguages) && renderer.translationLanguages.some((l) => l && l.languageCode === 'ko');
      const base = tracks.find((t) => /^en/i.test(t.lang) && !t.asr) || tracks.find((t) => /^en/i.test(t.lang)) || tracks.find((t) => !t.asr) || tracks[0];
      if (!hasKo && canTranslate && base) {
        tracks.push({ id: base.id + '.tlang-ko', lang: 'ko', label: '한국어 (유튜브 자동 번역)', cc: false, forced: false, asr: base.asr, translated: true, url: base.url + '&tlang=ko', format: base.format });
      }
      const meta = { title: String(vd.title || ''), episode: String(vd.author || '') };
      const prev = byVideo.get(vid);
      byVideo.set(vid, { tracks, meta });
      if (vid === currentId() && (!prev || JSON.stringify(prev.tracks.map((t) => t.id)) !== JSON.stringify(tracks.map((t) => t.id)))) announce(vid);
      return true;
    } catch (e) { return false; }
  }
  function announce(vid) {
    const e = byVideo.get(vid);
    if (!e) return;
    post({ type: 'tracks', platform: 'youtube', videoId: vid, tracks: e.tracks });
    if (e.meta.title) post({ type: 'meta', platform: 'youtube', videoId: vid, meta: e.meta });
  }
  function fromPlayerApi() {
    try {
      const mp = document.getElementById('movie_player');
      const pr = mp && typeof mp.getPlayerResponse === 'function' ? mp.getPlayerResponse() : null;
      if (pr && pr.videoDetails && pr.videoDetails.videoId === currentId()) return handlePlayerResponse(pr);
    } catch (e) { /* ignore */ }
    return false;
  }
  const tryInitial = () => { try { if (window.ytInitialPlayerResponse) handlePlayerResponse(window.ytInitialPlayerResponse); } catch (e) { /* ignore */ } };
  tryInitial();
  document.addEventListener('DOMContentLoaded', tryInitial);
  window.addEventListener('load', tryInitial);
  document.addEventListener('yt-navigate-finish', (e) => {
    try {
      const d = e.detail || {};
      const pr = (d.response && (d.response.playerResponse || (d.response.response && d.response.response.playerResponse))) || null;
      if (pr) handlePlayerResponse(pr);
      const id = currentId();
      if (id && byVideo.has(id)) announce(id);
    } catch (err) { /* ignore */ }
  });
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/youtubei\/v1\/player(\?|$)/.test(url)) p.then((r) => r.clone().json().then(handlePlayerResponse, () => {}), () => {});
    } catch (e) { /* ignore */ }
    return p;
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutor !== 'content') return;
    const d = e.data;
    const reply = (extra) => post(Object.assign({ type: 'reply', reqId: d.reqId }, extra));
    try {
      switch (d.type) {
        case 'hello': { const id = currentId(); if (id && !byVideo.has(id)) fromPlayerApi(); if (id) announce(id); break; }
        case 'getTracks': { const id = String(d.videoId || currentId() || ''); if (!byVideo.has(id)) fromPlayerApi(); reply({ tracks: byVideo.has(id) ? byVideo.get(id).tracks : null }); break; }
        case 'getMeta': { const id = String(d.videoId || currentId() || ''); if (!byVideo.has(id)) fromPlayerApi(); reply({ meta: byVideo.has(id) ? byVideo.get(id).meta : null }); break; }
        case 'fetchText':
          origFetch.call(window, d.url, { credentials: 'include' }).then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then((text) => reply({ ok: true, text }), (err) => reply({ ok: false, error: String(err) }));
          break;
        default: break;
      }
    } catch (err) {
      if (d.reqId) reply({ ok: false, error: String(err) });
    }
  });

  let lastHref = location.href;
  setInterval(() => {
    const id = currentId();
    if (location.href !== lastHref) {
      lastHref = location.href;
      post({ type: 'navigate', platform: 'youtube', videoId: id });
      if (id && byVideo.has(id)) announce(id);
    }
    if (id && !byVideo.has(id)) fromPlayerApi();
  }, 700);
})();
