'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const asar = require('@electron/asar');
async function main() {
  const root = path.resolve(__dirname, '..'), directory = path.resolve(process.argv[2] ?? '');
  const relative = path.relative(path.join(root, 'out'), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^installer-[a-f0-9-]+$/.test(relative)) throw new Error('Project-owned installer directory required');
  const build = JSON.parse(await fs.readFile(path.join(directory, 'LOCAL_BUILD_RESULT.json'), 'utf8'));
  if (build.output !== directory || build.publication !== false || build.installationExecuted !== false) throw new Error('Build identity mismatch');
  const archive = path.join(directory, 'win-unpacked/resources/app.asar');
  const list = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
  const forbidden = list.filter(name => name.split('/').some(part => /^(?:node_modules|backend|test|tests|profile|\.runtime|\.verification|\.env(?:\..*)?)$/i.test(part))
    || /\.(?:sqlite3?|db|key|pem|pfx|map|log)$/i.test(name));
  if (forbidden.length) throw new Error('Private/development artifact in package');
  const inventory = JSON.parse(asar.extractFile(archive, 'ui-dist/UI_ASSETS.json'));
  for (const entry of inventory.files) {
    const bytes = asar.extractFile(archive, path.join('ui-dist', ...entry.path.split('/')));
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Packaged UI differs from current inventory');
  }
  const uiFiles = list.filter(name => name.startsWith('/ui-dist/') && !name.endsWith('/UI_ASSETS.json') && !asar.statFile(archive, path.normalize(name.slice(1))).files);
  if (uiFiles.length !== inventory.files.length) throw new Error('Stale build resources included');
  const policy = JSON.parse(asar.extractFile(archive, 'release-policy.json'));
  if (policy.automaticUpdates !== false || policy.automaticPublication !== false || policy.feedUrl !== null || policy.uploadCrashDumps !== false) throw new Error('Release policy is not disabled');
  const icon = asar.extractFile(archive, 'assets/app.ico');
  if (icon.readUInt16LE(4) !== 7) throw new Error('Incomplete application icon');
  const files = [];
  for (const entry of build.files) {
    if (path.dirname(entry.file) !== directory) throw new Error('Artifact escaped build folder');
    const bytes = await fs.readFile(entry.file);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Installer artifact hash changed');
    files.push({ file: entry.file, bytes: bytes.length, sha256: entry.sha256 });
  }
  const evidence = { status: 'P82_INSTALLER_CONTENTS_VERIFIED_NOT_INSTALLED', archiveFiles: list.length,
    forbiddenEntries: forbidden, currentUiFiles: inventory.files.map(entry => entry.path), policy,
    iconFrames: 7, backendIncluded: false, signatureVerified: false, installationExecuted: false, files };
  const out = path.join(root, '../.verification/p82-phase2', 'package-review-' + randomUUID());
  await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, 'inspection.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...evidence, evidence: out }, null, 2));
}
main().catch(error => { console.error(String(error.message)); process.exitCode = 1; });
