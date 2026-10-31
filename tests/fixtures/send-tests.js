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
    throw new Error('Send UI did not reach the expected state: ' + element('error').textContent);
  }
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
  function queued(id) {
    const job = { ...panelFixture.job, id, status: 'pending', delivery: null, send: null, sendRequested: true,
      prompt: `[Gemini Edit request: ${id}]\nA new instruction.` };
    panelFixture.moreJobs.push(job);
    return job;
  }
  await test('Enter waits while Gemini is generating without reserving a delivery', async () => {
    await waitFor(() => /still generating/.test(element('error').textContent) && !element('insertPrompt').disabled);
    assert(panelFixture.job.status === 'pending');
    assert(panelFixture.prepared.length === 0 && panelFixture.submitted === 0 && panelFixture.deliveries === 0);
  });
  await test('an Enter-requested prompt inserts and sends once when Gemini becomes ready', async () => {
    panelFixture.geminiBusy = false;
    await poll();
    assert(panelFixture.prepared.length === 1);
    assert(panelFixture.prepared[0].requestId === panelFixture.job.id);
    assert(panelFixture.submitted === 1 && panelFixture.submitAttempts === 1);
    assert(panelFixture.job.send.state === 'sent');
    assert(element('sendPrompt').disabled);
  });
  await test('polling and a page reload do not replay a completed Send', async () => {
    autoAttempts.clear();
    await poll();
    panelFixture.tabStatus = 'loading';
    chrome.tabs.onUpdated.emit(7, { status: 'loading' });
    panelFixture.tabStatus = 'complete';
    chrome.tabs.onUpdated.emit(7, { status: 'complete' });
    await poll();
    assert(panelFixture.submitted === 1 && panelFixture.submitAttempts === 1);
  });
  await test('a subsequent Enter request sends even when an older response has not been imported', async () => {
    const next = queued('44444444-4444-4444-a444-444444444444');
    await poll();
    assert(next.send?.state === 'sent');
    assert(panelFixture.submitted === 2);
    assert(panelFixture.prepared.at(-1).requestId === next.id);
  });
  await test('an unrelated Gemini draft is kept and never submitted by automatic Send', async () => {
    queued('55555555-5555-4555-a555-555555555555');
    panelFixture.draftExists = true;
    await poll();
    assert(/draft was kept/.test(element('error').textContent));
    assert(panelFixture.submitted === 2 && panelFixture.prepared.length === 2);
    panelFixture.draftExists = false;
  });
  await test('a lost Send acknowledgement stays uncertain and is not retried', async () => {
    const uncertain = queued('66666666-6666-4666-a666-666666666666');
    panelFixture.submitFailure = 'port';
    await poll();
    assert(uncertain.send?.state === 'uncertain');
    const attempts = panelFixture.submitAttempts;
    autoAttempts.clear();
    await poll();
    await poll();
    assert(panelFixture.submitAttempts === attempts, 'An uncertain Send was repeated.');
    assert(element('sendPrompt').disabled);
  });
  const output = document.createElement('pre');
  output.id = 'test-results';
  output.textContent = JSON.stringify({ results });
  document.body.append(output);
})();
