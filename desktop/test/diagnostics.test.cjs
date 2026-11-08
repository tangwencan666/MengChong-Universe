'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics, safeEvent, LIMIT } = require('../src/diagnostics.cjs');
function directory(t) {
  const base = fs.realpathSync(os.tmpdir()), prefix = path.join(base, 'weibiye-diag-');
  const folder = fs.mkdtempSync(prefix);
  t.after(() => { assert.ok(fs.realpathSync(folder).startsWith(prefix)); fs.rmSync(folder, { recursive: true, force: true }); });
  return folder;
}
test('diagnostics are off by default and never read unknown sensitive fields', t => {
  const root = directory(t), logger = createDiagnostics({ directory: root, version: '0.1.0' });
  assert.equal(logger.write('started'), false); assert.deepEqual(fs.readdirSync(root), []);
  const canary = { role: 'chat' };
  Object.defineProperty(canary, 'apiKey', { enumerable: true, get() { throw new Error('Sensitive getter read'); } });
  assert.equal(safeEvent('started', canary), null);
  for (const data of [{ reason: 'private prompt' }, { url: 'https://private' }, { role: 'secret' }, { windowCount: Infinity }, { token: 'private' }]) {
    assert.equal(safeEvent('renderer_gone', data), null);
  }
});
test('only bounded local event metadata is persisted, with bounded rotation', t => {
  const root = directory(t), logger = createDiagnostics({ directory: root, version: '0.1.0', enabled: true });
  assert.equal(logger.write('renderer_gone', { role: 'chat', reason: 'oom', petCount: 3 }), true);
  const file = path.join(root, 'diagnostics-v1/events.jsonl');
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(first).sort(), ['at', 'event', 'petCount', 'reason', 'role', 'schema', 'version']);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').repeat(Math.floor(LIMIT / fs.statSync(file).size)));
  assert.equal(logger.write('renderer_gone', { role: 'chat', reason: 'oom', petCount: 3 }), true);
  assert.ok(fs.statSync(file).size < 1024);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['events.1.jsonl', 'events.jsonl']);
  assert.ok(fs.statSync(path.join(path.dirname(file), 'events.1.jsonl')).size <= LIMIT);
});
