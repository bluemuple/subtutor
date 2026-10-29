/*
 * SubTutor E2E: Chrome for Testing + 실제 확장 프로그램 + 모의 넷플릭스(https://www.netflix.com → 127.0.0.1:8443) + 웹사이트(http://localhost:8766)
 * 실행: NODE_PATH=<puppeteer가 설치된 node_modules> node tests/e2e/run.js
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { start } = require('./mock/server');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');
const TMP = path.join(__dirname, '.tmp');
const HEADLESS = process.env.HEADFUL ? false : true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log('  ✔ ' + name + ' (' + (Date.now() - t0) + 'ms)'); }
  catch (e) { results.push({ name, ok: false, error: e }); console.log('  ✖ ' + name + ' → ' + (e && e.message || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < (timeout || 10000)) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error('timeout: ' + (label || 'waitFor') + (last instanceof Error ? ' (' + last.message + ')' : ''));
}
const videoTime = (page) => page.evaluate(() => document.querySelector('video').currentTime);
const videoPaused = (page) => page.evaluate(() => document.querySelector('video').paused);
const setTime = (page, sec, play) => page.evaluate((s, p) => { const v = document.querySelector('video'); v.currentTime = s; if (p) v.play(); }, sec, !!play);

function ensureFixtures() {
  const { execSync } = require('child_process');
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(TMP, 'shots'), { recursive: true });
  const media = path.join(__dirname, 'mock', 'media', 'test.webm');
  if (!fs.existsSync(media)) {
    fs.mkdirSync(path.dirname(media), { recursive: true });
    console.log('▶ 모의 영상 생성 (ffmpeg)');
    execSync('ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x180:rate=10 -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 48 -c:v libvpx-vp9 -b:v 150k -deadline realtime -cpu-used 8 -c:a libopus -b:a 48k "' + media + '"', { stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(TMP, 'key.pem')) || !fs.existsSync(path.join(TMP, 'cert.pem'))) {
    console.log('▶ 자체 서명 인증서 생성 (openssl)');
    execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout "' + path.join(TMP, 'key.pem') + '" -out "' + path.join(TMP, 'cert.pem') + '" -days 60 -subj "/CN=www.netflix.com" -addext "subjectAltName=DNS:www.netflix.com,DNS:translate.googleapis.com,DNS:clients5.google.com"', { stdio: 'inherit' });
  }
}

(async () => {
  ensureFixtures();
  const servers = await start({ mockRoot: path.join(__dirname, 'mock'), docsRoot: path.join(ROOT, 'docs'), key: fs.readFileSync(path.join(TMP, 'key.pem')), cert: fs.readFileSync(path.join(TMP, 'cert.pem')) });
  const userDataDir = path.join(TMP, 'profile-' + Date.now());
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir,
    args: [
      '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
      '--host-resolver-rules=MAP www.netflix.com 127.0.0.1:8443, MAP www.youtube.com 127.0.0.1:8443, MAP translate.googleapis.com 127.0.0.1:8443, MAP clients5.google.com 127.0.0.1:8443',
      '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--window-size=1400,900',
    ],
    acceptInsecureCerts: true,
    defaultViewport: { width: 1400, height: 900 },
  });
  let failed = false;
  try {
    console.log('▶ 확장 프로그램 로딩');
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
    const sw = await swTarget.worker();
    assert(sw, 'service worker');
    // 모듈 import 가 있는 서비스 워커는 컨텍스트가 생긴 뒤 조금 있다가 스크립트가 실행된다
    await waitFor(() => sw.evaluate(() => typeof globalThis.__subtutorHandle === 'function' && !!(globalThis.chrome && chrome.storage)), 15000, 'service worker script ready');
    const extId = new URL(swTarget.url()).host;
    console.log('  extension id: ' + extId);
    await sw.evaluate(() => chrome.storage.local.clear());

    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push('[page ' + m.type() + '] ' + m.text()));
    page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
    console.log('▶ 모의 넷플릭스 페이지');
    await page.goto('https://www.netflix.com/watch/12345', { waitUntil: 'domcontentloaded' });

    await step('패널이 뜨고 자막 10줄이 목록에 표시된다', async () => {
      await page.waitForSelector('#st-panel', { timeout: 15000 });
      await waitFor(() => page.$$eval('.st-row', (r) => r.length === 10), 15000, 'rows');
      const first = await page.$eval('.st-row .st-en', (e) => e.textContent);
      assert(first === 'Hello there, welcome to the test.', 'first row text: ' + first);
    });
    await step('패널이 열리면 영상이 패널 왼쪽까지로 줄어든다 (CSS 규칙과 구조 탐색 보조 모두)', async () => {
      const right = () => page.evaluate(() => ({ right: Math.round(document.querySelector('video').getBoundingClientRect().right), inner: window.innerWidth, inline: document.querySelector('.watch-video').style.width }));
      let r = await right();
      assert(r.right <= r.inner - 400 + 1 && r.right > r.inner - 400 - 40, 'css rule: video right ' + JSON.stringify(r));
      assert(!r.inline, 'css path should not need inline width: ' + r.inline);
      // 플랫폼 CSS 가 안 먹는 상황(디즈니+ 같은 미지의 DOM)을 흉내: 규칙을 지우면 구조 탐색이 바깥쪽 조상부터 너비를 줄인다
      await page.evaluate(() => { document.getElementById('st-layout-style').textContent = ''; });
      await waitFor(async () => { const x = await right(); return x.right > x.inner - 400 + 4; }, 2000, 'overlap after removing css');
      await waitFor(async () => { const x = await right(); return x.right <= x.inner - 400 + 1; }, 4000, 'structural fit');
      r = await right();
      assert(/calc\((100vw - 400px|-400px \+ 100vw)\)/.test(r.inline), 'inline width applied to .watch-video: ' + r.inline);
      // 패널을 닫으면 원래대로
      await page.keyboard.press('Backquote');
      await waitFor(async () => { const x = await right(); return !x.inline && x.right === x.inner; }, 3000, 'restored on panel close');
      await page.keyboard.press('Backquote');
      await waitFor(() => page.evaluate(() => document.documentElement.classList.contains('st-panel-open')), 3000, 'panel reopened');
    });
    await step('한국어 자막 트랙이 영어 줄에 연결된다', async () => {
      const status = await page.$eval('.st-status', (e) => e.textContent);
      assert(/한국어 10줄 연결/.test(status), 'status: ' + status);
      const ko = await page.$$eval('.st-row .st-ko', (els) => els.map((e) => e.textContent));
      assert(ko[1].includes('래피'), 'ko row 2: ' + ko[1]);
    });
    await step('manifest 요청에 텍스트 자막 포맷이 추가되고 부분 하이드레이션이 꺼진다', async () => {
      const r = await page.evaluate(() => window.__patchedRequest);
      assert(r.params.profiles.includes('webvtt-lssdh-ios8'), 'profiles: ' + JSON.stringify(r.params.profiles));
      assert(r.params.supportsPartialHydration === false, 'supportsPartialHydration');
      assert(r.params.showAllSubDubTracks === true, 'showAllSubDubTracks');
    });
    await step('제목/에피소드가 플레이어 API에서 읽힌다', async () => {
      await waitFor(() => page.$eval('.st-brand', (e) => /Mock Show/.test(e.textContent) && /S1:E2/.test(e.textContent)), 8000, 'title');
    });
    await step('플랫폼 기본 자막이 숨겨진다', async () => {
      const vis = await page.$eval('.player-timedtext', (e) => getComputedStyle(e).visibility);
      assert(vis === 'hidden', 'visibility=' + vis);
    });
    await step('영상 위에 영어+한국어 자막이 같은 타이밍에 표시된다', async () => {
      await setTime(page, 6.3, true);
      await waitFor(() => page.evaluate(() => { const o = document.getElementById('st-overlay'); return o && !o.classList.contains('st-hidden') && o.querySelector('.st-ov-text').textContent.includes('Raffie') && o.querySelector('.st-ov-ko').textContent.includes('래피'); }), 5000, 'overlay');
      const active = await page.$eval('.st-row.active .st-en', (e) => e.textContent);
      assert(active.includes('Raffie'), 'active row: ' + active);
      await page.screenshot({ path: path.join(TMP, 'shots', 'netflix-overlay.png') });
      await waitFor(async () => (await videoTime(page)) > 8.2, 5000, 'past cue');
      const hidden = await page.$eval('#st-overlay', (o) => o.classList.contains('st-hidden'));
      assert(hidden, 'overlay should hide between cues');
    });
    await step('D: 다음 자막으로 이동', async () => {
      await setTime(page, 6.5, true);
      await sleep(200);
      await page.keyboard.press('KeyD');
      await waitFor(async () => { const t = await videoTime(page); return t >= 9.8 && t < 10.6; }, 4000, 'next cue time');
    });
    await step('A: 이전 자막으로 이동', async () => {
      await sleep(300);
      await page.keyboard.press('KeyA');
      await waitFor(async () => { const t = await videoTime(page); return t >= 5.8 && t < 6.6; }, 4000, 'prev cue time');
    });
    await step('F: 현재 자막 다시 듣기', async () => {
      await setTime(page, 7.4, true);
      await sleep(250);
      await page.keyboard.press('KeyF');
      await waitFor(async () => { const t = await videoTime(page); return t >= 5.8 && t < 6.6; }, 4000, 'replay time');
    });
    await step('S: 현재 자막 무한 반복', async () => {
      await setTime(page, 10.3, true);
      await sleep(250);
      const seeks0 = await page.evaluate(() => window.__seeks.length);
      await page.keyboard.press('KeyS');
      await sleep(5200);
      const t = await videoTime(page);
      const seeks1 = await page.evaluate(() => window.__seeks.length);
      assert(t >= 9.7 && t < 12.5, 'loop time ' + t);
      assert(seeks1 - seeks0 >= 2, 'loop seeks ' + (seeks1 - seeks0));
      await page.keyboard.press('KeyS');
      await sleep(200);
      const chip = await page.$('.st-ov-chip.on-loop');
      assert(!chip, 'loop chip should be gone');
    });
    await step('P: 자동 일시정지 — 자막 끝에서 멈추고 F로 다시 듣는다', async () => {
      await page.keyboard.press('KeyP');
      await waitFor(() => page.$eval('.st-mode', (b) => b.classList.contains('on')), 2000, 'AP on');
      await setTime(page, 13.6, true);
      await waitFor(async () => (await videoPaused(page)), 5000, 'paused at cue end');
      const t = await videoTime(page);
      assert(t >= 15.85 && t < 16.5, 'paused at ' + t);
      await sleep(200);
      const shown = await page.$eval('#st-overlay', (o) => !o.classList.contains('st-hidden') && o.querySelector('.st-ov-text').textContent.includes('facts'));
      assert(shown, 'overlay keeps the ended cue while paused');
      await page.keyboard.press('KeyF');
      await waitFor(async () => { const t2 = await videoTime(page); return !(await videoPaused(page)) && t2 >= 13.7 && t2 < 14.6; }, 4000, 'replay from start');
      await waitFor(async () => (await videoPaused(page)), 5000, 'paused again');
      const t3 = await videoTime(page);
      assert(t3 >= 15.85 && t3 < 16.5, 'paused again at ' + t3);
      await page.keyboard.press('KeyP');
      await sleep(200);
    });
    await step('W: 쉐도잉 — 자막 끝에서 1초 쉬고 자동으로 이어 재생', async () => {
      await page.select('.st-shadow-sec', '1');
      await page.keyboard.press('KeyW');
      await waitFor(() => page.$eval('.st-mode.st-shadow', (b) => b.classList.contains('on')), 2000, 'shadow on');
      await setTime(page, 17.7, true);
      await waitFor(async () => (await videoPaused(page)), 5000, 'paused at cue end');
      const tPause = await videoTime(page);
      assert(tPause >= 19.85 && tPause < 20.5, 'paused at ' + tPause);
      const countdown = await page.$eval('.st-ov-shadow', (e) => e.classList.contains('on'));
      assert(countdown, 'countdown visible');
      await page.screenshot({ path: path.join(TMP, 'shots', 'netflix-shadowing.png') });
      const t0 = Date.now();
      await waitFor(async () => !(await videoPaused(page)), 4000, 'resumed');
      const waited = Date.now() - t0;
      assert(waited >= 500 && waited <= 2500, 'resume delay ' + waited + 'ms');
      await page.keyboard.press('KeyW');
      await sleep(200);
    });
    await step('E: 현재 자막 저장(별표)', async () => {
      await setTime(page, 22.4, true);
      await sleep(300);
      await page.keyboard.press('KeyE');
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 1), 4000, 'saved row');
      const star = await page.$eval('.st-row.saved .st-star', (e) => e.textContent);
      assert(star === '★', 'star glyph');
      const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      assert(items && items.length === 1 && items[0].text.includes('frisbee'), 'storage items: ' + JSON.stringify(items));
      assert(items[0].translation.includes('프리스비'), 'translation saved: ' + items[0].translation);
      assert(items[0].title === 'Mock Show' && items[0].episode === 'S1:E2 The Test', 'title/episode: ' + items[0].title + '/' + items[0].episode);
      await page.evaluate(() => document.querySelector('video').pause());
    });
    await step('패널에서 줄을 누르면 그 위치로 이동하고 별표를 누르면 저장된다', async () => {
      await page.click('.st-row[data-i="7"]');
      await waitFor(async () => { const t = await videoTime(page); return t >= 29.7 && t < 30.6; }, 4000, 'row click seek');
      await page.evaluate(() => document.querySelector('video').pause());
      await page.hover('.st-row[data-i="8"]');
      await page.click('.st-row[data-i="8"] .st-star');
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 2), 4000, 'two saved');
      await page.click('.st-head .st-icon');
      await sleep(200);
      await page.screenshot({ path: path.join(TMP, 'shots', 'netflix-settings.png') });
      await page.click('.st-head .st-icon');
    });
    await step('기계 번역 경로: 한국어 트랙이 없는 줄은 번역 API(모의)로 채운다', async () => {
      const res = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'translate', texts: ['hello world'] }, {}));
      assert(res && res.translations && res.translations[0] === '[번역] hello world', 'mt: ' + JSON.stringify(res));
    });

    await step('오버레이는 화면 고정이며 영상 사각형 안에 그려진다', async () => {
      const r = await page.evaluate(() => {
        const o = document.getElementById('st-overlay'); const v = document.querySelector('video');
        const cs = getComputedStyle(o); const a = o.getBoundingClientRect(); const b = v.getBoundingClientRect();
        return { pos: cs.position, parent: o.parentElement.tagName, a: [a.left, a.top, a.width, a.height].map(Math.round), b: [b.left, b.top, b.width, b.height].map(Math.round) };
      });
      assert(r.pos === 'fixed' && r.parent === 'BODY', 'overlay should be fixed on body: ' + JSON.stringify(r));
      assert(Math.abs(r.a[0] - r.b[0]) <= 2 && Math.abs(r.a[2] - r.b[2]) <= 2 && Math.abs(r.a[1] - r.b[1]) <= 2, 'overlay rect should match video rect: ' + JSON.stringify(r));
      assert(r.b[2] < 1100, 'video should have shrunk for the panel: ' + r.b[2]);
    });
    await step('컨트롤 바의 ST 버튼으로 켜고 끌 수 있다', async () => {
      await waitFor(() => page.$('.st-ctl'), 5000, 'control button');
      const placed = await page.evaluate(() => { const w = document.querySelector('.st-ctl-wrap'); const nxt = w && w.nextElementSibling && w.nextElementSibling.querySelector('[data-uia]'); return { next: nxt && nxt.getAttribute('data-uia'), wrapClass: w && w.className, icon: !!document.querySelector('.st-ctl .st-ctl-svg text') }; });
      assert(placed.next === 'control-next' && /\bmedium\b/.test(placed.wrapClass) && placed.icon, 'ST placed left of next-episode with the neighbour wrapper class: ' + JSON.stringify(placed));
      await page.click('.st-ctl');
      await waitFor(() => page.evaluate(() => document.getElementById('st-panel').classList.contains('st-closed') && document.getElementById('st-overlay').classList.contains('st-hidden') && getComputedStyle(document.querySelector('.player-timedtext')).visibility === 'visible' && document.querySelector('.st-ctl').classList.contains('off')), 4000, 'disabled state');
      const tBefore = await videoTime(page);
      await page.keyboard.press('KeyD');
      await sleep(400);
      const tAfter = await videoTime(page);
      assert(Math.abs(tAfter - tBefore) < 1.5, 'keys must be inactive while disabled');
      await page.click('.st-ctl');
      await waitFor(() => page.evaluate(() => !document.getElementById('st-panel').classList.contains('st-closed') && !document.querySelector('.st-ctl').classList.contains('off')), 4000, 'enabled again');
      await sleep(400);
    });
    await step('영상별 자막 시간 보정이 표시·저장에 반영된다', async () => {
      await page.click('.st-head .st-icon');
      await page.waitForSelector('.st-settings:not(.st-hidden)');
      await page.evaluate(() => { const i = document.querySelector('.st-offset-ctl input'); i.value = '-2000'; i.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => page.$eval('.st-status', (e) => /보정 -2\.0초/.test(e.textContent)), 3000, 'offset in status');
      await page.click('.st-head .st-icon');
      // 자막 4번(14~16s) 은 보정 -2s 이면 영상 16~18s 에 표시된다
      await setTime(page, 16.4, true);
      await waitFor(() => page.evaluate(() => !document.getElementById('st-overlay').classList.contains('st-hidden') && document.querySelector('.st-ov-text').textContent.includes('facts')), 4000, 'shifted overlay');
      await page.keyboard.press('KeyE');
      await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); return items.some((i) => i.text.includes('facts') && i.startMs === 16000 && i.endMs === 18000 && i.offsetMs === -2000); }, 4000, 'saved in video time');
      await page.keyboard.press('KeyE');
      await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); return !items.some((i) => i.text.includes('facts')); }, 4000, 'unsaved');
      const stored = await sw.evaluate(async () => (await chrome.storage.local.get('offsets')).offsets);
      assert(stored && stored['netflix:12345'] && stored['netflix:12345'].ms === -2000, 'offset persisted: ' + JSON.stringify(stored));
      await page.click('.st-head .st-icon');
      await page.evaluate(() => { const b = [...document.querySelectorAll('.st-settings .st-btn')].find((x) => x.textContent === '보정 초기화'); b.click(); });
      await waitFor(() => page.$eval('.st-status', (e) => !/보정/.test(e.textContent)), 3000, 'offset reset');
      await page.click('.st-head .st-icon');
    });
    await step('[ ] \\ 키로 재생 속도를 바꾸고 반복 재생에도 유지된다', async () => {
      await setTime(page, 10.3, true);
      await sleep(200);
      await page.keyboard.press('BracketLeft');
      await page.keyboard.press('BracketLeft');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.8) < 0.01), 2000, 'rate 0.8');
      const chip = await page.$eval('.st-ov-chip.on-rate', (e) => e.textContent).catch(() => null);
      assert(chip && /0\.8×/.test(chip), 'rate chip: ' + chip);
      await page.keyboard.press('KeyS');
      await sleep(3200);
      const r1 = await page.evaluate(() => document.querySelector('video').playbackRate);
      assert(Math.abs(r1 - 0.8) < 0.01, 'rate kept during loop: ' + r1);
      const seeks = await page.evaluate(() => window.__seeks.length);
      await page.evaluate(() => { document.querySelector('video').playbackRate = 1; });
      await sleep(900);
      const r2 = await page.evaluate(() => document.querySelector('video').playbackRate);
      const seeks2 = await page.evaluate(() => window.__seeks.length);
      assert(seeks2 >= seeks, 'loop seeking');
      assert(Math.abs(r2 - 0.8) < 0.01 || seeks2 === seeks, 'rate re-applied after loop seek: ' + r2);
      await page.keyboard.press('KeyS');
      await page.keyboard.press('Backslash');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 2000, 'rate reset');
      for (let i = 0; i < 12; i++) await page.keyboard.press('BracketRight');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 2) < 0.01), 2000, 'rate capped at 2');
      await page.keyboard.press('Backslash');
      await sleep(200);
    });
    await step('재생 화면을 떠나면 패널이 닫히고 돌아오면 다시 열린다', async () => {
      await page.evaluate(() => history.pushState({}, '', '/browse'));
      await waitFor(() => page.evaluate(() => document.getElementById('st-panel').classList.contains('st-closed') && !document.documentElement.classList.contains('st-panel-open') && document.getElementById('st-toggle').classList.contains('st-hidden')), 3000, 'panel closed off-watch');
      await page.evaluate(() => history.pushState({}, '', '/watch/12345'));
      await waitFor(() => page.evaluate(() => !document.getElementById('st-panel').classList.contains('st-closed')), 4000, 'panel back');
      await waitFor(() => page.$$eval('.st-row', (r) => r.length === 10), 8000, 'rows back');
    });
    await step('넷플릭스 모의 영상을 중간 위치에 정지해 둔다', async () => {
      await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; });
      await sleep(200);
      const st = await page.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, ended: v.ended }; });
      assert(st.paused && !st.ended, 'parked: ' + JSON.stringify(st));
    });

    console.log('▶ 설정 페이지 (오디오 저장 폴더)');
    const opt = await browser.newPage();
    opt.on('pageerror', (e) => logs.push('[opt pageerror] ' + e.message));
    await opt.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'load' });
    await step('설정 페이지: 기본은 다운로드 폴더, 폴더 핸들을 넣으면 허용 상태로 표시된다', async () => {
      await waitFor(() => opt.$eval('#dirName', (e) => e.textContent === '크롬 다운로드 폴더'), 5000, 'default dir');
      // 폴더 선택 창은 자동화할 수 없으므로, 브라우저 내부 저장소(OPFS)의 폴더 핸들을 같은 자리에 넣어 저장 경로/권한 흐름을 검증한다
      await opt.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('e2e-docs', { create: true });
        await window.SubTutorFS.setHandle(dir);
      });
      await opt.reload({ waitUntil: 'load' });
      await waitFor(() => opt.$eval('#dirName', (e) => e.textContent === 'e2e-docs'), 5000, 'dir name');
      const perm = await opt.$eval('#permState', (e) => e.textContent);
      assert(/허용됨/.test(perm), 'perm ' + perm);
      const s = await waitFor(async () => { const r = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings); return r && r.audioDirName === 'e2e-docs' ? r : null; }, 5000, 'settings.audioDirName');
      assert(s.audioDirName === 'e2e-docs', 'settings.audioDirName ' + s.audioDirName);
      const st = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'audioDir.status' }, {}));
      assert(st.state === 'granted' && st.name === 'e2e-docs', 'sw status ' + JSON.stringify(st));
      await opt.screenshot({ path: path.join(TMP, 'shots', 'options-folder.png') });
    });

    await step('넷플릭스(탭 캡처 경로): 합성 신호로 녹음 파이프라인이 끊김·되풀이 없이 이어진다', async () => {
      // 실제 탭 캡처는 사용자 클릭(activeTab)이 필요하므로, 같은 파이프라인(MediaStreamTrackProcessor → 조각 배치 → 자르기 → MP3)에 300→900Hz 로 올라가는 합성 신호를 넣는다
      await sw.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: Object.assign({}, settings, { audioMode: 'store', captureTest: 'sweep' }) }); });
      await sleep(400);
      await setTime(page, 14.3, true);
      await sleep(300);
      await page.keyboard.press('KeyE');
      const b64 = await waitFor(() => sw.evaluate(async () => { const all = await chrome.storage.local.get(null); const k = Object.keys(all).find((x) => x.startsWith('audio:netflix:12345:14000')); return k ? all[k] : null; }), 30000, 'netflix stored audio').catch(async (e) => {
        const toastText = await page.$eval('.st-toast', (t) => t.textContent).catch(() => '');
        throw new Error(e.message + ' toast=' + toastText);
      });
      const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      const it = items.find((i) => i.id === 'netflix:12345:14000');
      assert(it && it.audio && it.audio.stats, 'audio stats: ' + JSON.stringify(it && it.audio));
      const st = it.audio.stats;
      assert(st.source === 'sweep' && st.chunks > 150 && st.errors === 0 && st.gaps === 0 && !st.readError, 'capture stats ' + JSON.stringify(st));
      assert(it.audio.ms > 2300 && it.audio.ms < 2800, 'clip length ' + it.audio.ms);
      // MP3 → PCM 으로 풀어 구간별 주파수(영교차)와 세기를 본다: 되풀이·끊김이 있으면 올라가는 모양이 깨진다
      const mp3 = path.join(TMP, 'e2e-netflix-sweep.mp3');
      fs.writeFileSync(mp3, Buffer.from(b64, 'base64'));
      const pcm = require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-i', mp3, '-f', 's16le', '-ac', '1', '-ar', '32000', '-'], { maxBuffer: 1 << 26 });
      const n = pcm.length / 2;
      const win = (frac) => { const a = Math.floor(n * frac), len = 32000 * 0.2; let cross = 0, prev = 0, sq = 0; for (let i = a; i < a + len; i++) { const v = pcm.readInt16LE(i * 2); sq += v * v; if ((v >= 0) !== (prev >= 0) && i > a) cross++; prev = v; } return { hz: Math.round(cross / 2 / 0.2), rms: Math.round(Math.sqrt(sq / len)) }; };
      const w = [0.1, 0.5, 0.85].map(win);
      assert(w.every((x) => x.rms > 1500), 'no silent gaps: ' + JSON.stringify(w));
      assert(w[0].hz > 250 && w[0].hz < 700 && w[2].hz > w[0].hz + 120 && w[1].hz > w[0].hz && w[2].hz > w[1].hz, 'rising sweep ' + JSON.stringify(w));
      // 정리: 별표 해제(항목·오디오 삭제), 설정 복원
      await page.keyboard.press('KeyE');
      await waitFor(() => sw.evaluate(async () => !((await chrome.storage.local.get('items')).items.find((i) => i.id === 'netflix:12345:14000'))), 5000, 'unstarred');
      await sw.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: Object.assign({}, settings, { audioMode: 'off', captureTest: '' }) }); });
      await sleep(300);
    });

    console.log('▶ 모의 유튜브 페이지');
    const yt = await browser.newPage();
    yt.on('pageerror', (e) => logs.push('[yt pageerror] ' + e.message));
    await yt.goto('https://www.youtube.com/watch?v=mock1234567', { waitUntil: 'domcontentloaded' });
    await step('유튜브: json3 자막 10줄 + 자동 번역 한국어가 연결된다', async () => {
      await yt.waitForSelector('#st-panel', { timeout: 15000 });
      await waitFor(() => yt.$$eval('.st-row', (r) => r.length === 10), 15000, 'yt rows');
      const status = await yt.$eval('.st-status', (e) => e.textContent);
      assert(/영어 10줄/.test(status) && !/자동 생성/.test(status), 'manual track preferred: ' + status);
      assert(/한국어 10줄 연결 \(유튜브 번역\)/.test(status), 'tlang merged: ' + status);
      await waitFor(() => yt.$eval('.st-brand', (e) => /Mock Lecture Title/.test(e.textContent) && /Mock Channel/.test(e.textContent)), 8000, 'yt title');
      const placed = await yt.evaluate(() => { const b = document.querySelector('.st-ctl'); return b && b.nextElementSibling.classList.contains('ytp-subtitles-button'); });
      assert(placed, 'control button before CC button');
      const layout = await yt.evaluate(() => ({ margin: getComputedStyle(document.querySelector('ytd-app')).marginRight, top: getComputedStyle(document.getElementById('st-panel')).top, videoRight: Math.round(document.querySelector('video').getBoundingClientRect().right) }));
      assert(layout.margin === '0px' && layout.top === '56px', 'panel overlays the page below the masthead: ' + JSON.stringify(layout));
    });
    await step('유튜브: D 키 이동과 오버레이', async () => {
      await setTime(yt, 6.3, true);
      await waitFor(() => yt.evaluate(() => !document.getElementById('st-overlay').classList.contains('st-hidden') && document.querySelector('.st-ov-text').textContent.includes('Raffie')), 5000, 'yt overlay');
      await yt.keyboard.press('KeyD');
      await waitFor(async () => { const t = await videoTime(yt); return t >= 9.8 && t < 10.6; }, 4000, 'yt next cue');
    });
    await step('유튜브: 별표 저장 시 대사 오디오를 캡처해 보관하고 지정 폴더에 MP3 로 쓴다', async () => {
      await yt.click('.st-head .st-icon');
      await yt.waitForSelector('.st-settings:not(.st-hidden)');
      const ok = await yt.evaluate(() => { const sel = [...document.querySelectorAll('.st-settings select')].find((s) => [...s.options].some((o) => o.value === 'both')); if (!sel) return false; sel.value = 'both'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; });
      assert(ok, 'audio mode select');
      await yt.click('.st-head .st-icon');
      await setTime(yt, 22.3, true);
      await sleep(300);
      await yt.keyboard.press('KeyE');
      const wavB64 = await waitFor(async () => {
        const r = await sw.evaluate(async () => { const all = await chrome.storage.local.get(null); const k = Object.keys(all).find((x) => x.startsWith('audio:youtube:mock1234567:')); return k ? all[k] : null; });
        return r || null;
      }, 25000, 'stored audio').catch(async (e) => {
        const toastText = await yt.$eval('.st-toast', (t) => t.textContent).catch(() => '');
        throw new Error(e.message + ' toast=' + toastText);
      });
      const buf = Buffer.from(wavB64, 'base64');
      assert(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0, 'mp3 sync bytes: ' + buf.slice(0, 4).toString('hex'));
      const file = path.join(TMP, 'e2e-clip.mp3');
      fs.writeFileSync(file, buf);
      const probe = require('child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'default=nw=1', file]).toString();
      assert(/codec_name=mp3/.test(probe) && /sample_rate=32000/.test(probe) && /channels=1/.test(probe), 'ffprobe: ' + probe.replace(/\s+/g, ' '));
      const durMs = parseFloat(/duration=([\d.]+)/.exec(probe)[1]) * 1000;
      assert(durMs > 1800 && durMs < 3700, 'clip duration ' + durMs);
      const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      const it = items.find((i) => i.platform === 'youtube');
      assert(it && it.audio && it.audio.format === 'mp3' && it.audio.rate === 32000, 'item audio meta: ' + JSON.stringify(it && it.audio));
      await yt.evaluate(() => document.querySelector('video').pause());
      // 지정 폴더: <폴더>/SubTutor/<작품 에피소드>/<시각 대사>.mp3 (원본 샘플레이트 128kbps) — 다운로드 폴더로는 가지 않는다
      const files = await opt.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const out = [];
        async function walk(dir, prefix) {
          for await (const [name, h] of dir.entries()) {
            if (h.kind === 'directory') await walk(h, prefix + name + '/');
            else { const f = await h.getFile(); const head = new Uint8Array(await f.slice(0, 2).arrayBuffer()); out.push({ path: prefix + name, size: f.size, head: Array.from(head) }); }
          }
        }
        await walk(await root.getDirectoryHandle('e2e-docs'), 'e2e-docs/');
        return out;
      });
      assert(files.length === 1 && /^e2e-docs\/SubTutor\/Mock Lecture Title Mock Channel\/00-2\d .+\.mp3$/.test(files[0].path), 'folder file ' + JSON.stringify(files));
      assert(files[0].size > 5000 && files[0].head[0] === 0xff && (files[0].head[1] & 0xe0) === 0xe0, 'mp3 in folder ' + JSON.stringify(files[0]));
      const dls = await sw.evaluate(() => new Promise((r) => chrome.downloads.search({}, r)));
      assert(dls.length === 0, 'no chrome download when folder works: ' + dls.length);
      const toastText = await yt.$eval('.st-toast', (t) => t.textContent).catch(() => '');
      assert(/e2e-docs\/SubTutor/.test(toastText), 'toast names folder: ' + toastText);
    });

    console.log('▶ 웹사이트');
    await browser.defaultBrowserContext().overridePermissions('http://localhost:8766', ['microphone']);
    const web = await browser.newPage();
    web.on('pageerror', (e) => logs.push('[web pageerror] ' + e.message));
    web.on('console', (m) => logs.push('[web ' + m.type() + '] ' + m.text()));
    web.on('dialog', (d) => d.accept());
    await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
    const trackClipEvents = () => web.evaluate(() => { window.__clipEvents = []; window.SubTutorBridge.on('clip.state', (p) => window.__clipEvents.push(Object.assign({ at: Date.now() % 100000 }, p))); }).catch(() => {});
    await trackClipEvents();
    const clipDiag = async () => {
      const ev = await web.evaluate(() => (window.__clipEvents || []).slice(-6)).catch(() => []);
      const mock = await page.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, t: v.currentTime, seeks: window.__seeks.slice(-5), pauses: window.__pauses.slice(-4), pauseCalls: (window.__pauseCalls || []).slice(-4) }; }).catch(() => null);
      const diag = await page.evaluate(() => { const b = [...document.querySelectorAll('.st-settings .st-btn')].find((x) => x.textContent === '진단 정보'); if (b) b.click(); const d = document.querySelector('.st-diag'); return d ? d.textContent.split('\n').slice(-2).join(' | ') : ''; }).catch(() => '');
      return ' events=' + JSON.stringify(ev) + ' mock=' + JSON.stringify(mock) + ' diag=' + diag;
    };
    await step('확장 프로그램이 감지되고 저장한 자막 3개가 보인다', async () => {
      await waitFor(() => web.$eval('#ext-status', (e) => e.classList.contains('ok')), 8000, 'ext ok');
      await waitFor(() => web.$$eval('.item', (r) => r.length === 3), 8000, 'items');
      const texts = await web.$$eval('.item .en', (els) => els.map((e) => e.textContent));
      assert(texts.some((t) => t.includes('frisbee')) && texts.some((t) => t.includes('Principal')), 'texts ' + texts);
      const groups = await web.$$eval('.group-title', (els) => els.map((e) => e.textContent));
      assert(groups.some((g) => g.includes('Mock Show') && g.includes('S1:E2')), 'group ' + groups);
    });
    await step('자막/뜻은 기본으로 감춰지고, 항목별·전체 토글로 보이거나 다시 감춘다', async () => {
      const veiled = await web.$$eval('.item', (els) => els.map((e) => e.classList.contains('veil-text') && e.classList.contains('veil-ko')));
      assert(veiled.length === 3 && veiled.every(Boolean), 'all veiled by default: ' + veiled);
      const enVisible = await web.$$eval('.item .en', (els) => els.filter((e) => e.offsetParent !== null).length);
      assert(enVisible === 0, 'no subtitle text visible: ' + enVisible);
      const labels = await web.$$eval('.hide-toggle', (b) => b.map((x) => x.textContent));
      assert(labels.join('|') === '자막 모두 보이기|뜻 모두 보이기', 'toolbar labels ' + labels.join('|'));
      // 항목 하나만 자막 열기 (가림막 클릭)
      await web.click('[data-id="netflix:12345:22000"] .veil-text-btn');
      const one = await web.evaluate(() => ({ open: document.querySelector('[data-id="netflix:12345:22000"] .en').offsetParent !== null, others: [...document.querySelectorAll('.item .en')].filter((e) => e.offsetParent !== null).length, btn: document.querySelector('[data-id="netflix:12345:22000"] .vis-text').textContent }));
      assert(one.open && one.others === 1 && one.btn === '자막 감추기', 'single reveal ' + JSON.stringify(one));
      // 항목의 "뜻" 버튼으로 뜻 열기
      await web.click('[data-id="netflix:12345:22000"] .vis-ko');
      const ko = await web.evaluate(() => document.querySelector('[data-id="netflix:12345:22000"] .ko').offsetParent !== null);
      assert(ko, 'ko revealed per item');
      // 전체 보이기 → 전체 감추기 (항목별로 연 것도 함께 닫힌다)
      await web.click('.hide-toggle[data-field="text"]');
      let n = await web.$$eval('.item .en', (els) => els.filter((e) => e.offsetParent !== null).length);
      assert(n === 3, 'all shown ' + n);
      const lbl = await web.$eval('.hide-toggle[data-field="text"]', (b) => b.textContent);
      assert(lbl === '자막 모두 감추기', 'label flipped ' + lbl);
      await web.click('.hide-toggle[data-field="text"]');
      n = await web.$$eval('.item .en', (els) => els.filter((e) => e.offsetParent !== null).length);
      assert(n === 0, 'all hidden again ' + n);
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-list-veiled.png') });
    });
    await step('정렬 옵션(작품별/전체 · 최신 위/아래)과 태그 지정·필터', async () => {
      const firstId = () => web.$eval('.item', (e) => e.dataset.id);
      const lastId = () => web.$$eval('.item', (els) => els[els.length - 1].dataset.id);
      await web.select('.toolbar select.sort', 'flat-new-top');
      assert((await firstId()).startsWith('youtube:'), 'flat newest first: ' + await firstId());
      assert(await web.$$eval('.group-title', (g) => g.length) === 0, 'no group titles in flat mode');
      const work = await web.$eval('.item .meta .work', (e) => e.textContent);
      assert(/Mock Lecture Title/.test(work), 'work label in flat mode: ' + work);
      await web.select('.toolbar select.sort', 'flat-new-bottom');
      assert((await lastId()).startsWith('youtube:'), 'flat newest last: ' + await lastId());
      await web.select('.toolbar select.sort', 'group-new-top');
      const g1 = await web.$eval('.group-title', (e) => e.textContent);
      assert(/Mock Lecture Title/.test(g1), 'newest work group first: ' + g1);
      await web.select('.toolbar select.sort', 'group-new-bottom');
      const gl = await web.$$eval('.group-title', (g) => g[g.length - 1].textContent);
      assert(/Mock Lecture Title/.test(gl), 'newest work group last: ' + gl);
      await web.select('.toolbar select.sort', 'group-time');
      assert(await web.evaluate(() => localStorage.getItem('subtutor.sort')) === 'group-time', 'sort persisted');
      // 태그: 항목에 붙이면 이름이 저장되고, 맨 위 태그를 누르면 그 자막만 보인다
      const sel = '[data-id="netflix:12345:22000"]';
      await web.click(sel + ' .tag-add');
      await web.waitForSelector(sel + ' .tag-input');
      await web.type(sel + ' .tag-input', '숙어');
      await web.keyboard.press('Enter');
      await waitFor(() => web.$$eval(sel + ' .tags-row .tag.small', (c) => c.map((x) => x.firstChild.textContent)).then((n) => (n.length ? n : null)), 5000, 'tag chip').then((names) => assert(names.join() === '숙어', 'item tags ' + names));
      await waitFor(() => web.$$eval('[data-tagbar] .tag', (c) => c.map((x) => x.firstChild.textContent + ':' + (x.querySelector('.n') ? x.querySelector('.n').textContent : ''))).then((c) => (c.includes('숙어:1') ? c : null)), 5000, 'tag bar');
      await web.evaluate(() => [...document.querySelectorAll('[data-tagbar] .tag')].find((x) => x.firstChild.textContent === '숙어').click());
      await waitFor(() => web.$$eval('.item', (r) => r.length === 1), 4000, 'filtered to tagged item');
      assert((await firstId()) === 'netflix:12345:22000', 'filtered item');
      await web.evaluate(() => [...document.querySelectorAll('[data-tagbar] .tag')].find((x) => x.firstChild.textContent === '전체').click());
      await waitFor(() => web.$$eval('.item', (r) => r.length === 3), 4000, 'filter cleared');
      const settings = await waitFor(async () => { const s = (await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) || {}; return (s.tagNames || []).includes('숙어') ? s : null; }, 5000, 'tagNames saved in settings');
      void settings;
      await web.reload({ waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 3), 8000, 'items after reload');
      const after = await web.$$eval(sel + ' .tags-row .tag.small', (c) => c.map((x) => x.firstChild.textContent));
      assert(after.join() === '숙어', 'tag persists after reload: ' + after);
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-list-tags.png') });
    });
    await step('오디오 구간 조정: ms 단위 버튼·드래그, 보관 오디오는 그 안에서 자르고 플레이어 재생은 조정 구간으로', async () => {
      const items = () => sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      const yt = '[data-id^="youtube:"]';
      await web.click(yt + ' .trim-toggle');
      await web.waitForSelector(yt + ' .trim-box:not(.hidden) canvas');
      await waitFor(() => web.$eval(yt + ' .trim-box canvas', (c) => c.width > 0), 5000, 'waveform drawn');
      for (let i = 0; i < 5; i++) await web.click(yt + ' .nudge[data-which="start"][data-d="100"]');
      const t1 = await waitFor(async () => { const it = (await items()).find((i) => i.id.startsWith('youtube:')); return it.trim && it.trim.startMs === it.startMs + 500 ? it : null; }, 5000, 'trim saved (+500ms start)');
      assert(t1.trim.endMs === t1.endMs, 'end unchanged');
      assert(/조정됨/.test(await web.$eval(yt + ' .meta .span', (e) => e.textContent)), 'meta shows 조정됨');
      // 끝 손잡이를 왼쪽으로 끌면 끝이 앞당겨진다
      const bb = await (await web.$(yt + ' .trim-handle.end')).boundingBox();
      await web.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await web.mouse.down();
      await web.mouse.move(bb.x + bb.width / 2 - 60, bb.y + bb.height / 2, { steps: 6 });
      await web.mouse.up();
      const t2 = await waitFor(async () => { const it = (await items()).find((i) => i.id.startsWith('youtube:')); return it.trim && it.trim.endMs < it.endMs - 100 ? it : null; }, 5000, 'end handle dragged');
      const expectMs = t2.trim.endMs - t2.trim.startMs;
      await web.click(yt + ' .play');
      await waitFor(() => web.$eval(yt, (e) => e.classList.contains('playing')), 5000, 'local trimmed playing');
      const t0 = Date.now();
      await waitFor(() => web.$eval(yt, (e) => !e.classList.contains('playing')), expectMs + 3000, 'local trimmed ended');
      const took = Date.now() - t0;
      assert(took > expectMs * 0.6 && took < expectMs + 1200, 'trimmed playback length ' + took + 'ms vs ' + expectMs + 'ms');
      await web.click(yt + ' .trim-reset');
      await waitFor(async () => !((await items()).find((i) => i.id.startsWith('youtube:')).trim), 5000, 'reset saved');
      await web.click(yt + ' .trim-ctl .btn:last-child');
      // 플레이어 재생 항목: 시작 +300ms → 플레이어가 그 위치(여유 150ms 앞)로 탐색하고 원래 끝에서 멈춘다
      const nf = '[data-id="netflix:12345:22000"]';
      await web.click(nf + ' .trim-toggle');
      await web.waitForSelector(nf + ' .trim-box:not(.hidden)');
      for (let i = 0; i < 3; i++) await web.click(nf + ' .nudge[data-which="start"][data-d="100"]');
      await waitFor(async () => { const it = (await items()).find((i) => i.id === 'netflix:12345:22000'); return it.trim && it.trim.startMs === 22300; }, 5000, 'remote trim saved');
      await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; window.__seeks = []; window.__pauses = []; });
      await web.click(nf + ' .play');
      await waitFor(() => page.evaluate(() => window.__seeks.some((x) => Math.abs(x - 22150) < 60)), 10000, 'player seeks to trimmed start').catch(async (e) => { throw new Error(e.message + ' seeks=' + JSON.stringify(await page.evaluate(() => window.__seeks.slice(-4)))); });
      await waitFor(() => web.$eval(nf, (e) => !e.classList.contains('playing')), 12000, 'remote trimmed ended');
      const pauses = await page.evaluate(() => window.__pauses);
      assert(pauses.length && pauses[pauses.length - 1] >= 24100 && pauses[pauses.length - 1] <= 24700, 'ended at original end: ' + JSON.stringify(pauses));
      await web.click(nf + ' .trim-reset');
      await waitFor(async () => !((await items()).find((i) => i.id === 'netflix:12345:22000').trim), 5000, 'remote reset');
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-trim.png') });
      await web.click(nf + ' .trim-ctl .btn:last-child');
    });
    await step('보관된 오디오가 있는 항목은 플레이어 탭 없이 바로 재생된다', async () => {
      const row = await web.$('[data-id^="youtube:"]');
      assert(row, 'youtube item row');
      const badge = await row.$eval('.has-audio', (e) => e.textContent).catch(() => null);
      assert(badge && badge.includes('오디오'), 'audio badge');
      await yt.evaluate(() => { window.__pauses = []; });
      await (await row.$('.play')).click();
      await waitFor(() => web.$eval('[data-id^="youtube:"]', (e) => e.classList.contains('playing')), 5000, 'local playing');
      await waitFor(() => web.$eval('[data-id^="youtube:"]', (e) => !e.classList.contains('playing')), 8000, 'local ended');
      const pauses = await yt.evaluate(() => window.__pauses);
      assert(pauses.length === 0, 'player tab untouched: ' + JSON.stringify(pauses));
    });
    await step('웹에서 ▶ 를 누르면 플레이어 탭이 그 구간만 재생하고 멈춘다', async () => {
      await page.evaluate(() => { window.__pauses = []; });
      await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; });
      const row = await web.$('[data-id="netflix:12345:22000"]');
      await (await row.$('.play')).click();
      await waitFor(() => web.$eval('[data-id="netflix:12345:22000"]', (e) => e.classList.contains('playing')), 8000, 'playing state');
      await waitFor(() => web.$eval('[data-id="netflix:12345:22000"] .state', (e) => e.textContent === ''), 15000, 'ended').catch(async (e) => {
        const st = await web.$eval('[data-id="netflix:12345:22000"] .state', (x) => x.textContent).catch(() => '?');
        const mock = await page.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, t: v.currentTime, ended: v.ended, seeks: window.__seeks.slice(-4), pauses: window.__pauses.slice(-4), vis: document.visibilityState }; });
        const diag = await page.evaluate(() => { const b = [...document.querySelectorAll('.st-settings .st-btn')].find((x) => x.textContent === '진단 정보'); if (b) b.click(); return document.querySelector('.st-diag') ? document.querySelector('.st-diag').textContent.split('\n').slice(-2).join(' | ') : ''; });
        throw new Error(e.message + ' state=' + st + ' mock=' + JSON.stringify(mock) + ' diag=' + diag);
      });
      const pauses = await page.evaluate(() => window.__pauses);
      const last = pauses[pauses.length - 1];
      assert(last >= 24100 && last <= 24700, 'paused at ' + JSON.stringify(pauses));
    });
    await step('재생 중 ◼ 를 누르면 플레이어가 바로 멈춘다', async () => {
      await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; window.__pauses = []; });
      const sel = '[data-id="netflix:12345:22000"]';
      await web.click(sel + ' .play');
      await waitFor(() => web.$eval(sel + ' .play', (e) => e.classList.contains('active')), 8000, 'playing');
      await sleep(500);
      await web.click(sel + ' .play');
      await waitFor(() => web.$eval(sel, (e) => !e.classList.contains('playing')), 3000, 'stopped state');
      await waitFor(() => videoPaused(page), 2500, 'player paused by stop');
      const t = await videoTime(page);
      assert(t < 24.0, 'stopped before the clip end: ' + t);
      await sleep(600);
      assert(await videoPaused(page), 'stays paused');
    });
    await step('🔁 반복: 보관 오디오·플레이어 재생을 되풀이하고, 다른 대사를 누르면 이전 것이 멈춘다', async () => {
      await web.click('.toolbar .repeat-toggle');
      assert(await web.$eval('.toolbar .repeat-toggle', (b) => b.classList.contains('on')), 'repeat on');
      const ytSel = '[data-id^="youtube:"]', nfSel = '[data-id="netflix:12345:22000"]';
      await web.click(ytSel + ' .play');
      await waitFor(() => web.$eval(ytSel, (e) => e.classList.contains('playing')), 5000, 'local playing');
      await sleep(7500); // 보관 오디오(약 2.7초)보다 훨씬 길게 — 반복이 아니면 끝났을 시간
      assert(await web.$eval(ytSel, (e) => e.classList.contains('playing')), 'local audio keeps looping');
      const st = await web.$eval(ytSel + ' .state', (e) => e.textContent);
      assert(/반복 재생 중/.test(st), 'state text ' + st);
      // 다른 대사(플레이어 원격 재생)를 누르면 이전 것은 멈추고 그 대사가 반복된다
      await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 5; window.__pauses = []; window.__seeks = []; });
      await web.click(nfSel + ' .play');
      await waitFor(() => web.$eval(ytSel, (e) => !e.classList.contains('playing')), 3000, 'previous stopped');
      await waitFor(() => web.$eval(nfSel + ' .play', (e) => e.classList.contains('active')), 10000, 'remote playing');
      // 구간 끝(24.4s+0.2s)에서 시작점(22.0s-0.15s)으로 되돌리는 탐색이 처음 재생 탐색 뒤에 한 번 더 기록돼야 한다
      await waitFor(() => page.evaluate(() => window.__seeks.filter((s) => Math.abs(s - 21850) < 120).length >= 2), 12000, 'loop seek back to start').catch(async (e) => {
        const d = await page.evaluate(() => ({ t: document.querySelector('video').currentTime, paused: document.querySelector('video').paused, seeks: window.__seeks.slice(-5), pauses: window.__pauses.slice(-3) }));
        throw new Error(e.message + ' ' + JSON.stringify(d));
      });
      const tLoop = await videoTime(page);
      assert(tLoop >= 21.5 && tLoop < 25, 'time inside the clip after loop: ' + tLoop);
      if (!(await web.$eval(nfSel, (e) => e.classList.contains('playing')))) throw new Error('still playing while looping' + await clipDiag());
      // 숨은 탭에서는 브라우저가 탐색 직후 잠깐 멈출 수 있고, 확장 프로그램이 곧바로 다시 재생한다
      await waitFor(async () => !(await videoPaused(page)), 3000, 'player resumes after loop seek').catch(async (e) => { throw new Error(e.message + await clipDiag()); });
      await web.click(nfSel + ' .play');
      await waitFor(() => videoPaused(page), 3000, 'paused after stop');
      await web.click('.toolbar .repeat-toggle');
      assert(!(await web.$eval('.toolbar .repeat-toggle', (b) => b.classList.contains('on'))), 'repeat off');
      await (await web.$(ytSel + ' .btn.danger')).click();
      await waitFor(() => web.$$eval('.item', (r) => r.length === 2), 5000, 'youtube item deleted');
      const left = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('audio:')));
      assert(left.length === 0, 'audio removed with item: ' + left);
    });
    await step('코멘트를 쓰면 저장되고 새로고침 후에도 남는다', async () => {
      const ta = await web.$('[data-id="netflix:12345:22000"] .comment');
      await ta.click();
      await ta.type('물다 = bite 메모');
      await web.keyboard.press('Tab');
      await sleep(400);
      await web.reload({ waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 2), 8000, 'items after reload');
      const v = await web.$eval('[data-id="netflix:12345:22000"] .comment', (e) => e.value);
      assert(v === '물다 = bite 메모', 'comment: ' + v);
    });
    await step('녹음: 3개까지 저장, 4번째에 첫 번째가 삭제된다', async () => {
      const clickRec = () => web.evaluate(() => document.querySelector('[data-id="netflix:12345:22000"] .rec-btn').click());
      for (let i = 0; i < 4; i++) {
        await clickRec();
        await waitFor(() => web.$eval('[data-id="netflix:12345:22000"] .rec-btn', (e) => e.classList.contains('recording')), 12000, 'recording ' + i).catch(async (e) => {
          const toastText = await web.$eval('#toast', (t) => t.textContent);
          throw new Error(e.message + ' toast=' + toastText + ' logs=' + logs.filter((l) => l.startsWith('[web')).slice(-5).join(' | '));
        });
        await sleep(700);
        await clickRec();
        await waitFor(() => web.$$eval('[data-id="netflix:12345:22000"] .attempt', (a, n) => a.length === n, Math.min(3, i + 1)), 6000, 'attempt count ' + i);
      }
      // 마지막 녹음 저장이 끝나 버튼이 다시 그려질 때까지 기다린다 (핸들이 떨어지는 경쟁 방지)
      await waitFor(() => web.$eval('[data-id="netflix:12345:22000"] .rec-btn', (e) => !e.classList.contains('recording')), 5000, 'recording stopped');
      await sleep(600);
      const n = await web.$$eval('.item .attempt', (a) => a.length);
      assert(n === 3, 'attempts ' + n);
      const latest = await web.$eval('.item .attempt.latest', (e) => e.firstChild.textContent);
      assert(latest === '3', 'latest chip ' + latest);
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-list-recordings.png') });
      const recs = await web.evaluate(async () => (await window.SubTutorRecorder.listAll()).map((r) => r.createdAt));
      assert(recs.length === 3 && recs[0] > 0, 'db recordings ' + recs.length);
    });
    await step('같이 듣기: 플레이어 오디오 뒤에 최근 녹음이 재생된다', async () => {
      const labels = await web.$$eval('[data-id="netflix:12345:22000"] .rec-row > button', (b) => b.map((x) => x.textContent));
      assert(/같이 듣기/.test(labels[labels.length - 1]), 'last button should be 같이 듣기: ' + labels.join(' | '));
      await trackClipEvents();
      await web.click('[data-id="netflix:12345:22000"] .rec-row > button:last-of-type');
      await waitFor(() => web.$eval('[data-id="netflix:12345:22000"]', (e) => e.classList.contains('playing')), 8000, 'clip playing').catch(async (e) => { throw new Error(e.message + await clipDiag()); });
      await waitFor(() => web.$$eval('.item .attempt.playing', (a) => a.length === 1), 15000, 'recording playing after clip');
    });
    await step('퀴즈: 받아쓰기 확인 후 C로 "알고 있는 표현" 상자로 이동', async () => {
      await web.goto('http://localhost:8766/#/quiz', { waitUntil: 'load' });
      await waitFor(() => web.$('.quiz-setup'), 8000, 'setup');
      await web.select('.quiz-setup select', 'Mock Show');
      await web.click('.quiz-setup .btn.primary');
      await waitFor(() => web.$('.dictation'), 8000, 'card');
      await sleep(300);
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-quiz-card.png') });
      const top = await web.$eval('.quiz-top', (e) => e.textContent);
      assert(/1 \/ 2/.test(top), 'progress ' + top);
      const answer = await web.evaluate(() => null);
      await web.type('.dictation', 'i can catch a frisby in my mouth');
      await web.keyboard.press('Enter');
      await waitFor(() => web.$('.quiz-result'), 5000, 'result');
      const score = await web.$eval('.score', (e) => e.textContent);
      assert(/정확도 88%/.test(score), 'score ' + score);
      const missing = await web.$$eval('.diff .missing', (els) => els.map((e) => e.textContent));
      assert(missing.join() === 'frisbee', 'missing ' + missing.join());
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-quiz-result.png') });
      await web.keyboard.press('KeyC');
      await waitFor(() => web.$eval('.quiz-top', (e) => /2 \/ 2/.test(e.textContent)), 5000, 'next card');
      await waitFor(() => web.$eval('#count-known', (e) => e.textContent === '1'), 5000, 'known count');
      void answer;
    });
    await step('퀴즈: Z(잊어버렸어)는 카드를 다시 큐에 넣는다', async () => {
      await web.type('.dictation', 'the only time');
      await web.keyboard.press('Enter');
      await waitFor(() => web.$('.quiz-result'), 5000, 'result 2');
      await web.keyboard.press('KeyZ');
      await waitFor(() => web.$eval('.quiz-top', (e) => /3 \/ 3/.test(e.textContent)), 5000, 'requeued card');
      const items = await waitFor(async () => {
        const all = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
        return all.find((i) => i.text.includes('Principal')).forgot === 1 ? all : null;
      }, 5000, 'stats written');
      const it = items.find((i) => i.text.includes('Principal'));
      assert(it.forgot === 1 && it.reviews === 1 && it.box === 'learning', 'stats ' + JSON.stringify({ forgot: it.forgot, reviews: it.reviews, box: it.box }));
      const known = items.find((i) => i.text.includes('frisbee'));
      assert(known.box === 'known', 'known box');
    });
    await step('알고 있는 표현 상자에서 다시 학습으로 되돌릴 수 있다', async () => {
      await web.goto('http://localhost:8766/#/known', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 1), 8000, 'known items');
      const btn = await web.$('.item .actions .btn');
      await btn.click();
      await waitFor(() => web.$eval('#count-known', (e) => e.textContent === '0'), 5000, 'moved back');
    });
    await step('웹에서 삭제하면 플레이어 패널의 별표도 꺼진다', async () => {
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 2), 8000, 'list');
      await web.click('.item .btn.danger');
      await waitFor(() => web.$$eval('.item', (r) => r.length === 1), 5000, 'deleted');
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 1), 6000, 'panel star updated');
    });
    await step('내보내기/가져오기 데이터 형식', async () => {
      const r = await web.evaluate(() => window.SubTutorBridge.request('items.import', { items: [{ id: 'netflix:999:1000', platform: 'netflix', videoId: '999', url: 'https://www.netflix.com/watch/999', title: 'Imported', episode: '', startMs: 1000, endMs: 2000, text: 'Imported line', translation: '', savedAt: Date.now(), box: 'learning' }] }));
      assert(r.added === 1 && r.total === 2, 'import ' + JSON.stringify(r));
    });

    const errors = logs.filter((l) => /error/i.test(l) && !/favicon|ERR_|net::/i.test(l));
    if (errors.length) console.log('  콘솔 오류:\n   ' + errors.slice(0, 10).join('\n   '));
  } catch (e) {
    failed = true;
    console.log('✖ 치명적 오류: ' + (e && e.stack || e));
  } finally {
    const bad = results.filter((r) => !r.ok);
    console.log('\n결과: ' + (results.length - bad.length) + '/' + results.length + ' 통과' + (bad.length ? ' — 실패: ' + bad.map((b) => b.name).join(', ') : ''));
    await browser.close().catch(() => {});
    servers.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    process.exit(failed || bad.length ? 1 : 0);
  }
})();
