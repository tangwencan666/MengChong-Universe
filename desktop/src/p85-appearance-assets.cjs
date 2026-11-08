'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto');
const { createCatalog } = require('../renderer/pet-appearance.js');
const catalog = createCatalog(require('../assets/p85-appearances.json'));
const BUDGET = 256 * 1024;
async function registerAppearanceAssets(rootDir, resources, { budget = BUDGET, catalog: assetCatalog = catalog } = {}) {
    if (!Number.isSafeInteger(budget) || budget < 131072 || budget > BUDGET)
        throw Error('Invalid local asset budget');
    const folder = path.resolve(rootDir, 'local-preview/p85-eight-v1'), cache = new Map(), pending = new Map();
    let bytes = 0, loads = 0, rejected = 0, disposed = false, available = false;
    try {
        for (const directory of [path.resolve(rootDir), path.resolve(rootDir, 'local-preview'), folder]) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw Error('Unsafe local appearance directory');
        }
        available = await fs.realpath(folder) === folder;
    }
    catch {
        available = false;
    }
    async function read(name) {
        if (disposed || !available || !assetCatalog.file(name))
            throw Error('Local view unavailable');
        if (cache.has(name)) {
            const value = cache.get(name);
            cache.delete(name);
            cache.set(name, value);
            return value;
        }
        if (pending.has(name))
            return pending.get(name);
        const task = (async () => {
            try {
                const file = path.join(folder, name), expected = assetCatalog.file(name), stat = await fs.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes || stat.size > 131072 || await fs.realpath(file) !== file)
                    throw Error('Unverified local view');
                const data = await fs.readFile(file);
                if (disposed || data.length !== expected.bytes || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
                    || data.readUInt32BE(16) !== expected.width || data.readUInt32BE(20) !== expected.height
                    || createHash('sha256').update(data).digest('hex') !== expected.sha256)
                    throw Error('Local view identity changed');
                while (cache.size && bytes + data.length > budget) {
                    const oldest = cache.keys().next().value;
                    bytes -= cache.get(oldest).length;
                    cache.delete(oldest);
                }
                cache.set(name, data);
                bytes += data.length;
                loads++;
                return data;
            }
            catch (error) {
                rejected++;
                throw error;
            }
        })();
        pending.set(name, task);
        try {
            return await task;
        }
        finally {
            pending.delete(name);
        }
    }
    if (available)
        for (const name of assetCatalog.files())
            resources.set('/__assets/' + name, { type: 'image/png', read: () => read(name) });
    return { get stats() { return { available, bytes, entries: cache.size, pending: pending.size, loads, rejected, budget }; }, close() { disposed = true; cache.clear(); bytes = 0; } };
}
module.exports = { registerAppearanceAssets, catalog, BUDGET };
