'use strict';
/* Dependency-free scan of tracked text files. It complements, not replaces, GitHub secret scanning. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const allowed = new Set(['123456:TEST_TOKEN_not_real']);
const findings = [];
let names;
try { names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); }
catch { names = []; }
for (const name of names) {
  const file = path.join(root, name);
  if (!fs.existsSync(file) || fs.statSync(file).size > 1024 * 1024 || /\.(png|jpe?g|webp|mp4|ico|zip|pdf)$/i.test(name)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\0')) continue;
  for (const match of text.matchAll(/\b\d{5,}:[A-Za-z0-9_-]{18,}\b/g)) {
    if (!allowed.has(match[0]) && !/replace|example|placeholder/i.test(match[0])) findings.push(`${name}: possible Telegram token`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push(`${name}: private key`);
  for (const match of text.matchAll(/^PAY_DETAILS[ \t]*=[ \t]*([^\r\n]+)$/gm)) {
    const value = match[1].trim();
    if (value && !/^(?:["']?)(?:test|example|placeholder|your_)/i.test(value)) findings.push(`${name}: non-empty PAY_DETAILS`);
  }
}
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`Secret scan OK: ${names.length} tracked files checked`);
