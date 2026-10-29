/*
 * SubTutor – 어휘 프로파일 (확장 프로그램 전용)
 *  - rankOf(word, freq): 빈도 순위 (1 = 가장 흔함, 없으면 0). 가벼운 어형 복원(-s, -ed, -ing, 's).
 *  - profile(cues, freq): 토큰 수, 밴드별 비율, 95%/98% 커버리지에 필요한 단어 수(순위), 3천 밖 단어 목록, 말 속도(wpm).
 * 근거: Nation (2006) 듣기용 어휘 크기; Webb & Rodgers (2009) TV 커버리지; van Zeeland & Schmitt (2013) 듣기 95% 커버리지; Rodgers & Webb (2011) 같은 시리즈 반복.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorVocab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  let index = null, indexFor = null;
  function buildIndex(freq) {
    if (index && indexFor === freq) return index;
    const map = new Map();
    String(freq || '').split('\n').forEach((w, i) => { if (w && !map.has(w)) map.set(w, i + 1); });
    index = map; indexFor = freq;
    return map;
  }
  const norm = (t) => String(t).toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z']+|[^a-z']+$/g, '');
  // 어형 후보: 더 구체적인 것부터. 짧은 어간(3자 미만)은 버려 us/bit 같은 엉뚱한 단어와 겹치지 않게 한다
  function candidates(w) {
    const out = [w];
    const add = (x) => { if (x && x.length >= 3 && !out.includes(x)) out.push(x); };
    if (w.endsWith("'s")) add(w.slice(0, -2));
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    else if (/(s|x|z|ch|sh)es$/.test(w)) add(w.slice(0, -2));
    else if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    else if (/ed$/.test(w)) { add(w.slice(0, -1)); add(w.slice(0, -2)); if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) add(w.slice(0, -3)); }
    if (/ing$/.test(w)) { add(w.slice(0, -3) + 'e'); add(w.slice(0, -3)); if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) add(w.slice(0, -4)); }
    if (/ly$/.test(w)) add(w.slice(0, -2));
    if (/er$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) add(w.slice(0, -3)); }
    if (/est$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
    if (/n't$/.test(w)) add(w.slice(0, -3));
    const ap = w.indexOf("'");
    if (ap > 0) add(w.slice(0, ap));
    return out;
  }
  // 가장 구체적인 어형부터 찾아 처음 발견되는 순위를 쓴다 (단어형 빈도; bites 가 목록에 있으면 bites, 없으면 bite)
  function rankOf(word, freq) {
    const map = buildIndex(freq);
    const w = norm(word);
    if (!w) return 0;
    for (const c of candidates(w)) { const r = map.get(c); if (r) return r; }
    return 0;
  }
  const BANDS = [[1000, '1천'], [2000, '2천'], [3000, '3천'], [5000, '5천'], [10000, '1만'], [20000, '2만']];
  function band(rank) { if (!rank) return '없음'; for (const [n, label] of BANDS) if (rank <= n) return label; return '2만+'; }
  const isName = (t) => /^[A-Z][a-z]+$/.test(t);
  function tokenize(text) { return String(text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').split(/\s+/).map((t) => t.trim()).filter(Boolean); }
  function profile(cues, freq, opts) {
    const o = opts || {};
    const counts = new Map(); // norm word -> {n, rank, example, name}
    let tokens = 0, firstStart = Infinity, lastEnd = -Infinity;
    for (const c of cues || []) {
      const text = typeof c === 'string' ? c : (c.text || '');
      if (typeof c === 'object') { if (Number.isFinite(c.start)) firstStart = Math.min(firstStart, c.start); if (Number.isFinite(c.end)) lastEnd = Math.max(lastEnd, c.end); }
      const toks = tokenize(text);
      toks.forEach((raw, i) => {
        const w = norm(raw);
        if (!w || !/[a-z]/.test(w)) return;
        tokens++;
        let e = counts.get(w);
        if (!e) { e = { word: w, n: 0, rank: rankOf(w, freq), example: text, name: isName(raw) && i > 0 }; counts.set(w, e); }
        e.n++;
        if (!(isName(raw) && i > 0)) e.name = false;
      });
    }
    const bands = {};
    let within3k = 0, namesTokens = 0;
    const byRank = [];
    for (const e of counts.values()) {
      const b = e.name && !e.rank ? '이름' : band(e.rank);
      bands[b] = (bands[b] || 0) + e.n;
      if (e.rank && e.rank <= 3000) within3k += e.n;
      if (e.name) namesTokens += e.n;
      byRank.push(e);
    }
    // 커버리지 곡선: 순위 r 이하 단어가 토큰의 몇 %를 덮는가 → 95%/98% 를 넘는 최소 순위
    const ranked = byRank.filter((e) => e.rank).sort((a, b) => a.rank - b.rank);
    let acc = 0, need95 = null, need98 = null;
    for (const e of ranked) { acc += e.n; if (need95 === null && acc / tokens >= 0.95) need95 = e.rank; if (need98 === null && acc / tokens >= 0.98) need98 = e.rank; }
    const beyond = byRank.filter((e) => !e.name && (!e.rank || e.rank > 3000)).sort((a, b) => b.n - a.n || (a.rank || 99999) - (b.rank || 99999));
    const minutes = isFinite(firstStart) && isFinite(lastEnd) && lastEnd > firstStart ? (lastEnd - firstStart) / 60000 : (o.minutes || 0);
    return {
      tokens, types: counts.size, bands, within3kPct: tokens ? Math.round((within3k / tokens) * 1000) / 10 : 0, namesPct: tokens ? Math.round((namesTokens / tokens) * 1000) / 10 : 0,
      need95, need98, beyond3k: beyond, wpm: minutes ? Math.round(tokens / minutes) : 0, minutes: Math.round(minutes * 10) / 10,
    };
  }
  // 어려움 등급: 3천 밖(이름 제외) 비율로
  function difficulty(p) {
    const outside = p.tokens ? 100 - p.within3kPct - p.namesPct : 0;
    if (outside < 5) return { label: '쉬움', outside };
    if (outside < 10) return { label: '보통', outside };
    return { label: '어려움', outside };
  }
  return { rankOf, band, profile, difficulty, tokenize, norm };
});
