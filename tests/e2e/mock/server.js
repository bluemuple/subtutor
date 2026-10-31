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

function mockHandler(root) {
  return (req, res) => {
    const url = new URL(req.url, 'https://x');
    const p = url.pathname;
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
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
