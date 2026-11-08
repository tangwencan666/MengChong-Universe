'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
// Historical names may change. The original byte identity must never change.
function resolveSourceImage(original, expected, directory = path.join(os.homedir(), 'Desktop', '图片库')) {
    const root = path.resolve(directory);
    if (path.dirname(path.resolve(original)) !== root || !/^[a-f0-9]{64}$/.test(expected?.sha256) || !Number.isSafeInteger(expected.bytes))
        throw Error('Invalid source identity');
    const folder = fs.lstatSync(root);
    if (!folder.isDirectory() || folder.isSymbolicLink())
        throw Error('Source directory link refused');
    function matches(file) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw Error('Source file link refused');
        return stat.size === expected.bytes && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected.sha256;
    }
    if (fs.existsSync(original)) {
        if (!matches(original))
            throw Error('Original source content changed');
        return original;
    }
    const files = fs.readdirSync(root, { withFileTypes: true }).filter(f => f.isFile() && /\.(png|jpe?g)$/i.test(f.name))
        .map(f => path.join(root, f.name)).filter(matches);
    if (files.length !== 1)
        throw Error('Source identity absent or ambiguous');
    return files[0];
}
module.exports = { resolveSourceImage };
