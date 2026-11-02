/*
 * SubTutor – 범용 페이지 스크립트 (MAIN world, document_start)
 * TVNZ+·ThreeNow·NZ On Screen·MĀORI+·TED·Vimeo 와 사용자가 켠 사이트에서 돈다.
 * 플레이어가 받아 가는 응답을 함께 읽어 자막을 찾는다 (페이지의 요청을 바꾸지는 않는다):
 *  - DASH 재생 목록(MPD): 자막 조각(wvtt·stpp) 주소와 광고 기간 → 콘텐츠 스크립트가 본편 시간으로 바꿔 쓴다 (TVNZ+)
 *  - HLS 마스터 재생 목록: 자막 재생 목록 → 조각 WebVTT
 *  - 통째로 된 자막 파일(WebVTT·SRT·TTML): TED 처럼 플레이어가 받아 가는 파일
 *  - JSON: Brightcove 재생 정보(text_tracks, NZ On Screen 등) · JW Player · Vimeo 설정 · TVNZ+ 카탈로그(제목) · 그 밖의 자막 주소
 * 콘텐츠 스크립트의 요청: hello · getTracks · getMeta · fetchText · fetchBytes (페이지 출처로 받아야 CORS 가 맞는 파일)
 */
(() => {
  'use strict';
  if (window.__subtutorGeneric) return;
  window.__subtutorGeneric = true;

  const origFetch = window.fetch;
  const post = (msg) => { try { window.postMessage(Object.assign({ __subtutor: 'page', platform: 'generic', href: location.href, at: Date.now() }, msg), '*'); } catch (e) { /* ignore */ } };
  const seen = new Set();          // 이미 본 응답 주소
  const tracks = [];               // 잡은 자막 트랙 { id, url, lang, label, cc, format, text?, href, at, source }
  let dash = null, master = null, meta = null;

  const SUB_EXT = /\.(?:vtt|webvtt|srt|ttml2?|dfxp)(?:[?#]|$)/i;
  const MPD_RE = /\.mpd(?:[?#]|$)/i;
  const M3U8_RE = /\.m3u8(?:[?#]|$)/i;
  const MEDIA_EXT = /\.(?:mp4|m4s|m4v|m4a|ts|aac|webm|dash|cmfv|cmfa|jpg|jpeg|png|webp|gif|svg|woff2?|css|js)(?:[?#]|$)/i;
  const JSON_HINT = /playback\/v1\/accounts\/\d+\/videos|cdn\.jwplayer\.com\/v2\/media|player\.vimeo\.com\/video\/\d+\/config|cms-api\.tvnz\.co\.nz\/content\/urn\/resource\/catalog|text_?tracks|caption|subtitle|playback|manifest|player|config|media|video/i;
  const MAX_TEXT = 6 * 1024 * 1024;
  // 언어 추측: 주소의 /subtitles/en/full.vtt · _en.vtt · lang=en · /en-NZ/ 같은 표시
  const LANGS = 'en|eng|en-nz|en-au|en-gb|en-us|ko|kor|ko-kr|mi|mri|fr|de|es|it|ja|zh|zh-cn|zh-tw|pt|pt-br|ru|ar|nl|sv|vi|th|id|hi|tr|pl';
  const LANG_PATTERNS = [
    new RegExp('[?&](?:lang|language|srclang|locale|tlang)=(' + LANGS + ')\\b', 'i'),
    new RegExp('/(?:subtitles?|captions?|tracks?|texttracks?)/(' + LANGS + ')(?:/|\\.|$)', 'i'),
    new RegExp('[._/-](' + LANGS + ')(?:[._-](?:cc|sdh|forced|full|auto))*\\.(?:vtt|webvtt|srt|ttml2?|dfxp)(?:[?#]|$)', 'i'),
    new RegExp('/(' + LANGS + ')/', 'i'),
  ];
  function normLang(l) {
    const s = String(l || '').toLowerCase().replace('_', '-');
    if (/^(en|eng)\b/.test(s)) return 'en';
    if (/^(ko|kor)\b/.test(s)) return 'ko';
    if (/^(mi|mri)\b/.test(s)) return 'mi';
    return s.split('-')[0] || 'und';
  }
  function guessLang(url, hint) {
    if (hint) return normLang(hint);
    for (const re of LANG_PATTERNS) { const m = re.exec(String(url || '')); if (m) return normLang(m[1]); }
    return 'und';
  }
  const formatOf = (url, text) => {
    if (/^\s*WEBVTT/.test(text || '') || /\.(?:vtt|webvtt)(?:[?#]|$)/i.test(url)) return 'vtt';
    if (/<tt\b|<\?xml/i.test((text || '').slice(0, 400)) || /\.(?:ttml2?|dfxp|xml)(?:[?#]|$)/i.test(url)) return 'ttml';
    return 'srt';
  };
  const absUrl = (u, base) => { try { return new URL(u, base || location.href).href; } catch (e) { return String(u || ''); } };
  const isWanted = (lang) => lang === 'en' || lang === 'ko' || lang === 'und';

  function addTracks(list, source) {
    const fresh = [];
    for (const t of list) {
      if (!t || !t.url) continue;
      const id = t.url;
      const old = tracks.find((x) => x.id === id);
      if (old) { if (t.text && !old.text) { old.text = t.text; fresh.push(old); } continue; }
      const tr = Object.assign({ id, lang: 'und', label: '', cc: false, format: '' }, t, { href: location.href, at: Date.now(), source });
      tracks.push(tr);
      if (tracks.length > 200) tracks.splice(0, tracks.length - 200);
      fresh.push(tr);
    }
    if (fresh.length) post({ type: 'tracks', merge: true, tracks: fresh });
  }
  function setMeta(m) {
    if (!m || !m.title) return;
    meta = { title: String(m.title).slice(0, 200), episode: String(m.episode || '').slice(0, 200), href: location.href };
    post({ type: 'meta', meta });
  }

  // ── 응답 살피기 ──
  function kindOf(url, ct) {
    if (MPD_RE.test(url) || /dash\+xml/i.test(ct)) return 'mpd';
    if (M3U8_RE.test(url) || /mpegurl/i.test(ct)) return 'm3u8';
    if (SUB_EXT.test(url) || /text\/vtt|ttml|x-subrip/i.test(ct)) return 'sub';
    if (MEDIA_EXT.test(url) || /^(video|audio|image|font)\//i.test(ct)) return '';
    if (/json/i.test(ct) || (!ct && JSON_HINT.test(url))) return 'json';
    return '';
  }
  function onText(url, ct, text) {
    if (typeof text !== 'string' || !text || text.length > MAX_TEXT) return;
    const kind = kindOf(url, ct);
    try {
      if (kind === 'mpd' || (kind === '' && /<MPD[\s>]/.test(text.slice(0, 2000)))) {
        if (!/<MPD[\s>]/.test(text)) return;
        dash = { url, text, href: location.href, at: Date.now() };
        post({ type: 'dash', url, text });
      } else if (kind === 'm3u8') {
        if (!/#EXTM3U/.test(text) || !(/#EXT-X-STREAM-INF/.test(text) || /TYPE=SUBTITLES/.test(text))) return;
        master = { url, href: location.href, at: Date.now() };
        post({ type: 'master', url });
      } else if (kind === 'sub') {
        // 통째로 된 자막 파일만 (HLS 조각처럼 몇 줄짜리는 건너뛴다)
        const n = (text.match(/-->/g) || []).length + (text.match(/<p\b[^>]*\bbegin=/gi) || []).length;
        if (n < 8 && !/\bfull\b/i.test(url)) return;
        const lang = guessLang(url);
        if (!isWanted(lang)) return; // 다른 언어 파일(TED 는 60개쯤 받는다)은 담지 않는다
        addTracks([{ url, lang, label: lang, format: formatOf(url, text), text }], 'file');
      } else if (kind === 'json') {
        if (!/^\s*[[{]/.test(text)) return;
        onJson(url, JSON.parse(text));
      }
    } catch (e) { /* 자막과 상관없는 응답 */ }
  }
  function onJson(url, j) {
    if (!j || typeof j !== 'object') return;
    // Brightcove 재생 정보 (NZ On Screen, ThreeNow 등)
    if (Array.isArray(j.text_tracks) || (j.sources && j.name && j.id)) {
      const list = (j.text_tracks || []).filter((t) => /captions|subtitles/i.test(t.kind || 'captions')).map((t) => {
        const src = ((t.sources || []).find((s) => /^https:/.test(s.src || '')) || t).src || t.src;
        return { url: absUrl(String(src || '').replace(/^http:/, 'https:')), lang: guessLang(src, t.srclang), label: t.label || t.srclang || '', cc: /captions/i.test(t.kind || ''), format: 'vtt' };
      }).filter((t) => t.url);
      if (list.length) addTracks(list, 'brightcove');
      if (j.name) setMeta({ title: j.name, episode: '' });
      return;
    }
    // JW Player
    if (Array.isArray(j.playlist) && j.playlist[0]) {
      const pl = j.playlist[0];
      const list = (pl.tracks || []).filter((t) => /captions|subtitles/i.test(t.kind || '')).map((t) => ({ url: absUrl(t.file), lang: guessLang(t.file, t.language || t.label), label: t.label || '', format: formatOf(t.file, '') }));
      if (list.length) addTracks(list, 'jwplayer');
      if (pl.title || j.title) setMeta({ title: pl.title || j.title });
      return;
    }
    // Vimeo 플레이어 설정
    if (j.request && Array.isArray(j.request.text_tracks)) {
      addTracks(j.request.text_tracks.map((t) => ({ url: absUrl(t.url, 'https://player.vimeo.com/'), lang: guessLang(t.url, t.lang), label: t.label || t.lang || '', cc: /captions/i.test(t.kind || ''), format: 'vtt' })), 'vimeo');
      if (j.video && j.video.title) setMeta({ title: j.video.title });
      return;
    }
    // TVNZ+ 카탈로그: 작품 이름(lon) · 시즌(snum) · 회차(epnum) · 회차 이름(losn)
    const d = j.data;
    if (d && /^urn:resource:catalog/.test(String(d.urn || ''))) {
      const name = (k) => (Array.isArray(d[k]) && d[k][0] && d[k][0].n) || '';
      const title = name('lostl') || name('lon');
      const epName = name('losn');
      const se = d.snum && d.epnum ? 'S' + d.snum + ' E' + d.epnum : (d.epnum ? 'E' + d.epnum : '');
      if (d.cty === 'tvepisode' && title) setMeta({ title, episode: [se, epName && !/^(season|episode)\b/i.test(epName) ? epName : ''].filter(Boolean).join(' · ') });
      else if (name('lon')) setMeta({ title: name('lon'), episode: '' });
      return;
    }
    // 그 밖: JSON 안에서 자막 파일 주소를 찾는다 (언어 표시와 함께 있는 것만)
    const found = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 7 || found.length > 40) return;
      if (Array.isArray(o)) { for (const x of o.slice(0, 200)) walk(x, depth + 1); return; }
      for (const k of Object.keys(o).slice(0, 80)) {
        const v = o[k];
        if (typeof v === 'string' && SUB_EXT.test(v) && /^(https?:)?\/\//i.test(v)) {
          const lang = guessLang(v, o.srclang || o.lang || o.language || o.languageCode || o.locale || o.code);
          if (isWanted(lang)) found.push({ url: absUrl(v), lang, label: String(o.label || o.name || o.title || lang), cc: /caption|sdh|cc/i.test(String(o.kind || o.type || o.label || '')), format: formatOf(v, '') });
        } else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(j, 0);
    if (found.length) addTracks(found, 'json');
  }

  // fetch: 응답을 복제해 읽는다 (페이지가 받는 응답은 그대로)
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = absUrl(typeof input === 'string' ? input : (input && input.url) || String(input));
      p.then((res) => {
        try {
          if (!res || !res.ok) return;
          const ct = res.headers.get('content-type') || '';
          const len = +(res.headers.get('content-length') || 0);
          if (!kindOf(url, ct) && !/\.xml(?:[?#]|$)/i.test(url)) return;
          if (len > MAX_TEXT) return;
          res.clone().text().then((t) => onText(url, ct, t), () => {});
        } catch (e) { /* ignore */ }
      }, () => {});
    } catch (e) { /* ignore */ }
    return p;
  };
  // XHR (hls.js · dash.js · video.js · Brightcove 카탈로그는 XHR 을 쓴다)
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__stUrl = absUrl(u); } catch (e) { /* ignore */ } return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__stUrl;
    if (url) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const ct = this.getResponseHeader('content-type') || '';
          if (!kindOf(url, ct) && !/\.xml(?:[?#]|$)/i.test(url)) return;
          let text = null;
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') { if (this.response) onJson(url, this.response); return; }
          else if (this.responseType === 'arraybuffer' && this.response && this.response.byteLength < MAX_TEXT) text = new TextDecoder('utf-8').decode(this.response);
          if (text !== null) onText(url, ct, text);
        } catch (e) { /* ignore */ }
      });
    }
    return xs.apply(this, arguments);
  };

  // ── 콘텐츠 스크립트와의 대화 ──
  const replay = () => {
    if (dash) post({ type: 'dash', url: dash.url, text: dash.text, href: dash.href, at: dash.at });
    if (master) post({ type: 'master', url: master.url, href: master.href, at: master.at });
    if (tracks.length) post({ type: 'tracks', merge: true, tracks: tracks.slice() });
    if (meta) post({ type: 'meta', meta, href: meta.href });
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutor !== 'content') return;
    const d = e.data;
    const reply = (extra) => post(Object.assign({ type: 'reply', reqId: d.reqId }, extra));
    try {
      switch (d.type) {
        case 'hello': replay(); break;
        case 'getTracks': reply({ tracks: tracks.slice(), dash: dash ? { url: dash.url, text: dash.text, href: dash.href, at: dash.at } : null, master: master ? { url: master.url, href: master.href, at: master.at } : null }); break;
        case 'getMeta': reply({ meta }); break;
        case 'fetchText':
          origFetch(d.url, { cache: 'no-store', credentials: 'omit' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((text) => reply({ ok: true, text }), (err) => reply({ ok: false, error: String(err) }));
          break;
        case 'fetchBytes':
          origFetch(d.url, { credentials: 'omit' }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((bytes) => reply({ ok: true, bytes }), (err) => reply({ ok: false, error: String(err) }));
          break;
        default: break;
      }
    } catch (err) {
      if (d.reqId) reply({ ok: false, error: String(err) });
    }
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    post({ type: 'navigate' });
  }, 500);
})();
