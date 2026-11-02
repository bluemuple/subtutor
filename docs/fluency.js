/*
 * SubTutor – 입트기(말하기 유창성 연습) 도우미. 웹(docs)과 단위 테스트가 함께 쓴다.
 *  - parsePromptLines(text): 여러 줄 붙여넣기 → 1줄 1프롬프트 (번호·글머리표 떼고, 빈 줄·중복 제거)
 *  - overUnder(targetS, actualS): 줄여 말하기 결과 — "N초 초과" / "N초 부족" / "딱 맞춤"
 *  - wpm(text, durMs): 받아 적은 문장으로 분당 단어 수(말 속도)
 *  - fmtClock(s): 75 → "1:15"
 * 근거: 같은 말을 점점 짧은 시간에 되풀이하는 4/3/2 활동이 말 속도·막힘을 줄인다
 * (Nation 1989, System 17(3); Boers 2014, ELT Journal 68(3); de Jong & Perfetti 2011, Language Learning 61(2)).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorFluency = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parsePromptLines(text) {
    const seen = new Set();
    const out = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
      const t = line.trim().replace(/^(?:[-*•▪·–—]|\d+[.)]|\(\d+\))\s*/, '').trim();
      if (!t) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    });
    return out;
  }

  function overUnder(targetS, actualS) {
    const d = Math.round(actualS) - Math.round(targetS);
    if (d > 0) return { diff: d, text: d + '초 초과' };
    if (d < 0) return { diff: d, text: -d + '초 부족' };
    return { diff: 0, text: '딱 맞춤' };
  }

  function wpm(text, durMs) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    if (!words || !durMs || durMs < 1000) return null;
    return Math.round(words / (durMs / 60000));
  }

  function fmtClock(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  return { parsePromptLines, overUnder, wpm, fmtClock };
});
