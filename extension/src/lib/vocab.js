/*
 * SubTutor – 어휘 프로파일 (확장 프로그램 전용)
 *  - rankOf(word, freq): 빈도 순위 (1 = 가장 흔함, 없으면 0). 가벼운 어형 복원(-s, -ed, -ing, 's).
 *  - profile(cues, freq): 토큰 수, 밴드별 비율, 95%/98% 커버리지에 필요한 단어 수(순위), 3천 밖 단어 목록, 말 속도(wpm).
 *  - wordList(cues, freq) / sortWords(list, mode): 자막의 모든 단어(중복·이름 없이)와 난이도 정렬 (패널 '단어 목록').
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
  // 앞뒤의 문장 부호·따옴표를 뗀다 ('Really? → really, facts.' → facts). 가운데 아포스트로피(don't)는 남긴다
  const norm = (t) => String(t).toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z]+|[^a-z]+$/g, '');
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
    if (ap > 0 && !out.includes(w.slice(0, ap))) out.push(w.slice(0, ap)); // 축약형의 앞부분은 짧아도 쓴다 (i'm → i, we're → we)
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
  // 단어 목록: 자막의 모든 단어를 한 번씩 → [{word, n(이 영상에 나온 횟수), rank, cue(처음 나온 자막 번호)}].
  // 이름은 뺀다: 늘 대문자로 시작하고(소문자로는 한 번도 안 나옴) 빈도 목록에 없거나 문장 중간에서도 대문자인 단어.
  // 하이픈 낱말(well-known)은 가장 드문 부분의 순위를 쓴다
  const BASIC_RANK = 300; // 이보다 흔한 단어(the, to, I …)는 '아주 쉬운 단어'
  const SENT_END = /[.!?…:]["'”’)\]]*$/;
  function wordRank(w, freq) {
    const r = rankOf(w, freq);
    if (r || w.indexOf('-') < 0) return r;
    const parts = w.split('-').filter(Boolean).map((x) => rankOf(x, freq));
    return parts.length && parts.every(Boolean) ? Math.max(...parts) : 0;
  }
  function wordList(cues, freq) {
    const map = new Map();
    (cues || []).forEach((c, ci) => {
      const text = typeof c === 'string' ? c : (c && c.text) || '';
      const toks = tokenize(text.replace(/\n/g, ' '));
      toks.forEach((raw, k) => {
        if (/^[A-Z][A-Z'-]+:$/.test(raw)) return; // 화자 표시 (SOFIA:)
        const w = norm(raw);
        if (!/^[a-z][a-z'-]*$/.test(w) || (w.length < 2 && w !== 'a' && w !== 'i')) return;
        const bare = raw.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '');
        const title = /^[A-Z](?=.*[a-z])/.test(bare) && !/^I'/.test(bare), lower = /^[a-z]/.test(bare); // I'm · I've 는 이름이 아니다
        // 문장 중간: 자막 첫 단어가 아니고, 앞 단어가 문장 끝(. ! ? …)이나 대화 줄표가 아니고, 따옴표로 여는 말(인용 첫 단어)도 아닐 때
        const mid = k > 0 && !/^["'“‘(\[]/.test(raw) && !SENT_END.test(toks[k - 1]) && !/^[-–—]$/.test(toks[k - 1]);
        let e = map.get(w);
        if (!e) { e = { word: w, n: 0, rank: wordRank(w, freq), cue: ci, cap: 0, low: 0, midCap: 0 }; map.set(w, e); }
        e.n++;
        if (title) { e.cap++; if (mid) e.midCap++; } else if (lower) e.low++;
      });
    });
    const out = [];
    for (const e of map.values()) {
      const name = e.low === 0 && e.cap > 0 && (!e.rank || e.midCap > 0) && e.word !== 'i';
      if (!name) out.push({ word: e.word, n: e.n, rank: e.rank, cue: e.cue });
    }
    return out;
  }
  // 정렬: 'hard' 드문 단어부터(빈도 목록 밖이 맨 앞) · 'easy' 흔한 단어부터 · 'easyNoBasic' 아주 쉬운 단어(순위 300 안) 빼고 흔한 단어부터
  function sortWords(list, mode) {
    const r = (e) => e.rank || 1e9;
    const tie = (a, b) => b.n - a.n || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0);
    if (mode === 'easy') return list.slice().sort((a, b) => r(a) - r(b) || tie(a, b));
    if (mode === 'easyNoBasic') return list.filter((e) => !(e.rank && e.rank <= BASIC_RANK)).sort((a, b) => r(a) - r(b) || tie(a, b));
    return list.slice().sort((a, b) => r(b) - r(a) || tie(a, b));
  }
  // 어려움 등급: 3천 밖(이름 제외) 비율로
  function difficulty(p) {
    const outside = p.tokens ? 100 - p.within3kPct - p.namesPct : 0;
    if (outside < 5) return { label: '쉬움', outside };
    if (outside < 10) return { label: '보통', outside };
    return { label: '어려움', outside };
  }
  return { rankOf, band, profile, difficulty, tokenize, norm, wordList, sortWords, BASIC_RANK };
});
