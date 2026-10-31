'use strict';

(async function () {
  const results = [];
  const element = (id) => document.getElementById(id);
  const assert = (value, message = 'Assertion failed') => { if (!value) throw new Error(message); };
  async function waitFor(fn) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('UI did not recover: ' + element('error').textContent + ' / ' + element('replyStatus').textContent);
  }
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
  function loading() {
    panelFixture.tabStatus = 'loading';
    chrome.tabs.onUpdated.emit(7, { status: 'loading' });
  }
  function loaded() {
    panelFixture.tabStatus = 'complete';
    chrome.tabs.onUpdated.emit(7, { status: 'complete' });
  }
  await test('a transient tab lookup failure at startup does not stop bridge polling', async () => {
    await waitFor(() => element('connectionStatus').textContent === 'Fixture workspace' && panelFixture.queries >= 2);
    assert(!element('requestSection').hidden);
  });
  await test('an unready Gemini app leaves the request pending and insert remains usable', async () => {
    panelFixture.composerReady = false;
    element('insertPrompt').click();
    await waitFor(() => /not ready/.test(element('error').textContent) && !element('insertPrompt').disabled);
    assert(panelFixture.job.status === 'pending');
    assert(panelFixture.deliveries === 0);
    panelFixture.composerReady = true;
    element('insertPrompt').click();
    await waitFor(() => panelFixture.prepared.length === 1 && !element('insertPrompt').disabled);
  });
  await test('refreshing an unsent draft preserves its request without automatically sending again', async () => {
    loading();
    panelFixture.draftLost = true;
    panelFixture.receiverPresent = false;
    assert(element('sendPrompt').disabled);
    assert(element('useResponse').disabled);
    assert(element('connectionStatus').textContent === 'Fixture workspace');
    assert(element('geminiTab').value === '7');
    loaded();
    element('refreshReply').click();
    await waitFor(() => element('insertPrompt').textContent.includes('Restore') && !element('insertPrompt').disabled);
    assert(panelFixture.injections === 1, 'The new document adapter was not reattached exactly once.');
    assert(panelFixture.submitted === 0);
    element('insertPrompt').click();
    await waitFor(() => panelFixture.prepared.length === 2 && !element('sendPrompt').disabled);
    element('sendPrompt').click();
    await waitFor(() => panelFixture.submitted === 1 && !element('refreshReply').disabled);
  });
  await test('a page reload clears cached code and rejects a late response from the previous document', async () => {
    element('refreshReply').click();
    await waitFor(() => !element('useResponse').disabled);
    panelFixture.hangReply = true;
    element('refreshReply').click();
    await waitFor(() => Boolean(panelFixture.pendingReply));
    loading();
    assert(element('codePreview').textContent === '', 'Old code stayed visible after navigation.');
    assert(element('useResponse').disabled);
    panelFixture.pendingReply({ ok: true, blocks: [{ index: 0, text: 'obsolete document code', size: 22 }] });
    panelFixture.pendingReply = null;
    await waitFor(() => !element('refreshReply').disabled);
    assert(!element('codePreview').textContent.includes('obsolete'));
    loaded();
    element('refreshReply').click();
    await waitFor(() => !element('useResponse').disabled);
    assert(element('codePreview').textContent === 'const greeting = "new";\n');
  });
  await test('a temporarily hidden loading tab is kept instead of switching to another Gemini conversation', async () => {
    loading();
    panelFixture.hideSelected = true;
    element('openGemini').click();
    await waitFor(() => element('geminiTab').options.length === 3);
    assert(element('geminiTab').value === '7', 'The selected chat changed during refresh.');
    assert(panelFixture.submitted === 1, 'Reload replayed a Send action.');
    panelFixture.hideSelected = false;
    loaded();
  });
  const output = document.createElement('pre');
  output.id = 'test-results';
  output.textContent = JSON.stringify({ results });
  document.body.append(output);
})();
