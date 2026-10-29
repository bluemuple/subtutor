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
    if (/^\/watch\/\d+$/.test(p)) return sendFile(req, res, path.join(root, 'watch.html'));
    if (p.startsWith('/tracks/')) return sendFile(req, res, path.join(root, 'tracks', path.basename(p)));
    if (p.startsWith('/media/')) return sendFile(req, res, path.join(root, 'media', path.basename(p)));
    if (p === '/translate_a/single') {
      const q = url.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify([[['[번역] ' + q, q, null, null]], null, 'en']));
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
