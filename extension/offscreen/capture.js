/*
 * SubTutor – 탭 오디오 캡처 (offscreen 문서)
 * 서비스 워커가 chrome.runtime 메시지({target:'offscreen', cmd})로 명령한다.
 *   start {streamId, limitMs, test}    → 탭 오디오 스트림을 열고 PCM 을 벽시계에 맞춰 모은다. 들리는 소리는 이 문서의 스피커 출력으로 통과시킨다
 *   finish {startMs, endMs, anchors}   → (벽시계ms, 미디어ms) 쌍으로 미디어 구간을 벽시계 구간으로 바꿔 잘라내고 MP3(base64)로 돌려준다
 *   stop                                → 캡처 종료
 *   recStart {streamId, test}          → 영상 오디오 통째 녹음: PCM 이 오는 대로 64kbps 모노 MP3 로 눌러 담는다 (메모리를 아낌)
 *   recBeat {paused}                   → 플레이어 탭의 심장박동. 15초 끊기면 알아서 저장하고 끝낸다. paused 동안의 소리는 건너뛴다
 *   recStop / recPing                  → 통째 녹음 저장(조각을 rec.part 로 서비스 워커에 보냄) / 녹음 중인지
 * 왜 offscreen 인가: 캡처한 소리를 캡처되는 탭 안(iframe)에서 다시 틀면 그 출력이 다시 캡처되어 되먹임(짧은 구간이 반복·증폭)이 생긴다.
 * 이 문서는 탭 바깥이라 안전하게 들려줄 수 있다.
 */
(() => {
  'use strict';
  const A = globalThis.SubTutorAudio;
  const PAD_MS = 250;
  let session = null;
  const nowWall = () => performance.timeOrigin + performance.now();

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
    if (recSess && recSess.tap === cur) recSess.tap = null;
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
    cur.lastChunkWall = nowWall();
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

  async function start({ streamId, limitMs, test }) {
    if (session) stop(session);
    if (recSess && !recSess.finishing && test !== 'sweep') {
      // 통째 녹음이 이 탭을 이미 캡처 중 — 크롬은 한 탭을 두 번 캡처하지 못하므로 같은 PCM 을 나눠 받는다
      const tap = { stream: null, reader: null, ctx: null, source: null, processor: null, chunks: [], sampleRate: 0, originMs: null, tsBaseUs: NaN, nextFrame: 0, lastChunkWall: 0, timer: null, waiter: null, stats: { chunks: 0, frames: 0, gaps: 0, gapFrames: 0, errors: 0, format: '', source: 'rec-tap' } };
      session = tap;
      recSess.tap = tap;
      tap.timer = setTimeout(() => stop(tap), Math.min(120000, limitMs || 60000));
      return { ok: true, padMs: PAD_MS, startedAt: nowWall(), shared: true };
    }
    const cur = { stream: null, reader: null, ctx: null, source: null, processor: null, chunks: [], sampleRate: 0, originMs: null, tsBaseUs: NaN, nextFrame: 0, lastChunkWall: 0, timer: null, waiter: null, stats: { chunks: 0, frames: 0, gaps: 0, gapFrames: 0, errors: 0, format: '', source: test === 'sweep' ? 'sweep' : 'tab' } };
    session = cur;
    try {
      if (test === 'sweep') {
        cur.stream = sweepStream(cur);
      } else {
        if (!streamId) throw new Error('탭 오디오 스트림 ID 가 없습니다');
        cur.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
        // 탭이 캡처되는 동안 크롬은 탭의 소리를 내지 않으므로, 여기(탭 바깥)서 스피커로 통과시킨다 — 되먹임 없음
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
    // 조각이 도착한 벽시계로 실제 샘플레이트를 재서, 스트림이 알려 준 값과 3% 넘게 다르면(예: 44.1kHz 데이터가 48kHz 로 표시) 그 값을 쓴다
    const wallSpan = cur.lastChunkWall && cur.originMs !== null ? (cur.lastChunkWall - cur.originMs) / 1000 : 0;
    const effRate = wallSpan > 0.8 ? Math.round(cur.nextFrame / wallSpan) : 0;
    const standard = [8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
    if (effRate && Math.abs(effRate - cur.sampleRate) / cur.sampleRate > 0.03) {
      const near = standard.reduce((a, b) => (Math.abs(b - effRate) < Math.abs(a - effRate) ? b : a), standard[0]);
      if (Math.abs(near - effRate) / near < 0.02) { cur.stats.claimedRate = cur.sampleRate; cur.sampleRate = near; }
    }
    const stats = Object.assign({}, cur.stats, { sampleRate: cur.sampleRate, effRate, recordedMs: Math.round((cur.nextFrame * 1000) / (cur.sampleRate || 1)) });
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
    out.download = A.bytesToBase64(dl.bytes); out.downloadFormat = dl.format; out.downloadMime = dl.mime; out.downloadRate = dl.rate;
    out.store = A.bytesToBase64(st.bytes); out.storeFormat = st.format; out.storeMime = st.mime; out.storeRate = st.rate;
    return out;
  }

  // ── 영상 오디오 통째 녹음: 문장 캡처(session)와 별개의 recSess 하나 ──
  // PCM 이 오는 대로 64kbps 모노 MP3 로 바로 눌러 담아(1시간 ≈ 28MB) 몇 시간짜리도 메모리가 터지지 않는다.
  // 플레이어가 멈춘 동안(심장박동 paused)의 소리와 3초 넘는 공백은 이어 붙인다 — 멈춘 시간이 파일에 들어가지 않는다.
  let recSess = null;
  function recClose(cur) {
    if (!cur) return;
    cur.closed = true;
    clearInterval(cur.watch);
    try { if (cur.reader) cur.reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
    try { if (cur.processor) cur.processor.disconnect(); } catch (e) { /* ignore */ }
    try { if (cur.source) cur.source.disconnect(); } catch (e) { /* ignore */ }
    if (cur.osc) { try { cur.osc.stop(); } catch (e) { /* ignore */ } }
    try { if (cur.ctx) cur.ctx.close(); } catch (e) { /* ignore */ }
    if (cur.stream) for (const t of cur.stream.getTracks()) t.stop();
    if (cur.tap) stop(cur.tap);
    if (recSess === cur) recSess = null;
  }
  function recPush(cur, samples, sampleRate, timestampUs) {
    if (!cur.sampleRate) {
      cur.sampleRate = sampleRate;
      try { cur.enc = new (globalThis.lamejs).Mp3Encoder(1, sampleRate, 64); }
      catch (e) { cur.stats.lastError = 'MP3 인코더: ' + ((e && e.message) || e); return; }
    }
    if (sampleRate !== cur.sampleRate || !cur.enc) return;
    if (!Number.isFinite(cur.tsBase) && Number.isFinite(timestampUs)) cur.tsBase = timestampUs;
    let start = cur.nextFrame;
    if (Number.isFinite(timestampUs) && Number.isFinite(cur.tsBase)) {
      const byTs = Math.round(((timestampUs - cur.tsBase) / 1000) * sampleRate / 1000);
      if (byTs - start > sampleRate * 0.05) start = byTs;
    }
    cur.nextFrame = start + samples.length;
    cur.stats.chunks++;
    if (cur.paused) { cur.encFrame = cur.nextFrame; cur.skippedFrames += samples.length; return; }   // 멈춘 동안은 담지 않는다
    const gap = start - cur.encFrame;
    if (gap > 0 && gap <= sampleRate * 3) {           // 짧은 공백은 무음으로 채워 박자를 지키고,
      const quiet = cur.enc.encodeBuffer(new Int16Array(gap));
      if (quiet.length) { cur.mp3parts.push(new Uint8Array(quiet)); cur.bytes += quiet.length; }
      cur.encodedFrames += gap;
    } else if (gap > 0) { cur.skippedFrames += gap; } // 긴 공백(멈춤·탐색)은 이어 붙인다
    const b = cur.enc.encodeBuffer(A.floatToInt16(samples));
    if (b.length) { cur.mp3parts.push(new Uint8Array(b)); cur.bytes += b.length; }
    cur.encFrame = cur.nextFrame;
    cur.encodedFrames += samples.length;
  }
  function recReadLoop(cur) {
    return cur.reader.read().then(({ done, value }) => {
      if (done || cur.closed) { if (value) { try { value.close(); } catch (e) { /* ignore */ } } return; }
      try {
        const mono = monoFromAudioData(value, cur.stats);
        recPush(cur, mono, value.sampleRate, value.timestamp);
        if (cur.tap) pushChunk(cur.tap, mono, value.sampleRate, value.timestamp);   // 문장 캡처가 같은 PCM 을 나눠 받는다
      } catch (e) { cur.stats.errors++; cur.stats.lastError = String((e && e.message) || e); }
      finally { try { value.close(); } catch (e) { /* ignore */ } }
      return recReadLoop(cur);
    }).catch((e) => { cur.stats.readError = String((e && e.message) || e); });
  }
  async function recStart({ streamId, test }) {
    if (recSess && !recSess.finishing) throw new Error('이미 영상 오디오를 녹음하고 있습니다');
    if (session) throw new Error('대사 오디오 녹음이 끝난 뒤 다시 눌러 주세요');
    const cur = { rec: true, closed: false, finishing: false, stream: null, reader: null, ctx: null, source: null, processor: null, osc: null, tap: null,
      sampleRate: 0, tsBase: NaN, nextFrame: 0, encFrame: 0, encodedFrames: 0, skippedFrames: 0,
      enc: null, mp3parts: [], bytes: 0, paused: false, lastBeat: nowWall(), watch: null,
      stats: { chunks: 0, errors: 0, format: '', source: test === 'sweep' ? 'sweep' : 'tab' } };
    recSess = cur;
    try {
      if (test === 'sweep') {
        cur.stream = sweepStream(cur);
      } else {
        if (!streamId) throw new Error('탭 오디오 스트림 ID 가 없습니다');
        cur.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
        try {
          cur.ctx = new AudioContext();
          cur.source = cur.ctx.createMediaStreamSource(cur.stream);
          cur.source.connect(cur.ctx.destination);   // 캡처되는 동안 크롬이 탭 소리를 끄므로 여기서 들려준다
          if (cur.ctx.state === 'suspended') cur.ctx.resume().catch(() => {});
        } catch (e) { /* ignore */ }
      }
      const [track] = cur.stream.getAudioTracks();
      if (!track) throw new Error('오디오 트랙이 없습니다');
      if (typeof MediaStreamTrackProcessor === 'function') {
        cur.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        recReadLoop(cur);
      } else {
        if (!cur.ctx) cur.ctx = new AudioContext();
        if (!cur.source) cur.source = cur.ctx.createMediaStreamSource(cur.stream);
        const proc = cur.ctx.createScriptProcessor(4096, 2, 1);
        cur.processor = proc;
        proc.onaudioprocess = (e) => {
          const ib = e.inputBuffer;
          const mono = new Float32Array(ib.length);
          for (let ch = 0; ch < ib.numberOfChannels; ch++) { const d = ib.getChannelData(ch); for (let i = 0; i < mono.length; i++) mono[i] += d[i] / ib.numberOfChannels; }
          recPush(cur, mono, ib.sampleRate, NaN);
          if (cur.tap) pushChunk(cur.tap, mono, ib.sampleRate, NaN);
        };
        cur.source.connect(proc);
        proc.connect(cur.ctx.destination);
      }
      // 심장박동이 15초 끊기면(탭을 닫음·떠남) 알아서 저장하고 끝낸다. 60MB(약 2시간)를 넘어도 끊어 저장한다
      cur.watch = setInterval(() => {
        if (nowWall() - cur.lastBeat > 15000) recAutoFinish(cur, 'no-beat');
        else if (cur.bytes > 60 * 1024 * 1024) recAutoFinish(cur, 'cap');
      }, 5000);
      return { ok: true, startedAt: nowWall() };
    } catch (err) {
      recClose(cur);
      throw err;
    }
  }
  async function recFinish(cur, reason) {
    if (!cur || cur.finishing) return null;
    cur.finishing = true;
    const enc = cur.enc;
    recClose(cur);
    if (enc) {
      const end = enc.flush();
      if (end.length) { cur.mp3parts.push(new Uint8Array(end)); cur.bytes += end.length; }
    }
    const durMs = Math.round(((cur.encodedFrames || 0) * 1000) / (cur.sampleRate || 48000));
    const total = cur.mp3parts.reduce((a, x) => a + x.length, 0);
    if (!total || durMs < 1000) return { ok: false, error: '담긴 오디오가 너무 짧습니다 (' + durMs + 'ms) — 영상이 재생되는 동안 담깁니다' };
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const x of cur.mp3parts) { bytes.set(x, off); off += x.length; }
    cur.mp3parts = [];
    // 6MB(3의 배수 — base64 조각을 그대로 이어 붙일 수 있다)씩 서비스 워커로 보낸다: 한 시간짜리도 메시지 크기 제한에 안 걸린다
    const SLICE = 6 * 1024 * 1024;
    const recId = 'rec' + Math.floor(Math.random() * 1e9).toString(36);
    for (let o = 0, seq = 0; o < bytes.length; o += SLICE, seq++) {
      await chrome.runtime.sendMessage({ type: 'rec.part', recId, seq, data: A.bytesToBase64(bytes.subarray(o, o + SLICE)) });
    }
    return { ok: true, recId, bytes: bytes.length, durMs,
      skippedMs: Math.round(((cur.skippedFrames || 0) * 1000) / (cur.sampleRate || 48000)), reason, stats: cur.stats };
  }
  function recAutoFinish(cur, reason) {
    recFinish(cur, reason)
      .then((meta) => { if (meta) return chrome.runtime.sendMessage({ type: 'rec.auto', meta }); })
      .catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return false;
    const run = (p) => p.then((r) => sendResponse(r), (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    if (msg.cmd === 'start') run(start(msg));
    else if (msg.cmd === 'finish') run(finish(msg));
    else if (msg.cmd === 'stop') { stop(session); sendResponse({ ok: true }); }
    else if (msg.cmd === 'ping') sendResponse({ ok: true, recording: !!session });
    else if (msg.cmd === 'recStart') run(recStart(msg));
    else if (msg.cmd === 'recBeat') { if (recSess && !recSess.finishing) { recSess.lastBeat = nowWall(); recSess.paused = !!msg.paused; } sendResponse({ ok: true, recording: !!recSess && !recSess.finishing }); }
    else if (msg.cmd === 'recStop') run(recFinish(recSess, 'user').then((m) => m || { ok: false, error: '영상 오디오를 녹음하고 있지 않습니다' }));
    else if (msg.cmd === 'recPing') sendResponse({ ok: true, recording: !!recSess && !recSess.finishing });
    else return false;
    return true;
  });
})();
