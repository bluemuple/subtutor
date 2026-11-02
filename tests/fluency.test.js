// 입트기 도우미: parsePromptLines / overUnder / wpm / fmtClock
const test = require('node:test');
const assert = require('node:assert');
const F = require('../extension/src/lib/fluency.js');

test('parsePromptLines: 여러 줄 → 1줄 1프롬프트, 번호·글머리표 제거', () => {
  const text = '1. Tell me about yourself.\n- How are you settling in?\n•  Bring a plate on Friday.\n(3) What makes a good teacher?\n2) Pop into my office.';
  assert.deepEqual(F.parsePromptLines(text), [
    'Tell me about yourself.',
    'How are you settling in?',
    'Bring a plate on Friday.',
    'What makes a good teacher?',
    'Pop into my office.',
  ]);
});

test('parsePromptLines: 빈 줄·공백 줄·중복(대소문자 무시)은 버린다', () => {
  assert.deepEqual(F.parsePromptLines('Hello there.\n\n   \nhello THERE.\nKia ora.'), ['Hello there.', 'Kia ora.']);
  assert.deepEqual(F.parsePromptLines(''), []);
  assert.deepEqual(F.parsePromptLines(null), []);
});

test('parsePromptLines: 한 줄만 붙여도 1개', () => {
  assert.deepEqual(F.parsePromptLines('  Flat out this week?  '), ['Flat out this week?']);
});

test('parsePromptLines: 번호가 아닌 숫자 시작 문장은 그대로 둔다', () => {
  assert.deepEqual(F.parsePromptLines('3 things I love about NZ'), ['3 things I love about NZ']);
});

test('overUnder: 초과·부족·딱 맞춤', () => {
  assert.deepEqual(F.overUnder(75, 82), { diff: 7, text: '7초 초과' });
  assert.deepEqual(F.overUnder(60, 44.6), { diff: -15, text: '15초 부족' });
  assert.deepEqual(F.overUnder(45, 45.4), { diff: 0, text: '딱 맞춤' });
});

test('wpm: 단어 수 / 분 — 1초 미만·빈 문장은 null', () => {
  assert.equal(F.wpm('one two three four five six seven eight nine ten', 60000), 10);
  assert.equal(F.wpm('one two three', 30000), 6);
  assert.equal(F.wpm('', 60000), null);
  assert.equal(F.wpm('hi', 500), null);
});

test('fmtClock: 초 → m:ss', () => {
  assert.equal(F.fmtClock(75), '1:15');
  assert.equal(F.fmtClock(5), '0:05');
  assert.equal(F.fmtClock(0), '0:00');
  assert.equal(F.fmtClock(-3), '0:00');
});
