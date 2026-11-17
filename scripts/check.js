'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = [];
for (const dir of ['server', 'tests']) {
  for (const name of fs.readdirSync(path.join(root, dir))) if (name.endsWith('.js')) files.push(path.join(dir, name));
}
files.push('public/app.js', 'public/i18n.js');
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
JSON.parse(fs.readFileSync(path.join(root, 'public', 'config.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`Syntax OK: ${files.length} JavaScript files; JSON OK`);
