'use strict';

// All Gemini DOM assumptions live here. No cookies, private endpoints, or page
// JavaScript globals are accessed. This script runs in Chrome's isolated world.
(function () {
  if (globalThis.__geminiEditAdapter) return;
  const MAX_TEXT = 256 * 1024;
  const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const submittedRequests = new Set();
  const sendError = (code, message) => Object.assign(new Error(message), { code });
  const bytes = (text) => new TextEncoder().encode(text).length;
  const marker = (id) => `[Gemini Edit request: ${id}]`;
  const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[aria-hidden="true"]'));
  function text(element) {
    if (!element) return '';
    // innerText adds spurious blank lines for contenteditable DIVs in Chrome.
    // Quill / contenteditable paragraphs represent one line each, including
    // empty paragraphs containing a sentinel BR.
    const serialize = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.data;
      if (node.nodeName === 'BR') return '\n';
      if (node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') return '';
      const lines = [];
      let inline = '';
      for (const child of node.childNodes) {
        if (['DIV', 'P', 'LI'].includes(child.nodeName)) {
          if (inline) { lines.push(inline); inline = ''; }
          lines.push(serialize(child));
        } else inline += serialize(child);
      }
      if (inline) lines.push(inline);
      return lines.join('\n');
    };
    return serialize(element).replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');
  }

  function composer() {
    const selectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '.ql-editor[contenteditable="true"]',
      'textarea[placeholder]'
    ];
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
      if (found) return found;
    }
    return null;
  }

  function generating() {
    return [...document.querySelectorAll('button[aria-label*="stop" i], button[data-test-id="stop-button"], button.stop, .send-button.stop, model-response[aria-busy="true"]')].some(visible);
  }

  function fillPrompt(requestId, prompt) {
    if (!REQUEST_ID.test(requestId) || typeof prompt !== 'string' || bytes(prompt) > MAX_TEXT || !prompt.startsWith(marker(requestId))) throw new Error('Invalid edit request.');
    if (submittedRequests.has(requestId) || nodes('user-query', '.user-query-container, [data-message-author-role="user"]').some((element) => (element.textContent || '').includes(marker(requestId)))) throw new Error('This request was already sent. Use its response, or capture a new edit in VS Code.');
    if (generating()) throw new Error('Gemini is still generating. Wait for it to finish.');
    const editor = composer();
    if (!editor) throw new Error('Cannot find Gemini’s message box. Sign in, open a chat, and try again. Gemini may have changed its page layout.');
    const current = editor instanceof HTMLTextAreaElement ? editor.value : text(editor);
    if (current.trim() && current !== prompt) throw new Error('Gemini’s message box already contains a draft. Send or clear it first; your draft was kept.');
    if (current === prompt) return { url: location.href, alreadyFilled: true };
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, prompt);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      // insertText lets rich text editors observe their normal editing events.
      const inserted = document.execCommand('insertText', false, prompt);
      if (!inserted) {
        editor.textContent = prompt;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      }
    }
    const result = editor instanceof HTMLTextAreaElement ? editor.value : text(editor);
    if (result.replace(/\n$/, '') !== prompt.replace(/\n$/, '')) throw new Error('Gemini did not accept the complete prompt. Check the message box before sending.');
    return { url: location.href, alreadyFilled: false };
  }

  function submitPrompt(requestId, prompt) {
    if (!REQUEST_ID.test(requestId) || typeof prompt !== 'string' || !prompt.startsWith(marker(requestId))) throw new Error('Invalid edit request.');
    const editor = composer();
    const current = editor instanceof HTMLTextAreaElement ? editor.value : text(editor);
    if (!editor || current.replace(/\n$/, '') !== prompt.replace(/\n$/, '')) throw sendError('DRAFT_CHANGED', 'The draft changed or was already sent. Insert this request again, or check Gemini for its reply.');
    if (submittedRequests.has(requestId)) throw sendError('ALREADY_SENT', 'This request was already sent. Check Gemini for its response.');
    if (generating()) throw sendError('SEND_BLOCKED', 'Gemini is still generating.');
    const button = [...document.querySelectorAll('button.send-button, button[data-test-id="send-button"], button[aria-label="Send message"], button[aria-label="Send prompt"], button[aria-label="Send"]')]
      .find((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.classList.contains('stop'));
    if (!button) throw sendError('SEND_NOT_READY', 'Cannot find an enabled Gemini Send button. You can send the draft directly in Gemini.');
    submittedRequests.add(requestId);
    button.click();
    return { submitted: true };
  }

  async function submitWhenReady(requestId, prompt) {
    for (let attempt = 0; ; attempt++) {
      try { return submitPrompt(requestId, prompt); }
      catch (error) {
        if (error.code !== 'SEND_NOT_READY' || attempt >= 15) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  function nodes(primary, fallback) {
    const found = [...document.querySelectorAll(primary)];
    return found.length ? found : [...document.querySelectorAll(fallback)];
  }
  const after = (node, other) => Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);

  function replyFor(requestId = null) {
    if (requestId !== null && !REQUEST_ID.test(requestId)) throw new Error('Invalid request ID.');
    const users = nodes('user-query', '.user-query-container, [data-message-author-role="user"]');
    const anchor = requestId === null ? users.at(-1) : users.filter((element) => (element.textContent || '').includes(marker(requestId))).at(-1);
    const busy = generating();
    if (!anchor) {
      const editor = composer();
      const draft = editor instanceof HTMLTextAreaElement ? editor.value : text(editor);
      const prepared = requestId !== null && draft.includes(marker(requestId));
      const canRestore = Boolean(requestId && editor && !draft.trim());
      return { found: false, busy, blocks: [], canRestore,
        message: !editor ? 'Gemini’s chat is still loading or needs sign-in. Waiting for its message box.' : prepared ? 'Prompt ready. Send it in Gemini to begin.' : canRestore ? 'This request is not in the loaded chat. Refreshing may have cleared its unsent draft. Use Restore prompt, or open the original conversation if you already sent it.' : requestId === null ? 'Ask Gemini for code in this chat. Replacement code will appear here when it finishes.' : 'This request is not in the loaded chat. Your current Gemini draft has been kept.' };
    }
    const nextRequest = users.find((element) => after(anchor, element) && /\[Gemini Edit request: [0-9a-f-]{36}\]/.test(element.textContent || ''));
    const latestUser = users.filter((element) => (element === anchor || after(anchor, element)) && (!nextRequest || after(element, nextRequest))).at(-1);
    const responses = nodes('model-response', '[data-message-author-role="model"], .model-response');
    const response = responses.filter((element) => after(latestUser, element) && (!nextRequest || after(element, nextRequest))).at(-1);
    if (!response) return { found: false, busy, blocks: [], message: 'Waiting for a response to this request.' };
    if (busy) return { found: true, busy: true, blocks: [], message: 'Gemini is generating. Code will be available when it finishes.' };
    // Follow-ups belong to this edit until another captured request starts.
    const codeNodes = [...response.querySelectorAll('pre code')];
    const plainPres = [...response.querySelectorAll('pre')].filter((element) => !element.querySelector('code'));
    const combined = [...codeNodes, ...plainPres].sort((a, b) => after(a, b) ? -1 : 1);
    let total = 0;
    const blocks = combined.slice(0, 20).map((element, index) => {
      const source = element.textContent || '';
      const size = bytes(source);
      total += size;
      const oversized = size > MAX_TEXT || total > 1024 * 1024;
      return { index, language: /(?:language|lang)-([\w+#.-]+)/.exec(element.className || '')?.[1] || '',
        text: oversized ? '' : source, oversized, size };
    });
    const preceding = users.filter((element) => element === latestUser || after(element, latestUser));
    const anchorId = preceding.map((element) => /\[Gemini Edit request: ([0-9a-f-]{36})\]/.exec(element.textContent || '')?.[1]).filter(Boolean).at(-1) || null;
    // Identifies the response across reloads, so already-reviewed code is not
    // offered again while a genuinely new turn (even identical code) is.
    let hash = 2166136261;
    const identity = (latestUser.textContent || '') + '\n' + blocks.map((block) => `${block.index}:${block.size}:${block.text}`).join('\n');
    for (let index = 0; index < identity.length; index++) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
    const responseKey = `${users.indexOf(latestUser)}:${identity.length}:${hash >>> 0}`;
    return { found: true, busy: false, blocks, url: location.href, anchorId, responseKey,
      message: blocks.length ? 'Choose the replacement code to review in VS Code.' : 'No fenced code block found. Ask Gemini to return the complete replacement in one code block.' };
  }

  const api = { composer, draftText: () => { const editor = composer(); return editor instanceof HTMLTextAreaElement ? editor.value : text(editor); }, generating, fillPrompt, submitPrompt, replyFor };
  globalThis.__geminiEditAdapter = api;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || message.source !== 'gemini-edit') return;
    try {
      let result;
      switch (message.type) {
        case 'ping': result = { url: location.href, composerFound: Boolean(composer()), busy: generating() }; break;
        case 'prepare': result = fillPrompt(message.requestId, message.prompt); break;
        case 'submit':
          void submitWhenReady(message.requestId, message.prompt).then(
            (value) => sendResponse({ ok: true, ...value }),
            (error) => sendResponse({ ok: false, error: error.message, code: error.code })
          );
          return true;
        case 'reply': result = replyFor(message.requestId); break;
        case 'latest': result = replyFor(); break;
        default: throw new Error('Unknown Gemini Edit command.');
      }
      sendResponse({ ok: true, ...result });
    } catch (error) { sendResponse({ ok: false, error: error.message, code: error.code }); }
  });
})();
