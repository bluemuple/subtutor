/*
 * SubTutor – 자막 유틸리티
 * 확장 프로그램 콘텐츠 스크립트(전역 SubTutorSubs)와 node 테스트(module.exports)에서 함께 사용한다.
 * - WebVTT / SRT / TTML(DFXP, IMSC) 파싱
 * - HLS 분할 WebVTT의 X-TIMESTAMP-MAP 처리
 * - 영어 자막에 한국어 자막 트랙을 시간 겹침으로 병합
 * - 받아쓰기 비교용 정규화 / 단어 diff
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SubTutorSubs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '',
    hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  };

  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        if (!isFinite(n)) return m;
        if (n === 0x200e || n === 0x200f) return '';
        try { return String.fromCodePoint(n); } catch (e) { return m; }
      }
      const k = code.toLowerCase();
      return k in ENTITIES ? ENTITIES[k] : m;
    });
  }

  function cleanLine(s) {
    return decodeEntities(String(s).replace(/<[^>]*>/g, ''))
      .replace(/[‎‏‪-‮﻿]/g, '')
      .replace(/[ \t ]+/g, ' ')
      .trim();
  }

  /** 태그 제거, <br> → 줄바꿈, 엔티티 해제, 빈 줄 제거 */
  function cleanCueText(raw) {
    const withBreaks = String(raw).replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, '\n');
    return withBreaks.split('\n').map(cleanLine).filter(Boolean).join('\n');
  }

  function parseVttTime(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(s).trim());
    if (!m) return null;
    const h = m[1] ? +m[1] : 0;
    const frac = m[4] ? +(m[4].padEnd(3, '0')) : 0;
    return (h * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + frac;
  }

  function parseTtmlTime(s, opts) {
    const o = opts || {};
    const str = String(s).trim();
    let m;
    if ((m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(str))) {
      const v = parseFloat(m[1]);
      switch (m[2]) {
        case 'h': return v * 3600000;
        case 'm': return v * 60000;
        case 's': return v * 1000;
        case 'ms': return v;
        case 'f': return (v / (o.frameRate || 30)) * 1000;
        case 't': return (v / (o.tickRate || 1)) * 1000;
      }
    }
    if ((m = /^(\d+):(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(str))) {
      let ms = ((+m[1]) * 3600 + (+m[2]) * 60) * 1000 + parseFloat(m[3].replace(',', '.')) * 1000;
      if (m[4] !== undefined) ms += (parseFloat(m[4]) / (o.frameRate || 30)) * 1000;
      return ms;
    }
    if ((m = /^(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(str))) {
      return ((+m[1]) * 60 + parseFloat(m[2].replace(',', '.'))) * 1000;
    }
    return null;
  }

  /** 시작 시간순 정렬, 같은 타이밍의 큐 병합(넷플릭스는 위치별로 <p>를 나눔), 완전 중복 제거 */
  function finalizeCues(cues) {
    const sorted = cues
      .map((c) => ({ start: Math.round(c.start), end: Math.round(c.end), text: c.text }))
      .filter((c) => c.text && c.end > c.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const c of sorted) {
      const last = out[out.length - 1];
      if (last && last.start === c.start && last.end === c.end) {
        if (!last.text.split('\n').includes(c.text)) last.text += '\n' + c.text;
        continue;
      }
      if (last && last.start === c.start && last.text === c.text) { last.end = Math.max(last.end, c.end); continue; }
      out.push({ start: c.start, end: c.end, text: c.text });
    }
    out.forEach((c, i) => { c.index = i; });
    return out;
  }

  function parseVTT(text) {
    const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    let tsOffsetMs = 0;
    let hasTimestampMap = false;
    const mm = /X-TIMESTAMP-MAP=([^\n]+)/i.exec(src);
    if (mm) {
      const mpeg = /MPEGTS:(\d+)/i.exec(mm[1]);
      const local = /LOCAL:([\d:.,]+)/i.exec(mm[1]);
      if (mpeg) {
        hasTimestampMap = true;
        tsOffsetMs = Math.round((+mpeg[1]) / 90) - (local ? (parseVttTime(local[1]) || 0) : 0);
      }
    }
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.includes('-->')) {
        const parts = line.split('-->');
        const start = parseVttTime(parts[0]);
        const endStr = (parts[1] || '').trim().split(/\s+/)[0];
        const end = parseVttTime(endStr);
        i++;
        const buf = [];
        while (i < lines.length && lines[i].trim() !== '') { buf.push(lines[i]); i++; }
        if (start !== null && end !== null && end > start) {
          const t = cleanCueText(buf.join('\n'));
          if (t) cues.push({ start, end, text: t });
        }
      } else {
        i++;
      }
    }
    return { cues: finalizeCues(cues), tsOffsetMs, hasTimestampMap };
  }

  function parseTTML(text) {
    const src = String(text).replace(/^﻿/, '');
    const head = /<tt\b[^>]*>/i.exec(src);
    const headAttrs = head ? head[0] : '';
    const attr = (name) => {
      const m = new RegExp('(?:^|\\s)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"', 'i').exec(headAttrs);
      return m ? m[1] : null;
    };
    const frameRate = parseFloat(attr('ttp:frameRate') || attr('frameRate') || '') || 30;
    const subFrameRate = parseFloat(attr('ttp:subFrameRate') || '') || 1;
    let tickRate = parseFloat(attr('ttp:tickRate') || attr('tickRate') || '');
    if (!tickRate) tickRate = attr('ttp:frameRate') ? frameRate * subFrameRate : 1;
    const lang = attr('xml:lang');
    const opts = { tickRate, frameRate };
    const cues = [];
    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(src))) {
      const a = m[1];
      const begin = /\bbegin\s*=\s*"([^"]*)"/i.exec(a);
      if (!begin) continue;
      const end = /\bend\s*=\s*"([^"]*)"/i.exec(a);
      const dur = /\bdur\s*=\s*"([^"]*)"/i.exec(a);
      const s = parseTtmlTime(begin[1], opts);
      let e = end ? parseTtmlTime(end[1], opts) : null;
      if (e === null && dur && s !== null) { const d = parseTtmlTime(dur[1], opts); if (d !== null) e = s + d; }
      if (s === null || e === null || e <= s) continue;
      const t = cleanCueText(m[2]);
      if (t) cues.push({ start: s, end: e, text: t });
    }
    return { cues: finalizeCues(cues), lang };
  }

  /** 유튜브 timedtext fmt=json3. asr=true면 자동 자막의 겹치는 끝 시간을 다음 큐 시작으로 자른다 */
  function parseJson3(text, opts) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { cues: [] }; }
    const events = data && Array.isArray(data.events) ? data.events : [];
    const raw = [];
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
      const joined = ev.segs.map((sg) => (sg && sg.utf8) || '').join('').replace(/\u200b/g, '');
      const cleaned = cleanCueText(joined);
      if (!cleaned) continue;
      const start = Math.round(+ev.tStartMs || 0);
      const dur = Math.round(+ev.dDurationMs || 0);
      raw.push({ start, end: start + (dur > 0 ? dur : 2000), text: cleaned });
    }
    raw.sort((a, b) => a.start - b.start);
    if (opts && opts.asr) {
      for (let i = 0; i < raw.length - 1; i++) {
        if (raw[i].end > raw[i + 1].start) raw[i].end = Math.max(raw[i].start + 300, raw[i + 1].start);
      }
    }
    return { cues: finalizeCues(raw) };
  }

  /** 포맷을 추측해서 파싱. 반환: {cues, tsOffsetMs, hasTimestampMap, lang, format} */
  function parseAny(text, hint) {
    const s = String(text || '').replace(/^﻿/, '').trimStart();
    const h = (hint || '').toLowerCase();
    if (h === 'json3' || h === 'json3-asr' || (s.startsWith('{') && /"events"\s*:/.test(s.slice(0, 2000)))) {
      const r = parseJson3(s, { asr: h === 'json3-asr' });
      return { cues: r.cues, tsOffsetMs: 0, hasTimestampMap: false, lang: null, format: 'json3' };
    }
    if (/^<\?xml|^<tt\b|^<ttml/i.test(s) || h === 'ttml' || h === 'ttml2' || h === 'dfxp' || h === 'xml' || (s.startsWith('<') && /<p\b/i.test(s))) {
      const r = parseTTML(s);
      return { cues: r.cues, tsOffsetMs: 0, hasTimestampMap: false, lang: r.lang, format: 'ttml' };
    }
    const r = parseVTT(s);
    return { cues: r.cues, tsOffsetMs: r.tsOffsetMs, hasTimestampMap: r.hasTimestampMap, lang: null, format: s.startsWith('WEBVTT') ? 'vtt' : 'srt' };
  }

  /** 여러 조각(HLS 세그먼트)을 하나의 큐 목록으로 */
  function parseSegments(texts, hint) {
    const all = [];
    let anyMap = false;
    for (const t of texts) {
      const r = parseAny(t, hint);
      if (r.hasTimestampMap) anyMap = true;
      for (const c of r.cues) all.push({ start: c.start + (r.hasTimestampMap ? r.tsOffsetMs : 0), end: c.end + (r.hasTimestampMap ? r.tsOffsetMs : 0), text: c.text });
    }
    return { cues: finalizeCues(all), hasTimestampMap: anyMap };
  }

  /** t(ms)가 속한 큐 인덱스. 없으면 -1 */
  function findCueIndex(cues, t) {
    let lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return -1;
    // 겹치는 큐가 있을 수 있으니 근처 몇 개를 확인
    for (let i = found; i >= 0 && i > found - 4; i--) {
      if (cues[i].start <= t && t < cues[i].end) return i;
    }
    return -1;
  }

  /** t 이전에 시작한 마지막 큐 인덱스(없으면 -1) */
  function lastStartedIndex(cues, t) {
    let lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  /** t 이후에 시작하는 첫 큐 인덱스(없으면 -1) */
  function nextStartingIndex(cues, t) {
    let lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start > t) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return found;
  }

  /**
   * 영어 큐에 한국어 트랙 큐를 시간 겹침으로 붙인다.
   * 겹침이 짧은 쪽 길이의 40% 이상이거나 300ms 이상이면 같은 대사로 본다.
   */
  function mergeTranslations(enCues, koCues) {
    if (!koCues || !koCues.length) return 0;
    let count = 0;
    let j = 0;
    for (const e of enCues) {
      while (j < koCues.length && koCues[j].end <= e.start) j++;
      const picked = [];
      for (let k = j; k < koCues.length && koCues[k].start < e.end; k++) {
        const ko = koCues[k];
        const overlap = Math.min(e.end, ko.end) - Math.max(e.start, ko.start);
        if (overlap <= 0) continue;
        const minDur = Math.min(e.end - e.start, ko.end - ko.start);
        if (overlap >= 0.4 * minDur || overlap >= 300) picked.push(ko);
      }
      if (picked.length) {
        const text = picked.map((k) => k.text.replace(/\n/g, ' ')).join(' ');
        if (text) { e.ko = text; e.koSource = 'track'; count++; }
      }
    }
    return count;
  }

  function normalizeForCompare(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’´`]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      .replace(/^(?:[a-z][a-z.'-]*(?:\s[a-z][a-z.'-]*)?):\s+/gm, '')
      .replace(/-/g, ' ')
      .replace(/'/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 기대 문장과 입력 문장을 단어 단위 LCS로 비교. ops: {type:'equal'|'missing'|'extra', word} */
  function diffWords(expected, actual) {
    const a = normalizeForCompare(expected).split(' ').filter(Boolean);
    const b = normalizeForCompare(actual).split(' ').filter(Boolean);
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0, equal = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type: 'equal', word: a[i] }); i++; j++; equal++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'missing', word: a[i] }); i++; }
      else { ops.push({ type: 'extra', word: b[j] }); j++; }
    }
    while (i < n) { ops.push({ type: 'missing', word: a[i++] }); }
    while (j < m) { ops.push({ type: 'extra', word: b[j++] }); }
    const total = Math.max(n, 1);
    return { ops, equal, total: n, accuracy: Math.round((equal / total) * 100), perfect: n > 0 && equal === n && m === n };
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
  }

  /** 간단한 HLS 플레이리스트 파싱 */
  function parseM3U8(text, baseUrl) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const resolve = (u) => { try { return new URL(u, baseUrl).href; } catch (e) { return u; } };
    const subtitles = [];
    const segments = [];
    let discontinuity = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = {};
        line.slice('#EXT-X-MEDIA:'.length).replace(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g, (m, k, v, q) => { attrs[k] = q !== undefined ? q : v; return ''; });
        if (attrs.TYPE === 'SUBTITLES' && attrs.URI) {
          subtitles.push({ name: attrs.NAME || '', lang: attrs.LANGUAGE || '', forced: attrs.FORCED === 'YES', characteristics: attrs.CHARACTERISTICS || '', uri: resolve(attrs.URI) });
        }
      } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        discontinuity = true;
      } else if (!line.startsWith('#')) {
        segments.push({ uri: resolve(line), discontinuity });
        discontinuity = false;
      }
    }
    return { subtitles, segments };
  }

  // ───────── DASH (MPD) ─────────
  // 범용 사이트(TVNZ+ 등)의 플레이어가 받는 MPD 에서 자막 조각 주소와, 광고가 끼워진 기간(Period)을 빼고 본편 시간을 계산할 표를 만든다.
  // 브라우저가 아닌 곳(node 테스트)에서도 돌도록 아주 작은 XML 해석기를 쓴다 (MPD 는 단순한 XML 이다)
  function parseXml(text) {
    const src = String(text || '');
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(src))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) { top.text += m[1]; continue; }
      if (m[2]) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break; } continue; }
      if (m[3]) {
        const node = { name: m[3], local: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
        const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = attrRe.exec(m[4] || ''))) node.attrs[a[1].replace(/^.*:/, '')] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
        top.children.push(node);
        if (!m[5]) stack.push(node);
        continue;
      }
      if (m[6] !== undefined) top.text += decodeEntities(m[6]);
    }
    return root;
  }
  const xmlKids = (n, name) => (n ? n.children.filter((c) => c.local === name) : []);
  const xmlKid = (n, name) => xmlKids(n, name)[0] || null;
  /** ISO 8601 기간(PT10M29.7S) → 초 */
  function parseIsoDuration(s) {
    const n = '(\\d+(?:\\.\\d+)?)';
    const m = new RegExp('^P(?:' + n + 'Y)?(?:' + n + 'M)?(?:' + n + 'W)?(?:' + n + 'D)?(?:T(?:' + n + 'H)?(?:' + n + 'M)?(?:' + n + 'S)?)?$').exec(String(s || '').trim());
    if (!m || String(s).trim() === 'P' || String(s).trim() === 'PT') return NaN;
    const v = (i) => +(m[i] || 0);
    return v(1) * 31536000 + v(2) * 2592000 + v(3) * 604800 + v(4) * 86400 + v(5) * 3600 + v(6) * 60 + v(7);
  }
  function fillTemplate(tpl, vars) {
    return String(tpl).replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$|\$\$/g, (m, k, w) => {
      if (!k) return '$';
      if (vars[k] === undefined) return m;
      const v = String(vars[k]);
      return w ? v.padStart(+w, '0') : v;
    });
  }
  const resolveUrl = (base, rel) => { try { return new URL(rel, base).href; } catch (e) { return rel; } };
  const isTextSet = (as, rep) => {
    const mime = (as.attrs.mimeType || (rep && rep.attrs.mimeType) || '').toLowerCase();
    const codecs = (as.attrs.codecs || (rep && rep.attrs.codecs) || '').toLowerCase();
    return as.attrs.contentType === 'text' || /^text\/|ttml|vtt/.test(mime) || /wvtt|stpp|ttml/.test(codecs);
  };
  /**
   * MPD → { duration, periods:[{id,start,dur,content}], map:[{presStart,presEnd,contentStart}], hasAds, textTracks:[{lang,label,role,codecs,parts|url}] }
   * - 광고(SSAI) 기간: 자막 세트가 있는 기간이 하나라도 있으면 자막 세트가 없는 기간을 광고로 본다 (TVNZ+ 는 광고 기간에 자막·presentationTimeOffset 이 없다)
   * - 본편 시간(contentStart): 본편 기간들의 presentationTimeOffset 이 이어지면 그 값(TVNZ+ 는 본편의 원래 시각), 아니면 본편 기간 길이의 누적
   * - 자막 조각의 미디어 시각 M(초) → 본편 시간 = contentStart + (M − pto)
   */
  function parseMPD(text, mpdUrl) {
    const doc = parseXml(text);
    const mpd = xmlKid(doc, 'MPD');
    if (!mpd) throw new Error('MPD 가 아닙니다');
    const baseOf = (node, parent) => { const b = xmlKid(node, 'BaseURL'); return b && b.text.trim() ? resolveUrl(parent, b.text.trim()) : parent; };
    const mpdBase = baseOf(mpd, mpdUrl || '');
    const total = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
    const periods = [];
    let cursor = 0;
    xmlKids(mpd, 'Period').forEach((p, i) => {
      const start = p.attrs.start != null ? parseIsoDuration(p.attrs.start) : cursor;
      const dur = p.attrs.duration != null ? parseIsoDuration(p.attrs.duration) : NaN;
      periods.push({ node: p, id: p.attrs.id || String(i), start: Number.isFinite(start) ? start : cursor, dur });
      cursor = periods[i].start + (Number.isFinite(dur) ? dur : 0);
    });
    periods.forEach((p, i) => {
      if (Number.isFinite(p.dur)) return;
      const next = periods[i + 1];
      p.dur = next ? next.start - p.start : (Number.isFinite(total) ? total - p.start : 0);
    });
    // 세그먼트 템플릿은 AdaptationSet 과 Representation 에 나뉘어 있을 수 있다 (Representation 이 덮는다)
    const templateOf = (as, rep) => {
      const a = xmlKid(as, 'SegmentTemplate'), r = rep ? xmlKid(rep, 'SegmentTemplate') : null;
      if (!a && !r) return null;
      const attrs = Object.assign({}, a ? a.attrs : {}, r ? r.attrs : {});
      const timeline = xmlKid(r, 'SegmentTimeline') || xmlKid(a, 'SegmentTimeline');
      return { attrs, timeline, hasPto: attrs.presentationTimeOffset != null };
    };
    const ptoOf = (period) => {
      for (const as of xmlKids(period.node, 'AdaptationSet')) {
        const rep = xmlKid(as, 'Representation');
        const t = templateOf(as, rep);
        if (t && t.hasPto) return { pto: (+t.attrs.presentationTimeOffset || 0) / (+t.attrs.timescale || 1), explicit: true };
      }
      return { pto: 0, explicit: false };
    };
    const textSetsOf = (period) => xmlKids(period.node, 'AdaptationSet').filter((as) => isTextSet(as, xmlKid(as, 'Representation')));
    const anyText = periods.some((p) => textSetsOf(p).length);
    const anyPto = periods.some((p) => ptoOf(p).explicit);
    periods.forEach((p) => { p.content = anyText ? textSetsOf(p).length > 0 : (anyPto ? ptoOf(p).explicit : true); });
    if (!periods.some((p) => p.content)) periods.forEach((p) => { p.content = true; });
    const content = periods.filter((p) => p.content);
    // 본편 시간: presentationTimeOffset 이 본편 기간마다 이어지면(앞 본편의 끝 = 다음 본편의 시작) 그 값을 쓴다
    const ptos = content.map((p) => ptoOf(p));
    const ptoChain = ptos.every((x) => x.explicit) && content.every((p, i) => !i || Math.abs(ptos[i].pto - (ptos[i - 1].pto + content[i - 1].dur)) < 1.5);
    let cum = ptos.length ? ptos[0].pto : 0;
    content.forEach((p, i) => { p.pto = ptos[i].pto; p.contentStart = ptoChain ? p.pto : cum; cum = p.contentStart + p.dur; });
    const map = content.map((p) => ({ presStart: p.start, presEnd: p.start + p.dur, contentStart: p.contentStart }));
    // 자막 트랙: 같은 언어·역할의 자막 세트를 본편 기간마다 모은다
    const tracks = new Map();
    for (const p of content) {
      const pBase = baseOf(p.node, mpdBase);
      for (const as of textSetsOf(p)) {
        const rep = xmlKid(as, 'Representation');
        const aBase = baseOf(as, pBase);
        const rBase = rep ? baseOf(rep, aBase) : aBase;
        const lang = String(as.attrs.lang || (rep && rep.attrs.lang) || 'und');
        const role = xmlKids(as, 'Role').map((r) => r.attrs.value).join(',');
        const label = (xmlKid(as, 'Label') && xmlKid(as, 'Label').text.trim()) || as.attrs.label || '';
        const codecs = String(as.attrs.codecs || (rep && rep.attrs.codecs) || (/vtt/i.test(as.attrs.mimeType || '') ? 'vtt' : (/ttml/i.test(as.attrs.mimeType || '') ? 'ttml' : ''))).toLowerCase();
        const key = lang + '|' + role + '|' + label;
        if (!tracks.has(key)) tracks.set(key, { lang, label, role, codecs, mime: as.attrs.mimeType || '', parts: [], url: '' });
        const tr = tracks.get(key);
        const tpl = templateOf(as, rep);
        const vars = { RepresentationID: rep ? rep.attrs.id : '', Bandwidth: rep ? rep.attrs.bandwidth : '' };
        const part = { presStart: p.start, dur: p.dur, pto: p.pto, contentStart: p.contentStart, timescale: 1, initUrl: '', segUrls: [] };
        if (tpl) {
          const ts = +tpl.attrs.timescale || 1;
          const ptoTicks = +tpl.attrs.presentationTimeOffset || 0;
          const startNumber = tpl.attrs.startNumber != null ? +tpl.attrs.startNumber : 1;
          part.timescale = ts;
          part.pto = ptoTicks / ts;
          if (tpl.attrs.initialization) part.initUrl = resolveUrl(rBase, fillTemplate(tpl.attrs.initialization, vars));
          const media = tpl.attrs.media || '';
          if (tpl.timeline) {
            let t = 0, n = startNumber;
            for (const s of xmlKids(tpl.timeline, 'S')) {
              const d = +s.attrs.d;
              if (!(d > 0)) continue;
              if (s.attrs.t != null) t = +s.attrs.t;
              let r = s.attrs.r != null ? +s.attrs.r : 0;
              if (r < 0) r = Math.max(0, Math.ceil((ptoTicks + p.dur * ts - t) / d) - 1);
              for (let k = 0; k <= r && part.segUrls.length < 5000; k++) { part.segUrls.push(resolveUrl(rBase, fillTemplate(media, Object.assign({}, vars, { Number: n, Time: t })))); t += d; n++; }
            }
          } else if (+tpl.attrs.duration > 0) {
            const d = +tpl.attrs.duration;
            const count = Math.min(5000, Math.ceil((p.dur * ts) / d));
            for (let k = 0; k < count; k++) part.segUrls.push(resolveUrl(rBase, fillTemplate(media, Object.assign({}, vars, { Number: startNumber + k, Time: ptoTicks + k * d }))));
          }
        } else {
          const list = xmlKid(rep, 'SegmentList') || xmlKid(as, 'SegmentList');
          if (list) {
            part.timescale = +list.attrs.timescale || 1;
            const init = xmlKid(list, 'Initialization');
            if (init && init.attrs.sourceURL) part.initUrl = resolveUrl(rBase, init.attrs.sourceURL);
            for (const su of xmlKids(list, 'SegmentURL')) if (su.attrs.media) part.segUrls.push(resolveUrl(rBase, su.attrs.media));
          } else if (rBase && rBase !== mpdUrl) {
            // 자막 파일 하나(사이드카): 본편 기간마다 같은 파일이면 한 번만 쓴다
            if (!tr.url) { tr.url = rBase; tr.urlContentStart = p.contentStart - p.pto; }
            continue;
          }
        }
        if (part.segUrls.length) tr.parts.push(part);
      }
    }
    const textTracks = Array.from(tracks.values()).filter((t) => t.url || t.parts.length);
    return {
      duration: Number.isFinite(total) ? total : (periods.length ? periods[periods.length - 1].start + periods[periods.length - 1].dur : 0),
      periods: periods.map((p) => ({ id: p.id, start: p.start, dur: p.dur, content: p.content })),
      map, hasAds: periods.some((p) => !p.content), textTracks,
    };
  }
  /** 영상 시각(초, 광고 포함) → 본편 시간(초). 광고 기간이면 NaN */
  function presToContent(map, pres) {
    if (!map || !map.length) return pres;
    for (const m of map) if (pres >= m.presStart - 0.05 && pres < m.presEnd + 0.05) return m.contentStart + Math.max(0, pres - m.presStart);
    return NaN;
  }
  /** 본편 시간(초) → 영상 시각(초). 본편 기간 밖이면 가장 가까운 본편으로 */
  function contentToPres(map, content) {
    if (!map || !map.length) return content;
    let best = null;
    for (const m of map) {
      const len = m.presEnd - m.presStart;
      if (content >= m.contentStart - 0.001 && content < m.contentStart + len) return m.presStart + (content - m.contentStart);
      const dist = content < m.contentStart ? m.contentStart - content : content - (m.contentStart + len);
      if (!best || dist < best.dist) best = { dist, pres: content < m.contentStart ? m.presStart : m.presEnd - 0.05 };
    }
    return best ? best.pres : content;
  }

  // ───────── MP4 자막 조각 (DASH 의 wvtt · stpp) ─────────
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function mp4Boxes(b, start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end) {
      let size = u32(b, off);
      const type = fourcc(b, off + 4);
      let hdr = 8;
      if (size === 1) { if (off + 16 > end) break; size = u64(b, off + 8); hdr = 16; } else if (size === 0) size = end - off;
      if (size < hdr || off + size > end) break;
      out.push({ type, start: off, data: off + hdr, end: off + size });
      off += size;
    }
    return out;
  }
  const findBox = (b, boxes, path) => {
    let list = boxes, box = null;
    for (const t of path) {
      box = list.find((x) => x.type === t);
      if (!box) return null;
      list = mp4Boxes(b, box.data + (t === 'stsd' ? 8 : 0), box.end);
    }
    return box;
  };
  const utf8 = (b, s, e) => {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b.subarray(s, e));
    return Buffer.from(b.subarray(s, e)).toString('utf8');
  };
  const toBytes = (x) => (x instanceof Uint8Array ? x : (x && x.byteLength !== undefined ? new Uint8Array(x.buffer ? x.buffer : x, x.byteOffset || 0, x.byteLength) : new Uint8Array(0)));
  /** 초기화 조각(moov)에서 시간 단위·기본 샘플 길이·자막 형식(wvtt/stpp) */
  function parseMp4Init(init) {
    const b = toBytes(init);
    const out = { timescale: 0, defaultDuration: 0, codec: '' };
    if (!b.length) return out;
    const top = mp4Boxes(b, 0, b.length);
    const mdhd = findBox(b, top, ['moov', 'trak', 'mdia', 'mdhd']);
    if (mdhd) out.timescale = b[mdhd.data] === 1 ? u32(b, mdhd.data + 20) : u32(b, mdhd.data + 12);
    const trex = findBox(b, top, ['moov', 'mvex', 'trex']);
    if (trex) out.defaultDuration = u32(b, trex.data + 12);
    const stsd = findBox(b, top, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    if (stsd) { const e = mp4Boxes(b, stsd.data + 8, stsd.end)[0]; if (e) out.codec = e.type; }
    return out;
  }
  /** 미디어 조각 하나 → 샘플 [{ t(틱), d(틱), bytes }] */
  function mp4Samples(seg, defaultDuration) {
    const b = toBytes(seg);
    const out = [];
    const top = mp4Boxes(b, 0, b.length);
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== 'moof') continue;
      const moof = top[i];
      const mdat = top.slice(i + 1).find((x) => x.type === 'mdat');
      for (const traf of mp4Boxes(b, moof.data, moof.end).filter((x) => x.type === 'traf')) {
        const kids = mp4Boxes(b, traf.data, traf.end);
        const tfhd = kids.find((x) => x.type === 'tfhd'), tfdt = kids.find((x) => x.type === 'tfdt');
        let base = moof.start, defDur = defaultDuration || 0, defSize = 0;
        if (tfhd) {
          const fl = u32(b, tfhd.data) & 0xffffff;
          let o = tfhd.data + 8;
          if (fl & 0x01) { base = u64(b, o); o += 8; }
          if (fl & 0x02) o += 4;
          if (fl & 0x08) { defDur = u32(b, o); o += 4; }
          if (fl & 0x10) { defSize = u32(b, o); o += 4; }
        }
        let t = tfdt ? (b[tfdt.data] === 1 ? u64(b, tfdt.data + 4) : u32(b, tfdt.data + 4)) : 0;
        for (const trun of kids.filter((x) => x.type === 'trun')) {
          const fl = u32(b, trun.data) & 0xffffff;
          const n = u32(b, trun.data + 4);
          let o = trun.data + 8;
          let pos = mdat ? mdat.data : 0;
          if (fl & 0x01) { pos = base + s32(b, o); o += 4; }
          if (fl & 0x04) o += 4;
          for (let k = 0; k < n && k < 100000; k++) {
            let d = defDur, size = defSize;
            if (fl & 0x100) { d = u32(b, o); o += 4; }
            if (fl & 0x200) { size = u32(b, o); o += 4; }
            if (fl & 0x400) o += 4;
            if (fl & 0x800) o += 4;
            if (pos + size > b.length) break;
            out.push({ t, d, bytes: b.subarray(pos, pos + size) });
            pos += size; t += d;
          }
        }
      }
    }
    return out;
  }
  /**
   * DASH 의 MP4 자막 조각들(wvtt: WebVTT-in-MP4, stpp: TTML-in-MP4) → 큐 [{start, end, text}] (미디어 시각 ms).
   * 같은 대사가 여러 샘플·조각에 걸쳐 나뉘어 있으면(다른 대사가 겹쳐 시작할 때마다 나뉜다) 하나로 잇는다
   */
  function parseMp4Text(segments, init, opts) {
    const o = opts || {};
    const info = parseMp4Init(init);
    const ts = info.timescale || o.timescale || 1000;
    const codec = String(info.codec || o.codecs || '').toLowerCase();
    const raw = [];
    for (const seg of segments || []) {
      for (const s of mp4Samples(seg, info.defaultDuration)) {
        const start = (s.t / ts) * 1000, end = ((s.t + s.d) / ts) * 1000;
        if (!s.bytes.length) continue;
        if (codec.startsWith('stpp') || (!codec.startsWith('wvtt') && /^\s*<\?xml|^\s*<tt/.test(utf8(s.bytes, 0, Math.min(64, s.bytes.length))))) {
          const r = parseTTML(utf8(s.bytes, 0, s.bytes.length));
          // TTML 시각은 대개 미디어 시각 그대로지만, 샘플 기준(0부터)인 경우도 있다 → 샘플 구간 밖이면 샘플 시작을 더한다
          const absolute = r.cues.every((c) => c.start >= start - 1000 && c.start <= end + 1000);
          for (const c of r.cues) raw.push({ start: absolute ? c.start : c.start + start, end: absolute ? c.end : c.end + start, text: c.text });
          continue;
        }
        for (const box of mp4Boxes(s.bytes, 0, s.bytes.length)) {
          if (box.type !== 'vttc') continue;
          const payl = mp4Boxes(s.bytes, box.data, box.end).find((x) => x.type === 'payl');
          if (!payl) continue;
          const text = cleanCueText(utf8(s.bytes, payl.data, payl.end));
          if (text) raw.push({ start, end, text });
        }
      }
    }
    return mergeSplitCues(raw);
  }
  /** 바로 이어지는(40ms 안) 같은 글의 큐를 하나로 */
  function mergeSplitCues(cues) {
    const sorted = (cues || []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    const open = new Map(); // 글 → 마지막 큐
    for (const c of sorted) {
      const prev = open.get(c.text);
      if (prev && c.start <= prev.end + 40) { prev.end = Math.max(prev.end, c.end); continue; }
      const n = { start: c.start, end: c.end, text: c.text };
      out.push(n);
      open.set(c.text, n);
    }
    return out;
  }

  return {
    decodeEntities, cleanCueText, parseVttTime, parseTtmlTime, parseVTT, parseTTML, parseJson3, parseAny, parseSegments,
    finalizeCues, findCueIndex, lastStartedIndex, nextStartingIndex, mergeTranslations,
    normalizeForCompare, diffWords, formatTime, parseM3U8,
    parseXml, parseIsoDuration, parseMPD, presToContent, contentToPres, parseMp4Init, parseMp4Text, mergeSplitCues,
  };
});
