'use strict';
// prepack: bundle the Python package (and the repo's README/LICENSE) into the npm tarball.
const fs = require('node:fs');
const path = require('node:path');

const pkg = path.join(__dirname, '..');
const repo = path.join(pkg, '..', '..');

fs.rmSync(path.join(pkg, 'python'), { recursive: true, force: true });
fs.cpSync(path.join(repo, 'htmldeck'), path.join(pkg, 'python', 'htmldeck'), {
  recursive: true,
  filter: (src) => path.basename(src) !== '__pycache__',
});
for (const name of ['README.md', 'LICENSE']) fs.copyFileSync(path.join(repo, name), path.join(pkg, name));
