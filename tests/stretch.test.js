const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../extension/src/lib/stretch.js');

const SR = 48000;
// 사람 목소리처럼 기본 주파수 + 배음
function voice(sec, f0) {
  const n = Math.round(SR * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = 0.4 * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.3 * Math.sin(6 * Math.PI * f0 * t));
  }
  return out;
}
// 한 주파수의 세기 (Goertzel)
function mag(x, hz, from, len) {
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) { const s = x[from + i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / len;
}
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
const mid = (x) => { const from = Math.floor(x.length * 0.25); return { from, len: Math.min(19200, x.length - from) }; };

test('stretch: 길이는 1/배속, 음높이·배음은 그대로 (느리게 해도 굵어지지 않는다)', () => {
  const f0 = 120;
  const src = voice(1.2, f0);
  const m = mid(src);
  const base = [f0, 2 * f0, 3 * f0].map((f) => mag(src, f, m.from, m.len));
  for (const rate of [0.3, 0.5, 0.7, 0.85, 1.15, 1.5, 2]) {
    const out = S.stretch(src, SR, rate);
    const want = Math.round(src.length / rate);
    assert.ok(Math.abs(out.length - want) <= 2, `rate ${rate}: 길이 ${out.length} ≈ ${want}`);
    const o = mid(out);
    [f0, 2 * f0, 3 * f0].forEach((f, k) => {
      const got = mag(out, f, o.from, o.len);
      assert.ok(Math.abs(got - base[k]) < 0.02, `rate ${rate}: ${f}Hz 세기 ${got.toFixed(3)} ≈ ${base[k].toFixed(3)}`);
    });
    // 음높이가 내려갔다면(테이프 효과) 아래쪽에 없던 성분이 생긴다
    for (const f of [f0 * rate * 0.98, f0 / 2, 40]) {
      if (Math.abs(f - f0) < 8 || Math.abs(f - 2 * f0) < 8) continue;
      assert.ok(mag(out, f, o.from, o.len) < 0.02, `rate ${rate}: ${Math.round(f)}Hz 에 새 성분 없음`);
    }
    assert.ok(Math.abs(rms(out) - rms(src)) < 0.02, `rate ${rate}: 음량 유지 ${rms(out).toFixed(3)} ≈ ${rms(src).toFixed(3)}`);
  }
});

test('stretch: 높은 목소리도 가늘어지지 않는다', () => {
  const f0 = 220;
  const src = voice(1, f0);
  for (const rate of [0.5, 1.5]) {
    const out = S.stretch(src, SR, rate);
    const o = mid(out);
    assert.ok(mag(out, f0, o.from, o.len) > 0.15, `rate ${rate}: 원래 음높이 유지`);
    // 테이프를 빨리 감듯 바뀌었다면 기본 주파수가 f0 × 배속 으로 옮겨 간다 (220Hz 기준 110Hz / 330Hz: 배음과 겹치지 않는 자리)
    assert.ok(mag(out, f0 * rate, o.from, o.len) < 0.02, `rate ${rate}: 음높이가 ${Math.round(f0 * rate)}Hz 로 옮겨 가지 않음`);
  }
});

test('stretch: 1배속·아주 짧은 소리·잘못된 값은 그대로 돌려준다', () => {
  const src = voice(0.5, 200);
  assert.equal(S.stretch(src, SR, 1), src);
  assert.equal(S.stretch(src, SR, 1.002), src);
  const tiny = voice(0.03, 200);
  assert.equal(S.stretch(tiny, SR, 0.5), tiny);
  assert.equal(S.stretch(src, SR, 0), src);       // clampRate → 1
  assert.equal(S.stretch(null, SR, 0.5), null);
});

test('clampRate: 0.3~2.0 으로 제한', () => {
  assert.equal(S.clampRate(0.1), 0.3);
  assert.equal(S.clampRate(5), 2);
  assert.equal(S.clampRate(0.85), 0.85);
  assert.equal(S.MIN_RATE, 0.3);
  assert.equal(S.MAX_RATE, 2);
});

test('stretch: 이어 붙인 자리에 뚝 끊기는 곳이 없다', () => {
  const src = voice(1, 150);
  for (const rate of [0.4, 0.8, 1.6]) {
    const out = S.stretch(src, SR, rate);
    let maxJump = 0;
    for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    const srcJump = (() => { let m = 0; for (let i = 1; i < src.length; i++) m = Math.max(m, Math.abs(src[i] - src[i - 1])); return m; })();
    assert.ok(maxJump < srcJump * 3, `rate ${rate}: 최대 샘플 간 변화 ${maxJump.toFixed(4)} < ${(srcJump * 3).toFixed(4)}`);
  }
});
