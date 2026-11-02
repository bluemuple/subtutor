/* E2E용 모의 서버: HTTPS(8443)로 www.netflix.com / translate.googleapis.com 흉내, HTTP(8766)로 docs 웹사이트 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.vtt': 'text/vtt; charset=utf-8', '.webm': 'video/webm', '.mp4': 'video/mp4' };

function sendFile(req, res, file, extraHeaders) {
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const headers = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, extraHeaders || {});
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, Object.assign(headers, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Content-Length': end - start + 1 }));
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, Object.assign(headers, { 'Content-Length': stat.size }));
  fs.createReadStream(file).pipe(res);
}

// ── 모의 TVNZ+: 광고가 영상에 이어 붙은 DASH (실제 TVNZ+ 와 같은 모양, 2026-11-02 확인) ──
// 영상 시각: 0–4초 광고 · 4–22초 본편(본편 0–18초) · 22–26초 광고 · 26–48초 본편(본편 18–40초)
// 자막은 wvtt(WebVTT-in-MP4) 6초 조각, 시간 단위 600, 본편 기간마다 presentationTimeOffset = 본편 시각
const TVNZ_CUES = [
  [1.0, 3.5, 'Kia ora, welcome to Ferndale.'],
  [4.2, 6.8, "<c.cyan>- My dog Raffie bites all the time</c>\n<c.cyan>when he's playing,</c>"],
  [7.5, 10.0, 'but my mum says, "You\'re not a dog, Rory,"'],
  [10.8, 13.2, "and I say, 'Really? Let's look at the facts.'"],
  [14.0, 16.5, "I like biting when I'm playing."],
  [17.0, 19.6, 'Sweet as, see you at morning tea.'], // 본편 18초의 광고 경계를 넘는다 → 두 조각에 나뉘어 들어가도 한 줄로 이어야 한다
  [20.5, 23.0, 'I can catch a frisbee in my mouth.'],
  [24.0, 26.6, 'And I like eating with no hands.'],
  [27.5, 30.0, "I don't think she's paying attention."],
  [31.0, 34.0, "The only time I've been to the Principal's office"],
];
const TVNZ_TS = 600;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => Buffer.concat([u32(Math.floor(n / 4294967296)), u32(n % 4294967296)]);
const box = (type, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]); };
const fullHdr = (v, flags) => u32(((v & 0xff) << 24) | (flags & 0xffffff));
function wvttInit() {
  const mdhd = box('mdhd', fullHdr(0, 0), u32(0), u32(0), u32(TVNZ_TS), u32(0), u32(0));
  const stsd = box('stsd', fullHdr(0, 0), u32(1), box('wvtt', Buffer.alloc(8), box('vttC', 'WEBVTT')));
  return Buffer.concat([box('ftyp', 'iso6', u32(0)), box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))), box('mvex', box('trex', fullHdr(0, 0), u32(1), u32(1), u32(0), u32(0), u32(0))))]);
}
// [t0, t1) 초 구간의 조각: 대사가 바뀌는 곳마다 샘플을 나눈다 (대사 없는 곳은 vtte)
function wvttSegment(t0, t1) {
  const marks = new Set([t0, t1]);
  for (const [s, e] of TVNZ_CUES) { if (s > t0 && s < t1) marks.add(s); if (e > t0 && e < t1) marks.add(e); }
  const pts = Array.from(marks).sort((a, b) => a - b);
  const samples = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const live = TVNZ_CUES.filter(([s, e]) => s <= a && e >= b);
    const data = live.length ? Buffer.concat(live.map(([, , text]) => box('vttc', box('payl', text)))) : box('vtte');
    samples.push({ d: Math.round((b - a) * TVNZ_TS), data });
  }
  const build = (off) => box('moof', box('mfhd', fullHdr(0, 0), u32(1)), box('traf', box('tfhd', fullHdr(0, 0x020000), u32(1)), box('tfdt', fullHdr(1, 0), u64(Math.round(t0 * TVNZ_TS))), box('trun', fullHdr(0, 0x000301), u32(samples.length), u32(off), ...samples.flatMap((s) => [u32(s.d), u32(s.data.length)]))));
  const moof = build(build(0).length + 8);
  return Buffer.concat([box('styp', 'msdh'), moof, box('mdat', Buffer.concat(samples.map((s) => s.data)))]);
}
function tvnzMpd() {
  // 본편 1: 영상 4–22초 = 본편 0–18초 (조각 0·3600·7200) · 본편 2: 영상 26–48초 = 본편 18–40초 (조각 10800·14400·18000·21600)
  const text = (pto, timeline) => '<AdaptationSet codecs="wvtt" contentType="text" lang="en" mimeType="application/mp4"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><SegmentTemplate initialization="mock-$RepresentationID$.dash" media="mock-$RepresentationID$-$Time$.dash" presentationTimeOffset="' + pto + '" timescale="600"><SegmentTimeline>' + timeline + '</SegmentTimeline></SegmentTemplate><Representation bandwidth="1000" id="textstream_eng=1000"/></AdaptationSet>';
  const video = (pto) => '<AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="600" presentationTimeOffset="' + pto + '" media="mock-$RepresentationID$-$Time$.dash"><SegmentTimeline><S t="' + pto + '" d="3600" r="3"/></SegmentTimeline></SegmentTemplate><Representation id="video=1000" bandwidth="1000"/></AdaptationSet>';
  const ad = (id, start, dur) => '<Period id="' + id + '" start="PT' + start + 'S" duration="PT' + dur + 'S"><BaseURL>https://ads.example.invalid/ad/</BaseURL><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="25000" media="asset_$RepresentationID$_$Number%09d$.mp4" duration="50000"/><Representation id="7"/></AdaptationSet></Period>';
  return '<?xml version="1.0" encoding="utf-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT48S">'
    + '<BaseURL>https://vod-origin-cdn.cms-api.tvnz.co.nz/content/pubcontent/vol/mock/mock-output_cenc_dash_dref.ism/</BaseURL>'
    + ad('1_PT0S_0', 0, 4)
    + '<Period id="1_PT4S" start="PT4S" duration="PT18S">' + video(0) + text(0, '<S d="3600" r="2" t="0"/>') + '</Period>'
    + ad('1_PT18S_0', 22, 4)
    + '<Period id="1_PT26S" start="PT26S" duration="PT22S">' + video(10800) + text(10800, '<S d="3600" r="3" t="10800"/>') + '</Period>'
    + '</MPD>';
}
const jsonRes = (res, obj, extra) => { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, extra || {})); res.end(JSON.stringify(obj)); };

function mockHandler(root) {
  return (req, res) => {
    const url = new URL(req.url, 'https://x');
    const p = url.pathname;
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    // ── 범용 사이트 모의 (TVNZ+ · NZ On Screen(Brightcove) · Vimeo(<track>) · TED(통째 자막 파일)) ──
    if (host === 'www.tvnz.co.nz' && /^\/player\/[\w-]+\/[^/]+$/.test(p)) return sendFile(req, res, path.join(root, 'tvnz.html'));
    if (host === 'data-store-cdn.cms-api.tvnz.co.nz' && p.startsWith('/content/urn/resource/catalog/tvepisode/')) {
      return jsonRes(res, { data: { urn: 'urn:resource:catalog:tvepisode', cty: 'tvepisode', nu: path.basename(p), snum: 2026, epnum: 110, lon: [{ lang: 'en', n: 'Shortland Street' }], lostl: [{ lang: 'en', n: 'Shortland Street' }], losn: [{ lang: 'en', n: 'Tuesday 27 Oct 2026' }], txt_lg: ['English'] }, header: { code: 0 } });
    }
    if (host === 'vod-origin-cdn.cms-api.tvnz.co.nz') {
      if (p.endsWith('/index.mpd')) { res.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(tvnzMpd()); return; }
      const m = /mock-textstream_eng=1000(?:-(\d+))?\.dash$/.exec(p);
      if (m) {
        const body = m[1] === undefined ? wvttInit() : wvttSegment(+m[1] / TVNZ_TS, +m[1] / TVNZ_TS + 6);
        res.writeHead(200, { 'Content-Type': 'application/mp4', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }
    }
    if (host === 'www.nzonscreen.com' && p.startsWith('/title/')) return sendFile(req, res, path.join(root, 'nzonscreen.html'));
    if (host === 'edge.api.brightcove.com' && /^\/playback\/v1\/accounts\/\d+\/videos\/\d+$/.test(p)) {
      return jsonRes(res, { id: '456', name: 'Mock Westside - Episode One', duration: 48000, sources: [{ src: 'https://www.nzonscreen.com/media/test.webm', type: 'video/webm' }], text_tracks: [{ id: 't1', src: 'http://www.nzonscreen.com/tracks/en.vtt', sources: [{ src: 'http://www.nzonscreen.com/tracks/en.vtt' }, { src: 'https://www.nzonscreen.com/tracks/en.vtt' }], srclang: 'en', label: 'EN', kind: 'captions' }, { id: 't2', src: 'https://www.nzonscreen.com/thumbs.vtt', srclang: null, label: 'thumbnails', kind: 'metadata' }] });
    }
    if (host === 'vimeo.com' && /^\/\d{5,}$/.test(p)) return sendFile(req, res, path.join(root, 'vimeo.html'));
    if (host === 'www.ted.com' && p.startsWith('/talks/')) return sendFile(req, res, path.join(root, 'ted.html'));
    if (/^\/subtitles\/(en|ko|fr)\/full\.vtt$/.test(p)) { const lang = p.split('/')[2]; return sendFile(req, res, path.join(root, 'tracks', (lang === 'fr' ? 'en' : lang) + '.vtt')); }
    // 디즈니+ 모의: /play/<id> 플레이어 페이지와 HLS 자막 목록 (자막 본문은 /tracks/*.vtt 를 그대로 쓴다)
    if (/^\/play\/[^/]+$/.test(p)) return sendFile(req, res, path.join(root, 'disney.html'));
    if (p.startsWith('/mock/disney/')) {
      const name = path.basename(p);
      const m3u8 = {
        'master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="한국어",LANGUAGE="ko",AUTOSELECT=YES,URI="ko.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="sub-main"\nvideo.m3u8\n',
        'en.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:60.000,\n/tracks/en.vtt\n#EXT-X-ENDLIST\n',
        'ko.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:60.000,\n/tracks/ko.vtt\n#EXT-X-ENDLIST\n',
        // 두 번째 작품: 자막이 빈틈없이 이어 붙어 있다 (따라하기 멈춤이 다음 줄로 넘어가지 않는지 보는 용도)
        'master2.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="en2.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="sub-main"\nvideo.m3u8\n',
        'en2.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:60.000,\n/tracks/adjacent-en.vtt\n#EXT-X-ENDLIST\n',
      }[name];
      if (!m3u8) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(m3u8);
      return;
    }
    // 유튜브 모의: /watch?v=... 페이지와 json3 자막
    if (p === '/watch' && url.searchParams.get('v')) return sendFile(req, res, path.join(root, 'youtube.html'));
    if (p === '/api/timedtext') {
      const tlang = url.searchParams.get('tlang');
      const asr = url.searchParams.get('kind') === 'asr';
      const lines = tlang === 'ko'
        ? ['안녕하세요, 테스트에 오신 것을 환영합니다.', '내 강아지 래피는 놀 때 항상 깨문다,', '하지만 엄마는 "넌 개가 아니야, 로리"라고 하신다,', '그러면 나는 \'정말요? 사실을 따져 보죠\'라고 한다.', '나는 놀 때 깨무는 걸 좋아한다.', '나는 입으로 프리스비를 잡을 수 있다.', '그리고 손 없이 먹는 것도 좋아한다.', '엄마는 내 말을 귀담아듣지 않는 것 같다.', '내가 교장실에 가 본 유일한 때는', '교장 선생님 상을 받으러 갈 때뿐이다.']
        : ['Hello there, welcome to the test.', "My dog Raffie bites all the time when he's playing,", 'but my mum says, "You\'re not a dog, Rory,"', "and I say, 'Really? Let's look at the facts.'", "I like biting when I'm playing.", 'I can catch a frisbee in my mouth.', 'And I like eating with no hands.', "I don't think she's paying attention.", "The only time I've ever been to the Principal's office", "is to collect a Principal's Award."];
      const events = [{ tStartMs: 0, dDurationMs: 1000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 }];
      lines.forEach((text, i) => {
        const start = 2000 + i * 4000;
        events.push({ tStartMs: start, dDurationMs: asr ? 5000 : 2000, segs: asr ? text.split(' ').map((w, k) => ({ utf8: (k ? ' ' : '') + w, tOffsetMs: k * 120 })) : [{ utf8: text }] });
        if (asr) events.push({ tStartMs: start + 3990, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] });
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ wireMagic: 'pb3', events }));
      return;
    }
    if (/^\/watch\/\d+$/.test(p)) return sendFile(req, res, path.join(root, 'watch.html'));
    if (p.startsWith('/tracks/')) return sendFile(req, res, path.join(root, 'tracks', path.basename(p)));
    if (p.startsWith('/media/')) return sendFile(req, res, path.join(root, 'media', path.basename(p)));
    if (p === '/translate_a/single') {
      const q = url.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      // 진짜 응답처럼 줄마다 한 조각 (줄바꿈은 앞 조각 끝에 붙는다)
      const lines = q.split('\n');
      res.end(JSON.stringify([lines.map((l, i) => ['[번역] ' + l + (i < lines.length - 1 ? '\n' : ''), l, null, null]), null, 'en']));
      return;
    }
    if (p === '/translate_a/t') {
      const q = url.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(['[번역2] ' + q]));
      return;
    }
    res.writeHead(404); res.end('mock 404 ' + p);
  };
}
function staticHandler(root) {
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    sendFile(req, res, file);
  };
}

function start({ mockRoot, docsRoot, key, cert, httpsPort = 8443, httpPort = 8766 }) {
  const tls = https.createServer({ key, cert }, mockHandler(mockRoot));
  const web = http.createServer(staticHandler(docsRoot));
  return Promise.all([
    new Promise((r) => tls.listen(httpsPort, '127.0.0.1', r)),
    new Promise((r) => web.listen(httpPort, '127.0.0.1', r)),
  ]).then(() => ({ close: () => { tls.close(); web.close(); } }));
}
module.exports = { start };
