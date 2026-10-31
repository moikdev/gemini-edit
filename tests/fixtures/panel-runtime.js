'use strict';

globalThis.panelFixture = {
  prepared: [], submitted: 0, proposals: [],
  queryFailures: globalThis.panelFixtureOptions?.queryFailures || 0,
  queries: 0, injections: 0, deliveries: 0,
  tabStatus: 'complete', receiverPresent: true, composerReady: true,
  draftLost: false, hideSelected: false, hangReply: false, pendingReply: null,
  noJobs: false, moreJobs: [], responseKey: 'turn-1',
  geminiBusy: Boolean(globalThis.panelFixtureOptions?.geminiBusy),
  draftExists: false, submitFailure: null, submitAttempts: 0,
  responseText: 'const greeting = "new";\n', anchorId: '11111111-1111-4111-a111-111111111111',
  connection: { protocol: 1, port: 17373, token: 'a'.repeat(43) },
  job: { id: '11111111-1111-4111-a111-111111111111', status: 'pending', filename: 'example.js', language: 'javascript',
    instruction: 'Change the greeting', prompt: '[Gemini Edit request: 11111111-1111-4111-a111-111111111111]\nEdit this code.', operation: 'replace', delivery: null,
    sendRequested: Boolean(globalThis.panelFixtureOptions?.sendRequested) }
};
function fixtureEvent() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (...args) => { for (const listener of listeners) listener(...args); } };
}
globalThis.chrome = {
  storage: { local: {
    async get() { return { connection: panelFixture.connection, geminiTabId: 7, autoInsert: false }; },
    async set() {}, async remove() {}
  } },
  tabs: {
    onUpdated: fixtureEvent(), onRemoved: fixtureEvent(),
    async query() {
      panelFixture.queries++;
      if (panelFixture.queryFailures > 0) { panelFixture.queryFailures--; throw new Error('Tab unavailable during reload'); }
      return panelFixture.hideSelected ? [{ id: 8, title: 'Another Gemini chat', url: 'https://gemini.google.com/app/other', status: 'complete' }] : [{ id: 7, windowId: 1, title: 'Gemini fixture', url: 'https://gemini.google.com/app/fixture', status: panelFixture.tabStatus }];
    },
    async get(id) { if (id !== 7) throw new Error('No tab with id: ' + id); return { id, title: 'Gemini fixture', windowId: 1, status: panelFixture.tabStatus, ...(panelFixture.hideSelected ? {} : { url: 'https://gemini.google.com/app/fixture' }) }; },
    async sendMessage(id, payload) {
      if (id !== 7) throw new Error('Wrong tab');
      if ('token' in payload || JSON.stringify(payload).includes(panelFixture.connection.token)) throw new Error('Token leaked to the content script.');
      if (!panelFixture.receiverPresent) throw new Error('Could not establish connection. Receiving end does not exist.');
      if (payload.type === 'ping') return { ok: true, composerFound: panelFixture.composerReady, busy: panelFixture.geminiBusy, readyState: 'complete' };
      if (payload.type === 'prepare') {
        if (panelFixture.draftExists) return { ok: false, code: 'DRAFT_EXISTS', error: 'An existing Gemini draft was kept.' };
        panelFixture.prepared.push(payload); panelFixture.draftLost = false; return { ok: true };
      }
      if (payload.type === 'submit') {
        panelFixture.submitAttempts++;
        const job = [panelFixture.job, ...panelFixture.moreJobs].find((item) => item.id === payload.requestId);
        if (job?.send?.state !== 'attempted') throw new Error('Send was not claimed before clicking.');
        panelFixture.submitted++;
        if (panelFixture.submitFailure === 'port') throw new Error('The message port closed before a response was received.');
        return { ok: true };
      }
      if (payload.type === 'reply' || payload.type === 'latest') {
        if (panelFixture.hangReply) { panelFixture.hangReply = false; return new Promise((resolve) => { panelFixture.pendingReply = resolve; }); }
        if (panelFixture.draftLost) return { ok: true, found: false, busy: false, canRestore: true, blocks: [], message: 'Refreshing cleared the unsent draft. Use Restore prompt.' };
        return { ok: true, found: true, busy: false, message: 'Ready to review.', url: 'https://gemini.google.com/app/fixture', anchorId: panelFixture.anchorId, responseKey: panelFixture.responseKey, blocks: [{ index: 0, language: 'javascript', text: panelFixture.responseText, size: panelFixture.responseText.length, oversized: false }] };
      }
      throw new Error('Unknown page message');
    },
    async update() {}
  },
  windows: { async update() {} },
  scripting: { async executeScript() { panelFixture.injections++; panelFixture.receiverPresent = true; } }
};
globalThis.fetch = async (url, options = {}) => {
  if (options.headers?.Authorization !== `Bearer ${panelFixture.connection.token}`) throw new Error('Missing bearer token');
  if (!url.startsWith('http://127.0.0.1:17373/v1/')) throw new Error('Unexpected remote request');
  if (new URL(url).pathname.endsWith('/state')) return new Response(JSON.stringify({ protocol: 1, supportsImport: true, instanceId: 'fixture', revision: 1, workspaceName: 'Fixture workspace', jobs: [...(panelFixture.noJobs ? [] : [panelFixture.job]), ...panelFixture.moreJobs] }));
  const body = JSON.parse(options.body);
  const requestedJobId = /\/jobs\/([^/]+)\//.exec(url)?.[1];
  const requestedJob = [panelFixture.job, ...panelFixture.moreJobs].find((job) => job.id === requestedJobId);
  if (url.endsWith('/send')) {
    if (!requestedJob || requestedJob.delivery?.id !== body.deliveryId || body.tabId !== 7) throw new Error('Wrong Send delivery.');
    if (body.action === 'claim') {
      if (requestedJob.send && requestedJob.send.state !== 'not-sent') return new Response(JSON.stringify({ error: 'Send was already attempted.' }), { status: 409 });
      requestedJob.send = { state: 'attempted' };
      return new Response(JSON.stringify({ send: requestedJob.send, claimId: 'claim-' + requestedJob.id }));
    }
    if (body.claimId !== 'claim-' + requestedJob.id) throw new Error('Wrong Send claim.');
    requestedJob.send = body.action === 'confirmed' ? { state: 'sent' } : { state: body.notSent ? 'not-sent' : 'uncertain', error: body.error };
    return new Response(JSON.stringify({ send: requestedJob.send }));
  }
  if (new URL(url).pathname === '/v1/import') {
    const parent = [panelFixture.job, ...panelFixture.moreJobs].find((job) => job.id === body.sourceJobId);
    if (parent && (body.deliveryId !== parent.delivery?.id || body.tabId !== 7)) throw new Error('Mismatched proposal delivery');
    panelFixture.proposals.push(body);
    let created = parent;
    if (!parent || parent.status !== 'delivered') {
      created = { id: `33333333-3333-4333-a333-${String(panelFixture.proposals.length).padStart(12,'0')}`, origin: 'gemini', filename: 'example.js', status: 'review',
        delivery: { id: 'followup-' + panelFixture.proposals.length, tabId: 7, url: body.url }, chatRequestId: body.chatRequestId || null, prompt: '', instruction: 'Code from Gemini chat', operation: 'replace' };
      panelFixture.moreJobs.push(created);
    }
    created.status = 'review';
    created.responseKey = body.responseKey;
    return new Response(JSON.stringify({ job: created }));
  }
  if (url.endsWith('/delivery')) {
    panelFixture.deliveries++;
    requestedJob.status = 'delivered';
    requestedJob.delivery = { id: '22222222-2222-4222-a222-222222222222', tabId: body.tabId, url: body.url };
    return new Response(JSON.stringify({ delivery: requestedJob.delivery }));
  }
  if (url.endsWith('/response')) {
    if (body.deliveryId !== panelFixture.job.delivery.id || body.tabId !== 7) throw new Error('Mismatched proposal delivery');
    panelFixture.proposals.push(body);
    panelFixture.job.status = 'review';
    return new Response(JSON.stringify({ status: 'review' }));
  }
  throw new Error('Unknown bridge route');
};
