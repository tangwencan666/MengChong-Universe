// Real input, read-only render observations; no engine setters or test-only combat mode.
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const project = path.resolve(__dirname, '../..');
const { chromium } = createRequire(path.join(project, 'frontend/package.json'))('@playwright/test');

(async () => {
  const out = path.join(project, '.verification/pet-brawl', 'whale-skill-' + randomUUID());
  await fs.mkdir(out, { recursive: true });
  const { createGameServer } = await import(pathToFileURL(path.join(__dirname, 'server.mjs')).href);
  const server = createGameServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = { status: 'running', browser: 'installed Chrome', headed: process.argv.includes('--headed'), checks: [], errors: [], externalRequests: [], evidenceDirectory: out };
  const record = (name, detail = {}) => result.checks.push({ name, status: 'passed', detail });
  let browser, page;
  try {
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: !result.headed, args: ['--disable-background-networking', '--no-first-run', '--disable-component-update'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); result.externalRequests.push(route.request().url()); return route.abort(); });
    page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
    await page.goto(origin); await page.locator('#start:not([disabled])').waitFor();
    await page.locator('[data-character="whale"]').click(); await page.locator('#opponent').selectOption('daodun'); await page.locator('#difficulty').selectOption('easy'); await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    const initialHp = Number((await page.locator('#cpu-health-label').textContent()).split('/')[0]);
    await page.evaluate(() => {
      window.observedSkillStages = [];
      const canvas = document.querySelector('#arena');
      new MutationObserver(() => { const n = Number(canvas.dataset.playerSkillStage); if (n > 0 && window.observedSkillStages.at(-1) !== n) window.observedSkillStages.push(n); }).observe(canvas, { attributes: true, attributeFilter: ['data-player-skill-stage'] });
    });
    await page.keyboard.press('u');
    for (let stage = 1; stage <= 3; stage++) {
      await page.waitForFunction(n => Number(document.querySelector('#arena').dataset.playerSkillStage) >= n, stage, { timeout: 2500 });
      if (stage === 1) {
        await page.waitForFunction(() => { const voice = document.querySelector('#whale-voice'); return !voice.paused && voice.currentTime > 0 && voice.readyState >= 2; });
        const playback = await page.locator('#whale-voice').evaluate(el => ({ duration: el.duration, volume: el.volume, loop: el.loop, currentTime: el.currentTime }));
        assert.ok(playback.duration >= 2 && playback.duration < 2.1); assert.equal(playback.loop, false); record('original video audio is decoded and actually advances during a real U cast', playback);
      }
      await page.screenshot({ path: path.join(out, `stage-${stage}.png`), fullPage: true });
    }
    await page.waitForFunction(() => /秒后就绪/.test(document.querySelector('#skill-status').textContent));
    await page.waitForTimeout(650);
    assert.deepEqual(await page.evaluate(() => window.observedSkillStages), [1, 2, 3]);
    const afterHp = Number((await page.locator('#cpu-health-label').textContent()).split('/')[0]);
    assert.equal(initialHp - afterHp, 16);
    record('one real U keypress displays three casts and deals exactly 16 total damage', { stages: [1, 2, 3], before: initialHp, after: afterHp });
    assert.equal(await page.locator('#skill-label').textContent(), '三连星弹'); record('skill name and three-hit disclosure match the reference-based motion');
    await page.keyboard.press('r'); await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    await page.keyboard.press('u'); await page.waitForFunction(() => document.querySelector('#arena').dataset.playerSkillStage === '1');
    await page.keyboard.press('Escape'); const frozen = await page.locator('#arena').getAttribute('data-player-skill-stage');
    const pausedVoiceTime = await page.locator('#whale-voice').evaluate(el => { if (!el.paused) throw new Error('voice did not pause'); return el.currentTime; });
    await page.waitForTimeout(700); assert.equal(await page.locator('#arena').getAttribute('data-player-skill-stage'), frozen);
    assert.ok(Math.abs(await page.locator('#whale-voice').evaluate(el => el.currentTime) - pausedVoiceTime) < .06);
    await page.locator('#resume').click(); await page.waitForFunction(() => document.querySelector('#arena').dataset.playerSkillStage === '3');
    record('pause between bursts freezes and then continues the actual three-stage animation');
    record('original cue pauses with combat and resumes from its existing playback position');
    await page.locator('#sound').click(); assert.equal(await page.locator('#whale-voice').evaluate(el => el.paused && el.currentTime === 0), true);
    record('sound toggle immediately stops and rewinds the original audio'); await page.locator('#arena').focus();
    await page.keyboard.press('r'); assert.equal(await page.locator('#player-health-label').textContent(), '100 / 100');
    assert.equal(await page.locator('#cpu-health-label').textContent(), '125 / 125');
    assert.equal(await page.locator('#arena').getAttribute('data-player-skill-stage'), '0');
    assert.equal(await page.locator('#whale-voice').evaluate(el => el.paused), true);
    record('restart clears the pending cast, target damage, and stage display');
    assert.deepEqual(result.errors, []); assert.deepEqual(result.externalRequests, []); record('no JavaScript errors or external requests');
    result.status = 'WHALE_THREE_HIT_BROWSER_VERIFIED';
  } catch (error) {
    result.status = 'WHALE_THREE_HIT_BROWSER_FAILED'; result.failure = error.message; process.exitCode = 1;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    result.browserClosed = !browser?.isConnected(); result.serverClosed = !server.listening;
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
})();
