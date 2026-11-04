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

  // ── 문장 인식 (문장 단위 저장) ──
  // 한 문장이 자막 2~3개에 걸치면, 첫 자막만 저장했을 때 퀴즈·복습에서 뒷부분이 없다.
  // 저장할 때 자막이 온전한 문장으로 끝났는지 보고, 아니면 문장이 끝나는 자막까지 묶는다.
  const SENT_END = /[.!?…]+[”’"')»›\]]*$/; // 끝 구두점(닫는 따옴표·괄호 허용)
  function sentenceComplete(text) {
    const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    if (!last) return true;                      // 빈 자막은 묶지 않는다
    if (TITLE_ABBR.test(last) || INITIAL.test(last)) return false;   // "… looking at Ms." 처럼 호칭·이니셜로 끝나면 이름이 다음 자막에
    if (SENT_END.test(last)) return true;
    if (/[♪♫]\s*$/.test(last)) return true;   // ♪ 노래 줄
    return false;                                 // 쉼표·구두점 없음 등 — 다음 자막으로 이어진다
  }
  // 마침표(.)가 문장 끝이 아닌 경우 — 여기서 자르지 않고 다음 조각과 잇는다
  //  · 호칭·직함(항상 이름이 따라온다): Mr. Mrs. Ms. Dr. Prof. St. Jr. Det. Capt. Sgt. … · vs.
  //  · 이니셜: 대문자 한 글자 + 점 (J. Smith) — 단 대명사 I 는 제외
  //  · 애매한 약어(문장 끝일 수도 있다): etc. a.m. p.m. e.g. i.e. U.S. Inc. … → 다음 조각이 소문자·숫자로 시작할 때만 잇는다
  //  · 숫자 소수점(3.14, $9.99)은 애초에 자르지 않는다 (점 뒤가 공백이 아니므로)
  const TITLE_ABBR = /(^|[\s(\["'\u201c\u2018-])(mr|mrs|ms|mx|dr|prof|st|sr|jr|mt|rev|hon|fr|gen|col|capt|cpt|sgt|lt|maj|cpl|pvt|adm|cmdr|det|insp|supt|gov|pres|sen|vs)\.$/i;
  const SOFT_ABBR = /(^|[\s(\["'\u201c\u2018-])(etc|approx|inc|ltd|co|corp|dept|est|al|cf)\.$/i;
  const LETTER_DOTS = /(^|[\s(\[])(?:[A-Za-z]\.){2,}$/;          // a.m. p.m. e.g. i.e. U.S. U.K. N.Z.
  const INITIAL = /(^|[\s(\["'\u201c\u2018-])(?!I\.)[A-Z]\.$/;   // J. — 대명사 I 는 문장 끝일 수 있어 제외
  // 이 조각 뒤에서 문장이 끝나지 않았다고 볼 것인가 (next: 다음 조각)
  function continuesAfter(piece, next) {
    const w = String(piece || '').trim();
    if (TITLE_ABBR.test(w) || INITIAL.test(w)) return true;
    if (SOFT_ABBR.test(w) || LETTER_DOTS.test(w)) return next != null && /^[\s"'\u201c\u2018(]*[a-z0-9]/.test(next);
    return false;
  }
  // 한 자막 안에서 문장 나누기: 끝 구두점(닫는 따옴표·괄호 허용) 뒤에 공백·끝이 오는 자리에서만 자른다.
  // 자른 자리 사이를 그대로 잘라 내므로 글자를 잃지 않는다 (예전 정규식은 "3.14" 같은 소수점이 있으면 앞부분을 잃었다).
  // 큰따옴표가 홀수로 남으면 인용이 끊긴 것이므로 다음 조각과 합친다 ("Really? Let's go." 는 한 덩어리).
  function sentenceSplit(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    const raw = [];
    const re = /[.!?\u2026]+[\u201d\u2019"')\u00bb\u203a\]]*(?=\s|$)/g;
    let last = 0, m;
    while ((m = re.exec(t))) {
      const endAt = m.index + m[0].length;
      raw.push(t.slice(last, endAt).trim());
      last = endAt;
    }
    if (last < t.length) raw.push(t.slice(last).trim());
    const openQuote = (x) => {
      const dq = (x.match(/"/g) || []).length % 2 === 1;
      const curly = ((x.match(/\u201c/g) || []).length !== (x.match(/\u201d/g) || []).length);
      return dq || curly;
    };
    const out = [];
    for (const p of raw) {
      if (!p) continue;
      const prev = out[out.length - 1];
      if (prev != null && (openQuote(prev) || continuesAfter(prev, p))) out[out.length - 1] = prev + ' ' + p;
      else out.push(p);
    }
    return out;
  }

  // i 번째 자막에서 시작한 문장이 끝나는 자막 번호. 최대 maxExtra 개까지 더 보고,
  // 다음 자막과 3초 넘게 떨어져 있으면(장면 전환) 거기서 끊는다.
  function sentenceEnd(cues, i, maxExtra) {
    const max = Number.isFinite(maxExtra) ? maxExtra : 3;
    let j = i;
    while (j < cues.length - 1 && j - i < max && !sentenceComplete(cues[j].text)) {
      if (cues[j + 1].start - cues[j].end > 3000) break;
      j++;
    }
    return j;
  }

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

  // ── 받아쓰기의 축약·약형 분류 ──
  // 소리 나는 대로 규칙(RULES)과 t 약화(FLAP)가 일어나는 구간 = 실제 말에서 모양이 바뀌는 곳.
  // 받아쓰기에서 놓친 단어가 그 구간에 들어 있으면 그 패턴(gonna, didja, 'em …)을 놓친 것으로 센다 (Wong et al. 2017: 축약형 지각은 어휘량과 별개의 듣기 예측 변수)
  const REDUCTIONS = RULES.concat(FLAP).map(([re, to]) => ({ to, src: re.source.replace(/\(\?!.*$/, '').replace(/\\b/g, '').toLowerCase(), re: new RegExp(re.source, 'gi') }));
  const normWord = (w) => String(w || '').toLowerCase().replace(/[’‘]/g, "'").replace(/'/g, '');
  function reductionMisses(text, missingWords) {
    const t = String(text || '').replace(/\n/g, ' ');
    const miss = new Set((missingWords || []).map(normWord).filter(Boolean));
    if (!miss.size) return [];
    const out = [];
    for (const r of REDUCTIONS) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(t))) {
        const words = m[0].toLowerCase().split(/[^a-z'’]+/).map(normWord).filter(Boolean);
        if (words.some((w) => miss.has(w))) {
          out.push({ pattern: r.to, src: r.src });
          words.forEach((w) => miss.delete(w)); // 긴 패턴(going to → gonna)이 먼저 가져가면 짧은 패턴(going → goin')은 세지 않는다
          break;
        }
      }
      if (!miss.size) break;
    }
    return out;
  }

  // 주석 겹침: 먼저 온 목록(키위 용어)이 이기고, 겹치지 않는 두 번째 목록(NZ 모음)만 남긴다. 위치순
  function mergeAnnotations(primary, secondary) {
    const out = (primary || []).slice();
    for (const h of secondary || []) if (!out.some((p) => h.start < p.end && h.end > p.start)) out.push(h);
    return out.sort((a, b) => a.start - b.start);
  }

  return { soundsLike, clozeLine, findKiwi, mergeAnnotations, reductionMisses, sentenceComplete, sentenceEnd, sentenceSplit, REDUCTIONS, FUNCTION_WORDS, RULES };
});
