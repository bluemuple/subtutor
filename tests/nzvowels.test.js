const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../extension/src/data/nzVowels.js');
const Sp = require('../extension/src/lib/speech.js');

test('NZ 모음: 단어를 찾고 유형·들리는 모양·짝을 준다', () => {
  const hits = V.find('Have you got a pen? Yes, check the desk.');
  assert.deepEqual(hits.map((h) => [h.word, h.type, h.sounds]), [['pen', 'DRESS', 'pin'], ['yes', 'DRESS', 'yis'], ['check', 'DRESS', 'chick']]);
  assert.equal(hits[0].pair, 'pin');
  assert.ok(/NZ 발음/.test(hits[0].hint) && /pin/.test(hits[0].hint), hits[0].hint);
  assert.ok(/DRESS/.test(hits[0].typeLabel));
});

test('NZ 모음: 한 줄에 최대 3개(기본), max 로 조절', () => {
  const line = 'Fish and chips with milk in the big city near school.';
  assert.equal(V.find(line).length, 3);
  assert.equal(V.find(line, 5).length, 5);
});

test('NZ 모음: 복수·3인칭 -s 와 소유격은 기본형으로, 대소문자 무시', () => {
  assert.equal(V.find('Kids love chips.', 5).length, 2);
  assert.equal(V.find("The kid's hat")[1].word, 'hat');
  assert.equal(V.find('FISH!')[0].word, 'fish');
});

test('NZ 모음: 다섯 유형이 모두 있고, NEAR=SQUARE 는 짝이 서로를 가리킨다', () => {
  const types = new Set(V.WORDS.map((w) => w[1]));
  for (const t of ['KIT', 'DRESS', 'TRAP', 'NEAR_SQUARE', 'L_VOCAL']) assert.ok(types.has(t), t);
  assert.ok(V.WORDS.length >= 100, 'enough words: ' + V.WORDS.length);
  const ear = V.lookup('ear'), air = V.lookup('air');
  assert.equal(ear.pair, 'air');
  assert.equal(air.pair, 'ear');
  // 모든 유형 이름이 TYPES 에 있다
  for (const [w, t] of V.WORDS) assert.ok(V.TYPES[t], w + ' type ' + t);
});

test('주석 겹침: 키위 용어가 이기고, 겹치지 않는 NZ 모음만 남는다', () => {
  const text = 'Mat time is sweet as, bring your pen.';
  const kiwi = [{ start: 0, end: 8, term: 'mat time', ko: '바닥에 모여 앉는 시간' }, { start: 12, end: 20, term: 'sweet as', ko: '아주 좋아' }];
  const nz = V.find(text, 5); // mat(TRAP) · pen(DRESS)
  assert.ok(nz.some((h) => h.word === 'mat') && nz.some((h) => h.word === 'pen'), JSON.stringify(nz));
  const merged = Sp.mergeAnnotations(kiwi, nz);
  assert.ok(!merged.some((h) => h.word === 'mat'), 'mat 은 키위 용어(mat time)에 덮인다');
  assert.ok(merged.some((h) => h.word === 'pen'), 'pen 은 남는다');
  assert.deepEqual(merged.map((h) => h.start), merged.map((h) => h.start).slice().sort((a, b) => a - b), '위치순');
});
