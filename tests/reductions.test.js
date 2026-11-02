const test = require('node:test');
const assert = require('node:assert/strict');
const Sp = require('../extension/src/lib/speech.js');

const pats = (text, missing) => Sp.reductionMisses(text, missing).map((r) => r.pattern).sort();

test('놓친 단어가 축약 구간이면 그 패턴으로 센다 (gonna · didja · \'em)', () => {
  assert.deepEqual(pats("I'm going to catch them later, did you see?", ['going', 'to', 'them', 'did', 'you']), ["'em", 'didja', 'gonna']);
  assert.deepEqual(Sp.reductionMisses("I'm going to catch them later, did you see?", ['going'])[0], { pattern: 'gonna', src: 'going to' });
});

test('축약 구간 밖의 단어만 놓치면 패턴이 없다', () => {
  assert.deepEqual(pats("I'm going to catch them later, did you see?", ['catch', 'see']), []); // later 는 t 약화(lader) 단어라 뺀다
  assert.deepEqual(pats('No reductions here at school.', ['school']), []);
});

test('t 약화(flap)와 아포스트로피 없는 받아쓰기 표기도 잡는다', () => {
  assert.deepEqual(pats('Get a bottle of water.', ['water', 'bottle']), ['boddle', 'wadder']);
  // 받아쓰기 비교는 아포스트로피를 떼므로(dont) 그대로 들어와도 맞춘다
  assert.deepEqual(pats("I don't know her name.", ['dont', 'know']), ['dunno']);
});

test('같은 패턴이 여러 번 나와도 한 번만, src 는 사람이 읽을 모양', () => {
  const r = Sp.reductionMisses('I want to go and you want to stay.', ['want', 'to']);
  assert.equal(r.filter((x) => x.pattern === 'wanna').length, 1);
  for (const x of Sp.REDUCTIONS.slice(0, 8)) assert.ok(!/[\\()?]/.test(x.src), x.src);
});
