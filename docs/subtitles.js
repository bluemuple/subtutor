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

  /** 포맷을 추측해서 파싱. 반환: {cues, tsOffsetMs, hasTimestampMap, lang, format} */
  function parseAny(text, hint) {
    const s = String(text || '').replace(/^﻿/, '').trimStart();
    const h = (hint || '').toLowerCase();
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

  return {
    decodeEntities, cleanCueText, parseVttTime, parseTtmlTime, parseVTT, parseTTML, parseAny, parseSegments,
    finalizeCues, findCueIndex, lastStartedIndex, nextStartingIndex, mergeTranslations,
    normalizeForCompare, diffWords, formatTime, parseM3U8,
  };
});
