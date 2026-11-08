'use strict';
// Local TLS only, synthetic mailbox, real React/auth/SSE and explicitly Mock models.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const desktop = path.resolve(__dirname, '..'), root = path.dirname(desktop);
const environment = desktopEnvironment(process.env);
async function freePort() {
  const server = net.createServer();
  await new Promise((yes,no) => { server.once('error',no); server.listen(0,'127.0.0.1',yes); });
  const port = server.address().port; await new Promise(yes => server.close(yes)); return port;
}
async function until(check, message, timeout=45000) {
  const end=Date.now()+timeout; while(Date.now()<end) { if(await check()) return; await delay(150); } throw Error(message);
}
function connect(port) {
  return new Promise(yes => {const socket=net.connect(port,'127.0.0.1');
    const done=value=>{socket.destroy();yes(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
}
async function main() {
  assert.equal(process.platform,'win32');
  const run=path.join(root,'.verification/p83','https-'+randomUUID()); await fs.mkdir(run,{recursive:true});
  const copied=path.join(run,'app'), profile=path.join(run,'profile'); await fs.mkdir(copied);
  const port=await freePort(), uiPort=await freePort(), origin=`https://p83.weibiye.test:${port}`;
  const result={status:'RUNNING',run,realModelRequests:0,publicDeployment:false,trust:'fresh certificate pin in verification bootstrap only; system trust unchanged',checks:[],pids:[]};
  const save=()=>fs.writeFile(path.join(run,'results.json'),JSON.stringify(result,null,2));
  const certs=[]; let backend, app, backendExit, backendRun, log;
  async function check(name, action) {try {const detail=await action();result.checks.push({name,status:'passed',detail});console.log('PASS '+name);}
    catch(error){result.checks.push({name,status:'failed',error:String(error.message)});throw error;} finally {await save();}}
  for(const name of ['src','renderer','assets','ui-dist']) await fs.cp(path.join(desktop,name),path.join(copied,name),{recursive:true,errorOnExist:true});
  for(const name of ['package.json','release-policy.json']) {
    try {await fs.copyFile(path.join(desktop,name),path.join(copied,name));} catch(error){if(error.code!=='ENOENT')throw error;}
  }
  await fs.writeFile(path.join(copied,'service-profile.json'),JSON.stringify({schema:'weibiye-service/1',mode:'hosted',origin}),{flag:'wx'});
  for(const suffix of ['good','wrong']) {
    const folder=path.join(run,'tls-'+suffix);await fs.mkdir(folder);
    const certificate=path.join(folder,'certificate.pem'), key=path.join(folder,'tls-fixture-private.pem');
    await promisify(execFile)('D:/git/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
      '-subj','/CN=p83.weibiye.test','-addext','subjectAltName=DNS:p83.weibiye.test','-addext','basicConstraints=critical,CA:FALSE',
      '-addext','extendedKeyUsage=serverAuth','-keyout',key,'-out',certificate],{env:environment,windowsHide:true});
    certs.push({certificate,key,ca:await fs.readFile(certificate)});
  }
  async function request(route, cert=certs[0]) {
    return new Promise((yes,no)=>{
      const req=https.get({hostname:'127.0.0.1',port,path:route,servername:'p83.weibiye.test',headers:{Host:`p83.weibiye.test:${port}`},
        ca:cert.ca,rejectUnauthorized:true,timeout:3000,agent:false},response=>{let body='';response.on('data',part=>body+=part);response.on('end',()=>{
          try {yes({status:response.statusCode,data:JSON.parse(body)});}catch{no(Error('Fixture JSON unavailable'));}});});
      req.on('error',no); req.on('timeout',()=>req.destroy(Error('Fixture TLS timeout')));
    });
  }
  async function startBackend(cert, suffix) {
    backendRun=path.join(run,'backend-'+suffix);await fs.mkdir(backendRun);log=await fs.open(path.join(backendRun,'backend.log'),'wx');
    backend=spawn(path.join(root,'backend/.venv/Scripts/python.exe'),['-B',path.join(__dirname,'fixtures/p83_https_server.py'),
      '--output',backendRun,'--port',String(port),'--certificate',cert.certificate,'--private-key',cert.key],
      {cwd:path.join(root,'backend'),env:environment,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
    result.pids.push(backend.pid);backendExit=new Promise(yes=>backend.once('exit',(code,signal)=>yes({code,signal})));
    await until(async()=>{if(backend.exitCode!==null)throw Error('TLS fixture exited; inspect owned backend log');
      try {const r=await request('/__p83_fixture/ready',cert);return r.status===200&&r.data.ready===true;}catch{return false;}},'TLS fixture not ready',60000);
  }
  async function stopBackend() {
    if(!backend)return;await fs.writeFile(path.join(backendRun,'stop-requested'),'stop',{flag:'wx'});
    const exit=await Promise.race([backendExit,delay(15000).then(()=>{throw Error('Owned TLS backend exit timeout; no force kill');})]);
    assert.equal(exit.code,0);await log.close();backend=null;assert.equal(await connect(port),false);
  }
  const mainFile=path.join(copied,'src/main.cjs');
  async function inspect(action,id) {return app.evaluate(async({BrowserWindow,screen},{mainFile,action,id})=>{
    const runtime=process.getBuiltinModule('module').createRequire(mainFile)(mainFile).getRuntime();
    if(action==='owner')return runtime.ownerId;
    if(action==='release')return runtime.release(id);
    if(action==='chat')return runtime.openChat(id);
    if(action==='quit'){runtime.trayMenu.getMenuItemById('quit').click();return;}
    if(action==='support'){runtime.trayMenu.getMenuItemById('support').click();return;}
    if(action==='cookies') {const cookies=await runtime.session.cookies.get({url:runtime.origin});return cookies.map(c=>({name:c.name,secure:c.secure,hostOnly:c.hostOnly,httpOnly:c.httpOnly}));}
    if(action==='tls-negative'){try {await runtime.session.fetch(runtime.origin+'/health/live');return false;}catch{return true;}}
    if(action==='windows')return {displays:screen.getAllDisplays().map(d=>({scaleFactor:d.scaleFactor,workArea:d.workArea})),windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL().split('#')[0]}))};
    throw Error('Unknown inspection');
  },{mainFile,action,id});}
  async function quit() {if(!app)return;const child=app.process();await inspect('quit');await until(()=>Promise.resolve(child.exitCode!==null),'Electron normal exit timeout',15000);assert.equal(child.exitCode,0);app=null;}
  async function focus(page) {const window=await app.browserWindow(page);await window.evaluate(win=>{win.show();win.focus();});}
  try {
    await check('loopback HTTPS validates fresh SAN certificate without disabling TLS',async()=>{await startBackend(certs[0],'good');const response=await request('/__p83_fixture/ready');assert.equal(response.status,200);assert.equal(response.data.schema_ready,true);return {fixtureStatus:200,productionRedisReadinessNotTested:true};});
    await check('hosted Electron uses approved HTTPS origin with no API proxy on local asset server',async()=>{
      app=await _electron.launch({args:[path.join(__dirname,'fixtures/p83-electron-bootstrap.cjs'),'--p83-app',copied,
        '--p83-certificate',certs[0].certificate,'--profile-dir',profile,'--ui-port',String(uiPort)],env:environment,timeout:45000});
      result.pids.push(app.process().pid);const page=await app.firstWindow();
      result.rendererErrors=[];
      page.on('pageerror',error=>result.rendererErrors.push(String(error.message).slice(0,500)));
      page.on('console',message=>{if(message.type()==='error')result.rendererErrors.push(message.text().slice(0,500));});
      await page.waitForURL(origin+'/companions');
      assert.equal(await page.evaluate(()=>window.isSecureContext),true);
      assert.equal((await fetch(`http://127.0.0.1:${uiPort}/api/v1/auth/me`)).status,404);
      return {origin,localApiStatus:404};
    });
    const page=app.windows().find(p=>p.url().startsWith(origin));
    const email='p83-'+randomUUID()+'@example.com';
    await check('real registration, synthetic verification mailbox and secure-cookie login',async()=>{
      await page.goto(origin+'/register');await page.getByLabel('昵称',{exact:true}).fill('P83离线HTTPS用户');
      await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill('P83-Local-Only!2026');
      const registration=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/auth/register'));
      await page.getByRole('button',{name:'注册',exact:true}).click();assert.equal((await registration).status(),202);
      const mail=await request('/__p83_fixture/mail?recipient='+encodeURIComponent(email));assert.equal(mail.data.mock,true);
      // One-use test verification token stays in memory, never written to evidence.
      await page.goto(mail.data.link);await page.getByRole('button',{name:'确认验证邮箱',exact:true}).click();
      await expect(page.getByRole('status')).toBeVisible();await page.goto(origin+'/login');
      await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill('P83-Local-Only!2026');
      const login=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/auth/login'));
      await page.getByRole('button',{name:'登录',exact:true}).click();assert.equal((await login).status(),200);
      await until(async()=>Boolean(await inspect('owner')),'Native owner not synchronized');
      const cookies=await inspect('cookies');assert.ok(cookies.length>=2);assert.ok(cookies.every(c=>c.secure&&c.hostOnly));
      return {verified:true,cookies};
    });
    let pets;
    await check('three independently scoped pets created through actual authenticated API',async()=>{
      pets=await page.evaluate(async()=>{
        const csrf=await(await fetch('/api/v1/auth/csrf')).json();const pets=[];
        for(const [name,role_type]of [['月芽','cat'],['豆包','dog'],['小云','custom']]) {
          const response=await fetch('/api/v1/pets',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.csrf_token,'Idempotency-Key':crypto.randomUUID()},
            body:JSON.stringify({name,role_type,persona_config:{description:'P83离线验证',tone:'calm'}})});
          if(response.status!==201)throw Error('Pet creation rejected');pets.push(await response.json());
        }return pets;
      });
      for(const pet of pets)await inspect('release',pet.pet_id);await inspect('chat',pets[0].pet_id);
      await until(()=>Promise.resolve(app.windows().some(p=>p.url().startsWith(origin+'/pets/'+pets[0].pet_id))),'Hosted chat not opened');
      const windows=await inspect('windows');result.displays=windows.displays;
      assert.equal(windows.windows.filter(w=>w.url.startsWith(`http://127.0.0.1:${uiPort}/__pet/`)).length,3);
      return {names:pets.map(p=>p.name),transparentPetsOnLocalAssets:true,chatOnHttps:true};
    });
    await check('actual hosted React Mock SSE reply persists after refresh and sibling histories stay empty',async()=>{
      const chat=app.windows().find(p=>p.url().startsWith(origin+'/pets/'+pets[0].pet_id));
      await expect(chat.locator('#composer-disclosure')).toContainText('本地 Mock');
      await chat.getByLabel('聊天消息',{exact:true}).fill('P83 HTTPS离线问候');
      const accepted=chat.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/messages'));
      await chat.getByRole('button',{name:'发送消息',exact:true}).click();assert.equal((await accepted).status(),202);
      await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。');
      await chat.reload();await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。');
      const histories=await page.evaluate(async ids=>Promise.all(ids.map(async id=>(await(await fetch('/api/v1/pets/'+id+'/sessions')).json()).items.length)),pets.map(p=>p.pet_id));
      assert.deepEqual(histories,[1,0,0]);await chat.screenshot({path:path.join(run,'actual-https-mock-chat.png')});
      return {model:'Mock',persisted:true,sessionCounts:histories,realModelRequests:0};
    });
    await check('explicit invitation grant and opt-in/opt-out privacy controls work in actual UI',async()=>{
      await focus(page);await page.goto(origin+'/beta');await page.getByLabel('内测邀请码',{exact:true}).fill('p83-local-synthetic-invitation-0000001');
      await page.getByRole('button',{name:'领取免费额度',exact:true}).click();await expect(page.getByText('剩余 20 次',{exact:false})).toBeVisible();
      const consent=page.getByRole('checkbox');assert.equal(await consent.isChecked(),false);await consent.check();
      await page.getByRole('button',{name:'保存统计选择',exact:true}).click();await expect(page.getByText('已开启最小统计。',{exact:true})).toBeVisible();
      const chat=app.windows().find(p=>p.url().startsWith(origin+'/pets/'+pets[0].pet_id));
      const privacy=chat.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith('/beta/privacy'));
      await focus(chat);await chat.reload();assert.equal((await(await privacy).json()).enabled,true);
      const active=chat.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/beta/privacy/events'));
      await chat.getByLabel('聊天消息',{exact:true}).click();assert.equal((await(await active).json()).recorded,true);
      await chat.getByLabel('聊天消息',{exact:true}).fill('P83已同意统计后的离线互动');
      const accepted=chat.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/messages'));
      await chat.getByRole('button',{name:'发送消息',exact:true}).click();const generation=await(await accepted).json();
      await until(async()=>await chat.evaluate(async route=>(await(await fetch(route)).json()).generation.state==='completed',
        '/api/v1/pets/'+pets[0].pet_id+'/sessions/'+generation.generation.session_id+'/generations/'+generation.generation.id),'Consented Mock generation did not finish');
      const counts=(await request('/__p83_fixture/metrics')).data.counts;
      assert.equal(counts.interaction_mock,1);assert.equal(counts.interaction_real??0,0);assert.equal(counts.active,1);
      await focus(page);
      await consent.uncheck();await page.getByRole('button',{name:'保存统计选择',exact:true}).click();await expect(page.getByText('已关闭统计并删除对应事件。',{exact:true})).toBeVisible();
      assert.deepEqual((await request('/__p83_fixture/metrics')).data.counts,{});
      return {grant:20,defaultConsent:false,firstMockInteractionCount:1,realInteractionCount:0,explicitOptInAndDeletion:true};
    });
    await check('unauthenticated offline support reuses one scriptless isolated window',async()=>{
      await inspect('support');await inspect('support');await until(()=>Promise.resolve(app.windows().some(p=>p.url().startsWith('data:'))),'Offline support missing');
      const support=app.windows().filter(p=>p.url().startsWith('data:'));assert.equal(support.length,1);
      const report=JSON.parse(await support[0].locator('textarea').inputValue());assert.deepEqual(Object.keys(report).sort(),['app_version','category','created_at','report_id','schema'].sort());
      return {windows:1,fields:Object.keys(report),automaticallyUploaded:false};
    });
    await check('same approved DNS origin with a different certificate is rejected by Chromium',async()=>{
      await stopBackend();await startBackend(certs[1],'wrong');assert.equal(await inspect('tls-negative'),true);
      return {wrongCertificateRejected:true,tlsVerificationDisabled:false};
    });
    await quit();await stopBackend();assert.equal(await connect(uiPort),false);
    await check('unavailable hosted backend opens offline support and still exits normally',async()=>{
      app=await _electron.launch({args:[path.join(__dirname,'fixtures/p83-electron-bootstrap.cjs'),'--p83-app',copied,
        '--p83-certificate',certs[0].certificate,'--profile-dir',profile,'--ui-port',String(uiPort)],env:environment,timeout:45000});
      result.pids.push(app.process().pid);
      await until(()=>Promise.resolve(app.windows().some(p=>p.url().startsWith('data:'))),'Offline startup did not expose help');
      const help=app.windows().find(p=>p.url().startsWith('data:'));await expect(help.getByRole('heading',{name:'连接帮助与反馈',exact:true})).toBeVisible();
      await quit();assert.equal(await connect(uiPort),false);return {offlineHelpVisible:true,exitCode:0,uiPortReleased:true};
    });
    result.status='P83_LOCAL_HTTPS_MOCK_VERIFIED';result.electronExitCode=0;result.backendExitCode=0;result.portsReleased=true;
    result.notVerified=['public CA and external deployment','real mailbox delivery','real DeepSeek','physical sleep/multiple displays/low-end hardware'];
  } catch(error) {result.status='P83_LOCAL_HTTPS_FAILED';result.failure=String(error.message);
    if(app) result.failureWindows=await Promise.all(app.windows().map(async page=>({url:page.url().split('#')[0],body:await page.locator('body').innerText().catch(()=>'<unavailable>')})));
    throw error;}
  finally {try{await quit();}catch{result.electronCleanupFailed=true;}try{await stopBackend();}catch{result.backendCleanupFailed=true;}await save();console.log(JSON.stringify({status:result.status,run}));}
}
main().catch(error=>{console.error(String(error.message));process.exitCode=1;});
