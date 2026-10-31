'use strict';

const { parsePairingCode, isGeminiUrl } = GeminiEditProtocol;
const pages = GeminiEditPageClient.createPageClient(chrome);
const $ = (id) => document.getElementById(id);
const terminal = new Set(['applied', 'rejected', 'cancelled', 'stale']);
let credentials = null;
let connected = false;
let state = null;
let selectedId = null;
let selectedByUser = false;
let selectedTabId = null;
let tabs = [];
let reply = null;
let busy = false;
let generation = 0;
let lastTabsRefresh = 0;
let requestSignature = '';
let replySignature = '';
const autoAttempts = new Set();
const loadingTabs = new Set();
let pageNotice = null;
let chooseTarget = false;

function chatUrl(value) {
  try { const url = new URL(value); return url.origin + url.pathname; } catch { return ''; }
}
function sourceForReply(value = reply) {
  if (!value || chooseTarget) return null;
  return [...(state?.jobs || [])].reverse().find((job) => {
    if (job.delivery?.tabId !== value.tabId) return false;
    const anchor = job.chatRequestId === undefined ? job.id : job.chatRequestId;
    if (value.anchorId) return anchor === value.anchorId;
    return job.origin === 'gemini' && anchor === null && chatUrl(job.delivery.url) === chatUrl(value.url);
  }) || null;
}
function blockIdentity(value = reply, block = currentBlock()) {
  return value?.responseKey && block ? `${value.responseKey}:${block.index}` : null;
}

function clearPageReply(tabId, text) {
  if (activeJob()?.delivery?.tabId !== tabId && reply?.tabId !== tabId && selectedTabId !== tabId) return;
  reply = null;
  replySignature = '';
  pageNotice = { tabId, text };
  renderReply();
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) {
    pages.invalidate(tabId);
    clearPageReply(tabId, 'Gemini is reloading. Waiting for its new page connection.');
  }
  if (change.status === 'loading') loadingTabs.add(tabId);
  if (change.status === 'complete') {
    loadingTabs.delete(tabId);
    lastTabsRefresh = 0;
    // A pending request that hit an unready page may now be inserted safely.
    for (const job of state?.jobs || []) if (job.status === 'pending') autoAttempts.delete(job.id);
  }
  if (tabId === selectedTabId || tabId === activeJob()?.delivery?.tabId) {
    if (loadingTabs.has(tabId)) $('tabStatus').textContent = 'Gemini is reloading. Your VS Code connection is still active.';
    renderState();
    renderReply();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  pages.invalidate(tabId);
  loadingTabs.delete(tabId);
  clearPageReply(tabId, 'The Gemini tab was closed. Open Gemini, then use Insert prompt to reconnect this request.');
  if (selectedTabId === tabId) selectedTabId = null;
  lastTabsRefresh = 0;
  renderState();
});

function message(kind, text) {
  $(kind).textContent = text || '';
  $(kind).hidden = !text;
}
function errorText(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'VS Code took too long to respond. Check that its window is still open.';
  if (error instanceof TypeError && /fetch/i.test(error.message)) return 'Cannot reach VS Code. Open its window and check the pairing code. If Chrome asks for local network access, allow it.';
  return error.message || String(error);
}
function activeJob() { return state?.jobs.find((job) => job.id === selectedId); }
function connectionStatus(text, ok) {
  connected = ok;
  $('connectionStatus').textContent = text;
  $('connectionDot').classList.toggle('connected', ok);
}
async function apiWith(connection, path, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === '/v1/import' ? 120000 : 10000), cache: 'no-store', credentials: 'omit', redirect: 'error'
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Local connection failed (${response.status}).`);
  return result;
}
async function api(path, body) {
  if (!credentials) throw new Error('Connect to VS Code first.');
  return apiWith(credentials, path, body);
}
function renderState() {
  const jobs = state?.jobs || [];
  const previous = activeJob();
  if (!previous || (!selectedByUser && terminal.has(previous.status) && jobs.some((job) => !terminal.has(job.status)))) {
    selectedId = jobs.find((job) => !terminal.has(job.status))?.id || jobs.at(-1)?.id || null;
    selectedByUser = false;
  }
  const signature = jobs.map((job) => `${job.id}:${job.status}`).join('|');
  if ($('requestSelect').dataset.signature !== signature) {
    $('requestSelect').replaceChildren(...jobs.map((job) => {
      const option = document.createElement('option');
      option.value = job.id;
      option.textContent = `${job.filename} · ${job.status}`;
      return option;
    }));
    $('requestSelect').dataset.signature = signature;
  }
  $('requestSelect').value = selectedId || '';
  $('emptyState').hidden = Boolean(jobs.length);
  $('requestSection').hidden = !jobs.length;
  $('queueCount').textContent = `${jobs.filter((job) => !terminal.has(job.status)).length} active`;
  const job = activeJob();
  const nextSignature = job ? `${job.id}:${job.status}:${job.delivery?.id || ''}:${job.send?.state || ''}` : '';
  if (nextSignature !== requestSignature) {
    requestSignature = nextSignature;
    reply = null;
    pageNotice = null;
    replySignature = '';
    renderReply();
    if (job) {
      $('filename').textContent = job.filename;
      $('instruction').textContent = job.instruction;
      $('operation').textContent = job.operation === 'insert' ? 'INSERT AT CURSOR' : 'REPLACE SELECTION';
      $('requestStatus').textContent = job.send?.state === 'sent' && job.status === 'delivered' ? 'sent' : job.status;
      $('promptPreview').textContent = job.prompt;
      $('promptPreview').closest('details').hidden = !job.prompt;
    }
  }
  if (job?.error) $('replyStatus').textContent = job.error;
  const pageLoading = loadingTabs.has(job?.delivery?.tabId ?? selectedTabId);
  const sendFinished = job?.send && job.send.state !== 'not-sent';
  const canSend = connected && !busy && !pageLoading && !sendFinished && job && ['pending', 'delivered'].includes(job.status);
  $('insertPrompt').disabled = !canSend;
  $('sendPrompt').disabled = !canSend;
  $('insertPrompt').textContent = reply?.canRestore ? 'Restore prompt ↗' : 'Insert prompt ↗';
  $('refreshReply').disabled = busy || selectedTabId === null;
  $('changeTarget').disabled = busy;
  $('useResponse').disabled = !canUseResponse();
}
function currentBlock() { return reply?.blocks?.find((block) => String(block.index) === $('codeBlock').value); }
function canUseResponse() {
  const block = currentBlock();
  const source = sourceForReply();
  const duplicate = !chooseTarget && (state?.jobs || []).some((job) => ['review', 'applying', 'applied'].includes(job.status) && job.responseKey === blockIdentity() && job.delivery?.tabId === reply?.tabId && chatUrl(job.delivery.url) === chatUrl(reply?.url));
  return connected && !busy && state?.supportsImport && reply?.tabId === selectedTabId && !loadingTabs.has(selectedTabId) && !reply.busy && block && !block.oversized && blockIdentity() && !duplicate && (!source || ['delivered', 'applied', 'rejected'].includes(source.status));
}
function renderReply() {
  const job = activeJob();
  const blocks = reply?.blocks || [];
  const signature = JSON.stringify([reply?.requestId, reply?.busy, blocks]);
  if (signature !== replySignature) {
    const previous = $('codeBlock').value;
    $('codeBlock').replaceChildren(...blocks.map((block) => {
      const option = document.createElement('option');
      option.value = String(block.index);
      option.textContent = `Block ${block.index + 1}${block.language ? ` · ${block.language}` : ''} · ${Math.max(1, Math.ceil(block.size / 1024))} KB${block.oversized ? ' · too large' : ''}`;
      return option;
    }));
    if (blocks.some((block) => String(block.index) === previous)) $('codeBlock').value = previous;
    replySignature = signature;
  }
  $('blockPicker').hidden = !blocks.length;
  if (blocks.length) $('emptyState').hidden = true;
  $('codePreview').textContent = currentBlock()?.oversized ? 'This block exceeds the edit size limit. Ask Gemini for a smaller replacement.' : currentBlock()?.text || '';
  $('useResponse').disabled = !canUseResponse();
  const statuses = {
    pending: job?.sendRequested ? 'Queued to send in Gemini when the chat is ready.' : 'Insert the prompt to get started.',
    delivered: job?.send?.state === 'sent' ? 'Sent to Gemini. Waiting for its response.' : job?.send?.state === 'uncertain' ? 'Send may have completed. Check Gemini; this request will not be sent again automatically.' : 'Waiting for Gemini. Send the prepared prompt in the chat.',
    review: 'Diff sent to VS Code. Accept or reject it there.', applying: 'VS Code is applying the edit.',
    applied: 'Edit applied. You can undo it in VS Code.', rejected: 'Edit rejected. Your source file was kept.',
    cancelled: 'Request cancelled in VS Code.', stale: 'The target document changed. Capture a new edit in VS Code.'
  };
  const source = sourceForReply();
  const alreadyImported = !chooseTarget && (state?.jobs || []).some((item) => ['review', 'applying', 'applied'].includes(item.status) && item.responseKey === blockIdentity() && item.delivery?.tabId === reply?.tabId && chatUrl(item.delivery.url) === chatUrl(reply?.url));
  $('replyStatus').textContent = (pageNotice?.tabId === selectedTabId ? pageNotice.text : null) || (source?.status === 'review' ? 'Diff sent to VS Code. Accept or reject it there; new Gemini code will keep appearing here.' : alreadyImported ? 'This code was already imported. Ask Gemini a follow-up question to get another replacement.' : reply?.message) || job?.error || statuses[job?.status] || 'Ask Gemini for code in the connected chat.';
  $('editTarget').textContent = source ? `Target: ${source.filename}${source.status === 'applied' ? ' · continues the last accepted edit' : ''}` : 'Choose a file or selection in VS Code when reviewing this code.';
  $('changeTarget').hidden = !reply?.blocks?.length || chooseTarget;
  $('insertPrompt').textContent = reply?.canRestore ? 'Restore prompt ↗' : 'Insert prompt ↗';
}
async function refreshTabs() {
  const found = (await chrome.tabs.query({ url: 'https://gemini.google.com/*' })).filter((tab) => isGeminiUrl(tab.url || tab.pendingUrl));
  if (selectedTabId !== null && !found.some((tab) => tab.id === selectedTabId)) {
    // A refresh can briefly remove the URL from tabs.query's results. Do not
    // silently switch to another conversation while the chosen tab is loading.
    try {
      const selected = await pages.getTab(selectedTabId);
      const previous = tabs.find((tab) => tab.id === selectedTabId);
      if (isGeminiUrl(selected.url || selected.pendingUrl) || (selected.status === 'loading' && (previous || (!selected.url && !selected.pendingUrl)))) found.push({ ...previous, ...selected, title: selected.title || previous?.title || 'Gemini (loading)' });
    } catch (error) {
      if (!/No tab with id|Invalid tab ID/i.test(error.message)) throw error;
    }
  }
  tabs = found;
  for (const tab of tabs) {
    if (tab.status === 'loading') loadingTabs.add(tab.id);
    else if (tab.status === 'complete') loadingTabs.delete(tab.id);
  }
  if (!tabs.some((tab) => tab.id === selectedTabId)) selectedTabId = tabs.length === 1 ? tabs[0].id : null;
  const previous = $('geminiTab').value;
  const options = [new Option('Choose a Gemini tab…', ''), ...tabs.map((tab) => new Option(tab.title || 'Gemini', String(tab.id)))];
  const signature = tabs.map((tab) => `${tab.id}:${tab.title}`).join('|');
  if ($('geminiTab').dataset.signature !== signature) {
    $('geminiTab').replaceChildren(...options);
    $('geminiTab').dataset.signature = signature;
  }
  $('geminiTab').value = selectedTabId === null ? '' : String(selectedTabId);
  if (previous !== $('geminiTab').value) await chrome.storage.local.set({ geminiTabId: selectedTabId });
  const target = tabs.find((tab) => tab.id === selectedTabId);
  $('tabStatus').textContent = target && loadingTabs.has(target.id) ? 'Gemini is reloading. Your VS Code connection is still active.' : target ? 'Requests stay in this chat tab.' : tabs.length > 1 ? 'Choose a tab below before inserting.' : 'Open Gemini and sign in to start.';
  lastTabsRefresh = Date.now();
}
async function targetTab(create = false) {
  await refreshTabs();
  let target = tabs.find((tab) => tab.id === selectedTabId);
  if (!target && tabs.length === 0 && create) {
    target = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
    selectedTabId = target.id;
    await chrome.storage.local.set({ geminiTabId: selectedTabId });
    throw new Error('Gemini is opening. Sign in if needed, then click Insert prompt.');
  }
  if (!target) throw new Error('Choose a Gemini tab in the list first.');
  return target;
}
async function page(tabId, type, data = {}) {
  return pages.request(tabId, type, data);
}
async function insert(job) {
  if (!job || !['pending', 'delivered'].includes(job.status)) throw new Error('Choose a waiting edit request.');
  const tab = await targetTab(true);
  const ready = await page(tab.id, 'ping', { requestId: job.id });
  if (!ready.composerFound) throw Object.assign(new Error('Gemini’s message box is not ready. Wait for the chat to load or sign in, then try again.'), { code: 'PAGE_NOT_READY' });
  if (ready.busy) throw Object.assign(new Error('Gemini is still generating. This request will send when it finishes.'), { code: 'GEMINI_BUSY' });
  // Reserve a delivery before touching the composer. Re-delivery invalidates old imports.
  const result = await api(`/v1/jobs/${job.id}/delivery`, { tabId: tab.id, url: tab.url });
  job.delivery = result.delivery;
  job.status = 'delivered';
  renderState();
  await page(tab.id, 'prepare', { requestId: job.id, prompt: job.prompt });
  pageNotice = null;
  message('notice', 'Prompt inserted. Send it in Gemini, or click Send in Gemini here.');
}
async function sendJob(job) {
  if (!job) throw new Error('Choose an edit request.');
  if (job.status === 'pending') await insert(job);
  const payload = { deliveryId: job.delivery.id, tabId: job.delivery.tabId };
  // Claim before clicking. This survives panel closure / reload and prevents
  // competing panels or reconnects from submitting the same request twice.
  const claim = await api(`/v1/jobs/${job.id}/send`, { ...payload, action: 'claim' });
  job.send = claim.send;
  renderState();
  try {
    await page(job.delivery.tabId, 'submit', { requestId: job.id, prompt: job.prompt });
  } catch (error) {
    const notSent = ['DRAFT_CHANGED', 'SEND_NOT_READY', 'SEND_BLOCKED'].includes(error.code);
    job.send = { state: notSent ? 'not-sent' : 'uncertain', error: errorText(error) };
    try {
      await api(`/v1/jobs/${job.id}/send`, { ...payload, action: 'failed', claimId: claim.claimId, notSent, error: errorText(error) });
    } catch { /* Keep the original send error; an unresolved claim never retries. */ }
    throw error;
  }
  try {
    const result = await api(`/v1/jobs/${job.id}/send`, { ...payload, action: 'confirmed', claimId: claim.claimId });
    job.send = result.send;
  } catch {
    job.send = { state: 'uncertain' };
    throw new Error('Gemini received the Send click, but confirmation to VS Code failed. Check the chat; this request will not be sent again automatically.');
  }
  message('notice', 'Sent to Gemini. Its code will appear here when it finishes.');
}
async function refreshReply() {
  const tabId = selectedTabId;
  if (tabId === null) return;
  let result;
  try {
    result = await page(tabId, 'latest');
    const job = activeJob();
    if (!result.found && job?.status === 'delivered' && job.delivery?.tabId === tabId) {
      const waiting = await page(tabId, 'reply', { requestId: job.chatRequestId || job.id });
      if (waiting.canRestore || !waiting.found) result = waiting;
    }
  }
  catch (error) {
    if (selectedTabId === tabId) clearPageReply(tabId, errorText(error));
    throw error;
  }
  if (selectedTabId !== tabId) return;
  reply = { ...result, tabId };
  pageNotice = null;
  renderReply();
}
async function action(fn) {
  if (busy) return;
  busy = true;
  message('error', '');
  message('notice', '');
  renderState();
  try { await fn(); }
  catch (error) { message('error', errorText(error)); }
  finally { busy = false; renderState(); renderReply(); }
}
async function poll() {
  const epoch = generation;
  try {
    if (credentials && !busy) {
      const cursor = state?.revision === undefined ? '' : `?since=${state.revision}&instance=${encodeURIComponent(state.instanceId)}`;
      const result = await api('/v1/state' + cursor);
      if (epoch !== generation || !credentials || busy) return;
      if (state?.instanceId !== result.instanceId) { selectedId = null; selectedByUser = false; reply = null; requestSignature = ''; autoAttempts.clear(); }
      if (!result.unchanged) state = result;
      connectionStatus(result.workspaceName, true);
      renderState();
      renderReply();
      if (Date.now() - lastTabsRefresh > 5000) {
        try { await refreshTabs(); }
        catch (error) { $('tabStatus').textContent = `Gemini tab lookup failed. Retrying automatically. ${errorText(error)}`; }
      }
      if (epoch !== generation || busy) return;
      const queuedSend = state.jobs.find((item) => item.status === 'pending' && item.sendRequested);
      if (queuedSend && queuedSend.id !== selectedId) {
        selectedId = queuedSend.id;
        selectedByUser = true;
        renderState();
      }
      const job = activeJob();
      if (job?.sendRequested && job.status === 'pending' && !autoAttempts.has(job.id)) {
        autoAttempts.add(job.id);
        await action(async () => {
          try { await insert(job); await sendJob(job); }
          catch (error) {
            if (['PAGE_LOADING', 'PAGE_NOT_READY', 'PAGE_TIMEOUT', 'GEMINI_BUSY'].includes(error.code) && job.status === 'pending') autoAttempts.delete(job.id);
            throw error;
          }
        });
      } else if (selectedTabId !== null) {
        try { await refreshReply(); }
        catch (error) { $('replyStatus').textContent = errorText(error); }
      }
    }
  } catch (error) {
    if (epoch === generation && !busy) {
      connectionStatus('VS Code disconnected', false);
      $('tabStatus').textContent = errorText(error);
      renderState();
    }
  } finally { setTimeout(poll, 1800); }
}

$('pairForm').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const value = parsePairingCode($('pairingCode').value);
    const result = await apiWith(value, '/v1/state');
    if (result.protocol !== 1 || !Array.isArray(result.jobs)) throw new Error('VS Code is running an incompatible Gemini Edit version.');
    generation++;
    credentials = value;
    state = result;
    selectedId = null;
    selectedByUser = false;
    requestSignature = '';
    autoAttempts.clear();
    await chrome.storage.local.set({ connection: value });
    $('pairingCode').value = '';
    $('pairing').hidden = true;
    $('settingsButton').setAttribute('aria-expanded', 'false');
    $('disconnectButton').hidden = false;
    connectionStatus(result.workspaceName, true);
    message('notice', 'Connected. Select code in VS Code and press Cmd/Ctrl+K.');
  });
});
$('settingsButton').addEventListener('click', () => {
  $('pairing').hidden = !$('pairing').hidden;
  $('settingsButton').setAttribute('aria-expanded', String(!$('pairing').hidden));
});
$('disconnectButton').addEventListener('click', () => void action(async () => {
  generation++;
  credentials = null;
  state = null;
  selectedId = null;
  selectedByUser = false;
  reply = null;
  requestSignature = '';
  await chrome.storage.local.remove('connection');
  $('disconnectButton').hidden = true;
  $('pairing').hidden = false;
  $('settingsButton').setAttribute('aria-expanded', 'true');
  connectionStatus('Not connected', false);
}));
$('openGemini').addEventListener('click', () => void action(async () => {
  await refreshTabs();
  const tab = tabs.find((item) => item.id === selectedTabId);
  if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  else if (tabs.length) { $('geminiTab').focus(); message('notice', 'Choose the Gemini chat tab you want to use.'); }
  else { const created = await chrome.tabs.create({ url: 'https://gemini.google.com/app' }); selectedTabId = created.id; await refreshTabs(); }
}));
$('geminiTab').addEventListener('change', () => void action(async () => {
  reply = null;
  pageNotice = null;
  chooseTarget = false;
  selectedTabId = $('geminiTab').value ? Number($('geminiTab').value) : null;
  await chrome.storage.local.set({ geminiTabId: selectedTabId });
  await refreshTabs();
  await refreshReply();
}));
$('requestSelect').addEventListener('change', () => {
  selectedId = $('requestSelect').value;
  selectedByUser = true;
  requestSignature = '';
  reply = null;
  renderState();
  void action(refreshReply);
});
$('insertPrompt').addEventListener('click', () => void action(() => insert(activeJob())));
$('sendPrompt').addEventListener('click', () => void action(() => sendJob(activeJob())));
$('refreshReply').addEventListener('click', () => void action(refreshReply));
$('codeBlock').addEventListener('change', renderReply);
$('changeTarget').addEventListener('click', () => { chooseTarget = true; renderState(); renderReply(); });
$('useResponse').addEventListener('click', () => {
  if (!canUseResponse()) return;
  const source = sourceForReply();
  const chosen = { ...currentBlock() };
  const captured = { ...reply };
  void action(async () => {
    const fresh = await page(captured.tabId, 'latest');
    const block = fresh.blocks?.find((item) => item.index === chosen.index);
    if (selectedTabId !== captured.tabId || fresh.busy || !block || block.oversized || block.text !== chosen.text || fresh.responseKey !== captured.responseKey) {
      reply = { ...fresh, tabId: captured.tabId };
      throw new Error('Gemini’s response changed. Review the current code block, then try again.');
    }
    if (!source) message('notice', 'Switch to VS Code and choose a file or selection for this code.');
    const result = await api('/v1/import', {
      ...(source ? { sourceJobId: source.id, deliveryId: source.delivery.id } : {}),
      tabId: captured.tabId, url: fresh.url, text: block.text, responseKey: blockIdentity(captured, chosen), chatRequestId: fresh.anchorId || null, chooseTarget
    });
    const existing = state.jobs.findIndex((job) => job.id === result.job.id);
    if (existing < 0) state.jobs.push(result.job); else state.jobs[existing] = result.job;
    selectedId = result.job.id;
    selectedByUser = true;
    chooseTarget = false;
    requestSignature = '';
    reply = null;
    message('notice', 'Diff opened in VS Code. Switch to your editor to accept or reject it.');
  });
});

async function initialize() {
  const saved = await chrome.storage.local.get(['connection', 'geminiTabId']);
  credentials = saved.connection || null;
  selectedTabId = Number.isInteger(saved.geminiTabId) ? saved.geminiTabId : null;
  $('shortcut').textContent = /Mac/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  if (credentials) {
    $('pairing').hidden = true;
    $('settingsButton').setAttribute('aria-expanded', 'false');
    $('disconnectButton').hidden = false;
  }
  try { await refreshTabs(); }
  catch (error) { $('tabStatus').textContent = `Gemini tab lookup failed. Retrying automatically. ${errorText(error)}`; }
  finally { renderState(); void poll(); }
}
void initialize().catch((error) => message('error', errorText(error)));
