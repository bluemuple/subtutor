/*
 * SubTutor – 프라임 비디오 페이지 스크립트 (MAIN world, document_start)
 * 플레이어가 받는 재생 리소스 JSON(subtitleUrls / forcedNarratives)에서 자막 트랙 목록을 모으고,
 * 제목 정보(catalogMetadataV2)를 찾는다. 재생 제어는 콘텐츠 스크립트가 <video>로 직접 한다.
 */
(() => {
  'use strict';
  if (window.__subtutorPrime) return;
  window.__subtutorPrime = true;

  const post = (msg) => { try { window.postMessage(Object.assign({ __subtutor: 'page' }, msg), '*'); } catch (e) { /* ignore */ } };
  let tracks = null;
  let titleId = '';
  let chromeUrl = '';
  let metaCache = null;

  const param = (url, name) => { try { return new URL(url, location.href).searchParams.get(name); } catch (e) { return null; } };

  function collect(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { for (const v of node) collect(v, out, depth + 1); return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if ((k === 'subtitleUrls' || k === 'forcedNarratives') && Array.isArray(v)) {
        for (const t of v) {
          if (!t || typeof t.url !== 'string') continue;
          out.push({ url: t.url, languageCode: String(t.languageCode || ''), displayName: String(t.displayName || ''), type: String(t.type || ''), subtype: String(t.subtype || ''), forced: k === 'forcedNarratives' });
        }
      } else {
        collect(v, out, depth + 1);
      }
    }
  }

  function announce() {
    if (tracks) post({ type: 'tracks', platform: 'prime', videoId: titleId || '', tracks });
  }

  function inspectObject(json) {
    const found = [];
    collect(json, found, 0);
    const seen = new Set();
    const uniq = found.filter((t) => !seen.has(t.url) && seen.add(t.url));
    if (!uniq.length) return;
    tracks = uniq.map((t) => ({
      id: t.url,
      lang: t.languageCode,
      label: t.displayName || t.languageCode,
      cc: /sdh|caption/i.test(t.type + ' ' + t.subtype + ' ' + t.displayName),
      forced: t.forced,
      url: t.url,
      format: /\.vtt(\?|#|$)/i.test(t.url) ? 'vtt' : 'ttml',
    }));
    announce();
  }
  const origParse = JSON.parse;
  function inspectText(text) {
    if (typeof text !== 'string' || text.indexOf('subtitleUrls') === -1) return;
    try { inspectObject(origParse(text)); } catch (e) { /* not JSON */ }
  }

  function captureUrl(url) {
    if (typeof url !== 'string') return;
    if (url.indexOf('GetVodPlaybackResources') !== -1) {
      const t = param(url, 'titleId');
      if (t && t !== titleId) { titleId = t; metaCache = null; post({ type: 'video', platform: 'prime', videoId: titleId }); }
    }
    if (url.indexOf('playerChromeResources') !== -1 && url.indexOf('catalogMetadataV2') !== -1) {
      chromeUrl = url;
      metaCache = null;
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || (input instanceof URL ? input.href : '');
      captureUrl(url);
    } catch (e) { /* ignore */ }
    const p = origFetch.apply(this, arguments);
    p.then((res) => {
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1 || /PlaybackResources/i.test(res.url || '')) res.clone().text().then(inspectText, () => {});
      } catch (e) { /* ignore */ }
    }, () => {});
    return p;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__stUrl = String(url);
    captureUrl(this.__stUrl);
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      this.addEventListener('load', () => {
        try {
          const rt = this.responseType;
          if (rt === '' || rt === 'text') inspectText(this.responseText);
          else if (rt === 'json' && this.response) inspectObject(this.response);
          else if (rt === 'arraybuffer' && this.response && /PlaybackResources/i.test(this.responseURL || this.__stUrl || '')) inspectText(new TextDecoder().decode(this.response));
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    return xhrSend.apply(this, arguments);
  };
  JSON.parse = function (text) {
    const value = origParse.apply(this, arguments);
    try { if (typeof text === 'string' && text.length > 200 && text.indexOf('subtitleUrls') !== -1) inspectObject(value); } catch (e) { /* ignore */ }
    return value;
  };

  async function meta() {
    if (metaCache) return metaCache;
    if (chromeUrl) {
      try {
        const res = await origFetch.call(window, chromeUrl, { credentials: 'include' });
        const json = await res.json();
        const catalog = json && json.resources && json.resources.catalogMetadataV2 && json.resources.catalogMetadataV2.catalog;
        if (catalog) {
          let title = catalog.seriesTitle || catalog.title || '';
          let episode = '';
          if (catalog.seriesTitle) {
            episode = (typeof catalog.seasonNumber === 'number' ? 'S' + catalog.seasonNumber : '') + (typeof catalog.episodeNumber === 'number' ? (catalog.seasonNumber ? ':' : '') + 'E' + catalog.episodeNumber : '') + (catalog.title ? ' ' + catalog.title : '');
          }
          metaCache = { title: String(title), episode: episode.trim() };
          return metaCache;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutor !== 'content') return;
    const d = e.data;
    const reply = (extra) => post(Object.assign({ type: 'reply', reqId: d.reqId }, extra));
    try {
      switch (d.type) {
        case 'hello': if (titleId) post({ type: 'video', platform: 'prime', videoId: titleId }); announce(); break;
        case 'getTracks': reply({ tracks }); break;
        case 'getMeta': meta().then((m) => reply({ meta: m }), () => reply({ meta: null })); break;
        case 'fetchText':
          origFetch.call(window, d.url).then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then((text) => reply({ ok: true, text }), (err) => reply({ ok: false, error: String(err) }));
          break;
        default: break;
      }
    } catch (err) {
      if (d.reqId) reply({ ok: false, error: String(err) });
    }
  });
})();
