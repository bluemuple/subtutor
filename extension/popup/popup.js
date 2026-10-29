const DEFAULTS = { showTranslation: true, translationSource: 'auto', hideNative: true, overlay: true, panelOpen: true, fontScale: 100, autoPause: false, shadowing: false, shadowPauseSec: 2, leadMs: 150, tailMs: 200, offsetMs: 0 };
const $ = (id) => document.getElementById(id);
let settings = Object.assign({}, DEFAULTS);

function save(patch) {
  settings = Object.assign({}, settings, patch);
  chrome.storage.local.set({ settings });
  render();
}
function render() {
  $('panelOpen').checked = !!settings.panelOpen;
  $('showTranslation').checked = !!settings.showTranslation;
  $('hideNative').checked = !!settings.hideNative;
  $('autoPause').checked = !!settings.autoPause;
  $('shadowing').checked = !!settings.shadowing;
  $('shadowPauseSec').value = String(settings.shadowPauseSec);
}
async function init() {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  const sel = $('shadowPauseSec');
  for (let s = 1; s <= 7; s++) { const o = document.createElement('option'); o.value = s; o.textContent = s + '초'; sel.append(o); }
  const { settings: s } = await chrome.storage.local.get('settings');
  settings = Object.assign({}, DEFAULTS, s || {});
  render();
  ['panelOpen', 'showTranslation', 'hideNative'].forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: e.target.checked })));
  $('autoPause').addEventListener('change', (e) => save({ autoPause: e.target.checked, shadowing: e.target.checked ? false : settings.shadowing }));
  $('shadowing').addEventListener('change', (e) => save({ shadowing: e.target.checked, autoPause: e.target.checked ? false : settings.autoPause }));
  sel.addEventListener('change', (e) => save({ shadowPauseSec: +e.target.value }));
  $('openSite').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openSite' }, () => window.close()));
  $('openNetflix').addEventListener('click', () => chrome.tabs.create({ url: 'https://www.netflix.com/browse' }));

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'status' }).catch(() => null) : null;
    if (res && res.platform) {
      const names = { netflix: '넷플릭스', prime: '프라임 비디오', disney: '디즈니+' };
      $('status').textContent = (names[res.platform] || res.platform) + (res.videoId ? ' · ' + (res.title || res.videoId) + ' · 자막 ' + res.cues + '줄' : ' · 재생 화면이 아닙니다');
    } else {
      $('status').textContent = '이 탭에서는 실행 중이 아닙니다 (넷플릭스 재생 화면에서 열어 보세요)';
    }
  } catch (e) {
    $('status').textContent = '상태를 확인할 수 없습니다';
  }
}
init();
