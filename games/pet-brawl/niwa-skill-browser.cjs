// Normal keyboard input; DOM/media are read-only observations, never engine setters.
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const project=path.resolve(__dirname,'../..'),{chromium}=createRequire(path.join(project,'frontend/package.json'))('@playwright/test');
(async()=>{
 const out=path.join(project,'.verification/pet-brawl','niwa-skill-'+randomUUID());await fs.mkdir(out,{recursive:true});
 const {createGameServer}=await import(pathToFileURL(path.join(__dirname,'server.mjs')).href);const server=createGameServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const result={status:'running',browser:'installed Chrome',headed:process.argv.includes('--headed'),checks:[],errors:[],externalRequests:[],evidenceDirectory:out};const record=(name,detail={})=>result.checks.push({name,status:'passed',detail});let browser,page;
 try{
  browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:!result.headed,args:['--disable-background-networking','--no-first-run','--disable-component-update']});
  const context=await browser.newContext({viewport:{width:1280,height:950}});await context.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();result.externalRequests.push(r.request().url());return r.abort();});
  page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
  await page.goto(origin);await page.locator('#start:not([disabled])').waitFor();
  assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>/niwa-laugh_/.test(r.name)).length),8);record('eight actual source-video poses preload once');
  await page.locator('[data-character="niwa"]').click();await page.locator('#opponent').selectOption('daodun');await page.locator('#difficulty').selectOption('easy');await page.locator('#start').click();await page.waitForFunction(()=>document.querySelector('#arena').dataset.phase==='playing');
  assert.equal(await page.locator('#skill-label').textContent(),'捧腹大笑');
  await page.evaluate(()=>{
   window.laughObservations=[];window.laughPlays=0;document.querySelector('#niwa-voice').addEventListener('play',()=>window.laughPlays++);
   const arena=document.querySelector('#arena');new MutationObserver(()=>{if(window.laughObservations.length<650)window.laughObservations.push({time:performance.now(),pulse:Number(arena.dataset.playerSkillStage),frame:arena.dataset.playerLaughFrame,controlled:arena.dataset.cpuControlled==='true',hp:Number(document.querySelector('#cpu-health-label').textContent.split('/')[0]),x:Number(arena.dataset.cpuX)});}).observe(arena,{attributes:true,attributeFilter:['data-player-skill-stage','data-player-laugh-frame','data-cpu-controlled']});
  });
  await page.keyboard.down('d');await page.waitForFunction(()=>{const d=document.querySelector('#arena').dataset;return Number(d.cpuX)-Number(d.playerX)<215;});await page.keyboard.up('d');
  const initialHp=Number((await page.locator('#cpu-health-label').textContent()).split('/')[0]);await page.keyboard.press('u');
  await page.waitForFunction(()=>Number(document.querySelector('#arena').dataset.playerSkillStage)>=3);await page.screenshot({path:path.join(out,'laugh-and-sonic.png'),fullPage:true});
  const cue=await page.locator('#niwa-voice').evaluate(el=>({duration:el.duration,time:el.currentTime,paused:el.paused,loop:el.loop}));assert.equal(cue.duration,2.6);assert.ok(cue.time>0&&!cue.paused);assert.equal(cue.loop,false);record('real U plays the uploaded original laugh, once and without a loop',cue);
  await page.waitForFunction(()=>document.querySelector('#arena').dataset.playerSkillStage==='21');await page.screenshot({path:path.join(out,'pulse-21.png'),fullPage:true});await page.waitForFunction(()=>document.querySelector('#arena').dataset.playerSkillStage==='0');
  const observations=await page.evaluate(()=>window.laughObservations);await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(observations,null,2));
  const damageSteps=[];let lastHp=initialHp;for(const o of observations){if(o.hp<lastHp){damageSteps.push(lastHp-o.hp);lastHp=o.hp;}}
  assert.ok(damageSteps.length>=8);assert.ok(damageSteps.every(n=>n===1));assert.ok(initialHp-lastHp<=21);record('live opponent loses health in individual one-point ticks, never more than 21',{initialHp,after:lastHp,ticks:damageSteps.length,allDelta:1,note:'Ordinary AI may guard or evade; exact full-hit 21 is covered deterministically offline.'});
  assert.ok(observations.some(o=>o.controlled));assert.ok(new Set(observations.filter(o=>o.frame!=='').map(o=>o.frame)).size>=4);assert.ok(observations.some(o=>o.pulse===21));assert.ok(observations.every(o=>o.pulse<=21));record('actual belly-laugh poses animate, controlled state appears and only 21 pulses are emitted');
  assert.equal(await page.evaluate(()=>window.laughPlays),1);assert.equal(await page.locator('#niwa-voice').evaluate(el=>el.paused),true);record('cast end leaves no looping or stale laugh');
  await page.keyboard.press('r');await page.waitForFunction(()=>document.querySelector('#arena').dataset.phase==='playing');await page.keyboard.press('u');await page.waitForFunction(()=>Number(document.querySelector('#arena').dataset.playerSkillStage)>=2);await page.keyboard.press('Escape');
  const frozen=await page.locator('#arena').getAttribute('data-player-skill-stage'),audioTime=await page.locator('#niwa-voice').evaluate(el=>{if(!el.paused)throw Error('laugh audio did not pause');return el.currentTime;});await page.waitForTimeout(450);assert.equal(await page.locator('#arena').getAttribute('data-player-skill-stage'),frozen);assert.ok(Math.abs(await page.locator('#niwa-voice').evaluate(el=>el.currentTime)-audioTime)<.06);
  await page.locator('#resume').click();await page.waitForFunction(n=>Number(document.querySelector('#arena').dataset.playerSkillStage)>n,Number(frozen));record('pause freezes both pulse counter and original audio, then resumes');
  await page.locator('#sound').click();assert.equal(await page.locator('#niwa-voice').evaluate(el=>el.paused&&el.currentTime===0),true);record('mute immediately stops and rewinds the voice');
  await page.locator('#arena').focus();await page.keyboard.press('r');assert.equal(await page.locator('#player-health-label').textContent(),'110 / 110');assert.equal(await page.locator('#cpu-health-label').textContent(),'125 / 125');assert.equal(await page.locator('#arena').getAttribute('data-cpu-controlled'),'false');assert.equal(await page.locator('#niwa-voice').evaluate(el=>el.paused),true);record('restart clears health, pending pulses, control and old sound');
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.externalRequests,[]);record('no JavaScript errors or external requests');result.status='NIWA_LAUGH_SONIC_BROWSER_VERIFIED';
 }catch(e){result.status='NIWA_LAUGH_SONIC_BROWSER_FAILED';result.failure=e.message;process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
 finally{if(browser)await browser.close();await new Promise(r=>server.close(r));result.browserClosed=!browser?.isConnected();result.serverClosed=!server.listening;await fs.writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
})();
