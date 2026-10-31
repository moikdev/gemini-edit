'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-edit-browser-'));
try {
  const inline = (source) => source.replace(/<\/script/gi, '<\\/script');
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const script = (name) => `<script>${inline(read(name))}</script>`;
  const adapterHtml = read('tests/fixtures/gemini.html').replace('<!-- ADAPTER -->', script('extensions/chrome/gemini-adapter.js')).replace('<!-- TESTS -->', script('tests/fixtures/adapter-tests.js'));
  const panelFixture = (testFile, setup = '') => read('extensions/chrome/sidepanel.html')
    .replace('<link rel="stylesheet" href="sidepanel.css">', `<style>${read('extensions/chrome/sidepanel.css')}</style>`)
    .replace(/<script src="[^"]+" defer><\/script>/g, '')
    .replace('</body>', [setup, script('tests/fixtures/panel-runtime.js'), script('extensions/chrome/protocol.js'), script('extensions/chrome/page-client.js'), script('extensions/chrome/sidepanel.js'), script(testFile), '</body>'].join('\n'));
  const panelHtml = panelFixture('tests/fixtures/panel-tests.js');
  const reloadHtml = panelFixture('tests/fixtures/reload-tests.js', '<script>globalThis.panelFixtureOptions={queryFailures:1};</script>');
  const sendHtml = panelFixture('tests/fixtures/send-tests.js', '<script>globalThis.panelFixtureOptions={sendRequested:true,geminiBusy:true};</script>');
  let count = 0;
  for (const [name, html] of [['adapter', adapterHtml], ['panel', panelHtml], ['reload', reloadHtml], ['send', sendHtml]]) {
    const filename = path.join(temp, name + '.html');
    fs.writeFileSync(filename, html);
    const extra = name === 'panel' && process.env.GEMINI_EDIT_SCREENSHOT ? [`--screenshot=${process.env.GEMINI_EDIT_SCREENSHOT}`, '--window-size=400,1050', '--hide-scrollbars'] : [];
    const result = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(temp, 'profile-' + name)}`, '--virtual-time-budget=5000', ...extra, '--dump-dom', pathToFileURL(filename).href], { encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Chrome exited with ${result.status}.`);
    const output = /<pre id="test-results"[^>]*>([\s\S]*?)<\/pre>/.exec(result.stdout)?.[1];
    if (!output) throw new Error(`${name} fixture did not report its results.`);
    const parsed = JSON.parse(output.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    if (parsed.viewport && process.env.GEMINI_EDIT_SCREENSHOT) console.log('Panel viewport:', JSON.stringify(parsed.viewport));
    for (const entry of parsed.results) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.error ? ': ' + entry.error : ''}`);
    if (parsed.results.some((entry) => !entry.ok)) process.exitCode = 1;
    count += parsed.results.length;
  }
  if (!process.exitCode) console.log(`Passed ${count} adapter / side panel checks in real headless Chrome.`);
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
