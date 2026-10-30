/*
 * SubTutor – 음높이를 유지하는 속도 바꾸기 (WSOLA)
 *  stretch(samples, sampleRate, rate) → 길이가 1/rate 인 Float32Array (rate>1 = 빠르게)
 *
 * WebAudio 의 playbackRate 는 테이프를 빨리 감듯 주파수까지 함께 바꾸므로,
 * 느리게 하면 목소리가 굵어지고 빠르게 하면 가늘어진다.
 * WSOLA 는 파형을 조각내어 겹쳐 이어 붙이되, 이어 붙일 자리를 파형이 가장 잘 맞는 곳(상관이 큰 곳)에서 찾아
 * 주파수(음높이)는 그대로 두고 길이만 바꾼다.
 * 근거: Verhelst & Roelands (1993), An overlap-add technique based on waveform similarity (WSOLA).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorStretch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_RATE = 0.3, MAX_RATE = 2;
  const clampRate = (r) => Math.min(MAX_RATE, Math.max(MIN_RATE, +r || 1));

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  /**
   * 음높이를 유지한 채 길이만 1/rate 로 바꾼다.
   * @param {Float32Array} input 모노 샘플
   * @param {number} sampleRate
   * @param {number} rate 1보다 크면 빠르게(짧게), 작으면 느리게(길게)
   * @param {object} [opts] { frameMs, searchMs, stride }
   */
  function stretch(input, sampleRate, rate, opts) {
    const o = opts || {};
    const n = input ? input.length : 0;
    const r = clampRate(rate);
    if (!n || Math.abs(r - 1) < 0.005) return input;
    const sr = sampleRate > 0 ? sampleRate : 48000;
    // 60ms 프레임, 50% 겹침: 말소리의 기본 주기(≥5ms)보다 충분히 길어 음높이가 유지된다
    const frame = Math.max(256, Math.round((sr * (o.frameMs || 60)) / 1000) & ~1);
    const half = frame >> 1;                                   // 합성 홉(Hs)
    if (n < frame + half) return input;                         // 너무 짧으면 그대로 (끊김 방지)
    const hop = Math.max(1, Math.round(half * r));              // 분석 홉(Ha)
    const search = Math.max(8, Math.round((sr * (o.searchMs || 7)) / 1000)); // 이어 붙일 자리 찾는 범위 ±7ms
    const stride = Math.max(1, o.stride || 4);                  // 상관 계산 간격 (속도)
    const outLen = Math.max(1, Math.round(n / r));
    const out = new Float32Array(outLen);
    const norm = new Float32Array(outLen);                      // 창 합 (겹침 보정)
    const win = hann(frame);

    let aPos = 0;        // 분석 위치
    let outPos = 0;      // 합성 위치
    let natural = -1;    // 자연스럽게 이어질 다음 조각의 시작 (이전 조각 + half)
    while (outPos < outLen) {
      let p = aPos;
      if (natural >= 0) {
        // 이전 조각 뒤에 자연스럽게 올 파형(natural)과 가장 비슷한 자리를 aPos 둘레에서 찾는다
        let bestScore = -Infinity, bestP = aPos;
        for (let d = -search; d <= search; d++) {
          const q = aPos + d;
          if (q < 0 || q + frame > n) continue;
          let s = 0;
          for (let k = 0; k < half; k += stride) s += input[q + k] * input[natural + k];
          if (s > bestScore) { bestScore = s; bestP = q; }
        }
        p = bestP;
      }
      if (p + frame > n) p = n - frame;
      if (p < 0) break;
      const limit = Math.min(frame, outLen - outPos);
      for (let k = 0; k < limit; k++) { out[outPos + k] += input[p + k] * win[k]; norm[outPos + k] += win[k]; }
      natural = p + half;
      if (natural + half > n) natural = -1;                     // 끝에 닿으면 탐색 없이 이어 간다
      outPos += half;
      aPos += hop;
      if (aPos + frame > n) {
        if (natural < 0) break;
        aPos = Math.max(0, n - frame);                          // 남은 꼬리는 마지막 자리에서 반복해 채운다
      }
    }
    // 창이 겹친 만큼 나눠 원래 크기로 되돌린다 (양 끝은 창 합이 작아 바닥값으로 제한해 잡음 증폭을 막는다)
    for (let i = 0; i < outLen; i++) out[i] /= Math.max(norm[i], 0.5);
    return out;
  }

  /** AudioBuffer 한 구간을 음높이 그대로 rate 배속으로 바꾼 새 AudioBuffer (ctx 는 BaseAudioContext) */
  function stretchBuffer(ctx, buffer, fromSec, toSec, rate, opts) {
    const sr = buffer.sampleRate;
    const a = Math.max(0, Math.min(buffer.length, Math.round(fromSec * sr)));
    const b = Math.max(a + 1, Math.min(buffer.length, Math.round(toSec * sr)));
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(stretch(buffer.getChannelData(c).subarray(a, b), sr, rate, opts));
    const len = chans[0].length;
    const out = ctx.createBuffer(chans.length, len, sr);
    for (let c = 0; c < chans.length; c++) out.copyToChannel ? out.copyToChannel(chans[c], c) : out.getChannelData(c).set(chans[c]);
    return out;
  }

  return { stretch, stretchBuffer, clampRate, MIN_RATE, MAX_RATE };
});
