'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { Bridge } = require('./bridge');
const { makeJob, replacementDocument, assertFresh, boundedText, publicJob, TERMINAL, continuationSnapshot } = require('./model');

async function activate(context) {
  const output = vscode.window.createOutputChannel('Gemini Edit');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const snapshots = new Map();
  const attachments = new Map();
  let nextImportTarget = null;
  const changes = new vscode.EventEmitter();
  const provider = vscode.workspace.registerTextDocumentContentProvider('gemini-edit', {
    onDidChange: changes.event,
    provideTextDocumentContent: (uri) => snapshots.get(uri.toString()) || ''
  });
  context.subscriptions.push(output, status, changes, provider);
  let token = await context.secrets.get('bridge-token');
  if (!token) {
    token = randomBytes(32).toString('base64url');
    await context.secrets.store('bridge-token', token);
  }

  let bridge;
  function report(error) {
    output.appendLine(error.stack || error.message || String(error));
    void vscode.window.showErrorMessage(`Gemini Edit: ${error.message || error}`);
  }
  function requireBridge() {
    if (!bridge?.port) throw new Error('The local bridge is unavailable. Check the Gemini Edit output channel and reload this window.');
    return bridge;
  }
  function updateStatus() {
    const jobs = bridge ? [...bridge.jobs.values()].filter((job) => !TERMINAL.has(job.status)) : [];
    const connected = bridge && Date.now() - bridge.lastSeen < 8000;
    status.text = `$(sparkle) Gemini${jobs.length ? ` · ${jobs.length}` : ''}${connected ? ' $(plug)' : ''}`;
    status.tooltip = bridge?.port ? `Gemini Edit · ${connected ? 'Chrome connected' : 'Open the Chrome side panel to connect'}\n${attachments.size} context attachment(s) · local port ${bridge.port}` : 'Gemini Edit: bridge unavailable';
    status.command = 'geminiEdit.requests';
    status.show();
  }
  function documentSnapshot(document) {
    return { uri: document.uri.toString(), version: document.version, text: document.getText() };
  }
  function previewUris(job) {
    const filename = job.filename.split(/[\\/]/).pop() || 'code.txt';
    return {
      original: vscode.Uri.from({ scheme: 'gemini-edit', path: `/original/${filename}`, query: `id=${job.id}&side=original` }),
      proposed: vscode.Uri.from({ scheme: 'gemini-edit', path: `/proposed/${filename}`, query: `id=${job.id}&side=proposed` })
    };
  }
  async function preview(job, notify = true) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(job.uri));
    assertFresh(job, documentSnapshot(document));
    const uris = previewUris(job);
    snapshots.set(uris.original.toString(), job.fullText);
    snapshots.set(uris.proposed.toString(), replacementDocument(job, job.proposal.text));
    await vscode.commands.executeCommand('vscode.diff', uris.original, uris.proposed, `Gemini Edit: ${job.filename}`, { preview: false });
    if (notify) {
      void vscode.window.showInformationMessage('Gemini Edit: Review the diff, then accept or reject the edit.', 'Accept', 'Reject').then((choice) => {
        if (choice === 'Accept') return accept(job);
        if (choice === 'Reject') return reject(job);
      }).catch(report);
    }
  }
  async function accept(job) {
    if (!job || job.status !== 'review') throw new Error('This proposal is no longer available. Open Gemini Edit: Show Requests.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(job.uri));
    if (job.status !== 'review') throw new Error('This proposal is already being handled.');
    try { assertFresh(job, documentSnapshot(document)); }
    catch (error) { job.status = 'stale'; job.error = error.message; bridge.changed(job); throw error; }
    const replacement = replacementDocument(job, job.proposal.text);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(job.start), document.positionAt(job.end)), replacement.slice(job.start, replacement.length - (job.fullText.length - job.end)));
    job.status = 'applying';
    bridge.changed(job);
    try {
      const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
      if (!applied) throw new Error('VS Code could not apply the edit.');
      const insertedLength = replacement.length - (job.fullText.length - (job.end - job.start));
      job.continuation = document.getText() === replacement ? {
        uri: job.uri, fullText: replacement, version: document.version,
        start: job.start, end: job.start + insertedLength
      } : null;
      job.status = 'applied';
      bridge.changed(job);
      await vscode.window.showTextDocument(document, { preview: false });
      void vscode.window.showInformationMessage('Gemini Edit: Applied. Use Undo to revert. The file has not been saved automatically.');
    } catch (error) {
      if (job.status === 'applying') { job.status = 'stale'; job.error = error.message; bridge.changed(job); }
      throw error;
    }
  }
  function reject(job) {
    if (!job || job.status !== 'review') throw new Error('This proposal is no longer available.');
    job.status = 'rejected';
    bridge.changed(job);
  }
  async function pickJob(uri, statuses = ['review']) {
    requireBridge();
    const candidateUri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (candidateUri?.scheme === 'gemini-edit') {
      const job = bridge.jobs.get(new URLSearchParams(candidateUri.query).get('id'));
      if (job && statuses.includes(job.status)) return job;
      throw new Error('This diff is no longer an active proposal. Open Gemini Edit: Show Requests.');
    }
    const jobs = [...bridge.jobs.values()].filter((job) => statuses.includes(job.status));
    if (!jobs.length) throw new Error('There are no matching proposals.');
    if (jobs.length === 1) return jobs[0];
    const picked = await vscode.window.showQuickPick(jobs.map((job) => ({ label: job.filename, description: job.instruction, job })), { placeHolder: 'Choose an edit' });
    return picked?.job;
  }
  async function edit(instruction) {
    requireBridge();
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme === 'gemini-edit') throw new Error('Focus a source file first.');
    if (editor.selections.length !== 1) throw new Error('Use one selection at a time.');
    const document = editor.document;
    const selection = editor.selection;
    const fullText = boundedText(document.getText(), 'Active file', 2 * 1024 * 1024);
    const start = document.offsetAt(selection.start);
    const end = document.offsetAt(selection.end);
    const version = document.version;
    const lines = vscode.workspace.getConfiguration('geminiEdit').get('surroundingLines', 20);
    const range = new vscode.Range(Math.max(0, selection.start.line - lines), 0, Math.min(document.lineCount - 1, selection.end.line + lines), Number.MAX_SAFE_INTEGER);
    const surrounding = document.getText(range);
    const capturedAttachments = [...attachments.values()].map((item) => ({ ...item }));
    if (typeof instruction !== 'string') instruction = await vscode.window.showInputBox({
      title: selection.isEmpty ? 'Gemini Edit · Insert at cursor' : 'Gemini Edit · Edit selection',
      prompt: `${capturedAttachments.length} context attachment(s). Press Enter to send your code and instruction to Gemini. Keep the Chrome side panel open.`,
      placeHolder: 'What would you like to change?',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Enter an instruction.'
    });
    if (instruction === undefined) return;
    if (document.version !== version || document.getText() !== fullText) throw new Error('The document changed while you entered the instruction. Try again.');
    const job = makeJob({ uri: document.uri.toString(), filename: vscode.workspace.asRelativePath(document.uri), language: document.languageId,
      version, fullText, start, end, selectedText: fullText.slice(start, end), instruction,
      surrounding, attachments: capturedAttachments, sendRequested: true, eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' });
    bridge.add(job);
    for (const key of snapshots.keys()) {
      if (!bridge.jobs.has(new URLSearchParams(vscode.Uri.parse(key).query).get('id'))) snapshots.delete(key);
    }
    void vscode.window.showInformationMessage('Gemini Edit: Queued to send in Gemini. Keep the Chrome side panel open.', 'Copy Pairing Code').then((choice) => {
      if (choice) return vscode.commands.executeCommand('geminiEdit.pair');
    }).catch(report);
    return job.id;
  }
  async function addContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme === 'gemini-edit') throw new Error('Focus a source file first.');
    const document = editor.document;
    const text = boundedText(editor.selection.isEmpty ? document.getText() : document.getText(editor.selection), 'Context attachment', 64 * 1024);
    const key = document.uri.toString();
    if (!attachments.has(key) && attachments.size >= 5) throw new Error('Attach at most five files. Clear attached context to start again.');
    attachments.set(key, { filename: vscode.workspace.asRelativePath(document.uri), language: document.languageId, text });
    updateStatus();
    void vscode.window.showInformationMessage(`Gemini Edit: Added ${vscode.workspace.asRelativePath(document.uri)} to context (${attachments.size} attached).`);
  }
  function captureTarget(document, selection = null) {
    const fullText = boundedText(document.getText(), 'Active file', 2 * 1024 * 1024);
    const start = selection ? document.offsetAt(selection.start) : 0;
    const end = selection ? document.offsetAt(selection.end) : fullText.length;
    return {
      uri: document.uri.toString(), filename: vscode.workspace.asRelativePath(document.uri), language: document.languageId,
      fullText, version: document.version, start, end, selectedText: fullText.slice(start, end),
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
    };
  }
  async function importTarget({ sourceJob, chatRequestId }) {
    let target;
    if (sourceJob) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceJob.uri));
      target = continuationSnapshot(sourceJob, documentSnapshot(document));
    } else if (nextImportTarget) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(nextImportTarget.uri));
      assertFresh(nextImportTarget, documentSnapshot(document));
      target = nextImportTarget;
      nextImportTarget = null;
    } else {
      const editor = vscode.window.activeTextEditor;
      const documents = vscode.workspace.textDocuments.filter((document) => !document.isClosed && ['file', 'untitled', 'vscode-remote'].includes(document.uri.scheme));
      const choices = [];
      if (editor && documents.includes(editor.document)) {
        const filename = vscode.workspace.asRelativePath(editor.document.uri);
        if (!editor.selection.isEmpty) choices.push({ label: `Replace selection in ${filename}`, snapshot: captureTarget(editor.document, editor.selection) });
        choices.push({ label: `Replace entire file: ${filename}`, snapshot: captureTarget(editor.document) });
        if (editor.selection.isEmpty) choices.push({ label: `Insert at cursor in ${filename}`, snapshot: captureTarget(editor.document, editor.selection) });
      }
      for (const document of documents) {
        if (document === editor?.document) continue;
        choices.push({ label: `Replace entire file: ${vscode.workspace.asRelativePath(document.uri)}`, document });
      }
      if (!choices.length) throw new Error('Open a source file in VS Code, then review the Gemini code again.');
      const selected = await vscode.window.showQuickPick(choices, { title: 'Gemini Edit: Choose an edit target', placeHolder: 'Choose where this Gemini code should go. You will review a diff before applying it.', ignoreFocusOut: true });
      if (!selected) return null;
      target = selected.snapshot || captureTarget(selected.document);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
      assertFresh(target, documentSnapshot(document));
    }
    const job = makeJob({ ...target, instruction: 'Code from Gemini chat', origin: 'gemini', chatRequestId: sourceJob ? target.chatRequestId : chatRequestId });
    // This is a local snapshot for a browser-originated edit, not a new prompt.
    job.prompt = '';
    return job;
  }
  async function requests() {
    requireBridge();
    const items = [
      { label: '$(plug) Copy Chrome Pairing Code', action: 'pair' },
      { label: `$(clear-all) Clear Attached Context (${attachments.size})`, action: 'clearContext' },
      ...[...bridge.jobs.values()].reverse().map((job) => ({ label: job.filename, description: job.status, detail: job.error || job.instruction, job }))
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Gemini Edit · Requests and connection' });
    if (!picked) return;
    if (picked.action) return vscode.commands.executeCommand(`geminiEdit.${picked.action}`);
    const job = picked.job;
    if (job.status === 'review') {
      const action = await vscode.window.showQuickPick(['Preview diff', 'Accept edit', 'Reject edit']);
      if (action === 'Preview diff') return preview(job, false);
      if (action === 'Accept edit') return accept(job);
      if (action === 'Reject edit') return reject(job);
    } else if (['pending', 'delivered'].includes(job.status)) {
      const action = await vscode.window.showQuickPick(['Keep waiting', 'Cancel request']);
      if (action === 'Cancel request') { job.status = 'cancelled'; bridge.changed(job); }
    } else {
      void vscode.window.showInformationMessage(`Gemini Edit: ${job.error || `This request was ${job.status}.`}`);
    }
  }

  const register = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(`geminiEdit.${name}`, async (...args) => {
    try { return await handler(...args); } catch (error) { report(error); }
  }));
  register('edit', (instruction) => edit(typeof instruction === 'string' ? instruction : undefined));
  register('addContext', addContext);
  register('setTarget', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['file', 'untitled', 'vscode-remote'].includes(editor.document.uri.scheme)) throw new Error('Focus a source file first.');
    nextImportTarget = captureTarget(editor.document, editor.selection);
    void vscode.window.showInformationMessage(`Gemini Edit: The current selection / cursor in ${nextImportTarget.filename} is the target for your next Gemini import.`);
  });
  register('clearContext', () => { attachments.clear(); updateStatus(); void vscode.window.showInformationMessage('Gemini Edit: Attached context cleared.'); });
  register('pair', async () => {
    await vscode.env.clipboard.writeText(requireBridge().pairingCode());
    void vscode.window.showInformationMessage('Gemini Edit: Pairing code copied. Paste it in the Chrome extension’s side panel. Keep it private.');
  });
  register('requests', requests);
  register('accept', async (uri) => { const job = await pickJob(uri); if (job) await accept(job); });
  register('reject', async (uri) => { const job = await pickJob(uri); if (job) reject(job); });
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!bridge) return;
    for (const job of bridge.jobs.values()) {
      if (['pending', 'delivered', 'review'].includes(job.status) && job.uri === event.document.uri.toString()) {
        job.status = 'stale';
        job.error = 'The target document changed. Capture the code again.';
        bridge.changed(job);
      }
    }
  }));
  try {
    bridge = new Bridge({ token, workspaceName: vscode.workspace.name || 'VS Code', onResponse: (job) => preview(job), onImport: importTarget });
    bridge.on('change', updateStatus);
    bridge.on('bridgeError', (error) => output.appendLine(error.message));
    await bridge.start(vscode.workspace.getConfiguration('geminiEdit').get('port', 17373));
    output.appendLine(`Listening on 127.0.0.1:${bridge.port}. Use Copy Chrome Pairing Code to connect.`);
    context.subscriptions.push({ dispose: () => { void bridge.close(); } });
  } catch (error) { report(error); }
  const timer = setInterval(updateStatus, 4000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  updateStatus();
  return { getStatus: () => ({ port: bridge?.port, jobs: bridge ? [...bridge.jobs.values()].map(publicJob) : [], attachments: attachments.size }) };
}

module.exports = { activate, deactivate() {} };
