'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { key } = require('./position-store.cjs');
function valid(value) { return value && Object.keys(value).sort().join('|') === 'autoMove|random|sleeping' && Object.values(value).every(v => typeof v === 'boolean'); }
function createPreferences(directory) {
    const file = directory ? path.join(directory, 'pet-behavior-v1.json') : null;
    let entries = {}, healthy = true, dirty = false;
    if (file) {
        if (!path.isAbsolute(directory))
            throw Error('Absolute profile required');
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
                throw Error('Unsafe preferences');
            const value = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (value.version !== 1 || Object.keys(value).sort().join('|') !== 'entries|version' || !value.entries || Array.isArray(value.entries)
                || Object.keys(value.entries).length > 128 || !Object.entries(value.entries).every(([id, v]) => /^[a-f0-9]{64}$/.test(id) && valid(v)))
                throw Error('Invalid preferences');
            entries = value.entries;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                healthy = false;
        }
    }
    return {
        get healthy() { return healthy; },
        get(owner, pet) { return entries[key(owner, pet)] ? { ...entries[key(owner, pet)] } : {}; },
        set(owner, pet, value) {
            if (!valid(value))
                throw Error('Invalid preferences');
            if (!healthy)
                return false;
            const id = key(owner, pet);
            if (JSON.stringify(entries[id]) === JSON.stringify(value))
                return true;
            delete entries[id];
            entries[id] = { ...value };
            while (Object.keys(entries).length > 128)
                delete entries[Object.keys(entries)[0]];
            dirty = true;
            return true;
        },
        flush() {
            if (!healthy || !dirty || !file)
                return healthy;
            const temporary = file + '.' + randomUUID() + '.tmp';
            try {
                fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { flag: 'wx', mode: 0o600 });
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
        }
    };
}
module.exports = { createPreferences };
