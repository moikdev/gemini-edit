'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zip } = require('./zip');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/vscode/package.json')));
const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/chrome/manifest.json')));
function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const filename = path.join(dir, entry.name);
    const name = prefix + entry.name;
    return entry.isDirectory() ? files(filename, name + '/') : [[name, fs.readFileSync(filename)]];
  });
}
fs.mkdirSync(dist, { recursive: true });
const vsix = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'],
  ['extension.vsixmanifest', `<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/><DisplayName>${manifest.displayName}</DisplayName><Description xml:space="preserve">${manifest.description}</Description><Tags>gemini,editor</Tags><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="false"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/></Assets></PackageManifest>`],
  ...files(path.join(root, 'extensions/vscode'), 'extension/'),
  ['extension/README.md', fs.readFileSync(path.join(root, 'README.md'))],
  ['extension/LICENSE.txt', fs.readFileSync(path.join(root, 'LICENSE'))]
];
fs.writeFileSync(path.join(dist, `gemini-edit-${manifest.version}.vsix`), zip(vsix));
fs.writeFileSync(path.join(dist, `gemini-edit-chrome-${chromeManifest.version}.zip`), zip(files(path.join(root, 'extensions/chrome'))));
console.log(`Built dist/gemini-edit-${manifest.version}.vsix`);
console.log(`Built dist/gemini-edit-chrome-${chromeManifest.version}.zip (unzip, then Load unpacked in Chrome)`);
