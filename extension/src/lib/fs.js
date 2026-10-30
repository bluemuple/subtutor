/*
 * SubTutor – 오디오 저장 폴더 (File System Access API)
 * 사용자가 고른 폴더 핸들을 확장 프로그램 원본(origin)의 IndexedDB 에 보관하고, 서비스 워커/팝업/설정 페이지가 함께 쓴다.
 * 일반 스크립트와 모듈(서비스 워커) 양쪽에서 쓰도록 globalThis 에 붙인다.
 */
globalThis.SubTutorFS = (() => {
  'use strict';
  const DB = 'subtutor-fs', STORE = 'handles', KEY = 'audioDir';
  const ROOT_DIR = 'SubTutor'; // 고른 폴더 안에 만드는 상위 폴더 (그 아래 작품/에피소드 폴더)

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 열기 실패'));
    });
  }
  async function getHandle() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        q.onsuccess = () => resolve(q.result || null);
        q.onerror = () => reject(q.error);
      });
    } finally { db.close(); }
  }
  async function setHandle(handle) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        if (handle) tx.objectStore(STORE).put(handle, KEY); else tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  // { state: 'none' | 'granted' | 'prompt' | 'denied', name, handle }
  async function status() {
    let handle = null;
    try { handle = await getHandle(); } catch (e) { return { state: 'none', error: String(e && e.message || e) }; }
    if (!handle) return { state: 'none' };
    let state = 'prompt';
    try { state = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { state = 'prompt'; }
    return { state, name: handle.name, handle };
  }
  // 창(팝업/설정 페이지)에서만: 사용자 클릭 안에서 호출해야 크롬이 허용 창을 띄운다
  async function requestPermission() {
    const handle = await getHandle();
    if (!handle) return 'none';
    try { return await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { return 'prompt'; }
  }
  async function pick() {
    if (typeof showDirectoryPicker !== 'function') throw new Error('이 브라우저는 폴더 선택을 지원하지 않습니다');
    const handle = await showDirectoryPicker({ id: 'subtutor-audio', mode: 'readwrite', startIn: 'documents' });
    await setHandle(handle);
    return handle;
  }
  async function clear() { await setHandle(null); }

  // relPath 예: 'SubTutor/작품 S1:E2/00-01-02 text.mp3' (구분자 '/'). 같은 이름이 있으면 덮어쓴다.
  async function writeFile(relPath, bytes) {
    const st = await status();
    if (st.state !== 'granted') return { ok: false, reason: st.state, name: st.name || '' };
    const parts = String(relPath).split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..');
    if (!parts.length) return { ok: false, reason: 'error', error: '파일 이름이 비었습니다', name: st.name };
    try {
      let dir = st.handle;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      return { ok: true, name: st.name, path: st.name + '/' + parts.join('/') };
    } catch (e) {
      const name = e && e.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return { ok: false, reason: 'prompt', name: st.name, error: String(e.message || e) };
      return { ok: false, reason: 'error', name: st.name, error: String((e && e.message) || e) };
    }
  }
  // 저장 때 기록한 경로('<폴더 이름>/SubTutor/작품/파일.mp3')를 지금 고른 폴더 기준의 부분 배열로. 폴더 이름이 달라졌어도 SubTutor/ 아래 구조는 같다
  function partsFromRecorded(path, rootName) {
    const parts = String(path || '').split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..');
    if (parts.length < 2) return null;
    if (rootName && parts[0] === rootName) return parts.slice(1);
    const i = parts.indexOf(ROOT_DIR);
    return i >= 0 && i < parts.length - 1 ? parts.slice(i) : null;
  }
  function fsError(e, name) {
    const n = e && e.name;
    if (n === 'NotFoundError') return { ok: false, reason: 'missing', name };
    if (n === 'NotAllowedError' || n === 'SecurityError') return { ok: false, reason: 'prompt', name, error: String((e && e.message) || e) };
    return { ok: false, reason: 'error', name, error: String((e && e.message) || e) };
  }
  // 기록된 경로의 파일을 읽는다 → { ok, bytes(Uint8Array), name, path, size }
  async function readFile(recordedPath) {
    const st = await status();
    if (st.state === 'none') return { ok: false, reason: 'none' };
    if (st.state !== 'granted') return { ok: false, reason: st.state, name: st.name || '' };
    const parts = partsFromRecorded(recordedPath, st.name);
    if (!parts) return { ok: false, reason: 'other-folder', name: st.name };
    try {
      let dir = st.handle;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
      return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()), name: st.name, path: st.name + '/' + parts.join('/'), size: file.size };
    } catch (e) { return fsError(e, st.name); }
  }
  // 기록된 경로의 파일을 지우고, 비게 된 작품 폴더도 지운다 (SubTutor 폴더 자체는 남긴다)
  async function removeFile(recordedPath) {
    const st = await status();
    if (st.state === 'none') return { ok: false, reason: 'none' };
    if (st.state !== 'granted') return { ok: false, reason: st.state, name: st.name || '' };
    const parts = partsFromRecorded(recordedPath, st.name);
    if (!parts) return { ok: false, reason: 'other-folder', name: st.name };
    try {
      const dirs = [st.handle]; // dirs[k] = parts[k-1] 폴더
      for (const part of parts.slice(0, -1)) dirs.push(await dirs[dirs.length - 1].getDirectoryHandle(part));
      await dirs[dirs.length - 1].removeEntry(parts[parts.length - 1]);
      for (let i = dirs.length - 1; i >= 2; i--) {
        const first = await dirs[i].entries().next();
        if (!first.done) break;
        await dirs[i - 1].removeEntry(parts[i - 1]);
      }
      return { ok: true, name: st.name };
    } catch (e) { return fsError(e, st.name); }
  }
  return { ROOT_DIR, getHandle, setHandle, status, requestPermission, pick, clear, writeFile, readFile, removeFile, partsFromRecorded };
})();
