'use strict';

(async function () {
  const api = globalThis.__geminiEditAdapter;
  const id = '11111111-1111-4111-a111-111111111111';
  const other = '22222222-2222-4222-a222-222222222222';
  const prompt = `[Gemini Edit request: ${id}]\n\nRewrite this:\n\n  const a = 1;\n  const b = 2;`;
  const conversation = document.getElementById('conversation');
  const results = [];
  function assert(condition, message = 'Assertion failed') { if (!condition) throw new Error(message); }
  function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
  function throws(fn, expected) {
    try { fn(); } catch (error) { assert(expected.test(error.message), error.message); return; }
    throw new Error('Expected a failure.');
  }
  function user(value) { const node = document.createElement('user-query'); node.textContent = value; conversation.append(node); return node; }
  function response(value) {
    const node = document.createElement('model-response');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-javascript';
    code.textContent = value;
    pre.append(code); node.append(pre); conversation.append(node); return node;
  }

  test('finds the Gemini rich text composer', () => assert(api.composer()?.classList.contains('ql-editor')));
  test('fills a multiline prompt without losing indentation', () => {
    api.fillPrompt(id, prompt);
    assert(api.draftText() === prompt, 'Multiline input changed.');
    assert(api.fillPrompt(id, prompt).alreadyFilled, 'A retry should be idempotent.');
  });
  test('preserves a draft belonging to the user', () => {
    api.composer().textContent = 'My unsent draft';
    throws(() => api.fillPrompt(id, prompt), /already contains a draft/);
    assert(api.composer().textContent === 'My unsent draft');
    api.composer().textContent = '';
  });
  test('submits only the exact captured draft, once per explicit click', () => {
    let clicked = 0;
    const button = document.querySelector('.send-button');
    const handler = () => clicked++;
    button.addEventListener('click', handler);
    api.fillPrompt(id, prompt);
    api.submitPrompt(id, prompt);
    assert(clicked === 1);
    throws(() => api.submitPrompt(id, prompt), /already sent/);
    assert(clicked === 1, 'The same exact draft must not be submitted twice.');
    api.composer().textContent = 'A changed draft';
    throws(() => api.submitPrompt(id, prompt), /draft changed/);
    assert(clicked === 1);
    api.composer().textContent = '';
    button.removeEventListener('click', handler);
  });
  test('does not import code from an older conversation turn', () => {
    user('Earlier question'); response('old and unrelated');
    assert(!api.replyFor(id).found);
    user(prompt);
    assert(!api.replyFor(id).found);
  });
  test('matches the request marker and preserves code whitespace and HTML-like text', () => {
    response('  const html = "<script>safe text</script>";\n\n');
    const reply = api.replyFor(id);
    assert(reply.found && reply.blocks.length === 1);
    assert(reply.blocks[0].text === '  const html = "<script>safe text</script>";\n\n');
    assert(reply.blocks[0].language === 'javascript');
  });
  test('refuses to send a captured request again after it appears in the conversation', () => throws(() => api.fillPrompt(id, prompt), /already sent/));
  test('waits for generation to finish before exposing code', () => {
    const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop response'); document.body.append(stop);
    assert(api.replyFor(id).busy && !api.replyFor(id).blocks.length);
    stop.remove();
  });
  test('follows a refinement in the same chat, waiting for its own response', () => {
    user('Make that shorter');
    assert(!api.replyFor(id).found);
    response('refined code');
    assert(api.replyFor(id).blocks[0].text === 'refined code');
  });
  test('keeps different captured requests separate', () => {
    user(`[Gemini Edit request: ${other}]\nDifferent file`); response('another request');
    assert(api.replyFor(id).blocks[0].text === 'refined code');
    assert(api.replyFor(other).blocks[0].text === 'another request');
  });
  test('does not silently truncate oversized code blocks', () => {
    user('Return a larger version'); response('x'.repeat(262145));
    const reply = api.replyFor(other);
    assert(reply.blocks[0].oversized && reply.blocks[0].text === '');
  });
  test('a missing unsent draft after refresh can be restored without resubmission', () => {
    const fresh = '33333333-3333-4333-a333-333333333333';
    api.composer().textContent = '';
    const lost = api.replyFor(fresh);
    assert(!lost.found && lost.canRestore && /refresh/i.test(lost.message));
    api.composer().textContent = 'A different draft';
    assert(!api.replyFor(fresh).canRestore);
    assert(api.composer().textContent === 'A different draft');
    api.composer().textContent = '';
  });
  test('restored conversation DOM is sufficient to reconnect a sent request', () => {
    const saved = conversation.cloneNode(true);
    conversation.replaceChildren(...saved.childNodes);
    assert(api.replyFor(id).blocks[0].text === 'refined code');
  });
  test('keeps messages from other extensions out of the adapter', () => {
    let replied = false;
    globalThis.messageListener({ source: 'gemini-edit', type: 'ping' }, { id: 'different' }, () => replied = true);
    assert(!replied);
    globalThis.messageListener({ source: 'gemini-edit', type: 'ping' }, { id: 'test-extension' }, (value) => { replied = value.ok; });
    assert(replied);
  });
  test('latest code is detected in a chat started directly in Gemini without a request marker', () => {
    conversation.replaceChildren();
    user('Write a simple loop'); response('for (let i = 0; i < 5; i++) {}');
    const reply = api.replyFor();
    assert(reply.blocks[0].text === 'for (let i = 0; i < 5; i++) {}');
    assert(reply.anchorId === null);
    assert(Boolean(reply.responseKey));
    const previousKey = reply.responseKey;
    user('Keep the same code, explain it'); response('for (let i = 0; i < 5; i++) {}');
    assert(api.replyFor().responseKey !== previousKey, 'A new turn must have its own response identity.');
  });
  test('a direct Gemini follow-up never falls back to code from the preceding answer', () => {
    user('Make the loop shorter');
    assert(!api.replyFor().found);
    response('for (;;) break;');
    assert(api.replyFor().blocks[0].text === 'for (;;) break;');
  });
  try {
    const readyId = '77777777-7777-4777-a777-777777777777';
    const readyPrompt = `[Gemini Edit request: ${readyId}]\nSend after the composer enables its button.`;
    const button = document.querySelector('.send-button');
    let clicked = 0;
    button.addEventListener('click', () => clicked++);
    api.fillPrompt(readyId, readyPrompt);
    button.disabled = true;
    setTimeout(() => { button.disabled = false; }, 50);
    const result = await new Promise((resolve) => {
      const keepAlive = globalThis.messageListener({ source: 'gemini-edit', type: 'submit', requestId: readyId, prompt: readyPrompt }, { id: 'test-extension' }, resolve);
      assert(keepAlive === true, 'The asynchronous message channel must stay open.');
    });
    assert(result.ok && result.submitted && clicked === 1, 'The delayed Send button was not clicked exactly once.');
    results.push({ name: 'automatic Send waits briefly for Gemini’s button to become enabled', ok: true });
  } catch (error) { results.push({ name: 'automatic Send waits briefly for Gemini’s button to become enabled', ok: false, error: error.message }); }
  document.getElementById('test-results').textContent = JSON.stringify({ results });
})();
