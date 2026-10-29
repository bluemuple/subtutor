const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../extension/src/lib/subtitles.js');

const NETFLIX_VTT = `WEBVTT

1
00:00:05.422 --> 00:00:07.465 position:50.00%,middle align:middle size:80.00%
<c.white><c.bg_black>My dog Raffie bites all the time</c></c>
<c.white><c.bg_black>when he's playing,</c></c>

2
00:00:07.466 --> 00:00:09.400 position:50.00%,middle align:middle size:80.00%
but my mum says, "You're not a dog, Rory,"

3
00:01:02.000 --> 00:01:03.500 line:10.00% align:middle
<i>&lrm;[dramatic music]</i>

4
00:01:02.000 --> 00:01:03.500 position:50.00% align:middle
I don&#39;t think she&amp;s paying attention.
`;

const NETFLIX_DFXP = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en">
<body><div>
<p begin="54220000t" end="74650000t" region="region0" xml:id="subtitle1"><span style="style0">My dog Raffie bites all the time</span><br/><span style="style0">when he&apos;s playing,</span></p>
<p begin="74660000t" end="94000000t" region="region0" xml:id="subtitle2">but my mum says, &quot;You&apos;re not a dog, Rory,&quot;</p>
<p begin="120000000t" end="130000000t" region="regionTop" xml:id="subtitle3">Top line</p>
<p begin="120000000t" end="130000000t" region="region0" xml:id="subtitle4">Bottom line</p>
</div></body></tt>`;

const PRIME_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xml:lang="en-US" xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">
<body><div>
<p begin="00:00:12.512" end="00:00:14.598" region="bottom"><span tts:fontStyle="italic">Where are you going?</span></p>
<p begin="00:00:15.000" end="00:00:17.250" region="bottom">To the shops.<br/>Want anything?</p>
<p begin="01:02:03.400" end="01:02:05.000">Late cue</p>
</div></body></tt>`;

const FRAME_TTML = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25"><body><div>
<p begin="00:00:01:12" end="00:00:02:00">Frame based</p>
<p begin="3s" dur="1.5s">Dur based</p>
</div></body></tt>`;

const HLS_SEG1 = `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000

00:00:01.000 --> 00:00:03.000 line:90%
Hello there.
`;
const HLS_SEG2 = `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:1800000,LOCAL:00:00:00.000

00:00:00.500 --> 00:00:02.000
Second segment.
`;

const SRT = `1
00:00:01,000 --> 00:00:02,000
First

2
00:00:03,000 --> 00:00:04,000
Second
`;

test('Netflix WebVTT: positions, tags, entities, same-timing merge', () => {
  const { cues } = S.parseVTT(NETFLIX_VTT);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 5422);
  assert.equal(cues[0].end, 7465);
  assert.equal(cues[0].text, "My dog Raffie bites all the time\nwhen he's playing,");
  assert.equal(cues[1].text, 'but my mum says, "You\'re not a dog, Rory,"');
  assert.equal(cues[2].start, 62000);
  assert.equal(cues[2].text, "[dramatic music]\nI don't think she&s paying attention.");
});

test('Netflix DFXP ticks + same-timing merge', () => {
  const { cues, lang } = S.parseTTML(NETFLIX_DFXP);
  assert.equal(lang, 'en');
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 5422);
  assert.equal(cues[0].end, 7465);
  assert.equal(cues[0].text, "My dog Raffie bites all the time\nwhen he's playing,");
  assert.equal(cues[1].text, 'but my mum says, "You\'re not a dog, Rory,"');
  assert.equal(cues[2].text, 'Top line\nBottom line');
});

test('Prime TTML clock times, span, br', () => {
  const { cues, lang } = S.parseTTML(PRIME_TTML);
  assert.equal(lang, 'en-US');
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 12512);
  assert.equal(cues[0].end, 14598);
  assert.equal(cues[0].text, 'Where are you going?');
  assert.equal(cues[1].text, 'To the shops.\nWant anything?');
  assert.equal(cues[2].start, 3723400);
});

test('TTML frames and dur', () => {
  const { cues } = S.parseTTML(FRAME_TTML);
  assert.equal(cues[0].start, 1480);
  assert.equal(cues[0].end, 2000);
  assert.equal(cues[1].start, 3000);
  assert.equal(cues[1].end, 4500);
});

test('HLS segments with X-TIMESTAMP-MAP', () => {
  const r1 = S.parseVTT(HLS_SEG1);
  assert.equal(r1.hasTimestampMap, true);
  assert.equal(r1.tsOffsetMs, 10000);
  const { cues } = S.parseSegments([HLS_SEG2, HLS_SEG1], 'vtt');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 11000);
  assert.equal(cues[0].text, 'Hello there.');
  assert.equal(cues[1].start, 20500);
});

test('SRT via parseAny', () => {
  const r = S.parseAny(SRT);
  assert.equal(r.format, 'srt');
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[1].start, 3000);
});

test('parseAny detects TTML', () => {
  assert.equal(S.parseAny(PRIME_TTML).format, 'ttml');
  assert.equal(S.parseAny(NETFLIX_VTT).format, 'vtt');
});

test('cue lookup helpers', () => {
  const cues = S.finalizeCues([
    { start: 1000, end: 2000, text: 'a' }, { start: 3000, end: 4000, text: 'b' }, { start: 5000, end: 6000, text: 'c' },
  ]);
  assert.equal(S.findCueIndex(cues, 1500), 0);
  assert.equal(S.findCueIndex(cues, 2500), -1);
  assert.equal(S.findCueIndex(cues, 5999), 2);
  assert.equal(S.findCueIndex(cues, 6000), -1);
  assert.equal(S.findCueIndex(cues, 0), -1);
  assert.equal(S.lastStartedIndex(cues, 2500), 0);
  assert.equal(S.lastStartedIndex(cues, 500), -1);
  assert.equal(S.nextStartingIndex(cues, 2500), 1);
  assert.equal(S.nextStartingIndex(cues, 5000), -1);
});

test('mergeTranslations by overlap', () => {
  const en = S.finalizeCues([
    { start: 1000, end: 3000, text: 'Where are you going?' },
    { start: 3100, end: 5000, text: 'To the shops.' },
    { start: 9000, end: 10000, text: 'No match' },
  ]);
  const ko = S.finalizeCues([
    { start: 1050, end: 2950, text: '어디 가?' },
    { start: 3000, end: 4000, text: '가게에.' },
    { start: 4000, end: 5100, text: '뭐 필요해?' },
    { start: 20000, end: 21000, text: '관계없음' },
  ]);
  const n = S.mergeTranslations(en, ko);
  assert.equal(n, 2);
  assert.equal(en[0].ko, '어디 가?');
  assert.equal(en[1].ko, '가게에. 뭐 필요해?');
  assert.equal(en[2].ko, undefined);
});

test('normalizeForCompare + diffWords', () => {
  assert.equal(S.normalizeForCompare("Rory: I don't think she's paying attention."), 'i dont think shes paying attention');
  assert.equal(S.normalizeForCompare('[music] Well-known, right?'), 'well known right');
  const d = S.diffWords("I don't think she's paying attention.", 'i dont think she is paying attention');
  assert.equal(d.total, 6);
  assert.equal(d.equal, 5);
  assert.equal(d.perfect, false);
  const ok = S.diffWords('My dog Raffie bites all the time', 'my dog raffie bites all the time!');
  assert.equal(ok.perfect, true);
  assert.equal(ok.accuracy, 100);
});

test('m3u8 parsing', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",FORCED=NO,AUTOSELECT=YES,URI="sub/en/prog.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English --forced--",LANGUAGE="en",FORCED=YES,URI="sub/en-f/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="aud/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="sub"
video/1.m3u8`;
  const m = S.parseM3U8(master, 'https://cdn.example.com/x/master.m3u8');
  assert.equal(m.subtitles.length, 2);
  assert.equal(m.subtitles[0].uri, 'https://cdn.example.com/x/sub/en/prog.m3u8');
  assert.equal(m.subtitles[1].forced, true);
  const media = `#EXTM3U
#EXTINF:6.0,
seg1.vtt
#EXT-X-DISCONTINUITY
#EXTINF:6.0,
seg2.vtt`;
  const p = S.parseM3U8(media, 'https://cdn.example.com/x/sub/en/prog.m3u8');
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].uri, 'https://cdn.example.com/x/sub/en/seg1.vtt');
  assert.equal(p.segments[1].discontinuity, true);
});

test('formatTime', () => {
  assert.equal(S.formatTime(5422), '0:05');
  assert.equal(S.formatTime(3723400), '1:02:03');
});

const JSON3 = JSON.stringify({ wireMagic: 'pb3', events: [
  { tStartMs: 0, dDurationMs: 5000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
  { tStartMs: 1230, dDurationMs: 2500, segs: [{ utf8: 'Hello there,' }, { utf8: '\nwelcome back.' }] },
  { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'Second line &amp; more' }] },
] });
const JSON3_ASR = JSON.stringify({ events: [
  { tStartMs: 1000, dDurationMs: 6000, wWinId: 1, segs: [{ utf8: 'hello', acAsrConf: 0 }, { utf8: ' world', tOffsetMs: 500 }] },
  { tStartMs: 3990, dDurationMs: 10, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
  { tStartMs: 4000, dDurationMs: 5000, wWinId: 1, segs: [{ utf8: 'next', acAsrConf: 0 }, { utf8: ' sentence', tOffsetMs: 400 }] },
] });

test('YouTube json3: header events skipped, segs joined, entities decoded', () => {
  const { cues } = S.parseJson3(JSON3);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1230);
  assert.equal(cues[0].end, 3730);
  assert.equal(cues[0].text, 'Hello there,\nwelcome back.');
  assert.equal(cues[1].text, 'Second line & more');
  assert.equal(S.parseAny(JSON3).format, 'json3');
});

test('YouTube json3 ASR: append events dropped, overlapping ends clamped', () => {
  const { cues } = S.parseJson3(JSON3_ASR, { asr: true });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'hello world');
  assert.equal(cues[0].end, 4000);
  assert.equal(cues[1].start, 4000);
  const unclamped = S.parseJson3(JSON3_ASR).cues;
  assert.equal(unclamped[0].end, 7000);
});
