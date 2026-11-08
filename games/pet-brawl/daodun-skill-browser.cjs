// Actual keyboard inputs and read-only rendering/media observations only.
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const project = path.resolve(__dirname, '../..');
const {chromium} = createRequire(path.join(project, 'frontend/package.json'))('@playwright/test');
(async () => {
  const out = path.join(project, '.verification/pet-brawl', 'daodun-skill-' + randomUUID()); await fs.mkdir(out, {recursive:true});
  const {createGameServer} = await import(pathToFileURL(path.join(__dirname, 'server.mjs')).href);
  const server = createGameServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = {status:'running',headed:process.argv.includes('--headed'),browser:'installed Chrome',checks:[],errors:[],externalRequests:[],evidenceDirectory:out};
  const record = (name, detail={}) => result.checks.push({name,status:'passed',detail});
  let browser, page;
  try {
    browser = await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:!result.headed,args:['--disable-background-networking','--no-first-run','--disable-component-update']});
    const context = await browser.newContext({viewport:{width:1280,height:950}});
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); result.externalRequests.push(route.request().url()); return route.abort(); });
    page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') result.errors.push(m.text()); });
    await page.goto(origin); await page.locator('#start:not([disabled])').waitFor();
    await page.locator('[data-character="daodun"]').click(); await page.locator('#opponent').selectOption('niwa'); await page.locator('#difficulty').selectOption('easy'); await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    assert.equal(await page.locator('#skill-label').textContent(), '冲锋横斩'); record('new skill is selectable for the original shield character');
    await page.evaluate(() => {
      window.chargePhases = []; window.shieldPlays = 0; window.chargeFrames = [];
      document.querySelector('#daodun-voice').addEventListener('play', () => window.shieldPlays++);
      const arena = document.querySelector('#arena');
      new MutationObserver(() => {
        const phase = arena.dataset.playerSkillPhase; if (phase && phase !== window.chargePhases.at(-1)) window.chargePhases.push(phase);
        if (window.chargeFrames.length < 600) window.chargeFrames.push({phase,x:Number(arena.dataset.playerX),cpuX:Number(arena.dataset.cpuX),hp:Number(document.querySelector('#cpu-health-label').textContent.split('/')[0])});
      }).observe(arena, {attributes:true,attributeFilter:['data-player-skill-phase','data-cpu-x','data-player-x']});
    });
    await page.keyboard.down('d');
    await page.waitForFunction(() => { const d = document.querySelector('#arena').dataset; return Number(d.cpuX) - Number(d.playerX) < 350; });
    await page.keyboard.up('d');
    const before = await page.locator('#arena').evaluate(el => ({x:Number(el.dataset.playerX),cpuX:Number(el.dataset.cpuX),hp:Number(document.querySelector('#cpu-health-label').textContent.split('/')[0])}));
    await page.keyboard.press('u');
    await page.waitForFunction(() => document.querySelector('#arena').dataset.playerSkillPhase === 'rush');
    await page.screenshot({path:path.join(out,'rush.png'),fullPage:true});
    await page.waitForFunction(() => window.chargePhases.includes('cleave'));
    await page.screenshot({path:path.join(out,'cleave.png'),fullPage:true});
    await page.waitForTimeout(450);
    const after = await page.locator('#arena').evaluate(el => ({x:Number(el.dataset.playerX),cpuX:Number(el.dataset.cpuX),hp:Number(document.querySelector('#cpu-health-label').textContent.split('/')[0])}));
    const frames = await page.evaluate(() => window.chargeFrames), contact = frames.find(f => f.hp === before.hp-6), furthestAfterContact = Math.max(...frames.filter(f => f.hp < before.hp).map(f => f.cpuX));
    result.combat = {before,after,contact,furthestAfterContact,phases:await page.evaluate(() => window.chargePhases)};
    assert.ok(after.x > before.x + 40); assert.equal(before.hp - after.hp,20); assert.ok(contact); assert.ok(furthestAfterContact > contact.cpuX + 60);
    record('actual U key charges, knocks back on contact and cleaves for a total of 20', result.combat);
    const audio = await page.locator('#daodun-voice').evaluate(el => ({duration:el.duration,currentTime:el.currentTime,paused:el.paused,loop:el.loop}));
    assert.equal(audio.duration,2); assert.ok(audio.currentTime > 0); assert.equal(audio.loop,false); assert.equal(await page.evaluate(() => window.shieldPlays),1);
    record('uploaded recording plays exactly one two-second cue per cast',audio);
    await page.waitForFunction(() => document.querySelector('#daodun-voice').ended, null, {timeout:3500});
    assert.equal(await page.evaluate(() => window.shieldPlays),1); record('cue ends naturally at two seconds and never loops');
    await page.keyboard.press('r'); await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    await page.keyboard.press('u'); await page.waitForFunction(() => document.querySelector('#arena').dataset.playerSkillPhase === 'rush'); await page.keyboard.press('Escape');
    const frozen = await page.locator('#arena').getAttribute('data-player-x'); const frozenTime = await page.locator('#daodun-voice').evaluate(el => {if (!el.paused) throw Error('cue not paused'); return el.currentTime;});
    await page.waitForTimeout(450); assert.equal(await page.locator('#arena').getAttribute('data-player-x'),frozen);
    assert.ok(Math.abs(await page.locator('#daodun-voice').evaluate(el => el.currentTime)-frozenTime)<.06);
    await page.locator('#resume').click(); await page.waitForFunction(() => {const el=document.querySelector('#daodun-voice');return !el.paused&&el.currentTime>0;}); record('pause and resume freeze both charge and audio');
    await page.locator('#sound').click(); assert.equal(await page.locator('#daodun-voice').evaluate(el => el.paused && el.currentTime===0),true); record('mute stops and rewinds the cue immediately');
    await page.locator('#arena').focus(); await page.keyboard.press('r'); assert.equal(await page.locator('#player-health-label').textContent(),'125 / 125'); assert.equal(await page.locator('#cpu-health-label').textContent(),'110 / 110');
    assert.equal(await page.locator('#arena').getAttribute('data-player-skill-phase'),''); assert.equal(await page.locator('#daodun-voice').evaluate(el => el.paused),true); record('restart clears pending cleave, health and old sound');
    assert.deepEqual(result.errors,[]); assert.deepEqual(result.externalRequests,[]); record('no browser errors or external requests');
    result.status='DAODUN_CHARGE_CLEAVE_BROWSER_VERIFIED';
  } catch(error) {
    result.status='DAODUN_CHARGE_CLEAVE_BROWSER_FAILED';result.failure=error.message;process.exitCode=1;
    if(page&&!page.isClosed()) await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});
  } finally {
    if(browser) await browser.close();await new Promise(resolve=>server.close(resolve));result.browserClosed=!browser?.isConnected();result.serverClosed=!server.listening;
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }
})();
