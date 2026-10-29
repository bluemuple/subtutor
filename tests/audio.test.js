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
