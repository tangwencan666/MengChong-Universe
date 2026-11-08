'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const config = require('../electron-builder.config.cjs');

function buildEnvironment(source) {
  const candidates = Object.create(null);
  for (const name of Object.keys(source).filter(name => !/^(?:GH_|GITHUB_|CSC_|WIN_CSC_|AWS_|AZURE_|S3_|DO_|NPM_TOKEN$)/i.test(name))) {
    Object.defineProperty(candidates, name, { enumerable: true, get: () => source[name] });
  }
  return { ...desktopEnvironment(candidates), CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
}
async function main() {
  if (!process.argv.includes('--build-local-unsigned')) throw new Error('Explicit --build-local-unsigned required; no installation or publication is performed');
  const desktop = path.resolve(__dirname,'..');
  // Re-exec before importing builder so signing/publishing/model values are unavailable.
  if (!process.argv.includes('--filtered-build-child')) {
    const result = await promisify(execFile)(process.execPath,[__filename,'--build-local-unsigned','--filtered-build-child'],
      { cwd: desktop, env: buildEnvironment(process.env), windowsHide:true, maxBuffer:2*1024*1024 });
    process.stdout.write(result.stdout); return;
  }
  for (const file of ['electron-builder.env','.env','.env.local']) {
    try { await fs.access(path.join(desktop,file)); throw new Error('Refusing an implicit build environment file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const execute = promisify(execFile);
  await execute(process.execPath,[path.join(desktop,'scripts/build-icon.cjs')],{cwd:desktop,env:process.env,windowsHide:true});
  const portable = await execute(process.execPath,[path.join(desktop,'scripts/package-portable.cjs')],
    {cwd:desktop,env:process.env,windowsHide:true,maxBuffer:2*1024*1024});
  const staging = JSON.parse(portable.stdout);
  const relative = path.relative(path.join(desktop,'out'), staging.output);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('WeiBiYe-win32-x64-')) throw new Error('Invalid staging package identity');
  const { build, Platform, Arch } = require('electron-builder');
  const metadata = JSON.parse(await fs.readFile(path.join(desktop,'package.json'),'utf8'));
  const output = path.join(desktop,'out','installer-' + randomUUID());
  const paths = await build({ projectDir:desktop, targets:Platform.WINDOWS.createTarget('nsis',Arch.x64), publish:'never',
    config:{...config, directories:{ app:path.join(staging.output,'resources/app'),output,buildResources:desktop },
      electronDist:path.join(desktop,'node_modules/electron/dist'),electronVersion:metadata.devDependencies.electron,
      extraMetadata:{productName:metadata.productName,description:'萌宠溜达 · 你的桌面 AI 宠物伙伴'} } });
  const files = [];
  for (const file of paths) {
    const bytes = await fs.readFile(file);
    files.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const evidence = { status:'UNSIGNED_LOCAL_INSTALLER_NOT_RELEASED', publication:false, installationExecuted:false,
    backendIncluded:false, output, files, stagedPortable:staging.output };
  await fs.writeFile(path.join(output,'LOCAL_BUILD_RESULT.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
  console.log(JSON.stringify(evidence,null,2));
}
if(require.main === module) main().catch(error => { console.error(String(error.message));process.exitCode=1; });
module.exports={buildEnvironment};
