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
  if (process.env.E2E_VERBOSE) console.log('  … ' + name + ' @' + new Date().toISOString().slice(11, 19));
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
    protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT) || 60000,
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
    await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { koMode: 'always' } }, {}));

    const page = await browser.newPage();
    const logs = [];
    page.on('dialog', (d) => { logs.push('[page dialog] ' + d.message()); d.dismiss().catch(() => {}); });
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
    await step('한국어 표시 방식: T 키를 누르는 동안만 보이고 패널 한국어는 흐리게', async () => {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { koMode: 'hold' } }, {}));
      await setTime(page, 6.3, true);
      await waitFor(() => page.evaluate(() => { const o = document.getElementById('st-overlay'); return !o.classList.contains('st-hidden') && o.querySelector('.st-ov-text').textContent.includes('Raffie') && o.querySelector('.st-ov-ko').textContent === ''; }), 5000, 'korean hidden by default');
      assert(await page.evaluate(() => getComputedStyle(document.querySelector('.st-row[data-i="1"] .st-ko')).filter !== 'none'), 'panel korean blurred');
      await page.keyboard.down('KeyT');
      await waitFor(() => page.evaluate(() => document.querySelector('.st-ov-ko').textContent.includes('래피')), 2000, 'korean while holding T');
      await page.keyboard.up('KeyT');
      await waitFor(() => page.evaluate(() => document.querySelector('.st-ov-ko').textContent === ''), 2000, 'korean hidden after release');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { koMode: 'always' } }, {}));
      await waitFor(() => page.evaluate(() => document.querySelector('.st-ov-ko').textContent.includes('래피')), 3000, 'always mode again');
    });
    await step('Q: 못 알아들음 표시 → 별표 저장 + 태그, 다시 누르면 해제', async () => {
      await page.keyboard.press('KeyQ');
      const it = await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = (items || []).find((i) => i.id === 'netflix:12345:6000'); return x && x.missed ? x : null; }, 6000, 'missed item saved');
      assert((it.tags || []).includes('못 알아들음'), 'missed tag: ' + JSON.stringify(it.tags));
      await waitFor(() => page.evaluate(() => document.querySelector('.st-ov-star').classList.contains('missed')), 3000, 'overlay star marks missed');
      const names = await sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings || {}).tagNames);
      assert(Array.isArray(names) && names.includes('못 알아들음'), 'tag name registered: ' + JSON.stringify(names));
      await page.keyboard.press('KeyQ');
      await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = (items || []).find((i) => i.id === 'netflix:12345:6000'); return x && !x.missed && !(x.tags || []).includes('못 알아들음'); }, 6000, 'missed cleared');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:6000' }, {}));
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 0), 5000, 'item removed');
    });
    await step('빈칸 자막: 단어를 가리고 V 로 공개', async () => {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { cloze: 'function' } }, {}));
      await waitFor(() => page.evaluate(() => /_{3,}/.test(document.querySelector('.st-ov-text').textContent) && document.querySelector('.st-ov-chip.on-cloze')), 4000, 'blanks shown');
      await page.keyboard.press('KeyV');
      await waitFor(() => page.evaluate(() => !/_{3,}/.test(document.querySelector('.st-ov-text').textContent) && document.querySelector('.st-ov-text').textContent.includes('Raffie')), 3000, 'revealed');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { cloze: 'off' } }, {}));
      await sleep(300);
    });
    await step('키위·학교 용어 주석과 소리 나는 대로 줄', async () => {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { soundsLike: true, kiwiNotes: true } }, {}));
      await setTime(page, 38.3, true);
      await waitFor(() => page.evaluate(() => document.querySelector('.st-ov-text').textContent.includes('Sweet as')), 5000, 'cue 10 shown');
      const ov = await page.evaluate(() => ({ kiwi: document.querySelector('.st-ov-kiwi').textContent, u: document.querySelectorAll('.st-ov-text u.st-kiwi').length, sound: document.querySelector('.st-ov-sound').textContent, row: document.querySelector('.st-row[data-i="9"] .st-kiwi-line') && document.querySelector('.st-row[data-i="9"] .st-kiwi-line').textContent, rowSound: document.querySelector('.st-row[data-i="9"] .st-sound') && document.querySelector('.st-row[data-i="9"] .st-sound').textContent }));
      assert(/sweet as = /.test(ov.kiwi) && /eh = /.test(ov.kiwi) && ov.u >= 2, 'kiwi gloss ' + JSON.stringify(ov));
      assert(/gonna/.test(ov.sound), 'sounds-like line ' + ov.sound);
      assert(ov.row && /sweet as/.test(ov.row) && ov.rowSound && /gonna/.test(ov.rowSound), 'panel row annotations ' + JSON.stringify(ov));
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { soundsLike: false } }, {}));
      await page.evaluate(() => document.querySelector('video').pause());
    });
    await step('어휘 프로파일: 상태줄의 말 속도·3천 밖 비율, 어휘 목록 상자, 에피소드 통계', async () => {
      const status = await page.$eval('.st-status', (e) => e.textContent);
      assert(/wpm/.test(status) && /3천 밖 \d+%/.test(status), 'status with profile: ' + status);
      await page.click('.st-foot-btn:nth-child(3)');
      await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-infobox'); return b && !b.classList.contains('st-hidden') && /이 에피소드 어휘/.test(b.textContent) && document.querySelectorAll('.st-vocab-row').length >= 1; }), 4000, 'vocab box');
      const words = await page.$$eval('.st-vocab-row b', (els) => els.map((e) => e.textContent));
      assert(words.includes('frisbee'), 'beyond-3k words include frisbee: ' + words.join(','));
      await page.click('.st-infobox-head .st-icon');
      const st = await waitFor(async () => { const r = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats); const e = r && r.episodes && r.episodes['netflix:12345']; return e && e.lines === 10 && e.watched >= 1 ? e : null; }, 8000, 'episode stats');
      assert(st.wpm > 0 && st.title === 'Mock Show', 'episode stat ' + JSON.stringify(st));
      const series = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats.series['netflix:Mock Show']);
      assert(series && series.episodes.includes('12345') && series.words.frisbee === 1, 'series words ' + JSON.stringify(series && Object.keys(series.words).slice(0, 5)));
    });
    await step('⚙ 설정: 설명은 ⓘ 뒤에만, 누르면 근거 상자', async () => {
      await page.click('.st-head .st-icon');
      await page.waitForSelector('.st-settings:not(.st-hidden)');
      const smalls = await page.$$eval('.st-settings small', (e) => e.length);
      assert(smalls === 0, 'no visible hint text: ' + smalls);
      const n = await page.$$eval('.st-settings .st-info', (e) => e.length);
      assert(n >= 12, 'info buttons: ' + n);
      await page.click('.st-settings .st-info[data-key="koMode"]');
      await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-infobox'); return b && !b.classList.contains('st-hidden') && /Mitterer/.test(b.textContent) && /참고 문헌/.test(b.textContent); }), 3000, 'basis box with references');
      await page.click('.st-infobox-head .st-icon');
      await page.click('.st-head .st-icon');
      await sleep(300);
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
    await step('W: 따라하기(고정 시간) — 자막 끝에서 1초 쉬고 자동으로 이어 재생', async () => {
      await page.select('.st-shadow-sec', 's1');
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
    await step('따라하기: 자막 길이 × 배율만큼 쉬었다가 다음 자막으로 이어 재생', async () => {
      try {
        // 앞 단계에서 재생 중이던 영상이 모드를 켜는 사이에 자막 끝을 지나가지 않도록, 멈춰 두고 자리를 잡은 뒤 켠다
        await page.evaluate(() => document.querySelector('video').pause());
        await setTime(page, 13.7, false);
        await sleep(300);
        await page.select('.st-shadow-sec', 'r1');   // 자막 길이 ×1.0 (목 자막은 한 줄이 2초)
        await page.keyboard.press('KeyW');
        await waitFor(() => page.$eval('.st-mode.st-shadow', (b) => b.classList.contains('on')), 2000, 'follow mode on');
        const chip = await page.$eval('.st-ov-chip.on-shadow', (e) => e.textContent).catch(() => '');
        assert(/따라하기 자막 길이 ×1$/.test(chip.trim()), 'mode chip shows the ratio: ' + chip);
        await page.evaluate(() => document.querySelector('video').play());
        await waitFor(async () => (await videoPaused(page)), 8000, 'paused at cue end');
        const tp = await videoTime(page);
        assert(tp >= 15.8 && tp < 16.9, '14–16초 자막 끝에서 멈춘다: ' + tp);
        const txt = await page.$eval('.st-ov-shadow', (e) => e.textContent);
        assert(/2초 뒤 다음 자막/.test(txt), '2초짜리 자막 → 2초 안내: ' + txt);
        const t0 = Date.now();
        await waitFor(async () => !(await videoPaused(page)), 6000, 'resumed by itself');
        const waited = Date.now() - t0;
        assert(waited >= 1300 && waited <= 3300, '약 2초 쉬고 이어 재생: ' + waited + 'ms');
        // 배율을 올리면 같은 자막에서 더 오래 쉰다
        await page.select('.st-shadow-sec', 'r1.5');
        await page.evaluate(() => document.querySelector('video').pause());
        await setTime(page, 17.7, false);
        await sleep(300);
        await page.evaluate(() => document.querySelector('video').play());
        await waitFor(async () => (await videoPaused(page)), 8000, 'paused again');
        const txt2 = await page.$eval('.st-ov-shadow', (e) => e.textContent);
        assert(/3초 뒤 다음 자막/.test(txt2), '×1.5 → 3초 안내: ' + txt2);
      } finally {
        await page.evaluate(() => { const b = document.querySelector('.st-mode.st-shadow.on'); if (b) b.click(); }).catch(() => {});
        await page.select('.st-shadow-sec', 's1').catch(() => {});
        await setTime(page, 10.3, true);
        await sleep(250);
      }
    });
    await step('E: 현재 자막 저장(별표)', async () => {
      await setTime(page, 22.4, true);
      await sleep(300);
      await page.keyboard.press('KeyE');
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 1), 4000, 'saved row');
      const star = await page.$eval('.st-row.saved .st-star', (e) => e.textContent);
      assert(star === '★', 'star glyph');
      // 저장 알림은 토스트가 아니라 영상 오른쪽 위의 작은 아이콘으로만
      const chipInfo = await waitFor(() => page.evaluate(() => { const c = document.querySelector('.st-chip'); if (!c || !c.classList.contains('show')) return null; const r = c.getBoundingClientRect(), v = document.querySelector('video').getBoundingClientRect(); return { cls: c.className, text: c.textContent, title: c.title, w: r.width, right: Math.round(v.right - r.right), top: Math.round(r.top - v.top) }; }), 3000, 'corner chip');
      assert(/st-chip-saved/.test(chipInfo.cls) && chipInfo.text === '★' && /저장했습니다/.test(chipInfo.title) && chipInfo.w <= 30 && chipInfo.right >= 8 && chipInfo.right <= 30 && chipInfo.top >= 8 && chipInfo.top <= 30, 'small ★ chip at the video top-right: ' + JSON.stringify(chipInfo));
      assert(!(await page.evaluate(() => { const t = document.querySelector('.st-toast'); return t && t.classList.contains('show') && /저장/.test(t.textContent); })), 'no save toast over the video');
      const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      assert(items && items.length === 1 && items[0].text.includes('frisbee'), 'storage items: ' + JSON.stringify(items));
      assert(items[0].translation.includes('프리스비'), 'translation saved: ' + items[0].translation);
      assert(items[0].title === 'Mock Show' && items[0].episode === 'S1:E2 The Test', 'title/episode: ' + items[0].title + '/' + items[0].episode);
      await page.evaluate(() => document.querySelector('video').pause());
    });
    await step('크롬 명령(Alt+E)·우클릭 메뉴 호출: 아이콘 없이 지금 자막을 저장하고, 이미 저장된 줄이면 중복 없이 표시한다', async () => {
      const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.netflix.com/*' }))[0].id);
      // 이미 저장된 줄(frisbee)에서 호출 → 중복 저장 없이 '이미 저장' 아이콘
      let r = await sw.evaluate((id) => globalThis.__subtutorInvoke({ id }, 'command'), tabId);
      assert(r && r.ok && r.did === 'already', 'invoke on a saved line: ' + JSON.stringify(r));
      await waitFor(() => page.evaluate(() => { const c = document.querySelector('.st-chip'); return c.classList.contains('show') && c.classList.contains('st-chip-saved') && /이미 저장/.test(c.title); }), 3000, 'already-saved chip');
      assert((await sw.evaluate(async () => (await chrome.storage.local.get('items')).items.length)) === 1, 'no duplicate item');
      // 다른 줄로 옮겨 우클릭 메뉴로 호출 → 그 줄이 저장된다
      await setTime(page, 26.4, true);
      await sleep(400);
      r = await sw.evaluate((id) => globalThis.__subtutorInvoke({ id }, 'menu'), tabId);
      assert(r && r.ok && r.did === 'save', 'invoke saves the shown line: ' + JSON.stringify(r));
      const it = await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); return (items || []).find((i) => i.id === 'netflix:12345:26000') || null; }, 5000, 'saved via invoke');
      assert(it.text && it.text.length > 3, 'saved item text: ' + it.text);
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 2), 3000, 'two saved rows');
      // 정리: 호출로 저장한 줄은 지운다
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:26000' }, {}));
      await waitFor(() => page.$$eval('.st-row.saved', (r) => r.length === 1), 5000, 'cleanup');
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
    await step('컨트롤 바 배속 버튼: ST 버튼 왼쪽에서 설정한 단계로 오르내린다', async () => {
      try {
        await waitFor(() => page.$('.st-rate'), 5000, 'rate control');
        const pos = await page.evaluate(() => {
          const r = document.querySelector('.st-rate');
          const c = document.querySelector('.st-ctl-wrap') || document.querySelector('.st-ctl');
          return { leftOfST: r.nextElementSibling === c, sameRow: Math.abs(r.getBoundingClientRect().top - c.getBoundingClientRect().top) < 14, label: document.querySelector('.st-rate-now').textContent, steps: document.querySelectorAll('.st-rate .st-rate-step').length };
        });
        assert(pos.leftOfST && pos.sameRow && pos.steps === 2 && pos.label === '1×', 'rate buttons left of ST: ' + JSON.stringify(pos));
        await page.click('.st-rate-up');                 // 1 → 1.15 (설정한 다음 단계)
        await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1.15) < 0.01), 3000, 'up to 1.15');
        assert(await page.$eval('.st-rate-now', (e) => e.textContent) === '1.15×', 'label follows the rate');
        await page.click('.st-rate-down');
        await page.click('.st-rate-down');                // 1.15 → 1 → 0.9 (연속으로 눌러도 빠뜨리지 않는다)
        await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.9) < 0.01), 3000, 'down to 0.9');
        await page.click('.st-rate-now');                 // 가운데를 누르면 보통 속도
        await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 3000, 'back to 1');
        // SubTutor 를 끄면 배속 버튼도 사라진다 (끄고 켜는 것은 설정으로 — 패널이 밀려나는 동안 버튼 자리가 가려져 연달아 클릭하면 어긋난다)
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { enabled: { netflix: false } } }, {}));
        await waitFor(() => page.$eval('.st-rate', (e) => e.style.display === 'none'), 4000, 'hidden while off');
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { enabled: {} } }, {}));
        await waitFor(() => page.$eval('.st-rate', (e) => e.style.display !== 'none'), 4000, 'back when on');
      } finally {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { enabled: {} } }, {})).catch(() => {});
        await page.keyboard.press('Backslash').catch(() => {});
        await sleep(300);
      }
    });
    await step('Shift+< / Shift+> : 설정한 배속으로 한 단계씩 (유튜브는 유튜브 기능에 맡긴다)', async () => {
      try {
        const shift = async (code) => { await page.keyboard.down('Shift'); await page.keyboard.press(code); await page.keyboard.up('Shift'); };
        await shift('Period');                            // Shift+> 한 단계 빠르게: 1 → 1.15
        await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1.15) < 0.01), 3000, 'Shift+> → 1.15');
        await shift('Period');                            // 가장 빠른 단계에서 더 누르면 그대로
        await sleep(300);
        assert(await page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1.15) < 0.01), 'stays at the top step');
        await shift('Comma'); await shift('Comma'); await shift('Comma');  // 1.15 → 1 → 0.9 → 0.8
        await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.8) < 0.01), 3000, 'Shift+< → 0.8');
        assert(await page.$eval('.st-rate-now', (e) => e.textContent) === '0.8×', 'control bar label follows the keys');
        // Shift 없이 누르면 우리 기능이 아니다 (플레이어의 , . 는 그대로 둔다)
        await page.keyboard.press('Period');
        await sleep(300);
        assert(await page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.8) < 0.01), 'plain . does nothing');
      } finally {
        await page.keyboard.press('Backslash').catch(() => {});
        await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 3000, 'rate reset').catch(() => {});
      }
    });
    await step('반복 속도 사다리: 웹 설정의 단계대로 S 반복마다 올라가고, 끄면 원래 속도 (음높이 유지)', async () => {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { loopLadder: true } }, {}));
      await sleep(300);
      await setTime(page, 2.3, true);
      await sleep(300);
      await page.keyboard.press('KeyS');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.8) < 0.01), 3000, 'ladder starts at 0.8');
      // 플레이어 재생도 음높이를 유지한다 (크롬 기본값이지만 직접 켜 둔다)
      assert(await page.evaluate(() => { const v = document.querySelector('video'); return !('preservesPitch' in v) || v.preservesPitch === true; }), 'preservesPitch on the video element');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.9) < 0.01), 8000, 'second pass at 0.9');
      // 웹에서 정한 단계를 따른다: 0.55 → 1.3 으로 바꾸면 다음 반복부터 그 값으로
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.55, 1.3], ladderPitch: true } } }, {}));
      await sleep(300);
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1.3) < 0.01), 10000, 'follows the web ladder settings (1.3)');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true } } }, {}));
      await page.keyboard.press('KeyS');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 3000, 'rate restored');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { loopLadder: false } }, {}));
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
      try {
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
      } finally {
        // 정리(검사가 실패해도 실행): 별표 해제로 항목·오디오 삭제, 설정 복원 — 안 하면 뒤 단계의 항목 수가 어긋나 줄줄이 실패한다
        const still = () => sw.evaluate(async () => !!(((await chrome.storage.local.get('items')).items || []).find((i) => i.id === 'netflix:12345:14000')));
        if (await still()) {
          await page.keyboard.press('KeyE');
          await waitFor(async () => !(await still()), 5000, 'unstarred').catch(() => sw.evaluate(() => globalThis.__subtutorHandle({ type: 'web.items.removeMany', payload: { ids: ['netflix:12345:14000'] } }, {})));
        }
        await sw.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: Object.assign({}, settings, { audioMode: 'off', captureTest: '' }) }); });
        await sleep(300);
      }
    });

    console.log('▶ 모의 유튜브 페이지');
    const yt = await browser.newPage();
    let ytClipB64 = null; // 유튜브 저장 단계의 MP3 (파일 = 웹 복사본) — 뒤 단계에서 비교에 쓴다
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
      // 유튜브에는 자체 배속 메뉴와 Shift+< , Shift+> 가 이미 있어 우리 배속 버튼·단축키를 넣지 않는다
      assert(!(await yt.$('.st-rate')), 'no rate buttons on YouTube');
      await yt.keyboard.down('Shift'); await yt.keyboard.press('Period'); await yt.keyboard.up('Shift');
      await sleep(300);
      assert(await yt.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 'Shift+> left to YouTube');
      const layout = await yt.evaluate(() => ({ margin: getComputedStyle(document.querySelector('ytd-app')).marginRight, top: getComputedStyle(document.getElementById('st-panel')).top, videoRight: Math.round(document.querySelector('video').getBoundingClientRect().right) }));
      assert(layout.margin === '0px' && layout.top === '56px', 'panel overlays the page below the masthead: ' + JSON.stringify(layout));
    });
    await step('유튜브: D 키 이동과 오버레이', async () => {
      await setTime(yt, 6.3, true);
      await waitFor(() => yt.evaluate(() => !document.getElementById('st-overlay').classList.contains('st-hidden') && document.querySelector('.st-ov-text').textContent.includes('Raffie')), 5000, 'yt overlay');
      await yt.keyboard.press('KeyD');
      await waitFor(async () => { const t = await videoTime(yt); return t >= 9.8 && t < 10.6; }, 4000, 'yt next cue');
    });
    await step('유튜브에서도 따라하기: 자막 길이만큼 쉬었다가 다음 자막으로 이어 재생', async () => {
      try {
        // 멈춰 두고 자리를 잡은 뒤 모드를 켠다 (켜는 사이에 자막 끝을 지나가면 거기서 멈춰 버린다)
        await yt.evaluate(() => document.querySelector('video').pause());
        await setTime(yt, 13.7, false);
        await sleep(300);
        await yt.select('.st-shadow-sec', 'r1');   // 자막 길이 ×1.0 (유튜브 목 자막도 한 줄 2초)
        await yt.keyboard.press('KeyW');
        await waitFor(() => yt.$eval('.st-mode.st-shadow', (b) => b.classList.contains('on')), 3000, 'follow mode on (youtube)');
        await yt.evaluate(() => document.querySelector('video').play());
        await waitFor(async () => (await videoPaused(yt)), 8000, 'paused at cue end');
        const t = await videoTime(yt);
        assert(t >= 15.8 && t < 16.8, 'paused at the end of the 14–16s cue: ' + t);
        const txt = await yt.$eval('.st-ov-shadow', (e) => e.textContent);
        assert(/2초 뒤 다음 자막/.test(txt), 'countdown says 2s: ' + txt);
        const t0 = Date.now();
        await waitFor(async () => !(await videoPaused(yt)), 6000, 'resumed by itself');
        const waited = Date.now() - t0;
        assert(waited >= 1300 && waited <= 3300, '약 2초 쉬고 이어 재생: ' + waited + 'ms');
      } finally {
        await yt.evaluate(() => { const b = document.querySelector('.st-mode.st-shadow.on'); if (b) b.click(); }).catch(() => {});
        await yt.select('.st-shadow-sec', 's1').catch(() => {});
        await yt.evaluate(() => document.querySelector('video').pause()).catch(() => {});
        await sleep(200);
      }
    });
    await step('유튜브: 별표 저장(PC 파일 모드) 시 지정 폴더에 MP3 를 하나만 쓰고, 복사본은 두지 않는다', async () => {
      await yt.click('.st-head .st-icon');
      await yt.waitForSelector('.st-settings:not(.st-hidden)');
      const ok = await yt.evaluate(() => { const sel = [...document.querySelectorAll('.st-settings select')].find((s) => [...s.options].some((o) => o.value === 'download')); if (!sel || [...sel.options].some((o) => o.value === 'both')) return false; sel.value = 'download'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; });
      assert(ok, 'audio mode select (download, no legacy both)');
      await yt.click('.st-head .st-icon');
      await setTime(yt, 22.3, true);
      await sleep(300);
      await yt.keyboard.press('KeyE');
      // 지정 폴더에 MP3 가 하나 생긴다 (확장 프로그램 저장소에는 복사본을 두지 않는다)
      const folderFile = await waitFor(async () => {
        const got = await opt.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const out = [];
          async function walk(dir, prefix) { for await (const [name, h] of dir.entries()) { if (h.kind === 'directory') await walk(h, prefix + name + '/'); else { const f = await h.getFile(); out.push({ path: prefix + name, size: f.size, b64: await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); }) }); } } }
          await walk(await root.getDirectoryHandle('e2e-docs'), 'e2e-docs/');
          return out;
        });
        return got.length === 1 && got[0].size > 5000 ? got[0] : null;
      }, 25000, 'mp3 written to the chosen folder').catch(async (e) => {
        const chipText = await yt.$eval('.st-chip', (t) => t.title).catch(() => '');
        throw new Error(e.message + ' chip=' + chipText);
      });
      ytClipB64 = folderFile.b64;
      const buf = Buffer.from(ytClipB64, 'base64');
      assert(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0, 'mp3 sync bytes: ' + buf.slice(0, 4).toString('hex'));
      const file = path.join(TMP, 'e2e-clip.mp3');
      fs.writeFileSync(file, buf);
      const probe = require('child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'default=nw=1', file]).toString();
      const probeRate = +((/sample_rate=(\d+)/.exec(probe) || [])[1] || 0);
      assert(/codec_name=mp3/.test(probe) && probeRate >= 32000 && /channels=1/.test(probe), 'ffprobe: ' + probe.replace(/\s+/g, ' '));
      const durMs = parseFloat(/duration=([\d.]+)/.exec(probe)[1]) * 1000;
      assert(durMs > 2300 && durMs < 3300, 'clip duration ' + durMs + ' (cue 2000ms + 앞뒤 250ms 여유)');
      const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      const it = items.find((i) => i.platform === 'youtube');
      assert(it && !it.audio, 'no web copy beside the file: ' + JSON.stringify(it && it.audio));
      assert(it.file && it.file.location === 'folder' && it.file.format === 'mp3' && Number.isFinite(it.file.leadMs), 'file meta: ' + JSON.stringify(it.file));
      const audioKeys = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('audio:')));
      assert(audioKeys.length === 0, 'extension storage holds no MP3 copy: ' + JSON.stringify(audioKeys));
      await yt.evaluate(() => document.querySelector('video').pause());
      // 지정 폴더: <폴더>/SubTutor/<작품 에피소드>/<시각 대사>.mp3 (원본 샘플레이트 128kbps) — 다운로드 폴더로는 가지 않는다
      assert(/^e2e-docs\/SubTutor\/Mock Lecture Title Mock Channel\/00-2\d .+\.mp3$/.test(folderFile.path), 'folder file path ' + folderFile.path);
      assert(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0, 'mp3 in folder ' + folderFile.path);
      const dls = await sw.evaluate(() => new Promise((r) => chrome.downloads.search({}, r)));
      assert(dls.length === 0, 'no chrome download when folder works: ' + dls.length);
      const chipTitle = await yt.$eval('.st-chip', (c) => c.className + '|' + c.textContent + '|' + c.title).catch(() => '');
      assert(/st-chip-audio/.test(chipTitle) && /\|♪\|/.test(chipTitle) && /e2e-docs\/SubTutor/.test(chipTitle) && /MP3 는 이 파일 하나/.test(chipTitle), 'corner ♪ chip names the folder (no toast): ' + chipTitle);
      assert(!(await yt.evaluate(() => { const t = document.querySelector('.st-toast'); return t && t.classList.contains('show'); })), 'no toast after saving the MP3');
    });

    console.log('▶ 웹사이트');
    await browser.defaultBrowserContext().overridePermissions('http://localhost:8766', ['microphone']);
    const web = await browser.newPage();
    web.on('pageerror', (e) => logs.push('[web pageerror] ' + e.message));
    web.on('console', (m) => logs.push('[web ' + m.type() + '] ' + m.text()));
    web.on('dialog', (d) => { logs.push('[web dialog] ' + d.message()); d.accept(); });
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
    await step('쉐도잉 세션: 듣기 → 속으로 → 글 보며 → 녹음 → 비교', async () => {
      await web.goto('http://localhost:8766/#/shadow', { waitUntil: 'load' });
      await waitFor(() => web.$('.quiz-setup'), 8000, 'shadow setup');
      await web.select('.quiz-setup select', 'Mock Lecture Title');
      await web.click('.quiz-setup .btn.primary');
      await waitFor(() => web.$eval('.steps .step.on', (e) => e.textContent.startsWith('1')), 5000, 'step 1');
      await waitFor(() => web.$eval('.shadow-card', (e) => e.classList.contains('playing')), 6000, 'autoplay step 1');
      assert(await web.$eval('.shadow-card .answer', (e) => e.classList.contains('veiled-text')), 'text hidden at step 1');
      await web.keyboard.press('KeyN'); await web.keyboard.press('KeyN');
      await waitFor(() => web.$eval('.steps .step.on', (e) => e.textContent.startsWith('3')), 4000, 'step 3');
      assert(await web.$eval('.shadow-card .answer', (e) => !e.classList.contains('veiled-text') && /frisbee/.test(e.textContent)), 'text shown at step 3');
      await web.keyboard.press('KeyN');
      await waitFor(() => web.$eval('.steps .step.on', (e) => e.textContent.startsWith('4')), 4000, 'step 4');
      await web.click('.shadow-card .quiz-audio .play');
      await waitFor(() => web.$eval('.steps .step.on', (e) => e.textContent.startsWith('5')), 20000, 'recorded then compare').catch(async (e) => { throw new Error(e.message + ' toast=' + await web.$eval('#toast', (t) => t.textContent)); });
      await waitFor(() => web.$$eval('.shadow-card .attempt', (a) => a.length === 1), 5000, 'one recording saved');
      await web.keyboard.press('KeyN');
      await waitFor(() => web.$eval('.quiz-card', (e) => /끝/.test(e.textContent) || /2 \/ /.test(e.textContent)), 8000, 'next item or done');
      await web.evaluate(async () => { await window.SubTutorRecorder.clearAll(); });
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 3), 8000, 'back to list');
      await waitFor(() => web.$eval('#count-due', (e) => e.textContent === '3'), 5000, 'due badge');
    });
    await step('속도 사다리 ⤴: 기본 4단계(0.8→0.9→1.0→1.15배)를 음높이를 유지한 채 재생', async () => {
      const yt = '[data-id^="youtube:"]';
      assert(/0\.8 → 0\.9 → 1 → 1\.15×/.test(await web.$eval(yt + ' .ladder', (b) => b.title)) && /음높이 유지/.test(await web.$eval(yt + ' .ladder', (b) => b.title)), 'ladder button title: ' + await web.$eval(yt + ' .ladder', (b) => b.title));
      await web.click(yt + ' .ladder');
      const seen = new Set();
      await waitFor(async () => { const t = await web.$eval('#toast', (e) => e.textContent); const m = /⤴ ([\d.]+)×/.exec(t); if (m) seen.add(m[1]); return seen.has('1.15'); }, 25000, 'ladder reached 1.15×').catch(async (e) => { const dbg = await web.evaluate(() => JSON.stringify(window.__subtutorDebug ? { clip: window.__subtutorDebug.state.clip, ladderFor: window.__subtutorDebug.state.ladderFor, local: window.__subtutorDebug.state.clipLocal, toast: document.getElementById('toast').textContent, shadow: !!window.__subtutorDebug.state.shadow, log: window.__subtutorDebug.log.slice(-8) } : null)); throw new Error(e.message + ' seen=' + [...seen].join(',') + ' dbg=' + dbg); });
      // 음높이 유지: 배속마다 미리 늘인/줄인 소리를 1배속으로 재생한다 (playbackRate 를 바꾸면 목소리가 굵어지거나 가늘어진다)
      const lastClip = await web.evaluate(() => window.__subtutorDebug.state.lastClip);
      assert(lastClip && lastClip.pitched === true && lastClip.speed === 1, 'pitch-preserved playback: ' + JSON.stringify(lastClip));
      await waitFor(() => web.$eval(yt, (e) => !e.classList.contains('playing')), 6000, 'ladder finished');
      assert(seen.has('0.8') && seen.has('1'), 'rates seen ' + [...seen].join(','));
    });
    await step('대사마다의 배속 버튼: 설정한 배속이 그대로 나오고, 반복을 켜면 그 배속으로 계속 반복된다', async () => {
      const yt = '[data-id^="youtube:"]';
      try {
        // 설정한 4단계가 그대로 버튼으로 나온다
        const labels = await web.$$eval(yt + ' .rate-btns .rate-btn', (b) => b.map((x) => x.textContent));
        assert(labels.join(',') === '0.8,0.9,1,1.15', 'rate buttons: ' + labels.join(','));
        // 자막·뜻 버튼과 같은 줄에 있어 카드 높이가 늘지 않는다
        const row = await web.evaluate((s) => {
          const card = document.querySelector(s);
          const ko = card.querySelector('.vis-ko').getBoundingClientRect();
          const r = card.querySelector('.rate-btn').getBoundingClientRect();
          return { same: Math.abs(ko.top - r.top) < 6, after: r.left > ko.right };
        }, yt);
        assert(row.same && row.after, 'rate buttons sit on the 자막·뜻 row: ' + JSON.stringify(row));
        // 0.9 버튼 → 그 배속으로 한 번 재생 (음높이 유지, 반복 꺼짐)
        await web.click(yt + ' .rate-btn[data-rate="0.9"]');
        await waitFor(() => web.$eval(yt + ' .rate-btn[data-rate="0.9"]', (b) => b.classList.contains('on')), 8000, '0.9 button on');
        const live = await web.evaluate(() => ({ rate: window.__subtutorDebug.state.playRate, clip: window.__subtutorDebug.state.lastClip, loop: window.__subtutorDebug.state.clip.loop }));
        assert(live.rate === 0.9 && live.clip && live.clip.pitched === true && live.clip.speed === 1 && live.loop === false, 'plays once at 0.9: ' + JSON.stringify(live));
        await waitFor(() => web.$eval(yt, (e) => !e.classList.contains('playing')), 12000, 'single pass ended (no loop while 반복 is off)');
        assert(await web.$eval(yt + ' .rate-btn[data-rate="0.9"]', (b) => !b.classList.contains('on')), 'button off when it ends');
        // 🔁 반복을 켠 채 배속 버튼 → 그 배속으로 계속 반복
        await web.click('.toolbar .repeat-toggle');
        await waitFor(() => web.$eval('.toolbar .repeat-toggle', (b) => b.classList.contains('on')), 4000, 'repeat on');
        await web.click(yt + ' .rate-btn[data-rate="1.15"]');
        await waitFor(() => web.$eval(yt + ' .rate-btn[data-rate="1.15"]', (b) => b.classList.contains('on') && b.classList.contains('looping')), 8000, '1.15 looping');
        assert(await web.evaluate(() => window.__subtutorDebug.state.clip.loop) === true, 'loop flag set');
        await sleep(3500); // 2초 구간을 1.15배로 → 한 번만 재생했다면 벌써 끝났을 시간
        assert(await web.$eval(yt, (e) => e.classList.contains('playing')), 'still looping after one pass');
        assert(await web.evaluate(() => window.__subtutorDebug.state.playRate) === 1.15, 'rate kept while looping');
        // 같은 배속을 다시 누르면 정지
        await web.click(yt + ' .rate-btn[data-rate="1.15"]');
        await waitFor(() => web.$eval(yt, (e) => !e.classList.contains('playing')), 6000, 'same rate again stops');
        assert(await web.evaluate(() => window.__subtutorDebug.state.playRate) === 0, 'play rate cleared on stop');
      } finally {
        await web.evaluate(() => { const b = document.querySelector('.toolbar .repeat-toggle.on'); if (b) b.click(); }).catch(() => {});
      }
    });
    await step('속도 사다리 설정: 단계 수·단계별 배속(0.3~2.0)·음높이 유지를 바꾸면 그대로 재생된다', async () => {
      const yt = '[data-id^="youtube:"]';
      try {
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$('.ladder-cfg'), 8000, 'ladder settings block');
      assert(await web.$$eval('.ladder-cfg input.rate', (e) => e.length) === 4, 'four rate inputs by default');
      // 2단계로 줄이면 기본값(0.7 → 1)이 채워진다
      await web.select('.ladder-cfg .ladder-steps', '2');
      await waitFor(() => web.$$eval('.ladder-cfg input.rate', (e) => e.map((x) => x.value)).then((v) => (v.length === 2 ? v : null)), 5000, 'two steps');
      assert((await web.$$eval('.ladder-cfg input.rate', (e) => e.map((x) => x.value))).join(',') === '0.7,1', 'preset for two steps');
      // 사용자 지정 배속: 0.45 → 1.0 (범위 밖 값은 0.3~2.0 으로 맞춘다)
      await web.evaluate(() => { const i = document.querySelector('.ladder-cfg input.rate[data-step="0"]'); i.value = '0.05'; i.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => web.$eval('.ladder-cfg input.rate[data-step="0"]', (i) => i.value === '0.3'), 5000, 'clamped to 0.3');
      await web.evaluate(() => { const i = document.querySelector('.ladder-cfg input.rate[data-step="0"]'); i.value = '0.45'; i.dispatchEvent(new Event('change', { bubbles: true })); });
      const saved = await waitFor(async () => { const w = await sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings || {}).web); return w && Array.isArray(w.ladderRates) && w.ladderRates[0] === 0.45 ? w : null; }, 5000, 'rates saved to the extension');
      assert(saved.ladderRates.length === 2 && saved.ladderRates[1] === 1 && saved.ladderPitch === true, 'saved ladder: ' + JSON.stringify(saved.ladderRates) + ' pitch=' + saved.ladderPitch);
      // 음높이 유지를 끄면 playbackRate 로 재생한다
      await web.click('.ladder-cfg .switch[data-pref="ladderPitch"]');
      await waitFor(async () => { const w = await sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings || {}).web); return w && w.ladderPitch === false; }, 5000, 'pitch off saved');
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await trackClipEvents();
      await waitFor(() => web.$(yt + ' .ladder'), 8000, 'list back');
      assert(/0\.45 → 1×/.test(await web.$eval(yt + ' .ladder', (b) => b.title)) && !/음높이 유지/.test(await web.$eval(yt + ' .ladder', (b) => b.title)), 'title follows the settings: ' + await web.$eval(yt + ' .ladder', (b) => b.title));
      const perItem = await web.$$eval(yt + ' .rate-btn', (b) => b.map((x) => x.textContent));
      assert(perItem.join(',') === '0.45,1', 'per-item rate buttons follow the settings: ' + perItem.join(','));
      await web.click(yt + ' .ladder');
      const seen = [];
      await waitFor(async () => { const t = await web.$eval('#toast', (e) => e.textContent); const m = /⤴ ([\d.]+)×/.exec(t); if (m && seen[seen.length - 1] !== m[1]) seen.push(m[1]); return seen.length >= 2 && seen[seen.length - 1] === '1'; }, 30000, 'custom ladder 0.45 → 1').catch((e) => { throw new Error(e.message + ' seen=' + seen.join(',')); });
      assert(seen.join(',') === '0.45,1', 'exactly the two configured steps: ' + seen.join(','));
      const plain = await web.evaluate(() => window.__subtutorDebug.state.lastClip);
      assert(plain && plain.pitched === false && plain.speed === 1, 'last step is 1× (no stretching needed): ' + JSON.stringify(plain));
      await waitFor(() => web.$eval(yt, (e) => !e.classList.contains('playing')), 8000, 'custom ladder finished');
      // 원래대로
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$('.ladder-cfg .ladder-reset'), 8000, 'reset button');
      await web.click('.ladder-cfg .ladder-reset');
      const back = await waitFor(async () => { const w = await sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings || {}).web); return w && w.ladderRates && w.ladderRates.length === 4 && w.ladderPitch === true ? w : null; }, 5000, 'defaults restored');
      assert(back.ladderRates.join(',') === '0.8,0.9,1,1.15', 'default rates: ' + back.ladderRates.join(','));
      } finally {
        // 검사가 실패해도 기본 설정과 목록 화면으로 되돌린다 (안 그러면 뒤 단계가 줄줄이 실패한다)
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true } } }, {})).catch(() => {});
        await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' }).catch(() => {});
        await trackClipEvents();
        await waitFor(() => web.$(yt + ' .ladder'), 8000, 'list back again');
      }
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
    await step('지정 폴더의 MP3 파일 하나로 플레이어 탭 없이 재생된다 (복사본을 만들지 않는다)', async () => {
      const row = await web.$('[data-id^="youtube:"]');
      assert(row, 'youtube item row');
      const badges = await row.$$eval('.fmt', (els) => els.map((e) => e.tagName + '|' + e.className + '|' + e.textContent + '|' + e.title));
      assert(badges.length === 1 && /^SPAN\|fmt file stored/.test(badges[0]) && /⬇ MP3/.test(badges[0]) && /e2e-docs\/SubTutor/.test(badges[0]) && /MP3 는 이 파일 하나/.test(badges[0]), 'one green file badge, read on demand: ' + JSON.stringify(badges));
      // 플랫폼 이름은 카드가 아니라 묶음 제목에 (카드 높이를 줄이려고)
      assert(!(await row.$$eval('.meta span', (els) => els.map((e) => e.textContent))).some((t) => t === '유튜브'), 'platform not repeated in every card');
      assert((await web.$$eval('.group-title', (els) => els.map((e) => e.textContent))).some((g) => /\(유튜브\)/.test(g)), 'platform shown in the group title');
      await yt.evaluate(() => { window.__pauses = []; });
      await (await row.$('.play')).click();
      await waitFor(() => web.$eval('[data-id^="youtube:"]', (e) => e.classList.contains('playing')), 5000, 'local playing');
      await waitFor(() => web.$eval('[data-id^="youtube:"]', (e) => !e.classList.contains('playing')), 8000, 'local ended');
      const pauses = await yt.evaluate(() => window.__pauses);
      assert(pauses.length === 0, 'player tab untouched: ' + JSON.stringify(pauses));
      const keys = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('audio:')));
      assert(keys.length === 0, 'playing from the folder file makes no copy: ' + JSON.stringify(keys));
    });
    const ytSelAll = '[data-id^="youtube:"]';
    let ytId = null;
    await step('폴더 권한이 풀리면 안내하고 플레이어 탭으로 재생한다 (복사본을 몰래 만들지 않는다)', async () => {
      ytId = await web.$eval(ytSelAll, (e) => e.dataset.id);
      // 폴더 핸들을 잠시 치워 권한이 없는 상태를 만든다
      await opt.evaluate(async () => { window.__savedHandle = await window.SubTutorFS.getHandle(); await window.SubTutorFS.setHandle(null); });
      await web.evaluate(() => { try { sessionStorage.removeItem('subtutor.hint.audio'); } catch (e) {} });
      await web.reload({ waitUntil: 'load' });
      await trackClipEvents();
      await waitFor(() => web.$(ytSelAll + ' .play'), 8000, 'list');
      await web.click(ytSelAll + ' .play');
      await waitFor(() => web.$eval('#toast', (t) => /폴더/.test(t.textContent)), 8000, 'folder hint toast').catch(async (e) => { throw new Error(e.message + ' toast=' + await web.$eval('#toast', (t) => t.textContent)); });
      const keys = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('audio:')));
      assert(keys.length === 0, 'no copy created when the folder is unreadable: ' + JSON.stringify(keys));
      await web.evaluate((sel) => { const b = document.querySelector(sel + ' .play'); if (b && (b.classList.contains('busy') || b.classList.contains('active'))) b.click(); }, ytSelAll);
      // 권한을 되돌리면 다시 그 파일로 재생된다
      await opt.evaluate(async () => { await window.SubTutorFS.setHandle(window.__savedHandle); });
      await web.reload({ waitUntil: 'load' });
      await trackClipEvents();
      await waitFor(() => web.$(ytSelAll + ' span.fmt.file.stored'), 8000, 'green file badge again');
      await yt.evaluate(() => { window.__pauses = []; });
      await web.click(ytSelAll + ' .play');
      await waitFor(() => web.$eval(ytSelAll, (e) => e.classList.contains('playing')), 8000, 'playing from the folder file again');
      await waitFor(() => web.$eval(ytSelAll, (e) => !e.classList.contains('playing')), 10000, 'ended');
      assert((await yt.evaluate(() => window.__pauses)).length === 0, 'player tab untouched');
    });
    await step('다운로드 폴더의 MP3: 안내가 뜨고, 웹의 "MP3 폴더에서 불러오기"로 복사본을 가져온다', async () => {
      // 다운로드 폴더에 저장한 것처럼 기록을 바꾸고 복사본을 지운다 (확장 프로그램은 다운로드 폴더를 읽을 수 없다)
      const rel = await sw.evaluate(async (id) => { await chrome.storage.local.remove('audio:' + id); const items = (await chrome.storage.local.get('items')).items; const it = items.find((i) => i.id === id); it.audio = null; it.fileFolder = it.file; const rel = it.file.path.split('/').slice(1).join('/'); it.file = { format: 'mp3', location: 'downloads', path: '다운로드/' + rel, leadMs: it.file.leadMs }; await chrome.storage.local.set({ items }); return rel; }, ytId);
      await waitFor(() => web.$(ytSelAll + ' button.fmt.only'), 8000, 'file-only badge (downloads)');
      await web.click(ytSelAll + ' .play');
      await waitFor(() => web.$eval('#toast', (t) => /다운로드 폴더에 있어/.test(t.textContent)), 8000, 'downloads hint toast');
      await sleep(400);
      await web.evaluate((sel) => { const b = document.querySelector(sel + ' .play'); if (b && (b.classList.contains('busy') || b.classList.contains('active'))) b.click(); }, ytSelAll); // 플레이어 재생으로 넘어갔으면 멈춘다
      // 웹사이트 원본의 OPFS 에 다운로드 폴더와 같은 구조로 MP3 를 두고(크롬이 붙이는 " (1)" 이름), 폴더 선택 창을 그 핸들로 대신한다
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$eval('.btn.mp3-import', (b) => /1개 대기/.test(b.textContent)), 8000, 'import button shows one waiting');
      await web.evaluate(async (rel, b64) => {
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle('e2e-downloads', { create: true });
        const parts = rel.split('/');
        for (const x of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(x, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1].replace(/\.mp3$/, ' (1).mp3'), { create: true });
        const w = await fh.createWritable();
        const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await w.write(bytes); await w.close();
        window.showDirectoryPicker = async () => root.getDirectoryHandle('e2e-downloads');
      }, rel, ytClipB64);
      await web.click('.btn.mp3-import');
      await waitFor(() => web.$eval('#toast', (t) => /MP3 1개를 불러왔습니다/.test(t.textContent)), 15000, 'import toast');
      const it = await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = items.find((i) => i.id === ytId); return x && x.audio ? x : null; }, 5000, 'copy imported');
      assert(it.audio.source === 'import' && it.audio.sameAsFile === true, 'import meta ' + JSON.stringify(it.audio));
      assert(await sw.evaluate(async (id) => (await chrome.storage.local.get('audio:' + id))['audio:' + id], ytId) === ytClipB64, 'imported bytes equal the file');
      await waitFor(() => web.$eval('.btn.mp3-import', (b) => !/대기/.test(b.textContent)), 8000, 'nothing waiting');
      // 원래대로: 지정 폴더 기록으로 되돌리고 불러온 복사본은 지운다 (MP3 는 다시 폴더의 파일 하나)
      await sw.evaluate(async (id) => { await chrome.storage.local.remove('audio:' + id); const items = (await chrome.storage.local.get('items')).items; const it = items.find((i) => i.id === id); it.file = it.fileFolder; it.audio = null; delete it.fileFolder; await chrome.storage.local.set({ items }); }, ytId);
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await trackClipEvents();
      await waitFor(() => web.$(ytSelAll + ' span.fmt.file.stored'), 8000, 'badge restored');
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
    await step('🔁 반복: 보관 오디오·플레이어 재생을 되풀이하고, 다른 대사를 누르면 이전 것이 멈춘다 · 삭제하면 MP3 파일도 함께 지워진다', async () => {
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
      assert(left.length === 0, 'no stored audio left: ' + left);
      // 삭제하면 지정 폴더의 MP3 파일과 비게 된 작품 폴더도 지워지고, 확인 창이 그 사실을 알린다
      assert(logs.some((l) => /\[web dialog\] 이 대사 1개를 삭제할까요\? PC 에 저장한 MP3 파일 1개도 함께 지웁니다/.test(l)), 'delete confirm names the MP3 file: ' + logs.filter((l) => /web dialog/.test(l)).slice(-1).join(''));
      const folders = await opt.evaluate(async () => { const sub = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); const out = []; for await (const [n] of sub.entries()) out.push(n); return out; });
      assert(!folders.some((n) => /Mock Lecture/.test(n)), 'MP3 file and its emptied folder removed with the item: ' + JSON.stringify(folders));
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
      // 녹음을 멈추면 마이크를 놓는다 (안 그러면 탭에 녹음 중 빨간 점이 계속 남는다)
      assert(await web.evaluate(() => !window.SubTutorRecorder.micOpen()), 'microphone released after recording');
    });
    await step('같이 듣기: 플레이어 오디오 뒤에 최근 녹음이 재생된다', async () => {
      const oneRow = await web.evaluate(() => { const n = document.querySelector('[data-id="netflix:12345:22000"]'); const a = n.querySelector('.tags-row .tag-add').getBoundingClientRect(); const r = n.querySelector('.rec-row .rec-btn').getBoundingClientRect(); const i = n.querySelector('.rec-row .info').getBoundingClientRect(); return { sameRow: Math.abs(a.top - r.top) < 12 && Math.abs(a.top - i.top) < 12, order: r.left > a.right - 2 && i.left > r.left }; });
      assert(oneRow.sameRow && oneRow.order, '+ 태그 · 녹음 · 같이 듣기 · ⓘ on one row: ' + JSON.stringify(oneRow));
      const labels = await web.$$eval('[data-id="netflix:12345:22000"] .rec-row > button', (b) => b.map((x) => x.textContent));
      assert(labels.some((l) => /같이 듣기/.test(l)), '같이 듣기 button present: ' + labels.join(' | '));
      await trackClipEvents();
      await web.evaluate(() => [...document.querySelectorAll('[data-id="netflix:12345:22000"] .rec-row > button')].find((b) => /같이 듣기/.test(b.textContent)).click());
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
      const weak = await waitFor(async () => { const r = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats); return r && r.weak && r.weak.frisbee ? r.weak : null; }, 5000, 'weak word recorded');
      assert(weak.frisbee === 1, 'weak words ' + JSON.stringify(weak));
      await web.keyboard.press('KeyC');
      await waitFor(() => web.$eval('.quiz-top', (e) => /2 \/ 2/.test(e.textContent)), 5000, 'next card');
      const graded = await waitFor(async () => { const all = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = all.find((i) => i.text.includes('frisbee')); return x && x.review ? x : null; }, 5000, 'review scheduled');
      assert(graded.box === 'learning' && graded.review.interval === 1 && graded.review.reps === 1 && graded.review.due > Date.now() + 20 * 3600 * 1000, 'srs schedule ' + JSON.stringify(graded.review) + ' box=' + graded.box);
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
      assert(it.forgot === 1 && it.reviews === 1 && it.box === 'learning' && it.review && it.review.lapses === 1, 'stats ' + JSON.stringify({ forgot: it.forgot, reviews: it.reviews, box: it.box, review: it.review }));
      const reviews = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats.reviews.length);
      assert(reviews >= 2, 'review log ' + reviews);
    });
    await step('설정: 학습 기능 토글·ⓘ 근거·진행 상황·약점 단어·추천', async () => {
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.switch-row .switch[data-pref]', (e) => e.length === 6), 8000, 'six toggles');
      assert(await web.$$eval('.settings p', (ps) => ps.filter((p) => p.textContent.length > 120).length) === 0, 'no long description paragraphs');
      await waitFor(() => web.$eval('.dday', (e) => /^D[-+]\d+/.test(e.textContent) || /D-day/.test(e.textContent)), 5000, 'd-day');
      await waitFor(() => web.$$eval('.weak .weak-w', (e) => e.map((x) => x.firstChild.textContent)).then((w) => (w.includes('frisbee') ? w : null)), 5000, 'weak word listed');
      assert(await web.$$eval('.recs .rec', (e) => e.length) >= 8, 'recommendations');
      await waitFor(() => web.$$eval('table.eps tbody tr', (r) => r.length >= 1), 5000, 'episode table');
      await web.click('.info[data-key="srs"]');
      await waitFor(() => web.evaluate(() => { const d = document.getElementById('info-dialog'); return d.open && /Cepeda/.test(d.textContent); }), 3000, 'basis dialog');
      await web.click('#info-close');
      await web.click('.switch[data-pref="recommend"]');
      await waitFor(() => web.$$eval('.recs', (e) => e.length === 0), 4000, 'recommend hidden when off');
      const pref = await sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings || {}).web);
      assert(pref && pref.recommend === false && pref.srs === true, 'web prefs saved ' + JSON.stringify(pref));
      await web.click('.switch[data-pref="recommend"]');
      await waitFor(() => web.$$eval('.recs', (e) => e.length === 1), 4000, 'recommend back');
    });
    await step('설정: 화이트 모드로 바꾸면 화면 색이 바뀌고 새로고침해도 남는다', async () => {
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$('.theme-sel'), 8000, 'theme select');
      const dark = await web.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color }));
      assert(dark.theme === 'dark', 'dark by default: ' + JSON.stringify(dark));
      await web.select('.theme-sel', 'light');
      const light = await waitFor(async () => { const v = await web.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, card: getComputedStyle(document.querySelector('.settings section')).backgroundColor })); return v.theme === 'light' ? v : null; }, 4000, 'light applied');
      const lum = (c) => { const m = /(\d+), (\d+), (\d+)/.exec(c); return m ? (+m[1] + +m[2] + +m[3]) / 3 : -1; };
      assert(lum(light.bg) > 200 && lum(light.text) < 80 && lum(light.card) > 230, 'white background with dark text: ' + JSON.stringify(light));
      assert(await web.evaluate(() => localStorage.getItem('subtutor.theme')) === 'light', 'theme persisted');
      await web.reload({ waitUntil: 'load' });
      await waitFor(() => web.evaluate(() => document.documentElement.dataset.theme === 'light'), 4000, 'still light after reload');
      assert(await web.$eval('.theme-sel', (s) => s.value) === 'light', 'select shows the saved theme');
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-light.png') });
      await web.select('.theme-sel', 'dark');
      await waitFor(() => web.evaluate(() => document.documentElement.dataset.theme === 'dark'), 4000, 'back to dark');
    });
    await step('알고 있는 표현 상자에서 다시 학습으로 되돌릴 수 있다', async () => {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.update', id: 'netflix:12345:22000', patch: { box: 'known', knownAt: Date.now() } }, {}));
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
    await step('편집 모드: 선택 상자로 고른 대사를 삭제하면 PC 의 MP3 파일도 함께 지워진다', async () => {
      // 편집용 항목 4개: Edit Show S1:E1 ×2, S1:E2 ×1(지정 폴더에 MP3 있음), Edit Movie ×1(다운로드 폴더 기록만, 실제 파일 없음)
      const now = Date.now();
      const mk = (id, title, episode, text, extra) => Object.assign({ id, platform: 'netflix', videoId: id.split(':')[1], url: 'https://www.netflix.com/watch/' + id.split(':')[1], title, episode, startMs: 1000, endMs: 2000, text, translation: '', savedAt: now, box: 'learning' }, extra || {});
      const filePath = 'e2e-docs/SubTutor/Edit Show S1E2/00-01 keep calm.mp3';
      const keepPath = 'e2e-docs/SubTutor/Edit Keep/00-02 stay.mp3'; // 다른 작품 폴더의 파일은 남아야 한다
      for (const p of [filePath, keepPath]) await opt.evaluate(async (p) => { const root = await navigator.storage.getDirectory(); let dir = await root.getDirectoryHandle('e2e-docs'); const parts = p.split('/').slice(1); for (const x of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(x, { create: true }); const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3])); await w.close(); }, p);
      const extra = [
        mk('netflix:801:1000', 'Edit Show', 'S1:E1', 'Edit one'),
        mk('netflix:801:5000', 'Edit Show', 'S1:E1', 'Edit two'),
        mk('netflix:802:1000', 'Edit Show', 'S1:E2', 'Edit three', { file: { format: 'mp3', location: 'folder', path: filePath, leadMs: 250, savedAt: now } }),
        mk('netflix:803:1000', 'Edit Movie', '', 'Edit four', { file: { format: 'mp3', location: 'downloads', path: '다운로드/SubTutor/Edit Movie/00-01 nothing.mp3', leadMs: 250, savedAt: now } }),
      ];
      const r = await web.evaluate((items) => window.SubTutorBridge.request('items.import', { items }), extra);
      assert(r.added === 4, 'imported ' + JSON.stringify(r));
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (x) => x.length === 5), 8000, 'five items');
      assert((await web.$$('.item .pick')).length === 0 && await web.$eval('.edit-bar', (e) => e.classList.contains('hidden')), 'no checkboxes before edit');
      assert(await web.$$eval('.toolbar .edit-bar .info', (e) => e.length) === 1 && await web.$$eval('.toolbar > .info', (e) => e.length) === 3, 'the edit ⓘ lives inside the edit bar, not loose in the toolbar');
      await web.click('.toolbar .edit-toggle');
      await waitFor(() => web.$$eval('.item .pick', (x) => x.length === 5), 5000, 'checkboxes in edit mode');
      assert(!(await web.$eval('.edit-bar', (e) => e.classList.contains('hidden'))), 'edit bar visible');
      // 편집 중 버튼 · ⓘ · 보이는 대사 모두 선택이 한 줄에 (카드가 더 보이도록)
      assert(await web.$$eval('.toolbar .hide-toggle, .toolbar .repeat-toggle', (e) => e.length) === 0, 'view-only buttons step aside while editing');
      const oneLine = await web.evaluate(() => {
        const t = document.querySelector('.toolbar .edit-toggle').getBoundingClientRect();
        const i = document.querySelector('.toolbar .edit-bar .info').getBoundingClientRect();
        const p = document.querySelector('.toolbar .edit-bar .pick-all-label').getBoundingClientRect();
        return { sameRow: Math.abs(t.top - i.top) < 14 && Math.abs(t.top - p.top) < 14, order: i.left > t.right - 2 && p.left > i.right - 2 };
      });
      assert(oneLine.sameRow && oneLine.order, '편집 중 → ⓘ → 모두 선택 on one row: ' + JSON.stringify(oneLine));
      assert(await web.$$eval('.toolbar > .edit-bar', (e) => e.length) === 1, 'the edit bar sits inside the toolbar, not on its own row');
      assert(await web.evaluate(() => { const tb = document.querySelector('.toolbar').getBoundingClientRect(); const bar = document.querySelector('.edit-bar').getBoundingClientRect(); return bar.bottom <= tb.bottom + 2 && tb.height < 60; }), 'the toolbar stays a single row in edit mode');
      assert(await web.$eval('.edit-bar .del-selected', (b) => b.disabled && /선택 0개 삭제/.test(b.textContent)), 'delete disabled with nothing selected');
      await web.click('[data-id="netflix:802:1000"] .pick');
      await waitFor(() => web.$eval('.edit-bar .del-selected', (b) => !b.disabled && /선택 1개 삭제/.test(b.textContent)), 3000, 'one selected');
      assert(await web.$eval('[data-id="netflix:802:1000"]', (e) => e.classList.contains('selected')), 'card highlighted');
      await web.click('[data-id="netflix:801:1000"] .meta .span'); // 카드 본문을 눌러도 선택
      await waitFor(() => web.$eval('.edit-bar .del-selected', (b) => /선택 2개 삭제/.test(b.textContent)), 3000, 'card click selects');
      await web.click('[data-id="netflix:801:1000"] .meta .span');
      await waitFor(() => web.$eval('.edit-bar .del-selected', (b) => /선택 1개 삭제/.test(b.textContent)), 3000, 'card click deselects');
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-edit-mode.png') });
      await web.click('.edit-bar .del-selected'); // 확인 창은 자동 수락 (문구는 logs 에 남는다)
      await waitFor(() => web.$$eval('.item', (x) => x.length === 4), 8000, 'deleted');
      assert(!(await web.$('[data-id="netflix:802:1000"]')), 'selected item gone');
      assert(logs.some((l) => /\[web dialog\] 선택한 대사 1개를 삭제할까요\? PC 에 저장한 MP3 파일 1개도 함께 지웁니다/.test(l)), 'confirm names the file: ' + logs.filter((l) => /web dialog/.test(l)).slice(-1).join(''));
      await waitFor(() => web.$eval('#toast', (t) => /대사 1개 삭제 · MP3 파일 1개 삭제/.test(t.textContent)), 5000, 'toast reports the deleted file');
      const left = await opt.evaluate(async () => { const root = await navigator.storage.getDirectory(); const sub = await (await root.getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); const out = []; for await (const [name] of sub.entries()) out.push(name); return out; });
      assert(!left.includes('Edit Show S1E2') && left.includes('Edit Keep'), 'file and its emptied folder removed, other folders kept: ' + JSON.stringify(left));
      assert(await web.$$eval('.item .pick', (x) => x.length) === 4, 'still in edit mode after deleting');
    });
    await step('편집 모드: 드롭다운으로 에피소드·작품 전체 삭제, 완료·Esc 로 나오기', async () => {
      const pickScope = async (re) => { const v = await web.$$eval('.edit-bar .bulk-scope option', (os, src) => { const o = os.find((x) => new RegExp(src).test((x.parentElement.label || '') + ' ' + x.textContent)); return o ? o.value : null; }, re.source); assert(v, 'scope option ' + re); await web.select('.edit-bar .bulk-scope', v); };
      await pickScope(/^Edit Show (\(넷플릭스\) )?S1:E1 · 2개$/);
      await waitFor(() => web.$$eval('.item', (x) => x.length === 2), 8000, 'episode deleted');
      assert(!(await web.$$eval('.item', (x) => x.map((e) => e.dataset.id))).some((i) => i.startsWith('netflix:801:')), 'S1:E1 items gone');
      // 작품 전체: 다운로드 폴더 기록만 있고 크롬 다운로드 기록에 없는 파일 → 자막은 지우고 파일은 못 지웠다고 알린다
      await pickScope(/^Edit Movie (\(넷플릭스\) )?작품 전체 · 1개$/);
      await waitFor(() => web.$$eval('.item', (x) => x.length === 1), 8000, 'work deleted');
      assert(logs.some((l) => /\[web dialog\] 작품 "Edit Movie"의 대사 1개를 삭제할까요\? PC 에 저장한 MP3 파일 1개도 함께 지웁니다/.test(l)), 'confirm text for the work: ' + logs.filter((l) => /web dialog/.test(l)).slice(-1).join(''));
      await waitFor(() => web.$eval('#toast', (t) => /대사 1개 삭제 · 파일 1개는 지우지 못했습니다 \(크롬 다운로드 기록에 없어/.test(t.textContent)), 5000, 'toast reports the missing download');
      const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items);
      assert(items.length === 1 && !items.some((i) => i.title.startsWith('Edit')), 'storage cleaned: ' + items.map((i) => i.id).join(','));
      await web.click('.edit-bar .edit-done');
      await waitFor(() => web.$$eval('.item .pick', (x) => x.length === 0), 3000, 'checkboxes gone');
      assert(await web.$eval('.edit-bar', (e) => e.classList.contains('hidden')), 'edit bar hidden');
      await web.click('.toolbar .edit-toggle');
      await waitFor(() => web.$$eval('.item .pick', (x) => x.length === 1), 3000, 'edit again');
      await web.keyboard.press('Escape');
      await waitFor(() => web.$$eval('.item .pick', (x) => x.length === 0), 3000, 'Esc exits edit mode');
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
