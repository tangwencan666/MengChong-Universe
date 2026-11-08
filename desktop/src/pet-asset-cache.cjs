'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { registry } = require('./pet-registry.cjs');
async function registerPetAssets(directory, resources, { budget = 32768 } = {}) {
    const root = await fs.realpath(directory), cache = new Map(), pending = new Map();
    let bytes = 0, disposed = false, loads = 0;
    const names = new Set(registry.assetFiles().filter(name => name.startsWith('p84-')));
    async function read(name) {
        if (disposed || !names.has(name))
            throw Error('Unknown or disposed pet resource');
        if (cache.has(name)) {
            const value = cache.get(name);
            cache.delete(name);
            cache.set(name, value);
            return value;
        }
        if (pending.has(name))
            return pending.get(name);
        const promise = (async () => {
            const file = path.join(root, name), stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.size > budget || await fs.realpath(file) !== file)
                throw Error('Unsafe pet resource');
            const value = await fs.readFile(file);
            if (value.length !== stat.size || disposed)
                throw Error('Changed pet resource');
            while (cache.size && bytes + value.length > budget) {
                const first = cache.keys().next().value;
                bytes -= cache.get(first).length;
                cache.delete(first);
            }
            cache.set(name, value);
            bytes += value.length;
            loads++;
            return value;
        })();
        pending.set(name, promise);
        try {
            return await promise;
        }
        finally {
            pending.delete(name);
        }
    }
    for (const name of await fs.readdir(root))
        if (names.has(name))
            resources.set('/__assets/' + name, { type: 'image/svg+xml', read: () => read(name) });
    return { get stats() { return { bytes, entries: cache.size, pending: pending.size, loads, budget }; }, close() { disposed = true; cache.clear(); bytes = 0; } };
}
module.exports = { registerPetAssets };
