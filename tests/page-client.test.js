'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPageClient } = require('../extensions/chrome/page-client');

function browser(overrides = {}) {
  const calls = { messages: [], injections: 0 };
  return {
    calls,
    tabs: {
      get: async () => ({ id: 7, url: 'https://gemini.google.com/app/chat', status: 'complete' }),
      sendMessage: async (id, payload) => { calls.messages.push(payload); return { ok: true, blocks: [] }; },
      ...overrides
    },
    scripting: { executeScript: async () => { calls.injections++; } }
  };
}
test('a reload is reported without injecting into or mutating a loading document', async () => {
  const chrome = browser({ get: async () => ({ status: 'loading', url: 'https://gemini.google.com/app/chat' }) });
  const client = createPageClient(chrome);
  await assert.rejects(client.request(7, 'prepare'), { code: 'PAGE_LOADING' });
  assert.equal(chrome.calls.messages.length, 0);
  assert.equal(chrome.calls.injections, 0);
});
test('a missing adapter is reattached once and response reading resumes', async () => {
  let count = 0;
  const chrome = browser({ sendMessage: async () => {
    if (++count === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return { ok: true, blocks: [{ text: 'restored code' }] };
  } });
  const result = await createPageClient(chrome).request(7, 'reply');
  assert.equal(result.blocks[0].text, 'restored code');
  assert.equal(chrome.calls.injections, 1);
  assert.equal(count, 2);
});
test('a hung content-script message times out instead of freezing the panel', { timeout: 1000 }, async () => {
  const chrome = browser({ sendMessage: () => new Promise(() => {}) });
  await assert.rejects(createPageClient(chrome, { timeoutMs: 20 }).request(7, 'reply'), { code: 'PAGE_TIMEOUT' });
  assert.equal(chrome.calls.injections, 0);
});
test('a reply from the previous document is discarded after a reload', async () => {
  let finish;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const chrome = browser({ sendMessage: () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
  const client = createPageClient(chrome);
  const pending = client.request(7, 'reply');
  await waiting;
  client.invalidate(7);
  finish({ ok: true, blocks: [{ text: 'obsolete code' }] });
  await assert.rejects(pending, { code: 'PAGE_LOADING' });
  assert.deepEqual((await createPageClient(browser()).request(7, 'reply')).blocks, []);
});
test('Send is never automatically replayed when the page receiver disappears', async () => {
  let sends = 0;
  const chrome = browser({ sendMessage: async () => { sends++; throw new Error('Could not establish connection. Receiving end does not exist.'); } });
  await assert.rejects(createPageClient(chrome).request(7, 'submit'), /Receiving end/);
  assert.equal(sends, 1);
  assert.equal(chrome.calls.injections, 0);
});
test('a timed-out Send explains the uncertain result without retrying', { timeout: 1000 }, async () => {
  let sends = 0;
  const chrome = browser({ sendMessage: () => { sends++; return new Promise(() => {}); } });
  await assert.rejects(createPageClient(chrome, { timeoutMs: 20 }).request(7, 'submit'), /Check Gemini before trying again/);
  assert.equal(sends, 1);
});
test('application errors do not trigger injection or replay', async () => {
  const chrome = browser({ sendMessage: async () => ({ ok: false, code: 'DRAFT_EXISTS', error: 'Your draft was kept.' }) });
  await assert.rejects(createPageClient(chrome).request(7, 'prepare'), { code: 'DRAFT_EXISTS' });
  assert.equal(chrome.calls.injections, 0);
});
