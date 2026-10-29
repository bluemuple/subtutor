/*
 * SubTutor – 탭 오디오 캡처 프레임
 * 부모(플레이어 페이지의 콘텐츠 스크립트)가 postMessage 로 명령한다.
 *   start {tabId, limitMs}             → 이 탭의 오디오 스트림을 열고 PCM 을 벽시계에 맞춰 모은다 (들리는 소리는 그대로 스피커로 통과)
 *   finish {startMs, endMs, anchors}   → (벽시계ms, 미디어ms) 쌍으로 미디어 구간을 벽시계 구간으로 바꿔 잘라내고 WAV(base64)로 돌려준다
 *   stop                                → 캡처 종료
 * 스트림 ID 는 요청한 컨텍스트(이 프레임)에서만 쓸 수 있어 여기서 getMediaStreamId 와 getUserMedia 를 함께 한다.
 */
(() => {
  'use strict';
  const A = globalThis.SubTutorAudio;
  const PAD_MS = 250;
  let session = null;
  const nowWall = () => performance.timeOrigin + performance.now();
  const parentOrigin = (() => { try { return new URL(document.referrer).origin; } catch (e) { return ''; } })();

  function post(msg) { try { window.parent.postMessage(Object.assign({ __stcap: 'res' }, msg), parentOrigin || '*'); } catch (e) { /* ignore */ } }

  function stop(cur) {
    if (!cur) return;
    clearTimeout(cur.timer);
    try { if (cur.reader) cur.reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
    try { if (cur.processor) cur.processor.disconnect(); } catch (e) { /* ignore */ }
    try { if (cur.source) cur.source.disconnect(); } catch (e) { /* ignore */ }
    try { if (cur.ctx) cur.ctx.close(); } catch (e) { /* ignore */ }
    if (cur.stream) for (const t of cur.stream.getTracks()) t.stop();
    if (cur.waiter) cur.waiter.resolve();
    if (session === cur) session = null;
  }

  function placeFrames(cur, frames, sampleRate, timestampUs) {
    // 첫 블록이 도착한 벽시계를 기준으로 샘플 수를 세어 이어 붙인다.
    // 타임스탬프는 조각이 빠져 50ms 이상 벌어졌을 때 앞으로 건너뛰는 데만 쓴다 (뒤로는 가지 않는다: 겹침·되풀이 방지)
    if (cur.originMs === null) {
      cur.originMs = nowWall() - (frames * 1000) / sampleRate;
      cur.tsBaseUs = timestampUs;
      cur.nextFrame = 0;
    }
    let start = cur.nextFrame;
    if (Number.isFinite(timestampUs) && Number.isFinite(cur.tsBaseUs)) {
      const byTs = Math.round(((timestampUs - cur.tsBaseUs) / 1000) * sampleRate / 1000);
      if (byTs - start > sampleRate * 0.05) { start = byTs; cur.stats.gaps++; cur.stats.gapFrames += byTs - cur.nextFrame; }
    }
    cur.nextFrame = start + frames;
    cur.stats.chunks++;
    cur.stats.frames += frames;
    return start;
  }
  function recordedUntil(cur) {
    if (cur.originMs === null || !cur.sampleRate) return null;
    return cur.originMs + (cur.nextFrame * 1000) / cur.sampleRate;
  }
  function pushChunk(cur, samples, sampleRate, timestampUs) {
    if (!cur.sampleRate) cur.sampleRate = sampleRate;
    if (sampleRate !== cur.sampleRate) return;
    const startFrame = placeFrames(cur, samples.length, sampleRate, timestampUs);
    cur.chunks.push({ startFrame, samples });
    if (cur.waiter && recordedUntil(cur) >= cur.waiter.untilMs) cur.waiter.resolve();
  }
  // AudioData 한 조각을 모노 Float32 로. f32-planar 변환 복사를 먼저 시도하고, 안 되면 원래 포맷(f32/s16/s32/u8, 평면/교차)으로 읽는다
  function monoFromAudioData(ad, stats) {
    const n = ad.numberOfFrames, nch = ad.numberOfChannels || 1;
    const mono = new Float32Array(n);
    if (stats && !stats.format) stats.format = String(ad.format || '?') + '/' + nch + 'ch/' + n + 'f';
    try {
      const plane = new Float32Array(n);
      for (let ch = 0; ch < nch; ch++) {
        ad.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += plane[i];
      }
      if (nch > 1) for (let i = 0; i < n; i++) mono[i] /= nch;
      return mono;
    } catch (e) { if (stats) stats.convertFallback = (stats.convertFallback || 0) + 1; }
    const fmt = String(ad.format || 'f32');
    const planar = /planar$/.test(fmt);
    const base = fmt.replace('-planar', '');
    const Ctor = base === 'f32' ? Float32Array : (base === 's32' ? Int32Array : (base === 's16' ? Int16Array : Uint8Array));
    const scale = base === 'f32' ? 1 : (base === 's32' ? 1 / 2147483648 : (base === 's16' ? 1 / 32768 : 1 / 128));
    const off = base === 'u8' ? 128 : 0;
    if (planar) {
      const plane = new Ctor(n);
      for (let ch = 0; ch < nch; ch++) { ad.copyTo(plane, { planeIndex: ch }); for (let i = 0; i < n; i++) mono[i] += (plane[i] - off) * scale; }
    } else {
      const buf = new Ctor(n * nch);
      ad.copyTo(buf, { planeIndex: 0 });
      for (let i = 0; i < n; i++) { let acc = 0; for (let ch = 0; ch < nch; ch++) acc += buf[i * nch + ch] - off; mono[i] = acc * scale; }
    }
    if (nch > 1) for (let i = 0; i < n; i++) mono[i] /= nch;
    return mono;
  }
  function readLoop(cur) {
    return cur.reader.read().then(({ done, value }) => {
      if (done || session !== cur) { if (value) { try { value.close(); } catch (e) { /* ignore */ } } return; }
      // 조각 하나가 실패해도 루프는 계속 돈다 (예전에는 첫 오류에서 조용히 멈춰 10ms 만 남을 수 있었다)
      try { pushChunk(cur, monoFromAudioData(value, cur.stats), value.sampleRate, value.timestamp); }
      catch (e) { cur.stats.errors++; cur.stats.lastError = String((e && e.message) || e); }
      finally { try { value.close(); } catch (e) { /* ignore */ } }
      return readLoop(cur);
    }).catch((e) => { cur.stats.readError = String((e && e.message) || e); });
  }
  // 테스트용 합성 신호: 300→900Hz 로 6초 동안 올라가는 사인파 (탭 캡처 대신 같은 파이프라인을 태운다)
  function sweepStream(cur) {
    cur.ctx = new AudioContext();
    const dest = cur.ctx.createMediaStreamDestination();
    const osc = cur.ctx.createOscillator();
    const gain = cur.ctx.createGain();
    gain.gain.value = 0.5;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, cur.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(900, cur.ctx.currentTime + 6);
    osc.connect(gain).connect(dest);
    osc.start();
    cur.osc = osc;
    if (cur.ctx.state === 'suspended') cur.ctx.resume().catch(() => {});
    return dest.stream;
  }

  async function start({ tabId, limitMs, test }) {
    if (session) stop(session);
    const cur = { stream: null, reader: null, ctx: null, source: null, processor: null, chunks: [], sampleRate: 0, originMs: null, tsBaseUs: NaN, nextFrame: 0, timer: null, waiter: null, stats: { chunks: 0, frames: 0, gaps: 0, gapFrames: 0, errors: 0, format: '', source: test === 'sweep' ? 'sweep' : 'tab' } };
    session = cur;
    try {
      if (test === 'sweep') {
        cur.stream = sweepStream(cur);
      } else {
        let streamId;
        try {
          streamId = await new Promise((resolve, reject) => {
            const opts = Number.isInteger(tabId) ? { targetTabId: tabId } : {};
            chrome.tabCapture.getMediaStreamId(opts, (id) => {
              const err = chrome.runtime.lastError;
              if (err || !id) reject(new Error(err ? err.message : 'no stream id')); else resolve(id);
            });
          });
        } catch (err) {
          stop(cur);
          if (/not been invoked|activeTab|invoked/i.test(err.message || '')) return { ok: false, unavailable: 'grant', error: err.message };
          throw err;
        }
        cur.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
        // 캡처 중에도 소리가 계속 들리도록 스피커로 통과시킨다
        try {
          cur.ctx = new AudioContext();
          cur.source = cur.ctx.createMediaStreamSource(cur.stream);
          cur.source.connect(cur.ctx.destination);
          if (cur.ctx.state === 'suspended') cur.ctx.resume().catch(() => {});
        } catch (e) { /* ignore */ }
      }
      const [track] = cur.stream.getAudioTracks();
      if (!track) throw new Error('오디오 트랙이 없습니다');
      if (typeof MediaStreamTrackProcessor === 'function') {
        cur.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        readLoop(cur);
      } else {
        // 구형: ScriptProcessor 로 PCM 수집
        const proc = cur.ctx.createScriptProcessor(4096, cur.source ? 2 : 1, 1);
        cur.processor = proc;
        proc.onaudioprocess = (e) => {
          const ib = e.inputBuffer;
          const mono = new Float32Array(ib.length);
          for (let ch = 0; ch < ib.numberOfChannels; ch++) { const d = ib.getChannelData(ch); for (let i = 0; i < mono.length; i++) mono[i] += d[i] / ib.numberOfChannels; }
          pushChunk(cur, mono, ib.sampleRate, NaN);
        };
        cur.source.connect(proc);
        proc.connect(cur.ctx.destination);
      }
      cur.timer = setTimeout(() => stop(cur), Math.min(120000, limitMs || 60000));
      return { ok: true, padMs: PAD_MS, startedAt: nowWall() };
    } catch (err) {
      stop(cur);
      throw err;
    }
  }

  function drain(cur, untilMs) {
    const until = recordedUntil(cur);
    if (until !== null && until >= untilMs) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (cur.waiter) cur.waiter.resolve(); }, 700);
      cur.waiter = { untilMs, resolve: () => { clearTimeout(timer); cur.waiter = null; resolve(); } };
    });
  }

  async function finish({ startMs, endMs, anchors, downloadRate, storeRate }) {
    const cur = session;
    if (!cur || cur.originMs === null) { stop(cur); throw new Error('녹음된 오디오가 없습니다'); }
    const offset = A.mediaClockOffset(anchors);
    try {
      if (offset !== null) await drain(cur, endMs + PAD_MS + offset);
    } finally {
      if (cur.osc) { try { cur.osc.stop(); } catch (e) { /* ignore */ } }
      stop(cur);
    }
    if (offset === null) throw new Error('플레이어가 재생되지 않아 녹음하지 못했습니다');
    const stats = Object.assign({}, cur.stats, { sampleRate: cur.sampleRate, recordedMs: Math.round((cur.nextFrame * 1000) / (cur.sampleRate || 1)) });
    const describe = () => ' (녹음 ' + stats.recordedMs + 'ms, 조각 ' + stats.chunks + ', 오류 ' + stats.errors + (stats.lastError ? ': ' + stats.lastError : '') + (stats.readError ? ', 읽기 중단: ' + stats.readError : '') + ')';
    if (stats.recordedMs < 200) throw new Error('녹음된 오디오가 너무 짧습니다' + describe());
    const samples = A.clipSamples(cur.chunks, { originMs: cur.originMs, sampleRate: cur.sampleRate, startMs: startMs - PAD_MS + offset, endMs: endMs + PAD_MS + offset });
    if (!samples) throw new Error('대사 구간의 오디오가 녹음되지 않았습니다' + describe());
    const wantMs = endMs - startMs + 2 * PAD_MS;
    const gotMs = (samples.length * 1000) / cur.sampleRate;
    if (gotMs < Math.min(wantMs * 0.6, wantMs - 400)) throw new Error('대사 구간의 일부만 녹음되었습니다 (' + Math.round(gotMs) + '/' + Math.round(wantMs) + 'ms)' + describe());
    if (A.isSilent(samples)) return { ok: true, silent: true, stats };
    const norm = A.normalize(samples, 0.95);
    // 클립이 자막 시작보다 얼마나 앞서 시작하는지(보통 PAD_MS, 녹음이 늦게 시작됐으면 그보다 작음) → 웹의 구간 조정에서 쓴다
    const leadMs = Math.max(0, Math.round(Math.min(PAD_MS, startMs + offset - cur.originMs)));
    const out = { ok: true, silent: false, sampleRate: cur.sampleRate, durationMs: Math.round((samples.length * 1000) / cur.sampleRate), leadMs, stats };
    // 다운로드: 원본 샘플레이트 모노 128kbps MP3 / 보관: 32kHz 모노 64kbps MP3 (MP3 인코더가 없으면 WAV)
    const dl = A.encodeClip(norm, cur.sampleRate, { rate: downloadRate || 0, kbps: 128 });
    const st = A.encodeClip(norm, cur.sampleRate, { rate: storeRate || 32000, kbps: 64 });
    out.download = A.bytesToBase64(dl.bytes); out.downloadFormat = dl.format; out.downloadMime = dl.mime;
    out.store = A.bytesToBase64(st.bytes); out.storeFormat = st.format; out.storeMime = st.mime; out.storeRate = st.rate;
    return out;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.__stcap !== 'req') return;
    if (parentOrigin && e.origin !== parentOrigin) return;
    const d = e.data;
    const run = (p) => p.then((r) => post(Object.assign({ id: d.id }, r)), (err) => post({ id: d.id, ok: false, error: String((err && err.message) || err) }));
    if (d.cmd === 'start') run(start(d));
    else if (d.cmd === 'finish') run(finish(d));
    else if (d.cmd === 'stop') { stop(session); post({ id: d.id, ok: true }); }
    else if (d.cmd === 'ping') post({ id: d.id, ok: true });
  });
  post({ ready: true });
})();
