/*
 * SubTutor – 뉴질랜드 영어(NZE) 모음 변이 주석 (확장 프로그램 · 웹사이트 공용)
 * 아는 단어인데도 NZ 발음 때문에 못 알아듣는 경우가 많은 고빈도 단어를 변이 유형별로 모았다.
 * 근거: Bauer, Warren, Bardsley, Kennedy & Major (2007) New Zealand English (JIPA 37(1)) —
 *   KIT 는 중설화되어 [ɘ] 쪽(“fish and chips” → ‘fush and chups’), DRESS 는 올라가 [e̝]~[i] 쪽(pen → ‘pin’),
 *   TRAP 은 올라가 [ɛ] 쪽(bat → ‘bet’), NEAR 와 SQUARE 는 [iə] 로 합쳐지고(ear = air, beer = bear),
 *   음절 끝 /l/ 은 모음처럼 된다(milk → ‘miwk’, school → ‘schoow’).
 *   Hay, Nolan & Drager (2006): 청자의 모음 지각은 그 방언에 대한 노출(기대)로 다시 맞춰진다.
 * 항목: [단어, 유형, 들리는 모양(힌트), 헷갈리는 짝 단어(미니 퀴즈용, 없으면 '')]
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorNZVowels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TYPES = {
    KIT: { label: 'KIT 모음 (i → 어 쪽)', short: 'KIT', why: 'NZ 영어의 i(KIT) 는 혀가 가운데로 가서 ‘어’에 가깝게 들립니다 (fish → fush).' },
    DRESS: { label: 'DRESS 모음 (e → 이 쪽)', short: 'DRESS', why: 'NZ 영어의 e(DRESS) 는 올라가서 ‘이’에 가깝게 들립니다 (pen → pin).' },
    TRAP: { label: 'TRAP 모음 (æ → 에 쪽)', short: 'TRAP', why: 'NZ 영어의 æ(TRAP) 는 올라가서 ‘에’에 가깝게 들립니다 (bat → bet).' },
    NEAR_SQUARE: { label: 'NEAR = SQUARE (이어 = 에어)', short: 'NEAR=SQUARE', why: 'NZ 영어는 ear 와 air, beer 와 bear 를 거의 같게 ‘이어’로 발음합니다.' },
    L_VOCAL: { label: '끝 l 의 모음화 (l → 우)', short: 'l 모음화', why: 'NZ 영어는 음절 끝 l 을 혀를 대지 않고 ‘우·오’처럼 냅니다 (milk → miwk).' },
  };
  const W = [
    // KIT: i 가 ‘어’ 쪽으로 (짝: 영어권 다른 억양의 ‘어(STRUT)’ 단어)
    ['fish', 'KIT', 'fush', ''], ['chips', 'KIT', 'chups', ''], ['six', 'KIT', 'sux', 'sucks'], ['sixty', 'KIT', 'suxty', ''],
    ['this', 'KIT', 'thus', 'thus'], ['big', 'KIT', 'bug', 'bug'], ['dinner', 'KIT', 'dunner', ''], ['kids', 'KIT', 'kuds', ''],
    ['kid', 'KIT', 'kud', ''], ['sit', 'KIT', 'sut', ''], ['think', 'KIT', 'thunk', 'thunk'], ['thing', 'KIT', 'thung', ''],
    ['bit', 'KIT', 'but', 'but'], ['give', 'KIT', 'guv', ''], ['him', 'KIT', 'hum', 'hum'], ['finish', 'KIT', 'funush', ''],
    ['minute', 'KIT', 'munnut', ''], ['quick', 'KIT', 'quuck', ''], ['picture', 'KIT', 'pucture', ''], ['sister', 'KIT', 'suster', ''],
    ['window', 'KIT', 'wundow', ''], ['ticket', 'KIT', 'tucket', ''], ['visit', 'KIT', 'vusut', ''], ['city', 'KIT', 'cuddy', ''],
    ['hit', 'KIT', 'hut', 'hut'], ['dig', 'KIT', 'dug', 'dug'], ['lick', 'KIT', 'luck', 'luck'], ['bin', 'KIT', 'bun', 'bun'],
    // DRESS: e 가 ‘이’ 쪽으로 (짝: KIT 단어)
    ['pen', 'DRESS', 'pin', 'pin'], ['ten', 'DRESS', 'tin', 'tin'], ['yes', 'DRESS', 'yis', ''], ['bed', 'DRESS', 'bid', 'bid'],
    ['red', 'DRESS', 'rid', 'rid'], ['said', 'DRESS', 'sid', ''], ['head', 'DRESS', 'hid', 'hid'], ['egg', 'DRESS', 'igg', ''],
    ['dead', 'DRESS', 'did', 'did'], ['left', 'DRESS', 'lift', 'lift'], ['set', 'DRESS', 'sit', 'sit'], ['met', 'DRESS', 'mitt', 'mitt'],
    ['check', 'DRESS', 'chick', 'chick'], ['desk', 'DRESS', 'disk', 'disk'], ['best', 'DRESS', 'bist', ''], ['never', 'DRESS', 'niver', ''],
    ['very', 'DRESS', 'viry', ''], ['seven', 'DRESS', 'siven', ''], ['get', 'DRESS', 'git', 'git'], ['let', 'DRESS', 'lit', 'lit'],
    ['friend', 'DRESS', 'frind', ''], ['pet', 'DRESS', 'pit', 'pit'], ['bet', 'DRESS', 'bit', 'bit'], ['peck', 'DRESS', 'pick', 'pick'],
    ['tell', 'DRESS', 'till', 'till'], ['send', 'DRESS', 'sind', ''], ['end', 'DRESS', 'ind', ''], ['address', 'DRESS', 'addriss', ''],
    // TRAP: æ 가 ‘에’ 쪽으로 (짝: DRESS 단어)
    ['bat', 'TRAP', 'bet', 'bet'], ['hat', 'TRAP', 'het', ''], ['back', 'TRAP', 'beck', ''], ['bad', 'TRAP', 'bed', 'bed'],
    ['man', 'TRAP', 'men', 'men'], ['cat', 'TRAP', 'ket', ''], ['black', 'TRAP', 'bleck', ''], ['happy', 'TRAP', 'heppy', ''],
    ['family', 'TRAP', 'femily', ''], ['sad', 'TRAP', 'sed', 'said'], ['bag', 'TRAP', 'beg', 'beg'], ['mad', 'TRAP', 'med', ''],
    ['hand', 'TRAP', 'hend', ''], ['apple', 'TRAP', 'epple', ''], ['pan', 'TRAP', 'pen', 'pen'], ['sat', 'TRAP', 'set', 'set'],
    ['mat', 'TRAP', 'met', 'met'], ['tan', 'TRAP', 'ten', 'ten'], ['catch', 'TRAP', 'ketch', ''],
    ['match', 'TRAP', 'metch', ''], ['camp', 'TRAP', 'kemp', ''], ['track', 'TRAP', 'treck', 'trek'], ['January', 'TRAP', 'Jenuary', ''],
    ['Saturday', 'TRAP', 'Seturday', ''], ['cattle', 'TRAP', 'kettle', 'kettle'],
    // NEAR = SQUARE: 둘 다 ‘이어’ (짝: 합쳐지는 상대)
    ['ear', 'NEAR_SQUARE', 'air 와 같게', 'air'], ['air', 'NEAR_SQUARE', 'ear 와 같게', 'ear'], ['beer', 'NEAR_SQUARE', 'bear 와 같게', 'bear'], ['bear', 'NEAR_SQUARE', 'beer 와 같게', 'beer'],
    ['here', 'NEAR_SQUARE', 'hair 와 같게', 'hair'], ['hair', 'NEAR_SQUARE', 'here 와 같게', 'here'], ['cheers', 'NEAR_SQUARE', 'chairs 와 같게', 'chairs'], ['chairs', 'NEAR_SQUARE', 'cheers 와 같게', 'cheers'],
    ['chair', 'NEAR_SQUARE', 'cheer 와 같게', 'cheer'], ['cheer', 'NEAR_SQUARE', 'chair 와 같게', 'chair'], ['fear', 'NEAR_SQUARE', 'fair 와 같게', 'fair'], ['fair', 'NEAR_SQUARE', 'fear 와 같게', 'fear'],
    ['dear', 'NEAR_SQUARE', 'dare 와 같게', 'dare'], ['dare', 'NEAR_SQUARE', 'dear 와 같게', 'dear'], ['really', 'NEAR_SQUARE', 'rarely 와 비슷하게', 'rarely'], ['rarely', 'NEAR_SQUARE', 'really 와 비슷하게', 'really'],
    ['care', 'NEAR_SQUARE', '‘keer’', ''], ['share', 'NEAR_SQUARE', 'sheer 와 같게', 'sheer'],
    ['wear', 'NEAR_SQUARE', 'we\'re 와 같게', ''], ['pair', 'NEAR_SQUARE', 'peer 와 같게', 'peer'], ['stairs', 'NEAR_SQUARE', 'steers 와 같게', 'steers'], ['year', 'NEAR_SQUARE', '‘yeer’ (= yair)', ''],
    ['clear', 'NEAR_SQUARE', 'Claire 와 같게', 'Claire'], ['near', 'NEAR_SQUARE', '‘neer’ (= nair)', ''], ['idea', 'NEAR_SQUARE', '‘idee-a’', ''],
    // 끝 l 의 모음화 (짝 없음)
    ['milk', 'L_VOCAL', 'miwk', ''], ['school', 'L_VOCAL', 'schoow', ''], ['well', 'L_VOCAL', 'weww', ''], ['feel', 'L_VOCAL', 'feeuw', ''],
    ['help', 'L_VOCAL', 'heup', ''], ['old', 'L_VOCAL', 'owd', ''], ['always', 'L_VOCAL', 'awways', ''], ['people', 'L_VOCAL', 'peepo', ''],
    ['little', 'L_VOCAL', 'liddo', ''], ['film', 'L_VOCAL', 'fiwm', ''], ['table', 'L_VOCAL', 'taybo', ''], ['cool', 'L_VOCAL', 'coow', ''],
    ['pool', 'L_VOCAL', 'poow', ''], ['ball', 'L_VOCAL', 'baw', ''], ['still', 'L_VOCAL', 'stiw', ''], ['fall', 'L_VOCAL', 'faw', ''],
    ['Wellington', 'L_VOCAL', 'Weowington', ''], ['child', 'L_VOCAL', 'chiwd', ''], ['build', 'L_VOCAL', 'biwd', ''], ['self', 'L_VOCAL', 'seuf', ''],
    ['bottle', 'L_VOCAL', 'boddo', ''], ['pencil', 'L_VOCAL', 'pinsow', ''],
  ];
  const BY_WORD = new Map();
  for (const [word, type, sounds, pair] of W) if (!BY_WORD.has(word.toLowerCase())) BY_WORD.set(word.toLowerCase(), { word, type, sounds, pair });
  // 흔한 굴절: 복수·3인칭 -s, -es (fishes 는 드물어 제외) — 기본형으로 찾는다
  function lookup(token) {
    const t = String(token || '').toLowerCase().replace(/[’‘]/g, "'");
    if (BY_WORD.has(t)) return BY_WORD.get(t);
    if (t.length > 3 && t.endsWith('s') && BY_WORD.has(t.slice(0, -1))) return BY_WORD.get(t.slice(0, -1));
    return null;
  }
  // 소리 나는 모양 힌트 한 줄
  function hint(e) {
    if (!e) return '';
    if (e.type === 'NEAR_SQUARE') return 'NZ 발음: ' + e.sounds + ' 들림';
    return 'NZ 발음: ‘' + e.sounds + '’처럼 들림';
  }
  /** 문장에서 모음 주석이 붙을 단어 위치 [{ start, end, word, type, sounds, pair, hint }] (원문 문자 위치). 한 줄에 너무 많으면 읽기 어려우므로 max 개까지 */
  function find(text, max) {
    const s = String(text || '');
    const out = [];
    const re = /[A-Za-z][A-Za-z'’]*/g;
    let m;
    while ((m = re.exec(s))) {
      const raw = m[0].replace(/['’]s$/i, '');
      const e = lookup(raw);
      if (!e) continue;
      out.push({ start: m.index, end: m.index + raw.length, word: e.word, type: e.type, sounds: e.sounds, pair: e.pair, hint: hint(e), typeLabel: TYPES[e.type].label });
      if (out.length >= (max || 3)) break;
    }
    return out;
  }
  return { TYPES, WORDS: W, lookup, find, hint };
});
