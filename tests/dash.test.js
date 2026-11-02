const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../extension/src/lib/subtitles.js');
const Sites = require('../extension/src/lib/sites.js');

// ── TVNZ+ 와 같은 모양의 MPD (2026-11-02 실제 응답의 구조): 광고 기간 → 본편 1 → 광고 → 본편 2 ──
const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2M0S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <BaseURL>https://vod.example.nz/content/vol/abc/123-output_cenc_dash_dref.ism/</BaseURL>
  <Period id="1_PT0S_0" start="PT0S" duration="PT15S">
    <BaseURL>https://ads.example.nz/ad1/</BaseURL>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f"><SegmentTemplate timescale="25000" media="asset_$RepresentationID$_$Number%09d$.mp4" initialization="asset_$RepresentationID$_init.mp4" startNumber="1" duration="50000"/><Representation id="7" bandwidth="1000000"/></AdaptationSet>
  </Period>
  <Period id="1_PT15S" start="PT15S" duration="PT40S">
    <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="600" presentationTimeOffset="0" media="123-$RepresentationID$-$Time$.dash" initialization="123-$RepresentationID$.dash"><SegmentTimeline><S t="0" d="3600" r="5"/><S d="2400"/></SegmentTimeline></SegmentTemplate><Representation id="video=3367347" bandwidth="3367347"/></AdaptationSet>
    <AdaptationSet codecs="wvtt" contentType="text" lang="en" mimeType="application/mp4">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
      <SegmentTemplate initialization="123-$RepresentationID$.dash" media="123-$RepresentationID$-$Time$.dash" presentationTimeOffset="0" startNumber="1" timescale="600">
        <SegmentTimeline><S d="3600" r="5" t="0"/><S d="2400" t="21600"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation bandwidth="1000" id="textstream_eng=1000"/>
    </AdaptationSet>
  </Period>
  <Period id="1_PT40S_0" start="PT55S" duration="PT20S">
    <AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="25000" media="ad_$Number$.mp4" duration="50000"/><Representation id="v"/></AdaptationSet>
  </Period>
  <Period id="1_PT40S" start="PT75S" duration="PT45S">
    <AdaptationSet contentType="text" lang="en" mimeType="application/mp4" codecs="wvtt">
      <Role value="subtitle"/>
      <SegmentTemplate initialization="123-$RepresentationID$.dash" media="123-$RepresentationID$-$Time$.dash" presentationTimeOffset="24000" startNumber="8" timescale="600">
        <SegmentTimeline><S d="3600" r="-1" t="24000"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation bandwidth="1000" id="textstream_eng=1000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('MPD: 광고 기간을 빼고 본편 시간 표를 만든다 (TVNZ+ 모양)', () => {
  const m = S.parseMPD(MPD, 'https://vod.example.nz/v1/dash/x/index.mpd?token=1');
  assert.equal(m.periods.length, 4);
  assert.deepEqual(m.periods.map((p) => p.content), [false, true, false, true]);
  assert.equal(m.hasAds, true);
  assert.deepEqual(m.map, [{ presStart: 15, presEnd: 55, contentStart: 0 }, { presStart: 75, presEnd: 120, contentStart: 40 }]);
  // 영상 시각 → 본편 시간 (광고 중이면 NaN)
  assert.ok(Number.isNaN(S.presToContent(m.map, 5)), 'pre-roll');
  assert.equal(S.presToContent(m.map, 20), 5);
  assert.ok(Number.isNaN(S.presToContent(m.map, 60)), 'mid-roll');
  assert.equal(S.presToContent(m.map, 80), 45);
  // 본편 시간 → 영상 시각 (광고를 건너뛴다)
  assert.equal(S.contentToPres(m.map, 5), 20);
  assert.equal(S.contentToPres(m.map, 45), 80);
  assert.equal(S.contentToPres(m.map, 40), 75);
});

test('MPD: 본편 기간마다 자막 조각 주소를 템플릿으로 만든다 ($Time$ · 반복 r · r=-1)', () => {
  const m = S.parseMPD(MPD, 'https://vod.example.nz/v1/dash/x/index.mpd');
  assert.equal(m.textTracks.length, 1);
  const t = m.textTracks[0];
  assert.equal(t.lang, 'en');
  assert.equal(t.codecs, 'wvtt');
  assert.equal(t.parts.length, 2);
  const [a, b] = t.parts;
  assert.equal(a.timescale, 600);
  assert.equal(a.initUrl, 'https://vod.example.nz/content/vol/abc/123-output_cenc_dash_dref.ism/123-textstream_eng=1000.dash');
  assert.equal(a.segUrls.length, 7);
  assert.equal(a.segUrls[0], 'https://vod.example.nz/content/vol/abc/123-output_cenc_dash_dref.ism/123-textstream_eng=1000-0.dash');
  assert.equal(a.segUrls[6], 'https://vod.example.nz/content/vol/abc/123-output_cenc_dash_dref.ism/123-textstream_eng=1000-21600.dash');
  assert.equal(b.pto, 40);
  assert.equal(b.contentStart, 40);
  // r=-1: 기간 끝까지(45초 / 6초 조각 = 8개)
  assert.equal(b.segUrls.length, 8);
  assert.ok(b.segUrls[0].endsWith('-24000.dash') && b.segUrls[7].endsWith('-49200.dash'), b.segUrls.join(' '));
});

test('MPD: 광고 없는 한 기간짜리는 영상 시각 = 본편 시간, 자막 파일 하나(사이드카)', () => {
  const one = `<MPD mediaPresentationDuration="PT10M"><Period><AdaptationSet mimeType="text/vtt" lang="en"><Representation id="s"><BaseURL>subs/en.vtt</BaseURL></Representation></AdaptationSet><AdaptationSet mimeType="video/mp4"><Representation id="v"/></AdaptationSet></Period></MPD>`;
  const m = S.parseMPD(one, 'https://cdn.example.com/a/b/manifest.mpd');
  assert.equal(m.hasAds, false);
  assert.deepEqual(m.map, [{ presStart: 0, presEnd: 600, contentStart: 0 }]);
  assert.equal(S.presToContent(m.map, 123.4), 123.4);
  assert.equal(m.textTracks[0].url, 'https://cdn.example.com/a/b/subs/en.vtt');
});

test('ISO 기간과 템플릿 서식', () => {
  assert.equal(S.parseIsoDuration('PT10M29.703333333S'), 629.703333333);
  assert.equal(S.parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(S.parseIsoDuration('P0Y0M0DT0H1M0.500S'), 60.5);
  assert.ok(Number.isNaN(S.parseIsoDuration('')));
});

// ── MP4 자막 조각 만들기 (wvtt) ──
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => Buffer.concat([u32(Math.floor(n / 4294967296)), u32(n % 4294967296)]);
const box = (type, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]); };
const full = (v, flags) => u32(((v & 0xff) << 24) | (flags & 0xffffff));
function initSeg(timescale, codec) {
  const mdhd = box('mdhd', full(0, 0), u32(0), u32(0), u32(timescale), u32(0), u32(0));
  const stsd = box('stsd', full(0, 0), u32(1), box(codec || 'wvtt', Buffer.alloc(8)));
  const trak = box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd))));
  const trex = box('trex', full(0, 0), u32(1), u32(1), u32(0), u32(0), u32(0));
  return Buffer.concat([box('ftyp', 'iso6', u32(0)), box('moov', trak, box('mvex', trex))]);
}
const cueSample = (...texts) => Buffer.concat(texts.length ? texts.map((t) => box('vttc', box('payl', t))) : [box('vtte')]);
function mediaSeg(baseTime, samples) {
  // samples: [{ d, data }] — trun 에 샘플 길이·크기와 data_offset(moof 시작 기준)을 넣는다
  const build = (dataOffset) => {
    const trun = box('trun', full(0, 0x000301), u32(samples.length), u32(dataOffset), ...samples.flatMap((s) => [u32(s.d), u32(s.data.length)]));
    const traf = box('traf', box('tfhd', full(0, 0x020000), u32(1)), box('tfdt', full(1, 0), u64(baseTime)), trun);
    return box('moof', box('mfhd', full(0, 0), u32(1)), traf);
  };
  const moofLen = build(0).length;
  const moof = build(moofLen + 8);
  return Buffer.concat([box('styp', 'msdh'), moof, box('mdat', Buffer.concat(samples.map((s) => s.data)))]);
}

test('wvtt: 샘플마다 나뉜 같은 대사는 하나로 · 두 대사가 겹치면 같은 시간의 두 줄 · 조각 경계를 넘는 대사도 잇는다', () => {
  const init = initSeg(600);
  // 조각 1 (0~6초): 0~1초 빈칸 · 1~3초 A · 3~4초 A+B(겹침) · 4~6초 B
  const seg1 = mediaSeg(0, [
    { d: 600, data: cueSample() },
    { d: 1200, data: cueSample('<c.cyan>- I was with a friend last night.</c>') },
    { d: 600, data: cueSample('<c.cyan>- I was with a friend last night.</c>', 'You move fast, don&apos;t ya?') },
    { d: 1200, data: cueSample('You move fast, don&apos;t ya?') },
  ]);
  // 조각 2 (6~12초): 6~7초 B 가 이어짐 · 7~12초 C
  const seg2 = mediaSeg(3600, [
    { d: 600, data: cueSample('You move fast, don&apos;t ya?') },
    { d: 3000, data: cueSample('OK, this is quite a full-on way\nto start the day.') },
  ]);
  const cues = S.parseMp4Text([seg1, seg2], init, {});
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [
    [1000, 4000, '- I was with a friend last night.'],
    [3000, 7000, "You move fast, don't ya?"],
    [7000, 12000, 'OK, this is quite a full-on way\nto start the day.'],
  ]);
  // 초기화 조각이 없으면 MPD 의 시간 단위로
  const c2 = S.parseMp4Text([seg2], null, { timescale: 600 });
  assert.equal(c2[0].start, 6000);
});

test('stpp: 샘플 안의 TTML (미디어 시각 그대로 / 샘플 기준)', () => {
  const init = initSeg(1000, 'stpp');
  const ttml = (b, e, t) => `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="${b}" end="${e}">${t}</p></div></body></tt>`;
  const seg = mediaSeg(10000, [{ d: 2000, data: Buffer.from(ttml('00:00:10.500', '00:00:11.500', 'Absolute line')) }, { d: 2000, data: Buffer.from(ttml('00:00:00.200', '00:00:01.000', 'Relative line')) }]);
  const cues = S.parseMp4Text([seg], init, {});
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[10500, 11500, 'Absolute line'], [12200, 13000, 'Relative line']]);
});

test('사이트 주소 규칙: 재생 화면이면 같은 영상에 같은 ID, 아니면 null', () => {
  const v = (k, u) => Sites.videoIdFor(k, u);
  assert.equal(v('tvnz', 'https://www.tvnz.co.nz/player/tvepisode/shortland-street-s2026-e110-shortland-street'), 'shortland-street-s2026-e110-shortland-street');
  assert.equal(v('tvnz', 'https://www.tvnz.co.nz/player/newsclip/survey-voters-trust-labour'), 'survey-voters-trust-labour');
  assert.equal(v('tvnz', 'https://www.tvnz.co.nz/tvseries/shortland-street'), null);
  assert.equal(v('threenow', 'https://www.threenow.co.nz/shows/high-country/season-1-ep-1/1712093997956/M84811-844'), 'M84811-844');
  assert.equal(v('threenow', 'https://www.threenow.co.nz/shows/high-country/1712093997956'), null);
  assert.equal(v('nzonscreen', 'https://www.nzonscreen.com/all-series/westside/westside-episode-one-2015/'), 'westside-episode-one-2015');
  assert.equal(v('nzonscreen', 'https://www.nzonscreen.com/title/westside-episode-one-2015'), 'westside-episode-one-2015');
  assert.equal(v('nzonscreen', 'https://www.nzonscreen.com/all-series/westside/'), null);
  assert.equal(v('maoriplus', 'https://www.maoriplus.co.nz/show/kiri-and-lou/season-1/episode-1/play'), 'kiri-and-lou/season-1/episode-1');
  assert.equal(v('maoriplus', 'https://www.maoriplus.co.nz/show/kiri-and-lou'), null);
  assert.equal(v('ted', 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity?language=ko'), 'sir_ken_robinson_do_schools_kill_creativity');
  assert.equal(v('vimeo', 'https://vimeo.com/76979871'), '76979871');
  assert.equal(v('vimeo', 'https://vimeo.com/channels/staffpicks/76979871'), '76979871');
  assert.equal(v('vimeo', 'https://vimeo.com/watch'), null);
  assert.equal(Sites.forHost('www.tvnz.co.nz').key, 'tvnz');
  assert.equal(Sites.forHost('player.vimeo.com'), null);
  // 사용자가 켠 사이트: 경로 + 영상을 가리키는 매개변수
  assert.equal(v('site:www.kanopy.com', 'https://www.kanopy.com/en/product/12345?utm=1&v=9'), '/en/product/12345?v=9');
  assert.equal(Sites.label('site:www.kanopy.com'), 'kanopy.com');
  assert.deepEqual(Sites.byKey('site:example.org').patterns, ['https://example.org/*', 'http://example.org/*']);
});
