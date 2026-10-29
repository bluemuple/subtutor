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
      '--host-resolver-rules=MAP www.netflix.com 127.0.0.1:8443, MAP translate.googleapis.com 127.0.0.1:8443, MAP clients5.google.com 127.0.0.1:8443',
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
    await step('한국어 자막 트랙이 영어 줄에 연결된다', async () => {
      const status = await page.$eval('.st-status', (e) => e.textContent);
      assert(/한국어 자막 10줄/.test(status), 'status: ' + status);
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

    console.log('▶ 웹사이트');
    await browser.defaultBrowserContext().overridePermissions('http://localhost:8766', ['microphone']);
    const web = await browser.newPage();
    web.on('pageerror', (e) => logs.push('[web pageerror] ' + e.message));
    web.on('console', (m) => logs.push('[web ' + m.type() + '] ' + m.text()));
    web.on('dialog', (d) => d.accept());
    await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
    await step('확장 프로그램이 감지되고 저장한 자막 2개가 보인다', async () => {
      await waitFor(() => web.$eval('#ext-status', (e) => e.classList.contains('ok')), 8000, 'ext ok');
      await waitFor(() => web.$$eval('.item', (r) => r.length === 2), 8000, 'items');
      const texts = await web.$$eval('.item .en', (els) => els.map((e) => e.textContent));
      assert(texts.some((t) => t.includes('frisbee')) && texts.some((t) => t.includes('Principal')), 'texts ' + texts);
      const group = await web.$eval('.group-title', (e) => e.textContent);
      assert(group.includes('Mock Show') && group.includes('S1:E2'), 'group ' + group);
    });
    await step('웹에서 ▶ 를 누르면 플레이어 탭이 그 구간만 재생하고 멈춘다', async () => {
      await page.evaluate(() => { window.__pauses = []; });
      const row = await web.$('.item');
      await (await row.$('.play')).click();
      await waitFor(() => web.$eval('.item', (e) => e.classList.contains('playing')), 8000, 'playing state');
      await waitFor(() => web.$eval('.item .state', (e) => e.textContent === ''), 15000, 'ended');
      const pauses = await page.evaluate(() => window.__pauses);
      const last = pauses[pauses.length - 1];
      assert(last >= 24100 && last <= 24700, 'paused at ' + JSON.stringify(pauses));
    });
    await step('코멘트를 쓰면 저장되고 새로고침 후에도 남는다', async () => {
      const ta = await web.$('.item .comment');
      await ta.click();
      await ta.type('물다 = bite 메모');
      await web.keyboard.press('Tab');
      await sleep(400);
      await web.reload({ waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 2), 8000, 'items after reload');
      const v = await web.$eval('.item .comment', (e) => e.value);
      assert(v === '물다 = bite 메모', 'comment: ' + v);
    });
    await step('녹음: 3개까지 저장, 4번째에 첫 번째가 삭제된다', async () => {
      for (let i = 0; i < 4; i++) {
        await web.click('[data-id="netflix:12345:22000"] .rec-btn');
        await waitFor(() => web.$eval('.item .rec-btn', (e) => e.classList.contains('recording')), 5000, 'recording ' + i).catch(async (e) => {
          const toastText = await web.$eval('#toast', (t) => t.textContent);
          throw new Error(e.message + ' toast=' + toastText + ' logs=' + logs.filter((l) => l.startsWith('[web')).slice(-5).join(' | '));
        });
        await sleep(700);
        await web.click('[data-id="netflix:12345:22000"] .rec-btn');
        await waitFor(() => web.$$eval('[data-id="netflix:12345:22000"] .attempt', (a, n) => a.length === n, Math.min(3, i + 1)), 6000, 'attempt count ' + i);
      }
      const n = await web.$$eval('.item .attempt', (a) => a.length);
      assert(n === 3, 'attempts ' + n);
      const latest = await web.$eval('.item .attempt.latest', (e) => e.firstChild.textContent);
      assert(latest === '3', 'latest chip ' + latest);
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-list-recordings.png') });
      const recs = await web.evaluate(async () => (await window.SubTutorRecorder.listAll()).map((r) => r.createdAt));
      assert(recs.length === 3 && recs[0] > 0, 'db recordings ' + recs.length);
    });
    await step('같이 듣기: 플레이어 오디오 뒤에 최근 녹음이 재생된다', async () => {
      const btns = await web.$$('[data-id="netflix:12345:22000"] .rec-btn');
      assert(btns.length === 2, 'rec buttons in first item: ' + btns.length);
      await btns[btns.length - 1].click();
      await waitFor(() => web.$eval('.item', (e) => e.classList.contains('playing')), 8000, 'clip playing');
      await waitFor(() => web.$$eval('.item .attempt.playing', (a) => a.length === 1), 15000, 'recording playing after clip');
    });
    await step('퀴즈: 받아쓰기 확인 후 C로 "알고 있는 표현" 상자로 이동', async () => {
      await web.goto('http://localhost:8766/#/quiz', { waitUntil: 'load' });
      await waitFor(() => web.$('.quiz-setup'), 8000, 'setup');
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
