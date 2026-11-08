'use strict';
// Installs ONLY two newly built packages with a random dedicated validation GUID.
// No production app identity, shared profile, elevation, publishing, or model calls.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const {randomUUID,createHash}=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {setTimeout:delay}=require('node:timers/promises');
const {buildEnvironment}=require('../scripts/package-installer.cjs');
const desktop=path.resolve(__dirname,'..'),root=path.dirname(desktop),execute=promisify(execFile);
async function freePort(){const server=net.createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const p=server.address().port;await new Promise(yes=>server.close(yes));return p;}
async function until(check,message,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(200);}throw Error(message);}
async function main(){
  if(!process.argv.includes('--execute-owned-validation'))throw Error('Explicit --execute-owned-validation required');
  if(!process.argv.includes('--filtered-child')){
    const {stdout}=await execute(process.execPath,[__filename,'--execute-owned-validation','--filtered-child',...process.argv.slice(2).filter(arg=>arg.startsWith('--reuse-build='))],{cwd:desktop,env:buildEnvironment(process.env),windowsHide:true,maxBuffer:4*1024*1024});process.stdout.write(stdout);return;
  }
  assert.equal(process.platform,'win32');
  const reuseFile=process.argv.find(arg=>arg.startsWith('--reuse-build='))?.slice('--reuse-build='.length);
  let reused;
  if(reuseFile){
    const source=path.resolve(reuseFile),folder=path.dirname(source);
    assert.equal(path.dirname(folder),path.join(root,'.verification/p83'));
    assert.match(path.basename(folder),/^install-[a-f0-9-]{36}$/);assert.equal(path.basename(source),'results.json');
    assert.equal(await fs.realpath(folder),folder);reused=JSON.parse(await fs.readFile(source,'utf8'));
    assert.equal(folder,reused.run);assert.equal(reused.appId,'com.weibiye.p83.validation.'+reused.guid.replaceAll('-',''));
    assert.match(reused.guid,/^[a-f0-9-]{36}$/);assert.deepEqual(reused.installers.map(a=>a.version),['0.1.0','0.1.1']);
    for(const artifact of reused.installers){
      assert.equal(artifact.file,path.join(folder,'build-'+artifact.version,'P83-validation-'+artifact.version+'-setup.exe'));
      assert.equal(createHash('sha256').update(await fs.readFile(artifact.file)).digest('hex'),artifact.sha256);
    }
  }
  const guid=reused?.guid??randomUUID(),appId='com.weibiye.p83.validation.'+guid.replaceAll('-','');
  const run=path.join(root,'.verification/p83','install-'+randomUUID()),installDir=path.join(run,'应用 安装'),profile=path.join(run,'profile');
  await fs.mkdir(run,{recursive:true});await fs.mkdir(profile);
  const results={status:'RUNNING',run,appId,guid,identity:'dedicated validation variant, not production appId',publicRelease:false,realModelRequests:0,checks:[],pids:[]};
  const save=()=>fs.writeFile(path.join(run,'results.json'),JSON.stringify(results,null,2));
  async function check(name,action){try{const detail=await action();results.checks.push({name,status:'passed',detail});console.log('PASS '+name);}catch(error){results.checks.push({name,status:'failed',error:String(error.message)});throw error;}finally{await save();}}
  const ps=async script=>JSON.parse((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $env:PSModulePath=\"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\"; "+script],{windowsHide:true,env:process.env})).stdout.trim());
  const registryPath=`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
  const registry=()=>ps(`$path='${registryPath}'; if(Test-Path -LiteralPath $path){$item=Get-ItemProperty -LiteralPath $path; $location=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\${guid}').InstallLocation; @{present=$true;location=$location;version=$item.DisplayVersion;name=$item.DisplayName}|ConvertTo-Json -Compress}else{@{present=$false}|ConvertTo-Json -Compress}`);
  const marker=path.join(profile,'p83-retention-marker.json'),markerValue=JSON.stringify({schema:'p83-retention/1',id:randomUUID()});
  await fs.writeFile(marker,markerValue,{flag:'wx'});
  let backend,backendExit,log,app,installed=false,uninstalled=false,target;
  const backendPort=await freePort(),uiPort=await freePort();
  const executable=path.join(installDir,'WeiBiYeP83.exe'),mainFile=path.join(installDir,'resources/app.asar/src/main.cjs');
  const { _electron,expect }=require('@playwright/test');
  const inspection=action=>app.evaluate(({app},{mainFile,action})=>{
    const runtime=process.getBuiltinModule('module').createRequire(mainFile)(mainFile).getRuntime();
    if(action==='quit'){runtime.trayMenu.getMenuItemById('quit').click();return;}
    return {version:app.getVersion(),pid:process.pid,packaged:app.isPackaged,owner:runtime.ownerId};
  },{mainFile,action});
  async function quit(){if(!app)return;const child=app.process();await inspection('quit');await until(()=>Promise.resolve(child.exitCode!==null),'Installed Electron exit timeout',15000);assert.equal(child.exitCode,0);app=null;}
  async function launch(version){
    app=await _electron.launch({executablePath:executable,args:['--profile-dir',profile,'--ui-port',String(uiPort),'--backend-origin',target.backend_origin],env:process.env,timeout:45000});
    results.pids.push(app.process().pid);const page=await app.firstWindow();await page.waitForURL(target.ui_origin+'/companions');await page.goto(target.ui_origin+'/login');
    await page.getByLabel('邮箱',{exact:true}).fill(target.accounts[0].email);await page.getByLabel('密码',{exact:true}).fill(target.accounts[0].password);
    await page.getByRole('button',{name:'登录',exact:true}).click();await until(async()=>Boolean((await inspection()).owner),'Installed login not synchronized');
    const info=await inspection();assert.equal(info.version,version);assert.equal(info.packaged,true);
    await page.goto(target.ui_origin+'/companions');
    const native=await ps(`$proc=Get-Process -Id ${info.pid}; $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($identity); @{nonElevated= -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);pid=$proc.Id}|ConvertTo-Json -Compress`);
    assert.equal(native.nonElevated,true);await expect(page.getByRole('heading',{name:/我的宠物/})).toBeVisible();
    await page.screenshot({path:path.join(run,'installed-'+version+'.png')});await quit();return {...info,nonElevated:true};
  }
  async function runUninstaller(){
    const identity=await registry();assert.equal(identity.present,true);assert.equal(path.resolve(identity.location.replace(/\\$/,'')),installDir);
    const names=(await fs.readdir(installDir)).filter(name=>/^Uninstall .+\.exe$/i.test(name));assert.equal(names.length,1);
    const uninstaller=path.join(installDir,names[0]);assert.equal(path.dirname(await fs.realpath(uninstaller)),installDir);
    const stat=await fs.stat(uninstaller);assert.ok(stat.isFile()&&stat.size>10000);
    // Normal self-copying uninstall also removes the uninstaller itself.
    // Never delete its directory ourselves to manufacture a clean result.
    await execute(uninstaller,['/S'],{windowsHide:true,env:process.env,timeout:60000});
    await until(async()=>!(await registry()).present,'Dedicated uninstall registration remains');
    await until(async()=>!(await fs.access(uninstaller).then(()=>true,()=>false)),'Uninstaller did not remove itself');
    assert.equal(await fs.access(executable).then(()=>true,()=>false),false);
    assert.equal(await fs.readFile(marker,'utf8'),markerValue);uninstalled=true;return {registrationRemoved:true,applicationRemoved:true,uninstallerRemoved:true,userProfilePreserved:true};
  }
  try{
    await check('current Windows token is non-elevated and random validation identity is absent',async()=>{
      const result=await ps('$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id); @{nonElevated= -not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress');
      assert.equal(result.nonElevated,true);assert.equal((await registry()).present,false);
      assert.equal(await fs.access(installDir).then(()=>true,()=>false),false);return {...result,distinctCleanStandardAccountTested:false};
    });
    const portable=reused?null:JSON.parse((await execute(process.execPath,[path.join(desktop,'scripts/package-portable.cjs')],{cwd:desktop,windowsHide:true,env:process.env,maxBuffer:2*1024*1024})).stdout);
    if(portable)assert.ok(path.resolve(portable.output).startsWith(path.join(desktop,'out')+path.sep));
    const {build,Platform,Arch}=require('electron-builder'),config=require('../electron-builder.config.cjs'),metadata=require('../package.json');
    const installers=reused?.installers??[];
    for(const version of (reused?[]:['0.1.0','0.1.1'])){
      const output=path.join(run,'build-'+version);
      const artifacts=await build({projectDir:desktop,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),publish:'never',config:{...config,
        appId,productName:'WeiBiYe P83 Validation '+guid.slice(0,8),directories:{app:path.join(portable.output,'resources/app'),output,buildResources:desktop},
        electronDist:path.join(desktop,'node_modules/electron/dist'),electronVersion:metadata.devDependencies.electron,
        extraMetadata:{version,productName:'WeiBiYe P83 Validation '+guid.slice(0,8)},
        win:{...config.win,executableName:'WeiBiYeP83'},nsis:{...config.nsis,guid,createDesktopShortcut:false,createStartMenuShortcut:false,uninstallDisplayName:'WeiBiYe P83 Validation '+guid.slice(0,8),artifactName:'P83-validation-${version}-setup.exe'}}});
      const file=artifacts.find(file=>file.endsWith('.exe'));assert.equal(path.dirname(file),output);
      const bytes=await fs.readFile(file);installers.push({version,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    results.installers=installers;await save();
    const backDir=path.join(run,'backend');await fs.mkdir(backDir);log=await fs.open(path.join(backDir,'backend.log'),'wx');
    backend=spawn(path.join(root,'backend/.venv/Scripts/python.exe'),['-B',path.join(__dirname,'fixtures/p82_server.py'),'--output',backDir,'--port',String(backendPort),'--ui-port',String(uiPort)],
      {cwd:path.join(root,'backend'),env:process.env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
    results.pids.push(backend.pid);backendExit=new Promise(yes=>backend.once('exit',(code,signal)=>yes({code,signal})));
    await until(async()=>{if(backend.exitCode!==null)throw Error('Owned installer Mock backend exited');try{return(await(await fetch(`http://127.0.0.1:${backendPort}/__p82_fixture/ready`)).json()).fixture==='p82-sqlite-mock-only/1';}catch{return false;}},'Installer fixture readiness failed',60000);
    target=JSON.parse(await fs.readFile(path.join(backDir,'target.json'),'utf8'));assert.equal(target.real_model_requests,0);
    for(const artifact of installers){
      await check('NSIS '+artifact.version+(installed?' in-place upgrade':' per-user install')+' and packaged startup',async()=>{
        const signature=await ps(`@{status=(Get-AuthenticodeSignature -LiteralPath '${artifact.file}').Status.ToString()}|ConvertTo-Json -Compress`);assert.equal(signature.status,'NotSigned');
        assert.equal(createHash('sha256').update(await fs.readFile(artifact.file)).digest('hex'),artifact.sha256);
        await execute(artifact.file,['/S',`/D=${installDir}`],{windowsHide:true,windowsVerbatimArguments:true,env:process.env,timeout:90000});installed=true;
        await until(async()=>await fs.access(executable).then(()=>true,()=>false),'Owned installed executable missing');
        const reg=await registry();assert.equal(reg.present,true);assert.equal(reg.version,artifact.version);
        assert.equal(path.resolve(reg.location.replace(/\\$/,'')),installDir);assert.equal(await fs.readFile(marker,'utf8'),markerValue);
        return {...await launch(artifact.version),signature:signature.status,profilePreserved:true};
      });
    }
    await check('dedicated NSIS uninstall removes executable and registration while retaining profile',runUninstaller);
    results.status='P83_OWNED_NSIS_LIFECYCLE_VERIFIED';results.notVerified=['production appId lifecycle','clean separate standard-user account','download-origin SmartScreen or antivirus prompts','signed release installer'];
  }catch(error){results.status='P83_OWNED_NSIS_FAILED';results.failure=String(error.message);throw error;}
  finally{
    try{await quit();}catch{results.electronCleanupFailed=true;}
    if(installed&&!uninstalled){try{results.failureUninstall=await runUninstaller();}catch{results.uninstallRequiresInspection=true;}}
    if(backend){try{await fs.writeFile(path.join(run,'backend/stop-requested'),'stop',{flag:'wx'});const exit=await Promise.race([backendExit,delay(15000).then(()=>{throw Error('Owned backend cleanup timeout');})]);assert.equal(exit.code,0);await log.close();results.backendExitCode=0;}catch{results.backendCleanupFailed=true;}}
    await save();console.log(JSON.stringify({status:results.status,run}));
  }
}
main().catch(error=>{console.error(String(error.message));process.exitCode=1;});
