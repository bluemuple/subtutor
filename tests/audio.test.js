const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../extension/src/lib/audio.js');

const sine = (rate, sec, hz) => { const n = Math.round(rate * sec); const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5; return out; };

test('mediaClockOffset: 중앙값 (탐색 직후 이상값 무시)', () => {
  assert.equal(A.mediaClockOffset([[1000, 0], [1500, 500], [9000, 600]]), 1000);
  assert.equal(A.mediaClockOffset([]), null);
});

test('clipSamples: 벽시계 구간을 프레임으로 잘라낸다', () => {
  const rate = 1000;
  const chunks = [{ startFrame: 0, samples: new Float32Array(1000).fill(0.1) }, { startFrame: 1000, samples: new Float32Array(1000).fill(0.2) }];
  const out = A.clipSamples(chunks, { originMs: 5000, sampleRate: rate, startMs: 5500, endMs: 6500 });
  assert.equal(out.length, 1000);
  assert.ok(Math.abs(out[0] - 0.1) < 1e-6 && Math.abs(out[999] - 0.2) < 1e-6);
  assert.equal(A.clipSamples(chunks, { originMs: 5000, sampleRate: rate, startMs: 9000, endMs: 9500 }), null);
});

test('WAV 헤더', () => {
  const wav = A.encodeMonoWav(sine(16000, 0.5, 440), 16000);
  const h = A.parseWavHeader(wav);
  assert.deepEqual(h, { channels: 1, sampleRate: 16000, bits: 16, dataBytes: 16000 });
});

test('MP3 인코딩 (lamejs) → ffprobe 로 디코딩 가능', () => {
  assert.equal(A.hasMp3(), true);
  const bytes = A.encodeMonoMp3(sine(48000, 2, 440), 48000, 128);
  assert.ok(bytes.length > 20000 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0, 'mp3 sync');
  const file = path.join(__dirname, 'e2e', '.tmp', 'unit-check.mp3');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'default=nw=1', file]).toString();
  assert.match(probe, /codec_name=mp3/);
  assert.match(probe, /sample_rate=48000/);
  const dur = parseFloat(/duration=([\d.]+)/.exec(probe)[1]);
  assert.ok(dur > 1.9 && dur < 2.2, 'duration ' + dur);
});

test('encodeClip: 리샘플 + MP3, 요청 시 WAV', () => {
  const pcm = sine(48000, 1, 300);
  const mp3 = A.encodeClip(pcm, 48000, { rate: 32000, kbps: 64 });
  assert.equal(mp3.format, 'mp3'); assert.equal(mp3.mime, 'audio/mpeg'); assert.equal(mp3.rate, 32000);
  const wav = A.encodeClip(pcm, 48000, { format: 'wav', rate: 16000 });
  assert.equal(wav.format, 'wav'); assert.equal(A.parseWavHeader(wav.bytes).sampleRate, 16000);
  assert.equal(A.base64ToBytes(A.bytesToBase64(mp3.bytes)).length, mp3.bytes.length);
});

test('파일 이름 정리', () => {
  assert.equal(A.safeFileName('a/b:c*?"<>|  d', 40), 'a b c d');
  assert.equal(A.fmtClock(3723400), '01-02-03');
  assert.equal(A.fmtClock(65000), '01-05');
});

// ── 더빙 재생 시계: 디즈니+ 처럼 재생 위치를 띄엄띄엄(계단식으로) 알려 주는 플레이어 흉내
// 실제 위치 M(t)=t, 플레이어가 알려 주는 위치는 step 단위로 내림, 보고는 불규칙한 두 타이머(500ms·330ms)로 온다.
// 콘텐츠 스크립트는 마지막 보고에서 이어 붙여 위치를 만든다 (adapters.js disney.timeMs 와 같다).
function steppedClock(step) {
  const reports = [];
  for (let a = 130; a < 30000; a += 500) reports.push(a);
  for (let a = 60; a < 30000; a += 330) reports.push(a);
  reports.sort((x, y) => x - y);
  let k = -1;
  return (t) => {
    while (k + 1 < reports.length && reports[k + 1] + 5 <= t) k++;
    if (k < 0) return Math.floor(t / step) * step;
    const at = reports[k];
    return Math.floor(at / step) * step + (t - (at + 5));
  };
}
// 더빙 엔진 흉내: 녹음 창 [from, from+len) 에 들어서면 시작, 매 40ms 틱마다 어긋남을 보고 다시 맞춘 횟수를 센다
function simulateDub(rawAt, policy, opts) {
  const o = opts || {};
  const from = o.from || 5750, len = o.len || 2500;
  const clock = policy === 'new' ? A.mediaClock() : null;
  let play = null, restarts = 0, off = 0;
  for (let t = 0; t <= (o.until || 9000); t += 40) {
    const raw = rawAt(t);
    const m = clock ? clock.update(raw, t, false, 1) : raw;
    const inWin = m >= from && m < from + len - 40;
    if (!inWin) { play = null; continue; }
    const want = (m - from) / 1000;
    if (!play) { play = { offset: want, startT: t }; continue; }
    const pos = play.offset + (t - play.startT) / 1000;
    const d = want - pos;
    if (policy === 'old') { if (Math.abs(d) > 0.2) { restarts++; play = { offset: want, startT: t }; } continue; }
    off = Math.abs(d) > 0.45 ? off + 1 : 0;
    if (Math.abs(d) > 1.5 || off >= 3) { restarts++; off = 0; play = { offset: want, startT: t }; }
  }
  return restarts;
}

test('mediaClock: 계단식으로 알려 주는 재생 위치(디즈니+)에서도 더빙을 되감지 않는다 — 예전 방식은 말머리가 반복됐다', () => {
  for (const step of [250, 500, 1000]) {
    const rawAt = steppedClock(step);
    const before = simulateDub(rawAt, 'old');
    const after = simulateDub(rawAt, 'new');
    if (step >= 500) assert.ok(before >= 3, 'step ' + step + ': 예전 방식은 여러 번 되감았다 (' + before + '회)');
    assert.equal(after, 0, 'step ' + step + ': 고른 시계로는 한 번도 되감지 않는다');
  }
});

test('mediaClock: 고른 시계는 뒤로 튀지 않고, 실제 위치와 일정한 거리를 유지한다', () => {
  const rawAt = steppedClock(500);
  const c = A.mediaClock();
  let prev = -Infinity, maxBack = 0;
  const lags = [];
  for (let t = 0; t <= 10000; t += 40) {
    const m = c.update(rawAt(t), t, false, 1);
    if (t > 2000) { maxBack = Math.max(maxBack, prev - m); lags.push(t - m); }
    prev = m;
  }
  assert.ok(maxBack < 60, '뒤로 튄 최대 폭 ' + maxBack.toFixed(1) + 'ms');
  const spread = Math.max(...lags) - Math.min(...lags);
  assert.ok(spread < 200, '실제 위치와의 거리 흔들림 ' + spread.toFixed(0) + 'ms (계단 500ms)');
});

test('mediaClock: 매끈한 시계는 그대로, 탐색은 바로 따라가고, 멈춤·배속 변경이면 새로 잰다', () => {
  const c = A.mediaClock();
  for (let t = 0; t <= 3000; t += 40) assert.ok(Math.abs(c.update(1000 + t, t, false, 1) - (1000 + t)) < 1, '영상 요소 시계는 그대로');
  // 탐색: 위치가 20초 앞으로 뛰면 첫 틱부터 따라간다
  assert.equal(c.update(21040 + 3000, 3040, false, 1), 24040);
  // 멈춤이면 받은 값 그대로
  assert.equal(c.update(5000, 3080, true, 1), 5000);
  // 배속 0.8: 위치가 0.8배로 흐르는 것을 그대로 따라간다
  const s = A.mediaClock();
  let last;
  for (let t = 0; t <= 2000; t += 40) last = s.update(500 + t * 0.8, t, false, 0.8);
  assert.ok(Math.abs(last - (500 + 2000 * 0.8)) < 1, '배속을 반영: ' + last);
});
