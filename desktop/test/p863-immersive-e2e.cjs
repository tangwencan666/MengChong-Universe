'use strict';
// Live Windows/Electron rendering and real local API/SQLite. Explicit Mock only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{randomUUID,createHash}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises'),{_electron,expect}=require('@playwright/test');
const {desktopEnvironment}=require('../src/launch-env.cjs');
const root=path.resolve(__dirname,'../..'),desktop=path.join(root,'desktop'),mainFile=path.join(desktop,'src/main.cjs');
const run=path.join(root,'.verification/p86','p863-immersive-'+randomUUID()),preview=process.argv.includes('--visual-only');
const env=desktopEnvironment(process.env);for(const key of Object.keys(env))if(/^VITE_/i.test(key))delete env[key];
const result={status:'RUNNING',run,preview,startedAt:new Date().toISOString(),checks:[],screenshots:[],processesSeen:[],pids:[],realModelRequests:0,sharedDatabaseAccess:false};
let app,page,target,backend,backendExit,log,owner,ids,ports,profile;
const save=()=>fs.writeFile(path.join(run,'results.json'),JSON.stringify(result,null,2));
async function until(fn,message,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(150)}throw Error(message)}
async function port(){const s=net.createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok)});const n=s.address().port;await new Promise(ok=>s.close(ok));return n;}
async function open(n){return new Promise(ok=>{const s=net.connect(n,'127.0.0.1'),done=v=>{s.destroy();ok(v)};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(1000,()=>done(false))});}
async function inspect(action,data){return app.evaluate(async({app,BrowserWindow,screen},{file,action,data})=>{
  const require=process.getBuiltinModule('module').createRequire(file),m=require(file).getRuntime();
  if(action==='sync')return m.syncSession();
  if(action==='close-chat')return require('../test/window-close.cjs').closeWindowAndWait(m.records.get(data)?.chatWindow);
  if(action==='tick')return m.tickSociety();
  if(action==='fail-next-release'){
    const ipc=require('electron').ipcMain,channel='weibiye:desktop:release',original=ipc._invokeHandlers.get(channel);
    if(typeof original!=='function')throw Error('Owned IPC handler missing');
    ipc.removeHandler(channel);ipc.handle(channel,async(event,id,...args)=>{
      ipc.removeHandler(channel);ipc.handle(channel,original);
      return id===data?{ok:false,error:{code:'UNAVAILABLE',message:'P863 受控离线故障'}}:original(event,id,...args);
    });return true;
  }
  if(action==='trigger')return require('./p86-society.cjs').triggerForTest(m.society,data.kind,data.ids,Date.now(),{bypassCooldown:true});
  if(action==='pet-state'){const r=m.records.get(data);return{identity:r.identity,social:m.society.pet(m.ownerId,data,Date.now()),actor:r.actor};}

  if(action==='society')return m.society?.view(m.ownerId,Date.now());
  if(action==='preferences')return m.configurePet(data,{random:false,autoMove:false});
  if(action==='size'){m.mainWindow.setContentSize(data.width,data.height);return m.mainWindow.getContentBounds()}
  if(action==='zoom'){m.mainWindow.webContents.setZoomFactor(data);return data}
  if(action==='hide-main'){m.mainWindow.hide();return true}
  if(action==='show-main')return m.showMain();
  if(action==='support'){const support=require('./support-window.cjs').createSupport({electron:require('electron'),version:'0.1.0'}),w=support.show();await new Promise(ok=>w.webContents.once('did-finish-load',ok));const title=w.getTitle();support.stop();return title}
  return{pid:process.pid,name:app.getName(),display:screen.getPrimaryDisplay(),owner:m.ownerId,title:m.mainWindow.getTitle(),main:{id:m.mainWindow.id,handle:m.mainWindow.getNativeWindowHandle().readBigUInt64LE().toString(),visible:m.mainWindow.isVisible()},pets:[...m.records.values()].map(r=>({id:r.identity.pet_id,hidden:r.hidden,visible:r.window.isVisible(),title:r.window.getTitle(),bounds:r.window.getBounds(),transparent:r.window.isNormal(),focusable:r.window.isFocusable(),chat:r.chatWindow&&!r.chatWindow.isDestroyed()?r.chatWindow.webContents.getURL():null}))};
},{file:mainFile,action,data});}
async function check(name,fn){try{const detail=await fn();result.checks.push({name,status:'passed',detail});if(app)result.processesSeen.push(...await app.evaluate(({app})=>app.getAppMetrics().map(p=>({pid:p.pid,creationTime:p.creationTime,type:p.type}))));console.log('PASS '+name)}catch(e){result.checks.push({name,status:'failed',error:String(e.message)});throw e}finally{await save()}}
async function shot(name,p=page){await p.evaluate(()=>document.fonts.ready);await delay(250);if(await p.locator('.p863-recount').count())await assertChatLayout(p);const file=path.join(run,name);await p.screenshot({path:file});result.screenshots.push({file,source:'Live Windows Electron renderer',composite:false,viewport:await p.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))});}
async function assertChatLayout(p){const value=await p.evaluate(()=>{const local=document.querySelector('.p863-recount'),next=local?.nextElementSibling,scroll=local?.parentElement;if(!local||!next||!scroll)throw Error('Missing chat layout');const a=local.getBoundingClientRect(),b=next.getBoundingClientRect();return{direction:getComputedStyle(scroll).flexDirection,localBottom:a.bottom,nextTop:b.top,localWidth:a.width,scrollWidth:scroll.scrollWidth,viewportWidth:scroll.clientWidth};});assert.equal(value.direction,'column');assert.ok(value.localBottom<=value.nextTop+1,JSON.stringify(value));assert.ok(value.scrollWidth<=value.viewportWidth+2,JSON.stringify(value));return value;}
async function layoutCheck(){return page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
  const overlaps=[];for(const card of document.querySelectorAll('.p863-choice,.pet-card,.p84-catalog-grid > .card'))for(const img of card.querySelectorAll('img'))for(const button of card.querySelectorAll('button,a.button')){const a=rect(img),b=rect(button);if(a.width&&b.width&&Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)overlaps.push(button.textContent)}
  const intro=document.querySelector('.p862-intro'),center=document.querySelector('.p85-management');
  return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,intro:rect(intro),center:rect(center),overlaps,paws:document.querySelectorAll('.lucide-paw-print').length,primary:getComputedStyle(document.documentElement).getPropertyValue('--ui-primary').trim(),slots:document.querySelectorAll('.p862-desktop-pet,.p862-empty-slot').length};
});}
async function assertLayout(){const v=await layoutCheck();assert.ok(v.scrollWidth<=v.width+2,JSON.stringify(v));assert.deepEqual(v.overlaps,[]);assert.equal(v.paws,0);assert.equal(v.primary,'#1677ff');if(v.width>1100)assert.ok(v.intro.x>=v.center.right+10,'Right introduction overlaps central column');else assert.ok(v.intro.y>=v.center.bottom-2,'Narrow introduction must follow main content');return v;}
async function launch(){app=await _electron.launch({args:[desktop,'--profile-dir',profile,'--ui-port',String(ports.ui),'--backend-origin',target.backend_origin],env,timeout:45000});result.pids.push(app.process().pid);const errorFile=path.join(run,'electron-'+app.process().pid+'.log');app.process().stderr?.on('data',chunk=>{require('node:fs').appendFileSync(errorFile,chunk)});page=await app.firstWindow();await page.getByLabel('邮箱',{exact:true}).waitFor({state:'visible',timeout:45000});}
async function login(account){await page.getByLabel('邮箱',{exact:true}).fill(account.email);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await until(async()=>(await inspect()).owner===account.owner_id,'Login owner sync');await page.goto(target.ui_origin+'/companions');await expect(page.getByRole('heading',{name:'我的宠物',exact:true})).toBeVisible();await inspect('sync');}
async function quit(){if(!app)return;const child=app.process();await app.evaluate(({app})=>app.quit()).catch(()=>{});await until(()=>child.exitCode!==null,'Normal Electron quit');assert.equal(child.exitCode,0);app=null;}
const card=id=>page.locator(`.p863-choice[data-instance-id="${id}"]`);
async function summon(id){await card(id).click();await until(async()=>(await inspect()).pets.some(p=>p.id===id&&!p.hidden&&p.visible),'Selected UUID not visible');await inspect('preferences',id);}
async function api(method,route,body){return page.evaluate(async({method,route,body})=>{const headers={};if(method!=='GET'){const csrf=await(await fetch('/api/v1/auth/csrf')).json();headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrf.csrf_token;headers['Idempotency-Key']=crypto.randomUUID()}const r=await fetch('/api/v1'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:r.status===204?null:await r.json()}},{method,route,body});}

async function snapshot(phase){await promisify(execFile)(path.join(root,'backend/.venv/Scripts/python.exe'),['-B',path.join(__dirname,'fixtures/p863_snapshot.py'),run,phase],{env,windowsHide:true});return JSON.parse(await fs.readFile(path.join(run,'database-'+phase+'.json'),'utf8'));}
async function recallAll(){await page.getByRole('button',{name:'一键收回全部',exact:true}).click();await until(async()=>(await inspect()).pets.length===0,'Recall all did not close owned windows');}
async function configure(patch){return page.evaluate(({owner,patch})=>window.weibiyeDesktop.socialSettings(owner,patch),{owner,patch});}
async function chatFor(id){await page.evaluate(id=>window.weibiyeDesktop.openChat(id),id);await until(()=>Promise.resolve(app.windows().some(p=>p.url()===target.ui_origin+'/pets/'+id)),'Instance chat window');const p=app.windows().find(p=>p.url()===target.ui_origin+'/pets/'+id);await expect(p.getByRole('button',{name:'最近和伙伴怎么样？',exact:true})).toBeEnabled();return p;}
async function main(){
  assert.equal(process.platform,'win32');await fs.mkdir(run);ports={ui:await port(),backend:await port()};result.ports=ports;profile=path.join(run,'profile');await save();await fs.copyFile(__filename,path.join(run,'acceptance-driver.cjs'));
  const sources=['desktop/src/manager.cjs','desktop/src/preload.cjs','desktop/src/policy.cjs','desktop/src/p863-context.cjs','desktop/src/p863-recount-store.cjs','desktop/renderer/pet-mood.js','desktop/renderer/pet.html','desktop/renderer/pet.js','desktop/renderer/pet-actions.css','frontend/src/pages/p85-pets.tsx','frontend/src/features/p863/CompanionRecount.tsx','desktop/ui-dist/UI_ASSETS.json','desktop/test/fixtures/p85_server.py'];
  result.sourceHashes=Object.fromEntries(await Promise.all(sources.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')])));
  log=await fs.open(path.join(run,'backend.log'),'wx');backend=spawn(path.join(root,'backend/.venv/Scripts/python.exe'),['-B',path.join(__dirname,'fixtures/p86_server.py'),'--output',run,'--port',String(ports.backend),'--ui-port',String(ports.ui)],{cwd:path.join(root,'backend'),env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});result.pids.push(backend.pid);backendExit=new Promise(ok=>backend.once('exit',(code,signal)=>ok({code,signal})));
  await until(async()=>{if(backend.exitCode!==null)throw Error('Owned Mock fixture stopped');try{return(await fetch(`http://127.0.0.1:${ports.backend}/__p85_fixture/ready`)).ok}catch{return false}},'Mock fixture ready',60000);
  target=JSON.parse(await fs.readFile(path.join(run,'target.json'),'utf8'));assert.equal(target.real_model_requests,0);assert.equal(target.fixture,'p85-sqlite-mock-only/1');owner=target.accounts[0].owner_id;ids=target.accounts[0].pets.map(p=>p.pet_id);assert.equal(ids.length,8);await launch();await login(target.accounts[0]);await configure({enabled:false});
  const before=await snapshot('before');let group,storyId,siblings;
  await check('eight adopted, zero visible: seventh Daodun and eighth Whale selected directly with no navigation or modal',async()=>{
    assert.equal((await inspect()).pets.length,0);await expect(page.locator('.p863-choice')).toHaveCount(8);const original=page.url();
    await summon(ids[6]);assert.deepEqual((await inspect()).pets.map(p=>p.id),[ids[6]]);await summon(ids[7]);
    assert.deepEqual((await inspect()).pets.map(p=>p.id),[ids[6],ids[7]]);assert.equal(page.url(),original);assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await card(ids[6]).getAttribute('aria-pressed'),'true');await shot('direct-seventh-eighth.png');return{owned:8,selected:ids.slice(6),navigation:false,modal:false};
  });
  await check('click toggles recall, fifth cap is a lightweight notice and a recalled slot is reusable',async()=>{
    await card(ids[6]).click();await until(async()=>(await inspect()).pets.length===1,'Click recall');assert.equal(await card(ids[6]).getAttribute('aria-pressed'),'false');await summon(ids[6]);
    for(const id of [ids[0],ids[2],ids[4]])await summon(id);await card(ids[5]).click();await expect(page.locator('.p863-light-notice')).toContainText('最多同时显示 5');assert.equal((await inspect()).pets.filter(p=>!p.hidden).length,5);
    await card(ids[2]).click();await until(async()=>(await inspect()).pets.length===4,'Free slot');await summon(ids[5]);assert.equal(page.url(),target.ui_origin+'/companions');return{maxVisible:5,fullNotice:true,recalledSlotReused:true};
  });
  await check('a hidden cached window does not reserve a visible slot; a controlled summon failure leaves UI unselected',async()=>{
    await page.evaluate(id=>window.weibiyeDesktop.hide(id),ids[4]);await until(()=>card(ids[4]).getAttribute('aria-pressed').then(v=>v==='false'),'Hidden selection');await summon(ids[1]);assert.equal((await inspect()).pets.filter(p=>!p.hidden).length,5);
    await card(ids[1]).click();await until(async()=>(await inspect()).pets.filter(p=>!p.hidden).length===4,'Recall before controlled failure');
    await inspect('fail-next-release',ids[3]);await card(ids[3]).click();await expect(page.getByRole('alert').first()).toContainText('P863 受控离线故障');assert.equal(await card(ids[3]).getAttribute('aria-pressed'),'false');assert.ok(!(await inspect()).pets.some(p=>p.id===ids[3]));await summon(ids[3]);return{hiddenNotCounted:true,controlledFault:'owned acceptance IPC, one failure only',uiResynced:true};
  });
  await check('selection and restart preserve every existing pet, chat and memory row byte-for-byte',async()=>{
    const current=(await inspect()).pets.map(p=>({id:p.id,hidden:p.hidden}));await quit();await launch();await login(target.accounts[0]);await configure({enabled:false});await until(async()=>(await inspect()).pets.length===current.length,'Restart restore');assert.deepEqual((await inspect()).pets.map(p=>({id:p.id,hidden:p.hidden})),current);
    const after=await snapshot('after');assert.deepEqual(after,before);return{allOriginalRowsUnchanged:true,restartSelections:true,deletedPets:0};
  });
  await check('main management entries are absent while private settings retain full social and memory controls',async()=>{
    for(const selector of ['#pet-moods','#pet-relations','.p862-shared-events','.p86-society'])await expect(page.locator(selector)).toHaveCount(0);
    await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'设置',exact:true}).click();await expect(page.locator('#pet-social')).toBeVisible();await expect(page.locator('#pet-moods > summary')).toContainText('查看心情与免费互动');await expect(page.locator('#pet-moods > summary')).toBeVisible();await expect(page.getByRole('button',{name:'查看共同事件',exact:true})).toBeVisible();
    await page.goto(target.ui_origin+'/companions');return{mainSimplified:true,settingsAndDataRetained:true};
  });
  await check('live Windows blue layout, narrow windows and application scaling retain readable nonoverlapping cards',async()=>{
    const display=(await inspect()).display;result.windowsDisplay=display;const wide={width:Math.min(1672,display.workArea.width-40),height:Math.min(900,display.workArea.height-60)};await inspect('size',wide);await page.evaluate(()=>scrollTo(0,0));await shot('windows-main-wide.png');const native=await inspect();
    const capture=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'fixtures/p863-capture.ps1'),'-WindowHandle',native.main.handle,'-ExpectedProcessId',String(native.pid),'-OutputPath',path.join(run,'windows-native-main.png')],{env,windowsHide:true,timeout:20000});result.windowsNativeCapture=JSON.parse(capture.stdout.trim());
    const measures=[];for(const size of [wide,{width:1000,height:740},{width:720,height:740},{width:420,height:680}]){await inspect('size',size);await delay(200);await page.evaluate(()=>scrollTo(0,0));measures.push(await assertLayout());await shot('width-'+size.width+'.png');}
    await inspect('size',wide);for(const zoom of [1.25,1.5]){await inspect('zoom',zoom);await delay(200);measures.push(await assertLayout());await shot('zoom-'+zoom+'.png');}await inspect('zoom',1);await inspect('size',wide);return{measures,osDpi:display.scaleFactor,applicationZoomIsNotOsDpi:true};
  });
  console.log('PACE before social context checks');await delay(55000);
  await check('actual local shared event yields an explicitly local story only for participating pet instances',async()=>{
    const pets=(await inspect()).pets.filter(p=>!p.hidden);let pair;
    for(const a of pets)for(const b of pets)if(a.id!==b.id&&Math.hypot(a.bounds.x-b.bounds.x,a.bounds.y-b.bounds.y)<550)pair??=[a.id,b.id];assert.ok(pair,'No nearby safe pair');group=pair;
    await configure({enabled:true,frequency:'rare',quiet_until:0});for(const id of group)await app.evaluate(async({app},{file,id})=>{const m=process.getBuiltinModule('module').createRequire(file)(file).getRuntime();await m.configurePet(id,{random:true,autoMove:false})},{file:mainFile,id});await inspect('tick');
    assert.equal(await inspect('trigger',{kind:'cooperate',ids:group}),true);storyId=(await inspect('society')).pets.find(p=>p.id===group[0]).current_event;await delay(11500);await inspect('tick');assert.ok((await inspect('society')).events.some(e=>e.id===storyId&&e.outcome==='friendly'));
    const chat=await chatFor(group[0]);await chat.getByRole('button',{name:'最近和伙伴怎么样？',exact:true}).click();await expect(chat.locator(`[data-event-id="${storyId}"]`)).toContainText('合作');await expect(chat.locator('.p863-recount small')).toContainText('不写入 AI 聊天');assert.equal(await chat.locator('.chat-transcript [data-event-id]').count(),0);await shot('local-shared-event-chat.png',chat);
    const outsider=pets.find(p=>!group.includes(p.id)).id,out=await chatFor(outsider);await out.getByRole('button',{name:'最近和伙伴怎么样？',exact:true}).click();await expect(out.locator('.p863-recount [role="status"]')).toContainText('还没有');assert.equal(await out.locator(`[data-event-id="${storyId}"]`).count(),0);await inspect('close-chat',outsider);await inspect('close-chat',group[0]);return{eventId:storyId,participants:group,outsider,source:'actual local engine, privileged acceptance trigger',modelInjected:false};
  });
  await check('completed conflict drives actual mood and idle posture, with no invented theft or user intervention',async()=>{
    // Respect the ordinary recount cooldown; never bypass the product ledger.
    await delay(45000);
    await until(async()=>{const views=await Promise.all(group.map(id=>inspect('pet-state',id)));return views.every(v=>v.actor.priority<90)},'Prior direct actions settling');
    await inspect('tick');assert.equal(await inspect('trigger',{kind:'conflict',ids:group}),true);const id=(await inspect('society')).pets.find(p=>p.id===group[0]).current_event;await delay(11500);await inspect('tick');const social=await inspect('society'),victim=group.find(id=>['upset','sad'].includes(social.pets.find(p=>p.id===id).mood));assert.ok(victim);
    let petPage;for(const candidate of app.windows().filter(p=>p.url().includes('/__pet/pet.html'))){if(await candidate.locator('body').getAttribute('data-pet-id')===victim)petPage=candidate;}assert.ok(petPage);await expect(petPage.locator('body')).toHaveAttribute('data-mood',social.pets.find(p=>p.id===victim).mood);result.moodProbe=await petPage.evaluate(()=>({dataset:{...document.body.dataset},module:typeof window.WeiBiYePetMood,hidden:document.hidden}));await until(()=>petPage.locator('body').getAttribute('data-mood-posture').then(v=>['upset','sad'].includes(v)),'Genuine idle mood posture');await shot('actual-upset-pet.png',petPage);
    const chat=await chatFor(victim);await chat.getByRole('button',{name:'最近和伙伴怎么样？',exact:true}).click();const story=chat.locator(`[data-event-id="${id}"]`);await expect(story).toContainText('玩具');assert.doesNotMatch(await story.innerText(),/抢我的位置|安慰过我|你支持/);await shot('actual-conflict-recount.png',chat);await inspect('close-chat',victim);return{conflictId:id,victim,actualMood:social.pets.find(p=>p.id===victim).mood,facialAssetsUnmodified:true};
  });
  await check('same event is not repeated after reopening a chat or restarting; ordinary Mock SSE chat persists normally',async()=>{
    const chat=await chatFor(group[0]);await chat.getByRole('button',{name:'最近和伙伴怎么样？',exact:true}).click();await expect(chat.locator('.p863-recount')).not.toContainText('一起做过一件小合作');let streamed=false;chat.on('response',r=>{if(r.headers()['content-type']?.includes('text/event-stream'))streamed=true});await expect(chat.locator('#composer-disclosure')).toContainText('本地 Mock');await chat.getByLabel('聊天消息',{exact:true}).fill('P863 SYNTHETIC unrelated ordinary topic');const sent=chat.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/messages'));await chat.getByRole('button',{name:'发送消息',exact:true}).click();const body=await(await sent).json();assert.equal(body.generation.provider,'mock');await expect(chat.locator('.message-assistant p').first()).toContainText('Mock',{timeout:30000});await until(()=>chat.getByRole('button',{name:'发送消息',exact:true}).isVisible(),'Mock terminal event');assert.equal(streamed,true);await chat.reload();await expect(chat.getByText('P863 SYNTHETIC unrelated ordinary topic',{exact:true})).toBeVisible();assert.equal(await chat.locator('.p863-recount [data-event-id]').count(),0);await inspect('close-chat',group[0]);
    await quit();await launch();await login(target.accounts[0]);const reopened=await chatFor(group[0]);assert.equal(await reopened.locator('.p863-recount [data-event-id]').count(),0);await reopened.getByRole('button',{name:'最近和伙伴怎么样？',exact:true}).click();await expect(reopened.locator('.p863-recount')).not.toContainText('一起做过一件小合作');await inspect('close-chat',group[0]);return{fixedMock:true,sseObserved:true,refreshPersists:true,noLocalStoryInTranscript:true,realModelRequests:0};
  });
  console.log('PACE before duplicate adoption checks');await delay(55000);
  await check('same-species same-name siblings remain independent and arbitrary late instances are clickable',async()=>{
    await recallAll();await page.getByText('领养新伙伴 · 八种角色可重复领养',{exact:true}).click();await page.getByRole('button',{name:'自定义领养名字',exact:true}).click();await page.getByLabel('给哈吉米取名',{exact:true}).fill('P863 同名');siblings=[];
    for(let i=0;i<2;i++){const pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/pet-instances'));await page.getByRole('button',{name:'领养哈吉米',exact:true}).click();const r=await pending;assert.equal(r.status(),201);siblings.push((await r.json()).pet_instance_id);await expect(page.getByRole('button',{name:'领养哈吉米',exact:true})).toBeEnabled();}
    assert.notEqual(...siblings);await page.getByText('领养新伙伴 · 八种角色可重复领养',{exact:true}).click();await expect(page.locator('.p863-choice')).toHaveCount(10);await summon(siblings[1]);await summon(siblings[0]);assert.deepEqual((await inspect()).pets.map(p=>p.id),[siblings[1],siblings[0]]);await card(siblings[1]).click();await until(async()=>(await inspect()).pets.length===1,'Sibling recall');assert.equal((await inspect()).pets[0].id,siblings[0]);await summon(siblings[1]);await shot('same-species-independent-selection.png');return{siblings,owned:10,reverseSelection:true,noIndexIdentity:true};
  });
  await check('cross-account context and pet access are denied; no prior owner story or desktop survives login switch',async()=>{
    await page.goto(target.ui_origin+`/pets/${siblings[0]}/memory`);await expect(page.locator('main')).toContainText('记忆');await api('POST','/auth/logout');await page.goto(target.ui_origin+'/login');await login(target.accounts[1]);assert.equal((await inspect()).pets.length,0);assert.equal((await api('GET','/pet-instances/'+ids[6])).status,404);
    const denied=await page.evaluate(async id=>{try{await window.weibiyeDesktop.companionContext(id,null,'recount');return false}catch{return true}},ids[6]);assert.equal(denied,true);assert.equal(await page.locator('.p863-recount [data-event-id]').count(),0);return{foreignAccess:404,foreignContextDenied:true};
  });
  result.status='P863_IMMERSIVE_WINDOWS_OFFLINE_VERIFIED';
}
main().catch(async e=>{result.status='P863_IMMERSIVE_WINDOWS_FAILED';result.failure=String(e.stack);console.error(e.message);if(page&&!page.isClosed())await shot('failure.png').catch(()=>{})}).finally(async()=>{
  await quit().catch(e=>{result.electronCleanupError=String(e.message)});await fs.writeFile(path.join(run,'stop-requested'),'stop only owned P863 fixture');if(backendExit){let timer;try{result.backendExit=await Promise.race([backendExit,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('Backend cleanup timeout')),15000)})])}catch(e){result.backendCleanupError=String(e.message)}finally{clearTimeout(timer)}}await log?.close();result.portsReleased={ui:!await open(ports.ui),backend:!await open(ports.backend)};result.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:result.status,run,passed:result.checks.filter(c=>c.status==='passed').length,portsReleased:result.portsReleased}));process.exitCode=result.status==='P863_IMMERSIVE_WINDOWS_OFFLINE_VERIFIED'&&!result.electronCleanupError&&!result.backendCleanupError?0:1;
});
