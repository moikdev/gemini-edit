'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeJob, replacementDocument, assertFresh, boundedText, continuationSnapshot } = require('../extensions/vscode/src/model');
const { parsePairingCode, isGeminiUrl } = require('../extensions/chrome/protocol');

function snapshot(overrides = {}) {
  return { uri: 'file:///project/file.js', filename: 'file.js', language: 'javascript', version: 1,
    fullText: 'before\nold\nafter\n', start: 7, end: 10, selectedText: 'old', instruction: 'Improve it', eol: '\n', attachments: [], ...overrides };
}

test('a selection replacement preserves every character outside the captured target', () => {
  const job = makeJob(snapshot());
  assert.equal(replacementDocument(job, '  new\n  code'), 'before\n  new\n  code\nafter\n');
  assert.equal(replacementDocument(job, ''), 'before\n\nafter\n');
  assert.match(job.prompt, new RegExp(`^\\[Gemini Edit request: ${job.id}\\]`));
});
test('insertion and full-document replacement work, including an empty file', () => {
  const job = makeJob(snapshot({ start: 7, end: 7, selectedText: '' }));
  assert.equal(replacementDocument(job, 'added\n'), 'before\nadded\nold\nafter\n');
  const empty = makeJob(snapshot({ fullText: '', start: 0, end: 0, selectedText: '' }));
  assert.equal(replacementDocument(empty, 'hello'), 'hello');
  const full = makeJob(snapshot({ start: 0, end: 17, selectedText: 'before\nold\nafter\n' }));
  assert.equal(replacementDocument(full, 'new'), 'new');
});
test('line endings normalize to the original file without stripping indentation or trailing lines', () => {
  const job = makeJob(snapshot({ fullText: 'x\r\ny\r\n', start: 3, end: 4, selectedText: 'y', eol: '\r\n' }));
  assert.equal(replacementDocument(job, '  a\nb\r\nc\r'), 'x\r\n  a\r\nb\r\nc\r\n\r\n');
});
test('code containing Markdown fences stays inside a longer fence', () => {
  const job = makeJob(snapshot({ fullText: '```\ntext\n```', start: 0, end: 12, selectedText: '```\ntext\n```' }));
  assert.match(job.prompt, /````javascript\n```\ntext\n```\n````/);
});
test('context attachments are identified as read-only', () => {
  const job = makeJob(snapshot({ surrounding: 'nearby code', attachments: [{ filename: 'types.js', language: 'javascript', text: 'class Item {}' }] }));
  assert.match(job.prompt, /READ-ONLY attachment: types.js/);
  assert.match(job.prompt, /READ-ONLY surrounding context/);
});
test('a URI, version, or content mismatch invalidates an edit', () => {
  const job = makeJob(snapshot());
  const current = { uri: job.uri, version: job.version, text: job.fullText };
  assert.doesNotThrow(() => assertFresh(job, current));
  for (const change of [{ uri: 'file:///other' }, { version: 2 }, { text: 'changed' }]) assert.throws(() => assertFresh(job, { ...current, ...change }), /changed/);
});
test('ranges, blank instructions, byte limits, and oversized prompts are rejected', () => {
  assert.throws(() => makeJob(snapshot({ start: -1 })), /range/);
  assert.throws(() => makeJob(snapshot({ selectedText: 'mismatch' })), /snapshot/);
  assert.throws(() => makeJob(snapshot({ instruction: ' ' })), /instruction/);
  assert.throws(() => boundedText('あ'.repeat(100000)), /256 KiB/);
  assert.throws(() => makeJob(snapshot({ attachments: [{ filename: 'large', text: 'x'.repeat(270000) }] })), /Combined prompt/);
});
test('pairing is restricted to a fixed loopback port and a correctly shaped token', () => {
  const value = { protocol: 1, port: 17373, token: 'a'.repeat(43), url: 'https://evil.example' };
  const encode = (data) => 'gemini-edit:' + Buffer.from(JSON.stringify(data)).toString('base64url');
  assert.deepEqual(parsePairingCode(encode(value)), { protocol: 1, port: 17373, token: 'a'.repeat(43) });
  for (const change of [{ protocol: 2 }, { port: 80 }, { port: '17373' }, { token: 'short' }]) assert.throws(() => parsePairingCode(encode({ ...value, ...change })));
  assert.throws(() => parsePairingCode('invalid'));
  assert.throws(() => parsePairingCode('gemini-edit:!!!'));
});
test('Gemini URL validation rejects lookalikes, other protocols, and nonstandard ports', () => {
  assert.equal(isGeminiUrl('https://gemini.google.com/app/abc'), true);
  for (const value of ['https://gemini.google.com.evil.example/app', 'http://gemini.google.com', 'https://gemini.google.com:1234/app', 'https://gemini.google.com@evil.example', 'nonsense']) assert.equal(isGeminiUrl(value), false);
});
test('a browser follow-up uses the updated accepted range while preserving the original diff snapshot', () => {
  const job = makeJob(snapshot());
  const original = job.fullText;
  job.status = 'applied';
  job.continuation = { uri: job.uri, version: 2, fullText: 'before\nmuch longer code\nafter\n', start: 7, end: 23 };
  const next = continuationSnapshot(job, { uri: job.uri, version: 2, text: job.continuation.fullText });
  assert.equal(next.selectedText, 'much longer code');
  const followup = makeJob(next);
  assert.equal(replacementDocument(followup, 'short'), 'before\nshort\nafter\n');
  assert.equal(followup.chatRequestId, job.id);
  assert.equal(followup.prompt, '');
  assert.equal(job.fullText, original);
  assert.throws(() => continuationSnapshot(job, { uri: job.uri, version: 3, text: job.continuation.fullText }), /changed/);
});

module.exports = { snapshot };
