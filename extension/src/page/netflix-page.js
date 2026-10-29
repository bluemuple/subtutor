/*
 * SubTutor – 넷플릭스 페이지 스크립트 (MAIN world, document_start)
 * 1) 플레이어가 요청하는 manifest에 텍스트 자막 포맷을 추가하고 모든 자막 트랙의 URL을 받도록 요청을 고친다.
 * 2) manifest 응답(JSON.parse / Response.json / XHR json)에서 자막 트랙 목록을 뽑아 콘텐츠 스크립트에 넘긴다.
 * 3) 넷플릭스 플레이어 API로 탐색/재생/일시정지한다. (video.currentTime을 직접 바꾸면 넷플릭스가 오류 M7375로 멈춘다)
 * 4) manifest를 못 잡았을 때는 플레이어 상태에서 현재 트랙 URL을 찾고, 필요하면 트랙을 잠시 바꿔 URL을 받아온다.
 */
(() => {
  'use strict';
  if (window.__subtutorNetflix) return;
  window.__subtutorNetflix = true;

  const REQUEST_PROFILES = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh'];
  const FORMATS = [['webvtt-lssdh-ios8', 'vtt'], ['dfxp-ls-sdh', 'ttml'], ['imsc1.1', 'ttml'], ['simplesdh', 'ttml']];
  const manifests = new Map(); // movieId -> tracks[]

  const post = (msg) => {
    try { window.postMessage(Object.assign({ __subtutor: 'page' }, msg), '*'); } catch (e) { /* ignore */ }
  };
  const watchingId = () => (/\/watch\/(\d+)/.exec(location.pathname) || [])[1] || '';

  function firstUrl(d) {
    if (!d || typeof d !== 'object') return '';
    if (Array.isArray(d.urls)) {
      const u = d.urls.find((x) => x && (x.url || x.cdn_url));
      if (u) return String(u.url || u.cdn_url);
    }
    if (d.downloadUrls && typeof d.downloadUrls === 'object') {
      const v = Object.values(d.downloadUrls).find(Boolean);
      if (v) return String(v);
    }
    return '';
  }

  function extractTracks(result) {
    const list = Array.isArray(result.timedtexttracks) ? result.timedtexttracks : result.textTracks;
    if (!Array.isArray(list)) return null;
    const tracks = [];
    for (const t of list) {
      if (!t || t.isNoneTrack || t.hydrated === false) continue;
      const dl = t.ttDownloadables || t.downloadables;
      if (!dl || typeof dl !== 'object') continue;
      let url = '', format = '';
      for (const [key, kind] of FORMATS) {
        const u = firstUrl(dl[key]);
        if (u) { url = u; format = kind; break; }
      }
      if (!url) continue;
      const rawType = String(t.rawTrackType || t.trackType || '').toLowerCase();
      tracks.push({
        id: String(t.new_track_id || t.id || (t.language + '-' + tracks.length)),
        lang: String(t.language || t.bcp47 || ''),
        label: String(t.languageDescription || t.displayName || t.language || ''),
        cc: rawType === 'closedcaptions',
        forced: !!t.isForcedNarrative,
        url,
        format,
      });
    }
    return tracks;
  }

  function announce(id) {
    const tracks = manifests.get(id);
    if (tracks) post({ type: 'tracks', platform: 'netflix', videoId: id, tracks });
  }

  function inspect(value) {
    const r = value && typeof value === 'object' ? (value.result && typeof value.result === 'object' ? value.result : value) : null;
    if (!r) return;
    if (!Array.isArray(r.timedtexttracks) && !Array.isArray(r.textTracks)) return;
    const id = String(r.movieId || '');
    if (!id) return;
    const tracks = extractTracks(r);
    if (!tracks || !tracks.length) return;
    manifests.set(id, tracks);
    if (id === watchingId()) announce(id);
  }

  // --- manifest 응답 가로채기 ---
  const origParse = JSON.parse;
  JSON.parse = function (text) {
    const value = origParse.apply(this, arguments);
    try {
      if (typeof text === 'string' && text.length > 500 && (text.indexOf('timedtexttracks') !== -1 || text.indexOf('textTracks') !== -1)) inspect(value);
    } catch (e) { /* 페이지를 깨뜨리지 않는다 */ }
    return value;
  };
  try {
    const origJson = Response.prototype.json;
    Response.prototype.json = function () {
      return origJson.apply(this, arguments).then((value) => {
        try { inspect(value); } catch (e) { /* ignore */ }
        return value;
      });
    };
  } catch (e) { /* ignore */ }
  try {
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', () => {
          try { if (this.responseType === 'json' && this.response) inspect(this.response); } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return xhrSend.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  // --- manifest 요청 고치기: 텍스트 자막 포맷 + 모든 트랙 하이드레이션 ---
  const origStringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      const params = value && typeof value === 'object' ? value.params : null;
      if (params && Array.isArray(params.profiles) && (params.viewableId || params.manifestVersion || /manifest/i.test(String(value.url || '')))) {
        for (const p of REQUEST_PROFILES) if (!params.profiles.includes(p)) params.profiles.push(p);
        params.showAllSubDubTracks = true;
        if (params.supportsPartialHydration) params.supportsPartialHydration = false;
      }
    } catch (e) { /* ignore */ }
    return origStringify.apply(this, arguments);
  };

  // --- 정밀 탐색: 넷플릭스 플레이어가 키프레임이 아니라 요청한 위치로 정확히 이동하도록 설정값을 켠다 ---
  try {
    Function.prototype.apply = new Proxy(Function.prototype.apply, {
      apply(target, thisArg, args) {
        try {
          if (args && args[1] && typeof args[1][0] === 'string') {
            const p = args[1][0];
            if (p === 'preciseSeeking' || p === 'preciseseeking' || p === 'preciseseekingontwocoredevice') return true;
          }
        } catch (e) { /* ignore */ }
        return Reflect.apply(target, thisArg, args);
      },
    });
  } catch (e) { /* ignore */ }

  // --- 플레이어 API ---
  function api() {
    try { return window.netflix.appContext.state.playerApp.getAPI(); } catch (e) { return null; }
  }
  function sessionId() {
    try {
      const ids = api().videoPlayer.getAllPlayerSessionIds() || [];
      if (!ids.length) return null;
      const watch = ids.filter((i) => String(i).startsWith('watch-'));
      return watch.length ? watch[watch.length - 1] : ids[ids.length - 1];
    } catch (e) { return null; }
  }
  function player() {
    try {
      const sid = sessionId();
      return sid ? api().videoPlayer.getVideoPlayerBySessionId(sid) : null;
    } catch (e) { return null; }
  }
  function state() {
    const p = player();
    if (!p) return { ok: false };
    try {
      return {
        ok: true,
        ms: p.getCurrentTime(),
        paused: !!p.isPaused(),
        ready: p.isReady ? !!p.isReady() : true,
        duration: p.getDuration(),
        movieId: String(p.getMovieId() || ''),
      };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  function meta(movieId) {
    try {
      const a = api();
      const vm = a && a.getVideoMetadataByVideoId && a.getVideoMetadataByVideoId(movieId);
      const cv = vm && vm.getCurrentVideo && vm.getCurrentVideo();
      if (!cv) return null;
      const title = cv.getTitle && cv.getTitle();
      if (typeof title !== 'string' || !title) return null;
      let episode = '';
      if (cv.isEpisodic && cv.isEpisodic()) {
        const season = cv.getSeason && cv.getSeason();
        const sNum = season && season._season && season._season.seq;
        const eNum = cv.getEpisodeNumber && cv.getEpisodeNumber();
        const eTitle = cv.getEpisodeTitle && cv.getEpisodeTitle();
        episode = (sNum ? 'S' + sNum : '') + (eNum ? (sNum ? ':' : '') + 'E' + eNum : '') + (eTitle ? ' ' + eTitle : '');
      }
      return { title, episode: episode.trim() };
    } catch (e) { return null; }
  }

  // 플레이어 상태에서 자막 URL 찾기 (활성 트랙만 들어 있음)
  function stateTrackUrls() {
    const urls = new Map();
    try {
      const sid = sessionId();
      const root = sid && window.netflix.appContext.state.playerApp.getState().videoPlayer.cadmiumPlayerRepository.playersById[sid];
      if (!root) return urls;
      const seen = new WeakSet();
      const stack = [{ n: root, d: 0 }];
      while (stack.length) {
        const { n, d } = stack.pop();
        if (!n || typeof n !== 'object' || d > 20 || seen.has(n)) continue;
        seen.add(n);
        if (n instanceof ArrayBuffer || ArrayBuffer.isView(n)) continue;
        try {
          if (n.type === 'timedtext' && typeof n.trackId === 'string' && Array.isArray(n.urls) && n.urls.length && n.urls[0] && typeof n.urls[0].url === 'string' && !urls.has(n.trackId)) {
            urls.set(n.trackId, n.urls[0].url);
          }
        } catch (e) { /* ignore */ }
        const vals = Array.isArray(n) ? n : Object.keys(n).map((k) => { try { return n[k]; } catch (e) { return null; } });
        for (const v of vals) if (v && typeof v === 'object') stack.push({ n: v, d: d + 1 });
      }
    } catch (e) { /* ignore */ }
    return urls;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 특정 언어 트랙의 URL을 플레이어 상태에서 얻는다. 없으면 트랙을 잠시 바꿔 넷플릭스가 받아오게 한 뒤 되돌린다.
  async function hydrate(lang, preferCC) {
    const p = player();
    if (!p) return null;
    const list = p.getTimedTextTrackList() || [];
    const want = String(lang || '').toLowerCase();
    const cands = list.filter((t) => t && t.bcp47 && !t.isNoneTrack && !t.isForcedNarrative && !t.isImageBased && String(t.bcp47).toLowerCase().split('-')[0] === want.split('-')[0]);
    if (!cands.length) return null;
    const isCC = (t) => String(t.rawTrackType || '').toLowerCase() === 'closedcaptions';
    cands.sort((a, b) => (isCC(a) === isCC(b) ? 0 : (isCC(a) === !!preferCC ? -1 : 1)));
    const track = cands[0];
    const toInfo = (url) => ({ id: String(track.trackId), lang: String(track.bcp47), label: String(track.displayName || track.bcp47), cc: isCC(track), forced: false, url, format: 'ttml' });
    let urls = stateTrackUrls();
    if (urls.has(track.trackId)) return toInfo(urls.get(track.trackId));
    const previous = p.getTimedTextTrack();
    try {
      await p.setTimedTextTrack(track);
      for (let i = 0; i < 25; i++) {
        await sleep(300);
        urls = stateTrackUrls();
        if (urls.has(track.trackId)) return toInfo(urls.get(track.trackId));
      }
      return null;
    } finally {
      try { if (previous) await p.setTimedTextTrack(previous); } catch (e) { /* ignore */ }
    }
  }

  // --- 콘텐츠 스크립트 명령 ---
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutor !== 'content') return;
    const d = e.data;
    const reply = (extra) => post(Object.assign({ type: 'reply', reqId: d.reqId }, extra));
    try {
      switch (d.type) {
        case 'hello': {
          const id = watchingId();
          if (manifests.has(id)) announce(id);
          post(Object.assign({ type: 'state' }, state()));
          break;
        }
        case 'getTracks': reply({ tracks: manifests.get(String(d.videoId)) || null }); break;
        case 'seek': { const p = player(); if (p) p.seek(Math.max(0, Math.round(d.ms))); break; }
        case 'play': { const p = player(); if (p) p.play(); break; }
        case 'pause': { const p = player(); if (p) p.pause(); break; }
        case 'getState': reply(state()); break;
        case 'getMeta': reply({ meta: meta(d.videoId) }); break;
        case 'fetchText':
          fetch(d.url).then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then((text) => reply({ ok: true, text }), (err) => reply({ ok: false, error: String(err) }));
          break;
        case 'hydrate':
          hydrate(d.lang, d.preferCC).then((track) => reply({ track }), (err) => reply({ track: null, error: String(err) }));
          break;
        default: break;
      }
    } catch (err) {
      if (d.reqId) reply({ ok: false, error: String(err) });
    }
  });

  // SPA 이동 감지
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const id = watchingId();
    post({ type: 'navigate', platform: 'netflix', videoId: id });
    if (id && manifests.has(id)) announce(id);
  }, 500);
})();
