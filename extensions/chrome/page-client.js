'use strict';

(function (root) {
  const { isGeminiUrl } = typeof module !== 'undefined' ? require('./protocol') : root.GeminiEditProtocol;
  function pageError(code, message) { return Object.assign(new Error(message), { code }); }

  function createPageClient(browser, { timeoutMs = 4000 } = {}) {
    const epochs = new Map();
    const injections = new Map();
    const epoch = (id) => epochs.get(id) || 0;
    const invalidate = (id) => epochs.set(id, epoch(id) + 1);
    function timed(operation) {
      let timer;
      return Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(pageError('PAGE_TIMEOUT', 'Gemini’s page connection timed out. Wait for the page to finish loading, then try again.')), timeoutMs); })
      ]).finally(() => clearTimeout(timer));
    }
    const getTab = (id) => timed(() => browser.tabs.get(id));
    async function request(tabId, type, data = {}) {
      const captured = epoch(tabId);
      const checkNavigation = () => {
        if (epoch(tabId) !== captured) throw pageError('PAGE_LOADING', 'Gemini reloaded during this operation. Waiting for its new page connection.');
      };
      try {
        const tab = await getTab(tabId);
        checkNavigation();
        if (tab.status === 'loading') throw pageError('PAGE_LOADING', 'Gemini is reloading. Its page connection will recover automatically.');
        if (!isGeminiUrl(tab.url)) throw pageError('WRONG_PAGE', 'The connected tab is no longer on Gemini.');
        const payload = { source: 'gemini-edit', type, ...data };
        const send = () => timed(() => browser.tabs.sendMessage(tabId, payload));
        let response;
        try { response = await send(); }
        catch (error) {
          checkNavigation();
          // A Send action might already have reached the website. Never replay
          // it on a timeout, navigation, or closed message port.
          const missingReceiver = /receiving end does not exist|could not establish connection/i.test(error.message);
          if (type === 'submit' || !missingReceiver) throw error;
          if (!injections.has(tabId)) {
            const injection = timed(() => browser.scripting.executeScript({ target: { tabId }, files: ['gemini-adapter.js'] }));
            injections.set(tabId, injection);
            void injection.finally(() => { if (injections.get(tabId) === injection) injections.delete(tabId); }).catch(() => {});
          }
          await injections.get(tabId);
          checkNavigation();
          response = await send();
        }
        checkNavigation();
        if (!response?.ok) throw pageError(response?.code || 'PAGE_ERROR', response?.error || 'Gemini’s page adapter is unavailable. Wait for the page to load, then try again.');
        return response;
      } catch (error) {
        if (type === 'submit' && ['PAGE_TIMEOUT', 'PAGE_LOADING'].includes(error.code)) {
          throw pageError(error.code, 'Sending was interrupted by a reload or lost connection. Check Gemini before trying again; this extension has not retried Send.');
        }
        throw error;
      }
    }
    return { request, getTab, invalidate };
  }
  root.GeminiEditPageClient = { createPageClient };
  if (typeof module !== 'undefined') module.exports = { createPageClient };
})(globalThis);
