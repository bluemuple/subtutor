/*
 * SubTutor – 범용 어댑터로 도는 사이트 목록 (콘텐츠 스크립트 · 서비스 워커 · 팝업 공용)
 * 넷플릭스·프라임·디즈니+·유튜브는 전용 어댑터(adapters.js)가 있다. 여기 있는 사이트는 범용 어댑터로 동작한다:
 * 페이지 스크립트(generic-page.js)가 플레이어가 받는 자막·재생 목록(DASH·HLS·WebVTT·Brightcove 등)을 함께 읽고,
 * 재생 위치는 <video> 요소로 읽는다 (광고가 같은 영상 안에 이어 붙은 DASH 는 본편 시간으로 바꾼다).
 * 사용자가 팝업에서 켠 사이트(아무 사이트)는 'site:<호스트>' 로 같은 방식을 쓴다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorSites = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const segs = (u) => u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });

  // videoId: 같은 영상이면 늘 같은 값, 다른 영상이면 다른 값. 재생 화면이 아니면 null (패널을 띄우지 않는다)
  const SITES = [
    {
      key: 'tvnz', label: 'TVNZ+', host: /(^|\.)tvnz\.co\.nz$/,
      patterns: ['https://www.tvnz.co.nz/*'],
      // /player/tvepisode/<slug> · /player/newsclip/<slug> · /player/movie/<slug> · /player/liveevent/<slug>
      videoId(u) { const s = segs(u); return s[0] === 'player' && s[2] ? s[2] : null; },
      home: 'https://www.tvnz.co.nz/',
      about: '뉴질랜드 공영 방송. Shortland Street 같은 뉴질랜드 드라마·뉴스·리얼리티 (뉴질랜드에서, 무료 가입)',
    },
    {
      key: 'threenow', label: 'ThreeNow', host: /(^|\.)threenow\.co\.nz$/,
      patterns: ['https://www.threenow.co.nz/*'],
      // /shows/<작품>/<회차>/<작품 id>/<회차 id>
      videoId(u) { const s = segs(u); return s[0] === 'shows' && s.length >= 5 ? s[4] : null; },
      home: 'https://www.threenow.co.nz/',
      about: '뉴질랜드 Three 방송 (Educators 같은 뉴질랜드 코미디·리얼리티, 무료 가입)',
    },
    {
      key: 'nzonscreen', label: 'NZ On Screen', host: /(^|\.)nzonscreen\.com$/,
      patterns: ['https://www.nzonscreen.com/*', 'https://nzonscreen.com/*'],
      // /title/<작품> 또는 /all-series/<시리즈>/<회차>/ · /all-films/… (작품 주소는 회차 주소로 넘어간다)
      videoId(u) { const s = segs(u); if (s[0] === 'title' && s[1]) return s[1]; if (/^all-/.test(s[0] || '') && s.length >= 3) return s[s.length - 1]; return null; },
      home: 'https://www.nzonscreen.com/',
      about: '뉴질랜드 영화·드라마·다큐 무료 보관소 (Westside 등, 가입 없이 자막 포함)',
    },
    {
      key: 'maoriplus', label: 'MĀORI+', host: /(^|\.)maoriplus\.co\.nz$/,
      patterns: ['https://www.maoriplus.co.nz/*'],
      // /show/<작품>/season-1/episode-1/play · /movie/<영화>/play
      videoId(u) { const s = segs(u); return (s[0] === 'show' || s[0] === 'movie') && s[s.length - 1] === 'play' && s.length >= 3 ? s.slice(1, -1).join('/') : null; },
      home: 'https://www.maoriplus.co.nz/',
      about: '마오리 TV(Whakaata Māori). 마오리 문화·말과 영어 자막 (무료 가입)',
    },
    {
      key: 'ted', label: 'TED', host: /(^|\.)ted\.com$/,
      patterns: ['https://www.ted.com/*'],
      videoId(u) { const s = segs(u); return s[0] === 'talks' && s[1] ? s[1] : null; },
      home: 'https://www.ted.com/talks',
      about: '교육·학교에 관한 강연 (영어·한국어 자막)',
    },
    {
      key: 'vimeo', label: 'Vimeo', host: /^(www\.)?vimeo\.com$/,
      patterns: ['https://vimeo.com/*', 'https://www.vimeo.com/*'],
      // vimeo.com/<숫자> · /channels/…/<숫자> · /showcase/…/video/<숫자>
      videoId(u) { const m = /(?:^|\/)(\d{5,})(?=\/|$)/.exec(u.pathname); return m ? m[1] : null; },
      home: 'https://vimeo.com/',
      about: '교사 연수·학교 영상이 많이 올라오는 곳 (올린 사람이 넣은 자막)',
    },
  ];

  // 사용자가 켠 사이트: 주소의 경로(+ 영상을 가리키는 흔한 매개변수)를 영상 ID 로 쓴다
  const ID_PARAMS = ['v', 'id', 'vid', 'video', 'videoId', 'episode', 'ep', 'e'];
  function customVideoId(u) {
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const keep = ID_PARAMS.filter((k) => u.searchParams.get(k)).map((k) => k + '=' + u.searchParams.get(k));
    return (path + (keep.length ? '?' + keep.join('&') : '')).slice(0, 300);
  }
  function custom(host) {
    const h = String(host || '').toLowerCase();
    return { key: 'site:' + h, label: h.replace(/^www\./, ''), custom: true, host: { test: (x) => String(x).toLowerCase() === h }, patterns: ['https://' + h + '/*', 'http://' + h + '/*'], videoId: customVideoId };
  }
  const isCustomKey = (key) => /^site:/.test(String(key || ''));
  function byKey(key) {
    if (isCustomKey(key)) return custom(String(key).slice(5));
    return SITES.find((s) => s.key === key) || null;
  }
  function forHost(host) { const h = String(host || '').toLowerCase(); return SITES.find((s) => s.host.test(h)) || null; }
  function videoIdFor(key, url) {
    const s = byKey(key);
    if (!s) return null;
    try { return s.videoId(new URL(url)) || null; } catch (e) { return null; }
  }
  function label(key) { const s = byKey(key); return s ? s.label : String(key || ''); }
  const allPatterns = () => SITES.reduce((a, s) => a.concat(s.patterns), []);

  return { SITES, custom, byKey, forHost, videoIdFor, label, allPatterns, isCustomKey, customVideoId };
});
