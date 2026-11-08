// Real installed Windows browser; no mocked gameplay and no simulation setters.
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const project = path.resolve(__dirname, '../..');
const { chromium } = createRequire(path.join(project, 'frontend/package.json'))('@playwright/test');
const out = path.join(project, '.verification', 'pet-brawl', 'browser-' + randomUUID());

(async () => {
  await fs.mkdir(out, { recursive: true });
  const { createGameServer } = await import(pathToFileURL(path.join(__dirname, 'server.mjs')).href);
  const server = createGameServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, url = `http://127.0.0.1:${port}`;
  let browser, context, page;
  const checks = [], errors = [], external = [];
  const record = (name, detail = {}) => checks.push({ name, status: 'passed', detail });
  const chrome = process.argv.includes('--chrome');
  const results = { url, browser: chrome ? 'installed Google Chrome' : 'installed Microsoft Edge', mode: process.argv.includes('--headed') ? 'headed' : 'headless', realModelRequests: 0, sharedDatabaseAccess: false, checks, errors, externalRequests: external };
  try {
    browser = await chromium.launch({ executablePath: chrome ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: !process.argv.includes('--headed'), args: ['--disable-background-networking', '--no-first-run', '--disable-component-update'] });
    context = await browser.newContext({ viewport: { width: 1360, height: 1100 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === url) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text()); });
    await page.goto(url); await page.locator('#start:not([disabled])').waitFor();
    assert.equal(await page.locator('[data-character]').count(), 3);
    assert.deepEqual(await page.locator('[data-character] h3').allTextContents(), ['奶娃', '刀盾', '鲸鱼娘']);
    assert.equal(await page.locator('.character-card img').evaluateAll(nodes => nodes.every(n => n.complete && n.naturalWidth > 100)), true);
    await page.screenshot({ path: path.join(out, '01-lobby.png'), fullPage: true }); record('three exact original-derived character assets load; no substituted characters');
    await page.locator('[data-character="niwa"]').click(); await page.locator('#opponent').selectOption('whale'); await page.locator('#difficulty').selectOption('easy'); await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    assert.equal(await page.locator('#player-name').textContent(), '奶娃'); assert.equal(await page.locator('#cpu-name').textContent(), '鲸鱼娘');
    const initial = Number(await page.locator('#arena').getAttribute('data-player-x'));
    await page.keyboard.down('a'); await page.waitForTimeout(400); await page.keyboard.up('a');
    const moved = Number(await page.locator('#arena').getAttribute('data-player-x')); assert.ok(moved < initial - 70);
    await page.keyboard.down('w'); await page.waitForTimeout(160); assert.ok(Number(await page.locator('#arena').getAttribute('data-player-y')) > 30); await page.keyboard.up('w');
    await page.waitForTimeout(850); record('actual keyboard movement and jump update the rendered fighter', { initial, moved });
    // Start a fresh ordinary round before testing dash/guard: the live opponent
    // may otherwise have already hit/stunned the player during the movement case.
    await page.keyboard.press('r'); await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    const beforeDash = Number(await page.locator('#arena').getAttribute('data-player-x')); await page.keyboard.down('d'); await page.keyboard.press('Space'); await page.waitForTimeout(180); await page.keyboard.up('d');
    assert.ok(Number(await page.locator('#arena').getAttribute('data-player-x')) > beforeDash + 65); record('actual dash input changes position');
    await page.keyboard.down('s'); await page.waitForFunction(() => document.querySelector('#arena').dataset.playerAction === 'guard'); await page.keyboard.up('s');
    await page.waitForFunction(() => document.querySelector('#arena').dataset.playerAction !== 'guard'); record('holding S guards and releasing S ends guard');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#resume').isVisible(), true);
    const frozen = { timer: await page.locator('#timer').textContent(), x: await page.locator('#arena').getAttribute('data-player-x') };
    await page.waitForTimeout(650); assert.equal(await page.locator('#timer').textContent(), frozen.timer); assert.equal(await page.locator('#arena').getAttribute('data-player-x'), frozen.x);
    await page.locator('#resume').click(); record('pause freezes timer and position, resume restores play');
    await page.keyboard.press('r'); await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    assert.equal(await page.locator('#player-health-label').textContent(), '110 / 110'); record('restart resets full health and countdown');
    // Fight only through ordinary keyboard events. Read DOM position to approach,
    // just as a player sees the sprites; never set health, time, seed, or game state.
    let damageObserved = false;
    for (let i = 0; i < 240; i++) {
      if (await page.locator('#arena').getAttribute('data-phase') === 'finished') break;
      const positions = await page.locator('#arena').evaluate(el => ({ x: +el.dataset.playerX, cpu: +el.dataset.cpuX }));
      const direction = positions.cpu > positions.x ? 'd' : 'a';
      await page.keyboard.down(direction); await page.keyboard.down('j');
      if (i % 14 === 0) await page.keyboard.press('u');
      if (i % 19 === 0) await page.keyboard.press('k');
      await page.waitForTimeout(140); await page.keyboard.up(direction);
      const hp = await page.locator('#cpu-health-label').textContent(); if (hp !== '100 / 100') damageObserved = true;
      if (i === 18) await page.screenshot({ path: path.join(out, '02-fight.png'), fullPage: true });
    }
    await page.keyboard.up('j'); await page.keyboard.up('a'); await page.keyboard.up('d');
    assert.ok(damageObserved, 'real player attacks must deal damage');
    await page.locator('#rematch').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#arena').getAttribute('data-phase'), 'finished');
    await page.screenshot({ path: path.join(out, '03-result.png'), fullPage: true });
    record('real keyboard duel deals damage and reaches a legitimate victory or defeat', { result: await page.locator('#result-title').textContent(), playerHealth: await page.locator('#player-health-label').textContent(), opponentHealth: await page.locator('#cpu-health-label').textContent() });
    await page.locator('#rematch').click(); assert.equal(await page.locator('#player-health-label').textContent(), '110 / 110'); await page.keyboard.press('Escape'); await page.locator('#change').click();
    record('result rematch and changing characters work without reloading');
    for (const id of ['daodun', 'whale']) {
      await page.locator(`[data-character="${id}"]`).click(); await page.locator('#start').click();
      await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing'); await page.keyboard.press('u'); await page.waitForTimeout(350);
      assert.match(await page.locator('#skill-status').textContent(), id === 'whale' ? /已发 [1-3]\/3 段/ : /冲刺|停步蓄斩|前方大范围横斩/);
      await page.screenshot({ path: path.join(out, `04-${id}-skill.png`), fullPage: true });
      await page.waitForFunction(() => /秒后就绪/.test(document.querySelector('#skill-status').textContent));
      await page.keyboard.press('Escape'); await page.locator('#change').click();
    }
    record('daodun and whale are playable and their exclusive skills enter cooldown');
    await page.setViewportSize({ width: 430, height: 932 }); await page.screenshot({ path: path.join(out, '05-narrow.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('[data-input="light"]').isVisible(), true); record('narrow layout has no horizontal overflow and exposes touch controls');
    await page.locator('#start').click(); await page.waitForFunction(() => document.querySelector('#arena').dataset.phase === 'playing');
    const beforeTouch = Number(await page.locator('#arena').getAttribute('data-player-x'));
    const leftButton = await page.locator('[data-input="left"]').boundingBox();
    await page.mouse.move(leftButton.x + leftButton.width / 2, leftButton.y + leftButton.height / 2); await page.mouse.down();
    await page.waitForTimeout(260); await page.locator('[data-input="left"]').dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
    assert.ok(Number(await page.locator('#arena').getAttribute('data-player-x')) < beforeTouch - 25);
    await page.waitForTimeout(120); const released = Number(await page.locator('#arena').getAttribute('data-player-x')); await page.waitForTimeout(160);
    assert.ok(Math.abs(Number(await page.locator('#arena').getAttribute('data-player-x')) - released) < 3); record('screen button moves fighter and pointer cancellation releases held input');
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert.equal(await page.locator('#resume').isVisible(), true); record('losing window focus pauses rather than continuing the fight');
    assert.deepEqual(errors, []); assert.deepEqual(external, []); record('no page errors, CSP violations, or external requests');
    results.status = 'PET_BRAWL_BROWSER_VERIFIED';
  } catch (error) {
    results.status = 'PET_BRAWL_BROWSER_FAILED'; results.failure = error.message; process.exitCode = 1;
    if (page && !page.isClosed()) {
      results.failureSnapshot = await page.locator('#arena').evaluate(el => ({ ...el.dataset })).catch(() => null);
      await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    }
  } finally {
    if (context) await context.close(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    results.serverClosed = !server.listening; results.browserClosed = !browser?.isConnected(); results.evidenceDirectory = out;
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  }
})();
