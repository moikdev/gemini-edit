'use strict';

(async function () {
  const results = [];
  const element = (id) => document.getElementById(id);
  function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
  async function waitFor(fn) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('UI did not reach the expected state: ' + element('error').textContent);
  }
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
  await test('side panel reconnects and displays a captured edit', async () => {
    await waitFor(() => element('connectionStatus').textContent === 'Fixture workspace');
    assert(!element('requestSection').hidden);
    assert(element('filename').textContent === 'example.js');
    assert(element('instruction').textContent === 'Change the greeting');
    assert(!element('insertPrompt').disabled);
    assert(panelFixture.prepared.length === 0, 'Auto-insert preference was ignored.');
  });
  await test('Insert delivers only the captured request and never submits automatically', async () => {
    element('insertPrompt').click();
    await waitFor(() => panelFixture.prepared.length === 1 && !element('sendPrompt').disabled);
    assert(panelFixture.prepared[0].requestId === panelFixture.job.id);
    assert(panelFixture.prepared[0].prompt === panelFixture.job.prompt);
    assert(panelFixture.submitted === 0);
  });
  await test('Send is an explicit action in the chosen Gemini tab', async () => {
    element('sendPrompt').click();
    await waitFor(() => panelFixture.submitted === 1 && !element('refreshReply').disabled);
  });
  await test('a returned code block is rendered as text for review', async () => {
    element('refreshReply').click();
    await waitFor(() => !element('useResponse').disabled);
    assert(element('codePreview').textContent === 'const greeting = "new";\n');
  });
  await test('review stages one matched proposal without an apply request', async () => {
    element('useResponse').click();
    await waitFor(() => panelFixture.proposals.length === 1 && element('requestStatus').textContent === 'review');
    assert(panelFixture.proposals[0].text === 'const greeting = "new";\n');
    assert(element('useResponse').disabled);
    assert(/Accept or reject/.test(element('replyStatus').textContent));
  });
  await test('Gemini follow-ups remain detectable after the previous edit was applied', async () => {
    panelFixture.job.status = 'applied';
    panelFixture.responseKey = 'turn-2';
    panelFixture.responseText = 'const greeting = "follow-up";\n';
    await poll();
    assert(!element('useResponse').disabled, 'An applied request stopped code detection.');
    assert(element('codePreview').textContent === panelFixture.responseText);
    element('useResponse').click();
    await waitFor(() => panelFixture.proposals.length === 2 && element('requestStatus').textContent === 'review');
    assert(panelFixture.proposals[1].sourceJobId === panelFixture.job.id);
    assert(panelFixture.moreJobs.length === 1);
  });
  await test('each accepted browser follow-up becomes the target of the next follow-up', async () => {
    const previous = panelFixture.moreJobs[0];
    previous.status = 'applied';
    panelFixture.responseKey = 'turn-3';
    panelFixture.responseText = 'const greeting = "third";\n';
    await poll();
    assert(!element('useResponse').disabled);
    element('useResponse').click();
    await waitFor(() => panelFixture.proposals.length === 3 && element('requestStatus').textContent === 'review');
    assert(panelFixture.proposals[2].sourceJobId === previous.id);
  });
  await test('a Gemini-only chat shows code even with no editor-originated request', async () => {
    panelFixture.noJobs = true;
    panelFixture.moreJobs = [];
    panelFixture.anchorId = null;
    panelFixture.responseKey = 'plain-chat';
    panelFixture.responseText = 'console.log("browser only");\n';
    await poll();
    assert(element('requestSection').hidden);
    assert(!element('replySection').hidden);
    assert(element('codePreview').textContent === panelFixture.responseText);
    assert(!element('useResponse').disabled);
    element('useResponse').click();
    await waitFor(() => panelFixture.proposals.length === 4 && element('requestStatus').textContent === 'review');
    assert(!panelFixture.proposals[3].sourceJobId, 'An unrelated request was silently used as the target.');
    assert(panelFixture.prepared.length === 1, 'Import sent a new prompt to Gemini.');
    assert(panelFixture.submitted === 1, 'Import sent a new Gemini message.');
  });
  const output = document.createElement('pre');
  output.id = 'test-results';
  output.textContent = JSON.stringify({ results, viewport: { width: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth } });
  output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%';
  document.body.append(output);
})();
