// 자동 녹음 캡슐: 서비스·작품 고르기 판단과 최근 본 작품 목록 (lib/sites.js)
const test = require('node:test');
const assert = require('node:assert');
const S = require('../extension/src/lib/sites.js');

test('서비스 캡슐: 전용 4곳 + 범용 사이트 전부, 이름은 화면에 보이는 그대로', () => {
  const keys = S.SERVICES.map((x) => x.key);
  assert.deepEqual(keys.slice(0, 4), ['netflix', 'youtube', 'prime', 'disney']);
  for (const k of ['tvnz', 'threenow', 'nzonscreen', 'maoriplus', 'ted', 'vimeo']) assert.ok(keys.includes(k), k);
  assert.equal(S.serviceLabel('netflix'), '넷플릭스');
  assert.equal(S.serviceLabel('tvnz'), 'TVNZ+');
  assert.equal(S.serviceLabel('site:www.example.org'), 'example.org');
});

test('workWords/workMatches: 대소문자·악센트·문장 부호 무시, 낱말 단위 앞부분 일치', () => {
  assert.deepEqual(S.workWords('MĀORI+ News: Te Karere'), ['maori', 'news', 'te', 'karere']);
  assert.deepEqual(S.workWords('하트스토퍼 시즌 2'), ['하트스토퍼', '시즌', '2']);   // 한글은 낱자로 쪼개지지 않는다
  assert.ok(S.workMatches('Heartbreak High', 'heartbreak high'));
  assert.ok(S.workMatches('Shortland Street', 'Shortland Street - Episode 7934'));
  assert.ok(!S.workMatches('Heart', 'Heartbreak High'), '글자 단위 앞부분은 다른 작품');
  assert.ok(!S.workMatches('Shortland Street Extra', 'Shortland Street'), '고른 이름이 더 길면 다른 작품');
  assert.ok(!S.workMatches('', 'Anything'));
  assert.ok(!S.workMatches('?!', 'Anything'));
});

test('recAutoWhy: 서비스를 고르면 그 서비스 전부, 작품만 고르면 그 서비스의 그 작품만', () => {
  const titles = [{ site: 'netflix', title: 'Heartbreak High', on: true }, { site: 'netflix', title: 'Sex Education', on: false }];
  const st = { recAutoSites: ['tvnz'], recTitles: titles };
  assert.equal(S.recAutoWhy(st, 'tvnz', 'Shortland Street'), 'site');
  assert.equal(S.recAutoWhy(st, 'tvnz', ''), 'site', '서비스는 제목을 몰라도 된다');
  assert.equal(S.recAutoWhy(st, 'netflix', 'Heartbreak High'), 'title');
  assert.equal(S.recAutoWhy(st, 'netflix', 'Sex Education'), '', '끈 작품은 안 담는다');
  assert.equal(S.recAutoWhy(st, 'netflix', ''), '', '제목을 모르면 작품 캡슐로는 못 정한다');
  assert.equal(S.recAutoWhy(st, 'prime', 'Heartbreak High'), '', '같은 이름이라도 다른 서비스면 다른 작품');
  assert.equal(S.recAutoWhy({}, 'netflix', 'X'), '');
});

test('recAutoWhy: 예전 스위치(recAuto)를 켜 둔 채면 모든 서비스, 캡슐을 한 번 쓰면 캡슐이 이긴다', () => {
  assert.equal(S.recAutoWhy({ recAuto: true, recAutoSites: null }, 'vimeo', ''), 'site');
  assert.equal(S.recAutoWhy({ recAuto: true, recAutoSites: null }, 'site:example.org', ''), 'site');
  assert.equal(S.recAutoWhy({ recAuto: true, recAutoSites: [] }, 'vimeo', ''), '');
  assert.equal(S.recAutoWhy({ recAuto: false, recAutoSites: null }, 'vimeo', ''), '');
  assert.deepEqual(S.recAutoSiteKeys({ recAuto: true, recAutoSites: null }, ['netflix', 'site:a.org']), ['netflix', 'site:a.org']);
  assert.deepEqual(S.recAutoSiteKeys({ recAuto: false, recAutoSites: null }, ['netflix']), []);
  assert.deepEqual(S.recAutoSiteKeys({ recAuto: true, recAutoSites: ['ted'] }, ['netflix']), ['ted']);
});

test('recentTouch: 본 작품을 맨 앞으로 · 이미 맨 앞이면 null(저장 안 함) · 고른 표시는 그대로', () => {
  let l = S.recentTouch([], 'netflix', 'Heartbreak High', 1);
  assert.deepEqual(l, [{ site: 'netflix', title: 'Heartbreak High', at: 1, on: false }]);
  assert.equal(S.recentTouch(l, 'netflix', '  heartbreak   HIGH ', 2), null);
  l = S.recentTouch(l, 'tvnz', 'Shortland Street', 3);
  l = S.recentSet(l, 'netflix', 'Heartbreak High', true, 4);
  l = S.recentTouch(l, 'netflix', 'Heartbreak High', 5);
  assert.deepEqual(l.map((x) => [x.site, x.title, x.on]), [['netflix', 'Heartbreak High', true], ['tvnz', 'Shortland Street', false]]);
  assert.equal(l[0].at, 5);
  assert.equal(S.recentTouch(l, 'netflix', '!!', 6), null, '낱말이 없는 제목은 넣지 않는다');
  assert.equal(S.recentTouch(l, '', 'X', 6), null);
});

test('recentTouch: 고르지 않은 작품은 12개까지만, 고른 작품은 오래돼도 남는다', () => {
  let l = S.recentSet([], 'ted', 'Old Talk', true, 0);
  for (let i = 0; i < 20; i++) l = S.recentTouch(l, 'youtube', 'Channel ' + i, i + 1);
  assert.equal(l.length, S.RECENT_MAX + 1);
  assert.equal(l[0].title, 'Channel 19');
  assert.ok(l.some((x) => x.title === 'Old Talk' && x.on), '고른 작품은 남는다');
  assert.ok(!l.some((x) => x.title === 'Channel 0'), '가장 오래된 것부터 빠진다');
});

test('recentSet: 켜고 끄기 — 없으면 맨 앞에 넣고, 끄더라도 바로 빼지 않는다', () => {
  let l = [];
  for (let i = 0; i < S.RECENT_MAX; i++) l = S.recentTouch(l, 'netflix', 'Show ' + i, i);
  l = S.recentSet(l, 'netflix', 'Show 0', true, 99);
  assert.ok(l.find((x) => x.title === 'Show 0').on);
  l = S.recentSet(l, 'netflix', 'Show 0', false, 100);
  assert.equal(l.length, S.RECENT_MAX, '끈 캡슐이 누르자마자 사라지지 않는다');
  l = S.recentSet(l, 'disney', 'Bluey', true, 101);
  assert.deepEqual([l[0].site, l[0].title, l[0].on], ['disney', 'Bluey', true]);
  assert.equal(S.recentSet(l, 'disney', '   ', true, 102), null);
});
