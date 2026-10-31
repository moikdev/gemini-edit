'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-edit-vscode-'));
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'geminiEdit.port': 18373 }));
const code = process.env.VSCODE_PATH || 'code';
const env = { ...process.env, GEMINI_EDIT_TEST_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(code, [
  '--wait', '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  '--user-data-dir', path.join(temp, 'user'), '--extensions-dir', path.join(temp, 'extensions'),
  `--extensionDevelopmentPath=${path.join(root, 'extensions/vscode')}`,
  `--extensionTestsPath=${path.join(root, 'tests/vscode/index.js')}`, workspace
], { env, stdio: 'inherit' });
const timer = setTimeout(() => { console.error('VS Code smoke test timed out.'); child.kill(); process.exitCode = 1; }, 60000);
child.on('error', (error) => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
child.on('close', (exitCode) => {
  clearTimeout(timer);
  const report = path.join(temp, 'results.json');
  if (fs.existsSync(report)) {
    const results = JSON.parse(fs.readFileSync(report));
    console.log(results.ok ? 'PASS VS Code: capture → bridge → diff → accept → undo; reject; stale edits; insertion; browser-only imports and follow-ups using the updated accepted range.' : `FAIL VS Code: ${results.error}`);
    if (!results.ok) process.exitCode = 1;
  } else { console.error('VS Code did not report test results. Check that the code CLI is available.'); process.exitCode = 1; }
  if (exitCode) process.exitCode = exitCode;
  if (process.exitCode) console.error(`Test logs retained at ${temp}`);
  else fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
