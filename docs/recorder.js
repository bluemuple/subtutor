/* SubTutor 녹음: IndexedDB 저장(자막당 최대 3개, 오래된 것부터 삭제) + MediaRecorder */
window.SubTutorRecorder = (() => {
  'use strict';
  const DB = 'subtutor-recordings';
  const STORE = 'recordings';
  const MAX = 3;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('itemId', 'itemId', { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function list(itemId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('itemId').getAll(itemId);
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
    });
  }
  async function listAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function add(itemId, blob, durationMs) {
    const existing = await list(itemId);
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const overflow = Math.max(0, existing.length + 1 - MAX);
      existing.slice(0, overflow).forEach((r) => s.delete(r.id));
      s.add({ itemId, blob, mime: blob.type, durationMs, createdAt: Date.now() });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    return list(itemId);
  }
  async function remove(id) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  async function clearItem(itemId) {
    const recs = await list(itemId);
    for (const r of recs) await remove(r.id);
  }
  async function clearAll() {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  let stream = null;
  async function getStream() {
    if (stream && stream.active) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return stream;
  }
  async function start() {
    const s = await getStream();
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const t0 = Date.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })); });
    rec.start(250);
    return {
      stop: async () => {
        if (rec.state !== 'inactive') rec.stop();
        const blob = await done;
        return { blob, durationMs: Date.now() - t0 };
      },
      get state() { return rec.state; },
    };
  }

  let currentAudio = null;
  function stop() {
    if (currentAudio) { try { currentAudio.pause(); } catch (e) { /* ignore */ } currentAudio = null; }
  }
  function play(blob) {
    return new Promise((resolve) => {
      stop();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      currentAudio = a;
      const finish = () => { URL.revokeObjectURL(url); if (currentAudio === a) currentAudio = null; resolve(); };
      a.onended = finish;
      a.onerror = finish;
      a.onpause = () => { if (a.ended) return; if (currentAudio !== a) finish(); };
      a.play().catch(finish);
    });
  }
  return { list, listAll, add, remove, clearItem, clearAll, start, play, stop, MAX };
})();
