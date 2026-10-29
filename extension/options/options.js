/* SubTutor 설정 페이지: 오디오 저장 폴더 선택과 권한 관리 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const FS = globalThis.SubTutorFS;
  const Ex = globalThis.SubTutorExplain;
  function showInfo(key) {
    const x = Ex && Ex.get(key);
    if (!x) return;
    $('infoTitle').textContent = x.title;
    const body = $('infoBody'); body.textContent = '';
    const p = document.createElement('p'); p.textContent = x.what; body.append(p);
    if (key === 'folder') { const h = document.createElement('h5'); h.textContent = '크롬의 폴더 권한'; const ul = document.createElement('ul'); ['크롬은 확장 프로그램이 받은 폴더 권한을 브라우저를 다시 시작하면(그리고 이 설정 탭을 모두 닫으면) 잠시 거둬 갑니다. 그동안은 다운로드 폴더/SubTutor 에 저장되고 플레이어에 안내가 뜹니다.', '툴바의 SubTutor 아이콘 → "폴더 권한 허용"을 누르면 다시 지정한 폴더에 저장됩니다.', '"다시 묻지 않게 고정" → 이 탭이 닫혔다 다시 열리면 "폴더 권한 허용"을 누르고 크롬 창에서 "매번 허용"(Allow on every visit)을 고르세요. 그 뒤로는 묻지 않습니다.', '다른 방법: 크롬 설정 › 다운로드 › 위치를 바꾸면 권한 없이도 그 폴더의 SubTutor 안에 저장됩니다.'].forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.append(li); }); body.append(h, ul); }
    if (x.why) { const h = document.createElement('h5'); h.textContent = '왜 이렇게 하나 (근거)'; const w = document.createElement('p'); w.textContent = x.why; body.append(h, w); }
    if (x.refs && x.refs.length) { const h = document.createElement('h5'); h.textContent = '참고 문헌'; const ul = document.createElement('ul'); x.refs.forEach((r) => { const li = document.createElement('li'); li.textContent = r; ul.append(li); }); body.append(h, ul); }
    $('infobox').classList.remove('hidden');
  }
  document.querySelectorAll('.info').forEach((b) => b.addEventListener('click', () => showInfo(b.dataset.key)));
  document.getElementById('infoClose').addEventListener('click', () => $('infobox').classList.add('hidden'));
  let settings = {};
  async function loadSettings() { const { settings: s } = await chrome.storage.local.get('settings'); settings = s || {}; }
  async function saveSettings(patch) { settings = Object.assign({}, settings, patch); await chrome.storage.local.set({ settings }); }
  function msg(text, kind) { $('msg').textContent = text || ''; $('msg').className = 'msg ' + (kind || ''); }

  const PERM = {
    granted: ['허용됨 ✓ (지정한 폴더에 저장)', 'ok'],
    prompt: ['다시 허용 필요 — 지금은 다운로드 폴더에 저장됩니다', 'warn'],
    denied: ['거부됨 — 폴더를 다시 선택하세요', 'bad'],
    none: ['— (폴더를 고르지 않았습니다)', ''],
  };
  async function refresh() {
    let st;
    try { st = await FS.status(); } catch (e) { st = { state: 'none' }; }
    const hasDir = st.state !== 'none';
    $('dirName').textContent = hasDir ? st.name : '크롬 다운로드 폴더';
    const [text, cls] = PERM[st.state] || PERM.prompt;
    $('permState').textContent = text; $('permState').className = cls;
    $('grant').classList.toggle('hidden', !(hasDir && st.state !== 'granted'));
    $('persist').classList.toggle('hidden', !(hasDir && st.state === 'granted'));
    $('reset').classList.toggle('hidden', !hasDir);
    $('pick').textContent = hasDir ? '📁 다른 폴더 선택…' : '📁 폴더 선택…';
    const name = hasDir ? st.name : '';
    if ((settings.audioDirName || '') !== name) await saveSettings({ audioDirName: name });
    return st;
  }
  $('pick').addEventListener('click', async () => {
    try {
      const h = await FS.pick();
      let perm = 'prompt';
      try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
      if (perm !== 'granted') { try { perm = await h.requestPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ } }
      await saveSettings({ audioDirName: h.name });
      await refresh();
      const modeHint = (settings.audioMode === 'download' || settings.audioMode === 'both') ? '' : ' 아래 "별표 저장 시 오디오"를 "PC에 MP3 파일로 저장"으로 바꿔야 파일이 저장됩니다.';
      if (perm === 'granted') msg('"' + h.name + '" 폴더에 저장합니다.' + modeHint + ' 브라우저를 다시 시작한 뒤에도 묻지 않게 하려면 "다시 묻지 않게 고정"을 눌러 두세요.', 'ok');
      else msg('폴더는 기억했지만 쓰기 권한이 허용되지 않았습니다. "폴더 권한 허용"을 눌러 주세요.', 'warn');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      msg('폴더를 고르지 못했습니다: ' + ((e && e.message) || e), 'bad');
    }
  });
  $('grant').addEventListener('click', async () => {
    const r = await FS.requestPermission();
    const st = await refresh();
    if (r === 'granted') msg('허용됐습니다. 이제 "' + st.name + '" 폴더에 저장합니다.', 'ok');
    else msg('아직 허용되지 않았습니다. 크롬이 허용 창을 띄우지 않으면 "다른 폴더 선택…"으로 폴더를 다시 골라 주세요.', 'warn');
    $('grant').classList.remove('pulse');
  });
  $('persist').addEventListener('click', () => {
    msg('이 탭을 닫았다가 다시 엽니다…');
    chrome.runtime.sendMessage({ type: 'options.reopenForGrant' }, () => void chrome.runtime.lastError);
  });
  $('reset').addEventListener('click', async () => {
    await FS.clear();
    await saveSettings({ audioDirName: '' });
    await refresh();
    msg('이제 크롬 다운로드 폴더의 SubTutor 안에 저장합니다.', 'ok');
  });
  $('audioMode').addEventListener('change', (e) => saveSettings({ audioMode: e.target.value }));

  async function init() {
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    await loadSettings();
    $('audioMode').value = settings.audioMode || 'off';
    const st = await refresh();
    if (location.hash === '#grant') {
      $('help').open = true;
      if (st.state === 'granted') msg('지금은 권한이 살아 있습니다. 나중에 "다시 허용 필요"로 바뀌면 이 페이지에서 "폴더 권한 허용"을 누르고 크롬 창에서 "매번 허용"을 고르세요.', 'ok');
      else if (st.state === 'prompt') { msg('2단계: "폴더 권한 허용"을 누르고, 크롬이 띄우는 창에서 "매번 허용" (Allow on every visit) 을 고르세요.', 'warn'); $('grant').classList.add('pulse'); $('grant').focus(); }
    }
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) { settings = ch.settings.newValue || {}; $('audioMode').value = settings.audioMode || 'off'; } });
  }
  init();
})();
