// 디즈니+ 콘텐츠 시계: 영상 요소 시각(ct) + 차이 k. k 는 플레이어가 알려 주는 위치(내림·늦게 옴)와 ct 의 차이 중 가장 큰 값
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.document = globalThis.document || {}; // adapters.js 는 브라우저용 — 불러올 때 document 이름만 있으면 된다
require('../extension/src/content/adapters.js');
const A = globalThis.SubTutorAdapters;
const reset = () => { A.shared.ctMap.samples = []; A.shared.ctMap.k = NaN; A.shared.ctMap.pending = NaN; A.shared.ctMap.resets = 0; };

test('차이 k: 늦게 온 보고(내림값)는 무시하고 위치가 바뀐 순간의 보고로 맞춘다', () => {
  reset();
  // 진짜 k = 0. 0.5초 간격 보고는 늘 454ms 늦은 값, 위치가 바뀐 순간의 보고는 0~30ms 늦은 값
  A.noteContentTime(0, 454, 1000);
  A.noteContentTime(500, 954, 1500);
  assert.equal(A.shared.ctMap.k, -454);
  A.noteContentTime(1000, 1012, 1560);
  A.noteContentTime(1000, 1454, 2000);
  assert.equal(A.shared.ctMap.k, -12);
  assert.ok(A.preciseClock());
});

test('크게 어긋난 보고 하나는 보류하고, 다음 보고도 같은 쪽이면 새로 잰다', () => {
  reset();
  A.noteContentTime(10000, 10010, 0);
  A.noteContentTime(10500, 10505, 500);
  assert.equal(A.shared.ctMap.k, -5);
  // 탐색 직후의 낡은 보고: 위치는 예전 값인데 ct 는 이미 새 위치 → k 가 -20초처럼 보인다
  A.noteContentTime(11000, 31000, 1000);
  assert.equal(A.shared.ctMap.k, -5, '한 번은 보류');
  assert.ok(A.preciseClock());
  A.noteContentTime(11500, 11510, 1500);
  assert.equal(A.shared.ctMap.k, -5, '원래대로 돌아오면 보류한 값은 버린다');
  assert.equal(A.shared.ctMap.resets, 0);
  // 기준이 정말 바뀌었으면(광고 등) 두 번 연달아 같은 쪽 → 새로 잰다
  A.noteContentTime(12000, 42000, 2000);
  A.noteContentTime(12500, 42480, 2500);
  assert.equal(A.shared.ctMap.resets, 1);
  assert.equal(A.shared.ctMap.k, -29980);
  assert.equal(A.preciseClock(), false, '새로 잰 값이 하나뿐이면 아직 쓰지 않는다');
  A.noteContentTime(13000, 42990, 3000);
  assert.ok(A.preciseClock());
  assert.equal(A.shared.ctMap.k, -29980);
});

test('12초보다 오래된 값은 빠진다', () => {
  reset();
  A.noteContentTime(1000, 1000, 0); // k = 0 (오래된 값)
  A.noteContentTime(1500, 1700, 500);
  A.noteContentTime(20000, 20200, 13000);
  assert.equal(A.shared.ctMap.k, -200);
  assert.equal(A.shared.ctMap.samples.length, 1);
});
