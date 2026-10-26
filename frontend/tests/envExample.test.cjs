const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Every process.env.EXPO_PUBLIC_* the app reads, in src/ and App.tsx (names in message text don't count).
function namesRead() {
  const names = new Set();
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  const app = path.join(ROOT, 'App.tsx');
  if (fs.existsSync(app)) files.push(app);
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/process\.env\.(EXPO_PUBLIC_\w+)/g)) names.add(match[1]);
  }
  return names;
}

// The non-comment lines of the committed example, as [name, value].
function exampleEntries() {
  return fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const at = line.indexOf('=');
      assert.ok(at > 0, `not a NAME=value line: ${line}`);
      return [line.slice(0, at).trim(), line.slice(at + 1)];
    });
}

test('.env.example lists exactly the EXPO_PUBLIC_* variables the app reads, each once with an empty value', () => {
  const entries = exampleEntries();
  const listed = entries.map(([name]) => name);
  assert.equal(new Set(listed).size, listed.length, 'a name is listed twice');
  assert.deepEqual([...listed].sort(), [...namesRead()].sort());
  assert.ok(listed.length > 0);
  for (const [name, value] of entries) assert.equal(value, '', `${name} must be empty`);
});
