// 디즈니+ 콘텐츠 시계: 영상 요소 시각(ct) + 차이 k. 실제 디즈니+ 는 탐색할 때마다 ct 를 20초에서 다시 시작하므로(진단 기록 2026-10-31)
// k 는 탐색 사이에서만 일정하다 → 탐색마다 버리고, 위치 값이 바뀐 순간의 보고 두 개가 맞으면 다시 쓴다
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.document = globalThis.document || {}; // adapters.js 는 브라우저용 — 불러올 때 document 이름만 있으면 된다
require('../extension/src/content/adapters.js');
const A = globalThis.SubTutorAdapters;
const M = () => A.shared.ctMap;
const fresh = () => { A.resetContentTime(); M().resets = 0; M().gen = 0; };

test('보고 하나로는 믿지 않고, 두 보고가 0.15초 안으로 맞아야 쓴다', () => {
  fresh();
  assert.equal(A.noteContentTime(79304, 20014, 1000), 'cand');
  assert.equal(A.preciseClock(), false);
  assert.equal(A.noteContentTime(79526, 20245, 1230), 'new');
  assert.ok(A.preciseClock());
  assert.equal(M().k, 79304 - 20014);
  assert.equal(M().gen, 1);
});

test('탐색 직후의 낡은 보고(옮기기 전 위치)는 다음 보고와 맞지 않아 버려진다', () => {
  fresh();
  assert.equal(A.noteContentTime(83635, 20012, 1000), 'cand'); // 옮기기 전 위치
  assert.equal(A.noteContentTime(79304, 20014, 1002), 'cand'); // 맞지 않음 → 이것이 새 후보
  assert.equal(A.noteContentTime(79526, 20245, 1230), 'new');
  assert.equal(M().k, 59290);
});

test('탐색하면 차이를 버린다 (영상 시각이 20초에서 다시 시작하므로 예전 차이는 10초씩 틀린다)', () => {
  fresh();
  A.noteContentTime(79850, 20000, 0);
  A.noteContentTime(80115, 20265, 265);
  assert.equal(M().k, 59850);
  A.resetContentTime();
  assert.equal(A.preciseClock(), false);
  A.noteContentTime(90475, 20010, 1000);
  A.noteContentTime(90686, 20237, 1230);
  assert.equal(M().k, 70465);
});

test('같은 무리 안에서는 가장 큰 차이(가장 덜 늦은 보고)를 쓰고, 크게 벗어난 값 하나는 무시한다', () => {
  fresh();
  A.noteContentTime(10000, 10030, 0); // k -30
  A.noteContentTime(10265, 10275, 265); // k -10
  assert.equal(M().k, -10);
  assert.equal(A.noteContentTime(10500, 10760, 530), 'add'); // 0.26초 늦은 보고 (계단 하나) — 무리 안
  assert.equal(M().k, -10);
  assert.equal(A.noteContentTime(14000, 11000, 760), 'cand'); // 3초 어긋난 값 하나
  assert.ok(A.preciseClock());
  assert.equal(A.noteContentTime(11060, 11070, 1060), 'add'); // 다시 정상 → 후보는 버린다
  assert.equal(M().cand, null);
  assert.equal(M().resets, 0);
});

test('기준이 정말 바뀌었으면(두 번 연달아 같은 쪽) 새로 잡고, 더빙이 위치를 다시 맞추도록 세대를 올린다', () => {
  fresh();
  A.noteContentTime(1000, 1000, 0);
  A.noteContentTime(1265, 1265, 265);
  const g = M().gen;
  A.noteContentTime(9000, 1500, 500);
  A.noteContentTime(9265, 1765, 765);
  assert.equal(M().k, 7500);
  assert.equal(M().resets, 1);
  assert.equal(M().gen, g + 1);
});

test('앞서 나간 값(탐색 직후 목표 위치를 알려 준 보고 같은 것)은 최근 값들이 모두 그보다 작아지면 버린다', () => {
  fresh();
  A.noteContentTime(14100, 20000, 0); // 목표 위치 보고 — 실제로는 13.8초에서 시작
  A.noteContentTime(14100, 20020, 20);
  assert.equal(M().k, -5900);
  const g = M().gen;
  // 실제 위치 보고: k = -6200 (0.3초 작다, 무리 안)
  for (let i = 1; i <= 4; i++) A.noteContentTime(13800 + i * 265, 20000 + i * 265, 300 + i * 265);
  assert.equal(M().k, -6200);
  assert.ok(M().gen > g, '시계가 0.1초 넘게 움직였으므로 더빙이 위치를 다시 맞춘다');
});

test('3초보다 오래된 값은 빠진다 (적어도 두 개는 남긴다)', () => {
  fresh();
  A.noteContentTime(1000, 1000, 0);
  A.noteContentTime(1265, 1265, 265);
  A.noteContentTime(5000, 5100, 4000);
  assert.equal(M().samples.length, 2);
  A.noteContentTime(5265, 5365, 4265);
  A.noteContentTime(5530, 5630, 4530);
  assert.ok(M().samples.every(([at]) => at >= 4000 - 1));
  assert.equal(M().k, -100);
});
