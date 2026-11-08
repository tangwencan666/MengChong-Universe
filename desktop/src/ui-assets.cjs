'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function loadCurrentUi(directory, files) {
  const base = await fs.realpath(directory);
  const manifestPath = path.join(base, 'UI_ASSETS.json');
  let manifest;
  try {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Invalid UI inventory');
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1024) throw new Error('Invalid UI inventory');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.length > 240 || !/^[a-z0-9_./-]+$/i.test(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || !TYPES[path.extname(entry.path)] || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 8 * 1024 * 1024
      || seen.has(entry.path)) throw new Error('Invalid UI inventory entry');
    seen.add(entry.path);
    let source = base;
    for (const component of entry.path.split('/')) {
      source = path.join(source, component);
      if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Linked UI resource');
    }
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size !== entry.bytes) throw new Error('UI inventory size mismatch');
    const bytes = await fs.readFile(source);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('UI inventory hash mismatch');
    files.set('/' + entry.path, { bytes, type: TYPES[path.extname(entry.path)] });
  }
  if (!seen.has('index.html')) throw new Error('UI inventory lacks entry point');
  return true;
}
module.exports = { loadCurrentUi };
