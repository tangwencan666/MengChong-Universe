'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
async function main() {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, '../frontend/dist');
  const target = path.join(root, 'ui-dist');
  const files = [];
  if (!(await fs.stat(path.join(source,'index.html'))).isFile()) throw new Error('Run the existing frontend build first.');
  // Only copy generated public assets; no source, environment, database, cache or credentials.
  async function copy(directory) {
    for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if (entry.isSymbolicLink()) throw new Error('Symlink in built assets.');
      const input = path.join(directory,entry.name);
      if (entry.isDirectory()) { await copy(input); continue; }
      if (!/\.(html|js|css|svg|png|ico)$/.test(entry.name)) continue;
      const output = path.join(target,path.relative(source,input));
      await fs.mkdir(path.dirname(output),{recursive:true});
      await fs.copyFile(input,output);
      const bytes = await fs.readFile(input);
      files.push({ path: path.relative(source, input).split(path.sep).join('/'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  await copy(source);
  const temporary = path.join(target, 'UI_ASSETS.' + randomUUID() + '.tmp');
  await fs.writeFile(temporary, JSON.stringify({ version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)) }), { flag: 'wx' });
  await fs.rename(temporary, path.join(target, 'UI_ASSETS.json'));
  console.log('Copied generated React assets into desktop/ui-dist.');
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
