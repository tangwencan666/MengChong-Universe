// Real installed browser, two independent clients. Only UI and keyboard actions;
// no health/seed/time setters, synthetic opponent, backend test routes, or external I/O.
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const project=path.resolve(__dirname,'../..'),{chromium}=createRequire(path.join(project,'frontend/package.json'))('@playwright/test');
(async()=>{
 const out=path.join(project,'.verification/pet-brawl','local-online-'+randomUUID());await fs.mkdir(out,{recursive:true});
 const {createGameServer}=await import(pathToFileURL(path.join(__dirname,'server.mjs')).href);const server=createGameServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const result={status:'running',browser:'installed Chrome',headed:process.argv.includes('--headed'),clients:2,checks:[],errors:[],externalRequests:[],evidenceDirectory:out};let browser,a,b;
 const record=(name,detail={})=>result.checks.push({name,status:'passed',detail});
 const playing=page=>page.waitForFunction(()=>document.querySelector('#arena').dataset.phase==='playing'&&document.querySelector('#arena').dataset.networked==='true');
 const focus=async page=>{await page.bringToFront();await page.locator('#arena').click();};
 try{
  browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:!result.headed,args:['--disable-background-networking','--no-first-run','--disable-component-update']});
  for(let i=0;i<2;i++){
   const context=await browser.newContext({viewport:{width:1280,height:950}});await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();result.externalRequests.push(route.request().url());return route.abort();});
   const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});await page.goto(origin);await page.locator('#start:not([disabled])').waitFor();if(i===0)a=page;else b=page;
  }
  await a.locator('[data-character="daodun"]').click();await a.locator('#battle-mode').selectOption('online');await a.locator('#create-fight-code').click();await a.waitForFunction(()=>/^[A-HJ-NP-Z2-9]{8}$/.test(document.querySelector('#room-code').textContent));
  const code=await a.locator('#room-code').textContent();await a.screenshot({path:path.join(out,'01-fight-code.png'),fullPage:true});
  await b.locator('[data-character="whale"]').click();await b.locator('#battle-mode').selectOption('online');await b.locator('#fight-code').fill(code);await b.locator('#start').click();await Promise.all([playing(a),playing(b)]);
  const room=await a.locator('#arena').getAttribute('data-room');assert.equal(await b.locator('#arena').getAttribute('data-room'),room);assert.equal(await a.locator('#arena').getAttribute('data-local-side'),'0');assert.equal(await b.locator('#arena').getAttribute('data-local-side'),'1');
  assert.equal(await a.locator('#player-name').textContent(),'刀盾');assert.equal(await b.locator('#player-name').textContent(),'鲸鱼娘');assert.equal(await b.locator('#player-side-label').textContent(),'P2 · 你');record('fight code joins two independent clients into one room with correct local P1/P2 identities');
  await focus(b);const before=Number(await b.locator('#arena').getAttribute('data-player-x'));await b.keyboard.down('a');await b.waitForFunction(x=>Number(document.querySelector('#arena').dataset.playerX)<x-50,before);await b.keyboard.up('a');
  await a.waitForFunction(x=>Number(document.querySelector('#arena').dataset.cpuX)<x-50,before);record('P2 keyboard movement is accepted by the server and visible to P1');
  await focus(a);await a.keyboard.down('d');await a.waitForFunction(()=>{const d=document.querySelector('#arena').dataset;return Number(d.cpuX)-Number(d.playerX)<115;});await a.keyboard.up('d');await a.keyboard.press('j');
  await b.waitForFunction(()=>document.querySelector('#player-health-label').textContent==='93 / 100');await a.waitForFunction(()=>document.querySelector('#cpu-health-label').textContent==='93 / 100');record('real P1 light attack causes exactly seven authoritative damage on both clients');
  await focus(b);await b.keyboard.down('a');await b.waitForFunction(()=>{const d=document.querySelector('#arena').dataset;return Number(d.playerX)-Number(d.cpuX)<115;});await b.keyboard.up('a');await b.keyboard.press('k');
  await a.waitForFunction(()=>document.querySelector('#player-health-label').textContent==='107 / 125');await b.waitForFunction(()=>document.querySelector('#cpu-health-label').textContent==='107 / 125');record('real P2 heavy attack damages only P1, synchronized as 18 damage');
  await a.screenshot({path:path.join(out,'02-p1-fight.png'),fullPage:true});await b.screenshot({path:path.join(out,'03-p2-fight.png'),fullPage:true});
  await focus(a);await a.keyboard.press('Escape');await a.locator('#resume').waitFor({state:'visible'});const time=Number(await b.locator('#timer').textContent());await b.waitForFunction(n=>Number(document.querySelector('#timer').textContent)<n,time);record('online menu releases local input but does not pause the peer');await a.locator('#resume').click();
  for(let i=0;i<160;i++){
   if(await a.locator('#arena').getAttribute('data-phase')==='finished')break;
   const d=await a.locator('#arena').evaluate(el=>el.dataset.cpuX-el.dataset.playerX),direction=d>=0?'d':'a';
   await a.keyboard.down(direction);await a.keyboard.down('j');await a.waitForTimeout(100);await a.keyboard.up(direction);
  }
  await a.keyboard.up('j');await a.keyboard.up('a');await a.keyboard.up('d');await a.locator('#rematch').waitFor({state:'visible'});await b.locator('#rematch').waitFor({state:'visible'});
  assert.equal(await a.locator('#cpu-health-label').textContent(),'0 / 100');assert.equal(await b.locator('#player-health-label').textContent(),'0 / 100');record('actual human-input duel reaches a synchronized knockout and result on both clients');
  const oldRound=await a.locator('#arena').getAttribute('data-round');await a.locator('#rematch').click();await a.waitForFunction(()=>document.querySelector('#rematch').textContent.includes('等待对手'));assert.equal(await a.locator('#arena').getAttribute('data-round'),oldRound);
  await b.locator('#rematch').click();await Promise.all([playing(a),playing(b)]);assert.notEqual(await a.locator('#arena').getAttribute('data-round'),oldRound);assert.equal(await a.locator('#player-health-label').textContent(),'125 / 125');assert.equal(await b.locator('#player-health-label').textContent(),'100 / 100');record('only mutual rematch consent starts a fresh synchronized round');
  await focus(a);
  await a.keyboard.press('Escape');await a.locator('#change').click();await b.waitForFunction(()=>document.querySelector('#result-title').textContent.includes('对手已离开'));record('leaving explicitly ends the peer match without a fake victory');await b.locator('#change').click();
  for(const page of [a,b]){await page.locator('[data-character="whale"]').click();await page.locator('#fight-code').fill('');}
  await a.locator('#start').click();await a.waitForFunction(()=>document.querySelector('#online-message').textContent.includes('正在随机匹配真人'));assert.equal(await a.locator('#setup').isVisible(),true);record('empty code waits in a real-player queue and never starts an AI match');
  await b.locator('#start').click();await Promise.all([playing(a),playing(b)]);const randomRoom=await a.locator('#arena').getAttribute('data-room');assert.notEqual(randomRoom,room);assert.equal(await b.locator('#arena').getAttribute('data-room'),randomRoom);assert.equal(await a.locator('#player-name').textContent(),'鲸鱼娘');assert.equal(await b.locator('#player-name').textContent(),'鲸鱼娘');record('empty-code random matching connects two humans and supports mirror characters');
  await a.screenshot({path:path.join(out,'04-random-mirror.png'),fullPage:true});
  await a.setViewportSize({width:430,height:932});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await a.screenshot({path:path.join(out,'05-online-narrow.png'),fullPage:true});record('online controls and role labels fit a narrow window without horizontal overflow');
  await b.close();await a.waitForFunction(()=>document.querySelector('#online-status').textContent.includes('连接中'),null,{timeout:5000});await a.waitForFunction(()=>document.querySelector('#result-title').textContent.includes('15秒'),null,{timeout:22000});record('closing the second client suspends then ends the room after the reconnect grace period');
  await a.locator('#change').click();await a.locator('#start').click();await a.waitForFunction(()=>document.querySelector('#online-message').textContent.includes('正在随机匹配真人'));await a.locator('#cancel-online').click();assert.equal(await a.locator('#online-waiting').isVisible(),false);record('queued matching can be cancelled and releases local controls');
  await a.locator('#battle-mode').selectOption('computer');await a.locator('#start').click();await a.waitForFunction(()=>document.querySelector('#arena').dataset.phase==='playing'&&document.querySelector('#arena').dataset.networked==='false');assert.equal(await a.locator('#cpu-side-label').textContent(),'CPU · 电脑');record('computer mode remains playable after leaving online mode');
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.externalRequests,[]);result.status='LOCAL_TWO_CLIENT_ONLINE_VERIFIED';
 }catch(e){result.status='LOCAL_TWO_CLIENT_ONLINE_FAILED';result.failure=e.message;process.exitCode=1;for(const[page,name]of [[a,'a'],[b,'b']])if(page&&!page.isClosed())await page.screenshot({path:path.join(out,`failure-${name}.png`),fullPage:true}).catch(()=>{});}
 finally{if(browser)await browser.close();await new Promise(r=>server.close(r));result.browserClosed=!browser?.isConnected();result.serverClosed=!server.listening;await fs.writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
})();
