'use strict';

// Offline packaging only. No dependency installation, script execution or download.
const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { loadServiceProfile } = require('../src/service-profile.cjs');

const root = path.resolve(__dirname, '..');
const frontend = path.resolve(root, '../frontend');
const ignoredOutput = path.join(root, 'out');
const forbidden = /^(?:\.env(?:\..*)?|\.venv|node_modules|backend|\.runtime|\.git|profile|cookies|credentials\.json|secrets(?:\..*)?)$/i;
const privateArtifact = /\.(?:db(?:-.*)?|sqlite3?(?:-.*)?|pem|key|pfx|p12|map|tsbuildinfo|log)$/i;

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function checkedDirectory(directory, boundary) {
  const absolute = path.resolve(directory);
  if (!inside(boundary, absolute)) throw new Error('Source path escaped its allowed boundary');
  let component = path.resolve(boundary);
  for (const name of ['', ...path.relative(component, absolute).split(path.sep).filter(Boolean)]) {
    if (name) component = path.join(component, name);
    const linkCheck = await fs.lstat(component);
    if (linkCheck.isSymbolicLink()) throw new Error('Refusing a symbolic link in a package path');
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Source directory must be a real directory');
  const real = await fs.realpath(absolute);
  if (!inside(boundary, real)) throw new Error('Source directory resolved outside its allowed boundary');
  return real;
}

async function collect(directory, destinationPrefix, options = {}) {
  const boundary = options.boundary ?? root;
  const base = await checkedDirectory(directory, boundary);
  const files = [];
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name);
      const stat = await fs.lstat(source);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error('Refusing a symbolic link in package sources');
      const real = await fs.realpath(source);
      if (!inside(base, real)) throw new Error('Packaged source escaped its directory');
      if (options.application && (forbidden.test(entry.name) || privateArtifact.test(entry.name))) {
        throw new Error('Private or temporary artifact found in application sources: ' + entry.name);
      }
      if (stat.isDirectory()) { await walk(source); continue; }
      if (!stat.isFile()) throw new Error('Only regular package files are supported');
      if (options.extensions && !options.extensions.includes(path.extname(entry.name).toLowerCase())) {
        throw new Error('Unexpected application artifact extension: ' + entry.name);
      }
      files.push({ source: real, destination: path.join(destinationPrefix, path.relative(base, real)), bytes: stat.size });
    }
  }
  await walk(base);
  return files;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function resolvePackage(name, fromDirectory) {
  if (!/^(?:@[a-z\d_.-]+\/)?[a-z\d_.-]+$/i.test(name)) throw new Error('Invalid dependency package name');
  let directory = fromDirectory;
  while (inside(frontend, directory)) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'));
    try { return await checkedDirectory(candidate, frontend); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory === frontend) break;
    directory = path.dirname(directory);
  }
  throw new Error('Installed frontend dependency missing: ' + name);
}

async function licenseInventory() {
  const direct = ['react', 'react-dom', 'react-router', '@tanstack/react-query', 'axios', 'lucide-react'];
  const queue = direct.map((name) => ({ name, from: frontend, recurse: true }));
  // These build tools contribute generated stylesheet/helper code; no build tools are executed or packaged.
  queue.push({ name: 'tailwindcss', from: frontend, recurse: false }, { name: 'vite', from: frontend, recurse: false });
  const seen = new Set();
  const files = [];
  const packages = [];
  while (queue.length) {
    const item = queue.shift();
    const directory = await resolvePackage(item.name, item.from);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const metadataFile = path.join(directory, 'package.json');
    const stat = await fs.lstat(metadataFile);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Invalid dependency metadata file');
    const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    if (metadata.name !== item.name || typeof metadata.version !== 'string') throw new Error('Dependency identity mismatch');
    const targetName = metadata.name.replace(/[^a-z\d_.-]/gi, '_') + '-' + metadata.version.replace(/[^a-z\d_.-]/gi, '_');
    const entries = await fs.readdir(directory);
    const names = entries.filter((name) => /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(name));
    let licenseInReadme = false;
    if (!names.length) {
      // Some npm packages ship their complete MIT text only inside README.md.
      // Preserve that entire actual installed document, never reconstruct a license.
      for (const name of entries.filter((entry) => /^readme(?:[._-].*)?$/i.test(entry))) {
        const source = path.join(directory, name);
        const info = await fs.lstat(source);
        if (info.isSymbolicLink()) throw new Error('Refusing symlinked dependency notice');
        if (!info.isFile()) continue;
        const content = await fs.readFile(source, 'utf8');
        if (/copyright/i.test(content) && /permission is hereby granted/i.test(content)
          && /the software is provided/i.test(content) && /without warranty/i.test(content)) {
          names.push(name);
          licenseInReadme = true;
          break;
        }
      }
    }
    const licenseNames = [];
    for (const name of names) {
      const source = path.join(directory, name);
      const info = await fs.lstat(source);
      if (info.isSymbolicLink()) throw new Error('Refusing symlinked dependency license');
      if (!info.isFile()) continue;
      const real = await fs.realpath(source);
      if (!inside(directory, real)) throw new Error('Dependency license escaped its package');
      licenseNames.push(name);
      files.push({ source: real, destination: path.join('resources/app/licenses', targetName, name), bytes: info.size });
    }
    if (!licenseNames.length) throw new Error('Actual license text missing for installed dependency: ' + item.name);
    packages.push({ name: metadata.name, version: metadata.version, declaredLicense: metadata.license ?? 'UNSPECIFIED',
      files: licenseNames, ...(licenseInReadme ? { completeLicenseTextInsideReadme: true } : {}) });
    if (item.recurse) {
      for (const name of Object.keys(metadata.dependencies ?? {})) queue.push({ name, from: directory, recurse: true });
    }
  }
  return { files, packages };
}

async function currentUiInventory() {
  // copy-ui deliberately leaves old ignored hashed assets untouched. Select only
  // files in the current Vite dist and prove the copied UI has identical bytes.
  const uiRoot = await checkedDirectory(path.join(root, 'ui-dist'), root);
  const current = await collect(path.join(frontend, 'dist'), path.join('resources/app', 'ui-dist'), {
    boundary: frontend, application: true, extensions: ['.html', '.js', '.css', '.svg', '.png', '.ico'],
  });
  const buildBase = await fs.realpath(path.join(frontend, 'dist'));
  const selected = [];
  for (const file of current) {
    const relative = path.relative(buildBase, file.source);
    const copied = path.join(uiRoot, relative);
    if (!inside(uiRoot, copied)) throw new Error('Built UI path escaped ui-dist');
    await checkedDirectory(path.dirname(copied), uiRoot);
    const info = await fs.lstat(copied);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Copied current UI file is missing or unsafe');
    const real = await fs.realpath(copied);
    if (!inside(uiRoot, real)) throw new Error('Copied current UI resolved outside ui-dist');
    if (await sha256(file.source) !== await sha256(real)) {
      throw new Error('Current frontend build differs from copied UI; run build:ui again');
    }
    selected.push({ ...file, source: real });
  }
  return selected;
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This preview packager requires Windows x64');
  const rootReal = await checkedDirectory(root, path.dirname(root));
  if (!inside(rootReal, path.resolve(__dirname))) throw new Error('Packager resolved outside desktop project');
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const runtime = path.join(root, 'node_modules/electron/dist');
  const runtimeVersion = (await fs.readFile(path.join(runtime, 'version'), 'utf8')).trim();
  if (runtimeVersion !== metadata.devDependencies?.electron) throw new Error('Installed Electron does not match the reviewed exact version');
  const runtimeFiles = await collect(runtime, '', { boundary: root, application: true });
  if (!runtimeFiles.some((entry) => entry.destination === 'electron.exe')
    || !runtimeFiles.some((entry) => entry.destination === 'LICENSE')
    || !runtimeFiles.some((entry) => entry.destination === 'LICENSES.chromium.html')) {
    throw new Error('Electron runtime or required runtime license files are incomplete');
  }
  const files = [...runtimeFiles];
  for (const [folder, extensions] of [
    ['src', ['.cjs']], ['renderer', ['.html', '.js', '.css']],
    ['assets', ['.svg', '.png', '.json', '.md', '.ico']],
  ]) files.push(...await collect(path.join(root, folder), path.join('resources/app', folder), { application: true, extensions }));
  files.push(...await currentUiInventory());
  if (!files.some((entry) => entry.destination === path.join('resources/app/ui-dist', 'index.html'))) {
    throw new Error('Built React UI is missing');
  }
  const notice = path.join(root, 'THIRD_PARTY_NOTICES.md');
  const noticeStat = await fs.lstat(notice);
  if (!noticeStat.isFile() || noticeStat.isSymbolicLink()) throw new Error('Third-party notice is missing or unsafe');
  files.push({ source: notice, destination: path.join('resources/app', 'THIRD_PARTY_NOTICES.md'), bytes: noticeStat.size });
  const licenses = await licenseInventory();
  files.push(...licenses.files);
  await fs.mkdir(ignoredOutput, { recursive: true });
  await checkedDirectory(ignoredOutput, root);
  const totalInputBytes = files.reduce((total, file) => total + file.bytes, 0);
  const disk = await fs.statfs(ignoredOutput);
  if (Number(disk.bavail) * Number(disk.bsize) < totalInputBytes + 64 * 1024 * 1024) {
    throw new Error('Insufficient free disk space for a new portable package');
  }
  const id = randomUUID();
  const target = path.join(ignoredOutput, 'WeiBiYe-win32-x64-' + id);
  if (!inside(ignoredOutput, target)) throw new Error('Output path escaped desktop/out');
  await fs.mkdir(target, { recursive: false });
  const manifest = [];
  for (const entry of files) {
    const relative = entry.destination === 'electron.exe' ? 'WeiBiYe.exe' : entry.destination;
    const destination = path.join(target, relative);
    if (!inside(target, destination)) throw new Error('Output file escaped its unique package');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const before = await fs.lstat(entry.source);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Package source changed during copy');
    const sourceHash = await sha256(entry.source);
    await fs.copyFile(entry.source, destination, constants.COPYFILE_EXCL);
    const targetHash = await sha256(destination);
    if (sourceHash !== targetHash) throw new Error('Package file integrity verification failed');
    manifest.push({ path: relative.split(path.sep).join('/'), bytes: (await fs.stat(destination)).size, sha256: targetHash });
  }
  const application = { name: metadata.name, version: metadata.version, main: 'src/main.cjs', productName: metadata.productName,
    description: '萌宠溜达 · 你的桌面 AI 宠物伙伴', author: metadata.author };
  const generated = [
    ['resources/app/package.json', JSON.stringify(application, null, 2) + '\n'],
    ['resources/app/licenses/DEPENDENCIES.json', JSON.stringify({ packages: licenses.packages }, null, 2) + '\n'],
    ['resources/app/ui-dist/UI_ASSETS.json', JSON.stringify({ version: 1, files: manifest
      .filter(entry => entry.path.startsWith('resources/app/ui-dist/'))
      .map(entry => ({ path: entry.path.slice('resources/app/ui-dist/'.length), bytes: entry.bytes, sha256: entry.sha256 })) }) + '\n'],
    ['resources/app/release-policy.json', await fs.readFile(path.join(root, 'release-policy.json'), 'utf8')],
    ['resources/app/service-profile.json', JSON.stringify(loadServiceProfile(root)) + '\n'],
  ];
  for (const [relative, content] of generated) {
    const destination = path.join(target, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { flag: 'wx' });
    manifest.push({ path: relative, bytes: Buffer.byteLength(content), sha256: await sha256(destination) });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const result = {
    schemaVersion: 1, createdAt: new Date().toISOString(), appVersion: metadata.version,
    electronVersion: runtimeVersion, platform: 'win32-x64', executable: 'WeiBiYe.exe',
    status: 'UNSIGNED_LOCAL_DEVELOPMENT_PREVIEW', backendIncluded: false,
    fileCount: manifest.length, totalBytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
    manifestExcludesItself: true, files: manifest,
  };
  const manifestPath = path.join(target, 'PACKAGE_MANIFEST.json');
  await fs.writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  const manifestHash = await sha256(manifestPath);
  const evidenceRoot = path.join(root, '.runtime', 'packaging');
  await fs.mkdir(evidenceRoot, { recursive: true });
  await checkedDirectory(evidenceRoot, root);
  const evidence = { output: target, manifestSha256: manifestHash, fileCount: result.fileCount,
    totalBytes: result.totalBytes, electronVersion: runtimeVersion, createdAt: result.createdAt,
    dependencyLicenseCount: licenses.packages.length };
  await fs.writeFile(path.join(evidenceRoot, id + '.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
}

main().catch((error) => {
  // Messages contain only source category/file names; never environment values or private application data.
  process.stderr.write('Portable preview packaging failed: ' + error.message + '\n');
  process.exitCode = 1;
});
