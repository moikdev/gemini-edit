'use strict';

(function (root) {
  function parsePairingCode(input) {
    const prefix = 'gemini-edit:';
    if (typeof input !== 'string' || !input.trim().startsWith(prefix) || input.length > 1024) throw new Error('Paste the pairing code copied from VS Code.');
    let value;
    try {
      const encoded = input.trim().slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/');
      value = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    } catch { throw new Error('The pairing code is invalid. Copy it again from VS Code.'); }
    if (value?.protocol !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
      throw new Error('Unsupported pairing code. Copy it again from VS Code.');
    }
    return { protocol: 1, port: value.port, token: value.token };
  }
  function isGeminiUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'gemini.google.com' && !parsed.port; }
    catch { return false; }
  }
  const api = { parsePairingCode, isGeminiUrl };
  root.GeminiEditProtocol = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
