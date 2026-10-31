'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const temp = process.env.GEMINI_EDIT_TEST_DIR;
  const report = (value) => fs.writeFileSync(path.join(temp, 'results.json'), JSON.stringify(value));
  const previousClipboard = await vscode.env.clipboard.readText();
  try {
    const extension = vscode.extensions.getExtension('gemini-edit-local.gemini-edit');
    assert.ok(extension, 'The extension was not discovered.');
    const api = await extension.activate();
    assert.ok(api.getStatus().port, 'The bridge did not start.');
    await vscode.commands.executeCommand('geminiEdit.pair');
    const pairing = await vscode.env.clipboard.readText();
    const connection = JSON.parse(Buffer.from(pairing.slice('gemini-edit:'.length), 'base64url'));
    const request = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${connection.port}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const stage = async (id, text) => {
      const delivery = await request(`/v1/jobs/${id}/delivery`, { tabId: 42, url: 'https://gemini.google.com/app/test' });
      assert.equal(delivery.status, 200);
      const response = await request(`/v1/jobs/${id}/response`, { deliveryId: delivery.data.delivery.id, tabId: 42, url: 'https://gemini.google.com/app/test', text });
      assert.equal(response.status, 200, JSON.stringify(response.data));
    };
    const filename = path.join(temp, 'workspace/example.js');
    const original = 'const greeting = "old";\n';
    fs.writeFileSync(filename, original);
    const document = await vscode.workspace.openTextDocument(filename);
    let editor = await vscode.window.showTextDocument(document);
    const start = original.indexOf('"old"');
    function select() { editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(start + 5)); }
    select();
    await vscode.commands.executeCommand('geminiEdit.addContext');
    assert.equal(api.getStatus().attachments, 1);
    const id = await vscode.commands.executeCommand('geminiEdit.edit', 'Replace the greeting.');
    assert.ok(id);
    assert.equal(api.getStatus().jobs.find((job) => job.id === id).sendRequested, true, 'Submitting a VS Code prompt must request Gemini Send.');
    assert.match(api.getStatus().jobs.find((job) => job.id === id).prompt, /READ-ONLY attachment/);
    await stage(id, '"new"');
    assert.equal(document.getText(), original, 'A proposal must not edit the file.');
    assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'gemini-edit');
    await vscode.commands.executeCommand('geminiEdit.accept');
    assert.equal(document.getText(), 'const greeting = "new";\n');
    assert.equal(api.getStatus().jobs.find((job) => job.id === id).status, 'applied');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original, 'Accept must support Undo.');

    editor = await vscode.window.showTextDocument(document);
    select();
    const rejectedId = await vscode.commands.executeCommand('geminiEdit.edit', 'Try a different greeting.');
    await stage(rejectedId, '"rejected"');
    const rejectedUri = vscode.window.activeTextEditor.document.uri;
    await vscode.commands.executeCommand('geminiEdit.reject');
    assert.equal(document.getText(), original);
    assert.equal(api.getStatus().jobs.find((job) => job.id === rejectedId).status, 'rejected');

    editor = await vscode.window.showTextDocument(document);
    select();
    const separateId = await vscode.commands.executeCommand('geminiEdit.edit', 'A separate proposal.');
    await stage(separateId, '"separate"');
    await vscode.commands.executeCommand('geminiEdit.accept', rejectedUri);
    assert.equal(document.getText(), original, 'An old diff must never accept a different proposal.');
    assert.equal(api.getStatus().jobs.find((job) => job.id === separateId).status, 'review');
    await vscode.commands.executeCommand('geminiEdit.reject');

    editor = await vscode.window.showTextDocument(document);
    select();
    const staleId = await vscode.commands.executeCommand('geminiEdit.edit', 'Change it again.');
    const delivery = await request(`/v1/jobs/${staleId}/delivery`, { tabId: 42, url: 'https://gemini.google.com/app/test' });
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '// newer work\n'));
    const stale = await request(`/v1/jobs/${staleId}/response`, { deliveryId: delivery.data.delivery.id, tabId: 42, url: 'https://gemini.google.com/app/test', text: '"bad"' });
    assert.equal(stale.status, 409);
    assert.equal(api.getStatus().jobs.find((job) => job.id === staleId).status, 'stale');
    assert.equal(document.getText(), '// newer work\n' + original);

    editor = await vscode.window.showTextDocument(document);
    const end = document.positionAt(document.getText().length);
    editor.selection = new vscode.Selection(end, end);
    const insertId = await vscode.commands.executeCommand('geminiEdit.edit', 'Add a comment.');
    await stage(insertId, '// inserted\n');
    await vscode.commands.executeCommand('geminiEdit.accept');
    assert.equal(document.getText(), '// newer work\n' + original + '// inserted\n');

    // Continue entirely from the browser after accepting a selection whose
    // replacement changed its length. The next diff must use the new range.
    editor = await vscode.window.showTextDocument(document);
    const prefix = '// newer work\n' + original;
    editor.selection = new vscode.Selection(document.positionAt(prefix.length), document.positionAt(document.getText().length));
    const browserStartId = await vscode.commands.executeCommand('geminiEdit.edit', 'Rewrite the trailing comment.');
    await stage(browserStartId, '// a much longer accepted comment\n');
    await vscode.commands.executeCommand('geminiEdit.accept');
    assert.equal(document.getText(), prefix + '// a much longer accepted comment\n');
    const parent = api.getStatus().jobs.find((job) => job.id === browserStartId);
    const followup = await request('/v1/import', { sourceJobId: parent.id, deliveryId: parent.delivery.id, tabId: 42, url: 'https://gemini.google.com/app/test',
      text: '// browser follow-up\n', responseKey: 'browser-turn-1:0', chatRequestId: browserStartId });
    assert.equal(followup.status, 200, JSON.stringify(followup.data));
    assert.notEqual(followup.data.job.id, browserStartId);
    assert.equal(followup.data.job.chatRequestId, browserStartId);
    assert.equal(document.getText(), prefix + '// a much longer accepted comment\n', 'A browser follow-up must still require accepting its diff.');
    await vscode.commands.executeCommand('geminiEdit.accept');
    assert.equal(document.getText(), prefix + '// browser follow-up\n', 'The full accepted range must be replaced without leaving old trailing characters.');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), prefix + '// a much longer accepted comment\n');
    const staleFollowup = await request('/v1/import', { sourceJobId: followup.data.job.id, deliveryId: followup.data.job.delivery.id, tabId: 42,
      url: 'https://gemini.google.com/app/test', text: '// must not overwrite the undo\n', responseKey: 'browser-turn-2:0' });
    assert.equal(staleFollowup.status, 409, 'An undo must invalidate the saved continuation snapshot.');

    // Import code from a chat that has never received a VS Code prompt. The
    // explicit one-shot target command avoids an interactive picker in tests.
    editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(document.positionAt(prefix.length), document.positionAt(document.getText().length));
    await vscode.commands.executeCommand('geminiEdit.setTarget');
    const direct = await request('/v1/import', { tabId: 42, url: 'https://gemini.google.com/app/direct-chat', text: '// direct Gemini prompt\n', responseKey: 'direct-turn:0' });
    assert.equal(direct.status, 200, JSON.stringify(direct.data));
    assert.equal(direct.data.job.chatRequestId, null);
    assert.equal(direct.data.job.origin, 'gemini');
    assert.equal(document.getText(), prefix + '// a much longer accepted comment\n');
    await vscode.commands.executeCommand('geminiEdit.accept');
    assert.equal(document.getText(), prefix + '// direct Gemini prompt\n');
    await vscode.commands.executeCommand('geminiEdit.clearContext');
    assert.equal(api.getStatus().attachments, 0);
    await document.save();
    report({ ok: true });
  } catch (error) { report({ ok: false, error: error.stack || error.message }); throw error; }
  finally { await vscode.env.clipboard.writeText(previousClipboard); }
}

module.exports = { run };
