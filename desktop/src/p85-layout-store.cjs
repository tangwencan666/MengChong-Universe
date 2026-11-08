'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { key } = require('./position-store.cjs');
const { UUID } = require('./policy.cjs');
const NAMESPACE = '85000000-0000-4000-8000-000000000001', MAX_BYTES = 65536;
function validList(value) { return Array.isArray(value) && value.length <= 5 && new Set(value.map(p => p?.pet_id)).size === value.length && value.every(p => p && Object.keys(p).sort().join('|') === 'hidden|pet_id' && UUID.test(p.pet_id) && p.pet_id === p.pet_id.toLowerCase() && typeof p.hidden === 'boolean'); }
function createLayoutStore(directory) {
    const file = directory ? path.join(directory, 'pet-layout-v1.json') : null;
    let entries = {}, healthy = true, dirty = false;
    if (file) {
        if (!path.isAbsolute(directory))
            throw Error('Absolute profile required');
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
                throw Error('Unsafe layout');
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (data.version !== 1 || Object.keys(data).sort().join('|') !== 'entries|version' || !data.entries || Array.isArray(data.entries) || Object.keys(data.entries).length > 32
                || !Object.entries(data.entries).every(([id, value]) => /^[a-f0-9]{64}$/.test(id) && value && Object.keys(value).sort().join('|') === 'current|previous' && validList(value.current) && validList(value.previous)))
                throw Error('Invalid layout');
            entries = data.entries;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                healthy = false;
        }
    }
    function get(owner) { return structuredClone(entries[key(owner, NAMESPACE)] ?? { current: [], previous: [] }); }
    return {
        get healthy() { return healthy; }, get,
        set(owner, patch) {
            if (!healthy)
                return false;
            if (!patch || Object.keys(patch).some(name => !['current', 'previous'].includes(name)) || !Object.values(patch).every(validList))
                throw Error('Invalid layout patch');
            const id = key(owner, NAMESPACE), next = { ...get(owner), ...structuredClone(patch) };
            if (JSON.stringify(entries[id]) === JSON.stringify(next))
                return true;
            delete entries[id];
            entries[id] = next;
            while (Object.keys(entries).length > 32)
                delete entries[Object.keys(entries)[0]];
            dirty = true;
            return true;
        },
        flush() {
            if (!healthy || !dirty || !file)
                return healthy;
            const temporary = file + '.' + randomUUID() + '.tmp';
            try {
                const body = JSON.stringify({ version: 1, entries });
                if (Buffer.byteLength(body) > MAX_BYTES)
                    throw Error('Layout budget');
                fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
                fs.renameSync(temporary, file);
                dirty = false;
                return true;
            }
            catch {
                try {
                    fs.unlinkSync(temporary);
                }
                catch { }
                return false;
            }
        },
    };
}
module.exports = { createLayoutStore, validList, MAX_BYTES };
