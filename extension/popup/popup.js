const DEFAULTS = { showTranslation: true, translationSource: 'auto', hideNative: true, overlay: true, panelOpen: true, fontScale: 100, autoPause: false, shadowing: false, shadowPauseSec: 2, shadowPauseMode: 'ratio', shadowPauseRatio: 1, dubPlayback: true, dubRecRate: 1, dubListenFirst: false, dubAutoPreview: false, dubAutoNext: false, dubFeedback: true, wordSort: 'hard', leadMs: 150, tailMs: 200, audioMode: 'off', enabled: {}, audioDirName: '', koMode: 'hold', secondPass: false, cloze: 'off', soundsLike: false, kiwiNotes: true, nzNotes: true, vocabProfile: true };
// 따라하기 쉬는 시간: 자막 길이 × 배율(r…) 또는 고정 초(s…) — content.js 와 같은 규칙
const SHADOW_RATIOS = [0.8, 1, 1.1, 1.2, 1.3, 1.5, 2];
const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));
const shadowRatio = () => {
  const v = clampNum(+settings.shadowPauseRatio || 1, 0.5, 3);
  return SHADOW_RATIOS.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), SHADOW_RATIOS[0]);
};
const shadowPauseValue = () => (settings.shadowPauseMode === 'sec'
  ? 's' + clampNum(+settings.shadowPauseSec || 2, 1, 7)
  : 'r' + shadowRatio());
function shadowPausePatch(v) {
  const s = String(v || '');
  if (s.charAt(0) === 's') return { shadowPauseMode: 'sec', shadowPauseSec: clampNum(+s.slice(1) || 2, 1, 7) };
  return { shadowPauseMode: 'ratio', shadowPauseRatio: clampNum(+s.slice(1) || 1, 0.5, 3) };
}
const Ex = globalThis.SubTutorExplain;
function showInfo(key) {
  const x = Ex && Ex.get(key);
  if (!x) return;
  $('infoTitle').textContent = x.title;
  const body = $('infoBody'); body.textContent = '';
  const p = document.createElement('p'); p.textContent = x.what; body.append(p);
  if (x.why) { const h = document.createElement('h5'); h.textContent = '왜 이렇게 하나 (근거)'; const w = document.createElement('p'); w.textContent = x.why; body.append(h, w); }
  if (x.refs && x.refs.length) { const h = document.createElement('h5'); h.textContent = '참고 문헌'; const ul = document.createElement('ul'); x.refs.forEach((r) => { const li = document.createElement('li'); li.textContent = r; ul.append(li); }); body.append(h, ul); }
  $('infobox').classList.remove('hidden');
}
const FS = globalThis.SubTutorFS;
let currentPlatform = null;
const $ = (id) => document.getElementById(id);
let settings = Object.assign({}, DEFAULTS);

function save(patch) {
  settings = Object.assign({}, settings, patch);
  chrome.storage.local.set({ settings });
  render();
}
async function refreshDir() {
  let st = { state: 'none' };
  try { if (FS) st = await FS.status(); } catch (e) { /* ignore */ }
  const has = st.state !== 'none';
  $('dirName').textContent = (has ? st.name : '다운로드 폴더') + '/SubTutor';
  $('dirName').title = has ? '지정한 폴더: ' + st.name : '크롬 다운로드 폴더 안의 SubTutor';
  $('dirWarn').classList.toggle('hidden', !(has && st.state !== 'granted'));
}
function render() {
  $('panelOpen').checked = !!settings.panelOpen;
  $('showTranslation').checked = !!settings.showTranslation;
  $('hideNative').checked = !!settings.hideNative;
  $('autoPause').checked = !!settings.autoPause;
  $('shadowing').checked = !!settings.shadowing;
  $('shadowPauseSec').value = shadowPauseValue();
  $('audioMode').value = settings.audioMode === 'both' ? 'download' : (settings.audioMode || 'off');
  $('koMode').value = settings.koMode || 'hold';
  $('cloze').value = settings.cloze || 'off';
  ['secondPass', 'soundsLike', 'kiwiNotes', 'nzNotes', 'vocabProfile'].forEach((k) => { $(k).checked = !!settings[k]; });
  $('enabled').checked = !currentPlatform || !settings.enabled || settings.enabled[currentPlatform] !== false;
  $('enabledRow').style.display = currentPlatform ? '' : 'none';
}
async function init() {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  const sel = $('shadowPauseSec');
  const group = (label, opts) => { const g = document.createElement('optgroup'); g.label = label; opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; g.append(o); }); return g; };
  sel.append(group('자막 길이 기준', SHADOW_RATIOS.map((r) => ['r' + r, '자막 길이 ×' + r])));
  sel.append(group('고정 시간', Array.from({ length: 7 }, (_, k) => ['s' + (k + 1), (k + 1) + '초'])));
  const { settings: s } = await chrome.storage.local.get('settings');
  settings = Object.assign({}, DEFAULTS, s || {});
  render();
  ['panelOpen', 'showTranslation', 'hideNative'].forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: e.target.checked })));
  $('autoPause').addEventListener('change', (e) => save({ autoPause: e.target.checked, shadowing: e.target.checked ? false : settings.shadowing }));
  $('shadowing').addEventListener('change', (e) => save({ shadowing: e.target.checked, autoPause: e.target.checked ? false : settings.autoPause }));
  sel.addEventListener('change', (e) => save(shadowPausePatch(e.target.value)));
  $('audioMode').addEventListener('change', (e) => save({ audioMode: e.target.value }));
  $('koMode').addEventListener('change', (e) => save({ koMode: e.target.value }));
  $('cloze').addEventListener('change', (e) => save({ cloze: e.target.value }));
  ['secondPass', 'soundsLike', 'kiwiNotes', 'nzNotes', 'vocabProfile'].forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: e.target.checked })));
  document.querySelectorAll('.info').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showInfo(b.dataset.key); }));
  $('infoClose').addEventListener('click', () => $('infobox').classList.add('hidden'));
  $('keysBtn').addEventListener('click', () => showInfo('keys'));
  $('enabled').addEventListener('change', (e) => { if (!currentPlatform) return; save({ enabled: Object.assign({}, settings.enabled || {}, { [currentPlatform]: e.target.checked }) }); });
  $('openSite').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openSite' }, () => window.close()));
  $('changeDir').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('grantDir').addEventListener('click', async () => {
    // 팝업에서는 크롬이 추가 창 없이 허용해 준다. 허용되지 않으면 설정 페이지에서 "매번 허용" 흐름으로 안내
    const r = FS ? await FS.requestPermission() : 'none';
    await refreshDir();
    if (r !== 'granted') { chrome.runtime.openOptionsPage(); window.close(); }
  });
  refreshDir();
  $('openNetflix').addEventListener('click', showSites);
  $('sitesClose').addEventListener('click', () => $('sitesBox').classList.add('hidden'));

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'status' }).catch(() => null) : null;
    if (res && res.platform) {
      currentPlatform = res.platform;
      render();
      const names = { netflix: '넷플릭스', prime: '프라임 비디오', disney: '디즈니+', youtube: '유튜브' };
      $('status').textContent = (names[res.platform] || res.label || res.platform) + (res.videoId ? ' · ' + (res.title || res.videoId) + ' · 자막 ' + res.cues + '줄' : ' · 재생 화면이 아닙니다');
      if (res.videoId && res.platform !== 'youtube') { $('audioHint').textContent = '✓ 이 탭의 오디오 녹음 허용됨'; $('audioHint').classList.remove('hidden'); }
      if (res.custom) { $('customText').textContent = '직접 켠 사이트입니다.'; $('customHint').classList.remove('hidden'); }
      chrome.tabs.sendMessage(tab.id, { type: 'popupOpened' }).catch(() => {});
    } else {
      offerSite(tab);
    }
  } catch (e) {
    $('status').textContent = '상태를 확인할 수 없습니다';
  }
  $('removeSite').addEventListener('click', async () => {
    let host = '';
    try { host = new URL(tab.url).hostname; } catch (e) { return; }
    const r = await chrome.runtime.sendMessage({ type: 'sites.remove', host }).catch(() => null);
    $('customText').textContent = r && r.ok ? '목록에서 뺐습니다. 탭을 새로고침하면 SubTutor 가 사라집니다.' : '빼지 못했습니다';
    $('removeSite').classList.add('hidden');
  });
}
// 지원 목록에 없는 사이트: 그 사이트의 접근 권한을 받아 SubTutor 를 켠다 (영상의 자막을 플레이어가 받는 파일·<track>·텍스트 트랙에서 찾는다)
function offerSite(tab) {
  let u = null;
  try { u = tab && tab.url ? new URL(tab.url) : null; } catch (e) { u = null; }
  const Sites = globalThis.SubTutorSites;
  const host = u ? u.hostname.toLowerCase() : '';
  const known = host && (/(^|\.)(netflix|primevideo|disneyplus|youtube)\.com$/.test(host) || /(^|\.)amazon\./.test(host) || (Sites && Sites.forHost(host)));
  if (!u || !/^https?:$/.test(u.protocol)) { $('status').textContent = '이 탭에서는 실행 중이 아닙니다 (영상 재생 화면에서 열어 보세요)'; return; }
  if (known) { $('status').textContent = '이 탭에서는 아직 실행 중이 아닙니다 — 탭을 새로고침해 보세요'; return; }
  $('status').textContent = host + ' · 지원 목록에 없는 사이트';
  $('siteBox').classList.remove('hidden');
  $('siteHint').textContent = '이 사이트의 영상 자막을 찾아 패널·단축키·저장·더빙을 씁니다. 크롬이 이 사이트 접근 권한을 묻습니다.';
  $('addSite').addEventListener('click', async () => {
    // 권한 요청은 누른 그 순간에 해야 한다 (사용자 동작)
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [u.origin + '/*'] }); } catch (e) { granted = false; }
    if (!granted) { $('siteHint').textContent = '권한을 허용하지 않아 켜지 못했습니다.'; return; }
    const r = await chrome.runtime.sendMessage({ type: 'sites.add', origin: u.origin, tabId: tab.id }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (!r || !r.ok) { $('siteHint').textContent = '켜지 못했습니다: ' + ((r && r.error) || ''); return; }
    $('siteHint').textContent = '켰습니다. 탭을 새로고침하면 처음부터 자막을 찾습니다. ';
    const reload = document.createElement('button'); reload.className = 'small'; reload.textContent = '새로고침';
    reload.addEventListener('click', () => { chrome.tabs.reload(tab.id); window.close(); });
    $('siteHint').append(reload);
    $('addSite').disabled = true;
  });
}
// 지원 사이트 목록 (누르면 그 사이트를 연다)
function showSites() {
  const Sites = globalThis.SubTutorSites;
  const body = $('sitesBody'); body.textContent = '';
  const add = (name, url, about) => {
    const row = document.createElement('div'); row.className = 'site-row';
    const a = document.createElement('a'); a.href = url; a.textContent = name; a.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url }); });
    const s = document.createElement('span'); s.textContent = about;
    row.append(a, s); body.append(row);
  };
  add('넷플릭스', 'https://www.netflix.com/browse', '드라마·영화');
  add('유튜브', 'https://www.youtube.com/', '영상·뉴질랜드 교실 영상');
  add('프라임 비디오', 'https://www.primevideo.com/', '드라마·영화');
  add('디즈니+', 'https://www.disneyplus.com/', '애니메이션·드라마 (실험적)');
  if (Sites) for (const s of Sites.SITES) add(s.label, s.home, s.about);
  const p = document.createElement('p'); p.className = 'hint'; p.textContent = '목록에 없는 사이트는 그 사이트에서 이 팝업을 열고 "이 사이트에서 SubTutor 켜기"를 누르세요.';
  body.append(p);
  $('sitesBox').classList.remove('hidden');
}
init();
