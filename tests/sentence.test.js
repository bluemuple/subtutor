// 문장 인식 (문장 단위 저장): sentenceComplete / sentenceEnd
const test = require('node:test');
const assert = require('node:assert');
const Sp = require('../extension/src/lib/speech.js');

test('sentenceComplete: 구두점으로 끝나면 완결', () => {
  assert.equal(Sp.sentenceComplete('This is a technique I use, OK?'), true);
  assert.equal(Sp.sentenceComplete('I like biting when I\'m playing.'), true);
  assert.equal(Sp.sentenceComplete('Stop!'), true);
  assert.equal(Sp.sentenceComplete('Well…'), true);
  assert.equal(Sp.sentenceComplete('and I say, \'Really? Let\'s look at the facts.\''), true); // 닫는 따옴표 뒤
  assert.equal(Sp.sentenceComplete('He said "go home."'), true);
  assert.equal(Sp.sentenceComplete('♪ sweet dreams ♪'), true); // 노래 줄
  assert.equal(Sp.sentenceComplete(''), true); // 빈 자막은 묶지 않는다
});

test('sentenceComplete: 쉼표·구두점 없음이면 미완', () => {
  assert.equal(Sp.sentenceComplete("My dog Raffie bites all the time when he's playing,"), false);
  assert.equal(Sp.sentenceComplete('but my mum says, "You\'re not a dog, Rory,"'), false); // 따옴표 안이 쉼표로 끝남
  assert.equal(Sp.sentenceComplete("The only time I've ever been to the Principal's office"), false);
  assert.equal(Sp.sentenceComplete('I was going to'), false);
});

test('sentenceComplete: 여러 줄이면 마지막 줄 기준', () => {
  assert.equal(Sp.sentenceComplete('- Hi.\n- I was about to'), false);
  assert.equal(Sp.sentenceComplete('- Hi there,\n- OK. Yeah, yeah, yeah.'), true);
});

const cues = [
  { start: 2000, end: 4000, text: 'Hello there, welcome to the test.' },                      // 0 완결
  { start: 6000, end: 8000, text: "My dog Raffie bites all the time when he's playing," },     // 1 미완
  { start: 10000, end: 12000, text: 'but my mum says, "You\'re not a dog, Rory,"' },           // 2 미완
  { start: 14000, end: 16000, text: "and I say, 'Really? Let's look at the facts.'" },         // 3 완결
  { start: 18000, end: 20000, text: "I like biting when I'm playing." },                       // 4 완결
  { start: 26000, end: 28000, text: 'This is a technique I use, OK?' },                        // 5 완결
  { start: 28100, end: 30000, text: '- OK. Yeah, yeah, yeah.' },                               // 6
  { start: 34000, end: 36000, text: 'He said he would' },                                      // 7 미완
  { start: 42000, end: 44000, text: 'come back tomorrow.' },                                   // 8 (6초 떨어짐)
];

test('sentenceEnd: 미완결 사슬은 문장이 끝나는 자막까지', () => {
  assert.equal(Sp.sentenceEnd(cues, 1, 3), 3);  // 1→2→3 에서 완결
  assert.equal(Sp.sentenceEnd(cues, 2, 3), 3);
});

test('sentenceEnd: 완결 자막은 그 자리 — 뒤의 "- OK. Yeah…"를 따라오지 않는다', () => {
  assert.equal(Sp.sentenceEnd(cues, 0, 3), 0);
  assert.equal(Sp.sentenceEnd(cues, 5, 3), 5);
});

test('sentenceEnd: 다음 자막과 3초 넘게 떨어지면 거기서 끊는다 (장면 전환)', () => {
  assert.equal(Sp.sentenceEnd(cues, 7, 3), 7); // 36000 → 42000 (6초)
});

test('sentenceEnd: 최대 maxExtra 개까지만 묶는다', () => {
  const chain = Array.from({ length: 8 }, (_, k) => ({ start: k * 2000, end: k * 2000 + 1500, text: 'and then' }));
  assert.equal(Sp.sentenceEnd(chain, 0, 3), 3);
  assert.equal(Sp.sentenceEnd(chain, 0, 1), 1);
});

test('sentenceEnd: 마지막 자막이 미완이어도 범위를 벗어나지 않는다', () => {
  assert.equal(Sp.sentenceEnd(cues, 8, 3), 8);
  assert.equal(Sp.sentenceEnd([{ start: 0, end: 1000, text: 'I was about to' }], 0, 3), 0);
});

// 한 자막 안 문장 나누기 (저장할 문장 고르기)
test('sentenceSplit: 구두점 기준으로 나누고 화자 하이픈 줄도 문장', () => {
  assert.deepEqual(
    Sp.sentenceSplit('- This is a technique I use, OK?\n- OK. Yeah, yeah, yeah.'),
    ['- This is a technique I use, OK?', '- OK.', 'Yeah, yeah, yeah.']
  );
  assert.deepEqual(Sp.sentenceSplit('Stop! That tickles. Really.'), ['Stop!', 'That tickles.', 'Really.']);
});

test('sentenceSplit: 문장 하나면 그대로 하나', () => {
  assert.deepEqual(Sp.sentenceSplit('Hello there, welcome to the test.'), ['Hello there, welcome to the test.']);
  assert.deepEqual(Sp.sentenceSplit("The only time I've ever been"), ["The only time I've ever been"]);
});

test('sentenceSplit: 큰따옴표 인용은 한 덩어리로 (홀수면 다음 조각과 합침)', () => {
  assert.deepEqual(
    Sp.sentenceSplit('He said, "Stop! Now." and smiled.'),
    ['He said, "Stop! Now."', 'and smiled.']
  );
});

test('sentenceSplit: 빈 자막은 빈 배열', () => {
  assert.deepEqual(Sp.sentenceSplit(''), []);
});
