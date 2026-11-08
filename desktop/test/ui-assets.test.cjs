'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadCurrentUi } = require('../src/ui-assets.cjs');
const { profileDirectory } = require('../src/app-profile.cjs');
async function fixture(t) {
  const prefix = path.join(await fs.realpath(os.tmpdir()), 'weibiye-ui-');
  const dir = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok((await fs.realpath(dir)).startsWith(prefix)); await fs.rm(dir, { recursive: true, force: true }); });
  const content = Buffer.from('<p>current build</p>');
  await fs.writeFile(path.join(dir, 'index.html'), content);
  const entry = { path: 'index.html', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  return { dir, entry, manifest: files => fs.writeFile(path.join(dir, 'UI_ASSETS.json'), JSON.stringify({ version: 1, files })) };
}
test('only current build assets are loaded while historical generated files remain untouched', async t => {
  const f = await fixture(t); await f.manifest([f.entry]);
  await fs.writeFile(path.join(f.dir, 'old-bundle.js'), 'old');
  const files = new Map(); assert.equal(await loadCurrentUi(f.dir, files), true);
  assert.deepEqual([...files.keys()], ['/index.html']);
  assert.equal(await fs.readFile(path.join(f.dir, 'old-bundle.js'), 'utf8'), 'old');
});
test('missing inventory supports legacy fixtures; corrupted or escaped inventories fail closed', async t => {
  const f = await fixture(t); assert.equal(await loadCurrentUi(f.dir, new Map()), false);
  for (const entry of [{ ...f.entry, path: '../outside.html' }, { ...f.entry, sha256: '0'.repeat(64) }, { ...f.entry, bytes: 0 }]) {
    await f.manifest([entry]); await assert.rejects(loadCurrentUi(f.dir, new Map()));
  }
  await f.manifest([f.entry, f.entry]); await assert.rejects(loadCurrentUi(f.dir, new Map()));
});
test('installed profiles stay outside install directory and development/explicit profiles retain compatibility', () => {
  const root = path.resolve('install/resources/app'), appData = path.resolve('user/appdata');
  assert.equal(profileDirectory({ packaged: true, appData, rootDir: root }), path.join(appData, 'WeiBiYe'));
  assert.equal(profileDirectory({ packaged: false, appData, rootDir: root }), path.join(root, '.runtime/profile'));
  assert.equal(profileDirectory({ explicit: path.resolve('explicit'), packaged: true, appData, rootDir: root }), path.resolve('explicit'));
  assert.throws(() => profileDirectory({ explicit: 'relative', packaged: true, appData, rootDir: root }));
});
