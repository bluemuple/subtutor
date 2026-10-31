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
        if (found) { playerVideo = video; return found; }
        fiber = fiber.return;
      }
    }
    return undefined;
  }
  const contentTime = (p) => { const ms = p && p.timeline && p.timeline.info && p.timeline.info.playheadPositionMs; return typeof ms === 'number' && isFinite(ms) ? ms : undefined; };

  let cached;
  let playerVideo = null; // 플레이어를 찾은 <video> (위치를 읽은 바로 그 순간의 영상 시각을 같이 보낸다)
  let advancing = false;
  // 진단용: 플레이어 이벤트가 실제로 몇 번 왔는지 (t=TIMECODE p=멈춤 r=다시 재생 s=시작 k=탐색 c=탐색 끝). 실제 디즈니+ 에서 이 이벤트가 오는지 확인할 수 없어 같이 보낸다
  const evc = { t: 0, p: 0, r: 0, s: 0, k: 0, c: 0 };
  function sendTime(p, adv) {
    const ms = contentTime(p);
    if (ms === undefined) return;
    post({ type: 'time', platform: 'disney', ms, advancing: adv, evc });
  }
  function player() {
    if (isPlayer(cached)) return cached;
    cached = findPlayer();
    if (cached && typeof cached.on === 'function') {
      try {
        cached.on('@EVENT/PLAYER/TIMECODE', () => { evc.t++; sendTime(cached, advancing); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_PAUSED', () => { evc.p++; advancing = false; sendTime(cached, false); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_RESUMED', () => { evc.r++; advancing = true; sendTime(cached, true); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_STARTED', () => { evc.s++; advancing = true; sendTime(cached, true); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_SEEKING', () => { evc.k++; sendTime(cached, false); });
        cached.on('@EVENT/PLAYER/PLAYBACK/MEDIA_SEEK_COMPLETE', () => { evc.c++; sendTime(cached, advancing); post({ type: 'seeked', platform: 'disney' }); });
      } catch (e) { /* ignore */ }
      sendTime(cached, advancing);
    }
    return cached;
  }
  // 이벤트가 드물 때를 대비한 주기적 시간 전송
  setInterval(() => { const p = isPlayer(cached) ? cached : null; if (p) sendTime(p, advancing); }, 500);
  // 위치 값이 바뀌는 순간을 잡아 보낸다. 플레이어의 위치 값은 띄엄띄엄(계단으로) 바뀌어 바뀐 바로 그때가 가장 정확한데,
  // 일정한 0.5초 간격으로만 읽으면 계단과 박자가 맞물려 늘 같은 만큼(최대 0.5초) 늦은 값만 읽게 된다 → 0.04초마다 보고, 바뀌었으면 그 순간의 영상 시각과 함께 보낸다
  let lastPolled, lastEdgeAt = 0;
  setInterval(() => {
    const p = isPlayer(cached) ? cached : null;
    if (!p) return;
    const ms = contentTime(p);
    if (ms === undefined || ms === lastPolled) return;
    const first = lastPolled === undefined;
    lastPolled = ms;
    const t = performance.now();
    if (first || t - lastEdgeAt < 200) return; // 매끈하게 바뀌는 값이면 0.2초에 한 번이면 충분하다
    lastEdgeAt = t;
    const v = playerVideo && playerVideo.isConnected ? playerVideo : null;
    post({ type: 'time', platform: 'disney', ms, advancing: advancing || !!(v && !v.paused), evc, edge: 1, ct: v ? v.currentTime * 1000 : undefined });
  }, 40);

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
