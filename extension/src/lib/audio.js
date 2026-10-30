/*
 * SubTutor – 오디오 유틸 (캡처 프레임·콘텐츠 스크립트·node 테스트 공용)
 * PCM 조각 모으기, 벽시계 ↔ 미디어 시간 맞추기, 구간 자르기, 리샘플, 16비트 모노 WAV 인코딩
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** (벽시계ms, 미디어ms) 쌍들에서 벽시계 - 미디어 의 중앙값. 탐색 직후의 이상값에 흔들리지 않는다 */
  function mediaClockOffset(anchors) {
    const offsets = (Array.isArray(anchors) ? anchors : [])
      .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      .map(([wall, media]) => wall - media)
      .sort((a, b) => a - b);
    if (!offsets.length) return null;
    const mid = Math.floor(offsets.length / 2);
    return offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  }

  /**
   * 녹음 조각(chunks: {startFrame, samples(Float32Array)})에서 벽시계 [startMs, endMs] 구간을 잘라낸다.
   * originMs = 프레임 0 의 벽시계 시각. 빠진 구간은 무음으로 채우고, 녹음 범위 밖은 잘라낸다.
   */
  /**
   * 들쭉날쭉한 재생 위치를 매끈한 시계로 바꾼다.
   * 디즈니+ 는 재생 위치를 0.5초쯤 간격으로 끊어서(그리고 조금 늦게) 알려 주므로, 그 사이를 이어 붙인 시각은 톱니처럼 뒤로 튄다.
   * 최근 windowMs 동안의 (위치 − 시각×배속) 중앙값을 쓴다. 멈춤·배속 변경·jumpMs 넘는 점프(탐색)면 새로 잰다.
   * update(위치ms, 지금ms, 멈춤?, 배속) → 고른 위치ms
   */
  function mediaClock(opts) {
    const o = opts || {};
    const windowMs = o.windowMs || 1500, jumpMs = o.jumpMs || 1200, minSamples = o.minSamples || 3;
    let samples = [], rate = 1;
    const median = () => { const a = samples.map((x) => x[1]).sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    return {
      reset() { samples = []; },
      update(mediaMs, nowMs, paused, playbackRate) {
        const r = playbackRate > 0 ? playbackRate : 1;
        if (!Number.isFinite(mediaMs) || !Number.isFinite(nowMs)) return mediaMs;
        if (paused || Math.abs(r - rate) > 1e-3) { samples = []; rate = r; return mediaMs; }
        const off = mediaMs - nowMs * r;
        if (samples.length && Math.abs(off - median()) > jumpMs) samples = [];
        samples.push([nowMs, off]);
        while (samples.length > 1 && nowMs - samples[0][0] > windowMs) samples.shift();
        return samples.length < minSamples ? mediaMs : nowMs * r + median();
      },
    };
  }
  function clipSamples(chunks, { originMs, sampleRate, startMs, endMs }) {
    if (![originMs, sampleRate, startMs, endMs].every(Number.isFinite) || sampleRate <= 0 || endMs <= startMs || !chunks.length) return null;
    let recStart = Infinity, recEnd = -Infinity;
    for (const c of chunks) { recStart = Math.min(recStart, c.startFrame); recEnd = Math.max(recEnd, c.startFrame + c.samples.length); }
    const from = Math.max(recStart, Math.round(((startMs - originMs) * sampleRate) / 1000));
    const to = Math.min(recEnd, Math.round(((endMs - originMs) * sampleRate) / 1000));
    if (to <= from) return null;
    const out = new Float32Array(to - from);
    for (const c of chunks) {
      const b = Math.max(from, c.startFrame);
      const e = Math.min(to, c.startFrame + c.samples.length);
      if (e > b) out.set(c.samples.subarray(b - c.startFrame, e - c.startFrame), b - from);
    }
    return out;
  }

  const isSilent = (samples) => { for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return false; return true; };

  /** 선형 보간 리샘플 (모노) */
  function resample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const n = Math.max(1, Math.floor(samples.length / ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const frac = pos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  /** 피크 정규화 (최대 0.95), 너무 조용하면 증폭 상한 8배 */
  function normalize(samples, target) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (!peak) return samples;
    const gain = Math.min(8, (target || 0.95) / peak);
    if (Math.abs(gain - 1) < 0.05) return samples;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
    return out;
  }

  function setAscii(view, offset, s) { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); }
  /** 16비트 모노 PCM WAV */
  function encodeMonoWav(samples, sampleRate) {
    const byteLength = 44 + samples.length * 2;
    const buf = new ArrayBuffer(byteLength);
    const v = new DataView(buf);
    setAscii(v, 0, 'RIFF'); v.setUint32(4, byteLength - 8, true); setAscii(v, 8, 'WAVE');
    setAscii(v, 12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    setAscii(v, 36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }
  function floatToInt16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out;
  }
  function lame() {
    if (typeof globalThis.lamejs === 'function' && globalThis.lamejs.Mp3Encoder) return globalThis.lamejs;
    if (typeof require === 'function') { try { return require('../../vendor/lamejs/lame.min.js'); } catch (e) { /* ignore */ } }
    return null;
  }
  const hasMp3 = () => !!lame();
  /** 모노 MP3 (lamejs). sampleRate 는 8k~48k, kbps 32~320 */
  function encodeMonoMp3(samples, sampleRate, kbps) {
    const L = lame();
    if (!L) throw new Error('MP3 인코더(lamejs)를 불러오지 못했습니다');
    const enc = new L.Mp3Encoder(1, sampleRate, kbps || 128);
    const pcm = floatToInt16(samples);
    const parts = [];
    let total = 0;
    const BLOCK = 1152;
    for (let i = 0; i < pcm.length; i += BLOCK) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + BLOCK));
      if (b.length) { parts.push(new Uint8Array(b.buffer, b.byteOffset, b.length)); total += b.length; }
    }
    const end = enc.flush();
    if (end.length) { parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length)); total += end.length; }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  /** 클립 인코딩: 가능하면 MP3, 아니면 WAV. 반환 {bytes, format, mime, rate} */
  function encodeClip(samples, sampleRate, opts) {
    const o = opts || {};
    const targetRate = o.rate && o.rate !== sampleRate ? o.rate : sampleRate;
    const pcm = targetRate === sampleRate ? samples : resample(samples, sampleRate, targetRate);
    if (o.format !== 'wav' && hasMp3()) {
      try { return { bytes: encodeMonoMp3(pcm, targetRate, o.kbps || 128), format: 'mp3', mime: 'audio/mpeg', rate: targetRate }; } catch (e) { /* WAV 로 */ }
    }
    return { bytes: encodeMonoWav(pcm, targetRate), format: 'wav', mime: 'audio/wav', rate: targetRate };
  }
  function parseWavHeader(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 44) return null;
    return { channels: v.getUint16(22, true), sampleRate: v.getUint32(24, true), bits: v.getUint16(34, true), dataBytes: v.getUint32(40, true) };
  }

  function bytesToBase64(bytes) {
    if (typeof btoa !== 'function') return Buffer.from(bytes).toString('base64');
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    if (typeof atob !== 'function') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 파일 이름에 못 쓰는 문자 정리 */
  function safeFileName(s, max) {
    const cleaned = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    return (cleaned || 'clip').slice(0, max || 70);
  }
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? String(h).padStart(2, '0') + '-' : '') + String(m).padStart(2, '0') + '-' + String(sec).padStart(2, '0');
  }

  return { mediaClockOffset, mediaClock, clipSamples, isSilent, resample, normalize, encodeMonoWav, encodeMonoMp3, encodeClip, hasMp3, floatToInt16, parseWavHeader, bytesToBase64, base64ToBytes, safeFileName, fmtClock };
});
