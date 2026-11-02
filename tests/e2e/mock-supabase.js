// 모의 Supabase (아이폰 앱·웹 동기화 검사용). node tests/e2e/mock-supabase.js [seed.mp3] [port]
// 시뮬레이터 수동 검사는 8768, E2E 하네스는 8769 로 띄운다
// GoTrue(password/refresh/signup) + PostgREST(items/words upsert·select) + Storage(audio 업로드/다운로드) + CORS
const http = require('http');
const fs = require('fs');
const state = { items: new Map(), words: new Map(), objects: new Map(), tokens: 0 };
const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'me@test.local' };
const seedMp3 = process.argv[2]; // 시드 MP3 파일 경로 (없으면 시드 없음)
if (seedMp3 && fs.existsSync(seedMp3)) {
  const mp3 = fs.readFileSync(seedMp3);
  const items = [
    { id: 'netflix:777:2000', title: 'Mock Moana', episode: 'S1 E1', platform: 'netflix', text: 'Have you got a pen?', translation: '펜 있어요?', start_ms: 2000, end_ms: 4000, saved_at: Date.now() - 60000, box: 'learning', comment: '', tags: [], missed: false, miss_reason: '', has_audio: true, audio_ms: 1500 },
    { id: 'netflix:777:6000', title: 'Mock Moana', episode: 'S1 E1', platform: 'netflix', text: "Sweet as, see you at morning tea.", translation: '좋아, 모닝티 때 봐.', start_ms: 6000, end_ms: 8500, saved_at: Date.now() - 50000, box: 'learning', comment: '', tags: [], missed: true, miss_reason: 'accent', has_audio: true, audio_ms: 1500 },
    { id: 'tvnz:shortland:9000', title: 'Shortland Street', episode: 'S2026 E110', platform: 'tvnz', text: 'We need to prepare for evacuation.', translation: '대피를 준비해야 해요.', start_ms: 9000, end_ms: 11500, saved_at: Date.now() - 40000, box: 'learning', comment: '', tags: [], missed: false, miss_reason: '', has_audio: true, audio_ms: 1500 },
    { id: 'youtube:abc:1000', title: 'Teacher Talk', episode: '', platform: 'youtube', text: 'No audio line (text only).', translation: '소리 없는 줄.', start_ms: 1000, end_ms: 3000, saved_at: Date.now() - 30000, box: 'learning', comment: '', tags: [], missed: false, miss_reason: '', has_audio: false, audio_ms: 0 },
  ];
  for (const it of items) { state.items.set(it.id, Object.assign({ user_id: USER.id, updated_at: new Date().toISOString() }, it)); }
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  for (const it of items) if (it.has_audio) state.objects.set('audio/' + USER.id + '/' + safe(it.id) + '.mp3', mp3);
  console.log('seeded', items.length, 'items,', state.objects.size, 'audio files');
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, x-upsert, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
const json = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  try {
    if (p === '/auth/v1/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password' && !(body.email && body.password)) return json(res, 400, { error: 'invalid' });
      if (grant === 'password' && body.password === 'wrong') return json(res, 400, { error_description: 'Invalid login credentials' });
      state.tokens++;
      return json(res, 200, { access_token: 'at-' + state.tokens, refresh_token: 'rt-' + state.tokens, token_type: 'bearer', expires_in: 3600, user: USER });
    }
    if (p === '/auth/v1/signup' && req.method === 'POST') { await readBody(req); state.tokens++; return json(res, 200, { access_token: 'at-' + state.tokens, refresh_token: 'rt-' + state.tokens, user: USER }); }
    if (p === '/rest/v1/items' && req.method === 'GET') {
      let list = [...state.items.values()];
      list.sort((a, b) => b.saved_at - a.saved_at);
      return json(res, 200, list);
    }
    if (p === '/rest/v1/items' && req.method === 'POST') {
      const rows = JSON.parse((await readBody(req)).toString());
      for (const r of [].concat(rows)) state.items.set(r.id, Object.assign({ user_id: USER.id, updated_at: new Date().toISOString() }, state.items.get(r.id) || {}, r));
      res.writeHead(201, CORS); res.end();
      return;
    }
    if (p === '/rest/v1/words' && req.method === 'GET') return json(res, 200, [...state.words.values()]);
    if (p === '/rest/v1/words' && req.method === 'POST') {
      const rows = JSON.parse((await readBody(req)).toString());
      for (const r of [].concat(rows)) state.words.set(r.word, Object.assign({ user_id: USER.id }, r));
      res.writeHead(201, CORS); res.end();
      return;
    }
    if (p.startsWith('/storage/v1/object/audio/')) {
      const key = 'audio/' + decodeURIComponent(p.slice('/storage/v1/object/audio/'.length));
      if (req.method === 'GET') {
        const buf = state.objects.get(key);
        if (!buf) return json(res, 404, { error: 'not found' });
        res.writeHead(200, Object.assign({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length }, CORS));
        res.end(buf);
        return;
      }
      if (req.method === 'POST' || req.method === 'PUT') { state.objects.set(key, await readBody(req)); return json(res, 200, { Key: key }); }
    }
    if (p === '/__state') return json(res, 200, { items: [...state.items.values()], words: [...state.words.values()], objects: [...state.objects.keys()].map((k) => [k, state.objects.get(k).length]) });
    json(res, 404, { error: 'mock 404 ' + req.method + ' ' + p });
  } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
}).listen(+(process.argv[3] || 8768), '127.0.0.1', function () { console.log('mock supabase on http://127.0.0.1:' + this.address().port); });
