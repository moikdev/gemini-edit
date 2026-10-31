'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const { Bridge } = require('../extensions/vscode/src/bridge');
const { makeJob } = require('../extensions/vscode/src/model');

const origin = `chrome-extension://${'a'.repeat(32)}`;
function job() {
  return makeJob({ uri: 'file:///private/project/file.js', filename: 'file.js', language: 'javascript', version: 1,
    fullText: 'old', selectedText: 'old', start: 0, end: 3, instruction: 'Improve it', eol: '\n' });
}
async function setup(t, options = {}) {
  const token = randomBytes(32).toString('base64url');
  const bridge = await new Bridge({ token, ...options }).start(0);
  t.after(() => bridge.close());
  const request = (path, body, headers = {}) => fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { bridge, request };
}
async function deliver(request, item, tabId = 42) {
  const response = await request(`/v1/jobs/${item.id}/delivery`, { tabId, url: 'https://gemini.google.com/app/abc' });
  assert.equal(response.status, 200);
  return (await response.json()).delivery;
}

test('only authenticated extension requests can read state; code and tokens are not logged or exposed as internal fields', async (t) => {
  const { bridge, request } = await setup(t);
  bridge.add(job());
  assert.equal((await request('/v1/state', undefined, { Authorization: '' })).status, 401);
  assert.equal((await request('/v1/state', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request('/v1/state', undefined, { Origin: 'https://gemini.google.com' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/state', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHost, 403);
  const response = await request('/v1/state');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const state = await response.json();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].uri, undefined);
  assert.equal(state.jobs[0].fullText, undefined);
  assert.equal(state.token, undefined);
  assert.equal(bridge.server.address().address, '127.0.0.1');
});
test('preflight permits only extension origins and exposes no data', async (t) => {
  const { bridge } = await setup(t);
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/state`, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  const denied = await fetch(`http://127.0.0.1:${bridge.port}/v1/state`, { method: 'OPTIONS', headers: { Origin: 'null' } });
  assert.equal(denied.status, 403);
});
test('unchanged state polls do not repeatedly transfer captured source code', async (t) => {
  const { bridge, request } = await setup(t);
  const item = bridge.add(job());
  const initial = await (await request('/v1/state')).json();
  const cursor = `/v1/state?since=${initial.revision}&instance=${initial.instanceId}`;
  const unchanged = await (await request(cursor)).json();
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.jobs, undefined);
  await deliver(request, item);
  const changed = await (await request(cursor)).json();
  assert.equal(changed.jobs[0].status, 'delivered');
  assert.ok(changed.revision > initial.revision);
  assert.equal((await (await request('/v1/state?since=1&instance=old')).json()).unchanged, undefined);
});
test('a matching response stages exactly one proposal and cannot apply code or replay', async (t) => {
  let staged = 0;
  const { bridge, request } = await setup(t, { onResponse: async () => staged++ });
  const item = bridge.add(job());
  const delivery = await deliver(request, item);
  const payload = { deliveryId: delivery.id, tabId: 42, url: 'https://gemini.google.com/app/abc', text: 'new' };
  assert.equal((await request(`/v1/jobs/${item.id}/response`, { ...payload, deliveryId: 'wrong' })).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, { ...payload, tabId: 43 })).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, { ...payload, url: 'https://evil.example/' })).status, 400);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, payload)).status, 200);
  assert.equal(item.status, 'review');
  assert.equal(item.proposal.text, 'new');
  assert.equal(item.fullText, 'old');
  assert.equal(staged, 1);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, payload)).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/apply`, {})).status, 404);
});
test('re-delivery invalidates an old response and malformed or oversized code is rejected', async (t) => {
  const { bridge, request } = await setup(t);
  const item = bridge.add(job());
  const old = await deliver(request, item);
  const latest = await deliver(request, item, 43);
  const payload = { deliveryId: latest.id, tabId: 43, url: 'https://gemini.google.com/app/abc', text: '' };
  assert.equal((await request(`/v1/jobs/${item.id}/response`, { ...payload, deliveryId: old.id })).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, { ...payload, text: null })).status, 400);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, { ...payload, text: 'x'.repeat(262145) })).status, 400);
  assert.equal((await request(`/v1/jobs/${item.id}/response`, payload)).status, 200);
  assert.equal(item.proposal.text, '');
});
test('cancelled and stale requests cannot receive proposals', async (t) => {
  const { bridge, request } = await setup(t);
  for (const status of ['cancelled', 'stale']) {
    const item = bridge.add(job());
    const delivery = await deliver(request, item);
    item.status = status;
    assert.equal((await request(`/v1/jobs/${item.id}/response`, { deliveryId: delivery.id, tabId: 42, url: delivery.url, text: 'new' })).status, 409);
    assert.equal((await request(`/v1/jobs/${item.id}/delivery`, { tabId: 42, url: delivery.url })).status, 409);
  }
});
test('a preview failure is surfaced and invalidates the proposal', async (t) => {
  const { bridge, request } = await setup(t, { onResponse: async () => { throw new Error('Document changed.'); } });
  const item = bridge.add(job());
  const delivery = await deliver(request, item);
  const response = await request(`/v1/jobs/${item.id}/response`, { deliveryId: delivery.id, tabId: 42, url: delivery.url, text: 'new' });
  assert.equal(response.status, 409);
  assert.equal(item.status, 'stale');
  assert.match((await response.json()).error, /changed/);
});
test('pending queue and snapshot retention are bounded', async (t) => {
  const { bridge } = await setup(t);
  for (let index = 0; index < 10; index++) bridge.add(job());
  assert.throws(() => bridge.add(job()), /maximum 10/);
  for (const item of bridge.jobs.values()) item.status = 'rejected';
  for (let index = 0; index < 30; index++) { const item = bridge.add(job()); item.status = 'applied'; }
  assert.equal(bridge.jobs.size, 20);
});
test('malformed JSON and unknown routes return structured errors', async (t) => {
  const { bridge, request } = await setup(t);
  const item = bridge.add(job());
  const pairing = JSON.parse(Buffer.from(bridge.pairingCode().split(':')[1], 'base64url'));
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/jobs/${item.id}/delivery`, { method: 'POST', headers: { Authorization: `Bearer ${pairing.token}` }, body: '{' });
  assert.equal(response.status, 400);
  assert.equal((await request('/anything')).status, 404);
  assert.equal((await request(`/v1/jobs/${item.id}/delivery`, { padding: 'x'.repeat(1024 * 1024) })).status, 413);
});
test('importing a Gemini reply can stage an existing delivered target without applying code', async (t) => {
  let targetPrompts = 0;
  const { bridge, request } = await setup(t, { onImport: async () => { targetPrompts++; return job(); } });
  const item = bridge.add(job());
  const delivery = await deliver(request, item);
  const response = await request('/v1/import', { sourceJobId: item.id, deliveryId: delivery.id, tabId: 42, url: delivery.url, text: 'new', responseKey: 'turn:0' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job.id, item.id);
  assert.equal(item.status, 'review');
  assert.equal(item.fullText, 'old');
  assert.equal(targetPrompts, 0);
  assert.equal((await (await request('/v1/state')).json()).supportsImport, true);
});
test('a Gemini-only follow-up creates a fresh proposal after an accepted edit', async (t) => {
  const { continuationSnapshot } = require('../extensions/vscode/src/model');
  const { bridge, request } = await setup(t, { onImport: async ({ sourceJob }) => makeJob(continuationSnapshot(sourceJob, { uri: sourceJob.uri, version: 2, text: 'a much longer replacement' })) });
  const original = bridge.add(job());
  const delivery = await deliver(request, original);
  original.status = 'applied';
  original.continuation = { uri: original.uri, fullText: 'a much longer replacement', version: 2, start: 0, end: 25 };
  const payload = { sourceJobId: original.id, deliveryId: delivery.id, tabId: 42, url: delivery.url, text: 'next', responseKey: 'followup:0', chatRequestId: original.id };
  const response = await request('/v1/import', payload);
  assert.equal(response.status, 200);
  const next = (await response.json()).job;
  assert.notEqual(next.id, original.id);
  assert.equal(next.chatRequestId, original.id);
  assert.equal(next.status, 'review');
  assert.equal(original.status, 'applied');
  assert.equal(original.fullText, 'old');
  assert.equal(bridge.jobs.get(next.id).fullText, 'a much longer replacement');
  assert.equal((await request('/v1/import', payload)).status, 409, 'The same code block must not be queued repeatedly.');
});
test('a chat without a VS Code request uses a locally selected target and ignores browser file paths', async (t) => {
  let imports = 0;
  const { bridge, request } = await setup(t, { onImport: async ({ sourceJob }) => { imports++; assert.equal(sourceJob, null); return job(); } });
  const response = await request('/v1/import', { tabId: 42, url: 'https://gemini.google.com/app/free-chat', text: 'plain chat code', responseKey: 'plain:0', uri: 'file:///untrusted/path', filename: '/untrusted/path' });
  assert.equal(response.status, 200);
  const created = bridge.jobs.get((await response.json()).job.id);
  assert.equal(created.uri, 'file:///private/project/file.js');
  assert.equal(created.status, 'review');
  assert.equal(created.proposal.text, 'plain chat code');
  assert.equal(imports, 1);
});
test('browser imports reject mismatched targets, unreviewed diffs, and invalid payloads', async (t) => {
  const { bridge, request } = await setup(t, { onImport: async () => job() });
  const item = bridge.add(job());
  const delivery = await deliver(request, item);
  const payload = { sourceJobId: item.id, deliveryId: delivery.id, tabId: 42, url: delivery.url, text: 'new', responseKey: 'turn:0' };
  assert.equal((await request('/v1/import', { ...payload, deliveryId: 'wrong' })).status, 409);
  assert.equal((await request('/v1/import', { ...payload, url: 'https://evil.example/' })).status, 400);
  assert.equal((await request('/v1/import', { ...payload, responseKey: '' })).status, 400);
  assert.equal((await request('/v1/import', { ...payload, text: 'x'.repeat(262145) })).status, 400);
  item.status = 'review';
  assert.equal((await request('/v1/import', payload)).status, 409);
});
test('competing panels can claim Send only once, and confirmation survives state polling', async (t) => {
  const { bridge, request } = await setup(t);
  const item = bridge.add(job());
  const delivery = await deliver(request, item);
  const payload = { deliveryId: delivery.id, tabId: 42, action: 'claim' };
  const results = await Promise.all([request(`/v1/jobs/${item.id}/send`, payload), request(`/v1/jobs/${item.id}/send`, payload)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const claim = await results.find((result) => result.status === 200).json();
  assert.equal(item.send.state, 'attempted');
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'confirmed', claimId: 'wrong' })).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'confirmed', claimId: claim.claimId })).status, 200);
  assert.equal((await request(`/v1/jobs/${item.id}/send`, payload)).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/delivery`, { tabId: 42, url: delivery.url })).status, 409);
  const state = await (await request('/v1/state')).json();
  assert.equal(state.jobs[0].send.state, 'sent');
  assert.equal(state.jobs[0].send.claimId, undefined);
});
test('only a known pre-click failure permits a new explicit Send attempt', async (t) => {
  const { bridge, request } = await setup(t);
  const item = bridge.add(job());
  const delivery = await deliver(request, item);
  const payload = { deliveryId: delivery.id, tabId: 42 };
  const claim = await (await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'claim' })).json();
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'failed', claimId: claim.claimId, notSent: true, error: 'Send button not ready.' })).status, 200);
  assert.equal(item.send.state, 'not-sent');
  const retry = await (await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'claim' })).json();
  assert.notEqual(retry.claimId, claim.claimId);
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'failed', claimId: retry.claimId, error: 'Message port closed.' })).status, 200);
  assert.equal(item.send.state, 'uncertain');
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { ...payload, action: 'claim' })).status, 409);
});
test('Send claims reject stale requests, wrong tabs, and obsolete deliveries', async (t) => {
  const { bridge, request } = await setup(t);
  const item = bridge.add(job());
  const old = await deliver(request, item);
  const current = await deliver(request, item, 43);
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { action: 'claim', tabId: 42, deliveryId: old.id })).status, 409);
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { action: 'claim', tabId: 42, deliveryId: current.id })).status, 409);
  item.status = 'stale';
  assert.equal((await request(`/v1/jobs/${item.id}/send`, { action: 'claim', tabId: 43, deliveryId: current.id })).status, 409);
});
