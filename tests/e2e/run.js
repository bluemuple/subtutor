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
// 웹·앱 코드에 실제 Supabase 주소가 기본값으로 들어 있다 — 테스트 크롬은 그 서버에 절대 닿지 못하게 막는다 (모의 서버는 127.0.0.1:8769)
const NO_REAL_SUPABASE = 'MAP *.supabase.co 127.0.0.1:9';
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
  // 디즈니+ 더빙 검사에서 마이크 대신 넣는 올라가는 음 (300Hz 에서 초당 200Hz 씩) — 녹음에 반복·끊김이 있으면 음높이가 뒤로 튄다
  const sweep = path.join(TMP, 'mic-sweep.wav');
  if (!fs.existsSync(sweep)) {
    console.log('▶ 마이크 대신 쓸 올라가는 음 생성 (ffmpeg)');
    execSync('ffmpeg -y -loglevel error -f lavfi -i "aevalsrc=0.5*sin(2*PI*(300*t+100*t*t)):s=48000:d=30" -ac 1 "' + sweep + '"', { stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(TMP, 'key.pem')) || !fs.existsSync(path.join(TMP, 'cert.pem'))) {
    console.log('▶ 자체 서명 인증서 생성 (openssl)');
    execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout "' + path.join(TMP, 'key.pem') + '" -out "' + path.join(TMP, 'cert.pem') + '" -days 60 -subj "/CN=www.netflix.com" -addext "subjectAltName=DNS:www.netflix.com,DNS:translate.googleapis.com,DNS:clients5.google.com"', { stdio: 'inherit' });
  }
}

// ── 디즈니+(모의): 따로 띄운 크롬. 플레이어가 재생 위치를 0.5초 계단으로 알려 주는 실제 디즈니+ 를 흉내 내고,
//    마이크 대신 올라가는 음을 넣어 더빙 녹음이 끊기거나 반복되지 않는지, 재생이 되감기지 않는지까지 본다.
async function runDisney() {
  const userDataDir = path.join(TMP, 'profile-disney-' + Date.now());
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir,
    args: [
      '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
      '--host-resolver-rules=MAP www.disneyplus.com 127.0.0.1:8443, MAP translate.googleapis.com 127.0.0.1:8443, MAP clients5.google.com 127.0.0.1:8443, ' + NO_REAL_SUPABASE,
      '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-audio-capture=' + path.join(TMP, 'mic-sweep.wav'),
      '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox', // 샌드박스된 오디오 서비스는 이 파일을 읽지 못한다
      '--no-first-run', '--window-size=1400,900',
    ],
    acceptInsecureCerts: true,
    defaultViewport: { width: 1400, height: 900 },
    protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT) || 60000,
  });
  try {
    console.log('▶ 모의 디즈니+ (0.5초 계단 재생 위치 · 마이크 대신 올라가는 음)');
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
    const sw = await swTarget.worker();
    await waitFor(() => sw.evaluate(() => typeof globalThis.__subtutorHandle === 'function' && !!(globalThis.chrome && chrome.storage)), 15000, 'service worker (disney)');
    await sw.evaluate(() => chrome.storage.local.clear());
    // 새 저장 옵션(문장 단위·고르기·꼬리·다음 자막)은 전용 스텝에서만 켠다 — clear() 직후라 여기서 꺼 둬야 유지된다
    await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { koMode: 'always', saveSentence: false, saveTailSec: 0, saveNextTexts: false, savePick: false } }, {}));
    const dp = await browser.newPage();
    // 탭이 죽으면(렌더러 충돌) 다음 단계들이 'Target closed / detached Frame' 으로 줄줄이 실패한다 → 원인을 남긴다
    dp.on('error', (e) => console.log('  [디즈니+ 탭 충돌] ' + e.message));
    dp.on('pageerror', (e) => console.log('  [디즈니+ 페이지 오류] ' + e.message));
    dp.on('close', () => console.log('  [디즈니+ 탭 닫힘]'));
    browser.on('disconnected', () => console.log('  [디즈니+ 브라우저 연결 끊김]'));
    await dp.goto('https://www.disneyplus.com/play/mockdisney1', { waitUntil: 'domcontentloaded' });
    await step('디즈니+(모의): HLS 자막 10줄과 한국어가 연결되고 제목을 읽는다', async () => {
      await dp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => dp.$$eval('.st-row', (r) => r.length === 10), 20000, 'disney rows');
      const status = await dp.$eval('.st-status', (e) => e.textContent);
      assert(/영어 10줄/.test(status) && /한국어 10줄 연결/.test(status), 'status: ' + status);
      await waitFor(() => dp.$eval('#st-panel', (e) => /Mock Moana/.test(e.dataset.title || '')), 8000, 'disney title');
      // 패널 맨 위 왼쪽은 작품 이름 대신 더빙 켬/끔 (이름은 상태줄에 마우스를 올리면 보인다)
      const head = await dp.$eval('.st-head', (h) => ({ first: h.firstElementChild.className, text: h.firstElementChild.textContent, brand: !!h.querySelector('.st-brand'), tip: document.querySelector('.st-status').title }));
      assert(/st-dub-toggle/.test(head.first) && /더빙 켬/.test(head.text) && !head.brand && /Mock Moana/.test(head.tip), 'dub toggle where the title was: ' + JSON.stringify(head));
    });
    await step('디즈니+(모의): 오른쪽 컨트롤 묶음 맨 앞에 배속 버튼, 바로 오른쪽에 ST 버튼', async () => {
      await waitFor(() => dp.$('.st-rate'), 8000, 'rate control (disney)');
      const order = await dp.$$eval('.experience-controls > *', (xs) => xs.map((x) => (x.classList.contains('st-rate') ? 'rate' : (x.classList.contains('st-ctl') || x.classList.contains('st-ctl-wrap') ? 'ST' : x.getAttribute('aria-label')))));
      assert(order.join(',') === 'rate,ST,Mute,Settings,Full screen', 'order: ' + order.join(','));
      await dp.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.play(); });
      await sleep(500);
      await dp.click('.st-rate-up');
      await waitFor(() => dp.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1.15) < 0.01), 3000, 'disney rate up');
      await dp.click('.st-rate-now');
      await waitFor(() => dp.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 3000, 'disney rate reset');
    });
    // 녹음 파일을 풀어 80ms 마다 영교차로 음높이를 잰다 (첫 80ms 는 MP3 인코더의 시작 지연이라 뺀다)
    const pitchTrack = (b64, name) => {
      const file = path.join(TMP, name);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      const pcm = require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '32000', '-']);
      const x = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
      const win = 2560, hz = [];
      for (let i = 0; i + win <= x.length; i += win) { let zc = 0; for (let k = i + 1; k < i + win; k++) if ((x[k - 1] < 0) !== (x[k] < 0)) zc++; hz.push(zc / 2 / 0.08); }
      const body = hz.slice(1);
      return { hz, body, back: body.filter((h, k) => k && h < body[k - 1] - 30).length, slope: (body[body.length - 1] - body[0]) / ((body.length - 1) * 0.08) };
    };
    const dubTakeData = (k) => sw.evaluate(async (k) => { const o = await chrome.storage.local.get(null); const seg = o['dubs:disney:mockdisney1'].segs[0]; const t = seg.takes[k]; return { take: t, b64: o['dubaudio:' + t.id].b64 }; }, k);
    await step('디즈니+(모의) 더빙 녹음: 끊기거나 반복되는 곳 없이 이어진다 (마이크 대신 올라가는 음) · 0.5배로 녹음해도 원래 길이로 맞춘다', async () => {
      await dp.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 6.3; });
      await sleep(800);
      await dp.keyboard.press('KeyR');
      await waitFor(() => dp.$('.st-list > .st-dubbox:not(.st-hidden)'), 3000, 'disney inline dub section');
      // 1배 녹음: 실제 시간 그대로 → 음높이가 초당 200Hz 씩 끊김 없이 오른다
      await dp.click('.st-dub-rec');
      await waitFor(async () => (await dp.$$('.st-dub-take')).length === 1 && !(await dp.$('.st-dub-rec.on')), 25000, 'disney take saved')
        .catch(async (e) => { throw new Error(e.message + ' toast=' + await dp.$eval('.st-toast', (t) => t.textContent).catch(() => '')); });
      const one = await dubTakeData(0);
      const p1 = pitchTrack(one.b64, 'disney-take.mp3');
      assert(p1.body.length >= 25 && p1.back === 0, '1x: 음높이가 끝까지 오른다 (반복·끊김 없음): ' + p1.hz.map(Math.round).join(' '));
      assert(p1.slope > 160 && p1.slope < 240, '1x: 오르는 속도 ≈ 200Hz/초: ' + p1.slope.toFixed(0));
      assert(Math.abs(one.take.ms - 2500) < 150, '1x take covers the line ±250ms: ' + one.take.ms);
      // 0.5배 녹음: 영상이 0.5배로 흐르는 동안 녹음 → 원래 길이로 줄이면 같은 음을 두 배 빨리 지나간다 (초당 약 400Hz), 음높이 자체는 그대로
      await dp.click('.st-dub-rec-rate[data-rate="0.5"]');
      await dp.click('.st-dub-rec');
      await waitFor(async () => (await dp.$eval('.st-dub-rec', (b) => /녹음 중/.test(b.textContent))) && Math.abs((await dp.evaluate(() => document.querySelector('video').playbackRate)) - 0.5) < 0.01, 10000, 'disney recording at 0.5x');
      await waitFor(async () => (await dp.$$('.st-dub-take')).length === 2 && !(await dp.$('.st-dub-rec.on')), 30000, 'disney slow take saved')
        .catch(async (e) => { throw new Error(e.message + ' toast=' + await dp.$eval('.st-toast', (t) => t.textContent).catch(() => '')); });
      const two = await dubTakeData(1);
      const p2 = pitchTrack(two.b64, 'disney-take-slow.mp3');
      assert(two.take.recRate === 0.5 && Math.abs(two.take.ms - 2500) < 150, '0.5x take squeezed back to the line length: ' + JSON.stringify(two.take));
      assert(Math.abs(two.take.clipStartMs - one.take.clipStartMs) < 200, '0.5x take lines up with the 1x take (Disney clock follows the speed): ' + two.take.clipStartMs + ' vs ' + one.take.clipStartMs);
      assert(p2.body.length >= 25 && p2.back === 0, '0.5x: 반복·끊김 없음: ' + p2.hz.map(Math.round).join(' '));
      assert(p2.slope > 320 && p2.slope < 480, '0.5x: 두 배 빠르게 맞춰졌다 (≈400Hz/초): ' + p2.slope.toFixed(0));
    });
    await step('디즈니+(모의) 더빙 재생: 재생 위치가 0.5초 계단으로 와도 녹음을 되감지 않는다 (말머리 반복 없음)', async () => {
      // 별표를 누르지 않아도 가장 최근 녹음(0.5배)이 더빙으로 골라져 있다
      const slowId = (await dubTakeData(1)).take.id;
      await waitFor(() => dp.$eval('.st-dub-take[data-take="' + slowId + '"]', (e) => e.classList.contains('chosen')), 3000, 'latest take starred automatically');
      assert((await dp.$$('.st-dub-take.chosen')).length === 1, 'one starred take');
      await dp.keyboard.press('KeyR');
      await waitFor(() => dp.evaluate(() => !document.querySelector('.st-list > .st-dubbox')), 3000, 'disney dub mode closed');
      // 더빙 모드에서 ☆ 녹음이 반복 재생 중이었을 수 있다 → 멈추고 내 더빙이 꺼질 때까지 기다린 뒤 보통 시청처럼 앞에서부터
      await dp.evaluate(() => document.querySelector('video').pause());
      await waitFor(() => dp.evaluate(() => !document.querySelector('.st-ov-dub').classList.contains('on') && !document.querySelector('video').muted), 3000, 'dub stopped while paused');
      await sleep(300);
      await dp.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.currentTime = 4.6; v.play(); });
      const tl = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 4800) {
        tl.push(await dp.evaluate(() => [document.querySelector('video').currentTime, document.querySelector('video').muted, document.querySelector('.st-ov-dub').classList.contains('on'), document.querySelector('.st-ov-dub').dataset.restarts || '']));
        await sleep(80);
      }
      await dp.evaluate(() => document.querySelector('video').pause());
      const on = tl.filter((x) => x[2]);
      assert(on.length > 15, 'dub played: ' + on.length + ' samples');
      assert(on.every((x) => x[3] === '0'), '녹음을 한 번도 되감지 않았다: ' + JSON.stringify([...new Set(on.map((x) => x[3]))]));
      const flips = tl.filter((x, k) => k && x[2] !== tl[k - 1][2]).length;
      assert(flips === 2, '더빙이 한 번 켜지고 한 번 꺼진다 (탐색 직후 예전 위치로 잘못 시작하지 않는다): 바뀐 횟수 ' + flips);
      const mutedAt = tl.filter((x) => x[1]).map((x) => x[0]);
      assert(Math.min(...mutedAt) > 5.5 && Math.max(...mutedAt) < 8.8, 'muted only around the line: ' + Math.min(...mutedAt).toFixed(2) + '–' + Math.max(...mutedAt).toFixed(2));
      assert(tl.some((x) => x[0] > 8.9 && !x[1]) && tl.some((x) => x[0] < 5.4 && !x[1]), 'original sound before and after');
    });
    await step('디즈니+(모의) 새로고침해도 더빙한 대사는 내 녹음으로 나온다 (재생 위치를 0.3초마다 미세하게 고쳐도 깜빡이지 않음)', async () => {
      await dp.reload({ waitUntil: 'domcontentloaded' });
      await dp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => dp.$('.st-row.st-dubbed'), 20000, 'dubbed line marked after reload');
      await dp.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.muted = false; v.currentTime = 4.6; });
      await sleep(600);
      await dp.click('.st-status'); // 재생 버튼을 누르듯 화면을 한 번 누른다 (브라우저 자동 재생 규칙)
      await dp.evaluate(() => document.querySelector('video').play());
      const tl = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 4800) {
        tl.push(await dp.evaluate(() => [document.querySelector('video').currentTime, document.querySelector('video').muted, document.querySelector('.st-ov-dub').classList.contains('on')]));
        await sleep(80);
      }
      await dp.evaluate(() => document.querySelector('video').pause());
      const on = tl.filter((x) => x[2]);
      assert(on.length > 15, 'my dub played after reload: ' + on.length + ' samples');
      const flips = tl.filter((x, k) => k && x[2] !== tl[k - 1][2]).length;
      assert(flips === 2, '더빙이 한 번 켜지고 한 번 꺼진다: 바뀐 횟수 ' + flips);
      const mutedAt = tl.filter((x) => x[1]).map((x) => x[0]);
      assert(Math.min(...mutedAt) > 5.5 && Math.max(...mutedAt) < 8.8, 'muted only around the line: ' + Math.min(...mutedAt).toFixed(2) + '–' + Math.max(...mutedAt).toFixed(2));
    });
    await step('디즈니+(모의) 플레이어가 재생·위치 이벤트를 하나도 주지 않아도(실제 디즈니+): R 은 지금 줄에서 열리고, 내 더빙은 한 번 켜지고 한 번 꺼진다 (0.4초마다 깜빡이지 않음) · 진단 기록 · 맨 위 "더빙 끔"이면 원래 소리만', async () => {
      await dp.goto('https://www.disneyplus.com/play/mockdisney1?events=none', { waitUntil: 'domcontentloaded' });
      await dp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => dp.$('.st-row.st-dubbed'), 20000, 'dubbed line marked (quiet player)');
      await dp.click('.st-status'); // 사용자 동작 한 번 (자동 재생 규칙)
      await dp.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.currentTime = 0.2; v.play(); });
      await sleep(1300);
      await dp.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 6.3; });
      await sleep(700);
      await dp.keyboard.press('KeyR');
      const row = await waitFor(() => dp.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i; }), 3000, 'dub section (quiet player)');
      assert(row === '1', '6.3초(2번 줄)에서 R → 2번 줄 아래 (예전에는 시계가 0.45초 늦게 잡혀 1번 줄에 열렸다): ' + row);
      await dp.keyboard.press('KeyR');
      await waitFor(() => dp.evaluate(() => !document.querySelector('.st-list > .st-dubbox')), 3000, 'dub mode closed (quiet)');
      await dp.evaluate(() => document.querySelector('video').pause());
      await waitFor(() => dp.evaluate(() => !document.querySelector('.st-ov-dub').classList.contains('on') && !document.querySelector('video').muted), 3000, 'dub off while paused (quiet)');
      // 0.02초마다 [위치, 음소거, 내 더빙 캡슐] 을 기록하며 4.6초부터 4.8초 동안 재생
      const run = () => dp.evaluate(() => new Promise((res) => {
        const v = document.querySelector('video'), ov = document.querySelector('.st-ov-dub'), tl = [];
        const timer = setInterval(() => tl.push([v.currentTime, v.muted, ov.classList.contains('on')]), 20);
        v.muted = false; v.currentTime = 4.6; v.play();
        setTimeout(() => { clearInterval(timer); v.pause(); res(tl); }, 4800);
      }));
      const flipsOf = (tl) => tl.filter((x, k) => k && x[2] !== tl[k - 1][2]);
      const tl = await run();
      const on = tl.filter((x) => x[2]);
      assert(on.length > 80 && flipsOf(tl).length === 2, '내 더빙이 한 번 켜지고 한 번 꺼진다: on ' + on.length + ' samples, 바뀐 곳 ' + flipsOf(tl).map((x) => x[0].toFixed(2) + (x[2] ? '+' : '-')).join(' '));
      const mutedAt = tl.filter((x) => x[1]).map((x) => x[0]);
      assert(Math.min(...mutedAt) > 5.5 && Math.max(...mutedAt) < 8.6, 'muted only around the line: ' + Math.min(...mutedAt).toFixed(2) + '–' + Math.max(...mutedAt).toFixed(2));
      // ⚙ › 진단 정보: 시계 상태 + 최근 40초 기록 (켜고 끈 까닭), 깜빡임 표시 없음
      const diag = await dp.evaluate(() => { const b = [...document.querySelectorAll('.st-settings button')].find((x) => x.textContent === '진단 정보'); b.click(); return document.querySelector('.st-settings .st-diag').textContent; });
      const clockLine = diag.split('\n').find((l) => l.startsWith('clock')) || '';
      assert(/precise=true/.test(clockLine) && /playerEvents=\{"t":0,"p":0,"r":0,"s":0/.test(clockLine), 'clock line: ' + clockLine);
      assert(/최근 40초 기록/.test(diag) && /dub start take=/.test(diag) && /dub stop beyond/.test(diag) && /time\* ms=/.test(diag) && !/FLICKER/.test(diag), 'log: ' + diag.split('\n').filter((l) => /dub |FLICKER/.test(l)).join(' | '));
      // 맨 위 "더빙 끔" → 원래 소리만, 다시 켜면 내 더빙
      await dp.click('.st-dub-toggle');
      await waitFor(() => dp.$eval('.st-dub-toggle', (b) => !b.classList.contains('on') && /더빙 끔/.test(b.textContent)), 2000, 'dub toggle off');
      const off = await run();
      assert(off.every((x) => !x[2] && !x[1]), '더빙 끔: 내 더빙도 음소거도 없다');
      await dp.click('.st-dub-toggle');
      await waitFor(() => dp.$eval('.st-dub-toggle', (b) => b.classList.contains('on') && /더빙 켬/.test(b.textContent)), 2000, 'dub toggle on');
      const again = await run();
      assert(again.filter((x) => x[2]).length > 80 && flipsOf(again).length === 2, '다시 켜면 내 더빙 (한 번 켜지고 한 번 꺼짐): ' + flipsOf(again).length);
    });
    await step('디즈니+(실제처럼: 탐색마다 영상 시각이 20초에서 다시 시작 · 재생 이벤트 없음 · 0.265초 계단 · 키프레임에서 일찍 시작): 녹음 → 들어보기 → 다음 줄로 넘어가도 그 줄을 끝까지 재생하고 끝에서만 되감는다 (0.5초마다 되감지 않음) · 앞 줄 더빙이 새 줄에서 나오지 않는다 · 옮긴 뒤 시계 오차 0.1초 안', async () => {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubAutoPreview: true, dubAutoNext: true } }, {}));
      try {
        await dp.goto('https://www.disneyplus.com/play/mockdisney1?real=1', { waitUntil: 'domcontentloaded' });
        await dp.waitForSelector('#st-panel', { timeout: 20000 });
        await waitFor(() => dp.$$eval('.st-row', (r) => r.length === 10), 20000, 'rows (real-like)');
        await dp.click('.st-status'); // 사용자 동작 한 번 (자동 재생 규칙)
        await dp.evaluate(() => { document.querySelector('video').muted = false; window.__player.play(); });
        await sleep(1500);
        await dp.evaluate(() => window.__player.seek(6300)); // 디즈니+ 플레이어로 옮긴다 → 영상 시각은 20초에서 다시 시작
        await sleep(300);
        await dp.evaluate(() => window.__player.pause());
        await sleep(900);
        await dp.keyboard.press('KeyR');
        const row = await waitFor(() => dp.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i; }), 3000, 'dub box (real-like)');
        assert(row === '1', '6.3초에서 R → 2번 줄 (탐색 뒤 시계를 새로 잰다, 예전 시계면 20초 근처 줄): ' + row);
        await sleep(400);
        await dp.keyboard.press('KeyK'); // 녹음 → 내 녹음 들어보기 → 다음 줄로
        await waitFor(() => dp.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i === '2'; }), 30000, 'recorded, previewed and moved on to row 2')
          .catch(async (e) => { throw new Error(e.message + ' toast=' + await dp.$eval('.st-toast', (t) => t.textContent).catch(() => '')); });
        const take = await sw.evaluate(async () => { const o = await chrome.storage.local.get(null); const seg = o['dubs:disney:mockdisney1'].segs.find((x) => x.cueStart === 6000); return seg.takes.find((t) => t.id === seg.chosen); });
        assert(Math.abs(take.clipStartMs - 5750) < 150 && Math.abs(take.ms - 2500) < 150, '녹음이 2번 줄에 맞는다: ' + JSON.stringify(take));
        // 다음 줄(10~12초)을 6초 동안 본다: [경과 ms, 콘텐츠 ms, 탐색 횟수, 내 더빙 녹음 id]
        const tl = await dp.evaluate(() => new Promise((res) => {
          const out = [], ov = document.querySelector('.st-ov-dub'), t0 = performance.now();
          const timer = setInterval(() => out.push([Math.round(performance.now() - t0), Math.round(window.__contentMs()), window.__seeks.length, ov.classList.contains('on') ? ov.dataset.take : '']), 50);
          setTimeout(() => { clearInterval(timer); res(out); }, 6000);
        }));
        const seekAt = tl.filter((x, k) => k && x[2] !== tl[k - 1][2]).map((x) => x[0]);
        const gaps = seekAt.slice(1).map((x, k) => x - seekAt[k]);
        assert(seekAt.length <= 3 && gaps.every((g) => g > 1500), '줄 끝에서만 되감는다 (예전에는 0.5초마다): ' + seekAt.join(','));
        assert(Math.max(...tl.map((x) => x[1])) > 11900, '3번 줄을 끝까지 재생한다: ' + tl.filter((x, k) => k % 8 === 0).map((x) => x[1]).join(' '));
        assert(!tl.some((x) => x[3] === take.id && x[1] > 9000), '앞 줄 더빙이 새 줄에서 나오지 않는다');
        // 사용자가 디즈니+ 에서 직접 옮겨도 1.4초 뒤에는 시계가 0.1초 안으로 맞는다
        await dp.keyboard.press('KeyR');
        await sleep(300);
        await dp.evaluate(() => { window.__player.seek(14100); window.__player.play(); });
        await sleep(1400);
        const acc = await dp.evaluate(() => { const b = [...document.querySelectorAll('.st-settings button')].find((x) => x.textContent === '진단 정보'); b.click(); const c = window.__contentMs(); const line = document.querySelector('.st-settings .st-diag').textContent.split('\n').find((l) => l.startsWith('clock')) || ''; return { c: Math.round(c), raw: +(/raw=(-?\d+)/.exec(line) || [])[1], precise: /precise=true/.test(line), line }; });
        assert(acc.precise && Math.abs(acc.raw - acc.c) < 100, '옮긴 뒤 시계: ' + JSON.stringify(acc));
      } finally {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubAutoPreview: false, dubAutoNext: false } }, {})).catch(() => {});
        await dp.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox .st-dub-close'); if (b) b.click(); window.__player.pause(); }).catch(() => {});
        await sleep(300);
      }
    });
    await step('디즈니+(모의) 따라하기: 이어 붙은 자막에서도 멈춘 동안 따라 할 줄이 화면·패널에 남고, 그 자막 길이만큼 쉰 뒤 이어 간다', async () => {
      await dp.goto('https://www.disneyplus.com/play/mockdisney2', { waitUntil: 'domcontentloaded' });
      await dp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => dp.$$eval('.st-row', (r) => r.length === 5), 20000, 'adjacent rows');
      await dp.select('.st-shadow-sec', 'r1');
      await dp.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.play(); });
      await sleep(500);
      await dp.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 2.6; });
      await sleep(700);
      await dp.keyboard.press('KeyW');
      await waitFor(() => dp.$eval('.st-mode.st-shadow', (b) => b.classList.contains('on')), 3000, 'follow mode on (disney)');
      await dp.evaluate(() => document.querySelector('video').play());
      const at = await waitFor(() => dp.evaluate(() => { const v = document.querySelector('video'); return v.paused ? { t: v.currentTime, ov: document.querySelector('.st-ov-text').textContent, row: document.querySelector('.st-row.active') && document.querySelector('.st-row.active').dataset.i } : null; }), 8000, 'paused after line one');
      const t0 = Date.now();
      await sleep(600);
      const mid = await dp.evaluate(() => ({ t: document.querySelector('video').currentTime, ov: document.querySelector('.st-ov-text').textContent, row: document.querySelector('.st-row.active') && document.querySelector('.st-row.active').dataset.i }));
      assert(/Line one/.test(at.ov) && at.row === '0' && /Line one/.test(mid.ov) && mid.row === '0' && mid.t < 4.05, '멈춘 동안 따라 할 줄(1번)이 그대로: ' + JSON.stringify({ at, mid }));
      await waitFor(() => dp.evaluate(() => !document.querySelector('video').paused), 8000, 'resumed by itself');
      const waited = Date.now() - t0 + 600;
      assert(waited >= 1500 && waited <= 3200, '1번 자막 길이(2초)만큼 쉰다: ' + waited + 'ms');
      await sleep(500);
      const after = await dp.evaluate(() => ({ t: document.querySelector('video').currentTime, ov: document.querySelector('.st-ov-text').textContent }));
      assert(/Line two/.test(after.ov) && after.t < 5.4, '이어서 2번 자막을 처음부터: ' + JSON.stringify(after));
      await dp.evaluate(() => { document.querySelector('video').pause(); const b = document.querySelector('.st-mode.st-shadow.on'); if (b) b.click(); });
    });
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

// ── 범용 사이트(모의): TVNZ+(광고가 이어 붙은 DASH · wvtt 자막) · NZ On Screen(Brightcove) · Vimeo(<track>) · TED(통째 자막 파일).
//    따로 띄운 크롬에서 진짜 주소를 모의 서버로 돌린다. 웹사이트(localhost:8766)에서 TVNZ+ 대사 원격 재생까지 본다
async function runSites() {
  const userDataDir = path.join(TMP, 'profile-sites-' + Date.now());
  const hosts = ['www.tvnz.co.nz', 'data-store-cdn.cms-api.tvnz.co.nz', 'vod-origin-cdn.cms-api.tvnz.co.nz', 'www.nzonscreen.com', 'edge.api.brightcove.com', 'vimeo.com', 'www.ted.com', 'translate.googleapis.com', 'clients5.google.com'];
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir,
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--host-resolver-rules=' + hosts.map((h) => 'MAP ' + h + ' 127.0.0.1:8443').concat(NO_REAL_SUPABASE).join(', '),
      '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--window-size=1400,900'],
    acceptInsecureCerts: true,
    defaultViewport: { width: 1400, height: 900 },
    protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT) || 60000,
  });
  const diag = (p) => p.evaluate(() => { const b = [...document.querySelectorAll('.st-settings button')].find((x) => x.textContent === '진단 정보'); if (b) b.click(); const d = document.querySelector('.st-settings .st-diag'); return d ? d.textContent : ''; });
  const vt = (p) => p.evaluate(() => document.querySelector('video').currentTime);
  try {
    console.log('▶ 범용 사이트 (모의 TVNZ+ · NZ On Screen · Vimeo · TED · 아무 사이트)');
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
    const sw = await swTarget.worker();
    await waitFor(() => sw.evaluate(() => typeof globalThis.__subtutorHandle === 'function' && !!(globalThis.chrome && chrome.storage)), 15000, 'service worker (sites)');
    await sw.evaluate(() => chrome.storage.local.clear());
    // 새 저장 옵션(문장 단위·고르기·꼬리·다음 자막)은 전용 스텝에서만 켠다 — clear() 직후라 여기서 꺼 둬야 유지된다
    await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { koMode: 'always', saveSentence: false, saveTailSec: 0, saveNextTexts: false, savePick: false } }, {}));
    const tp = await browser.newPage();
    tp.on('pageerror', (e) => console.log('  [TVNZ 페이지 오류] ' + e.message));
    await tp.goto('https://www.tvnz.co.nz/player/tvepisode/shortland-street-s2026-e110-shortland-street', { waitUntil: 'domcontentloaded' });
    await step('TVNZ+(모의): 광고가 이어 붙은 DASH 의 wvtt 자막 10줄 · 제목·회차는 카탈로그에서 · 광고 경계를 넘는 줄도 한 줄', async () => {
      await tp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => tp.$$eval('.st-row', (r) => r.length === 10), 20000, 'tvnz rows').catch(async (e) => { throw new Error(e.message + ' diag=' + (await diag(tp)).split('\n').slice(0, 12).join(' | ')); });
      const status = await tp.$eval('.st-status', (e) => e.textContent);
      assert(/영어 10줄/.test(status), 'status ' + status);
      const rows = await tp.$$eval('.st-row .st-en', (r) => r.map((e) => e.textContent));
      assert(rows[1] === "- My dog Raffie bites all the time when he's playing," && rows[5] === 'Sweet as, see you at morning tea.', 'rows ' + JSON.stringify(rows));
      await waitFor(() => tp.$eval('#st-panel', (e) => e.dataset.title === 'Shortland Street · S2026 E110 · Tuesday 27 Oct 2026'), 8000, 'tvnz title').catch(async (e) => { throw new Error(e.message + ' title=' + await tp.$eval('#st-panel', (x) => x.dataset.title)); });
      const d = await diag(tp);
      assert(/dash=periods 4 content 4\.0-22\.0→0\.0 26\.0-48\.0→18\.0 \(ads\)/.test(d), 'diag dash line: ' + d.split('\n').find((l) => l.startsWith('site=')));
    });
    await step('TVNZ+(모의): 오른쪽 묶음의 전체 화면 버튼 바로 왼쪽에 배속·ST 버튼, 컨트롤이 DOM 에서 빠졌다 다시 생겨도 다시 붙는다 · TVNZ 자막(Shaka)은 숨긴다 · 영상은 패널 왼쪽까지', async () => {
      await tp.mouse.move(300, 300);
      await waitFor(() => tp.$$eval('.player-bottom-options-right > *', (xs) => xs.map((x) => (x.classList.contains('st-rate') ? 'rate' : (x.classList.contains('st-ctl-wrap') || x.classList.contains('st-ctl') ? 'ST' : x.tagName.toLowerCase()))).join(',') === 'rate,ST,app-player-fullscreen'), 5000, 'ST before fullscreen');
      assert((await tp.$eval('.shaka-text-container', (e) => getComputedStyle(e).visibility)) === 'hidden', 'shaka captions hidden');
      await waitFor(() => tp.evaluate(() => !document.querySelector('.player-bottom-options-right')), 6000, 'controls auto-hide (removed from DOM)');
      await tp.mouse.move(420, 360);
      await waitFor(() => tp.$$eval('.player-bottom-options-right > *', (xs) => xs.length === 3 && xs[2].tagName === 'APP-PLAYER-FULLSCREEN' && xs[1].classList.contains('st-ctl-wrap')), 5000, 'ST re-inserted after the controls come back');
      const right = await tp.evaluate(() => Math.round(document.querySelector('video').getBoundingClientRect().right));
      assert(right <= 1400 - 400 + 2, 'video beside the panel: right=' + right);
    });
    await step('TVNZ+(모의): 광고 중에는 영상 위 자막을 감추고, 줄 이동은 광고를 건너뛴 본편 시각으로 (줄 누르기 · D 로 광고 경계 넘기)', async () => {
      await tp.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 23; v.play(); });
      await sleep(900);
      assert(await tp.$eval('#st-overlay', (e) => e.classList.contains('st-hidden')), 'overlay hidden during the mid-roll ad');
      await tp.evaluate(() => { document.querySelector('video').currentTime = 28.6; });
      await waitFor(() => tp.$eval('.st-ov-text', (e) => e.textContent === 'I can catch a frisbee in my mouth.'), 3000, 'overlay after the ad = content 20.6 s');
      await tp.evaluate(() => { document.querySelector('video').pause(); window.__seeks = []; }); // 여기부터는 우리가 옮긴 탐색만
      await tp.click('.st-row[data-i="7"] .st-en');  // 본편 24.0초 → 영상 26 + 6.0 − 앞 여유 0.15 = 31.85초
      await waitFor(async () => { const t = await vt(tp); return t > 31.7 && t < 33.5; }, 3000, 'row 7 → video 31.85 s');
      const pauseNow = () => tp.evaluate(() => document.querySelector('video').pause());
      await tp.click('.st-row[data-i="4"] .st-en');
      await waitFor(async () => { const t = await vt(tp); return t > 17.6 && t < 19.5; }, 8000, 'row 4 → video 17.85 s');
      await pauseNow(); await sleep(250); // 재생이 광고까지 흘러가기 전에 멈추고 누른다 (광고 중의 D 는 아래에서 따로 확인)
      await tp.keyboard.press('KeyD');                 // 5번 줄(본편 17.0초) → 영상 20.85초
      await waitFor(async () => { const t = await vt(tp); return t > 20.7 && t < 22.3; }, 8000, 'D → row 5 at video 20.85 s');
      await pauseNow(); await sleep(250);
      await tp.keyboard.press('KeyD');                 // 6번 줄(본편 20.5초) → 광고(22–26초)를 건너뛰어 영상 28.35초
      await waitFor(async () => { const t = await vt(tp); return t > 28.2 && t < 29.8; }, 8000, 'D across the ad → video 28.35 s');
      // 광고 중의 A/D: 본편 시간이 없는 동안 눌러도 0초로 가지 않고, 광고 앞에서 보던 줄 기준으로 움직인다
      const seeks = await tp.evaluate(() => window.__seeks.slice());
      // (탐색을 잇달아 하면 브라우저가 seeking 이벤트를 합치기도 한다 → 위치는 위의 단계마다 확인했고, 여기서는 광고 구간으로 옮긴 적이 없는지만)
      assert(!seeks.some((ms) => ms >= 22000 && ms < 26000), 'never seeks into the ad: ' + seeks.join(','));
      // 광고 중의 D: 본편 시간이 없는 동안 눌러도 0초로 가지 않고, 광고 앞에서 보던 줄의 다음 줄로 간다
      await tp.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 23.2; v.play(); });
      await sleep(600);
      await tp.evaluate(() => { window.__seeks = []; }); // 위의 23.2초 이동은 테스트가 한 것 — D 가 만드는 탐색만 본다
      await tp.keyboard.press('KeyD');
      await waitFor(async () => { const t = await vt(tp); return t > 26 && t < 48; }, 3000, 'D during the ad lands in content, not at 0');
      const adSeeks = await tp.evaluate(() => window.__seeks.slice());
      assert(adSeeks.length && adSeeks.every((ms) => ms >= 26000), 'D from the ad goes straight to content: ' + adSeeks.join(','));
      await tp.evaluate(() => document.querySelector('video').pause());
    });
    await step('TVNZ+(모의): 저장한 대사를 웹에서 ▶ 하면 TVNZ 탭이 그 대사만(광고를 건너뛴 본편 시각) 재생하고 멈춘다 · 목록에 "TVNZ+"', async () => {
      await tp.click('.st-row[data-i="7"] .st-star');
      await waitFor(() => sw.evaluate(async () => ((await chrome.storage.local.get('items')).items || []).length === 1), 5000, 'tvnz item saved');
      const item = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items[0]);
      assert(item.platform === 'tvnz' && item.videoId === 'shortland-street-s2026-e110-shortland-street' && item.startMs === 24000 && item.endMs === 26600 && /^https:\/\/www\.tvnz\.co\.nz\/player\/tvepisode\//.test(item.url), 'item ' + JSON.stringify(item));
      const web = await browser.newPage();
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length === 1), 8000, 'web item');
      const group = await web.$eval('.group-title', (e) => e.textContent);
      assert(/Shortland Street \(TVNZ\+\)/.test(group), 'group title ' + group);
      await web.evaluate(() => { window.__clipEvents = []; window.SubTutorBridge.on('clip.state', (p) => window.__clipEvents.push(p.state)); });
      await web.click('.item .play');
      await waitFor(() => web.evaluate(() => window.__clipEvents.includes('ended')), 20000, 'clip ended').catch(async (e) => { throw new Error(e.message + ' events=' + JSON.stringify(await web.evaluate(() => window.__clipEvents))); });
      const t = await vt(tp);
      const paused = await tp.evaluate(() => document.querySelector('video').paused);
      // 느린 머신에서는 멈춤이 몇 초 늦게 먹을 수 있다 — 대사 끝(34.8초) 뒤에 멈췄고, 영상 끝(48초)까지 가지 않았으면 된다
      assert(paused && t > 34.4 && t < 45, 'TVNZ paused after the line end (34.8 s), before the tail of the video: ' + t.toFixed(2) + ' paused=' + paused);
      await web.close();
    });
    await tp.close();

    const np = await browser.newPage();
    np.on('pageerror', (e) => console.log('  [NZ On Screen 페이지 오류] ' + e.message));
    await np.goto('https://www.nzonscreen.com/title/mock-westside-episode-one-2015', { waitUntil: 'domcontentloaded' });
    await step('NZ On Screen(모의 Brightcove): 재생 정보(JSON)의 자막 파일 · video.js 컨트롤 바의 전체 화면 버튼 왼쪽에 ST · video.js 자막은 숨기고 페이지는 패널 왼쪽까지', async () => {
      await np.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => np.$$eval('.st-row', (r) => r.length === 10), 20000, 'nzos rows');
      assert(/영어 10줄 \(CC\)/.test(await np.$eval('.st-status', (e) => e.textContent)), 'nzos status');
      await waitFor(() => np.$eval('#st-panel', (e) => e.dataset.title === 'Mock Westside - Episode One'), 8000, 'brightcove title');
      const bar = await np.$$eval('.vjs-control-bar > *', (xs) => xs.map((x) => (x.classList.contains('st-rate') ? 'rate' : (x.classList.contains('st-ctl') ? 'ST' : x.className.split(' ')[0]))));
      assert(bar.slice(-3).join(',') === 'rate,ST,vjs-fullscreen-control', 'vjs bar ' + bar.join(','));
      assert((await np.$eval('.vjs-text-track-display', (e) => getComputedStyle(e).visibility)) === 'hidden', 'video.js captions hidden');
      assert((await np.evaluate(() => getComputedStyle(document.body).marginRight)) === '400px', 'page pushed left of the panel');
    });
    await np.close();

    const vp = await browser.newPage();
    await vp.goto('https://vimeo.com/123456789', { waitUntil: 'domcontentloaded' });
    await step('Vimeo(모의): <track> 의 영어·한국어 자막 · 컨트롤 바를 못 찾으면 영상 왼쪽 위의 떠 있는 ST 버튼으로 켜고 끈다', async () => {
      await vp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => vp.$$eval('.st-row', (r) => r.length === 10), 20000, 'vimeo rows');
      assert(/한국어 10줄 연결/.test(await vp.$eval('.st-status', (e) => e.textContent)), 'vimeo ko merged');
      const fl = await waitFor(() => vp.$eval('#st-float', (e) => { const r = e.getBoundingClientRect(); return r.width > 0 ? [Math.round(r.left), Math.round(r.top)] : null; }).catch(() => null), 6000, 'float toggle');
      const vr = await vp.evaluate(() => { const r = document.querySelector('video').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; });
      assert(Math.abs(fl[0] - vr[0] - 10) <= 2 && Math.abs(fl[1] - vr[1] - 10) <= 2, 'float at the video top-left: ' + fl + ' video ' + vr);
      await vp.click('#st-float');
      await waitFor(() => sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings.enabled || {}).vimeo === false), 3000, 'vimeo disabled');
      assert(await vp.$eval('#st-float', (e) => e.classList.contains('off')), 'float shows off');
      await vp.click('#st-float');
      await waitFor(() => sw.evaluate(async () => ((await chrome.storage.local.get('settings')).settings.enabled || {}).vimeo === true), 3000, 'vimeo enabled again');
    });
    await vp.close();

    const dp = await browser.newPage();
    await dp.goto('https://www.ted.com/talks/mock_speaker_do_schools_kill_creativity', { waitUntil: 'domcontentloaded' });
    await step('TED(모의): 플레이어가 받는 언어별 자막 파일 중 영어·한국어만 골라 쓴다 · 이름이 Fullscreen 인 버튼 왼쪽에 ST', async () => {
      await dp.waitForSelector('#st-panel', { timeout: 20000 });
      await waitFor(() => dp.$$eval('.st-row', (r) => r.length === 10), 20000, 'ted rows');
      assert(/한국어 10줄 연결/.test(await dp.$eval('.st-status', (e) => e.textContent)), 'ted ko merged');
      const bar = await dp.$$eval('.bar > *', (xs) => xs.map((x) => (x.classList.contains('st-rate') ? 'rate' : (x.classList.contains('st-ctl') ? 'ST' : x.getAttribute('aria-label')))));
      assert(bar.join(',') === 'Play,Captions,rate,ST,Fullscreen', 'ted bar ' + bar.join(','));
      const d = await diag(dp);
      const kept = (/pageTracks=(\[[^\]]*\])/.exec(d) || [])[1] || '[]';
      assert(JSON.parse(kept).sort().join(',') === 'en:text/file,ko:text/file', 'only en/ko files kept (any order): ' + kept);
    });
    await dp.close();

    await step('아무 사이트에서 켜기: 권한이 없으면 거절 · 권한이 있으면 페이지·콘텐츠 스크립트를 등록 · 빼기로 지운다', async () => {
      const denied = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'sites.add', origin: 'https://www.example-library.test' }, {}));
      assert(denied && denied.ok === false && /권한/.test(denied.error), 'no permission → refused: ' + JSON.stringify(denied));
      const r = await sw.evaluate(async () => {
        const orig = chrome.permissions.contains;
        chrome.permissions.contains = async () => true; // 팝업에서 허용했다고 친다
        try {
          const add = await globalThis.__subtutorHandle({ type: 'sites.add', origin: 'https://www.example-library.test' }, {});
          const reg = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id + ':' + s.matches.slice().sort().reverse().join('|') + ':' + (s.world || 'ISOLATED'));
          const list = (await chrome.storage.local.get('customSites')).customSites;
          await globalThis.__subtutorHandle({ type: 'sites.remove', host: 'www.example-library.test' }, {});
          const after = (await chrome.scripting.getRegisteredContentScripts()).length;
          return { add, reg, list, after };
        } finally { chrome.permissions.contains = orig; }
      });
      assert(r.add.ok && r.add.host === 'www.example-library.test', 'added ' + JSON.stringify(r.add));
      assert(r.reg.includes('st-page-www.example-library.test:https://www.example-library.test/*|http://www.example-library.test/*:MAIN') && r.reg.some((x) => x.startsWith('st-content-www.example-library.test:')), 'registered ' + JSON.stringify(r.reg));
      assert(r.list.length === 1 && r.after === 0, 'list ' + JSON.stringify(r.list) + ' after remove ' + r.after);
      const builtIn = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'sites.add', origin: 'https://www.tvnz.co.nz' }, {}));
      assert(builtIn.ok && builtIn.builtIn, 'built-in site needs no registration');
    });
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

(async () => {
  ensureFixtures();
  const servers = await start({ mockRoot: path.join(__dirname, 'mock'), docsRoot: path.join(ROOT, 'docs'), key: fs.readFileSync(path.join(TMP, 'key.pem')), cert: fs.readFileSync(path.join(TMP, 'cert.pem')) });
  // E2E_ONLY=disney : 모의 디즈니+ 부분만 (디즈니+ 시계를 고칠 때 빠르게 되풀이하려고)
  if (process.env.E2E_ONLY === 'disney' || process.env.E2E_ONLY === 'sites') {
    const run = process.env.E2E_ONLY === 'sites' ? runSites : runDisney;
    try { await run(); } catch (e) { console.log('✖ 치명적 오류: ' + (e && e.stack || e)); results.push({ name: process.env.E2E_ONLY, ok: false }); }
    const bad = results.filter((r) => !r.ok);
    console.log('\n결과: ' + (results.length - bad.length) + '/' + results.length + ' 통과' + (bad.length ? ' — 실패: ' + bad.map((b) => b.name).join(', ') : ''));
    servers.close();
    process.exit(bad.length ? 1 : 0);
  }
  // 모의 Supabase (아이폰 동기화 업로드 검사용) — 시드 없이 빈 상태로 8769 에
  const supaMock = require('child_process').fork(path.join(__dirname, 'mock-supabase.js'), ['', '8769'], { stdio: 'ignore' });
  const supaState = async () => { const r = await fetch('http://127.0.0.1:8769/__state'); return r.json(); };
  const userDataDir = path.join(TMP, 'profile-' + Date.now());
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir,
    args: [
      '--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
      '--host-resolver-rules=MAP www.netflix.com 127.0.0.1:8443, MAP www.youtube.com 127.0.0.1:8443, MAP translate.googleapis.com 127.0.0.1:8443, MAP clients5.google.com 127.0.0.1:8443, ' + NO_REAL_SUPABASE,
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
    // 새 저장 옵션(문장 단위·고르기·꼬리·다음 자막)은 전용 스텝에서만 켠다 — clear() 직후라 여기서 꺼 둬야 유지된다
    await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { koMode: 'always', saveSentence: false, saveTailSec: 0, saveNextTexts: false, savePick: false } }, {}));

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
      await waitFor(() => page.$eval('#st-panel', (e) => /Mock Show/.test(e.dataset.title || '') && /S1:E2/.test(e.dataset.title || '')), 8000, 'title');
      // 맨 위 왼쪽의 더빙 켬/끔: 누르면 설정이 바뀌고 다시 누르면 돌아온다
      const dubPlaybackSaved = () => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.dubPlayback);
      assert(await page.$eval('.st-head > :first-child', (b) => b.classList.contains('st-dub-toggle') && b.classList.contains('on') && b.getAttribute('aria-checked') === 'true'), 'dub toggle on by default');
      await page.click('.st-dub-toggle');
      await waitFor(async () => (await page.$eval('.st-dub-toggle', (b) => !b.classList.contains('on') && /더빙 끔/.test(b.textContent))) && (await dubPlaybackSaved()) === false, 3000, 'toggle off');
      await page.click('.st-dub-toggle');
      await waitFor(async () => (await page.$eval('.st-dub-toggle', (b) => b.classList.contains('on') && /더빙 켬/.test(b.textContent))) && (await dubPlaybackSaved()) === true, 3000, 'toggle on again');
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
    await step('Q: 못 알아들음 표시 → 빨간 별만, 오디오 모드가 켜져 있어도 녹음하지 않는다 · 다시 누르면 해제', async () => {
      await page.evaluate(() => document.querySelector('video').pause());   // 이 스텝은 몇 초 걸린다 — 재생이 흘러 다음 스텝의 자막(Raffie)을 지나치지 않게
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { audioMode: 'store' } }, {}));   // 오디오 모드가 켜져 있어도
      await sleep(300);
      await page.keyboard.press('KeyQ');
      const it = await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = (items || []).find((i) => i.id === 'netflix:12345:6000'); return x && x.missed ? x : null; }, 6000, 'missed item saved');
      assert((it.tags || []).includes('못 알아들음'), 'missed tag: ' + JSON.stringify(it.tags));
      await waitFor(() => page.evaluate(() => document.querySelector('.st-ov-star').classList.contains('missed')), 3000, 'overlay star marks missed');
      // 목록 줄에는 빨간 별 — 그리고 오디오는 녹음되지 않는다
      await waitFor(() => page.evaluate(() => { const r = [...document.querySelectorAll('.st-row')].find((x) => x.classList.contains('missed-star')); return r ? getComputedStyle(r.querySelector('.st-star')).color : null; }), 3000, 'red star class')
        .then((col) => assert(col === 'rgb(239, 68, 68)', '별이 빨갛다: ' + col));
      await sleep(2500);   // 녹음이 시작됐다면 이 사이에 칩·오디오가 생긴다
      const audioKeys = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('audio:netflix:12345:6000')));
      assert(audioKeys.length === 0, 'Q 는 오디오를 담지 않는다: ' + JSON.stringify(audioKeys));
      assert(!(await page.evaluate(() => { const c = document.querySelector('.st-chip'); return c && c.classList.contains('show') && c.classList.contains('st-chip-rec'); })), '녹음 칩이 뜨지 않는다');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { audioMode: 'off' } }, {}));
      await sleep(300);
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
    await step('NZ 모음 주석: think 처럼 NZ 발음이 다른 단어에 점선 밑줄 + "~처럼 들림" 설명, 끄면 사라진다', async () => {
      const row = '.st-row[data-i="7"]'; // "I don't think she's paying attention."
      await waitFor(() => page.$(row + ' u.st-nzv'), 6000, 'nzv underline on think');
      const t = await page.$eval(row + ' u.st-nzv', (u) => u.textContent + '|' + u.title);
      assert(/^think\|/.test(t) && /thunk/.test(t) && /KIT/.test(t), 'think hint: ' + t);
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { nzNotes: false } }, {}));
      await waitFor(() => page.evaluate(() => !document.querySelector('.st-row u.st-nzv')), 5000, 'toggled off removes the dotted underlines');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { nzNotes: true } }, {}));
      await waitFor(() => page.$(row + ' u.st-nzv'), 5000, 'toggled back on');
    });
    await step('어휘 프로파일: 상태줄의 말 속도·3천 밖 비율, 어휘 목록 상자, 에피소드 통계', async () => {
      const status = await page.$eval('.st-status', (e) => e.textContent);
      assert(/wpm/.test(status) && /3천 밖 \d+%/.test(status), 'status with profile: ' + status);
      await page.evaluate(() => [...document.querySelectorAll('#st-panel .st-foot-btn')].find((b) => b.textContent.trim() === '어휘 통계').click());   // 순번이 아니라 글자로 (발치 버튼은 바뀔 수 있다)
      await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-infobox'); return b && !b.classList.contains('st-hidden') && /이 에피소드 어휘/.test(b.textContent) && document.querySelectorAll('.st-vocab-row').length >= 1; }), 4000, 'vocab box');
      const words = await page.$$eval('.st-vocab-row b', (els) => els.map((e) => e.textContent));
      assert(words.includes('frisbee'), 'beyond-3k words include frisbee: ' + words.join(','));
      await page.click('.st-infobox-head .st-icon');
      const st = await waitFor(async () => { const r = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats); const e = r && r.episodes && r.episodes['netflix:12345']; return e && e.lines === 10 && e.watched >= 1 ? e : null; }, 8000, 'episode stats');
      assert(st.wpm > 0 && st.title === 'Mock Show', 'episode stat ' + JSON.stringify(st));
      const series = await sw.evaluate(async () => (await chrome.storage.local.get('stats')).stats.series['netflix:Mock Show']);
      assert(series && series.episodes.includes('12345') && series.words.frisbee === 1, 'series words ' + JSON.stringify(series && Object.keys(series.words).slice(0, 5)));
    });
    await step('단어 목록: 패널에 2칸 · 어려운 단어부터 · 쉬운 단어부터(아주 쉬운 단어 빼기) · 뜻 모두 보기/단어별 뜻(오른쪽) · ☆ 저장 → 단어장', async () => {
      await page.click('.st-foot-words');
      await waitFor(() => page.$('.st-wordview:not(.st-hidden) .st-word'), 3000, 'word view');
      const v = await page.evaluate(() => {
        const g = document.querySelector('.st-word-grid');
        const cells = [...g.querySelectorAll('.st-word')];
        const a = cells[0].getBoundingClientRect(), b = cells[1].getBoundingClientRect();
        return { words: cells.map((e) => e.dataset.word), cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, sideBySide: Math.abs(a.top - b.top) < 2 && b.left >= a.right - 1, listHidden: document.querySelector('.st-list').offsetParent === null, count: document.querySelector('.st-word-count').textContent };
      });
      assert(v.cols === 2 && v.sideBySide, 'two columns: ' + JSON.stringify(Object.assign({}, v, { words: v.words.length })));
      assert(v.listHidden && v.count === '단어 ' + v.words.length + '개', 'word list replaces the subtitle list: ' + v.count);
      assert(new Set(v.words).size === v.words.length, 'no duplicates');
      assert(!v.words.includes('raffie') && !v.words.includes('rory') && v.words.includes("you're") && v.words.includes('really'), 'names left out, quoted words kept: ' + v.words.join(','));
      assert(v.words.indexOf('frisbee') < v.words.indexOf('dog') && v.words.indexOf('dog') < v.words.indexOf('the'), 'hard words first: ' + v.words.slice(0, 8).join(','));
      await page.select('.st-word-sort', 'easy');
      const easy = await page.$$eval('.st-word', (x) => x.map((e) => e.dataset.word));
      assert(['you', "you're", 'i', "i'm", "i've"].includes(easy[0]) && easy.indexOf('the') < easy.indexOf('frisbee'), 'easy words first: ' + easy.slice(0, 6).join(','));
      await page.select('.st-word-sort', 'easyNoBasic');
      const nb = await page.$$eval('.st-word', (x) => x.map((e) => e.dataset.word));
      assert(!nb.includes('the') && !nb.includes('i') && !nb.includes('my') && nb.includes('frisbee') && nb.length < easy.length, 'very easy words left out: ' + nb.slice(0, 6).join(','));
      await waitFor(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.wordSort)) === 'easyNoBasic', 3000, 'sort remembered');
      await page.click('.st-word[data-word="frisbee"] .st-word-mean');
      await waitFor(() => page.$eval('.st-word[data-word="frisbee"] .st-word-m', (e) => e.textContent === '[번역] frisbee'), 5000, 'one meaning (machine translation)');
      assert((await page.$$('.st-word .st-word-m')).length === 1, 'only that word shows its meaning');
      await page.click('.st-word-all');
      await waitFor(() => page.$$eval('.st-word', (x) => x.every((e) => e.querySelector('.st-word-m') && /^\[번역\] /.test(e.querySelector('.st-word-m').textContent))), 8000, 'all meanings');
      const pair = await page.$eval('.st-word[data-word="frisbee"]', (e) => { const w = e.querySelector('.st-word-w').getBoundingClientRect(), m = e.querySelector('.st-word-m').getBoundingClientRect(); return { right: m.left >= w.right - 1, top: Math.round(m.top - w.top) }; });
      assert(pair.right && Math.abs(pair.top) < 10, 'meaning on the right of the word: ' + JSON.stringify(pair));
      await page.screenshot({ path: path.join(TMP, 'shots', 'panel-words.png') });
      await page.click('.st-word[data-word="frisbee"] .st-word-save');
      const card = await waitFor(async () => { const w = await sw.evaluate(async () => (await chrome.storage.local.get('words')).words); return w && w.find((x) => x.word === 'frisbee'); }, 4000, 'word saved');
      assert(card.meaning === '[번역] frisbee' && /catch a frisbee/.test(card.sentence) && card.source && card.source.platform === 'netflix' && card.source.videoId === '12345' && card.source.title === 'Mock Show', 'card: ' + JSON.stringify(card));
      await waitFor(() => page.$eval('.st-word[data-word="frisbee"] .st-word-save', (b) => b.textContent === '★'), 2000, 'star shown');
      await page.select('.st-word-sort', 'hard');
      await page.click('.st-word-close');
      await waitFor(() => page.evaluate(() => document.querySelector('.st-wordview').classList.contains('st-hidden') && document.querySelector('.st-list').offsetParent !== null), 2000, 'back to the subtitle list');
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
      assert(typeof items[0].thumb === 'string' && items[0].thumb.startsWith('data:image/jpeg') && items[0].thumb.length > 400 && items[0].thumb.length < 30000,
        '장면 썸네일(가로 150px JPEG)이 함께 저장된다: ' + String(items[0].thumb).slice(0, 30) + '… len=' + String((items[0].thumb || '').length));
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
      await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); return items.some((i) => i.text.includes('facts') && i.startMs === 16000 && i.endMs === 18000 && i.offsetMs === -2000); }, 4000, 'saved in video time')
        .catch(async (err) => { // 진단: 키가 페이지에 닿는지·무엇이 막는지
          const diag = await page.evaluate(() => new Promise((res) => {
            const got = { key: false };
            const h = (ev) => { got.key = ev.code; };
            window.addEventListener('keydown', h, true);
            setTimeout(() => { window.removeEventListener('keydown', h, true); res({ got: got.key, active: document.activeElement && (document.activeElement.tagName + '.' + document.activeElement.className), pick: !!document.querySelector('.st-pick'), panelClosed: document.getElementById('st-panel').classList.contains('st-closed'), ctlOff: !!document.querySelector('.st-ctl.off'), toast: (document.querySelector('.st-toast') || {}).textContent || '', chip: (document.querySelector('.st-save-chip') || {}).title || '' }); }, 700);
          }));
          await page.keyboard.press('KeyE');
          const diag2 = await page.evaluate(() => ({ afterToast: (document.querySelector('.st-toast') || {}).textContent || '' }));
          const st = await sw.evaluate(async () => { const x = (((await chrome.storage.local.get('settings')).settings) || {}); return { enabled: x.enabled, savePick: x.savePick, saveSentence: x.saveSentence }; });
          const items2 = await sw.evaluate(async () => (((await chrome.storage.local.get('items')).items) || []).map((i) => i.id + '@' + i.startMs));
          throw new Error(err.message + ' ┃diag=' + JSON.stringify(diag) + ' ┃after=' + JSON.stringify(diag2) + ' ┃settings=' + JSON.stringify(st) + ' ┃items=' + JSON.stringify(items2));
        });
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
    const WEB_PREFS = { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true, dubRecRates: [0.5, 0.7, 1] };
    const dubTakes = () => page.$$eval('.st-dub-take', (x) => x.map((e) => e.dataset.take));
    const vstate = () => page.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, p: v.paused, r: v.playbackRate, m: v.muted }; });
    let dubFour = [];
    await step('더빙 모드 ①: R 로 지금 자막 바로 아래(패널 안, 팝업 아님)에 더빙 칸이 열리고 그 구간만 반복 · 반복 배속 · 배속 연습', async () => {
      await sw.evaluate((w) => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: Object.assign({}, w, { ladderRates: [0.5, 0.5, 0.7, 1] }) } }, {}), WEB_PREFS);
      await page.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.pause(); v.currentTime = 6.3; });
      await sleep(500);
      await page.keyboard.press('KeyR');
      await waitFor(() => page.$('.st-list > .st-dubbox:not(.st-hidden)'), 3000, 'inline dub section');
      const box = await page.evaluate(() => {
        const b = document.querySelector('.st-list > .st-dubbox');
        return { after: b.previousElementSibling && b.previousElementSibling.dataset.i, rowOn: [...document.querySelectorAll('.st-row.st-dub-on')].map((r) => r.dataset.i).join(','), pos: getComputedStyle(b).position,
          popupParts: !!b.querySelector('.st-dub-text, .st-dub-span, .st-dub-rates, .st-dub-switch, .st-dub-clear, .st-dub-hint'), h: Math.round(b.getBoundingClientRect().height),
          play: [...b.querySelectorAll('.st-dub-play-rate')].map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')).join(','),
          rec: [...b.querySelectorAll('.st-dub-rec-rate')].map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')).join(',') };
      });
      assert(box.after === '1' && box.rowOn === '1' && box.pos === 'static', 'right under the current line inside the panel list: ' + JSON.stringify(box));
      assert(!box.popupParts && box.h < 120, 'no repeated subtitle text, no 4th row, no clear-all; compact (' + box.h + 'px): ' + JSON.stringify(box));
      assert(box.play === '0.5,0.7,1*' && box.rec === '0.5,0.7,1*', 'rate buttons: practice = ladder rates without repeats, record rate defaults to 1: ' + JSON.stringify(box));
      // 그 구간만 자동으로 반복 재생
      await waitFor(async () => { const v = await vstate(); return !v.p && v.t > 7.7; }, 6000, 'plays the line');
      await waitFor(async () => { const v = await vstate(); return !v.p && v.t > 5.6 && v.t < 6.4; }, 6000, 'loops back to the start of the line');
      // ① 배속 버튼: 그 배속으로 반복
      await page.click('.st-dub-play-rate[data-rate="0.7"]');
      await waitFor(async () => Math.abs((await vstate()).r - 0.7) < 0.01, 3000, 'loop at 0.7');
      // ▶ 배속 연습: 0.5 → 0.5 → 0.7 → 1 한 번씩, 끝나면 다시 0.7 로 반복
      await page.click('.st-dub-ladder');
      const starts = [];
      let inStart = false;
      await waitFor(async () => {
        const s = await page.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, r: v.playbackRate, on: !!document.querySelector('.st-dub-ladder.on') }; });
        if (s.on && s.t < 6.15 && !inStart) { starts.push(s.r); inStart = true; } else if (s.t > 6.4) inStart = false;
        return !s.on && starts.length > 0;
      }, 30000, 'ladder finished');
      assert(starts.map(String).join(',') === '0.5,0.5,0.7,1', 'each step plays the line from its start at the set rates: ' + starts.join(','));
      await waitFor(async () => { const v = await vstate(); return !v.p && Math.abs(v.r - 0.7) < 0.01; }, 4000, 'after the ladder the line keeps looping at 0.7');
    });
    await step('더빙 모드 ②③: 녹음 배속을 고르면 기억하고, 0.5배로 녹음하면 영상도 0.5배로 흐르며 저장할 때 원래 길이로 맞춘다 · 3개까지 (☆ 은 남김)', async () => {
      await page.click('.st-dub-rec-rate[data-rate="0.5"]');
      await waitFor(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.dubRecRate)) === 0.5, 3000, 'record rate remembered');
      await page.click('.st-dub-rec');
      await waitFor(async () => { const v = await vstate(); return (await page.$eval('.st-dub-rec', (b) => /녹음 중/.test(b.textContent))) && v.m && Math.abs(v.r - 0.5) < 0.01 ? v : null; }, 10000, 'recording at 0.5x with the original muted');
      await waitFor(async () => (await dubTakes()).length === 1 && !(await page.$('.st-dub-rec.on')), 30000, 'slow take saved');
      const slow = await sw.evaluate(async () => { const o = await chrome.storage.local.get(null); const t = o['dubs:netflix:12345'].segs[0].takes[0]; return Object.assign({}, t, { mime: o['dubaudio:' + t.id].mime }); });
      assert(slow.recRate === 0.5 && Math.abs(slow.ms - 2500) < 150 && Math.abs(slow.clipStartMs - 5750) < 100 && slow.mime === 'audio/mpeg', '0.5x take squeezed back to the line length (≈2.5s) and aligned: ' + JSON.stringify(slow));
      assert(/0\.5배 녹음/.test(await page.$eval('.st-dub-take .st-dub-len', (e) => e.textContent)), 'take labelled as a 0.5x recording');
      assert(await page.$eval('.st-dub-take', (e) => e.classList.contains('chosen')), 'the new take is starred without pressing ☆');
      await waitFor(async () => { const v = await vstate(); return !v.p && !v.m && Math.abs(v.r - 0.7) < 0.01; }, 5000, 'after recording the line loops again at 0.7 with sound');
      assert(await page.$eval('.st-dubbox', (b) => b.dataset.mic === 'closed'), 'microphone released');
      // 1배로 두 개 더 → 3개
      await page.click('.st-dub-rec-rate[data-rate="1"]');
      for (let k = 2; k <= 3; k++) {
        await page.click('.st-dub-rec');
        await waitFor(async () => (await dubTakes()).length === k && !(await page.$('.st-dub-rec.on')), 20000, 'take ' + k + ' saved');
      }
      const three = await dubTakes();
      await page.click('.st-dub-take[data-take="' + three[0] + '"] .st-dub-star');
      await waitFor(() => page.$eval('.st-dub-take[data-take="' + three[0] + '"]', (e) => e.classList.contains('chosen')), 3000, 'first take starred');
      await page.click('.st-dub-rec');
      await waitFor(async () => { const t = await dubTakes(); return t.length === 3 && !t.includes(three[1]) && !(await page.$('.st-dub-rec.on')); }, 20000, '4th take saved');
      dubFour = await dubTakes();
      assert(dubFour[0] === three[0] && dubFour[1] === three[2], 'starred take kept, oldest unstarred removed: ' + JSON.stringify({ three, four: dubFour }));
      assert(await page.$eval('.st-dub-take[data-take="' + dubFour[2] + '"]', (e) => e.classList.contains('chosen')), 'the newest take becomes the dub');
      const audioKeys = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('dubaudio:')));
      assert(audioKeys.length === 3 && !audioKeys.includes('dubaudio:' + three[1]), 'removed take audio deleted: ' + JSON.stringify(audioKeys));
      // 다른 줄을 누르면 더빙 칸이 그 줄 아래로 옮겨 가고, 고른 녹음 배속(1)은 그대로
      await page.click('.st-row[data-i="3"] .st-en');
      await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i === '3'; }), 3000, 'section moved under row 3');
      await waitFor(async () => { const v = await vstate(); return !v.p && v.t > 13.7 && v.t < 16.5; }, 5000, 'row 3 loops');
      assert(await page.$eval('.st-dub-rec-rate.on', (b) => b.textContent) === '1', 'record rate stays as chosen');
      assert(await page.$eval('.st-row[data-i="1"]', (r) => r.classList.contains('st-dubbed') && r.querySelector('.st-dub-mark.on') !== null), 'dubbed line marked in the panel');
    });
    await step('더빙 모드 ④: ☆ 를 고르면 더빙 재생이 저절로 켜지고, 닫고 보면 그 구간에서만 원래 소리 대신 내 녹음 · 들어보기 · ✕ 로 지우기', async () => {
      try {
        // 더빙 재생을 꺼 둔 상태에서도 ☆ 를 고르면 켜진다 (따로 켜는 줄은 없앴다)
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubPlayback: false } }, {}));
        await page.click('.st-row[data-i="1"] .st-en');
        await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i === '1'; }), 3000, 'back on row 1');
        await page.click('.st-dub-take[data-take="' + dubFour[1] + '"] .st-dub-star');
        await waitFor(async () => (await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.dubPlayback)) === true, 3000, 'starring turns dub playback on');
        // 들어보기
        await page.click('.st-dub-take[data-take="' + dubFour[1] + '"] .st-dub-play');
        const pv = [];
        const tp = Date.now();
        while (Date.now() - tp < 4500) { pv.push(await page.evaluate(() => [document.querySelector('video').muted, document.querySelector('.st-ov-dub').dataset.take || ''])); await sleep(100); }
        assert(pv.some((x) => x[0] && x[1] === dubFour[1]), 'preview plays that take with the original muted');
        // 닫으면 원래 배속으로, 보통 시청에서 그 구간만 내 녹음
        await page.keyboard.press('KeyR');
        await waitFor(() => page.evaluate(() => !document.querySelector('.st-list > .st-dubbox')), 3000, 'R closes dub mode');
        await waitFor(async () => Math.abs((await vstate()).r - 1) < 0.01, 3000, 'speed back to 1x');
        await page.evaluate(() => document.querySelector('video').pause());
        await waitFor(() => page.evaluate(() => !document.querySelector('.st-ov-dub').classList.contains('on') && !document.querySelector('video').muted), 3000, 'dub stopped while paused');
        await sleep(300);
        await page.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.currentTime = 4.6; v.play(); });
        const tl = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 5200) { tl.push(await page.evaluate(() => [document.querySelector('video').currentTime, document.querySelector('video').muted, document.querySelector('.st-ov-dub').dataset.take || ''])); await sleep(100); }
        await page.evaluate(() => document.querySelector('video').pause());
        const mutedAt = tl.filter((x) => x[1]).map((x) => x[0]);
        assert(mutedAt.length > 8 && Math.min(...mutedAt) >= 5.6 && Math.max(...mutedAt) <= 8.35, 'original muted only in the dubbed line: ' + JSON.stringify(tl.map((x) => [+x[0].toFixed(2), +x[1]])));
        assert(tl.filter((x) => x[1]).every((x) => x[2] === dubFour[1]), 'plays the starred take');
        assert(tl.some((x) => x[0] < 5.6 && !x[1]) && tl.some((x) => x[0] > 8.5 && !x[1]), 'original sound before and after');
        // ✕ 로 하나씩 지운다 (모두 지우기 버튼은 없다)
        await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 6.3; });
        await sleep(400);
        await page.keyboard.press('KeyR');
        await waitFor(() => page.$('.st-list > .st-dubbox'), 3000, 'dub mode again');
        for (let k = 0; k < 3; k++) {
          const before = (await dubTakes()).length;
          await page.click('.st-dub-take .st-dub-del');
          await waitFor(async () => (await dubTakes()).length === before - 1, 3000, 'take ' + (k + 1) + ' deleted');
        }
        await waitFor(async () => (await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('dub')).length)) === 0, 4000, 'all dub data removed');
        assert(!(await page.$('.st-dub-mark')), 'panel mark gone');
      } finally {
        await page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox .st-dub-close'); if (b) b.click(); }).catch(() => {});
        await sw.evaluate((w) => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubPlayback: true, dubRecRate: 1, web: w } }, {}), WEB_PREFS).catch(() => {});
        await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.muted = true; }).catch(() => {});
        await sleep(200);
      }
    });
    await step('더빙 명료도 피드백(실험적): 인식 문장과의 일치율·wpm·멈춤이 녹음 줄에 붙고, 끄면 붙지 않는다 (인식이 없으면 조용히 생략)', async () => {
      const cueText = await page.$eval('.st-row[data-i="8"] .st-en', (e) => e.textContent);
      await sw.evaluate((t) => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubFeedback: true, dubAsrTest: t } }, {}), cueText);
      await sleep(300);
      await page.click('.st-row[data-i="8"] .st-en');
      await sleep(400);
      await page.keyboard.press('KeyR');
      await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox:not(.st-hidden)'); return b && b.previousElementSibling.dataset.i === '8'; }), 4000, 'dub box on row 8');
      assert((await page.$$('.st-dub-take')).length === 0, 'row 8 starts with no takes');
      await page.click('.st-dub-rec');
      await waitFor(async () => (await page.$$('.st-dub-take')).length === 1 && !(await page.$('.st-dub-rec.on')), 30000, 'take saved');
      const fb = await page.$eval('.st-dub-take:last-child .st-dub-fb', (e) => e.textContent + '||' + e.title).catch(() => null);
      assert(fb && /일치 100%/.test(fb) && /\d+wpm/.test(fb) && /원본 \d+ wpm/.test(fb) && /인식된 문장/.test(fb), 'feedback badge: ' + fb);
      // 끄면(또는 인식이 없으면) 배지 없이 저장만 된다
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubFeedback: false, dubAsrTest: '' } }, {}));
      await sleep(300);
      await page.click('.st-dub-rec');
      await waitFor(async () => (await page.$$('.st-dub-take')).length === 2 && !(await page.$('.st-dub-rec.on')), 30000, 'second take saved');
      assert(!(await page.$('.st-dub-take:last-child .st-dub-fb')), 'no badge when the feedback is off');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubFeedback: true } }, {}));
      // 이 단계의 더빙을 지우고 새로고침해 다음 단계가 깨끗한 상태에서 돌게 한다
      await sw.evaluate(async () => { const o = await chrome.storage.local.get(null); const keys = ['dubs:netflix:12345'].concat(Object.keys(o).filter((k) => k.startsWith('dubaudio:'))); await chrome.storage.local.remove(keys); });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#st-panel', { timeout: 15000 });
      await waitFor(() => page.$$eval('.st-row', (r) => r.length === 10), 15000, 'rows after reload');
      await page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; v.pause(); v.currentTime = 20; });
    });
    await step('더빙 녹음 흐름 설정: 원래 소리 먼저 듣기 → 3·2·1 → 녹음 → 내 녹음 바로 들어보기 → 다음 자막으로 넘어가 녹음 준비', async () => {
      try {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubListenFirst: true, dubAutoPreview: true, dubAutoNext: true } }, {}));
        await page.evaluate(() => { const v = document.querySelector('video'); v.muted = false; v.pause(); v.currentTime = 6.3; });
        await sleep(500);
        await page.keyboard.press('KeyR');
        await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i === '1'; }), 3000, 'dub section on row 1');
        await page.click('.st-dub-rec');
        const phases = [];
        let last = '';
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          const s = await page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); const r = document.querySelector('.st-dub-rec'); return { btn: r ? r.textContent.trim() : '', muted: document.querySelector('video').muted, dub: document.querySelector('.st-ov-dub').dataset.take || '', row: b && b.previousElementSibling ? b.previousElementSibling.dataset.i : '' }; });
          const ph = (/듣는/.test(s.btn) ? 'listen' : /^\d$/.test(s.btn) ? 'count' : /녹음 중/.test(s.btn) ? 'rec' : /저장/.test(s.btn) ? 'save' : s.dub ? 'preview' : 'idle') + '@' + s.row + (s.muted ? 'm' : '');
          if (ph !== last) { phases.push(ph); last = ph; }
          if (s.row === '2' && !s.dub && phases.some((x) => x.startsWith('preview'))) break;
          await sleep(60);
        }
        const flow = phases.map((x) => x.split('@')[0]).filter((x) => x !== 'idle' && x !== 'save').filter((x, k, a) => !k || x !== a[k - 1]);
        assert(flow.join('>') === 'listen>count>rec>preview', 'order: ' + phases.join(' → '));
        assert(phases.includes('listen@1') && phases.includes('rec@1m') && phases.includes('preview@1m') && /@2$/.test(last), 'original heard, recorded and previewed with the original muted, then row 2: ' + phases.join(' → '));
      } finally {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { dubListenFirst: false, dubAutoPreview: false, dubAutoNext: false } }, {})).catch(() => {});
        // 녹음을 지운다 (1번 줄로 더빙 칸을 옮겨 ✕)
        await page.click('.st-row[data-i="1"] .st-en').catch(() => {});
        await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i === '1'; }), 3000, 'back on row 1').catch(() => {});
        for (let k = 0; k < 4 && (await page.$('.st-dub-take .st-dub-del')); k++) { await page.click('.st-dub-take .st-dub-del').catch(() => {}); await sleep(300); }
        await page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox .st-dub-close'); if (b) b.click(); }).catch(() => {});
        await waitFor(async () => (await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('dub')).length)) === 0, 4000, 'flow test dubs removed').catch(() => {});
        await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.muted = true; }).catch(() => {});
        await sleep(200);
      }
    });
    await step('더빙 칸: J 배속 연습 · K 녹음 (한 번 더 누르면 멈춤·취소) · 칸 밖의 J·K 는 플레이어 몫 · 줄을 넘겨도 칸이 보이면 목록은 그대로, 칸이 패널 바닥에 닿을 때만 그 줄을 맨 위로', async () => {
      const vp = page.viewport();
      try {
        await page.evaluate(() => { window.__jk = []; document.addEventListener('keydown', (e) => { if (e.code === 'KeyJ' || e.code === 'KeyK') window.__jk.push(e.code); }); const v = document.querySelector('video'); v.pause(); v.muted = false; v.currentTime = 2.3; });
        await sleep(400);
        await page.keyboard.press('KeyJ'); await page.keyboard.press('KeyK');
        await sleep(200);
        assert((await page.evaluate(() => window.__jk.join(','))) === 'KeyJ,KeyK', 'outside dub mode J/K reach the player: ' + await page.evaluate(() => window.__jk.join(',')));
        await page.setViewport({ width: 1400, height: 560 }); // 목록이 스크롤되도록 낮은 창
        await sleep(400);
        await page.keyboard.press('KeyR');
        await waitFor(() => page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox'); return b && b.previousElementSibling.dataset.i === '0'; }), 3000, 'dub section on row 0');
        const badge = await page.evaluate(() => [getComputedStyle(document.querySelector('.st-dub-ladder'), '::after').content, getComputedStyle(document.querySelector('.st-dub-rec'), '::after').content].join(' '));
        assert(badge === '"J" "K"', 'key hints on the buttons: ' + badge);
        await page.keyboard.press('KeyJ');
        await waitFor(() => page.$('.st-dub-ladder.on'), 2000, 'J starts the ladder');
        await page.keyboard.press('KeyJ');
        await waitFor(async () => !(await page.$('.st-dub-ladder.on')), 2000, 'J again stops it');
        await page.keyboard.press('KeyK');
        await waitFor(() => page.$('.st-dub-rec.on'), 3000, 'K starts recording');
        await sleep(300);
        await page.keyboard.press('KeyK');
        await waitFor(async () => !(await page.$('.st-dub-rec.on')), 4000, 'K again cancels');
        assert((await page.$$('.st-dub-take')).length === 0, 'the cancelled recording is not saved');
        assert((await page.evaluate(() => window.__jk.length)) === 2, 'in dub mode J/K are ours, not the player\'s');
        const geo = () => page.evaluate(() => {
          const L = document.querySelector('.st-list'), lr = L.getBoundingClientRect(), b = document.querySelector('.st-list > .st-dubbox'), rows = [...document.querySelectorAll('.st-row.st-dub-on')];
          const last = rows[rows.length - 1], next = last.nextElementSibling === b ? b.nextElementSibling : null;
          return { st: Math.round(L.scrollTop), max: L.scrollHeight - L.clientHeight, row: +rows[0].dataset.i, rowTop: Math.round(rows[0].getBoundingClientRect().top - lr.top), boxBottom: Math.round(b.getBoundingClientRect().bottom - lr.top), h: Math.round(lr.height), nextH: next ? Math.round(next.getBoundingClientRect().height) : 0 };
        });
        let g = await geo();
        assert(g.max > 150, 'the list scrolls in this window: ' + JSON.stringify(g));
        const moves = [];
        for (let k = 0; k < 9 && g.row < 9; k++) {
          const before = g;
          await page.click('.st-dub-next');
          await waitFor(async () => (await geo()).row === before.row + 1, 3000, 'moved to the next line');
          await sleep(700); // 부드러운 스크롤이 끝나기를 기다린다
          g = await geo();
          moves.push({ row: g.row, moved: g.st !== before.st, need: before.boxBottom + before.nextH > before.h, rowTop: g.rowTop, boxBottom: g.boxBottom, h: g.h, st: g.st, max: g.max });
        }
        const bad = moves.filter((m) => m.moved !== m.need || (m.moved && !(m.rowTop >= 0 && m.rowTop <= 14) && !(m.st >= m.max - 1 && m.boxBottom <= m.h + 1)) || (!m.moved && !(m.rowTop >= -1 && m.boxBottom <= m.h + 1)));
        assert(!bad.length && moves.filter((m) => m.moved).length >= 1 && moves.filter((m) => !m.moved).length >= 3, '칸이 바닥에 닿을 때만 그 줄을 맨 위로: ' + JSON.stringify(moves));
        // 그 구간을 반복 재생하는 동안에도 목록은 움직이지 않는다
        const st0 = (await geo()).st;
        await sleep(2500);
        assert((await geo()).st === st0, 'list stays still while the line loops');
      } finally {
        await page.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox .st-dub-close'); if (b) b.click(); const v = document.querySelector('video'); v.pause(); v.muted = true; }).catch(() => {});
        await page.setViewport(vp).catch(() => {});
        await sleep(400);
      }
    });
    await step('다른 에피소드로 넘어가면 그 에피소드 자막을 불러오고, 패널은 지금 줄을 바로 선택한다 (방금 손으로 스크롤했어도)', async () => {
      try {
        await page.evaluate(() => document.querySelectorAll('.st-row').forEach((r) => r.setAttribute('data-old', '1')));
        await page.evaluate(() => { const l = document.querySelector('.st-list'); l.scrollTop = 0; l.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true })); });
        await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); window.__mockEpisode(67890); v.currentTime = 34.4; v.play(); });
        await waitFor(() => page.evaluate(() => document.querySelectorAll('.st-row').length === 10 && !document.querySelector('.st-row[data-old]')), 10000, 'rows rebuilt for the new episode');
        await waitFor(() => page.$eval('.st-row.active', (r) => r.dataset.i === '8'), 6000, 'current line selected');
        await waitFor(() => page.evaluate(() => { const l = document.querySelector('.st-list').getBoundingClientRect(); const r = document.querySelector('.st-row.active').getBoundingClientRect(); return r.top >= l.top - 2 && r.bottom <= l.bottom + 2; }), 3000, 'current line scrolled into view');
      } finally {
        await page.evaluate(() => { document.querySelectorAll('.st-row').forEach((r) => r.setAttribute('data-old', '1')); const v = document.querySelector('video'); v.pause(); window.__mockEpisode(12345); v.currentTime = 10.3; });
        await waitFor(() => page.evaluate(() => /\/watch\/12345$/.test(location.pathname) && document.querySelectorAll('.st-row').length === 10 && !document.querySelector('.st-row[data-old]')), 10000, 'back to the first episode').catch(() => {});
        await sleep(400);
      }
    });
    await step('X 반복 속도 사다리: 설정한 배속 단계대로 반복마다 올라가고, ⚙ 설정에서 단계를 더하고 빼며, 끄면 원래 속도 (음높이 유지)', async () => {
      await setTime(page, 2.3, true);
      await sleep(300);
      await page.keyboard.press('KeyX');
      await waitFor(() => page.evaluate(() => /반복 속도 사다리/.test(document.querySelector('.st-toast').textContent)), 3000, 'ladder toast');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.8) < 0.01), 3000, 'ladder starts at 0.8');
      // 플레이어 재생도 음높이를 유지한다 (크롬 기본값이지만 직접 켜 둔다)
      assert(await page.evaluate(() => { const v = document.querySelector('video'); return !('preservesPitch' in v) || v.preservesPitch === true; }), 'preservesPitch on the video element');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.9) < 0.01), 8000, 'second pass at 0.9');
      // 웹에서 정한 단계를 따른다: 0.55 → 1.3 으로 바꾸면 다음 반복부터 그 값으로
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.55, 1.3], ladderPitch: true } } }, {}));
      await sleep(300);
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1.3) < 0.01), 10000, 'follows the web ladder settings (1.3)');
      // ⚙ 설정의 "반복 속도 사다리" 편집: 입력이 단계 수만큼 보이고, + 추가가 단계를 늘린다 (더빙 연습 사다리와 같은 값)
      await page.evaluate(() => { const st = document.querySelector('.st-settings'); if (st.classList.contains('st-hidden')) [...document.querySelectorAll('#st-panel button')].find((b) => b.title === '설정').click(); });
      await waitFor(() => page.$$eval('.st-ladder-cfg input.st-ladder-rate', (e) => e.length === 2), 3000, 'two rate inputs in the panel settings');
      assert(await page.$$eval('.st-ladder-cfg input.st-ladder-rate', (e) => Math.abs(+e[0].value - 0.55) < 0.001 && Math.abs(+e[1].value - 1.3) < 0.001), 'inputs show the configured rates');
      await page.click('.st-ladder-cfg .st-ladder-add');
      await waitFor(() => sw.evaluate(async () => { const w = ((await chrome.storage.local.get('settings')).settings || {}).web || {}; return Array.isArray(w.ladderRates) && w.ladderRates.length === 3 && Math.abs(w.ladderRates[2] - 1.45) < 0.001; }), 4000, '+ adds a 1.45 step to the shared ladder');
      await waitFor(() => page.$$eval('.st-ladder-cfg input.st-ladder-rate', (e) => e.length === 3), 3000, 'third input appears');
      await page.click('.st-ladder-cfg .st-ladder-del');
      await waitFor(() => sw.evaluate(async () => { const w = ((await chrome.storage.local.get('settings')).settings || {}).web || {}; return Array.isArray(w.ladderRates) && w.ladderRates.length === 2; }), 4000, '− removes the last step');
      await page.evaluate(() => { const st = document.querySelector('.st-settings'); if (!st.classList.contains('st-hidden')) [...document.querySelectorAll('#st-panel button')].find((b) => b.title === '설정').click(); });
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true } } }, {}));
      await page.keyboard.press('KeyX');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 3000, 'rate restored');
    });
    await step('S 일정한 속도 반복: 배속을 바꾸지 않고 반복하며, 반복 중 S↔X 로 모드만 바뀐다', async () => {
      await setTime(page, 2.3, true);
      await sleep(300);
      await page.keyboard.press('KeyS');
      await waitFor(() => page.evaluate(() => /이 자막 반복 · 1×/.test(document.querySelector('.st-toast').textContent)), 3000, 'steady loop toast with the current rate');
      await page.evaluate(() => { window.__seeks = []; });
      await waitFor(() => page.evaluate(() => window.__seeks.length >= 1), 12000, 'looped back at least once');
      assert(await page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 'steady loop keeps 1×');
      assert(await page.evaluate(() => !!document.querySelector('.st-ov-chip.on-loop')), 'loop chip on');
      // S 반복 중 X → 사다리 1단계(0.8)로, 사다리 중 S → 일정(시작 배속)으로. 반복은 꺼지지 않는다
      await page.keyboard.press('KeyX');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 0.8) < 0.01), 3000, 'S→X switches to the ladder first step');
      await page.keyboard.press('KeyS');
      await waitFor(() => page.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 3000, 'X→S returns to the steady rate');
      assert(await page.evaluate(() => !!document.querySelector('.st-ov-chip.on-loop')), 'still looping after the switch');
      await page.keyboard.press('KeyS');
      await waitFor(() => page.evaluate(() => !document.querySelector('.st-ov-chip.on-loop')), 3000, 'loop off');
    });
    await step('자막 전체 복사: 패널 아래 드롭다운에서 영어/영어+시간/한글을 복사한다 (더빙 오른쪽)', async () => {
      await browser.defaultBrowserContext().overridePermissions('https://www.netflix.com', ['clipboard-read', 'clipboard-write']);
      await page.bringToFront();
      assert(await page.evaluate(() => { const b = document.querySelector('.st-foot .st-copy-btn'); const d = document.querySelector('.st-foot .st-foot-dub'); return b && d && d.compareDocumentPosition(b.closest('.st-copy-wrap')) & Node.DOCUMENT_POSITION_FOLLOWING; }), 'copy dropdown sits right of the dub button');
      await page.click('.st-copy-btn');
      await waitFor(() => page.evaluate(() => !document.querySelector('.st-copy-menu').classList.contains('st-hidden') && document.querySelectorAll('.st-copy-item').length === 4), 3000, 'menu opens with 4 choices');
      await page.click('.st-copy-item[data-copy="en-t"]');
      await waitFor(() => page.evaluate(() => /영어 자막 10줄을 복사했습니다 \(시간 포함\)/.test(document.querySelector('.st-toast').textContent)), 4000, 'copy toast');
      const txt = await page.evaluate(() => navigator.clipboard.readText());
      const lines = txt.split('\n');
      assert(lines.length === 12 && lines[0].length > 0 && lines[1] === '', 'title line + blank + 10 cue lines');
      assert(/^\[0:02\] Hello there, welcome to the test\.$/.test(lines[2]), 'timestamped english line');
      assert(await page.evaluate(() => document.querySelector('.st-copy-menu').classList.contains('st-hidden')), 'menu closes after copying');
      await page.click('.st-copy-btn');
      await page.click('.st-copy-item[data-copy="en"]');
      await waitFor(() => page.evaluate(() => /영어 자막 10줄을 복사했습니다/.test(document.querySelector('.st-toast').textContent)), 4000, 'plain copy toast');
      const plain = await page.evaluate(() => navigator.clipboard.readText());
      assert(plain.split('\n')[2] === 'Hello there, welcome to the test.', 'no timestamp when not asked');
      await page.click('.st-copy-btn');
      await page.click('.st-copy-item[data-copy="ko"]');
      await waitFor(() => page.evaluate(() => /한글 해석 10줄을 복사했습니다/.test(document.querySelector('.st-toast').textContent)), 4000, 'korean copy toast (missing lines allowed)');
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
      assert(it.audio.ms > 2300 && it.audio.ms < 2800, 'clip length ' + it.audio.ms + ' (lines=' + it.text.split('\n').length + ' ' + it.startMs + '-' + it.endMs + ', 묶임·꼬리 설정이 살아 있으면 커진다)');
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

    await step('영상 오디오 통째 MP3(합성 신호): 폴더에 한 파일로 저장되고, 멈춘(paused) 동안은 건너뛴다', async () => {
      const started = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.start', test: 'sweep', title: 'E2E Sweep' }, { tab: { id: 777 } }));
      assert(started && started.ok, '통째 녹음 시작: ' + JSON.stringify(started));
      try {
        await sleep(1600);
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.beat', paused: true, title: 'E2E Sweep' }, { tab: { id: 777 } }));
        await sleep(1300);   // 멈춘 동안의 소리는 버려진다
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.beat', paused: false, title: 'E2E Sweep' }, { tab: { id: 777 } }));
        await sleep(1600);
        const saved = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.stop' }, {}));
        assert(saved && saved.ok && saved.location === 'folder', '지정 폴더에 저장: ' + JSON.stringify(saved));
        assert(/^e2e-docs\/SubTutor\/영상 오디오\/E2E Sweep .+\.mp3$/.test(saved.fileName), '파일 이름: ' + saved.fileName);
        assert(saved.durMs > 2200 && saved.durMs < 4600, '담긴 길이 ≈ 3.2초 (멈춘 1.3초 제외): ' + saved.durMs);
        assert(saved.skippedMs > 600, '멈춘 동안을 건너뛰었다: ' + saved.skippedMs);
        const got = await opt.evaluate(async (pth) => {
          const root = await navigator.storage.getDirectory();
          let dir = await root.getDirectoryHandle('e2e-docs');
          const parts = pth.split('/').slice(1);
          for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
          const f = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
          return { size: f.size, b64: await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); }) };
        }, saved.fileName);
        const buf = Buffer.from(got.b64, 'base64');
        assert(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0, 'mp3 sync bytes: ' + buf.slice(0, 4).toString('hex'));
        const file = path.join(TMP, 'e2e-rec-full.mp3');
        fs.writeFileSync(file, buf);
        const probe = require('child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,channels', '-of', 'default=nw=1', file]).toString();
        assert(/codec_name=mp3/.test(probe) && /channels=1/.test(probe), 'ffprobe: ' + probe.replace(/\s+/g, ' '));
        const durMs = parseFloat(/duration=([\d.]+)/.exec(probe)[1]) * 1000;
        assert(Math.abs(durMs - saved.durMs) < 800, '파일 길이 ' + Math.round(durMs) + ' ≈ 기록 ' + saved.durMs);
        // 올라가는 사인 스위프: 멈춘 구간을 이어 붙여도 소리가 비지 않고, 뒤가 앞보다 높다
        const pcm = require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '32000', '-'], { maxBuffer: 1 << 26 });
        const n = pcm.length / 2;
        const win = (frac) => { const a = Math.floor(n * frac), len = 32000 * 0.2; let cross = 0, prev = 0, sq = 0; for (let i = a; i < a + len; i++) { const v = pcm.readInt16LE(i * 2); sq += v * v; if ((v >= 0) !== (prev >= 0) && i > a) cross++; prev = v; } return { hz: Math.round(cross / 2 / 0.2), rms: Math.round(Math.sqrt(sq / len)) }; };
        const w = [0.15, 0.8].map(win);
        assert(w.every((x) => x.rms > 1200), '빈 구간이 없다: ' + JSON.stringify(w));
        assert(w[1].hz > w[0].hz + 80, '이어 붙인 자리 너머로도 스위프가 올라간다: ' + JSON.stringify(w));
        // 웹이 아이폰으로 올릴 수 있게 녹음 목록에 적힌다
        const recs = await sw.evaluate(async () => (await chrome.storage.local.get('recordings')).recordings || []);
        assert(recs.length === 1 && recs[0].title === 'E2E Sweep' && !recs[0].sent && recs[0].file && recs[0].file.location === 'folder', '녹음 목록 항목: ' + JSON.stringify(recs));
      } finally {
        // 다음 단계(지정 폴더에 MP3 1개 검사)를 위해 통째 녹음 파일·내려받기를 치운다
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.stop' }, {})).catch(() => {});
        await opt.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          try { const dir = await (await root.getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); await dir.removeEntry('영상 오디오', { recursive: true }); } catch (e) { /* 없음 */ }
        });
        const dls = await sw.evaluate(() => new Promise((r) => chrome.downloads.search({}, r)));
        for (const d of dls) { await sw.evaluate((id) => chrome.downloads.removeFile(id).catch(() => {}), d.id).catch(() => {}); await sw.evaluate((id) => new Promise((r) => chrome.downloads.erase({ id }, r)), d.id).catch(() => {}); }
        await sw.evaluate(() => chrome.storage.local.remove('recordings'));   // 다음 스텝이 제 것을 심는다
      }
    });

    await step('저장 폴더가 없으면 통째 MP3 는 다운로드 폴더로 가고, 확장 프로그램이 복사본을 두어 웹이 그대로 읽는다 (사용자 손 안 감)', async () => {
      await opt.evaluate(async () => { window.__savedHandle = await window.SubTutorFS.getHandle(); await window.SubTutorFS.setHandle(null); });
      try {
        const started = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.start', test: 'sweep', title: 'No Folder' }, { tab: { id: 778 } }));
        assert(started && started.ok, 'rec start: ' + JSON.stringify(started));
        await sleep(1600);
        const saved = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.stop' }, {}));
        assert(saved && saved.ok && saved.location === 'downloads' && !saved.copyError, '다운로드 폴더로 저장: ' + JSON.stringify(saved));
        const recs = await sw.evaluate(async () => (await chrome.storage.local.get('recordings')).recordings || []);
        assert(recs.length === 1 && recs[0].file.location === 'downloads' && recs[0].file.opfs === true, '복사본 표시가 있다: ' + JSON.stringify(recs.map((r) => r.file)));
        const read = await sw.evaluate((id) => globalThis.__subtutorHandle({ type: 'web.recs.data', payload: { id, seq: 0 } }, {}), recs[0].id);
        assert(read && read.done && read.size === saved.bytes && read.data.length > 1000, '복사본을 그대로 읽는다: ' + JSON.stringify({ done: read && read.done, size: read && read.size, len: read && read.data && read.data.length }));
        const head = Buffer.from(read.data.slice(0, 8), 'base64');
        assert(head[0] === 0xff && (head[1] & 0xe0) === 0xe0, 'mp3 sync bytes: ' + head.slice(0, 2).toString('hex'));
        // 목록에서 지우면 복사본도 지워진다
        await sw.evaluate((id) => globalThis.__subtutorHandle({ type: 'web.recs.remove', payload: { id } }, {}), recs[0].id);
        const again = await sw.evaluate((id) => globalThis.__subtutorHandle({ type: 'web.recs.data', payload: { id, seq: 0 } }, {}), recs[0].id);
        assert(again && again.reason === 'missing', '지운 뒤에는 없다: ' + JSON.stringify(again));
      } finally {
        await opt.evaluate(async () => { if (window.__savedHandle) await window.SubTutorFS.setHandle(window.__savedHandle); });
        await sw.evaluate(() => chrome.storage.local.remove('recordings'));
        const dls = await sw.evaluate(() => new Promise((r) => chrome.downloads.search({}, r)));
        for (const d of dls) { await sw.evaluate((id) => chrome.downloads.removeFile(id).catch(() => {}), d.id).catch(() => {}); await sw.evaluate((id) => new Promise((r) => chrome.downloads.erase({ id }, r)), d.id).catch(() => {}); }
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
      await waitFor(() => yt.$eval('#st-panel', (e) => /Mock Lecture Title/.test(e.dataset.title || '') && /Mock Channel/.test(e.dataset.title || '')), 8000, 'yt title');
      const placed = await yt.evaluate(() => { const b = document.querySelector('.st-ctl'); return b && b.nextElementSibling.classList.contains('ytp-subtitles-button'); });
      assert(placed, 'control button before CC button');
      // 유튜브에는 자체 배속 메뉴와 Shift+< , Shift+> 가 이미 있어 우리 배속 버튼·단축키를 넣지 않는다
      assert(!(await yt.$('.st-rate')), 'no rate buttons on YouTube');
      await yt.keyboard.down('Shift'); await yt.keyboard.press('Period'); await yt.keyboard.up('Shift');
      await sleep(300);
      assert(await yt.evaluate(() => Math.abs(document.querySelector('video').playbackRate - 1) < 0.01), 'Shift+> left to YouTube');
      const layout = await yt.evaluate(() => ({ margin: getComputedStyle(document.querySelector('ytd-app')).marginRight, top: getComputedStyle(document.getElementById('st-panel')).top, videoRight: Math.round(document.querySelector('video').getBoundingClientRect().right) }));
      assert(layout.margin === '0px' && layout.top === '56px', 'panel overlays the page below the masthead: ' + JSON.stringify(layout));
      // 홈에서 넘어온 것처럼 숨은 홈 페이지(ytd-browse)의 #secondary 가 문서 앞쪽에 있어도, 보이는 추천 영상 칸을 통째로 덮는다
      const cover = await waitFor(() => yt.evaluate(() => { const sec = document.querySelector('ytd-watch-flexy #secondary').getBoundingClientRect(); const p = document.getElementById('st-panel').getBoundingClientRect(); return p.left <= sec.left + 0.5 && p.width > 400 ? { panelLeft: Math.round(p.left), secLeft: Math.round(sec.left), w: Math.round(p.width) } : null; }), 4000, 'panel covers the whole recommendations column')
        .catch(async (e) => { throw new Error(e.message + ' ' + JSON.stringify(await yt.evaluate(() => ({ w: getComputedStyle(document.documentElement).getPropertyValue('--st-panel-w'), sec: Math.round(document.querySelector('ytd-watch-flexy #secondary').getBoundingClientRect().left), iw: innerWidth })))); });
      void cover;
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
          async function walk(dir, prefix) { for await (const [name, h] of dir.entries()) { if (h.kind === 'directory') { if (name !== '백업') await walk(h, prefix + name + '/'); } else { const f = await h.getFile(); out.push({ path: prefix + name, size: f.size, b64: await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); }) }); } } }
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

    await step('유튜브(DRM 없음): 패널 발치에 "두 번 보기" 대신 ⏺ MP3 · 허용(아이콘) 없이 영상 요소에서 통째 MP3 · ⚙ "자동으로 오디오 MP3 녹음"을 켜면 재생 중에 알아서 담는다 · Option+R(패널이 직접)·크롬 명령으로 켜고 끈다', async () => {
      const recDirGone = () => opt.evaluate(async () => { try { const root = await navigator.storage.getDirectory(); const d = await (await root.getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); await d.removeEntry('영상 오디오', { recursive: true }); } catch (e) { /* 없음 */ } });
      try {
        const foot = await yt.$$eval('#st-panel .st-foot-btn', (els) => els.map((e) => e.textContent.trim()));
        assert(!foot.some((t) => t === '두 번 보기') && foot.some((t) => t === '⏺ MP3'), '발치 버튼: ' + JSON.stringify(foot));
        // ⚙ 저장 칸에 자동 녹음 스위치가 있다 (켜기 전에 확인만)
        const autoRow = await yt.evaluate(() => { const lab = [...document.querySelectorAll('#st-panel .st-settings .st-field label')].find((l) => /자동으로 오디오 MP3 녹음/.test(l.textContent)); return lab ? !!lab.closest('.st-field').querySelector('input.st-switch') : null; });
        assert(autoRow === true, '⚙ 저장에 자동 녹음 스위치가 있다: ' + autoRow);
        // 허용 없이(탭 캡처 아님) 영상 요소에서 바로 담는다
        await yt.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 4; v.play(); });
        await sleep(400);
        await yt.evaluate(() => document.querySelector('#st-panel .st-rec-btn').click());
        await waitFor(() => yt.evaluate(() => document.querySelector('#st-panel .st-rec-btn').classList.contains('st-on')), 4000, 'recording starts without a grant');
        assert(!(await yt.evaluate(() => { const c = document.querySelector('.st-chip'); return c && c.classList.contains('st-chip-wait') && c.classList.contains('show'); })), '허용 대기 칩이 뜨지 않는다');
        await sleep(2600);
        await yt.evaluate(() => document.querySelector('#st-panel .st-rec-btn').click());
        const rec = await waitFor(async () => { const r = await sw.evaluate(async () => (await chrome.storage.local.get('recordings')).recordings || []); return r.length === 1 ? r[0] : null; }, 15000, 'element recording saved');
        assert(/Mock Lecture Title/.test(rec.title) && rec.file.location === 'folder' && rec.durMs > 1800 && rec.durMs < 6000, '요소 캡처 녹음: ' + JSON.stringify({ title: rec.title, file: rec.file, durMs: rec.durMs }));
        const bytes = await opt.evaluate(async (pth) => {
          const root = await navigator.storage.getDirectory();
          let dir = await root.getDirectoryHandle('e2e-docs');
          const parts = pth.split('/').slice(1);
          for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
          const f = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
          const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
          return { size: f.size, b0: head[0], b1: head[1] };
        }, rec.file.path);
        assert(bytes.size > 4000 && bytes.b0 === 0xff && (bytes.b1 & 0xe0) === 0xe0, '폴더의 MP3: ' + JSON.stringify(bytes));
        // 자동 녹음: ⚙ 스위치를 켜면 재생 중인 에피소드를 알아서 담기 시작한다
        await yt.evaluate(() => { const lab = [...document.querySelectorAll('#st-panel .st-settings .st-field label')].find((l) => /자동으로 오디오 MP3 녹음/.test(l.textContent)); lab.closest('.st-field').querySelector('input.st-switch').click(); });
        await waitFor(() => sw.evaluate(async () => !!(((await chrome.storage.local.get('settings')).settings || {}).recAuto)), 4000, 'recAuto saved');
        await yt.evaluate(() => { const v = document.querySelector('video'); if (v.paused) v.play(); });
        await waitFor(() => yt.evaluate(() => document.querySelector('#st-panel .st-rec-btn').classList.contains('st-on')), 6000, 'auto recording starts');
        await sleep(1500);
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { recAuto: false } }, {}));
        await yt.evaluate(() => document.querySelector('#st-panel .st-rec-btn').click());
        await waitFor(async () => (await sw.evaluate(async () => ((await chrome.storage.local.get('recordings')).recordings || []).length)) === 2, 15000, 'auto recording saved');
        const recCount = () => sw.evaluate(async () => ((await chrome.storage.local.get('recordings')).recordings || []).length);
        const recOn = () => yt.evaluate(() => document.querySelector('#st-panel .st-rec-btn').classList.contains('st-on'));
        // 단축키 ① Option(Alt)+R — 크롬 단축키로 지정이 안 돼 있어도 패널이 직접 받아 켜고 끈다
        const optR = async () => { await yt.keyboard.down('Alt'); await yt.keyboard.press('KeyR'); await yt.keyboard.up('Alt'); };
        await yt.evaluate(() => { const v = document.querySelector('video'); if (v.paused) v.play(); document.body.focus(); });
        await optR();
        await waitFor(recOn, 4000, 'Option+R starts recording');
        assert(!(await yt.evaluate(() => !!document.querySelector('.st-dubbox:not(.st-hidden)'))), 'Option+R 은 더빙 칸(R)을 열지 않는다');
        await sleep(1600);
        await optR();
        await waitFor(async () => (await recCount()) === 3, 15000, 'Option+R stops and saves');
        // 단축키 ② 크롬 명령(rec-episode) — 실제 Option+R 이 크롬 단축키로 지정돼 있을 때 오는 길 (누르는 순간 녹음 허용)
        const ytTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
        let r = await sw.evaluate((id) => globalThis.__subtutorInvoke({ id }, 'command', 'rec'), ytTab);
        assert(r && r.ok && r.did === 'rec-start', 'command starts: ' + JSON.stringify(r));
        await waitFor(recOn, 4000, 'command recording on');
        await sleep(1600);
        r = await sw.evaluate((id) => globalThis.__subtutorInvoke({ id }, 'command', 'rec'), ytTab);
        assert(r && r.ok && r.did === 'rec-stop', 'command stops: ' + JSON.stringify(r));
        await waitFor(async () => (await recCount()) === 4, 15000, 'command recording saved');
        // ⏺ MP3 버튼 설명과 ⌨ 단축키 목록에 Option+R 이 적혀 있다
        const tip = await yt.$eval('#st-panel .st-rec-btn', (b) => b.title);
        assert(/단축키/.test(tip), '버튼 설명에 단축키: ' + tip);
        await yt.evaluate(() => [...document.querySelectorAll('#st-panel .st-foot-btn')].find((b) => /단축키/.test(b.textContent)).click());
        await waitFor(() => yt.evaluate(() => { const b = document.querySelector('.st-infobox'); return b && !b.classList.contains('st-hidden') && /Option\(Alt\)\+R/.test(b.textContent); }), 4000, 'shortcut list mentions Option+R');
        await yt.evaluate(() => { const x = document.querySelector('.st-infobox-head .st-icon'); if (x) x.click(); });
      } finally {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { recAuto: false } }, {})).catch(() => {});
        await yt.evaluate(() => { const b = document.querySelector('#st-panel .st-rec-btn'); if (b && b.classList.contains('st-on')) b.click(); document.querySelector('video').pause(); }).catch(() => {});
        await sleep(800);
        await sw.evaluate(() => chrome.storage.local.remove('recordings'));
        await recDirGone();
      }
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
    await step('녹음을 마치면 바로 아이폰으로: 웹에 로그인돼 있으면 열린 웹 탭에 알려 올리게 하고, 아니면 조용히 둔다 (탭 수 그대로)', async () => {
      await web.evaluate(() => { window.__recsSaved = 0; window.SubTutorBridge.on('recs.saved', () => { window.__recsSaved++; }); });
      const tabCount = () => sw.evaluate(() => new Promise((r) => chrome.tabs.query({}, (t) => r(t.length))));
      const recOnce = async (title) => {
        const started = await sw.evaluate((tt) => globalThis.__subtutorHandle({ type: 'rec.start', test: 'sweep', title: tt }, { tab: { id: 779 } }), title);
        assert(started && started.ok, 'rec start: ' + JSON.stringify(started));
        await sleep(1300);
        const saved = await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'rec.stop' }, {}));
        assert(saved && saved.ok, 'rec saved: ' + JSON.stringify(saved));
      };
      try {
        // ① 웹에 로그인돼 있지 않으면: 알리지도, 탭을 새로 열지도 않는다
        await sw.evaluate(() => chrome.storage.local.set({ webLoggedIn: false }));
        const t0 = await tabCount();
        await recOnce('AutoSync A');
        await sleep(900);
        assert((await tabCount()) === t0, '로그인 전: 새 탭 없음');
        assert((await web.evaluate(() => window.__recsSaved)) === 0, '로그인 전: 이벤트 없음');
        // ② 웹이 supa.flag 로 로그인 상태를 알려 두면: 녹음이 끝나는 순간 열려 있는 웹 탭이 recs.saved 를 받는다
        const fr = await web.evaluate(() => window.SubTutorBridge.request('supa.flag', { on: true }));
        assert(fr && fr.ok, 'supa.flag ok: ' + JSON.stringify(fr));
        await waitFor(() => sw.evaluate(async () => (await chrome.storage.local.get('webLoggedIn')).webLoggedIn === true), 4000, 'flag stored');
        await recOnce('AutoSync B');
        await waitFor(() => web.evaluate(() => window.__recsSaved >= 1), 6000, 'web tab notified right after save');
        assert((await tabCount()) === t0, '열린 웹 탭을 쓰므로 탭 수 그대로');
      } finally {
        await sw.evaluate(() => chrome.storage.local.set({ webLoggedIn: false }));
        await sw.evaluate(() => chrome.storage.local.remove('recordings'));
        await opt.evaluate(async () => { try { const root = await navigator.storage.getDirectory(); const d = await (await root.getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); await d.removeEntry('영상 오디오', { recursive: true }); } catch (e) { /* 없음 */ } });
      }
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
    await step('장면 썸네일이 목록에 보이고 🖼 로 모두 감추며, "띄엄띄엄 보이기"를 켜면 가림막에 1·6…번째 단어만 남는다', async () => {
      const th = await web.evaluate(() => { const i = document.querySelector('.item img.thumb'); return { n: document.querySelectorAll('.item img.thumb').length, w: i ? i.getBoundingClientRect().width : 0 }; });
      assert(th.n >= 1 && th.w > 100 && th.w <= 160, '썸네일이 목록에 보인다: ' + JSON.stringify(th));
      await web.click('.thumb-toggle');
      assert((await web.$$eval('.item img.thumb', (e) => e.length)) === 0, '🖼 모두 감추기');
      await web.click('.thumb-toggle');
      assert((await web.$$eval('.item img.thumb', (e) => e.length)) >= 1, '🖼 다시 보이기');
      // 띄엄 가리기 (설정 › 화면): 가림막에 첫 단어 + █ 들
      await web.evaluate(() => { try { localStorage.setItem('st.veilPeek', '1'); } catch (e) { /* ignore */ } });
      await web.reload({ waitUntil: 'load' });
      await web.waitForSelector('.item');
      const peek = await web.$eval('[data-id="netflix:12345:22000"] .veil-text-btn', (e) => e.textContent);
      assert(/█/.test(peek) && !peek.includes('감춤'), '가림막이 띄엄띄엄 글로 바뀐다: ' + peek);
      const first = peek.split(' ')[0];
      assert(first && !/█/.test(first), '첫 단어는 보인다: ' + peek);
      // 설정의 스위치에도 상태가 반영된다
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      assert(await web.$eval('.veil-peek', (e) => e.checked), '설정 스위치가 켜져 있다');
      await web.evaluate(() => { document.querySelector('.veil-peek').click(); });
      await web.goto('http://localhost:8766/#/', { waitUntil: 'load' });
      await web.waitForSelector('.item');
      const off = await web.$eval('[data-id="netflix:12345:22000"] .veil-text-btn', (e) => e.textContent);
      assert(off.includes('자막 감춤'), '끄면 원래 가림막: ' + off);
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
      assert(await web.$$eval('.ladder-cfg input.rate:not(.fast-rate)', (e) => e.length) === 4, 'four rate inputs by default');
      // 2단계로 줄이면 기본값(0.7 → 1)이 채워진다
      await web.select('.ladder-cfg .ladder-steps', '2');
      await waitFor(() => web.$$eval('.ladder-cfg input.rate:not(.fast-rate)', (e) => e.map((x) => x.value)).then((v) => (v.length === 2 ? v : null)), 5000, 'two steps');
      assert((await web.$$eval('.ladder-cfg input.rate:not(.fast-rate)', (e) => e.map((x) => x.value))).join(',') === '0.7,1', 'preset for two steps');
      // 사용자 지정 배속: 0.45 → 1.0 (범위 밖 값은 0.3~2.0 으로 맞춘다)
      await web.evaluate(() => { const i = document.querySelector('.ladder-cfg input.rate:not(.fast-rate)[data-step="0"]'); i.value = '0.05'; i.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => web.$eval('.ladder-cfg input.rate:not(.fast-rate)[data-step="0"]', (i) => i.value === '0.3'), 5000, 'clamped to 0.3');
      await web.evaluate(() => { const i = document.querySelector('.ladder-cfg input.rate:not(.fast-rate)[data-step="0"]'); i.value = '0.45'; i.dispatchEvent(new Event('change', { bubbles: true })); });
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
    await step('고속 적응 프리셋 ⏩: 이해 확인한 문장에만 나오고 1 → 1.25 → 1.5 → 1 순서로 재생 · 설정에서 단계 편집(마지막은 1배 고정)', async () => {
      assert((await web.$$('.ladder.fast')).length === 0, 'no fast button before any line is confirmed understood');
      await web.evaluate(() => { const it = window.__subtutorDebug.state.items.find((i) => i.platform === 'youtube'); return window.SubTutorBridge.request('items.update', { id: it.id, patch: { lastResult: 'know' } }); });
      await waitFor(() => web.$$eval('.ladder.fast', (b) => b.length === 1), 6000, 'fast button appears on the understood item only');
      const yt = '[data-id^="youtube:"]';
      assert(/고속 적응 1 → 1.25 → 1.5 → 1×/.test(await web.$eval(yt + ' .ladder.fast', (b) => b.title)), 'fast title: ' + await web.$eval(yt + ' .ladder.fast', (b) => b.title));
      const order = [];
      await web.click(yt + ' .ladder.fast');
      await waitFor(async () => {
        const t = await web.$eval('#toast', (e) => e.textContent);
        const m = /⏩ ([\d.]+)×/.exec(t);
        if (m && order[order.length - 1] !== m[1]) order.push(m[1]);
        return order.length === 4 && order[3] === '1' && (await web.$eval(yt, (e) => !e.classList.contains('playing')));
      }, 30000, 'fast preset finished').catch(async (e) => {
        const dbg = await web.evaluate(() => JSON.stringify({ clip: window.__subtutorDebug.state.clip, local: window.__subtutorDebug.state.clipLocal, ladderFor: window.__subtutorDebug.state.ladderFor, playRate: window.__subtutorDebug.state.playRate, log: window.__subtutorDebug.log.slice(-12) })).catch(() => '(no dbg)');
        throw new Error(e.message + ' order=' + order.join(',') + ' dbg=' + dbg);
      });
      assert(order.join(',') === '1,1.25,1.5,1', 'rates in order: ' + order.join(','));
      // 설정: 고속 적응 편집 칸 — 마지막 단계는 1배 고정, 나머지는 바꿀 수 있다
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$('.fast-cfg'), 5000, 'fast preset editor under the ladder settings');
      const cells = await web.$$eval('.fast-cfg input.fast-rate', (xs) => xs.map((x) => [x.value, x.disabled]));
      assert(cells.length === 4 && cells[3][0] === '1' && cells[3][1] === true, 'last step fixed at 1: ' + JSON.stringify(cells));
      await web.$eval('.fast-cfg input.fast-rate[data-step="1"]', (i) => { i.value = '1.2'; i.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => web.evaluate(() => window.SubTutorBridge.request('settings.get').then((r) => JSON.stringify(r.settings.web.fastRates) === '[1,1.2,1.5,1]')), 5000, 'edited rate saved');
      await web.$eval('.fast-cfg select.fast-steps', (sel) => { sel.value = '4'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); // 단계 수를 고르면 그 기본값으로
      await waitFor(() => web.evaluate(() => window.SubTutorBridge.request('settings.get').then((r) => JSON.stringify(r.settings.web.fastRates) === '[1,1.25,1.5,1]')), 5000, 'preset restored');
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length >= 3), 8000, 'list back');
    });
    await step('NZ 모음 미니 퀴즈: 짝 단어(pen·pin)가 든 오디오 있는 저장 문장으로 "들린 단어 고르기" 2지선다 · 맞음 표시·힌트·요약', async () => {
      const src = await sw.evaluate(async () => {
        const items = (await chrome.storage.local.get('items')).items || [];
        const withCopy = items.find((i) => i.audio);
        if (withCopy) { const a = (await chrome.storage.local.get('audio:' + withCopy.id))['audio:' + withCopy.id]; if (a) return { data: a, mime: (withCopy.audio.mime || 'audio/mpeg') }; }
        const withFile = items.find((i) => i.file && i.file.location === 'folder');
        if (!withFile) return { err: 'no-audio-item' };
        const r = await globalThis.SubTutorFS.readFile(withFile.file.path);
        if (!r.ok) return { err: r.reason };
        let b64 = ''; const b = r.bytes;
        for (let i = 0; i < b.length; i += 0x8000) b64 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return { data: btoa(b64), mime: 'audio/mpeg' };
      });
      assert(src && src.data, 'an audio source exists to copy: ' + JSON.stringify(src && src.err));
      await web.evaluate(() => window.SubTutorBridge.request('items.import', { items: [{ id: 'netflix:777:100', platform: 'netflix', videoId: '777', url: 'https://www.netflix.com/watch/777', title: 'NZ Quiz Mock', episode: '', startMs: 100, endMs: 1600, text: 'Have you got a pen?', translation: '펜 있어요?', savedAt: Date.now(), box: 'learning' }] }));
      await web.evaluate((d) => window.SubTutorBridge.request('audio.put', { itemId: 'netflix:777:100', data: d.data, mime: d.mime, format: 'mp3', ms: 1500 }), src);
      await web.goto('http://localhost:8766/#/quiz', { waitUntil: 'load' });
      await waitFor(() => web.$eval('.nz-start', (b) => !b.disabled && /\(1\)/.test(b.textContent)), 8000, 'mini quiz button counts 1 eligible question');
      await web.click('.nz-start');
      await waitFor(() => web.$$eval('.nz-opt', (b) => b.length === 2 && b.every((x) => ['pen', 'pin'].includes(x.textContent))), 5000, 'two options: the word and its NZ-merged pair');
      await web.evaluate(() => { [...document.querySelectorAll('.nz-opt')].find((b) => b.textContent === 'pen').click(); });
      await waitFor(() => web.$eval('.nz-card .score', (e) => /맞았습니다/.test(e.textContent)), 4000, 'graded correct');
      assert(await web.$$eval('.nz-card p.count', (ps) => ps.some((p) => /NZ 발음/.test(p.textContent) && /DRESS/.test(p.textContent))), 'hint line with the vowel type');
      assert(await web.$eval('.nz-card .answer', (e) => /pen/.test(e.textContent)), 'sentence shown with the word');
      await web.$eval('.nz-card .quiz-result .btn.primary', (b) => b.click());
      await waitFor(() => web.$('.quiz-card.summary'), 4000, 'summary');
      assert(await web.$eval('.summary .nums', (e) => /1/.test(e.textContent)), 'score counted');
      await web.evaluate(() => { window.__subtutorDebug.state.nzQuiz = null; return window.SubTutorBridge.request('items.remove', { id: 'netflix:777:100' }); });
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$$eval('.item', (r) => r.length >= 3), 8000, 'list back');
    });
    await step('Q 원인 태깅: 못 알아들은 문장에만 원인 칩(선택 사항) · 고르면 저장, 같은 칩은 해제 · 진행 상황에 비율과 다음 훈련 추천', async () => {
      assert((await web.$$('.miss-why')).length === 0, 'no reason chips before any missed item');
      await web.evaluate(() => { const it = window.__subtutorDebug.state.items.find((i) => i.platform === 'netflix'); return window.SubTutorBridge.request('items.update', { id: it.id, patch: { missed: true } }); });
      await waitFor(() => web.$('.miss-why'), 6000, 'chips row appears on the missed item');
      assert((await web.$$('.miss-why')).length === 1, 'only on the missed item');
      const labels = await web.$$eval('.miss-why .mw', (xs) => xs.map((x) => x.textContent));
      assert(labels.join(',') === '속도,모르는 단어,축약·연음,키위 발음,문장이 김', 'labels ' + labels.join(','));
      await web.click('.miss-why .mw[data-why="reduction"]');
      await waitFor(() => sw.evaluate(async () => (((await chrome.storage.local.get('items')).items) || []).some((i) => i.missReason === 'reduction')), 5000, 'reason saved');
      await waitFor(() => web.$eval('.miss-why .mw[data-why="reduction"]', (b) => b.classList.contains('on')), 3000, 'chip lit');
      await web.click('.miss-why .mw[data-why="speed"]'); // 다른 칩을 누르면 바꾼다
      await waitFor(() => sw.evaluate(async () => (((await chrome.storage.local.get('items')).items) || []).some((i) => i.missReason === 'speed')), 5000, 'reason replaced');
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$('.miss-stats .miss-row'), 8000, 'dashboard shows reason rows');
      const stat = await web.$eval('.miss-stats', (e) => e.textContent);
      assert(/속도/.test(stat) && /1개 · 100%/.test(stat) && /고속 적응/.test(stat), 'stats + recommendation: ' + stat.slice(0, 160));
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$('.miss-why'), 8000, 'back to the list');
      await web.click('.miss-why .mw[data-why="speed"]'); // 같은 칩을 다시 누르면 해제
      await waitFor(() => sw.evaluate(async () => (((await chrome.storage.local.get('items')).items) || []).every((i) => !i.missReason)), 5000, 'reason cleared');
      await web.evaluate(() => { const it = window.__subtutorDebug.state.items.find((i) => i.missed); return window.SubTutorBridge.request('items.update', { id: it.id, patch: { missed: false } }); });
      await waitFor(() => web.evaluate(() => !document.querySelector('.miss-why')), 6000, 'chips gone after unmarking');
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
      // 줄이 화면 맨 위에 걸리면 상단 고정 메뉴에 가려 클릭이 메뉴로 간다 (썸네일로 줄 높이가 바뀌며 드러남) — 가운데로 옮기고 누른다
      await row.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await (await row.$('.play')).click();
      await waitFor(() => web.$eval('[data-id^="youtube:"]', (e) => e.classList.contains('playing')), 5000, 'local playing').catch(async (e) => {
        const dbg = await web.evaluate(async () => {
          const B = window.SubTutorBridge;
          const out = {
            cls: (document.querySelector('[data-id^="youtube:"]') || {}).className,
            rows: document.querySelectorAll('[data-id^="youtube:"]').length,
            toastShown: !!(document.querySelector('#toast.show')),
            toast: ((document.querySelector('#toast') || {}).textContent || '').slice(0, 60),
          };
          try {
            const items = (await B.request('items.list')).items || [];
            const it = items.find((x) => String(x.id).startsWith('youtube:'));
            out.item = it ? { id: it.id, file: it.file, audio: it.audio, thumbLen: (it.thumb || '').length } : null;
            if (it) {
              try { const r = await B.request('audio.file', { itemId: it.id }, 15000); out.af = r ? { reason: r.reason, len: (r.data || '').length } : null; } catch (e) { out.af = 'ERR ' + e.message; }
            }
          } catch (e) { out.err = e.message; }
          return out;
        }).catch((e) => 'eval-fail ' + e.message);
        throw new Error(e.message + ' dbg=' + JSON.stringify(dbg) + ' console=' + logs.slice(-6).join(' | ').slice(0, 500));
      });
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
      // 웹은 목록에서 먼저 빼고(바로 보이게) 확장 프로그램이 그다음에 파일을 지우므로, 폴더가 비워질 때까지 기다린다.
      // 실패하면 남은 폴더 안에 무엇이 있는지까지 보여 준다
      const listFolders = () => opt.evaluate(async () => { const sub = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); const out = []; for await (const [n, h] of sub.entries()) { if (n === '백업') continue; if (h.kind === 'directory') { const inner = []; for await (const [m] of h.entries()) inner.push(m); out.push(n + '/[' + inner.join(', ') + ']'); } else out.push(n); } return out; });
      await waitFor(async () => !(await listFolders()).some((n) => /Mock Lecture/.test(n)), 8000, 'MP3 file and its emptied folder removed with the item')
        .catch(async (e) => { throw new Error(e.message + ': ' + JSON.stringify(await listFolders()) + ' toast=' + await web.$eval('#toast', (t) => t.textContent).catch(() => '')); });
      await waitFor(() => web.$eval('#toast', (t) => /MP3 파일 1개 삭제/.test(t.textContent)), 5000, 'delete result says the MP3 file was removed');
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
    await step('웹 녹음 명료도(실험적): 인식 일치율·멈춤이 번호 버튼에 작게 붙는다', async () => {
      const it = await web.evaluate(() => { const s = window.__subtutorDebug.state; const i = s.items.find((x) => x.platform === 'netflix' && x.id !== 'netflix:12345:22000') || s.items.find((x) => x.platform === 'youtube'); return { id: i.id, text: i.text }; }); // 녹음 3개 단계(22000)와 다른 항목으로
      await web.evaluate((t) => { window.__subtutorAsrTest = t; }, it.text);
      const row = '[data-rec-item="' + it.id + '"]';
      await web.click(row + ' .rec-btn');
      await sleep(900);
      await web.click(row + ' .rec-btn.recording');
      await waitFor(() => web.$eval(row + ' .attempt.latest', (b) => /일치 100%/.test(b.title) && /멈춤 \d+번/.test(b.title) && /인식:/.test(b.title)), 8000, 'feedback in the attempt title');
      assert(await web.$eval(row + ' .attempt.latest .fb-acc', (e) => e.textContent === '100%'), 'small acc badge');
      await web.evaluate(() => { window.__subtutorAsrTest = null; });
      // 녹음은 그대로 둔다 (다른 항목이라 뒤 단계와 무관). 지우거나 새로고침하면 다른 단계의 녹음·화면 상태를 건드린다
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
    await step('웹 단어장: 패널에서 저장한 단어 → 카드(앞: 단어·예문, 뒤: 뜻) · 잘 모름은 10분 뒤 + 이번에 다시 · 알고 있어요는 1일 뒤 · 뜻 고치기 · 지우기', async () => {
      const wordsNow = async () => (await sw.evaluate(async () => (await chrome.storage.local.get('words')).words)) || [];
      await web.goto('http://localhost:8766/#/words', { waitUntil: 'load' });
      await waitFor(() => web.$('.word-row[data-word="frisbee"]'), 8000, 'saved word listed');
      const row = await web.$eval('.word-row[data-word="frisbee"]', (r) => ({ meaning: r.querySelector('.word-meaning').value, hl: r.querySelector('.word-sent .hl') && r.querySelector('.word-sent .hl').textContent, meta: r.querySelector('.word-meta').textContent }));
      assert(row.meaning === '[번역] frisbee' && row.hl === 'frisbee' && /Mock Show/.test(row.meta), 'row: ' + JSON.stringify(row));
      assert(await web.$eval('#count-words', (b) => b.textContent) === '1', 'due badge');
      await web.click('.quiz-setup .btn.primary');
      await waitFor(() => web.$('.word-card'), 4000, 'card');
      const front = await web.$eval('.word-card', (c) => ({ big: c.querySelector('.word-big').textContent, hl: c.querySelector('.word-example .hl') && c.querySelector('.word-example .hl').textContent, back: !!c.querySelector('.word-back') }));
      assert(front.big === 'frisbee' && front.hl === 'frisbee' && !front.back, 'front: the word and its sentence, meaning hidden: ' + JSON.stringify(front));
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-word-front.png') });
      await web.keyboard.press('Space');
      await waitFor(() => web.$eval('.word-card .word-mean', (e) => e.textContent === '[번역] frisbee'), 3000, 'back shows the meaning');
      await web.screenshot({ path: path.join(TMP, 'shots', 'web-word-back.png') });
      await web.keyboard.press('KeyZ');
      const lapse = await waitFor(async () => { const w = (await wordsNow()).find((x) => x.word === 'frisbee'); return w && w.review && w.review.lapses === 1 ? w.review : null; }, 4000, 'forgot saved');
      assert(lapse.level === 0 && lapse.due > Date.now() + 8 * 60000 && lapse.due < Date.now() + 12 * 60000, '잘 모름 → 10분 뒤: ' + JSON.stringify(lapse));
      await waitFor(() => web.$eval('.word-card .quiz-top', (e) => /2 \/ 2/.test(e.textContent)), 3000, 'requeued in this session');
      await web.keyboard.press('Space');
      await waitFor(() => web.$('.word-card .word-back'), 3000, 'flipped again');
      await web.keyboard.press('KeyC');
      const know = await waitFor(async () => { const w = (await wordsNow()).find((x) => x.word === 'frisbee'); return w && w.review && w.review.level === 1 ? w.review : null; }, 4000, 'know saved');
      assert(know.due > Date.now() + 23 * 3600000 && know.due < Date.now() + 25 * 3600000, '알고 있어요 → 1일 뒤: ' + JSON.stringify(know));
      await waitFor(() => web.$('.summary'), 3000, 'summary');
      await waitFor(() => web.$eval('#count-words', (b) => b.textContent === ''), 3000, 'nothing due now');
      await web.click('.summary .btn.primary');
      await waitFor(() => web.$('.word-row[data-word="frisbee"]'), 3000, 'back to the list');
      assert(/1일 뒤/.test(await web.$eval('.word-row[data-word="frisbee"] .word-meta', (e) => e.textContent)), 'next review shown');
      // 뜻 칸을 눌러 글자를 모두 고른 뒤 새 뜻을 친다 (이 puppeteer 는 clickCount:3 으로 전체 선택이 되지 않는다)
      await web.click('.word-row[data-word="frisbee"] .word-meaning');
      await web.$eval('.word-row[data-word="frisbee"] .word-meaning', (i) => i.select());
      await web.keyboard.type('원반');
      await web.keyboard.press('Enter');
      await waitFor(async () => ((await wordsNow()).find((x) => x.word === 'frisbee') || {}).meaning === '원반', 3000, 'meaning edited');
      await web.click('.word-row[data-word="frisbee"] .word-del');
      await waitFor(async () => (await wordsNow()).length === 0, 3000, 'word removed');
      await waitFor(() => web.evaluate(() => !document.querySelector('.word-row')), 3000, 'row gone');
    });
    await step('오늘의 훈련: 첫 화면 카드의 버튼 하나로 받아쓰기 → (단어 카드) → Q 문장 속도 사다리 → 더빙 권유(플레이어에서 그 줄 더빙 칸이 열림) → 완료까지 끊김 없이 이어지고, 연속 일수가 D-day 옆과 주별 그래프에 남는다', async () => {
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.$('.today-card .today-start:not([disabled])'), 8000, 'today card on the first screen');
      const plan = await web.$eval('.today-plan', (e) => e.textContent);
      assert(/받아쓰기 \d/.test(plan) && /Q 문장 사다리 \d/.test(plan) && /더빙 1/.test(plan) && /약 \d+분/.test(plan), 'plan ' + plan);
      assert(/D-\d+/.test(await web.$eval('.today-dday', (e) => e.textContent)), 'D-day on the card');
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 1], ladderPitch: true, dubRecRates: [0.5, 0.7, 1], fastRates: [1, 1.25, 1.5, 1] } } }, {})); // 사다리를 2단계로 줄여 시간 단축
      await sleep(300);
      await web.click('.today-card .today-start');
      await waitFor(() => web.evaluate(() => location.hash === '#/today' && !!document.querySelector('.today-head')), 5000, 'today session view');
      const seen = [];
      const S = () => web.evaluate(() => { const t = window.__subtutorDebug.state.today; if (!t) return 'none'; if (t.finished) return 'done'; const x = t.stages[t.idx]; return x ? x.kind + (x.kind === 'ladder' ? ':' + x.pos : '') : 'between'; });
      const dbg = () => web.evaluate(() => { const st = window.__subtutorDebug.state; const t = st.today; return JSON.stringify({ idx: t && t.idx, stages: t && t.stages.map((x) => x.kind + (x.pos !== undefined ? ':' + x.pos : '')), fin: t && !!t.finished, clip: st.clip, ladderFor: st.ladderFor, playRate: st.playRate, toast: document.getElementById('toast').textContent }); }).catch(() => '(no dbg)');
      let dubItem = null, lastKey = '', keyAt = Date.now();
      const tGuard = Date.now();
      for (let guard = 0; guard < 600 && Date.now() - tGuard < 240000; guard++) {
        const stKey = await S();
        const st = stKey.split(':')[0];
        if (stKey !== lastKey) { lastKey = stKey; keyAt = Date.now(); }
        else if (Date.now() - keyAt > 60000) throw new Error('today stuck in ' + stKey + ' → ' + (await dbg()));
        if (st === 'done') break;
        if (st !== 'between' && !seen.includes(st)) seen.push(st);
        if (st === 'dict') {
          await web.waitForSelector('.quiz-card');
          const phase = await web.evaluate(() => (window.__subtutorDebug.state.quiz || {}).phase);
          if (phase === 'listen') {
            const text = await web.evaluate(() => { const s = window.__subtutorDebug.state; const id = s.quiz.queue[s.quiz.pos]; return (s.items.find((i) => i.id === id) || {}).text || ''; });
            await web.waitForSelector('.dictation');
            await web.$eval('.dictation', (t, v) => { t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); }, text);
            await web.focus('.dictation');
            await web.keyboard.press('Enter');
            await waitFor(() => web.evaluate(() => (window.__subtutorDebug.state.quiz || {}).phase === 'graded'), 3000, 'dictation graded');
          }
          await web.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
          await web.keyboard.press('KeyC');
          await sleep(250);
        } else if (st === 'words') {
          await web.keyboard.press('Space'); await sleep(150); await web.keyboard.press('KeyC'); await sleep(250);
        } else if (st === 'ladder') {
          // 사다리가 저절로 시작하고, 끝까지 듣기 전에는 자막이 감춰져 있다. 재생이 끊겼으면 Space 로 다시, 35초 넘게 같은 문장에 막혀 있으면 건너뛴다(N)
          const info = await web.evaluate(() => { const s = window.__subtutorDebug.state; const stg = s.today.stages[s.today.idx]; const cur = stg.ids[stg.pos]; return { fin: stg.finishedFor === cur, active: !!s.ladderFor || ['opening', 'loading', 'playing'].includes(s.clip.state), veiled: !!document.querySelector('.today-ladder .answer.veiled-text') }; });
          if (info.fin) { assert(!(await web.$('.today-ladder .answer.veiled-text')), 'text revealed after the full ladder'); await web.keyboard.press('KeyN'); await sleep(250); }
          else if (Date.now() - keyAt > 35000) { console.log('    [today] ladder stuck at ' + lastKey + ' → skip: ' + (await dbg())); await web.keyboard.press('KeyN'); await sleep(300); }
          else if (!info.active) { await web.keyboard.press('Space'); await sleep(500); }
          else { assert(info.veiled, 'text veiled while the ladder plays'); await sleep(400); }
        } else if (st === 'dub') {
          dubItem = await web.evaluate(() => { const s = window.__subtutorDebug.state; const st = s.today.stages[s.today.idx]; const it = s.items.find((i) => i.id === st.id); return { id: it.id, platform: it.platform, text: it.text }; });
          await web.click('.today-dub-open');
          // 그 대사의 플레이어 탭에서 더빙 칸이 열린다 (그 줄 바로 아래)
          const opened = await waitFor(async () => {
            for (const p of await browser.pages()) {
              const r = await p.evaluate(() => { const b = document.querySelector('.st-list > .st-dubbox:not(.st-hidden)'); return b ? b.previousElementSibling.querySelector('.st-en').textContent : null; }).catch(() => null);
              if (r) return { page: p, row: r };
            }
            return null;
          }, 40000, 'player dub box opened from the web');
          assert(opened.row.replace(/\s+/g, ' ') === dubItem.text.replace(/\s+/g, ' '), 'dub box under the suggested line: ' + opened.row + ' vs ' + dubItem.text);
          await waitFor(() => web.$eval('.today-dub-state', (e) => /열었습니다/.test(e.textContent)), 10000, 'dub opened message');
          await opened.page.evaluate(() => { const c = document.querySelector('.st-dub-close'); if (c) c.click(); const v = document.querySelector('video'); if (v) v.pause(); });
          await web.bringToFront();
          await web.click('.today-finish');
        }
      }
      assert(seen[0] === 'dict' && seen.includes('ladder') && seen[seen.length - 1] === 'dub', 'stages in order: ' + seen.join(' → ') + ' → ' + (await dbg()));
      await waitFor(() => web.$('.today-summary'), 5000, 'summary');
      assert(/1일 연속/.test(await web.$eval('.today-streak-big', (e) => e.textContent)), 'streak 1 day');
      const day = await web.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
      const rec = await sw.evaluate(async (k) => ((await chrome.storage.local.get('stats')).stats.training || {})[k], day);
      assert(rec && rec.dict >= 1 && rec.ladder >= 1 && rec.dub === 1 && rec.sessions === 1, 'training record ' + JSON.stringify(rec));
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { web: { srs: true, dashboard: true, recommend: true, weakWords: true, shadow: true, ladder: true, goalDate: '2027-01-28', ladderRates: [0.8, 0.9, 1, 1.15], ladderPitch: true, dubRecRates: [0.5, 0.7, 1], fastRates: [1, 1.25, 1.5, 1] } } }, {})); // 사다리 단계 복원
      await web.click('.today-summary .btn.primary');
      await waitFor(() => web.$eval('.today-card', (e) => e.classList.contains('done') && /오늘 완료 ✓ · 🔥 1일 연속/.test(e.textContent)), 5000, 'first screen shows today done');
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$eval('.dash .dday', (e) => /D-\d+/.test(e.textContent) && /🔥 1일 연속/.test(e.textContent)), 8000, 'streak next to D-day');
      const lastWeek = await web.$$eval('.bars .bar.train', (bs) => bs[bs.length - 1].dataset.days);
      assert(lastWeek === '1', 'this week training bar = 1 day: ' + lastWeek);
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
    });
    await step('축약 패턴 통계: 받아쓰기에서 going to·did you·them 을 놓치면 gonna·didja·’em 로 쌓이고, 패턴을 누르면 그 문장 목록으로', async () => {
      await web.evaluate(() => window.SubTutorBridge.request('items.import', { items: [{ id: 'netflix:778:200', platform: 'netflix', videoId: '778', url: 'https://www.netflix.com/watch/778', title: 'Reduction Mock', episode: '', startMs: 200, endMs: 2600, text: "I'm going to catch them later, did you see?", translation: '', savedAt: Date.now(), box: 'learning' }] }));
      await web.goto('http://localhost:8766/#/quiz', { waitUntil: 'load' });
      await web.evaluate(() => { window.__subtutorDebug.state.quizPrefs.autoplay = false; window.__subtutorDebug.state.quizPrefs.dueOnly = false; });
      await waitFor(() => web.$('.quiz-setup'), 5000, 'quiz setup');
      await web.$$eval('.quiz-setup select', (sels) => { const s = sels[0]; s.value = 'Reduction Mock'; s.dispatchEvent(new Event('change', { bubbles: true })); });
      await web.click('.quiz-setup .btn.primary.big');
      await waitFor(() => web.$('.dictation'), 5000, 'dictation card');
      await web.$eval('.dictation', (t) => { t.value = "I'm catch later see"; t.dispatchEvent(new Event('input', { bubbles: true })); });
      await web.focus('.dictation');
      await web.keyboard.press('Enter');
      await waitFor(() => web.$('.quiz-result'), 4000, 'graded');
      const red = await waitFor(() => sw.evaluate(async () => { const r = ((await chrome.storage.local.get('stats')).stats || {}).reductions; return r && r.gonna && r.didja && r["'em"] ? r : null; }), 6000, 'patterns recorded');
      assert(red.gonna.n === 1 && red.gonna.src === 'going to' && red.didja.src === 'did you', 'patterns ' + JSON.stringify(red));
      await web.evaluate(() => document.activeElement && document.activeElement.blur());
      await web.keyboard.press('KeyC');
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$('.tag.red-pattern'), 8000, 'pattern chips in the weak-words box');
      const chips = await web.$$eval('.tag.red-pattern', (xs) => xs.map((x) => x.textContent));
      assert(chips.some((c) => /gonna/.test(c)) && chips.some((c) => /didja/.test(c)), 'chips ' + chips.join(','));
      await web.evaluate(() => { [...document.querySelectorAll('.tag.red-pattern')].find((x) => /didja/.test(x.textContent)).click(); });
      await waitFor(() => web.evaluate(() => location.hash === '#/list'), 4000, 'jumps to the list');
      await waitFor(() => web.$$eval('.item', (r) => r.length === 1), 5000, 'filtered to the sentence with that pattern');
      assert(/did you see/.test(await web.$eval('.item .en', (e) => e.textContent)), 'the did-you sentence');
      await web.evaluate(() => { window.__subtutorDebug.state.search = ''; window.__subtutorDebug.state.quizPrefs.autoplay = true; window.__subtutorDebug.state.quizPrefs.dueOnly = true; return window.SubTutorBridge.request('items.remove', { id: 'netflix:778:200' }); });
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await waitFor(() => web.evaluate(() => !document.querySelector('.item [data-id*="778"]') && document.querySelectorAll('.item').length >= 1), 8000, 'list restored');
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
      const left = await opt.evaluate(async () => { const root = await navigator.storage.getDirectory(); const sub = await (await root.getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); const out = []; for await (const [name] of sub.entries()) { if (name !== '백업') out.push(name); } return out; });
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

    await step('자동 백업: 지정 폴더에 JSON 을 쓰고(지금 백업 · 변경 50건 규칙), 그 파일의 items·words 로 완전 복원된다', async () => {
      await web.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await waitFor(() => web.$eval('.backup-line', (e) => /자동 백업/.test(e.textContent)), 8000, 'backup status line');
      await web.click('.backup-now');
      const meta = await waitFor(() => sw.evaluate(async () => { const m = (await chrome.storage.local.get('backupMeta')).backupMeta; return m && m.lastPath ? m : null; }), 10000, 'backup written');
      assert(/SubTutor\/백업\/subtutor-backup-\d{4}-\d{2}-\d{2}\.json$/.test(meta.lastPath), 'path ' + meta.lastPath);
      await waitFor(() => web.$eval('.backup-line', (e) => /마지막/.test(e.textContent)), 5000, 'line shows the last backup');
      const payload = await sw.evaluate(async () => { const day = new Date().toISOString().slice(0, 10); const r = await globalThis.SubTutorFS.readFile('SubTutor/백업/subtutor-backup-' + day + '.json'); return r.ok ? JSON.parse(new TextDecoder().decode(r.bytes)) : { err: r.reason }; });
      assert(payload.app === 'SubTutor' && Array.isArray(payload.items) && Array.isArray(payload.words) && payload.settings && payload.stats, 'payload keys: ' + Object.keys(payload).join(','));
      assert(payload.items.some((i) => i.id === 'netflix:999:1000'), 'imported item inside the backup');
      await web.evaluate(() => window.SubTutorBridge.request('items.remove', { id: 'netflix:999:1000' }));
      await waitFor(() => sw.evaluate(async () => !(((await chrome.storage.local.get('items')).items) || []).some((i) => i.id === 'netflix:999:1000')), 5000, 'item removed');
      const res = await web.evaluate((p) => Promise.all([window.SubTutorBridge.request('items.import', { items: p.items }), window.SubTutorBridge.request('words.import', { words: p.words })]), payload);
      assert(res[0].added === 1, 'restore added the removed item back: ' + JSON.stringify(res[0]));
      assert(await sw.evaluate(async () => (((await chrome.storage.local.get('items')).items) || []).some((i) => i.id === 'netflix:999:1000' && i.text === 'Imported line')), 'restored with its text');
      // 변경 50건 규칙: 49건째로 맞춰 두고 한 번 더 바꾸면 저절로 백업되고 카운터가 0 이 된다
      await sw.evaluate(async () => { await chrome.storage.local.set({ backupMeta: { lastAt: Date.now(), changes: 49, lastPath: '', lastError: '' } }); }); // 50건째 변경이 백업을 깨운다
      await web.evaluate(() => window.SubTutorBridge.request('items.update', { id: 'netflix:999:1000', patch: { comment: 'backup trigger' } }));
      await waitFor(() => sw.evaluate(async () => { const m = (await chrome.storage.local.get('backupMeta')).backupMeta; return m && m.changes === 0 && m.lastPath ? true : null; }), 15000, 'auto backup after the 50th change');
      await web.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
    });

    await step('문장 단위 저장: 쉼표로 이어지는 자막은 문장 끝 자막까지 묶고(완결 문장은 한 줄), 웹 구간 조정에서 한 줄씩 늘리고 줄인다', async () => {
      await page.bringToFront();
      await waitFor(() => page.evaluate(() => /\/watch\/12345$/.test(location.pathname) && document.querySelectorAll('.st-row').length === 10), 10000, 'player back on the first episode');
      const prevMode = await sw.evaluate(async () => ((((await chrome.storage.local.get('settings')).settings) || {}).audioMode) || 'off');
      try {
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { saveSentence: true, saveNextTexts: true, audioMode: 'off' } }, {}));
      await sleep(400);
      await page.hover('.st-row[data-i="1"]');
      await page.click('.st-row[data-i="1"] .st-star'); // "My dog Raffie … playing," — 쉼표로 끝나 다음 자막으로 이어진다
      const it = await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); return (items || []).find((x) => x.id === 'netflix:12345:6000') || null; }, 6000, 'joined item saved');
      assert(it.text.split('\n').length === 3 && /facts\.'$/.test(it.text), 'three cues joined until the sentence ends');
      assert(it.endMs === 16000, 'end extended to the last joined cue');
      assert(Array.isArray(it.parts) && it.parts.length === 3 && Array.isArray(it.next) && it.next.length === 3, 'parts and next texts stored');
      assert(it.next[0].text.indexOf('I like biting') === 0, 'next starts after the joined sentence');
      await page.hover('.st-row[data-i="4"]');
      await page.click('.st-row[data-i="4"] .st-star'); // "I like biting when I'm playing." — 완결 문장
      const one = await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); return (items || []).find((x) => x.id === 'netflix:12345:18000') || null; }, 6000, 'single item saved');
      assert(one.text === "I like biting when I'm playing." && one.endMs === 20000 && one.parts.length === 1, 'a complete sentence stays one cue');
      // 웹 구간 조정: + 문장 늘리기 → 다음 자막 글·구간이 붙는다, − 줄이기 → 되돌아간다 (오래 산 웹 탭의 상태와 격리하려고 새 탭에서)
      const w2 = await browser.newPage();
      try {
      await w2.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
      await w2.waitForSelector('.trim-toggle[data-id="netflix:12345:18000"]');
      await w2.click('.trim-toggle[data-id="netflix:12345:18000"]');
      await w2.waitForSelector('[data-trim-item="netflix:12345:18000"] .sent-plus');
      await w2.click('[data-trim-item="netflix:12345:18000"] .sent-plus');
      await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = (items || []).find((y) => y.id === 'netflix:12345:18000'); return x && x.endMs === 24000 && x.text.split('\n').length === 2 && /frisbee/.test(x.text) ? x : null; }, 8000, '+ adds the next cue text and range');
      await w2.waitForSelector('[data-trim-item="netflix:12345:18000"] .sent-minus:not([disabled])');
      await w2.click('[data-trim-item="netflix:12345:18000"] .sent-minus');
      await waitFor(async () => { const items = await sw.evaluate(async () => (await chrome.storage.local.get('items')).items); const x = (items || []).find((y) => y.id === 'netflix:12345:18000'); return x && x.endMs === 20000 && x.text === "I like biting when I'm playing." ? x : null; }, 8000, '− removes the added cue');
      } finally { await w2.close().catch(() => {}); }
      } finally {
        // 정리: 저장 두 개 삭제 + 설정 원복 — 중간에 실패해도 뒤 단계가 오염되지 않게
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:6000' }, {})).catch(() => {});
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:18000' }, {})).catch(() => {});
        await sw.evaluate((mm) => globalThis.__subtutorHandle({ type: 'settings.set', patch: { saveSentence: false, saveNextTexts: false, audioMode: mm } }, {}), prevMode).catch(() => {});
        await waitFor(() => page.evaluate(() => !document.querySelector('.st-row[data-i="1"]').classList.contains('saved') && !document.querySelector('.st-row[data-i="4"]').classList.contains('saved')), 6000, 'stars cleared after cleanup').catch(() => {});
      }
    });
    await step('저장할 문장 고르기: 한 자막에 문장이 여러 개면 영상을 멈추고 고른다 — 뒷문장만 저장, Esc 취소', async () => {
      await page.bringToFront();
      const prevMode2 = await sw.evaluate(async () => ((((await chrome.storage.local.get('settings')).settings) || {}).audioMode) || 'off');
      try {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'settings.set', patch: { savePick: true, saveSentence: true, audioMode: 'off' } }, {}));
        await sleep(300);
        await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 14.3; v.play(); });
        await sleep(400);
        await page.hover('.st-row[data-i="3"]');
        await page.click('.st-row[data-i="3"] .st-star'); // "and I say, 'Really? Let's look at the facts.'" — 두 문장으로 나뉜다
        await waitFor(() => page.evaluate(() => !!document.querySelector('.st-pick') && document.querySelectorAll('.st-pick-row').length === 2), 4000, 'pick box with 2 sentences');
        await waitFor(() => page.evaluate(() => document.querySelector('video').paused), 3000, 'video paused while picking');
        await page.click('.st-pick-row input[data-k="0"]'); // 앞문장 체크 해제 → 뒷문장만
        await page.keyboard.press('Enter');
        const it = await waitFor(async () => { const items = await sw.evaluate(async () => ((await chrome.storage.local.get('items')).items) || []); return items.find((x) => x.id === 'netflix:12345:14000') || null; }, 5000, 'picked item saved');
        assert(it.text === "Let's look at the facts.'" && it.endMs === 16000, 'only the trailing sentence saved: ' + JSON.stringify(it.text));
        assert(await page.evaluate(() => !document.querySelector('.st-pick')), 'box closed after saving');
        await waitFor(() => page.evaluate(() => !document.querySelector('video').paused), 3000, 'playback resumed');
        // Esc 취소: 저장되지 않는다
        await page.evaluate(() => document.querySelector('video').pause());
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:14000' }, {}));
        await waitFor(() => page.evaluate(() => !document.querySelector('.st-row[data-i="3"]').classList.contains('saved')), 5000, 'star cleared');
        await page.hover('.st-row[data-i="3"]');
        await page.click('.st-row[data-i="3"] .st-star');
        await waitFor(() => page.evaluate(() => !!document.querySelector('.st-pick')), 4000, 'pick box again');
        await page.keyboard.press('Escape');
        await sleep(300);
        assert(await page.evaluate(() => !document.querySelector('.st-pick')), 'box closed by Esc');
        assert(await sw.evaluate(async () => !((((await chrome.storage.local.get('items')).items) || []).some((x) => x.id === 'netflix:12345:14000'))), 'nothing saved on cancel');
      } finally {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:14000' }, {})).catch(() => {});
        await sw.evaluate((m) => globalThis.__subtutorHandle({ type: 'settings.set', patch: { savePick: false, saveSentence: false, audioMode: m } }, {}), prevMode2).catch(() => {});
      }
    });
    await step('아이폰 동기화: 회원가입하면 바로 전부 올리고(대사·단어·보관 소리, 아이폰과 같은 파일 이름), 접속만 해도 자동 동기화가 돈다', async () => {
      const w3 = await browser.newPage(); // 오래 산 웹 탭과 격리
      try {
      // 이 시점엔 보관 오디오 항목이 없을 수 있으니(캡처 스텝들은 자기 정리를 한다) 하나 심어 소리 업로드까지 본다
      await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'web.items.import', payload: { items: [{ id: 'netflix:12345:2000', platform: 'netflix', videoId: '12345', title: 'Mock Show', episode: 'S1:E1', text: 'Hello there, welcome to the test.', translation: '', startMs: 2000, endMs: 4000, savedAt: Date.now(), box: 'learning', audio: { ms: 2500, leadMs: 250, mime: 'audio/mpeg' } }] } }, {}));
      await sw.evaluate(() => chrome.storage.local.set({ ['audio:netflix:12345:2000']: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAA' + 'QUFB'.repeat(300) }));
      // 코드 기본값은 실제 Supabase 다 — 주소·키는 페이지가 뜨기 전에 모의 서버로 넣어 두고, 유저처럼 이메일·비밀번호만 입력한다
      await w3.evaluateOnNewDocument(() => { try { localStorage.setItem('st.supaUrl', 'http://127.0.0.1:8769'); localStorage.setItem('st.supaKey', 'test-anon'); } catch (e) { /* ignore */ } });
      await w3.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
      await w3.waitForSelector('.supa-email', { visible: true });
      await sleep(1500); // 설정 화면은 데이터를 다 불러온 뒤 한 번 더 그려진다 (그때 입력 중인 칸이 새로 만들어진다)
      const type = async (sel, txt) => { await w3.$eval(sel, (e) => { e.value = ''; }); await w3.type(sel, txt); };
      for (let k = 0; ; k++) {
        await type('.supa-email', 'me@test.local');
        await type('.supa-pass', 'pass1234');
        const f = await w3.evaluate(() => ({ url: document.querySelector('.supa-url').value, email: document.querySelector('.supa-email').value, pass: document.querySelector('.supa-pass').value }));
        if (f.email === 'me@test.local' && f.pass === 'pass1234') { assert(f.url === 'http://127.0.0.1:8769', 'sign up only against the mock, got ' + f.url); break; }
        if (k >= 2) throw new Error('login form kept resetting ' + JSON.stringify(f));
        await sleep(800);
      }
      await w3.click('.supa-signup');
      await waitFor(() => w3.$eval('.supa-line', (e) => /^올렸습니다/.test(e.textContent)), 60000, 'signup logs in and uploads')
        .catch(async (e) => {
          // 메인 스레드가 멈춘 경우 그 지점의 JS 스택을 덤프한다
          let stack = '(none)';
          try {
            const cdp = await w3.target().createCDPSession();
            await cdp.send('Debugger.enable');
            const paused = new Promise((res) => cdp.once('Debugger.paused', (ev) => res(ev.callFrames.slice(0, 8).map((f) => (f.functionName || '(anon)') + '@' + (f.url || '').split('/').pop() + ':' + (f.location && f.location.lineNumber)).join(' < '))));
            await cdp.send('Debugger.pause');
            stack = await Promise.race([paused, new Promise((res) => setTimeout(() => res('(no pause event — main thread not running JS)'), 4000))]);
            await cdp.send('Debugger.resume').catch(() => {});
            await cdp.detach().catch(() => {});
          } catch (err2) { stack = '(cdp err ' + err2.message + ')'; }
          const t = await Promise.race([w3.$eval('.supa-line', (el) => el.textContent).catch(() => '(없음)'), new Promise((res) => setTimeout(() => res('(EVAL BLOCKED)'), 3000))]);
          throw new Error(e.message + ' — supa-line: "' + t + '" ┃stack=' + stack);
        });
      const st = await supaState();
      const counts = await sw.evaluate(async () => { const s = await chrome.storage.local.get(['items', 'words']); return { items: (s.items || []).length, words: (s.words || []).length }; });
      assert(st.items.length === counts.items && counts.items > 0, 'server items match the extension (' + st.items.length + '/' + counts.items + ')');
      assert(st.words.length === counts.words, 'server words match (' + st.words.length + '/' + counts.words + ')');
      const withAudio = st.items.filter((i) => i.has_audio).length;
      assert(st.objects.length === withAudio && withAudio >= 1, 'every has_audio item has an uploaded MP3 (' + st.objects.length + '/' + withAudio + ')');
      assert(st.objects.some((ob) => ob[0].endsWith('/netflix_12345_2000.mp3') && ob[1] > 500), 'the seeded audio landed with the iPhone-safe name');
      assert(st.objects.every((o) => /^audio\/[^/]+\/[A-Za-z0-9._-]+\.mp3$/.test(o[0])), 'storage names follow the iPhone-safe rule');
      assert(st.items.every((i) => typeof i.start_ms === 'number' && typeof i.saved_at === 'number' && typeof i.text === 'string'), 'rows carry the columns the iPhone app reads');
      // 로그인 유지 + 자동 동기화: 다시 접속하면 refresh 토큰으로 조용히 로그인해 올린다 (쓰로틀을 0 으로 당겨서 확인)
      // 아이폰에서 태그를 바꾼 것처럼: 서버 행의 tags 와 updated_at 만 고친다 (앱의 PATCH 와 같은 모양)
      const phoneAt = new Date(Date.now() + 1000).toISOString();
      const pr = await fetch('http://127.0.0.1:8769/rest/v1/items?id=eq.' + encodeURIComponent('netflix:12345:2000'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: ['교실 영어'], box: 'known', updated_at: phoneAt }) });
      assert(pr.status === 204, 'mock PATCH ' + pr.status);
      const postsBefore = (await supaState()).itemPosts;
      // 로그인 유지 + 자동 동기화: 다시 접속하면 저장된 로그인으로 조용히 → 아이폰 태그를 먼저 받아 오고 → 다시 올린다
      await w3.evaluate(() => localStorage.setItem('st.supaLastAt', '0'));
      await w3.reload({ waitUntil: 'load' });
      await waitFor(async () => (await supaState()).itemPosts > postsBefore, 30000, 'auto sync after reload uploads again');
      const pulled = await sw.evaluate(async () => (((await chrome.storage.local.get('items')).items) || []).find((x) => x.id === 'netflix:12345:2000'));
      assert(pulled && JSON.stringify(pulled.tags) === JSON.stringify(['교실 영어']), 'phone tag pulled into the extension: ' + JSON.stringify(pulled && pulled.tags));
      assert(pulled.box === 'known', 'phone "알아요" (box=known) pulled into the extension: ' + pulled.box);
      const row = (await supaState()).items.find((x) => x.id === 'netflix:12345:2000');
      assert(JSON.stringify(row.tags) === JSON.stringify(['교실 영어']) && row.box === 'known', 're-upload keeps the phone tag and box: ' + JSON.stringify([row.tags, row.box]));
      // 뒤 단계에 영향을 주지 않게 로그인을 정리한다
      await w3.evaluate(() => { localStorage.removeItem('st.supaRefresh'); localStorage.setItem('st.supaAuto', '1'); });
      } finally {
        await sw.evaluate(() => globalThis.__subtutorHandle({ type: 'items.remove', id: 'netflix:12345:2000' }, {})).catch(() => {});
        await w3.close().catch(() => {});
      }
    });

    // ── 입트기 (말하기 유창성 연습, 웹) — 확장 프로그램 없이도 도는 화면이라 새 탭에서 ──
    let w4 = null;
    await step('입트기(웹): 기본 프롬프트 48 + 줄 붙여넣기(번호 떼고·중복 버림) · 편집·지우기 · 자유 말하기(가짜 마이크) 녹음이 기록 줄로 · 별점·메모', async () => {
      w4 = await browser.newPage();
      await w4.evaluateOnNewDocument(() => { try {
        localStorage.setItem('st.supaUrl', 'http://127.0.0.1:8769');
        localStorage.setItem('st.supaKey', 'test-anon');
        localStorage.setItem('st.supaRefresh', 'rt-speak');
        localStorage.setItem('st.speak', JSON.stringify({ stages: [1, 3], drop10: false }));   // 1단계 1초(넘겨서 +N 검사)·2단계 3초(일찍 멈춰 '부족' — 느린 머신에서 0.4초 클릭이 1초로 늦어도 반올림이 3에 못 미친다) + 10초 미만 버리기는 꺼 둔다
      } catch (e) { /* ignore */ } });
      await w4.goto('http://localhost:8766/#/speak', { waitUntil: 'load' });
      await w4.waitForSelector('.speak-p', { visible: true });
      const base = await w4.evaluate(() => ({
        n: JSON.parse(localStorage.getItem('st.speak')).prompts.length,
        groups: document.querySelectorAll('.speak-group').length,
      }));
      assert(base.n >= 48, '기본 프롬프트가 내장된다: ' + base.n);
      assert(base.groups >= 9, '짧게/길게 묶음 제목: ' + base.groups);
      // 줄 붙여넣기 → 1줄 1프롬프트 (번호·글머리표 제거, 중복 무시)
      await w4.evaluate(() => { [...document.querySelectorAll('.speak-head .btn')].find((b) => b.textContent === '＋ 추가').click(); });
      await w4.type('.speak-import textarea', '1. Custom one?\n- Custom two!\ncustom ONE?');
      await w4.evaluate(() => document.querySelector('.speak-import .btn.primary').click());
      let mine = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).prompts.filter((x) => x.cat === 'mine'));
      assert(mine.length === 2 && mine[0].text === 'Custom one?' && mine[1].text === 'Custom two!', '3줄 → 2개 (번호 떼고 중복 버림): ' + JSON.stringify(mine.map((x) => x.text)));
      // 편집: 이름 고치기 + 지우기(지움 표식)
      await w4.evaluate(() => { [...document.querySelectorAll('.speak-head .btn')].find((b) => b.textContent === '✎ 편집').click(); });
      await w4.evaluate((id) => {
        const card = document.querySelector('[data-sp="' + id + '"]');
        const input = card.querySelector('input');
        input.value = 'Custom one, edited?';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, mine[0].id);
      await w4.evaluate((id) => { document.querySelector('[data-sp="' + id + '"] .btn.danger').click(); }, mine[1].id);
      await w4.evaluate(() => { [...document.querySelectorAll('.speak-head .btn')].find((b) => b.textContent === '편집 끝').click(); });
      mine = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).prompts.filter((x) => x.cat === 'mine'));
      assert(mine[0].text === 'Custom one, edited?' && mine[1].deleted === true, '편집·지우기: ' + JSON.stringify([mine[0].text, mine[1].deleted]));
      assert(await w4.evaluate((id) => !document.querySelector('[data-sp="' + id + '"]'), mine[1].id), '지운 프롬프트는 목록에서 빠진다');
      // 자유 말하기: 가짜 마이크로 1.2초쯤 녹음
      await w4.evaluate((id) => { document.querySelector('[data-sp="' + id + '"] .p-head').click(); }, mine[0].id);
      await w4.evaluate((id) => { [...document.querySelector('[data-sp="' + id + '"]').querySelectorAll('.speak-bigbtns .btn')].find((b) => b.textContent.includes('자유')).click(); }, mine[0].id);
      await w4.waitForSelector('.speak-rec', { visible: true });
      await new Promise((r) => setTimeout(r, 1300));
      await w4.evaluate(() => document.querySelector('.speak-rec .rbtn.stop').click());
      await waitFor(() => w4.evaluate(() => !document.querySelector('.speak-rec')), 8000, 'free recording saves and closes');
      await waitFor(() => w4.evaluate(() => document.querySelectorAll('.speak-take').length >= 1), 5000, 'take row appears');
      const t1 = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).takes[0]);
      assert(t1.mode === 'free' && t1.durMs >= 900, '자유 녹음 길이: ' + Math.round(t1.durMs) + 'ms');
      // 별점 4 + 메모
      await w4.evaluate(() => { document.querySelectorAll('.speak-take .speak-stars button')[3].click(); });
      await w4.evaluate(() => { document.querySelector('.speak-take .icon[title="메모"]').click(); });
      await w4.evaluate(() => {
        const ta = document.querySelector('.speak-take .t-memo');
        ta.value = '막힌 데: rules 설명';
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const t1b = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).takes[0]);
      assert(t1b.rating === 4 && t1b.memo === '막힌 데: rules 설명', '별점·메모 저장: ' + JSON.stringify([t1b.rating, t1b.memo]));
      // 재생 단추가 생긴다 (오디오가 이 브라우저에 있다)
      assert(await w4.evaluate(() => !!document.querySelector('.speak-take .icon[title="재생"]')), '오디오가 있어 ▶ 가 보인다');
    });

    await step('입트기(웹) 범주 접기·주사위·스와이프 삭제: 제목을 누르면 접히고, 🎲 가 뽑은 범주는 자동으로 펼쳐지고, 기록을 왼쪽으로 밀면 빨간 삭제', async () => {
      // 범주 제목을 눌러 모두 접는다
      await w4.evaluate(() => {
        for (let i = 0; i < 25; i++) {
          const g = [...document.querySelectorAll('.speak-group')].find((x) => !x.classList.contains('closed'));
          if (!g) break;
          g.click();
        }
      });
      const folded = await w4.evaluate(() => ({ cards: document.querySelectorAll('.speak-p').length, open: document.querySelectorAll('.speak-group:not(.closed)').length, saved: (JSON.parse(localStorage.getItem('st.speak')).collapsed || []).length }));
      assert(folded.cards === 0 && folded.open === 0, '모두 접힘 — 카드가 없다: ' + JSON.stringify(folded));
      assert(folded.saved >= 9, '접힌 상태가 저장된다: ' + folded.saved);
      // 🎲: 뽑힌 프롬프트의 범주만 자동으로 펼쳐지고 그 카드가 열린다
      await w4.evaluate(() => { [...document.querySelectorAll('.speak-head .btn')].find((b) => b.textContent.includes('아무거나')).click(); });
      const dice = await w4.evaluate(() => ({ open: document.querySelectorAll('.speak-group:not(.closed)').length, card: !!document.querySelector('.speak-p.open') }));
      assert(dice.open === 1 && dice.card, '주사위가 범주 하나를 펼치고 카드를 연다: ' + JSON.stringify(dice));
      // 뒤 단계를 위해 다시 모두 펼친다
      await w4.evaluate(() => {
        for (let i = 0; i < 25; i++) {
          const g = [...document.querySelectorAll('.speak-group.closed')][0];
          if (!g) break;
          g.click();
        }
      });
      // 버릴 녹음 하나 만들고 → 왼쪽으로 밀면 빨간 삭제 버튼 → 누르면 지움 표식
      const mine = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).prompts.filter((x) => x.cat === 'mine' && !x.deleted));
      await w4.evaluate((id) => { const c = document.querySelector('[data-sp="' + id + '"]'); if (!c.classList.contains('open')) c.querySelector('.p-head').click(); }, mine[0].id);
      await w4.evaluate((id) => { [...document.querySelector('[data-sp="' + id + '"]').querySelectorAll('.speak-bigbtns .btn')].find((b) => b.textContent.includes('자유')).click(); }, mine[0].id);
      await w4.waitForSelector('.speak-rec', { visible: true });
      await new Promise((r) => setTimeout(r, 1100));
      await w4.evaluate(() => document.querySelector('.speak-rec .rbtn.stop').click());
      await waitFor(() => w4.evaluate(() => !document.querySelector('.speak-rec')), 8000, 'disposable recording saves');
      await waitFor(() => w4.evaluate(() => document.querySelectorAll('.speak-take').length >= 2), 5000, 'two take rows');
      assert(await w4.evaluate(() => !document.querySelector('.speak-take .icon[title="이 녹음 지우기"]')), '휴지통 아이콘이 없다');
      await w4.evaluate(() => {
        const row = document.querySelectorAll('.speak-take')[0];   // 맨 위가 방금 녹음
        const r = row.getBoundingClientRect();
        const y = r.top + 8;
        const fire = (type, x) => row.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, clientX: x, clientY: y }));
        fire('pointerdown', r.left + 220);
        for (let x = r.left + 220; x >= r.left + 80; x -= 20) fire('pointermove', x);
        fire('pointerup', r.left + 80);
      });
      const swiped = await w4.evaluate(() => { const row = document.querySelectorAll('.speak-take')[0]; return { mark: row.dataset.swiped, shift: row.querySelector('.t-inner').style.transform }; });
      assert(swiped.mark === '1' && /translateX\(-/.test(swiped.shift), '밀면 줄이 밀리고 삭제 버튼이 드러난다: ' + JSON.stringify(swiped));
      await new Promise((r) => setTimeout(r, 420));   // 민 직후의 클릭은 삼키므로 잠깐 뒤에 누른다
      await w4.evaluate(() => { document.querySelectorAll('.speak-take')[0].querySelector('.t-del').click(); });
      await waitFor(() => w4.evaluate(() => document.querySelectorAll('.speak-take').length === 1), 5000, 'row disappears');
      const takes = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).takes);
      assert(takes.length === 2 && takes.filter((t) => t.deleted).length === 1, '지움 표식이 남아 동기화로 전해진다: ' + JSON.stringify(takes.map((t) => !!t.deleted)));
    });

    await step('입트기(웹) 10초 미만 자동 삭제: 스위치를 켜면 짧은 녹음을 버리고 알린다', async () => {
      await w4.evaluate(() => { document.querySelector('.speak-drop10 input').click(); });   // 끈 상태(선주입)에서 켠다
      assert(await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).drop10 === true), '스위치가 저장된다');
      const before = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).takes.length);
      const mine = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).prompts.filter((x) => x.cat === 'mine' && !x.deleted));
      await w4.evaluate((id) => { const c = document.querySelector('[data-sp="' + id + '"]'); if (!c.classList.contains('open')) c.querySelector('.p-head').click(); }, mine[0].id);
      await w4.evaluate((id) => { [...document.querySelector('[data-sp="' + id + '"]').querySelectorAll('.speak-bigbtns .btn')].find((b) => b.textContent.includes('자유')).click(); }, mine[0].id);
      await w4.waitForSelector('.speak-rec', { visible: true });
      await new Promise((r) => setTimeout(r, 1200));
      await w4.evaluate(() => document.querySelector('.speak-rec .rbtn.stop').click());
      await waitFor(() => w4.evaluate(() => !document.querySelector('.speak-rec')), 8000, 'short recording closes');
      const after = await w4.evaluate(() => ({ n: JSON.parse(localStorage.getItem('st.speak')).takes.length, toast: document.querySelector('#toast') ? document.querySelector('#toast').textContent : '' }));
      assert(after.n === before, '10초 미만이라 저장되지 않는다: ' + before + ' → ' + after.n);
      assert(/10초/.test(after.toast), '안내 토스트: ' + after.toast);
      await w4.evaluate(() => { document.querySelector('.speak-drop10 input').click(); });   // 뒤 스텝들(1초 녹음)을 위해 다시 끈다
      assert(await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).drop10 === false), '다시 꺼짐');
    });

    await step('입트기(웹) 줄여 말하기: 1초 단계를 넘기면 원형 타이머에 +N초가 올라가고(주황), 멈추면 "N초 초과" → 다음 단계는 일찍 멈춰 "N초 부족" · 기록 줄에 목표와 초과/부족', async () => {
      const mine = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).prompts.filter((x) => x.cat === 'mine' && !x.deleted));
      await w4.evaluate((id) => { const c = document.querySelector('[data-sp="' + id + '"]'); if (!c.classList.contains('open')) c.querySelector('.p-head').click(); }, mine[0].id);
      await w4.evaluate((id) => { [...document.querySelector('[data-sp="' + id + '"]').querySelectorAll('.speak-bigbtns .btn')].find((b) => b.textContent.includes('줄여')).click(); }, mine[0].id);
      await w4.waitForSelector('.speak-rec .speak-ring', { visible: true });
      await new Promise((r) => setTimeout(r, 1900));   // 1초 목표를 넘긴다
      const over = await w4.evaluate(() => ({ clock: document.querySelector('.speak-rec .r-clock').textContent, overLen: document.querySelector('.speak-rec .ring-over').getAttribute('stroke-dasharray') }));
      assert(/^\+\d+$/.test(over.clock), '넘긴 시간이 +N 으로 보인다: ' + over.clock);
      assert(parseFloat(over.overLen) > 0, '주황 띠가 같은 방향으로 덧칠된다: ' + over.overLen);
      await w4.evaluate(() => document.querySelector('.speak-rec .rbtn.stop').click());
      await waitFor(() => w4.evaluate(() => { const r = document.querySelector('.speak-rec .r-result'); return r && r.style.display !== 'none' && !!r.querySelector('b'); }), 8000, 'stage result shows');
      const r1 = await w4.evaluate(() => document.querySelector('.speak-rec .r-result b').textContent);
      assert(/초과/.test(r1), '1단계 결과가 "초과": ' + r1);
      // 다음 단계(1초)를 일찍 멈춰 "부족"
      await w4.evaluate(() => { [...document.querySelectorAll('.speak-rec .r-result .btn')].find((b) => b.textContent.startsWith('다음 단계')).click(); });
      await waitFor(() => w4.evaluate(() => /2\/2/.test(document.querySelector('.speak-rec .r-stage').textContent) && document.querySelector('.speak-rec .r-result').style.display === 'none'), 8000, 'stage 2 starts');
      await new Promise((r) => setTimeout(r, 420));
      await w4.evaluate(() => document.querySelector('.speak-rec .rbtn.stop').click());
      await waitFor(() => w4.evaluate(() => { const r = document.querySelector('.speak-rec .r-result'); const b = r && r.querySelector('b'); return r && r.style.display !== 'none' && b && /2단계/.test(b.textContent); }), 8000, 'stage 2 result shows');
      const r2 = await w4.evaluate(() => document.querySelector('.speak-rec .r-result b').textContent);
      assert(/부족/.test(r2), '2단계(일찍 멈춤) 결과가 "부족": ' + r2);
      await w4.evaluate(() => { [...document.querySelectorAll('.speak-rec .r-result .btn')].find((b) => b.textContent === '끝내기').click(); });
      await waitFor(() => w4.evaluate(() => !document.querySelector('.speak-rec')), 5000, 'session closes');
      const steps = await w4.evaluate(() => JSON.parse(localStorage.getItem('st.speak')).takes.filter((t) => t.mode === 'step'));
      assert(steps.length === 2 && JSON.stringify(steps.map((t) => t.targetS)) === '[1,3]', '줄여 기록 2개(목표 1·3초): ' + JSON.stringify(steps.map((t) => [t.targetS, Math.round(t.durMs)])));
      const badges = await w4.evaluate(() => [...document.querySelectorAll('.speak-take .t-over, .speak-take .t-under')].map((x) => x.textContent));
      assert(badges.some((x) => /초과/.test(x)) && badges.some((x) => /부족/.test(x)), '기록 줄에 초과·부족 배지: ' + JSON.stringify(badges));
    });

    await step('입트기(웹) 동기화: 바뀐 프롬프트·기록만 모의 Supabase 로(오디오 없음), 폰에서 고친 프롬프트는 updated_at 비교로 받아 온다', async () => {
      try {
        await w4.evaluate(() => { [...document.querySelectorAll('.speak-head .btn')].find((b) => b.textContent === '동기화').click(); });
        await waitFor(() => w4.evaluate(() => /동기화 끝/.test(document.querySelector('.speak-sync').textContent)), 15000, 'speak sync finishes');
        const st = await supaState();
        assert(st.speakPrompts.length === 2, '바뀐 프롬프트만 올라간다 (내장 48개는 안 올라감): ' + st.speakPrompts.length);
        assert(st.speakPrompts.some((x) => x.deleted === true), '지움 표식도 올라간다');
        assert(st.speakTakes.filter((x) => !x.deleted).length === 3 && st.speakTakes.every((x) => typeof x.dur_ms === 'number'), '산 기록 3개가 정보만 올라간다: ' + JSON.stringify(st.speakTakes.map((x) => !!x.deleted)));
        assert(st.speakTakes.some((x) => x.deleted === true), '밀어서 지운 기록도 지움 표식으로 올라간다');
        const edited = st.speakPrompts.find((x) => !x.deleted);
        assert(edited.text === 'Custom one, edited?', '고친 글이 올라갔다: ' + edited.text);
        const rated = st.speakTakes.find((x) => x.rating === 4);
        assert(rated && rated.memo === '막힌 데: rules 설명' && rated.mode === 'free', '별점·메모·모드가 올라갔다');
        // 폰에서 고쳤다 치고(더 새 updated_at) → 받아 오기
        const phoneAt = new Date(Date.now() + 1500).toISOString();
        await fetch('http://127.0.0.1:8769/rest/v1/speak_prompts?id=eq.' + encodeURIComponent(edited.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Edited on phone', updated_at: phoneAt }) });
        await w4.evaluate(() => { [...document.querySelectorAll('.speak-head .btn')].find((b) => b.textContent === '동기화').click(); });
        await waitFor(() => w4.evaluate((id) => {
          const p = JSON.parse(localStorage.getItem('st.speak')).prompts.find((x) => x.id === id);
          return p && p.text === 'Edited on phone';
        }, edited.id), 15000, 'phone edit pulled');
        assert(await w4.evaluate((id) => document.querySelector('[data-sp="' + id + '"] .p-text').textContent === 'Edited on phone', edited.id), '받아 온 글이 화면에도 보인다');
      } finally {
        await w4.close().catch(() => {});
      }
    });

    await step('영상 오디오 → 아이폰: 웹이 폴더 MP3 를 올리고, 서버 소리 관리에서 대사 소리·영상 오디오를 지우며, 목록 머리에 플레이어가 선다', async () => {
      const UID = '00000000-0000-4000-8000-000000000001';
      const recAt = Date.now();
      const recId = 'r' + recAt.toString(36);
      // 씨앗: 폴더에 가짜 MP3, 확장 프로그램에 대사 1개 + 녹음 목록 1개, 모의 서버에 그 대사의 소리 객체·행
      await opt.evaluate(async (bytes) => {
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle('e2e-docs', { create: true });
        for (const seg of ['SubTutor', '영상 오디오']) dir = await dir.getDirectoryHandle(seg, { create: true });
        const f = await dir.getFileHandle('Rec Show S1 E1.mp3', { create: true });
        const w = await f.createWritable();
        await w.write(new Uint8Array(bytes));
        await w.close();
      }, Array.from(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x44]), Buffer.alloc(3000, 7)])));
      await sw.evaluate(async (recId2, recAt2) => {
        await chrome.storage.local.set({
          items: [{ id: 'rec:show:1', platform: 'netflix', title: 'Rec Show', episode: 'S1 E1', text: 'Hello there.', translation: '', startMs: 1000, endMs: 2000, savedAt: Date.now(), tags: [], box: 'learning' }],
          recordings: [{ id: recId2, title: 'Rec Show S1 E1', at: recAt2, durMs: 754000, bytes: 3004, file: { location: 'folder', path: 'e2e-docs/SubTutor/영상 오디오/Rec Show S1 E1.mp3', downloadId: 0 }, sent: 0, skip: false }],
        });
      }, recId, recAt);
      await fetch('http://127.0.0.1:8769/rest/v1/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ id: 'rec:show:1', title: 'Rec Show', episode: 'S1 E1', has_audio: true, audio_ms: 1000, box: 'learning', tags: [] }]) });
      await fetch('http://127.0.0.1:8769/storage/v1/object/audio/' + UID + '/rec_show_1.mp3', { method: 'POST', body: Buffer.from([1, 2, 3, 4]) });
      const w5 = await browser.newPage();
      await w5.evaluateOnNewDocument(() => { try {
        localStorage.setItem('st.supaUrl', 'http://127.0.0.1:8769');
        localStorage.setItem('st.supaKey', 'test-anon');
        localStorage.setItem('st.supaRefresh', 'rt-rec');
        localStorage.setItem('st.supaAuto', '0');
      } catch (e) { /* ignore */ } });
      try {
        await w5.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
        await waitFor(() => w5.evaluate(() => !!document.querySelector('.supa-storage')), 8000, 'settings renders');
        // items 로딩이 끝나면 설정이 다시 그려져 닫힌 패널로 바뀐다 — 읽을 때마다 열어 둔다
        const bodyText = () => w5.evaluate(() => {
          const d = document.querySelector('.supa-storage');
          if (d && !d.open) d.open = true;
          const b = document.querySelector('.supa-storage-body');
          return b ? b.textContent : '';
        });
        await waitFor(async () => /아직 안 올라간 녹음 1개/.test(await bodyText()), 15000, 'pending recording listed');
        assert(/Rec Show · S1 E1/.test(await bodyText()), '대사 소리 묶음이 보인다: ' + (await bodyText()).slice(0, 200));
        // 지금 올리기 → 모의 Storage 에 rec/<id>.<길이36>.<제목 base64url>.mp3 가 생기고 목록에 sent 표시
        await w5.evaluate(() => { [...document.querySelectorAll('.supa-storage-body button')].find((b) => b.textContent === '지금 올리기').click(); });
        await waitFor(async () => (await supaState()).objects.some(([k]) => k.includes('/rec/')), 20000, 'rec uploaded to storage');
        const obj = (await supaState()).objects.find(([k]) => k.includes('/rec/'));
        assert(obj[0].startsWith('audio/' + UID + '/rec/' + recId + '.') && obj[1] === 3004, '파일 이름·바이트: ' + JSON.stringify(obj));
        await waitFor(() => sw.evaluate(async () => ((((await chrome.storage.local.get('recordings')).recordings) || [])[0] || {}).sent > 0), 8000, 'sent mark');
        await waitFor(async () => /Rec Show S1 E1 — /.test(await bodyText()) && /영상 오디오 합계/.test(await bodyText()), 10000, 'remote rec row with decoded title');
        // 대사 소리 묶음을 서버에서 지우면: 객체 삭제 + 행의 has_audio 꺼짐 (아이폰이 내려받기를 권하지 않게)
        await w5.evaluate(() => { const r = [...document.querySelectorAll('.supa-storage-body .supa-obj')].find((x) => /Rec Show · S1 E1/.test(x.textContent)); r.querySelector('button').click(); });
        await waitFor(async () => !(await supaState()).objects.some(([k]) => k.endsWith('/rec_show_1.mp3')), 10000, 'episode audio object removed');
        // 객체 삭제 뒤에 has_audio 패치가 이어진다 — 끝날 때까지 기다린다
        await waitFor(async () => {
          const row = (await supaState()).items.find((x) => x.id === 'rec:show:1');
          return row && row.has_audio === false && row.audio_ms === 0;
        }, 8000, '행의 has_audio 가 꺼진다');
        // 저장한 자막 목록: 작품 머리 아래 에피소드 오디오 플레이어 (길이 12:34 = 754초)
        await w5.goto('http://localhost:8766/#/', { waitUntil: 'load' });
        await waitFor(() => w5.evaluate(() => !!document.querySelector('.epi-audio')), 10000, 'episode player row');
        const ea = await w5.evaluate(() => document.querySelector('.epi-audio').textContent);
        assert(/에피소드 오디오/.test(ea) && /12:34/.test(ea), '플레이어에 통째 길이가 보인다: ' + ea);
        assert(await w5.evaluate(() => !!document.querySelector('.epi-audio .ea-seek') && document.querySelectorAll('.epi-audio button').length >= 6), '⏪⏩·배속·반복 단추: ' + (await w5.evaluate(() => document.querySelectorAll('.epi-audio button').length)));
        // 구간 반복 버튼 하나로: 시작 지정 → 끝 지정(반복) → 해제
        const loopSel = '.epi-audio .ea-loop';
        await w5.click(loopSel);
        await waitFor(() => w5.$eval(loopSel, (b) => b.textContent === 'A→' && b.classList.contains('ea-mid')), 4000, 'loop start set');
        await w5.click(loopSel);
        const onTitle = await waitFor(() => w5.$eval(loopSel, (b) => (b.classList.contains('on') ? b.title : null)), 4000, 'loop range set');
        assert(/반복 중 0:00–0:0\d/.test(onTitle), '구간이 제목에 보인다: ' + onTitle);
        assert(await w5.evaluate(() => /^반복 /.test(document.querySelector('.epi-audio .ea-looplab').textContent)), '구간 표시 글');
        await w5.click(loopSel);
        await waitFor(() => w5.$eval(loopSel, (b) => !b.classList.contains('on') && !b.classList.contains('ea-mid') && b.textContent === '🔁'), 4000, 'loop cleared');
        assert(await w5.evaluate(() => document.querySelector('.epi-audio .ea-looplab').textContent === ''), '해제하면 구간 글도 사라진다');
        // 영상 오디오를 서버에서 지우면 skip 이 남아 자동으로 다시 올라가지 않는다
        await w5.goto('http://localhost:8766/#/settings', { waitUntil: 'load' });
        await waitFor(async () => [...(await bodyText()).matchAll(/Rec Show S1 E1 — /g)].length >= 1, 15000, 'rec row listed again');
        await w5.evaluate(() => { const r = [...document.querySelectorAll('.supa-storage-body .supa-obj')].find((x) => /Rec Show S1 E1 — /.test(x.textContent)); r.querySelector('button').click(); });
        await waitFor(async () => !(await supaState()).objects.some(([k]) => k.includes('/rec/')), 10000, 'rec object removed');
        await waitFor(() => sw.evaluate(async () => ((((await chrome.storage.local.get('recordings')).recordings) || [])[0] || {}).skip === true), 8000, 'skip mark');
        await waitFor(async () => /다시 올리기 허용/.test(await bodyText()), 8000, 're-upload button shows');
      } finally {
        await w5.close().catch(() => {});
        await sw.evaluate(async () => {
          await chrome.storage.local.remove('recordings');
          const { items } = await chrome.storage.local.get('items');
          await chrome.storage.local.set({ items: (items || []).filter((i) => i.id !== 'rec:show:1') });
        });
        await opt.evaluate(async () => { try { const root = await navigator.storage.getDirectory(); const d = await (await root.getDirectoryHandle('e2e-docs')).getDirectoryHandle('SubTutor'); await d.removeEntry('영상 오디오', { recursive: true }); } catch (e) { /* 없음 */ } });
      }
    });

    await step('확장 프로그램을 다시 불러오면(⟳) 열려 있던 플레이어 탭과 웹 탭에 "새로고침" 안내가 뜬다', async () => {
      const web2 = await browser.newPage();
      try {
        await web2.goto('http://localhost:8766/#/list', { waitUntil: 'load' });
        await waitFor(() => web2.evaluate(() => !!document.documentElement.getAttribute('data-subtutor')), 6000, 'bridge attached');
        await sw.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); return true; }).catch(() => {});
        await waitFor(() => yt.evaluate(() => { const b = document.querySelector('.st-orphan'); return b ? b.textContent : null; }), 10000, 'player tab orphan banner')
          .then((t) => assert(/새로고침/.test(t), 'banner text ' + t));
        await waitFor(() => web2.evaluate(() => { const b = document.querySelector('.ext-orphan'); return b ? b.textContent : null; }), 10000, 'web tab orphan banner')
          .then((t) => assert(/새로고침/.test(t), 'web banner text ' + t));
      } finally {
        await web2.close().catch(() => {});
      }
    });

    const errors = logs.filter((l) => /error/i.test(l) && !/favicon|ERR_|net::/i.test(l));
    if (errors.length) console.log('  콘솔 오류:\n   ' + errors.slice(0, 10).join('\n   '));
    await runDisney();
    await runSites();
  } catch (e) {
    failed = true;
    console.log('✖ 치명적 오류: ' + (e && e.stack || e));
  } finally {
    const bad = results.filter((r) => !r.ok);
    console.log('\n결과: ' + (results.length - bad.length) + '/' + results.length + ' 통과' + (bad.length ? ' — 실패: ' + bad.map((b) => b.name).join(', ') : ''));
    await browser.close().catch(() => {});
    try { supaMock.kill(); } catch (e) { /* 이미 죽음 */ }
    servers.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    process.exit(failed || bad.length ? 1 : 0);
  }
})();
