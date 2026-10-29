/* SubTutor 웹 ↔ 확장 프로그램 브리지 클라이언트 */
window.SubTutorBridge = (() => {
  'use strict';
  let reqId = 0;
  const pending = new Map();
  const listeners = new Map();
  let ready = false;
  let version = null;
  const readyResolvers = [];

  function emit(ev, payload) {
    (listeners.get(ev) || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
    (listeners.get('*') || []).forEach((fn) => { try { fn(ev, payload); } catch (e) { console.error(e); } });
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__subtutorWeb) return;
    const d = e.data;
    if (d.__subtutorWeb === 'res') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error || '알 수 없는 오류'));
    } else if (d.__subtutorWeb === 'event') {
      if (d.event === 'ready') {
        ready = true;
        version = (d.payload && d.payload.version) || version;
        readyResolvers.splice(0).forEach((r) => r(true));
      }
      emit(d.event, d.payload);
    }
  });
  function detect() { return ready || !!document.documentElement.getAttribute('data-subtutor'); }
  function request(action, payload, timeout) {
    return new Promise((resolve, reject) => {
      if (!detect()) { reject(new Error('SubTutor 확장 프로그램이 감지되지 않았습니다')); return; }
      const id = ++reqId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('응답 시간 초과: ' + action)); }, timeout || 60000);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ __subtutorWeb: 'req', id, action, payload: payload || {} }, '*');
    });
  }
  function waitReady(ms) {
    if (detect()) return Promise.resolve(true);
    return new Promise((r) => { readyResolvers.push(r); setTimeout(() => r(detect()), ms || 1500); });
  }
  return {
    request, waitReady, detect,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
    get version() { return version || document.documentElement.getAttribute('data-subtutor'); },
  };
})();
