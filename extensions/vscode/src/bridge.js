'use strict';

const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { boundedText, publicJob, TERMINAL } = require('./model');

const MAX_BODY = 1024 * 1024;
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

class Bridge extends EventEmitter {
  constructor({ token, workspaceName = 'VS Code', onResponse = async () => {}, onImport = null }) {
    super();
    this.token = token;
    this.workspaceName = workspaceName;
    this.onResponse = onResponse;
    this.onImport = onImport;
    this.importing = false;
    this.instanceId = randomUUID();
    this.jobs = new Map();
    this.revision = 0;
    this.lastSeen = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
  }

  async start(preferredPort = 17373) {
    for (let offset = 0; offset < (preferredPort ? 10 : 1); offset++) {
      try {
        await new Promise((resolve, reject) => {
          const failed = (error) => { this.server.off('listening', ready); reject(error); };
          const ready = () => { this.server.off('error', failed); resolve(); };
          this.server.once('error', failed);
          this.server.once('listening', ready);
          this.server.listen(preferredPort ? preferredPort + offset : 0, '127.0.0.1');
        });
        this.port = this.server.address().port;
        return this;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || offset === 9) throw error;
      }
    }
  }

  close() {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }

  pairingCode() {
    return 'gemini-edit:' + Buffer.from(JSON.stringify({ protocol: 1, port: this.port, token: this.token })).toString('base64url');
  }

  add(job) {
    if ([...this.jobs.values()].filter((item) => !TERMINAL.has(item.status)).length >= 10) throw new Error('Finish or cancel an existing request first (maximum 10).');
    // Retain at most 20 snapshots, discarding completed requests first.
    for (const [id, item] of this.jobs) {
      if (this.jobs.size < 20) break;
      if (TERMINAL.has(item.status)) this.jobs.delete(id);
    }
    this.jobs.set(job.id, job);
    this.changed(job);
    return job;
  }

  changed(job) { this.revision++; this.emit('change', job); }

  authorized(req) {
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async body(req) {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      throw Object.assign(new Error('Request is too large.'), { status: 413 });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    }
    if (size > MAX_BODY) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }

  async handle(req, res) {
    const reply = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.headers.host !== `127.0.0.1:${this.port}`) return reply(403, { error: 'Invalid host.' });
      const origin = req.headers.origin;
      if (origin && !ORIGIN.test(origin)) return reply(403, { error: 'Only the paired Chrome extension may connect.' });
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') return reply(204);
      if (!this.authorized(req)) return reply(401, { error: 'Pair Chrome with VS Code first.' });
      this.lastSeen = Date.now();
      const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
      if (req.method === 'GET' && url.pathname === '/v1/state') {
        const metadata = { protocol: 1, instanceId: this.instanceId, workspaceName: this.workspaceName, revision: this.revision, supportsImport: Boolean(this.onImport) };
        if (url.searchParams.get('instance') === this.instanceId && url.searchParams.get('since') === String(this.revision)) return reply(200, { ...metadata, unchanged: true });
        return reply(200, { ...metadata, jobs: [...this.jobs.values()].map(publicJob) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/import') {
        if (!this.onImport) return reply(409, { error: 'Update the VS Code extension to import Gemini-only follow-ups.' });
        const body = await this.body(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Expected an import request.' });
        try {
          boundedText(body.text, 'Replacement');
          boundedText(body.responseKey, 'Response identity', 512);
          if (!body.responseKey) throw new Error('Missing response identity.');
        } catch (error) { return reply(400, { error: error.message }); }
        if (!Number.isInteger(body.tabId) || body.tabId < 0 || typeof body.url !== 'string' || !/^https:\/\/gemini\.google\.com\//.test(body.url)) return reply(400, { error: 'Expected a Gemini response.' });
        if (body.chatRequestId != null && !/^[0-9a-f-]{36}$/.test(body.chatRequestId)) return reply(400, { error: 'Invalid conversation request.' });
        const sourceJob = body.sourceJobId ? this.jobs.get(body.sourceJobId) : null;
        if (body.sourceJobId && (!sourceJob || !sourceJob.delivery || sourceJob.delivery.id !== body.deliveryId || sourceJob.delivery.tabId !== body.tabId)) return reply(409, { error: 'The edit target no longer matches this conversation. Choose a target in VS Code.' });
        if (sourceJob && !['delivered', 'applied', 'rejected'].includes(sourceJob.status)) return reply(409, { error: 'Finish the current diff or choose a new target in VS Code.' });
        if (!body.chooseTarget && [...this.jobs.values()].some((item) => ['review', 'applying', 'applied'].includes(item.status) && item.proposal?.responseKey === body.responseKey && item.proposal.sourceUrl === body.url && item.delivery?.tabId === body.tabId && item.proposal.text === body.text)) return reply(409, { error: 'This code block was already imported. Ask Gemini for a new response or choose another code block.' });
        if (this.importing) return reply(409, { error: 'An import is already waiting in VS Code. Finish or cancel it first.' });
        this.importing = true;
        try {
          let job = sourceJob;
          if (!job || job.status !== 'delivered') {
            job = await this.onImport({ sourceJob, text: body.text, chatRequestId: body.chatRequestId || null });
            if (!job) return reply(409, { error: 'No edit target was selected in VS Code.' });
            if (job === sourceJob || this.jobs.has(job.id)) throw new Error('An import must create a new proposal.');
            job.origin = 'gemini';
            job.delivery = { id: randomUUID(), tabId: body.tabId, url: body.url };
            job.status = 'review';
            this.add(job);
          }
          job.proposal = { text: body.text, responseKey: body.responseKey, sourceUrl: body.url, receivedAt: Date.now() };
          job.status = 'review';
          this.changed(job);
          try { await this.onResponse(job); }
          catch (error) { job.status = 'stale'; job.error = error.message; this.changed(job); return reply(409, { error: error.message }); }
          return reply(200, { job: publicJob(job) });
        } catch (error) { return reply(409, { error: error.message }); }
        finally { this.importing = false; }
      }
      const match = /^\/v1\/jobs\/([0-9a-f-]{36})\/(delivery|response|send)$/.exec(req.url);
      if (req.method !== 'POST' || !match) return reply(404, { error: 'Unknown route.' });
      const job = this.jobs.get(match[1]);
      if (!job) return reply(404, { error: 'Request no longer exists.' });
      const body = await this.body(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Expected a JSON object.' });
      if (match[2] === 'send') {
        if (!job.delivery || body.deliveryId !== job.delivery.id || body.tabId !== job.delivery.tabId) return reply(409, { error: 'Send does not match the current Gemini delivery.' });
        if (body.action === 'claim') {
          if (job.status !== 'delivered') return reply(409, { error: 'This request is no longer waiting to be sent.' });
          if (job.send && job.send.state !== 'not-sent') return reply(409, { error: 'Send was already attempted for this request. Check Gemini before creating another request.' });
          job.send = { state: 'attempted', claimId: randomUUID(), deliveryId: job.delivery.id };
          this.changed(job);
          return reply(200, { send: publicJob(job).send, claimId: job.send.claimId });
        }
        if (!job.send || job.send.state !== 'attempted' || body.claimId !== job.send.claimId) return reply(409, { error: 'This Send acknowledgement is no longer valid.' });
        if (body.action === 'confirmed') job.send.state = 'sent';
        else if (body.action === 'failed') {
          try { boundedText(body.error || '', 'Send error', 2048); }
          catch (error) { return reply(400, { error: error.message }); }
          job.send.state = body.notSent === true ? 'not-sent' : 'uncertain';
          job.send.error = body.error || 'Check Gemini before trying again.';
        } else return reply(400, { error: 'Unknown Send action.' });
        this.changed(job);
        return reply(200, { send: publicJob(job).send });
      }
      if (match[2] === 'delivery') {
        if (!['pending', 'delivered'].includes(job.status)) return reply(409, { error: 'This request is no longer waiting for Gemini.' });
        if (job.send && job.send.state !== 'not-sent') return reply(409, { error: 'This request was already sent or its Send result is uncertain. Check Gemini before creating another request.' });
        if (!Number.isInteger(body.tabId) || body.tabId < 0 || typeof body.url !== 'string' || !/^https:\/\/gemini\.google\.com\//.test(body.url)) return reply(400, { error: 'Expected a Gemini tab.' });
        job.delivery = { id: randomUUID(), tabId: body.tabId, url: body.url };
        job.status = 'delivered';
        this.changed(job);
        return reply(200, { delivery: job.delivery });
      }
      if (job.status !== 'delivered' || !job.delivery || body.deliveryId !== job.delivery.id || body.tabId !== job.delivery.tabId) return reply(409, { error: 'Response does not belong to the current delivery.' });
      if (typeof body.url !== 'string' || !/^https:\/\/gemini\.google\.com\//.test(body.url)) return reply(400, { error: 'Expected a Gemini response.' });
      try { boundedText(body.text, 'Replacement'); }
      catch (error) { return reply(400, { error: error.message }); }
      job.proposal = { text: body.text, receivedAt: Date.now() };
      job.status = 'review';
      this.changed(job);
      // A response only stages a proposal. The browser has no apply-edit endpoint.
      try { await this.onResponse(job); }
      catch (error) {
        job.status = 'stale';
        job.error = error.message;
        this.changed(job);
        return reply(409, { error: error.message });
      }
      return reply(200, { status: job.status });
    } catch (error) {
      reply(error.status || 500, { error: error.status ? error.message : 'The local bridge could not process this request.' });
      this.emit('bridgeError', error);
    }
  }
}

module.exports = { Bridge };
