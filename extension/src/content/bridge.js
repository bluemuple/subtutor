/*
 * SubTutor – 웹사이트 브리지 (저장 목록/퀴즈 웹페이지에서 실행)
 * 웹페이지의 window.postMessage 요청을 확장 프로그램 백그라운드로 중계하고, 이벤트를 되돌려 준다.
 */
(() => {
  'use strict';
  if (window.__subtutorBridge) return;
  window.__subtutorBridge = true;
  const version = chrome.runtime.getManifest().version;
  const post = (msg) => { try { window.postMessage(msg, '*'); } catch (e) { /* ignore */ } };
  try { document.documentElement.setAttribute('data-subtutor', version); } catch (e) { /* ignore */ }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__subtutorWeb !== 'req') return;
    const { id, action, payload } = e.data;
    try {
      chrome.runtime.sendMessage({ type: 'web.' + action, payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) post({ __subtutorWeb: 'res', id, ok: false, error: err.message });
        else if (res && res.error) post({ __subtutorWeb: 'res', id, ok: false, error: res.error });
        else post({ __subtutorWeb: 'res', id, ok: true, result: res });
      });
    } catch (err) {
      post({ __subtutorWeb: 'res', id, ok: false, error: '확장 프로그램이 다시 로드되었습니다. 페이지를 새로고침하세요. (' + err.message + ')' });
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'web.event') post({ __subtutorWeb: 'event', event: msg.event, payload: msg.payload });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.items) post({ __subtutorWeb: 'event', event: 'items.changed' });
    if (area === 'local' && changes.words) post({ __subtutorWeb: 'event', event: 'words.changed' });
  });
  const announce = () => post({ __subtutorWeb: 'event', event: 'ready', payload: { version } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
  window.addEventListener('load', announce);
})();
