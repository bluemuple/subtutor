/*
 * SubTutor – 디즈니+ 페이지 스크립트 (MAIN world, document_start)
 * - 재생 응답 JSON에서 HLS 마스터 플레이리스트 URL과 제목을 잡아 콘텐츠 스크립트에 넘긴다.
 * - 디즈니+는 video.currentTime이 MediaSource 기준 상대 시간이라 쓸 수 없다. <video> 위의 React 트리에서
 *   플레이어 객체(seek/scrub/play/pause, timeline.info.playheadPositionMs)를 찾아 실제 콘텐츠 시간으로 제어한다.
 */
(() => {
  'use strict';
  if (window.__subtutorDisney) return;
  window.__subtutorDisney = true;

  const post = (msg) => { try { window.postMessage(Object.assign({ __subtutor: 'page' }, msg), '*'); } catch (e) { /* ignore */ } };
  let masterUrl = '';
  let metaInfo = null;

  function processParsed(value) {
    try {
      if (value && value.stream && Array.isArray(value.stream.sources) && value.stream.sources.length) {
        const url = value.stream.sources[0].complete && value.stream.sources[0].complete.url;
        if (url && url !== masterUrl) { masterUrl = url; post({ type: 'master', platform: 'disney', url: masterUrl }); }
      }
      const pe = value && value.data && value.data.playerExperience;
      if (pe && pe.title) {
        metaInfo = { title: String(pe.title), episode: pe.subtitle ? String(pe.subtitle) : '' };
        post({ type: 'meta', platform: 'disney', meta: metaInfo });
      }
    } catch (e) { /* ignore */ }
  }
  const origParse = JSON.parse;
  JSON.parse = function () {
    const value = origParse.apply(this, arguments);
    processParsed(value);
    return value;
  };
  try {
    const origJson = Response.prototype.json;
    Response.prototype.json = function () {
      return origJson.call(this).then((value) => { processParsed(value); return value; });
    };
  } catch (e) { /* ignore */ }

  // --- 플레이어 객체 찾기 ---
  const isPlayer = (v) => v && typeof v === 'object' && typeof v.seek === 'function' && typeof v.scrub === 'function' && typeof v.play === 'function' && typeof v.pause === 'function';
  function playerFromObject(value) {
    if (!value || typeof value !== 'object') return undefined;
    let keys;
    try { keys = Object.keys(value); } catch (e) { return undefined; }
    for (const key of keys.slice(0, 60)) {
      let c;
      try { c = value[key]; } catch (e) { continue; }
      if (isPlayer(c)) return c;
    }
    return undefined;
  }
  function findPlayer() {
    for (const video of document.querySelectorAll('video')) {
      let el = video, fiberKey, host;
      while (el) {
        fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (fiberKey) { host = el; break; }
        el = el.parentElement;
      }
      if (!fiberKey) continue;
      let fiber = host[fiberKey], steps = 0;
      while (fiber && steps < 400) {
        steps++;
        let found = playerFromObject(fiber.memoizedProps);
        if (!found) {
          let hook = fiber.memoizedState, hs = 0;
          while (hook && hs < 20 && !found) { found = playerFromObject(hook.memoizedState); hook = hook.next; hs++; }
        }
        if (!found && fiber.stateNode && typeof fiber.stateNode === 'object') found = playerFromObject(fiber.stateNode);
        if (found) return found;
        fiber = fiber.return;
      }
    }
    return undefined;
  }
  const contentTime = (p) => { const ms = p && p.timeline && p.timeline.info && p.timeline.info.playheadPositionMs; return typeof ms === 'number' && isFinite(ms) ? ms : undefined; };

  let cached;
  let advancing = false;
  function sendTime(p, adv) {
    const ms = contentTime(p);
    if (ms === undefined) return;
    post({ type: 'time', platform: 'disney', ms, advancing: adv });
  }
  function player() {
    if (isPlayer(cached)) return cached;
    cached = findPlayer();
    if (cached && typeof cached.on === 'function') {
      try {
        cached.on('@EVENT/PLAYER/TIMECODE', () => sendTime(cached, advancing));
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_PAUSED', () => { advancing = false; sendTime(cached, false); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_RESUMED', () => { advancing = true; sendTime(cached, true); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_STARTED', () => { advancing = true; sendTime(cached, true); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_SEEKING', () => sendTime(cached, false));
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_SEEK_COMPLETE', () => { sendTime(cached, advancing); post({ type: 'seeked', platform: 'disney' }); });
      } catch (e) { /* ignore */ }
      sendTime(cached, advancing);
    }
    return cached;
  }
  // 이벤트가 드물 때를 대비한 주기적 시간 전송
  setInterval(() => { const p = isPlayer(cached) ? cached : null; if (p) sendTime(p, advancing); }, 500);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutor !== 'content') return;
    const d = e.data;
    const reply = (extra) => post(Object.assign({ type: 'reply', reqId: d.reqId }, extra));
    try {
      switch (d.type) {
        case 'hello':
          if (masterUrl) post({ type: 'master', platform: 'disney', url: masterUrl });
          if (metaInfo) post({ type: 'meta', platform: 'disney', meta: metaInfo });
          player();
          break;
        case 'getMeta': reply({ meta: metaInfo }); break;
        case 'getState': { const p = player(); reply({ ok: !!p, ms: p ? contentTime(p) : undefined, advancing }); break; }
        case 'seek': { const p = player(); if (p && isFinite(d.ms)) { try { Promise.resolve(p.seek(Math.max(0, Math.round(d.ms)))).catch(() => {}); } catch (err) { /* ignore */ } } break; }
        case 'play': { const p = player(); if (p) p.play(); break; }
        case 'pause': { const p = player(); if (p) p.pause(); break; }
        case 'fetchText':
          fetch(d.url, { cache: 'no-store' }).then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then((text) => reply({ ok: true, text }), (err) => reply({ ok: false, error: String(err) }));
          break;
        default: break;
      }
    } catch (err) {
      if (d.reqId) reply({ ok: false, error: String(err) });
    }
  });

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    cached = undefined;
    post({ type: 'navigate', platform: 'disney' });
  }, 500);
})();
