'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash, randomUUID } = require('node:crypto');
const { validate, LIMITS } = require('./p86-society.cjs');
function createSocietyStore(directory) {
    const memory = new Map();
    let healthy = true;
    const folder = directory ? path.join(directory, 'pet-society-v1') : null;
    function file(owner) { if (!/^[a-f0-9-]{36}$/.test(owner))
        throw Error('Invalid owner'); return path.join(folder, createHash('sha256').update('p86:' + owner).digest('hex') + '.json'); }
    function checkFolder() { if (!folder)
        return; if (!path.isAbsolute(directory))
        throw Error('Absolute profile required'); const parent = fs.lstatSync(directory); if (!parent.isDirectory() || parent.isSymbolicLink())
        throw Error('Unsafe profile'); if (!fs.existsSync(folder))
        fs.mkdirSync(folder); const stat = fs.lstatSync(folder); if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Unsafe society directory'); }
    return {
        load(owner) { try {
            if (!folder)
                return memory.has(owner) ? structuredClone(memory.get(owner)) : null;
            checkFolder();
            const name = file(owner);
            if (!fs.existsSync(name))
                return null;
            const stat = fs.lstatSync(name);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes)
                throw Error('Unsafe society file');
            return validate(JSON.parse(fs.readFileSync(name, 'utf8')), owner);
        }
        catch {
            healthy = false;
            return null;
        } },
        save(owner, data) { if (!healthy)
            return false; validate(data, owner); if (!folder) {
            memory.set(owner, structuredClone(data));
            return true;
        } let temp; try {
            checkFolder();
            const name = file(owner), raw = JSON.stringify(data);
            if (fs.existsSync(name)) {
                const stat = fs.lstatSync(name);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes)
                    throw Error('Unsafe society file');
                if (fs.readFileSync(name, 'utf8') === raw)
                    return true;
            }
            temp = name + '.' + randomUUID() + '.tmp';
            fs.writeFileSync(temp, raw, { flag: 'wx', mode: 0o600 });
            fs.renameSync(temp, name);
            return true;
        }
        catch {
            healthy = false;
            return false;
        } },
        get healthy() { return healthy; },
    };
}
module.exports = { createSocietyStore };
