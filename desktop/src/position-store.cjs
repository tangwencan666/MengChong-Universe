'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { UUID } = require('./policy.cjs');
const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 128;

function key(owner, pet) {
  if (!UUID.test(owner ?? '') || !UUID.test(pet ?? '')) throw new TypeError('Invalid position scope');
  return createHash('sha256').update(owner.toLowerCase() + ':' + pet.toLowerCase()).digest('hex');
}

function valid(value) {
  const area = value?.workArea;
  return value && Object.keys(value).sort().join('|') === 'displayId|workArea|x|y'
    && [value.x, value.y].every((n) => Number.isInteger(n) && Math.abs(n) <= 100000)
    && typeof value.displayId === 'string' && value.displayId.length <= 80
    && area && Object.keys(area).sort().join('|') === 'height|width|x|y'
    && [area.x, area.y, area.width, area.height].every((n) => Number.isInteger(n) && Math.abs(n) <= 100000)
    && area.width > 0 && area.height > 0;
}

function createPositionStore(directory) {
  if (!path.isAbsolute(directory)) throw new TypeError('Absolute profile directory required');
  const file = path.join(directory, 'pet-positions-v1.json');
  let positions = {}, healthy = true, dirty = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Unsafe position file');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || Object.keys(data).sort().join('|') !== 'positions|version'
      || !data.positions || Array.isArray(data.positions) || Object.keys(data.positions).length > MAX_ENTRIES
      || !Object.entries(data.positions).every(([id, value]) => /^[a-f0-9]{64}$/.test(id) && valid(value))) throw new Error('Invalid positions');
    positions = data.positions;
  } catch (error) {
    // Preserve malformed/linked existing files. Never overwrite unknown data.
    if (error.code !== 'ENOENT') healthy = false;
  }
  return {
    get healthy() { return healthy; },
    get(owner, pet) { const value = positions[key(owner, pet)]; return value ? structuredClone(value) : null; },
    set(owner, pet, value) {
      if (!valid(value)) throw new TypeError('Invalid saved placement');
      if (!healthy) return false;
      const id = key(owner, pet);
      if (JSON.stringify(positions[id]) === JSON.stringify(value)) return true;
      delete positions[id]; positions[id] = structuredClone(value);
      while (Object.keys(positions).length > MAX_ENTRIES) delete positions[Object.keys(positions)[0]];
      dirty = true; return true;
    },
    flush() {
      if (!healthy || !dirty) return healthy;
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        const data = JSON.stringify({ version: 1, positions });
        if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Position budget exceeded');
        fs.writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file); dirty = false; return true;
      } catch {
        try { fs.unlinkSync(temporary); } catch { /* Only our unique temporary file. */ }
        return false;
      }
    },
  };
}

module.exports = { createPositionStore, MAX_BYTES, MAX_ENTRIES, key };
