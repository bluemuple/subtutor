/*
 * SubTutor – 백그라운드 서비스 워커
 * 저장한 자막(items) 관리, 기계 번역(캐시), 플레이어 탭 찾기/열기, 웹사이트 ↔ 플레이어 원격 재생 중계.
 */
import './lib/fs.js';
import './lib/sites.js';
const FS = globalThis.SubTutorFS;
const Sites = globalThis.SubTutorSites;
const SITE_URL = 'https://bluemuple.github.io/subtutor/';
const DEFAULT_SETTINGS = {
  showTranslation: true, translationSource: 'auto', hideNative: true, overlay: true, panelOpen: true,
  fontScale: 100, autoPause: false, shadowing: false, shadowPauseSec: 2, shadowPauseMode: 'ratio', shadowPauseRatio: 1, dubPlayback: true, dubRecRate: 1, dubListenFirst: false, dubAutoPreview: false, dubAutoNext: false, dubFeedback: true, wordSort: 'hard', leadMs: 150, tailMs: 200, audioMode: 'off', saveSentence: true, savePick: true, saveTailSec: 4, saveNextTexts: true, recAuto: false, enabled: {},
  audioDirName: '', // 사용자가 고른 오디오 저장 폴더 이름 (핸들은 IndexedDB). 비어 있으면 다운로드 폴더
  koMode: 'hold', koRepeats: 3, secondPass: false, cloze: 'off', soundsLike: false, kiwiNotes: true, nzNotes: true, vocabProfile: true, missedTag: '못 알아들음',
  web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true, dubRecRates: [0.5, 0.7, 1], fastRates: [1, 1.25, 1.5, 1] },
};
// ───────── 학습 통계 (에피소드별 이해율·말 속도, 시리즈 어휘 재출현, 받아쓰기 약점 단어, 복습 기록) ─────────
async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  const st = stats && typeof stats === 'object' ? stats : {};
  st.episodes = st.episodes || {}; st.series = st.series || {}; st.weak = st.weak || {}; st.reviews = Array.isArray(st.reviews) ? st.reviews : [];
  return st;
}
let statsChain = Promise.resolve();
function withStats(fn) {
  const run = statsChain.then(async () => { const st = await getStats(); const r = await fn(st); await chrome.storage.local.set({ stats: st }); return r; });
  statsChain = run.catch(() => {});
  return run;
}
const PLATFORM_URL_PATTERNS = {
  netflix: ['https://www.netflix.com/watch/*'],
  youtube: ['https://www.youtube.com/watch*'],
  prime: ['https://www.primevideo.com/*', 'https://*.amazon.com/*', 'https://*.amazon.co.uk/*', 'https://*.amazon.co.jp/*', 'https://*.amazon.de/*', 'https://*.amazon.com.au/*'],
  disney: ['https://www.disneyplus.com/*'],
};
// 범용 사이트(TVNZ+ 등)와 사용자가 켠 사이트의 주소 패턴은 sites.js 에서
const urlPatternsFor = (platform) => PLATFORM_URL_PATTERNS[platform] || ((Sites && Sites.byKey(platform)) || {}).patterns || [];

// ───────── 저장소 ─────────
async function getItems() {
  const { items } = await chrome.storage.local.get('items');
  return Array.isArray(items) ? items : [];
}
let itemsChain = Promise.resolve();
function withItems(fn) {
  const run = itemsChain.then(async () => {
    const items = await getItems();
    const r = await fn(items);
    if (r && r.write) { await chrome.storage.local.set({ items: r.items }); noteDataChange(); }
    return r ? r.result : undefined;
  });
  itemsChain = run.catch(() => {});
  return run;
}
// ───────── 단어장: 플레이어 패널의 단어 목록에서 ☆ 로 저장 → 웹에서 카드로 복습 ─────────
// 카드 { word, meaning, sentence, sentenceKo, source{platform,videoId,title,episode,startMs}, savedAt, review{level,due,reps,lapses,last} }
async function getWords() {
  const { words } = await chrome.storage.local.get('words');
  return Array.isArray(words) ? words : [];
}
let wordsChain = Promise.resolve();
function withWords(fn) {
  const run = wordsChain.then(async () => {
    const words = await getWords();
    const r = await fn(words);
    if (r && r.write) { await chrome.storage.local.set({ words: r.words }); noteDataChange(); }
    return r ? r.result : undefined;
  });
  wordsChain = run.catch(() => {});
  return run;
}
const wordKey = (w) => String(w || '').toLowerCase().trim().slice(0, 60);
// 망각 곡선을 따라 간격을 늘린다: 알고 있어요 → 1·3·7·14·30·60·120일 뒤, 잘 모름 → 10분 뒤 다시(그 뒤 1일부터 다시 늘림)
const WORD_STEPS_DAYS = [1, 3, 7, 14, 30, 60, 120];
function reviewWord(card, result, now) {
  const r = Object.assign({ level: 0, due: now, reps: 0, lapses: 0 }, card.review || {});
  r.reps++; r.last = now;
  if (result === 'know') { r.level = Math.min(WORD_STEPS_DAYS.length, r.level + 1); r.due = now + WORD_STEPS_DAYS[r.level - 1] * 86400000; }
  else { r.level = 0; r.lapses++; r.due = now + 10 * 60000; }
  return r;
}
// 단어 뜻(기계 번역): 40개씩 줄바꿈으로 묶어 한 번에 번역하고, 줄 수가 어긋나면 그 묶음만 하나씩. 번역 캐시(mt.cache)를 같이 쓴다
async function translateWords(words) {
  await loadCache();
  const list = words.map((w) => String(w).slice(0, 60));
  const out = list.map((w) => mt.cache['ko:' + w] || '');
  const misses = list.map((w, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
  if (!misses.length) return { meanings: out };
  if (Date.now() < mt.backoffUntil) return { meanings: out, error: '번역 요청이 잠시 제한되었습니다. 1분 뒤 다시 시도하세요.' };
  for (let k = 0; k < misses.length; k += 40) {
    const idx = misses.slice(k, k + 40);
    let parts = null;
    try {
      const lines = (await translateOne(idx.map((i) => list[i]).join('\n'), 'en', 'ko')).split('\n').map((x) => x.trim());
      if (lines.length === idx.length) parts = lines;
    } catch (e) { if (Date.now() < mt.backoffUntil) break; }
    if (!parts) {
      parts = [];
      for (const i of idx) {
        try { parts.push(await translateOne(list[i], 'en', 'ko')); } catch (e) { parts.push(''); if (Date.now() < mt.backoffUntil) break; }
      }
    }
    idx.forEach((i, n) => { const m = String(parts[n] || '').trim(); if (m) { out[i] = m; mt.cache['ko:' + list[i]] = m; } });
    scheduleCacheSave();
  }
  return { meanings: out };
}
async function saveWordCard(card) {
  const key = wordKey(card && card.word);
  if (!key) return { ok: false, error: '단어가 비었습니다' };
  return withWords((words) => {
    const i = words.findIndex((w) => wordKey(w.word) === key);
    const now = Date.now();
    const base = { word: key, meaning: String(card.meaning || '').slice(0, 200), sentence: String(card.sentence || '').slice(0, 400), sentenceKo: String(card.sentenceKo || '').slice(0, 400), source: card.source || null };
    if (i >= 0) { words[i] = Object.assign({}, words[i], base, { meaning: base.meaning || words[i].meaning }); return { write: true, words, result: { ok: true, existed: true } }; }
    words.push(Object.assign(base, { savedAt: now, review: { level: 0, due: now, reps: 0, lapses: 0 } }));
    return { write: true, words, result: { ok: true, count: words.length } };
  });
}
let settingsChain = Promise.resolve();
function withSettings(fn) { const p = settingsChain.then(fn); settingsChain = p.catch(() => {}); return p; }
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}
async function sessionGet(key) {
  try { const r = await chrome.storage.session.get(key); return r[key]; } catch (e) { return undefined; }
}
async function sessionSet(obj) {
  try { await chrome.storage.session.set(obj); } catch (e) { /* ignore */ }
}

// ───────── 기계 번역 (Google 번역 비공식 엔드포인트, 로컬 캐시) ─────────
const mt = { cache: null, loaded: null, saveTimer: null, backoffUntil: 0 };
function loadCache() {
  if (!mt.loaded) mt.loaded = chrome.storage.local.get('mtCache').then(({ mtCache }) => { mt.cache = mtCache && typeof mtCache === 'object' ? mtCache : {}; });
  return mt.loaded;
}
function scheduleCacheSave() {
  clearTimeout(mt.saveTimer);
  mt.saveTimer = setTimeout(async () => {
    const keys = Object.keys(mt.cache);
    if (keys.length > 8000) keys.slice(0, keys.length - 6000).forEach((k) => delete mt.cache[k]);
    await chrome.storage.local.set({ mtCache: mt.cache });
  }, 1500);
}
function parseTranslateResponse(data) {
  if (Array.isArray(data)) {
    if (Array.isArray(data[0]) && Array.isArray(data[0][0])) return data[0].map((s) => (s && s[0]) || '').join('');
    if (typeof data[0] === 'string') return data[0];
    if (Array.isArray(data[0]) && typeof data[0][0] === 'string') return data[0][0];
  }
  if (data && typeof data === 'object' && typeof data.sentences === 'object' && Array.isArray(data.sentences)) return data.sentences.map((s) => s.trans || '').join('');
  return '';
}
async function translateOne(text, from, to) {
  const q = encodeURIComponent(text);
  const urls = [
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + from + '&tl=' + to + '&dt=t&q=' + q,
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + from + '&tl=' + to + '&q=' + q,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 403) { mt.backoffUntil = Date.now() + 60000; throw new Error('번역 요청이 잠시 제한되었습니다 (' + res.status + ')'); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = parseTranslateResponse(await res.json()).trim();
      if (out) return out;
      throw new Error('empty');
    } catch (e) { lastErr = e; if (Date.now() < mt.backoffUntil) break; }
  }
  throw lastErr || new Error('translate failed');
}
async function translateTexts(texts, from, to) {
  await loadCache();
  const out = new Array(texts.length).fill('');
  const misses = [];
  texts.forEach((t, i) => {
    const key = to + ':' + t;
    if (mt.cache[key]) out[i] = mt.cache[key]; else misses.push(i);
  });
  if (!misses.length) return { translations: out };
  if (Date.now() < mt.backoffUntil) return { translations: out, error: '번역 요청이 잠시 제한되었습니다. 1분 뒤 다시 시도합니다.' };
  let k = 0;
  let firstErr = null;
  await Promise.all([0, 1, 2].map(async () => {
    while (k < misses.length) {
      const i = misses[k++];
      try {
        const r = await translateOne(texts[i], from, to);
        out[i] = r; mt.cache[to + ':' + texts[i]] = r; scheduleCacheSave();
      } catch (e) {
        firstErr = firstErr || e;
        if (Date.now() < mt.backoffUntil) return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }));
  const res = { translations: out };
  if (firstErr && out.every((t, i) => t || !misses.includes(i))) { /* 일부만 실패 */ }
  if (firstErr && misses.some((i) => !out[i])) res.partialError = String(firstErr.message || firstErr);
  return res;
}

// ───────── 플레이어 탭 ─────────
async function getRegistry() { return (await sessionGet('players')) || {}; }
async function setRegistry(players) { await sessionSet({ players }); }
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const reg = await getRegistry();
  if (reg[tabId]) { delete reg[tabId]; await setRegistry(reg); }
  const clip = await currentClip();
  if (clip && (clip.tabId === tabId || clip.websiteTabId === tabId)) await setActiveClip(null);
});

function videoIdFromUrl(platform, url) {
  if (Sites && Sites.byKey(platform)) return Sites.videoIdFor(platform, url);
  try {
    const u = new URL(url);
    let m = null;
    if (platform === 'netflix') m = /\/watch\/(\d+)/.exec(u.pathname);
    else if (platform === 'disney') m = /\/(?:play|video)\/([^/?#]+)/.exec(u.pathname);
    else if (platform === 'prime') m = /\/(?:detail|gp\/video\/detail)\/([A-Z0-9]{8,})/i.exec(u.pathname);
    else if (platform === 'youtube') return u.pathname === '/watch' ? u.searchParams.get('v') : null;
    return m ? m[1] : null;
  } catch (e) { return null; }
}
function watchUrl(item) {
  if (item.platform === 'netflix') return 'https://www.netflix.com/watch/' + item.videoId + '?t=' + Math.max(0, Math.floor((item.startMs || 0) / 1000));
  if (item.platform === 'youtube') return 'https://www.youtube.com/watch?v=' + item.videoId + '&t=' + Math.max(0, Math.floor((item.startMs || 0) / 1000)) + 's';
  if (item.platform === 'disney') return item.url || ('https://www.disneyplus.com/play/' + item.videoId);
  return item.url;
}
async function tabAlive(tabId) { try { await chrome.tabs.get(tabId); return true; } catch (e) { return false; } }
async function findPlayerTab(item) {
  const reg = await getRegistry();
  for (const [tabId, info] of Object.entries(reg)) {
    if (info.platform === item.platform && String(info.videoId) === String(item.videoId) && await tabAlive(+tabId)) return { tabId: +tabId, same: true };
  }
  const patterns = urlPatternsFor(item.platform);
  const tabs = patterns.length ? await chrome.tabs.query({ url: patterns }) : [];
  const same = tabs.find((t) => videoIdFromUrl(item.platform, t.url || '') === String(item.videoId));
  if (same) return { tabId: same.id, same: true };
  const registered = tabs.find((t) => reg[t.id] && reg[t.id].platform === item.platform);
  if (registered) return { tabId: registered.id, same: false };
  if (tabs.length) return { tabId: tabs[0].id, same: false };
  return null;
}
async function ensurePlayerTab(item, focus) {
  const found = await findPlayerTab(item);
  const url = watchUrl(item);
  if (!url) throw new Error('이 항목에는 열 수 있는 주소가 없습니다');
  let tabId;
  if (found && found.same) tabId = found.tabId;
  else if (found) { await chrome.tabs.update(found.tabId, { url }); tabId = found.tabId; }
  else { const tab = await chrome.tabs.create({ url, active: !!focus }); tabId = tab.id; }
  if (focus) {
    try { const tab = await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { /* ignore */ }
  }
  return tabId;
}
async function tabStatus(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'status' }); } catch (e) { return null; }
}
async function waitForReady(tabId, item, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 45000)) {
    const s = await tabStatus(tabId);
    if (s && s.ready && s.platform === item.platform && String(s.videoId) === String(item.videoId)) return s;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

// ───────── 원격 재생 ─────────
let activeClipMem = null;
async function currentClip() { return activeClipMem || (await sessionGet('activeClip')) || null; }
async function setActiveClip(clip) { activeClipMem = clip; await sessionSet({ activeClip: clip }); }
function notifyWeb(tabId, payload) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'web.event', event: 'clip.state', payload }).catch(() => {});
}
async function playClip(item, websiteTabId, loop, rate) {
  const prev = await currentClip();
  if (prev && prev.tabId) { try { await chrome.tabs.sendMessage(prev.tabId, { type: 'stopClip' }); } catch (e) { /* ignore */ } }
  const clipId = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const clip = { clipId, tabId: null, websiteTabId, itemId: item.id };
  await setActiveClip(clip);
  notifyWeb(websiteTabId, { itemId: item.id, clipId, state: 'opening' });
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    const tabId = await ensurePlayerTab(item, false);
    const cur = await currentClip();
    if (!cur || cur.clipId !== clipId) return { clipId, cancelled: true };
    clip.tabId = tabId;
    await setActiveClip(clip);
    const s = await waitForReady(tabId, item);
    const cur2 = await currentClip();
    if (!cur2 || cur2.clipId !== clipId) return { clipId, cancelled: true };
    if (!s) {
      const other = await tabStatus(tabId);
      const msg = other && other.ready && String(other.videoId) !== String(item.videoId)
        ? '플레이어 탭에 다른 영상이 열려 있습니다. 저장한 자막의 영상(' + (item.title || item.videoId) + (item.episode ? ' ' + item.episode : '') + ')을 재생한 뒤 다시 시도하세요.'
        : '플레이어가 준비되지 않았습니다. 플레이어 탭에서 영상이 재생되는지(프로필 선택 등) 확인하세요.';
      notifyWeb(websiteTabId, { itemId: item.id, clipId, state: 'error', message: msg });
      await setActiveClip(null);
      return { clipId, error: 'not-ready' };
    }
    const range = item.trim && Number.isFinite(item.trim.startMs) && Number.isFinite(item.trim.endMs) && item.trim.endMs > item.trim.startMs ? item.trim : item; // 웹에서 조정한 구간
    await chrome.tabs.sendMessage(tabId, { type: 'playRange', clipId, startMs: range.startMs, endMs: range.endMs, loop: !!loop, rate: Number.isFinite(rate) && rate > 0 ? rate : 0 });
    return { clipId };
  } catch (e) {
    notifyWeb(websiteTabId, { itemId: item.id, clipId, state: 'error', message: String((e && e.message) || e) });
    await setActiveClip(null);
    return { clipId, error: String(e) };
  } finally {
    clearInterval(keepAlive);
  }
}

async function openSite() {
  const tabs = await chrome.tabs.query({ url: SITE_URL + '*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (e) { /* ignore */ }
  } else {
    await chrome.tabs.create({ url: SITE_URL });
  }
}

// ───────── 오디오 (별표 저장 시 캡처한 WAV) ─────────
const audioKey = (id) => 'audio:' + id;
async function saveAudio(msg) {
  const out = { ok: true };
  const mode = msg.mode === 'both' ? 'download' : (msg.mode || 'store'); // 'both'(예전 값)는 'PC 파일'과 같다
  const fileName = String(msg.fileName || 'SubTutor/clip.mp3').replace(/^\/+/, '');
  const ext = (fileName.split('.').pop() || 'mp3').toLowerCase();
  const leadMs = Number.isFinite(msg.leadMs) ? msg.leadMs : 250;
  // MP3 는 하나만 만든다.
  //  - '보관': 확장 프로그램 안에 작은 MP3(32kHz 64kbps) 하나. 폴더 권한이 필요 없다
  //  - 'PC 파일': 지정 폴더에 MP3 하나. 웹은 재생할 때 그 파일을 읽으므로 복사본을 따로 두지 않는다
  //    (크롬 다운로드 폴더로 떨어진 경우에만 예외: 확장 프로그램이 그 폴더를 읽을 수 없어 웹 재생용 복사본을 함께 둔다)
  const storeCopy = async (data, meta) => {
    await chrome.storage.local.set({ [audioKey(msg.id)]: data });
    await withItems((items) => updateItem(items, msg.id, { audio: Object.assign({ ms: msg.durationMs || 0, leadMs, savedAt: Date.now(), stats: msg.stats || null }, meta) }));
    out.stored = true;
  };
  if (mode === 'store' && msg.store) {
    await storeCopy(msg.store, { format: msg.storeFormat || 'wav', mime: msg.storeMime || 'audio/wav', rate: msg.storeRate || 16000, sameAsFile: false });
    await withItems((items) => updateItem(items, msg.id, { file: null }));
  }
  if (mode === 'download' && msg.download) {
    // 1) 사용자가 고른 폴더가 있고 권한이 살아 있으면 그 폴더 안에 바로 쓴다 — 파일 하나로 끝
    const folder = await saveToFolder(fileName, msg.download);
    if (folder.ok) {
      out.fileName = folder.path; out.location = 'folder';
      await removeAudio([msg.id]); // 예전에 두었던 복사본이 있으면 지운다
      await withItems((items) => updateItem(items, msg.id, { audio: null, file: { format: ext, location: 'folder', path: folder.path, leadMs, savedAt: Date.now() } }));
      return out;
    }
    if (folder.reason && folder.reason !== 'none') { out.folderIssue = folder.reason === 'error' ? 'error' : 'prompt'; out.folderError = folder.error || ''; out.folderName = folder.name || ''; }
    // 2) 아니면 크롬 다운로드 폴더(Downloads/SubTutor/…). 다운로드 id 를 기록해 두면 나중에 삭제할 때 찾기 쉽다
    try {
      out.downloadId = await chrome.downloads.download({ url: 'data:' + (msg.downloadMime || 'audio/wav') + ';base64,' + msg.download, filename: fileName, conflictAction: 'uniquify', saveAs: false });
      out.fileName = fileName; out.location = 'downloads';
      await withItems((items) => updateItem(items, msg.id, { file: { format: ext, location: 'downloads', path: '다운로드/' + fileName, downloadId: out.downloadId, leadMs, savedAt: Date.now() } }));
      // 다운로드 폴더는 확장 프로그램이 다시 읽을 수 없으므로, 웹에서 재생할 수 있도록 복사본을 함께 둔다
      if (msg.store) { await storeCopy(msg.store, { format: msg.storeFormat || 'wav', mime: msg.storeMime || 'audio/wav', rate: msg.storeRate || 16000, sameAsFile: false, source: 'downloads-fallback' }); out.webCopy = true; }
    } catch (e) {
      throw new Error('파일 다운로드 실패: ' + ((e && e.message) || e));
    }
  }
  return out;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function saveToFolder(relPath, b64) {
  if (!FS) return { ok: false, reason: 'none' };
  try {
    const st = await FS.status();
    if (st.state === 'none') return { ok: false, reason: 'none' };
    if (st.state !== 'granted') return { ok: false, reason: st.state, name: st.name };
    return await FS.writeFile(relPath, base64ToBytes(b64));
  } catch (e) {
    return { ok: false, reason: 'error', error: String((e && e.message) || e) };
  }
}
async function audioDirStatus() {
  if (!FS) return { state: 'none' };
  const st = await FS.status();
  return { state: st.state, name: st.name || '' };
}
async function getAudio(id) {
  const r = await chrome.storage.local.get(audioKey(id));
  const data = r[audioKey(id)] || null;
  if (!data) return { data: null, mime: null };
  const item = (await getItems()).find((i) => i.id === id);
  const mime = (item && item.audio && item.audio.mime) || (data.startsWith('UklGR') ? 'audio/wav' : 'audio/mpeg'); // 'UklGR' = base64("RIFF")
  return { data, mime, wav: mime === 'audio/wav' ? data : null };
}
async function removeAudio(ids) {
  const keys = ids.map(audioKey);
  if (keys.length) await chrome.storage.local.remove(keys);
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// 웹 재생용 복사본 넣기 (지정 폴더에서 읽었거나 웹에서 MP3 폴더를 골라 가져온 파일)
async function putAudio(p) {
  if (!p || !p.itemId || !p.data) throw new Error('오디오 데이터가 없습니다');
  await chrome.storage.local.set({ [audioKey(p.itemId)]: p.data });
  await withItems((items) => updateItem(items, p.itemId, { audio: { format: p.format || 'mp3', mime: p.mime || 'audio/mpeg', rate: p.rate || 0, ms: p.ms || 0, leadMs: Number.isFinite(p.leadMs) ? p.leadMs : 250, savedAt: Date.now(), stats: null, sameAsFile: true, source: p.source || 'import' } }));
  return { ok: true };
}
// PC 파일(MP3)만 있고 웹 재생용 복사본이 없는 예전 항목: 지정 폴더에서 읽어 복사본을 만든다. 다운로드 폴더는 확장 프로그램이 읽을 수 없다
async function audioFromFile(id) {
  const item = (await getItems()).find((i) => i.id === id);
  if (!item || !item.file || !item.file.path) return { data: null, reason: 'no-file' };
  if (item.file.location !== 'folder') return { data: null, reason: 'downloads', path: item.file.path };
  let r;
  try { r = await FS.readFile(item.file.path); } catch (e) { r = { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
  if (!r.ok) return { data: null, reason: r.reason || 'error', error: r.error || '', path: item.file.path, folder: r.name || '' };
  // 복사본을 만들지 않고 바이트만 돌려준다 (MP3 는 폴더의 파일 하나뿐). 웹이 이번 세션 동안만 기억해 두고 쓴다
  return { data: bytesToBase64(r.bytes), mime: item.file.format === 'wav' ? 'audio/wav' : 'audio/mpeg', path: r.path, leadMs: Number.isFinite(item.file.leadMs) ? item.file.leadMs : 250, cache: 'memory' };
}
// 다운로드 폴더에 저장한 파일: 크롬 다운로드 기록에서 찾아 지운다 (기록이 지워졌으면 못 찾는다)
async function removeDownload(file) {
  if (!chrome.downloads) return { ok: false, reason: 'no-downloads-api' };
  const rel = String(file.path || '').replace(/^다운로드\//, '');
  const base = rel.split('/').pop() || '';
  const stem = base.replace(/\.[^.]+$/, '');
  const unify = (n) => n.replace(/ \(\d+\)(\.[^.]+)$/, '$1'); // 크롬이 같은 이름에 붙이는 " (1)"
  const baseOf = (f) => String(f || '').replace(/\\/g, '/').split('/').pop();
  let found = [];
  if (file.downloadId) { try { found = await chrome.downloads.search({ id: file.downloadId }); } catch (e) { found = []; } }
  if (!found.length && stem) { try { found = (await chrome.downloads.search({ query: [stem] })).filter((d) => unify(baseOf(d.filename)) === base); } catch (e) { found = []; } }
  const d = found.find((x) => x.state === 'complete' && x.exists !== false);
  if (!d) return { ok: false, reason: found.length ? 'file-gone' : 'not-found' };
  await chrome.downloads.removeFile(d.id);
  try { await chrome.downloads.erase({ id: d.id }); } catch (e) { /* ignore */ }
  return { ok: true };
}
// 항목 삭제: 보관 오디오와 PC 파일(지정 폴더는 바로, 다운로드 폴더는 크롬 다운로드 기록으로)도 함께 지운다
async function removeItems(ids) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  const victims = (await getItems()).filter((i) => set.has(i.id));
  await removeAudio(victims.map((i) => i.id));
  const files = { deleted: 0, failed: [] };
  for (const it of victims) {
    if (!it.file || !it.file.path) continue;
    let r;
    try { r = it.file.location === 'folder' ? await FS.removeFile(it.file.path) : await removeDownload(it.file); }
    catch (e) { r = { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
    if (r && r.ok) files.deleted++; else files.failed.push({ id: it.id, path: it.file.path, reason: (r && r.reason) || 'error', error: (r && r.error) || '' });
  }
  await withItems((items) => ({ write: true, items: items.filter((i) => !set.has(i.id)), result: { ok: true } }));
  return { ok: true, removed: victims.length, files };
}

// ───────── 탭 오디오 캡처 (offscreen 문서 중계) ─────────
let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('이 크롬은 offscreen 문서를 지원하지 않습니다 (크롬 109 이상 필요)');
  const url = chrome.runtime.getURL('offscreen/capture.html');
  let has = false;
  try { has = typeof chrome.offscreen.hasDocument === 'function' ? await chrome.offscreen.hasDocument() : false; } catch (e) { has = false; }
  if (has) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({ url, reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'], justification: '탭 오디오를 녹음해 저장한 대사의 구간을 MP3 로 만들고, 녹음 중에도 소리가 들리도록 재생합니다' })
      .catch((e) => { if (!/single offscreen|already exists|only a single/i.test(String(e && e.message || e))) throw e; })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}
async function offscreenCall(msg, tries) {
  await ensureOffscreen();
  let lastErr = null;
  for (let i = 0; i < (tries || 6); i++) {
    try {
      const r = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
      if (r !== undefined) return r;
      lastErr = new Error('offscreen 문서가 응답하지 않습니다');
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr || new Error('offscreen 호출 실패');
}
async function captureStart(msg, tabId) {
  let streamId = null;
  if (msg.test !== 'sweep') {
    if (!Number.isInteger(tabId)) throw new Error('플레이어 탭을 알 수 없습니다');
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/not been invoked|activeTab|invoked|permission/i.test(m)) return { ok: false, unavailable: 'grant', error: m, shortcut: await saveShortcut() };
      throw e;
    }
    if (!streamId) return { ok: false, unavailable: 'grant', error: 'no stream id', shortcut: await saveShortcut() };
  }
  return offscreenCall({ cmd: 'start', streamId, limitMs: msg.limitMs, test: msg.test });
}
// ───────── 영상 오디오 통째 MP3 (offscreen 이 눌러 담고, 여기서 파일로) ─────────
let recState = null;            // { tabId, title, startedAt }
const recParts = new Map();     // recId → base64 조각 (6MB = 3의 배수 바이트라 그대로 이어 붙인다)
async function recStart(msg, tabId) {
  let streamId = null;
  if (msg.test !== 'sweep') {
    if (!Number.isInteger(tabId)) throw new Error('플레이어 탭을 알 수 없습니다');
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/not been invoked|activeTab|invoked|permission/i.test(m)) return { ok: false, unavailable: 'grant', error: m, shortcut: await saveShortcut(), recShortcut: await commandShortcut('rec-episode') };
      throw e;
    }
    if (!streamId) return { ok: false, unavailable: 'grant', error: 'no stream id', shortcut: await saveShortcut(), recShortcut: await commandShortcut('rec-episode') };
  }
  const r = await offscreenCall({ cmd: 'recStart', streamId, test: msg.test });
  if (r && r.ok) recState = { tabId, title: msg.title || '', startedAt: r.startedAt || Date.now() };
  return r;
}
async function recSave(meta) {
  const parts = recParts.get(meta.recId) || [];
  recParts.delete(meta.recId);
  if (!parts.length) return { ok: false, error: '받은 오디오 조각이 없습니다' };
  const safe = (x) => String(x || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '영상 오디오';
  const title = safe(recState && recState.title);
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + '.' + two(d.getMinutes());
  const fileName = 'SubTutor/영상 오디오/' + title + ' ' + stamp + '.mp3';
  const b64 = parts.join('');
  recState = null;
  const out = { ok: true, fileName, durMs: meta.durMs || 0, skippedMs: meta.skippedMs || 0, bytes: meta.bytes || 0, reason: meta.reason || '' };
  const recId = 'r' + Date.now().toString(36);
  let opfs = false;
  const folder = await saveToFolder(fileName, b64);
  if (folder.ok) { out.location = 'folder'; out.fileName = folder.path; }
  else {
    try {
      out.downloadId = await chrome.downloads.download({ url: 'data:audio/mpeg;base64,' + b64, filename: fileName, conflictAction: 'uniquify', saveAs: false });
      out.location = 'downloads';
    } catch (e) {
      return { ok: false, error: '파일 저장 실패: ' + ((e && e.message) || e) };
    }
    // 다운로드 폴더는 확장 프로그램이 다시 읽지 못한다 — 아이폰으로 올릴 수 있게 자기 저장소(OPFS)에 복사본을 둔다
    try {
      await offscreenCall({ cmd: 'recStoreOpen', recId }, 2);
      for (const part of parts) await offscreenCall({ cmd: 'recStorePart', recId, data: part }, 2);
      await offscreenCall({ cmd: 'recStoreClose', recId }, 2);
      opfs = true;
    } catch (e) { out.copyError = String((e && e.message) || e); }
  }
  // 녹음 목록에 적어 둔다 — 웹(설정 › 서버 소리 관리)이 읽어 Supabase 로 올리고, 아이폰이 내려받는다
  const recs = await getRecs();
  recs.push({ id: recId, title, at: Date.now(), durMs: out.durMs, bytes: out.bytes,
    file: { location: out.location, path: out.fileName, downloadId: out.downloadId || 0, opfs }, sent: 0, skip: false });
  await setRecs(recs);
  return out;
}
// ── 영상 오디오 녹음 목록 (chrome.storage) + 웹 브리지 ──
async function getRecs() { return ((await chrome.storage.local.get('recordings')).recordings) || []; }
async function setRecs(recs) { await chrome.storage.local.set({ recordings: recs.slice(-200) }); }
function bytesToB64(bytes) {
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(out);
}
// ───────── 호출(단축키·우클릭 메뉴) ─────────
// 탭 오디오 캡처는 사용자가 이 탭에서 확장 프로그램을 '호출'해야 허용된다(activeTab, 크롬 규칙). 팝업(아이콘) 말고도 크롬 명령 단축키와 우클릭 메뉴가 같은 효과를 낸다
async function commandShortcut(name) {
  try { const c = (await chrome.commands.getAll()).find((x) => x.name === name); return (c && c.shortcut) || ''; } catch (e) { return ''; }
}
const saveShortcut = () => commandShortcut('save-cue');
async function invokeOnTab(tab, source, action) {
  if (!tab || !Number.isInteger(tab.id)) return { ok: false, error: '탭 없음' };
  const shortcut = await saveShortcut();
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'invoke', source: source || 'command', shortcut, action: action || '' }); } catch (e) { return { ok: false, error: '이 탭에서는 SubTutor가 실행 중이 아닙니다' }; }
}
globalThis.__subtutorInvoke = invokeOnTab; // 테스트용
// Alt+E: 지금 자막 저장 · Alt+R: 영상 오디오 통째 MP3 켜고 끄기 — 둘 다 누르는 순간 이 탭의 녹음 허용(activeTab)이 된다
if (chrome.commands) chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'save-cue') invokeOnTab(tab, 'command');
  else if (command === 'rec-episode') invokeOnTab(tab, 'command', 'rec');
});
if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'st-save-cue') invokeOnTab(tab, 'menu'); });

// ───────── 자동 백업 ─────────
// 학습 데이터(저장 자막·단어장·통계·설정)는 이 크롬의 로컬 저장소에만 있다 — 확장 프로그램 삭제·프로필 초기화 한 번이면 전부 사라진다.
// 오디오 저장 폴더가 지정돼 있고 권한이 살아 있으면, 자막·단어가 바뀐 지 4초 뒤에 조건(마지막 백업 뒤 7일, 또는 변경 50건)을 보고
// <폴더>/SubTutor/백업/subtutor-backup-YYYY-MM-DD.json 을 쓴다 (같은 날은 덮어쓴다). 복원: 웹 설정 › 데이터 › 가져오기로 그 파일을 고른다
const BACKUP_AFTER_CHANGES = 50, BACKUP_AFTER_MS = 7 * 86400000;
let backupTimer = null, backupChain = Promise.resolve();
function noteDataChange() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { backupChain = backupChain.then(() => maybeBackup()).catch(() => {}); }, 4000);
}
async function getBackupMeta() {
  const { backupMeta } = await chrome.storage.local.get('backupMeta');
  return Object.assign({ lastAt: 0, changes: 0, lastPath: '', lastError: '' }, backupMeta || {});
}
async function maybeBackup() {
  const meta = await getBackupMeta();
  meta.changes++;
  if (!meta.lastAt) meta.lastAt = Date.now(); // 첫 사용: 여기서부터 7일을 센다 (폴더를 고르자마자 쓰지는 않는다)
  if (meta.changes < BACKUP_AFTER_CHANGES && Date.now() - meta.lastAt <= BACKUP_AFTER_MS) {
    await chrome.storage.local.set({ backupMeta: meta });
    return { ok: false, reason: 'not-due' };
  }
  return doBackup(meta);
}
async function doBackup(meta0) {
  const meta = meta0 || (await getBackupMeta());
  if (!FS) return { ok: false, reason: 'none' };
  const st = await FS.status().catch(() => ({ state: 'none' }));
  if (st.state !== 'granted') { meta.lastError = st.state; await chrome.storage.local.set({ backupMeta: meta }); return { ok: false, reason: st.state }; }
  const payload = { app: 'SubTutor', kind: 'backup', exportedAt: new Date().toISOString(), items: await getItems(), words: await getWords(), stats: await getStats(), settings: await getSettings() };
  const name = 'SubTutor/백업/subtutor-backup-' + payload.exportedAt.slice(0, 10) + '.json';
  const r = await FS.writeFile(name, new TextEncoder().encode(JSON.stringify(payload)));
  if (r.ok) await chrome.storage.local.set({ backupMeta: { lastAt: Date.now(), changes: 0, lastPath: r.path, lastError: '' } });
  else { meta.lastError = r.reason || 'error'; await chrome.storage.local.set({ backupMeta: meta }); }
  return Object.assign({ name }, r);
}

// ───────── 사용자가 켠 사이트 (목록에 없는 아무 사이트) ─────────
// 팝업에서 "이 사이트에서 SubTutor 켜기"를 누르면 팝업이 그 사이트의 접근 권한을 받고, 여기서 콘텐츠 스크립트를 등록한다
// (범용 페이지 스크립트 + 범용 어댑터). 등록은 브라우저를 다시 열어도 남고, 지금 탭에도 바로 넣는다
const CONTENT_JS = ['src/lib/subtitles.js', 'vendor/lamejs/lame.min.js', 'src/lib/audio.js', 'src/lib/stretch.js', 'src/data/freq-en.js', 'src/data/kiwi.js', 'src/data/nzVowels.js', 'src/lib/speech.js', 'src/lib/vocab.js', 'src/lib/explain.js', 'src/lib/sites.js', 'src/content/adapters.js', 'src/content/content.js'];
const siteScriptIds = (host) => ['st-page-' + host, 'st-content-' + host];
const sitePatterns = (host) => ['https://' + host + '/*', 'http://' + host + '/*'];
function builtInHost(host) {
  const h = String(host || '').toLowerCase();
  return /(^|\.)netflix\.com$/.test(h) || /(^|\.)primevideo\.com$/.test(h) || /(^|\.)amazon\.(com|co\.uk|co\.jp|de|com\.au)$/.test(h) || /(^|\.)disneyplus\.com$/.test(h) || /(^|\.)youtube\.com$/.test(h) || !!(Sites && Sites.forHost(h));
}
async function getCustomSites() {
  const { customSites } = await chrome.storage.local.get('customSites');
  return Array.isArray(customSites) ? customSites : [];
}
async function hasHostPermission(host) {
  try { return (await chrome.permissions.contains({ origins: ['https://' + host + '/*'] })) || (await chrome.permissions.contains({ origins: ['http://' + host + '/*'] })); } catch (e) { return false; }
}
async function registerSiteScripts(host) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) throw new Error('이 크롬은 사이트 추가를 지원하지 않습니다 (크롬 102 이상 필요)');
  const ids = siteScriptIds(host);
  const have = await chrome.scripting.getRegisteredContentScripts({ ids }).catch(() => []);
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((s) => s.id) }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    { id: ids[0], matches: sitePatterns(host), js: ['src/page/generic-page.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: ids[1], matches: sitePatterns(host), js: CONTENT_JS, css: ['src/content/content.css'], runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}
async function addCustomSite(origin, tabId) {
  let u;
  try { u = new URL(origin); } catch (e) { throw new Error('사이트 주소가 올바르지 않습니다'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('http·https 사이트에서만 켤 수 있습니다');
  const host = u.hostname.toLowerCase();
  if (builtInHost(host)) return { ok: true, host, builtIn: true };
  if (!(await hasHostPermission(host))) return { ok: false, host, error: '이 사이트에 접근할 권한이 없습니다 (팝업에서 허용해야 합니다)' };
  await registerSiteScripts(host);
  const list = (await getCustomSites()).filter((s) => s.host !== host);
  list.push({ host, origin: u.origin, addedAt: Date.now() });
  await chrome.storage.local.set({ customSites: list });
  let injected = false;
  // 지금 탭에도 바로 넣는다. 페이지 스크립트가 늦게 들어가 이미 받은 자막은 못 볼 수 있다 → 팝업이 새로고침을 권한다
  if (Number.isInteger(tabId)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/page/generic-page.js'], world: 'MAIN' });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
      injected = true;
    } catch (e) { injected = false; }
  }
  await refreshContextMenu();
  return { ok: true, host, injected };
}
async function removeCustomSite(host) {
  const h = String(host || '').toLowerCase();
  if (chrome.scripting && chrome.scripting.unregisterContentScripts) await chrome.scripting.unregisterContentScripts({ ids: siteScriptIds(h) }).catch(() => {});
  await chrome.storage.local.set({ customSites: (await getCustomSites()).filter((s) => s.host !== h) });
  try { await chrome.permissions.remove({ origins: sitePatterns(h) }); } catch (e) { /* 이미 없음 */ }
  await refreshContextMenu();
  return { ok: true, host: h };
}
// 서비스 워커가 깨어날 때: 저장된 사이트의 등록이 빠졌으면(확장 프로그램을 다시 불러온 경우 등) 다시 넣고, 권한이 없어진 사이트는 목록에서 뺀다
async function syncCustomSites() {
  if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return;
  const list = await getCustomSites();
  const keep = [];
  for (const s of list) {
    if (!(await hasHostPermission(s.host))) continue;
    keep.push(s);
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: siteScriptIds(s.host) }).catch(() => []);
    if (have.length < 2) await registerSiteScripts(s.host).catch(() => {});
  }
  if (keep.length !== list.length) await chrome.storage.local.set({ customSites: keep });
}
// 재생 화면 우클릭 메뉴 "지금 자막 저장": 지원 사이트 + 사용자가 켠 사이트
async function refreshContextMenu() {
  if (!chrome.contextMenus) return;
  const patterns = Object.values(PLATFORM_URL_PATTERNS).flat().concat(Sites ? Sites.allPatterns() : [], (await getCustomSites()).flatMap((s) => sitePatterns(s.host)));
  await new Promise((resolve) => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; resolve(); }));
  chrome.contextMenus.create({ id: 'st-save-cue', title: 'SubTutor: 지금 자막 저장 (오디오 녹음 허용)', contexts: ['page', 'video', 'frame'], documentUrlPatterns: patterns }, () => void chrome.runtime.lastError);
}
syncCustomSites().catch(() => {});

// ───────── 메시지 처리 ─────────
function updateItem(items, id, patch) {
  const it = items.find((i) => i.id === id);
  if (!it) return { write: false, items, result: { ok: false, error: '항목을 찾을 수 없습니다' } };
  // 태그를 바꾼 시각 — 아이폰에서 바꾼 태그(서버 updated_at)와 어느 쪽이 최신인지 가린다
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tags') && !Object.prototype.hasOwnProperty.call(patch, 'tagsAt')) patch = Object.assign({}, patch, { tagsAt: Date.now() });
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'box') && !Object.prototype.hasOwnProperty.call(patch, 'boxAt')) patch = Object.assign({}, patch, { boxAt: Date.now() });
  Object.assign(it, patch || {});
  return { write: true, items, result: { ok: true, item: it } };
}
async function handleMessage(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const p = msg.payload || {};
  switch (msg.type) {
    // 플레이어 탭(콘텐츠 스크립트)
    case 'player.hello': {
      if (tabId == null) return { ok: true };
      const reg = await getRegistry();
      reg[tabId] = { platform: msg.platform, videoId: msg.videoId, ready: !!msg.ready, at: Date.now() };
      await setRegistry(reg);
      return { ok: true, tabId };
    }
    case 'audio.save': return saveAudio(msg);
    case 'capture.start': return captureStart(msg, tabId);
    // 영상 오디오 통째 MP3
    case 'rec.start': return recStart(msg, tabId);
    case 'rec.beat': {
      const r = await offscreenCall({ cmd: 'recBeat', paused: !!msg.paused }, 2);
      if (r && r.recording) {   // 서비스 워커가 그새 재시동됐어도 심장박동으로 상태를 되살린다
        if (!recState) recState = { tabId, title: '', startedAt: 0 };
        if (msg.title) recState.title = msg.title;
        if (tabId != null) recState.tabId = tabId;
      }
      return r;
    }
    case 'rec.stop': {
      const meta = await offscreenCall({ cmd: 'recStop' }, 2);
      if (!meta || !meta.ok) return meta || { ok: false, error: '영상 오디오를 녹음하고 있지 않습니다' };
      return recSave(meta);
    }
    case 'rec.status': {
      let has = false;
      try { has = chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function' ? await chrome.offscreen.hasDocument() : false; } catch (e) { has = false; }
      if (!has) { recState = null; return { on: false }; }
      const r = await offscreenCall({ cmd: 'recPing' }, 2).catch(() => null);
      if (!r || !r.recording) { recState = null; return { on: false }; }
      if (!recState) recState = { tabId, title: '', startedAt: 0 };
      return { on: true, tabId: recState.tabId, title: recState.title, startedAt: recState.startedAt };
    }
    case 'rec.part': {   // offscreen 이 보내는 MP3 조각
      const arr = recParts.get(msg.recId) || [];
      arr[msg.seq] = msg.data;
      recParts.set(msg.recId, arr);
      return { ok: true };
    }
    case 'rec.elemSave': {   // DRM 없는 사이트: 콘텐츠 스크립트가 영상 요소에서 담아 조각(rec.part)을 보낸 뒤 저장을 맡긴다
      recState = { tabId, title: msg.title || '', startedAt: 0 };
      return recSave(msg.meta || {});
    }
    case 'web.recs.list': return { recs: await getRecs(), dir: await audioDirStatus() };
    case 'web.recs.data': {   // 웹이 올리기 전에 폴더의 MP3 를 6MB 조각으로 읽어 간다
      const rec = (await getRecs()).find((x) => x.id === p.id);
      if (!rec) return { reason: 'missing' };
      if (rec.file && rec.file.location !== 'folder' && rec.file.opfs) return offscreenCall({ cmd: 'recRead', recId: rec.id, seq: p.seq || 0 }, 2);   // 자기 저장소의 복사본
      if (!rec.file || rec.file.location !== 'folder') return { reason: 'downloads' };
      const r = await FS.readFile(rec.file.path);
      if (!r.ok) return { reason: r.reason || 'error' };
      const SLICE = 6 * 1024 * 1024;
      const off = (p.seq || 0) * SLICE;
      return { data: bytesToB64(r.bytes.subarray(off, off + SLICE)), done: off + SLICE >= r.bytes.length, size: r.bytes.length };
    }
    case 'web.recs.mark': {
      const recs = await getRecs();
      const rec = recs.find((x) => x.id === p.id);
      if (rec) { Object.assign(rec, p.patch || {}); await setRecs(recs); }
      return { ok: true };
    }
    case 'web.recs.remove': {
      const gone = (await getRecs()).find((x) => x.id === p.id);
      await setRecs((await getRecs()).filter((x) => x.id !== p.id));
      if (gone && gone.file && gone.file.opfs) await offscreenCall({ cmd: 'recDelete', recId: gone.id }, 2).catch(() => {});
      return { ok: true };
    }
    case 'rec.auto': {   // 심장박동 끊김·용량 초과로 offscreen 이 스스로 끝냈다 — 저장하고 플레이어 탭에 알린다
      const st = recState;
      const out = await recSave(msg.meta || {});
      if (st && Number.isInteger(st.tabId)) { try { await chrome.tabs.sendMessage(st.tabId, { type: 'rec.saved', result: out }); } catch (e) { /* 탭이 사라짐 */ } }
      return { ok: true };
    }
    case 'stats.get': case 'web.stats.get': return { stats: await getStats() };
    case 'stats.episode': return withStats((st) => {
      st.episodes[msg.key] = Object.assign({}, st.episodes[msg.key] || {}, msg.data || {});
      if (msg.series && msg.series.key) {
        const se = st.series[msg.series.key] || { episodes: [], words: {} };
        if (!se.episodes.includes(msg.series.videoId)) {
          se.episodes.push(msg.series.videoId);
          for (const w of msg.series.words || []) se.words[w] = (se.words[w] || 0) + 1;
          const keys = Object.keys(se.words);
          if (keys.length > 3000) keys.sort((a, b) => se.words[a] - se.words[b]).slice(0, keys.length - 3000).forEach((k) => delete se.words[k]);
        }
        st.series[msg.series.key] = se;
      }
      return { ok: true };
    });
    case 'web.stats.weak': return withStats((st) => { for (const w of (p.words || []).slice(0, 50)) { const k = String(w).toLowerCase().slice(0, 30); if (k) st.weak[k] = (st.weak[k] || 0) + 1; } return { ok: true }; });
    case 'web.stats.weakReset': return withStats((st) => { st.weak = {}; st.reductions = {}; return { ok: true }; });
    // 받아쓰기에서 놓친 축약 패턴 (gonna, didja, 'em …) 누적
    case 'web.stats.reduction': return withStats((st) => {
      st.reductions = st.reductions && typeof st.reductions === 'object' ? st.reductions : {};
      for (const r of (p.patterns || []).slice(0, 20)) {
        const key = String((r && r.to) || '').slice(0, 24);
        if (!key) continue;
        const cur = st.reductions[key] || { n: 0, src: '' };
        st.reductions[key] = { n: cur.n + 1, src: String((r && r.src) || cur.src).slice(0, 40) };
      }
      const keys = Object.keys(st.reductions);
      if (keys.length > 200) keys.sort((a, b) => st.reductions[a].n - st.reductions[b].n).slice(0, keys.length - 200).forEach((k) => delete st.reductions[k]);
      return { ok: true };
    });
    case 'web.stats.review': return withStats((st) => { st.reviews.push({ t: Date.now(), kind: String(p.kind || 'review').slice(0, 20) }); if (st.reviews.length > 3000) st.reviews.splice(0, st.reviews.length - 3000); return { ok: true }; });
    // 오늘의 훈련을 마친 날 (웹이 그 사람의 날짜로 'YYYY-MM-DD' 를 준다) → 연속 일수·주별 그래프
    case 'web.stats.training': return withStats((st) => {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(p.day || '')) ? p.day : null;
      if (!day) return { ok: false, error: '날짜가 없습니다' };
      st.training = st.training && typeof st.training === 'object' ? st.training : {};
      const prev = st.training[day] || {};
      st.training[day] = Object.assign({}, prev, p.data || {}, { at: Date.now(), sessions: (prev.sessions || 0) + 1 });
      const keys = Object.keys(st.training).sort();
      if (keys.length > 800) keys.slice(0, keys.length - 800).forEach((k) => delete st.training[k]);
      return { ok: true, training: st.training };
    });
    case 'capture.finish': return offscreenCall({ cmd: 'finish', startMs: msg.startMs, endMs: msg.endMs, anchors: msg.anchors, downloadRate: msg.downloadRate, storeRate: msg.storeRate }, 2);
    case 'capture.stop': return offscreenCall({ cmd: 'stop' }, 2);
    case 'audio.get': return getAudio(msg.id);
    case 'player.event': {
      const clip = await currentClip();
      if (!clip || clip.clipId !== msg.clipId) return { ok: false };
      notifyWeb(clip.websiteTabId, { itemId: clip.itemId, clipId: msg.clipId, state: msg.event, message: msg.message || msg.reason || '' });
      if (msg.event !== 'playing') await setActiveClip(null);
      return { ok: true };
    }
    case 'items.list': {
      const items = await getItems();
      return { items: msg.platform ? items.filter((i) => i.platform === msg.platform && (!msg.videoId || String(i.videoId) === String(msg.videoId))) : items };
    }
    case 'items.save':
      return withItems((items) => {
        const idx = items.findIndex((i) => i.id === msg.item.id);
        if (idx >= 0) items[idx] = Object.assign({}, items[idx], msg.item, { comment: items[idx].comment || msg.item.comment || '', box: items[idx].box || 'learning' });
        else items.push(msg.item);
        return { write: true, items, result: { ok: true } };
      });
    case 'items.update': return withItems((items) => updateItem(items, msg.id, msg.patch));
    case 'items.remove': await removeAudio([msg.id]); return withItems((items) => ({ write: true, items: items.filter((i) => i.id !== msg.id), result: { ok: true } }));
    case 'translate': return translateTexts(Array.isArray(msg.texts) ? msg.texts.map(String) : [], msg.from || 'en', msg.to || 'ko');
    case 'fetch.text': {
      const res = await fetch(msg.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { text: await res.text() };
    }
    case 'fetch.bytes': { // DASH 자막 조각(MP4) — 페이지에서 받지 못했을 때
      const res = await fetch(msg.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { b64: bytesToBase64(new Uint8Array(await res.arrayBuffer())) };
    }
    // 아무 사이트에서 켜기 (팝업이 그 사이트의 권한을 받은 뒤)
    case 'sites.list': return { sites: await getCustomSites(), builtIn: Sites ? Sites.SITES.map((s) => ({ key: s.key, label: s.label, home: s.home, about: s.about })) : [] };
    case 'sites.add': return addCustomSite(msg.origin, msg.tabId);
    case 'sites.remove': return removeCustomSite(msg.host);
    case 'settings.get': return { settings: await getSettings() };
    case 'settings.set': return withSettings(async () => {
      const s = Object.assign(await getSettings(), msg.patch || {});
      await chrome.storage.local.set({ settings: s });
      return { settings: s };
    });
    case 'openSite': await openSite(); return { ok: true };
    case 'openOptions': await chrome.runtime.openOptionsPage(); return { ok: true };
    case 'audioDir.status': return audioDirStatus();
    case 'backup.now': case 'web.backup.now': return doBackup();
    case 'backup.status': case 'web.backup.status': return { meta: await getBackupMeta(), dir: await audioDirStatus() };
    // 설정 페이지를 닫았다가 다시 연다: 크롬은 확장 프로그램 탭이 모두 닫히면 폴더 권한을 '휴면' 상태로 돌리고,
    // 그 상태에서 권한을 다시 요청해야 "매번 허용" 선택지가 있는 창을 띄운다.
    case 'options.reopenForGrant': {
      const url = chrome.runtime.getURL('options/options.html') + '#grant';
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('options/options.html') + '*' });
      for (const t of tabs) { try { await chrome.tabs.remove(t.id); } catch (e) { /* ignore */ } }
      await new Promise((r) => setTimeout(r, 900));
      await chrome.tabs.create({ url, active: true });
      return { ok: true };
    }
    case 'togglePanel': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }); } catch (e) { return { ok: false, error: '이 탭에서는 SubTutor가 실행 중이 아닙니다' }; } }
      return { ok: true };
    }
    // 웹사이트(브리지)
    case 'web.ping': return { ok: true, version: chrome.runtime.getManifest().version };
    case 'web.items.list': return { items: await getItems() };
    case 'words.translate': case 'web.words.translate': return translateWords(Array.isArray(p.words || msg.words) ? (p.words || msg.words) : []);
    case 'words.list': case 'web.words.list': return { words: await getWords() };
    case 'words.save': return saveWordCard(msg.card || p.card);
    case 'words.remove': case 'web.words.remove': { const key = wordKey(msg.word || p.word); return withWords((words) => ({ write: true, words: words.filter((w) => wordKey(w.word) !== key), result: { ok: true } })); }
    case 'web.words.update': { const key = wordKey(p.word); return withWords((words) => { const w = words.find((x) => wordKey(x.word) === key); if (!w) return { result: { ok: false } }; if (typeof (p.patch || {}).meaning === 'string') w.meaning = p.patch.meaning.slice(0, 200); return { write: true, words, result: { ok: true } }; }); }
    case 'web.words.import': { const incoming = Array.isArray(p.words) ? p.words : []; return withWords((words) => { const have = new Set(words.map((w) => wordKey(w.word))); let added = 0; for (const c of incoming) { const key = wordKey(c && c.word); if (!key || have.has(key)) continue; have.add(key); added++; words.push(Object.assign({}, c, { word: key })); } return { write: added > 0, words, result: { ok: true, added, total: words.length } }; }); } // 이미 있는 단어는 복습 기록을 지키려고 건드리지 않는다
    case 'web.words.review': { const key = wordKey(p.word); return withWords((words) => { const w = words.find((x) => wordKey(x.word) === key); if (!w) return { result: { ok: false } }; w.review = reviewWord(w, p.result === 'know' ? 'know' : 'forgot', Date.now()); return { write: true, words, result: { ok: true, review: w.review } }; }); }
    case 'web.items.update': return withItems((items) => updateItem(items, p.id, p.patch));
    case 'web.items.remove': return removeItems([p.id]);
    case 'web.items.removeMany': return removeItems(p.ids);
    case 'web.items.clear': return removeItems((await getItems()).map((i) => i.id));
    case 'web.audio.get': return getAudio(p.itemId);
    case 'web.audio.file': return audioFromFile(p.itemId);
    case 'web.audio.put': return putAudio(p);
    case 'web.audio.remove': { await removeAudio([p.itemId]); return withItems((items) => updateItem(items, p.itemId, { audio: null })); }
    case 'web.setEnabled': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: 'setEnabled', enabled: !!p.enabled }); } catch (e) { /* ignore */ } }
      return { ok: true };
    }
    case 'web.items.import': {
      const incoming = Array.isArray(p.items) ? p.items : [];
      return withItems((items) => {
        const map = new Map(items.map((i) => [i.id, i]));
        let added = 0;
        for (const it of incoming) {
          if (!it || !it.id || typeof it.text !== 'string') continue;
          if (!map.has(it.id)) added++;
          map.set(it.id, Object.assign({}, map.get(it.id) || {}, it));
        }
        return { write: true, items: Array.from(map.values()), result: { ok: true, added, total: map.size } };
      });
    }
    case 'web.settings.get': return { settings: await getSettings() };
    case 'web.settings.set': return withSettings(async () => {
      const s2 = Object.assign(await getSettings(), p.patch || {});
      await chrome.storage.local.set({ settings: s2 });
      return { settings: s2 };
    });
    case 'web.clip.play': {
      const item = (await getItems()).find((i) => i.id === p.itemId);
      if (!item) throw new Error('항목을 찾을 수 없습니다');
      return playClip(item, tabId, !!p.loop, +p.rate || 0);
    }
    case 'web.clip.loop': {
      const clip = await currentClip();
      if (clip && clip.tabId) { try { await chrome.tabs.sendMessage(clip.tabId, { type: 'clipLoop', loop: !!p.loop }); } catch (e) { /* ignore */ } }
      return { ok: true };
    }
    case 'web.clip.stop': {
      const clip = await currentClip();
      if (clip && clip.tabId) { try { await chrome.tabs.sendMessage(clip.tabId, { type: 'stopClip' }); } catch (e) { /* ignore */ } }
      await setActiveClip(null);
      return { ok: true };
    }
    case 'web.item.open': {
      const item = (await getItems()).find((i) => i.id === p.itemId);
      if (!item) throw new Error('항목을 찾을 수 없습니다');
      const playerTab = await ensurePlayerTab(item, true);
      const s = await waitForReady(playerTab, item, 30000);
      if (s) { try { await chrome.tabs.sendMessage(playerTab, { type: 'seekTo', ms: Math.max(0, item.startMs - 300), play: true }); } catch (e) { /* ignore */ } }
      return { ok: !!s };
    }
    // 오늘의 훈련 › 더빙 권유: 플레이어 탭을 열어 그 대사에서 더빙 칸(R)을 바로 연다
    case 'web.item.dub': {
      const item = (await getItems()).find((i) => i.id === p.itemId);
      if (!item) throw new Error('항목을 찾을 수 없습니다');
      const playerTab = await ensurePlayerTab(item, true);
      const s = await waitForReady(playerTab, item, 30000);
      if (!s) return { ok: false, error: '플레이어가 준비되지 않았습니다. 플레이어 탭에서 영상이 재생되는지 확인하세요.' };
      try { return await chrome.tabs.sendMessage(playerTab, { type: 'dubAt', ms: item.startMs }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    default:
      throw new Error('알 수 없는 메시지: ' + msg.type);
  }
}
globalThis.__subtutorHandle = handleMessage; // 테스트/진단용
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  handleMessage(msg, sender).then(
    (r) => sendResponse(r === undefined ? { ok: true } : r),
    (e) => sendResponse({ error: String((e && e.message) || e) }),
  );
  return true;
});
chrome.runtime.onInstalled.addListener(async () => {
  // settings 는 저장하지 않는다 — 모든 경로가 getSettings()(기본값 merge)를 쓰므로 초기 저장이 필요 없고,
  // "없으면 기본값 저장"은 설치 직후 들어온 settings.set 을 기본값으로 되덮는 경쟁(E2E 에서 재현)을 만든다
  await refreshContextMenu();
});
