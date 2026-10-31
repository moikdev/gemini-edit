'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let count = 0;
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(filename);
    else if (entry.name.endsWith('.js')) {
      new vm.Script(fs.readFileSync(filename, 'utf8'), { filename });
      count++;
    } else if (entry.name.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (entry.name === 'package.json') {
        for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          if (Object.keys(data[key] || {}).length) throw new Error(`${filename}: third-party dependencies are not allowed.`);
        }
      }
      count++;
    }
  }
}
visit(root);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/chrome/manifest.json')));
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, ...manifest.content_scripts.flatMap((entry) => entry.js)]) {
  if (!fs.existsSync(path.join(root, 'extensions/chrome', file))) throw new Error(`Missing Chrome asset: ${file}`);
}
console.log(`Checked ${count} JavaScript / JSON files. Zero third-party dependencies.`);
