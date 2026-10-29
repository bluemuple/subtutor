/*
 * SubTutor – 말소리 도우미 (확장 프로그램 ISOLATED world 와 웹사이트 공용)
 *  - soundsLike(text): 빠른 구어에서 실제로 들리는 모양으로 바꿔 준다 (gonna, didja, 'em, 연음 ‿ 등). 규칙 기반.
 *  - clozeLine(text, mode, seed): 빈칸 자막 — 기능어(약형) 또는 임의 단어를 ____ 로 가린다.
 *  - findKiwi(text, dict): 키위·마오리·학교 용어를 찾아 [{term, ko, cat, start, end}] 로 준다.
 * 근거: Field (2003, 2008) 단어 경계 분절 실패와 약형; Cauldwell (2013) 연속 발화의 압축; Siegel & Siegel (2015) 상향식 듣기 활동.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 소리 나는 대로 ──
  // [정규식, 대체]. 앞에서부터 차례로 적용. 대소문자 무시, 단어 경계 유지.
  const RULES = [
    [/\bgoing to\b(?!\s+(?:the|a|an|my|your|his|her|our|their|school|town|bed|work)\b)/gi, 'gonna'],
    [/\bwant to\b/gi, 'wanna'], [/\bwants to\b/gi, 'wansta'],
    [/\bgot to\b/gi, 'gotta'], [/\bhave to\b/gi, 'hafta'], [/\bhas to\b/gi, 'hasta'],
    [/\bought to\b/gi, 'oughta'], [/\bout of\b/gi, 'outta'],
    [/\bkind of\b/gi, 'kinda'], [/\bsort of\b/gi, 'sorta'], [/\blot of\b/gi, 'lotta'], [/\blots of\b/gi, 'lotsa'],
    [/\bdon't know\b/gi, 'dunno'], [/\blet me\b/gi, 'lemme'], [/\bgive me\b/gi, 'gimme'],
    [/\bdid you\b/gi, 'didja'], [/\bdo you\b/gi, "d'ya"], [/\bwould you\b/gi, 'wouldja'], [/\bcould you\b/gi, 'couldja'],
    [/\bwhat do you\b/gi, 'whaddya'], [/\bwhat are you\b/gi, 'whatcha'], [/\bwhat did you\b/gi, 'whadja'],
    [/\bshould have\b/gi, "should've"], [/\bcould have\b/gi, "could've"], [/\bwould have\b/gi, "would've"], [/\bmust have\b/gi, "must've"], [/\bmight have\b/gi, "might've"],
    [/\bbecause\b/gi, "'cause"], [/\bprobably\b/gi, "prob'ly"], [/\bthem\b/gi, "'em"],
    [/\byou know\b/gi, "y'know"], [/\bisn't it\b/gi, "innit"],
    [/\bgoing\b/gi, "goin'"], [/\bdoing\b/gi, "doin'"], [/\bnothing\b/gi, "nothin'"], [/\bsomething\b/gi, "somethin'"],
    [/\band\b/gi, "'n'"],
  ];
  // 모음 앞 t 가 약해지는 경우(물→wadder 식): 미국·호주·뉴질랜드 구어의 'flapping'
  const FLAP = [[/\bwater\b/gi, 'wadder'], [/\bbetter\b/gi, 'bedder'], [/\blittle\b/gi, 'liddle'], [/\bbottle\b/gi, 'boddle'], [/\bget it\b/gi, 'geddit'], [/\bgot it\b/gi, 'goddit'], [/\bput it\b/gi, 'puddit'], [/\bwhat a\b/gi, 'whadda'], [/\bpretty\b/gi, 'priddy'], [/\bcity\b/gi, 'ciddy'], [/\bparty\b/gi, 'pardy'], [/\blater\b/gi, 'lader']];
  const VOWEL = /^[aeiou]/i;
  const ENDS_CONS = /[bcdfgklmnprstvz]$/i;
  function soundsLike(text) {
    let s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    for (const [re, to] of RULES) s = s.replace(re, (m) => (m[0] === m[0].toUpperCase() && /[A-Z]/.test(m[0]) ? to[0].toUpperCase() + to.slice(1) : to));
    for (const [re, to] of FLAP) s = s.replace(re, to);
    // 연음: 자음으로 끝나는 단어 + 모음으로 시작하는 단어 → ‿ 로 잇는다
    const words = s.split(' ');
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i].replace(/[^A-Za-z']+$/, ''), b = words[i + 1];
      if (ENDS_CONS.test(a) && VOWEL.test(b) && !/[.,!?;:]$/.test(words[i])) words[i] = words[i] + '‿';
    }
    return words.join(' ').replace(/‿ /g, '‿');
  }

  // ── 빈칸 자막 ──
  const FUNCTION_WORDS = new Set(['to', 'of', 'and', 'the', 'a', 'an', 'them', 'have', 'has', 'had', 'you', 'your', 'are', 'were', 'was', 'is', 'that', 'there', 'their', 'it', "it's", 'its', 'can', "can't", 'will', 'would', 'could', 'should', 'for', 'from', 'with', 'at', 'in', 'on', 'or', 'but', 'than', 'then', 'been', 'be', 'do', 'does', 'did', "don't", "didn't", 'not', 'as', 'if', 'him', 'her', 'his', 'our', 'us', 'we', 'they', 'he', 'she', 'me', 'my', 'some', 'any', 'this', 'these', 'those', 'what', 'who', 'how', 'when', 'where', 'why', 'just', 'so', 'up', 'out', 'off', 'about', 'into', 'over', "i'll", "you'll", "we'll", "i've", "you've", "we've", "i'd", "you'd", "he's", "she's", "we're", "they're", "you're", "that's", "there's", "what's", 'gonna', 'wanna', 'gotta']);
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // mode: 'function' (기능어 우선) | 'random'. 반환 {text, blanks:[단어]}
  function clozeLine(text, mode, seed) {
    const src = String(text || '');
    const tokens = src.split(/(\s+)/);
    const idx = [];
    tokens.forEach((t, i) => { if (!/^\s*$/.test(t) && /[A-Za-z]/.test(t)) idx.push(i); });
    if (idx.length < 3) return { text: src, blanks: [] };
    const norm = (t) => t.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
    const want = idx.length >= 8 ? 2 : 1;
    let pool = mode === 'function' ? idx.filter((i) => FUNCTION_WORDS.has(norm(tokens[i]))) : [];
    if (pool.length < want) pool = pool.concat(idx.filter((i) => !pool.includes(i)));
    const h = hash(src + '|' + (seed || 0));
    const chosen = [];
    for (let k = 0; k < want && pool.length; k++) {
      const p = (h >>> (k * 7)) % pool.length;
      chosen.push(pool[p]); pool.splice(p, 1);
    }
    const blanks = [];
    chosen.sort((a, b) => a - b).forEach((i) => {
      const t = tokens[i];
      const core = t.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');
      blanks.push(core);
      tokens[i] = t.replace(core, '_'.repeat(Math.max(3, Math.min(8, core.length))));
    });
    return { text: tokens.join(''), blanks };
  }

  // ── 키위·마오리·학교 용어 찾기 ──
  const strip = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let compiled = null, compiledFor = null;
  function compile(dict) {
    if (compiled && compiledFor === dict) return compiled;
    const entries = (dict || []).map((e) => ({ term: e[0], ko: e[1], cat: e[2], note: e[3] || '', key: strip(e[0]) }))
      .sort((a, b) => b.key.length - a.key.length); // 긴 표현(sweet as) 먼저
    compiled = entries.map((e) => Object.assign(e, { re: new RegExp('(^|[^a-z0-9])(' + e.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+') + ')(?![a-z0-9])', 'gi') }));
    compiledFor = dict;
    return compiled;
  }
  function findKiwi(text, dict) {
    const s = strip(text || '');
    if (!s) return [];
    const out = [];
    const taken = [];
    for (const e of compile(dict)) {
      e.re.lastIndex = 0;
      let m;
      while ((m = e.re.exec(s))) {
        const start = m.index + m[1].length, end = start + m[2].length;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        taken.push([start, end]);
        out.push({ term: e.term, ko: e.ko, cat: e.cat, note: e.note, start, end });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  return { soundsLike, clozeLine, findKiwi, FUNCTION_WORDS, RULES };
});
