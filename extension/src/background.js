/*
 * SubTutor – 백그라운드 서비스 워커
 * 저장한 자막(items) 관리, 기계 번역(캐시), 플레이어 탭 찾기/열기, 웹사이트 ↔ 플레이어 원격 재생 중계.
 */
import './lib/fs.js';
const FS = globalThis.SubTutorFS;
const SITE_URL = 'https://bluemuple.github.io/subtutor/';
const DEFAULT_SETTINGS = {
  showTranslation: true, translationSource: 'auto', hideNative: true, overlay: true, panelOpen: true,
  fontScale: 100, autoPause: false, shadowing: false, shadowPauseSec: 2, leadMs: 150, tailMs: 200, audioMode: 'off', enabled: {},
  audioDirName: '', // 사용자가 고른 오디오 저장 폴더 이름 (핸들은 IndexedDB). 비어 있으면 다운로드 폴더
};
const PLATFORM_URL_PATTERNS = {
  netflix: ['https://www.netflix.com/watch/*'],
  youtube: ['https://www.youtube.com/watch*'],
  prime: ['https://www.primevideo.com/*', 'https://*.amazon.com/*', 'https://*.amazon.co.uk/*', 'https://*.amazon.co.jp/*', 'https://*.amazon.de/*', 'https://*.amazon.com.au/*'],
  disney: ['https://www.disneyplus.com/*'],
};

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
    if (r && r.write) await chrome.storage.local.set({ items: r.items });
    return r ? r.result : undefined;
  });
  itemsChain = run.catch(() => {});
  return run;
}
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
  const tabs = await chrome.tabs.query({ url: PLATFORM_URL_PATTERNS[item.platform] || [] });
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
async function playClip(item, websiteTabId, loop) {
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
    await chrome.tabs.sendMessage(tabId, { type: 'playRange', clipId, startMs: item.startMs, endMs: item.endMs, loop: !!loop });
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
  const mode = msg.mode || 'store';
  if ((mode === 'store' || mode === 'both') && msg.store) {
    await chrome.storage.local.set({ [audioKey(msg.id)]: msg.store });
    await withItems((items) => updateItem(items, msg.id, { audio: { format: msg.storeFormat || 'wav', mime: msg.storeMime || 'audio/wav', rate: msg.storeRate || 16000, ms: msg.durationMs || 0, savedAt: Date.now() } }));
    out.stored = true;
  }
  if ((mode === 'download' || mode === 'both') && msg.download) {
    const fileName = String(msg.fileName || 'SubTutor/clip.mp3').replace(/^\/+/, '');
    // 1) 사용자가 고른 폴더가 있고 권한이 살아 있으면 그 폴더 안에 바로 쓴다
    const folder = await saveToFolder(fileName, msg.download);
    if (folder.ok) { out.fileName = folder.path; out.location = 'folder'; return out; }
    if (folder.reason && folder.reason !== 'none') { out.folderIssue = folder.reason === 'error' ? 'error' : 'prompt'; out.folderError = folder.error || ''; out.folderName = folder.name || ''; }
    // 2) 아니면 크롬 다운로드 폴더(Downloads/SubTutor/…)
    try {
      out.downloadId = await chrome.downloads.download({ url: 'data:' + (msg.downloadMime || 'audio/wav') + ';base64,' + msg.download, filename: fileName, conflictAction: 'uniquify', saveAs: false });
      out.fileName = fileName; out.location = 'downloads';
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

// ───────── 메시지 처리 ─────────
function updateItem(items, id, patch) {
  const it = items.find((i) => i.id === id);
  if (!it) return { write: false, items, result: { ok: false, error: '항목을 찾을 수 없습니다' } };
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
    case 'settings.get': return { settings: await getSettings() };
    case 'settings.set': {
      const s = Object.assign(await getSettings(), msg.patch || {});
      await chrome.storage.local.set({ settings: s });
      return { settings: s };
    }
    case 'openSite': await openSite(); return { ok: true };
    case 'openOptions': await chrome.runtime.openOptionsPage(); return { ok: true };
    case 'audioDir.status': return audioDirStatus();
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
    case 'web.items.update': return withItems((items) => updateItem(items, p.id, p.patch));
    case 'web.items.remove': await removeAudio([p.id]); return withItems((items) => ({ write: true, items: items.filter((i) => i.id !== p.id), result: { ok: true } }));
    case 'web.items.clear': { const ids = (await getItems()).map((i) => i.id); await removeAudio(ids); return withItems(() => ({ write: true, items: [], result: { ok: true } })); }
    case 'web.audio.get': return getAudio(p.itemId);
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
    case 'web.settings.set': {
      const s = Object.assign(await getSettings(), p.patch || {});
      await chrome.storage.local.set({ settings: s });
      return { settings: s };
    }
    case 'web.clip.play': {
      const item = (await getItems()).find((i) => i.id === p.itemId);
      if (!item) throw new Error('항목을 찾을 수 없습니다');
      return playClip(item, tabId, !!p.loop);
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
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});
