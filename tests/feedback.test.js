const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.navigator = globalThis.navigator || {};
const Au = require('../extension/src/lib/audio.js');

const SR = 16000;
function seq(parts) { // parts: [초, 켬?] — 켬이면 440Hz 음, 아니면 무음
  const total = Math.round(parts.reduce((a, [s]) => a + s, 0) * SR);
  const out = new Float32Array(total);
  let i = 0;
  for (const [sec, on] of parts) {
    const n = Math.round(sec * SR);
    if (on) for (let k = 0; k < n; k++) out[i + k] = 0.4 * Math.sin((2 * Math.PI * 440 * k) / SR);
    i += n;
  }
  return out;
}

test('silenceGaps: 말 사이의 0.3초 넘는 무음만 센다 (앞뒤 무음은 제외)', () => {
  assert.equal(Au.silenceGaps(seq([[1, 1], [0.45, 0], [1, 1]]), SR, 300), 1);
  assert.equal(Au.silenceGaps(seq([[0.8, 1], [0.4, 0], [0.5, 1], [0.6, 0], [0.5, 1]]), SR, 300), 2);
  assert.equal(Au.silenceGaps(seq([[1, 1], [0.15, 0], [1, 1]]), SR, 300), 0, '짧은 쉼은 아니다');
  assert.equal(Au.silenceGaps(seq([[0.7, 0], [1, 1], [0.9, 0]]), SR, 300), 0, '앞뒤 무음은 세지 않는다');
  assert.equal(Au.silenceGaps(seq([[1.2, 1]]), SR, 300), 0);
  assert.equal(Au.silenceGaps(null, SR, 300), 0);
});
