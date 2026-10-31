// 어휘 라이브러리: 축약형 순위 · 단어 목록(중복·이름 제외) · 난이도 정렬
const test = require('node:test');
const assert = require('node:assert');
const V = require('../extension/src/lib/vocab.js');
require('../extension/src/data/freq-en.js');
const F = globalThis.SubTutorFreq;

const LINES = ['Hello there, welcome to the test.', "My dog Raffie bites all the time when he's playing,", 'but my mum says, "You\'re not a dog, Rory,"', "and I say, 'Really? Let's look at the facts.'", "I like biting when I'm playing.", 'I can catch a frisbee in my mouth.', 'And I like eating with no hands.', "I don't think she's paying attention.", "The only time I've ever been to the Principal's office", "is to collect a Principal's Award."];

test('축약형은 앞부분의 순위를 쓴다 (짧아도)', () => {
  assert.strictEqual(V.rankOf("i'm", F), V.rankOf('i', F));
  assert.strictEqual(V.rankOf("we're", F), V.rankOf('we', F));
  assert.strictEqual(V.rankOf("he's", F), V.rankOf('he', F));
  assert.ok(V.rankOf("don't", F) > 0 && V.rankOf("don't", F) < 100);
});

test('단어 목록: 한 번씩, 횟수·처음 나온 자막, 이름은 뺀다', () => {
  const list = V.wordList(LINES.map((text) => ({ text })), F);
  const by = new Map(list.map((e) => [e.word, e]));
  assert.strictEqual(list.length, by.size, '중복 없음');
  assert.ok(!by.has('raffie') && !by.has('rory'), '이름(문장 중간 대문자)은 뺀다');
  for (const w of ["you're", 'really', "let's", "i've", "i'm", 'frisbee', 'the', 'i']) assert.ok(by.has(w), w + ' 있음');
  assert.strictEqual(by.get('playing').n, 2);
  assert.strictEqual(by.get('frisbee').cue, 5);
  assert.ok(by.get('frisbee').rank > 10000);
});

test('단어 목록: 화자 표시·[효과음]·숫자는 단어가 아니다, 문장 첫머리에만 나오는 낯선 대문자 단어는 이름', () => {
  const list = V.wordList([{ text: 'SOFIA: [laughs] Plaud is 3 times better.' }, { text: 'Hey Sofia, the magician is here.' }], F).map((e) => e.word);
  assert.ok(!list.includes('sofia') && !list.includes('laughs') && !list.includes('plaud') && !list.includes('3'), list.join(','));
  assert.ok(list.includes('magician') && list.includes('times'), list.join(','));
});

test('정렬: 어려운 단어부터 · 쉬운 단어부터 · 아주 쉬운 단어 빼고', () => {
  const list = V.wordList(LINES.map((text) => ({ text })), F);
  const hard = V.sortWords(list, 'hard').map((e) => e.word);
  const easy = V.sortWords(list, 'easy').map((e) => e.word);
  const nb = V.sortWords(list, 'easyNoBasic').map((e) => e.word);
  assert.ok(hard.indexOf('frisbee') < hard.indexOf('dog') && hard.indexOf('dog') < hard.indexOf('the'), hard.join(','));
  assert.ok(V.rankOf(easy[0], F) <= 2 && easy.indexOf('the') < easy.indexOf('frisbee'), easy.slice(0, 5).join(','));
  assert.ok(!nb.includes('the') && !nb.includes('i') && !nb.includes('my') && nb.includes('frisbee') && nb.includes('attention'), nb.join(','));
  assert.ok(nb.every((w, k) => !k || (V.rankOf(nb[k - 1], F) || 1e9) <= (V.rankOf(w, F) || 1e9)), '흔한 순서');
});
