'use strict';

// P7 local character acceptance. Real Electron/Win32 and the explicitly isolated
// FastAPI target; model replies are Mock. No system display settings are changed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { samplePerformance } = require('./performance.cjs');

const runFile = promisify(execFile);
const desktopDir = path.resolve(__dirname, '..');
const repository = path.dirname(desktopDir);
const evidence = path.join(repository, '.verification', 'p7');
const mainFile = path.join(desktopDir, 'src', 'main.cjs');
const argument = (name, fallback) => process.argv.slice(2).find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;
const phase = argument('phase', 'all');
const targetFile = path.resolve(argument('target', path.join(repository, '.verification/p6/target.json')));
const COMPLETE = '你可以用它体验已保存会话的流式显示。';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}
async function until(predicate, message, timeout = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { const value = await predicate(); if (value) return value; } catch (cause) { last = cause; }
    await delay(100);
  }
  throw new Error(message + (last ? ': ' + last.message : ''));
}

async function main() {
  assert.equal(process.platform, 'win32', 'Native tests require a real Windows host.');
  assert.ok(['all', 'functional', 'performance', 'dpi'].includes(phase));
  const target = JSON.parse(await fs.readFile(targetFile, 'utf8'));
  assert.equal(target.databaseName, 'weibiye_p6_desktop_test_' + target.runId);
  assert.equal(target.cluster, '7703042374370492450');
  assert.equal(target.schemaVersion, '0006');
  assert.equal(target.backendOrigin, 'http://127.0.0.1:38316');
  assert.equal(target.uiPort, 35316);
  assert.ok(target.accounts.a.pets.length === 3);
  assert.match(target.accounts.a.user_id, UUID);
  for (const pet of target.accounts.a.pets) assert.match(pet.pet_id, UUID);
  const account = target.accounts.a;
  const pets = account.pets;
  const origin = 'http://127.0.0.1:' + target.uiPort;
  const runDirectory = path.join(evidence, 'native-' + crypto.randomUUID());
  await fs.mkdir(runDirectory, { recursive: false });
  const outputFile = path.join(runDirectory, 'results.json');
  const result = {
    startedAt: new Date().toISOString(), status: 'RUNNING', phase,
    database: target.databaseName, provider: 'Mock; no paid model requests',
    checks: [], screenshots: [], performance: [], nativeInput: [], scaling: [],
    authAttempts: [], appInstances: [], notVerified: [
      'Real Windows system-wide 100% and 150% display configurations were not changed or tested.',
      'Independent tail animation requires reliable layered artwork; not inferred from whole-character motion.',
      'Short process metrics do not prove long-duration leak freedom or low-end hardware suitability.'
    ],
  };
  const p6LedgerFile = path.join(repository, '.verification/p6/native-acceptance-ledger.json');
  const p6Ledger = JSON.parse(await fs.readFile(p6LedgerFile, 'utf8'));
  result.comparison = {
    sameRunBaseline: 'Current P7 source with local preview disabled and the original SVG assets; not the old P6 binary.',
    historicalP6Source: p6LedgerFile, historicalP6SourceSha256: hash(await fs.readFile(p6LedgerFile)),
    historicalP6ThreePetSamples: p6Ledger.performance.samples.map(sample => ({
      label: sample.label, durationMs: sample.durationMs, averageCpuPercent: sample.averageCpuPercent,
      averageWorkingSetKiB: sample.averageWorkingSetKiB, peakWorkingSetKiB: sample.peakWorkingSetKiB,
    })),
    noHistoricalSinglePetBaseline: true,
  };
  const save = () => fs.writeFile(outputFile, JSON.stringify(result, null, 2) + '\n');
  let active;
  let cookieJar; // Test session credentials stay in this Node process RAM only.
  let quietGateChecked = false;
  const sourceHashes = {};
  const p6SourceHashes = JSON.parse(await fs.readFile(path.join(repository, '.verification/p6/delivered-source-sha256.json'), 'utf8'));
  for (const name of ['cat.svg', 'dog.svg', 'cloud.svg']) {
    sourceHashes[name] = hash(await fs.readFile(path.join(desktopDir, 'assets', name)));
    assert.equal(sourceHashes[name], p6SourceHashes['desktop/assets/' + name], 'Original P6 art must stay unchanged.');
  }
  function safeError(cause) {
    let value = String(cause.stack || cause);
    for (const secret of [account.password, ...(cookieJar || []).map(cookie => cookie.value)]) {
      if (typeof secret === 'string' && secret.length > 8) value = value.split(secret).join('[redacted]');
    }
    return value;
  }

  async function check(name, operation) {
    const start = Date.now();
    try {
      const detail = await operation();
      result.checks.push({ name, status: 'passed', durationMs: Date.now() - start, ...(detail === undefined ? {} : { detail }) });
      console.log('PASS ' + name);
    } catch (cause) {
      result.checks.push({ name, status: 'failed', durationMs: Date.now() - start, error: safeError(cause) });
      throw cause;
    } finally { await save(); }
  }

  async function inspect(operation, payload) {
    return active.app.evaluate(async ({ app, BrowserWindow, screen }, input) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(input.mainFile);
      const runtime = nodeRequire(input.mainFile).getRuntime();
      const manager = runtime.manager || runtime;
      const handle = window => window && !window.isDestroyed() ? window.getNativeWindowHandle().readBigUInt64LE().toString() : null;
      const snapshot = () => ({
        pid: process.pid, mainHandle: handle(manager.mainWindow), mainId: manager.mainWindow.id,
        mainBounds: manager.mainWindow.getBounds(), ownerId: manager.ownerId,
        displays: screen.getAllDisplays().map(({ id, scaleFactor, bounds, workArea }) => ({ id, scaleFactor, bounds, workArea })),
        records: [...manager.records.values()].map(record => ({ petId: record.identity.pet_id,
          ownerId: record.identity.owner_id, handle: handle(record.window), bounds: record.window.getBounds(),
          visible: record.window.isVisible(), windowId: record.window.id, alwaysOnTop: record.window.isAlwaysOnTop(),
          chatId: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.id : null,
          chatURL: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.webContents.getURL() : null,
          state: manager.world.pets.get(record.identity.pet_id)?.state })),
        windowCount: BrowserWindow.getAllWindows().length,
      });
      switch (input.operation) {
        case 'snapshot': return snapshot();
        case 'cookies-export': return manager.session.cookies.get({ url: manager.origin });
        case 'cookies-import': {
          for (const cookie of input.payload) {
            if (!['weibiye_session', 'weibiye_csrf', '__Host-weibiye_session', '__Host-weibiye_csrf'].includes(cookie.name)) continue;
            const next = { url: manager.origin, name: cookie.name, value: cookie.value, path: cookie.path,
              httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite };
            if (cookie.expirationDate !== undefined) next.expirationDate = cookie.expirationDate;
            await manager.session.cookies.set(next);
          }
          return true; // Never return or persist credential values in evidence.
        }
        case 'arrange': {
          const display = screen.getPrimaryDisplay();
          manager.mainWindow.setBounds(display.workArea);
          manager.mainWindow.show(); manager.mainWindow.setAlwaysOnTop(true); manager.mainWindow.focus();
          const motion = nodeRequire(nodeRequire('node:path').join(nodeRequire('node:path').dirname(input.mainFile), 'motion.cjs'));
          let index = 0;
          for (const record of manager.records.values()) {
            if (record.hidden) continue;
            const point = { x: display.workArea.x + 60 + 220 * index,
              y: display.workArea.y + Math.min(440, Math.max(150, display.workArea.height - 250)) };
            motion.beginDrag(manager.world, record.identity.pet_id, point);
            motion.endDrag(manager.world, record.identity.pet_id);
            manager.world.pets.get(record.identity.pet_id).nextAt = Date.now() + 60000;
            record.window.setBounds({ ...point, width: 188, height: 196 });
            record.window.showInactive(); record.window.moveTop(); index++;
          }
          return snapshot();
        }
        case 'main-normal': manager.mainWindow.setAlwaysOnTop(false); return true;
        case 'focus-pet': manager.mainWindow.setAlwaysOnTop(false); manager.records.get(input.payload).window.moveTop(); return true;
        case 'benchmark': {
          const bounds = manager.world.bounds;
          let index = 0;
          for (const [id, pet] of manager.world.pets) {
            pet.x = bounds.x + 35 + index * 220; pet.y = bounds.y + bounds.height - 215;
            pet.state = input.payload === 'walking' ? 'walking' : 'idle'; pet.nextAt = Date.now() + 60000;
            pet.target = input.payload === 'walking' ? { x: pet.x, y: bounds.y + 25 } : null;
            pet.motionX = pet.x; pet.motionY = pet.y; pet.speed = 10;
            manager.records.get(id).lastState = null; index++;
          }
          return { controlled: true, requestedState: input.payload };
        }
        case 'motion': return [...manager.world.pets.values()].map(pet => ({ pet_id: pet.pet_id, x: pet.x, y: pet.y, state: pet.state }));
        case 'menu': return manager.lastContextMenu?.items.map(item => ({ label: item.label, enabled: item.enabled }));
        case 'close-menu': manager.lastContextMenu?.closePopup(); return true;
        case 'close-chats': for (const record of manager.records.values()) if (record.chatWindow && !record.chatWindow.isDestroyed()) record.chatWindow.close(); return true;
        case 'hide-main': manager.mainWindow.close(); return { visible: manager.mainWindow.isVisible() };
        case 'show-main-tray': {
          const entry = manager.trayMenu.items.find(item => item.label?.includes('主界面'));
          if (!entry) throw new Error('Actual tray show-main action is missing.');
          entry.click(entry, manager.mainWindow, {}); return true;
        }
        case 'quit-tray': {
          const item = manager.trayMenu.getMenuItemById('quit');
          if (!item?.enabled) throw new Error('Actual tray Quit action is missing.');
          setImmediate(() => item.click(item, manager.mainWindow, {})); return true;
        }
        default: throw new Error('Unsupported acceptance observation.');
      }
    }, { mainFile, operation, payload });
  }

  async function api(page, method, requestPath, data) {
    return page.evaluate(async input => {
      const headers = {};
      if (input.method !== 'GET') {
        const token = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
        if (!token.ok) throw new Error('Actual CSRF request failed.');
        headers['X-CSRF-Token'] = (await token.json()).csrf_token;
        headers['Idempotency-Key'] = crypto.randomUUID();
      }
      if (input.data !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(input.requestPath, { method: input.method, credentials: 'include', headers,
        signal: AbortSignal.timeout(15000), body: input.data === undefined ? undefined : JSON.stringify(input.data) });
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    }, { method, requestPath, data });
  }
  async function command(name, id) {
    return active.mainPage.evaluate(async ({ name, id }) => window.weibiyeDesktop[name](id), { name, id });
  }
  async function petPage(id) {
    return until(async () => {
      for (const page of active.app.windows()) {
        if (!page.url().includes('/__pet/pet.html')) continue;
        try {
          const value = await page.evaluate(() => ({ id: document.body.dataset.petId, enabled: !document.getElementById('pet-hitbox').disabled,
            loaded: document.getElementById('pet-art').complete && document.getElementById('pet-art').naturalWidth > 0 }));
          if (value.id === id && value.enabled && value.loaded) return page;
        } catch { /* Wait only for this new window's genuine initial load. */ }
      }
      return null;
    }, 'Expected loaded, enabled native pet renderer ' + id);
  }
  async function release(id) {
    await command('release', id);
    await petPage(id);
    return (await inspect('snapshot')).records.find(record => record.petId === id);
  }
  async function quit() {
    if (!active) return;
    const current = active;
    const closed = current.app.waitForEvent('close', { timeout: 15000 });
    await inspect('quit-tray');
    await closed;
    current.exitExpected = true;
    await until(async () => !(await portOpen(target.uiPort)), 'Native local port stayed open after actual tray Quit.');
    result.appInstances.find(item => item.id === current.id).exited = true;
    active = null;
  }
  async function launch(label, preview, forcedScale) {
    assert.equal(await portOpen(target.uiPort), false, 'Refusing to reuse an unexpected local UI service.');
    const instance = { id: crypto.randomUUID(), label, preview, forcedScale: forcedScale ?? null, exited: false };
    const args = [desktopDir, '--ui-port=' + target.uiPort, '--backend-origin=' + target.backendOrigin,
      '--profile-dir=' + path.join(runDirectory, 'profile-' + instance.id)];
    if (preview) args.push('--local-character-preview=deepseek', '--preview-owner-id=' + account.user_id,
      '--preview-pet-id=' + pets[0].pet_id);
    if (forcedScale !== undefined) args.push('--force-device-scale-factor=' + forcedScale);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: path.join(desktopDir, 'node_modules/electron/dist/electron.exe'),
      args, env, timeout: 30000 });
    active = { app, mainPage: null, id: instance.id, preview, label, forcedScale };
    result.appInstances.push(instance);
    const mainPage = await app.firstWindow();
    active.mainPage = mainPage;
    await mainPage.waitForLoadState('load');
    await expect.poll(() => mainPage.evaluate(() => typeof window.weibiyeDesktop)).toBe('object');
    if (cookieJar) {
      await inspect('cookies-import', cookieJar);
      await mainPage.goto(origin + '/companions');
    } else {
      await mainPage.goto(origin + '/login');
      await mainPage.getByLabel('邮箱', { exact: true }).fill(account.email);
      await mainPage.getByLabel('密码', { exact: true }).fill(account.password);
      const pending = mainPage.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/login'));
      await mainPage.getByRole('button', { name: '登录', exact: true }).click();
      const response = await pending;
      const body = await response.json();
      result.authAttempts.push({ status: response.status(), errorCode: body.error?.code ?? null,
        retryAfter: response.headers()['retry-after'] ?? null });
      await save();
      assert.equal(response.status(), 200, 'Real login failed; preserve the actual limiter response and never clear its keys.');
      await mainPage.waitForURL(url => url.origin === origin && url.pathname !== '/login', { timeout: 15000 });
      await mainPage.goto(origin + '/companions');
    }
    await expect(mainPage.locator('.pet-card')).toHaveCount(3);
    const actual = await api(mainPage, 'GET', '/api/v1/auth/me');
    assert.equal(actual.status, 200); assert.equal(actual.body.id, account.user_id);
    const synced = await command('syncSession');
    assert.equal(synced.authenticated, true); assert.equal(synced.owner_id, account.user_id);
    cookieJar = await inspect('cookies-export');
    assert.ok(cookieJar.some(cookie => cookie.httpOnly && cookie.name.endsWith('weibiye_session')));
    instance.initial = await inspect('snapshot');
    return instance.initial;
  }

  async function renderer(id) {
    const page = await petPage(id);
    return page.evaluate(() => {
      const image = document.getElementById('pet-art');
      const blink = document.getElementById('pet-blink');
      return { petId: document.body.dataset.petId, assetId: document.body.dataset.assetId,
        source: new URL(image.src).pathname, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        dpr: devicePixelRatio, innerWidth, innerHeight, hidden: document.hidden,
        imageRect: image.getBoundingClientRect().toJSON(), hitbox: document.getElementById('pet-hitbox').getBoundingClientRect().toJSON(),
        blinkSource: blink?.getAttribute('src') ?? null, blinkLoaded: !!blink && blink.complete && blink.naturalWidth > 0,
        animations: document.getAnimations().map(animation => ({ state: animation.playState, name: animation.animationName ?? null })) };
    });
  }
  async function verifyThree(preview) {
    const data = [];
    for (let index = 0; index < 3; index++) {
      const value = await renderer(pets[index].pet_id);
      assert.equal(value.source, preview && index === 0 ? '/__assets/deepseek-open.png'
        : '/__assets/' + ['cat', 'dog', 'cloud'][index] + '.svg');
      if (preview && index === 0) {
        assert.equal(value.assetId, 'deepseek-local-preview');
        assert.equal(value.blinkSource, '/__assets/deepseek-blink.png');
        await expect.poll(async () => (await renderer(pets[index].pet_id)).blinkLoaded).toBe(true);
      } else assert.ok(value.assetId !== 'deepseek-local-preview');
      data.push(value);
    }
    assert.equal((await inspect('snapshot')).records.length, 3);
    return data;
  }
  async function screenshot(label) {
    const arranged = await inspect('arrange');
    await delay(350);
    const output = path.join(runDirectory, label + '.png');
    try {
      const response = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'capture.ps1'), '-WindowHandle', arranged.mainHandle,
        '-ExpectedProcessId', String(arranged.pid), '-OutputPath', output, '-AllowedDirectory', runDirectory],
      { windowsHide: true, timeout: 15000 });
      const captured = JSON.parse(response.stdout.trim()); result.screenshots.push(captured);
      return captured;
    } finally { await inspect('main-normal'); }
  }
  async function nativeInput(id, action, delta) {
    const page = await petPage(id);
    await page.evaluate(() => {
      window.__p7Events = [];
      if (window.__p7Observed) return;
      window.__p7Observed = true;
      const button = document.getElementById('pet-hitbox');
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) button.addEventListener(type, event => {
        window.__p7Events.push({ type, trusted: event.isTrusted, button: event.button,
          feedback: document.body.dataset.feedback, filter: getComputedStyle(document.querySelector('.pet-facing')).filter });
      });
    });
    await inspect('focus-pet', id);
    const before = await inspect('snapshot');
    const record = before.records.find(item => item.petId === id);
    const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-interaction.ps1'),
      '-WindowHandle', record.handle, '-ExpectedProcessId', String(before.pid), '-Action', action];
    if (delta) args.push('-DeltaX', String(delta.x), '-DeltaY', String(delta.y));
    const response = await runFile('powershell.exe', args, { windowsHide: true, timeout: 15000 });
    const events = await page.evaluate(() => window.__p7Events);
    assert.ok(events.some(event => event.type === 'pointerdown' && event.trusted));
    const detail = { petId: id, action, native: JSON.parse(response.stdout.trim()), events };
    result.nativeInput.push(detail); await save(); return detail;
  }
  async function measure(label, count) {
    if (!quietGateChecked) {
      const gate = JSON.parse(await fs.readFile(path.join(evidence, 'performance-ready.json'), 'utf8'));
      assert.equal(gate.runId, target.runId); assert.equal(gate.ready, true);
      quietGateChecked = true;
    }
    await inspect('arrange'); await inspect('main-normal');
    for (const state of ['idle', 'walking']) await check(label + ' ' + count + '-pet ' + state + ' real process metrics', async () => {
      await inspect('benchmark', state); await delay(1000);
      const sample = await samplePerformance(active.app, label + ' ' + count + '-pet ' + state, 11000, 1000, () => inspect('motion'));
      assert.ok(sample.samples.every(value => value.petStates.length === count && value.petStates.every(pet => pet.state === state)));
      if (state === 'walking') assert.ok(sample.samples.at(-1).petStates.every((pet, index) => Math.abs(pet.y - sample.samples[0].petStates[index].y) > 50));
      sample.characterMode = label; sample.petCount = count;
      result.performance.push(sample);
      return { sampleCount: sample.sampleCount, durationMs: sample.durationMs,
        averageCpuPercent: sample.averageCpuPercent, averageWorkingSetKiB: sample.averageWorkingSetKiB,
        peakWorkingSetKiB: sample.peakWorkingSetKiB, caveat: sample.caveat };
    });
  }
  async function verifyDpi(label, requestedScale) {
    const initial = await inspect('snapshot');
    const renderers = await verifyThree(true);
    const native = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'native-observe.ps1'), '-ExpectedProcessId', String(initial.pid),
      '-WindowsJson', JSON.stringify(initial.records.map(record => ({ petId: record.petId, handle: record.handle })))],
    { windowsHide: true, timeout: 15000 });
    for (const record of initial.records) {
      assert.ok(Math.abs(record.bounds.width - 188) <= 1 && Math.abs(record.bounds.height - 196) <= 1);
    }
    for (const value of renderers) {
      assert.ok(Math.abs(value.dpr - requestedScale) < 0.03, 'Unexpected actual renderer DPR.');
      assert.ok(value.imageRect.x >= 0 && value.imageRect.y >= 0);
      assert.ok(value.imageRect.right <= value.innerWidth + 1 && value.imageRect.bottom <= value.innerHeight + 1);
    }
    const data = { label, requestedProcessScale: requestedScale, systemDisplayModified: false,
      actualSystemTest: label === 'unforced-current-Windows', originalUnforcedDisplays: result.actualWindowsDisplays,
      reportedDisplays: initial.displays, renderers, native: JSON.parse(native.stdout.trim()) };
    result.scaling.push(data); await screenshot('deepseek-' + label); return data;
  }

  try {
    await check('strict isolated target and empty UI port', async () => {
      assert.equal(await portOpen(target.uiPort), false);
      const ready = await fetch(target.backendOrigin + '/health/ready'); assert.equal(ready.status, 200);
      return { database: target.databaseName, schema: target.schemaVersion, provider: 'Mock' };
    });
    await check('baseline real login and original assets remain unchanged', async () => {
      const initial = await launch('current-code-original-assets', false);
      result.actualWindowsDisplays = initial.displays;
      const forbidden = await active.mainPage.evaluate(async () => (await fetch('/__assets/deepseek-open.png')).status);
      assert.equal(forbidden, 404, 'The default gateway must not serve authorization-unknown preview media.');
      await release(pets[0].pet_id);
      const source = await renderer(pets[0].pet_id); assert.equal(source.source, '/__assets/cat.svg');
      return { displays: initial.displays, cookieReusedLaterOnlyInRam: true, previewMediaStatus: forbidden };
    });
    if (['all', 'performance'].includes(phase)) await measure('baseline', 1);
    for (const pet of pets.slice(1)) await release(pet.pet_id);
    await check('baseline three native pets still use their original SVG roles', () => verifyThree(false));
    if (['all', 'performance'].includes(phase)) await measure('baseline', 3);
    await check('baseline actual tray Quit releases its private UI port', quit);

    await check('preview reuses a real Cookie only in RAM and targets one owner and pet', async () => {
      const initial = await launch('DeepSeek-local-preview', true);
      await release(pets[0].pet_id);
      const value = await renderer(pets[0].pet_id);
      assert.equal(value.assetId, 'deepseek-local-preview'); assert.equal(value.source, '/__assets/deepseek-open.png');
      return { owner: initial.ownerId, targetPet: pets[0].pet_id, actualLoginRequestsSoFar: result.authAttempts.length };
    });
    if (['all', 'performance'].includes(phase)) await measure('preview', 1);
    for (const pet of pets.slice(1)) await release(pet.pet_id);
    await check('only one native character is replaced and the other two stay SVG', () => verifyThree(true));
    if (['all', 'performance'].includes(phase)) await measure('preview', 3);

    if (['all', 'functional', 'dpi'].includes(phase)) {
      const actualScale = result.actualWindowsDisplays[0].scaleFactor;
      await check('real current Windows scaling and new three-pet native screenshot', () => verifyDpi('unforced-current-Windows', actualScale));
    }
    if (['all', 'functional'].includes(phase)) {
      await check('target cutout has genuine alpha and actual blink and breathing states', async () => {
        const page = await petPage(pets[0].pet_id);
        const alpha = await page.evaluate(() => {
          const image = document.getElementById('pet-art');
          const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let clear = 0, visible = 0; for (let i = 3; i < data.length; i += 4) { if (data[i] === 0) clear++; if (data[i] > 0) visible++; }
          return { width: canvas.width, height: canvas.height, clear, visible, topLeftAlpha: data[3] };
        });
        assert.equal(alpha.topLeftAlpha, 0); assert.ok(alpha.clear > alpha.width * alpha.height * 0.05); assert.ok(alpha.visible > 1000);
        const animation = await page.evaluate(async () => {
          const blink = document.getElementById('pet-blink');
          if (!blink || !blink.complete || !blink.naturalWidth) throw new Error('Real blink PNG is not loaded.');
          const opacity = []; const visualTransforms = new Set();
          const animations = document.getAnimations().map(item => ({ name: item.animationName ?? null, playState: item.playState }));
          const started = performance.now();
          while (performance.now() - started < 5500) {
            opacity.push(Number(getComputedStyle(blink).opacity));
            visualTransforms.add(getComputedStyle(document.querySelector('.pet-visual')).transform);
            await new Promise(resolve => setTimeout(resolve, 40));
          }
          return { animations, min: Math.min(...opacity), max: Math.max(...opacity), samples: opacity.length,
            visualTransforms: [...visualTransforms] };
        });
        assert.ok(animation.max > 0.5 && animation.min < 0.05, 'Actual blink opacity must alternate, not just have a class name.');
        assert.ok(animation.animations.some(item => item.playState === 'running' && item.name === 'deepseek-breathe'));
        assert.ok(animation.visualTransforms.length > 1, 'Breathing must change the actual visual transform.');
        return { alpha, animation, independentTailAnimation: 'not implemented; not inferred from breathing' };
      });
      await check('real native drag and pressed feedback do not accidentally open chat', async () => {
        await inspect('arrange'); await inspect('main-normal'); await delay(150);
        const detail = await nativeInput(pets[0].pet_id, 'drag', { x: 70, y: -25 });
        assert.ok(detail.events.some(event => event.type === 'pointerdown' && event.trusted && event.feedback === 'pressed' && event.filter !== 'none'));
        assert.ok(detail.events.some(event => event.type === 'pointerup' && event.trusted && event.feedback === 'idle' && event.filter === 'none'));
        assert.ok(Math.hypot(detail.native.after.x - detail.native.before.x, detail.native.after.y - detail.native.before.y) > 20);
        assert.equal((await inspect('snapshot')).records.find(record => record.petId === pets[0].pet_id).chatId, null);
        return detail;
      });
      await check('real moving-pet short click opens its own native chat', async () => {
        await inspect('benchmark', 'walking'); await delay(300);
        const detail = await nativeInput(pets[0].pet_id, 'click');
        const record = await until(async () => (await inspect('snapshot')).records.find(value => value.petId === pets[0].pet_id && value.chatId), 'Click did not open target native chat.');
        assert.ok(record.chatURL.includes('/pets/' + pets[0].pet_id)); return { detail, chatId: record.chatId, petId: record.petId };
      });
      await check('real character chat receives Mock SSE and restores persisted scoped history', async () => {
        const chat = await until(async () => active.app.windows().find(page => page !== active.mainPage && page.url().includes('/pets/' + pets[0].pet_id)), 'Expected distinct scoped chat page.');
        await chat.waitForLoadState('load');
        await expect(chat.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible();
        const message = 'P7 本地角色预览验收 ' + crypto.randomUUID();
        await chat.getByLabel('聊天消息', { exact: true }).fill(message);
        const pending = chat.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
        await chat.getByRole('button', { name: '发送消息', exact: true }).click();
        const response = await pending; assert.equal(response.status(), 202);
        const data = await response.json(); assert.equal(data.generation.pet_id, pets[0].pet_id);
        await expect(chat.locator('.message-assistant').last()).toContainText(COMPLETE, { timeout: 45000 });
        await expect(chat.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
        await chat.reload(); await expect(chat.getByRole('log')).toContainText(message);
        const history = await api(chat, 'GET', '/api/v1/pets/' + pets[0].pet_id + '/sessions/' + data.generation.session_id + '/messages');
        assert.equal(history.status, 200); assert.ok(history.body.items.some(item => item.content === message));
        assert.ok(history.body.items.every(item => item.pet_id === pets[0].pet_id));
        await active.mainPage.goto(origin + '/pets/' + pets[0].pet_id + '/chat/' + data.generation.session_id);
        await expect(active.mainPage.getByRole('log')).toContainText(message);
        await screenshot('deepseek-mock-chat-real-Windows');
        await inspect('close-chats');
        return { sessionId: data.generation.session_id, generationId: data.generation.id, messageId: data.user_message.id, provider: 'Mock', messagePersisted: true };
      });
      await check('native right-click menu, hide, recall and re-release preserve other pets', async () => {
        await inspect('arrange'); await inspect('main-normal');
        await nativeInput(pets[0].pet_id, 'context');
        const menu = await inspect('menu'); assert.ok(menu.some(item => item.label === '打开聊天'));
        assert.ok(menu.some(item => item.label === '收回这只宠物')); await inspect('close-menu');
        const otherIds = (await inspect('snapshot')).records.filter(item => item.petId !== pets[0].pet_id).map(item => item.windowId);
        await command('hide', pets[0].pet_id);
        assert.equal((await inspect('snapshot')).records.find(item => item.petId === pets[0].pet_id).visible, false);
        await command('show', pets[0].pet_id); await command('recall', pets[0].pet_id);
        assert.deepEqual((await inspect('snapshot')).records.map(item => item.windowId), otherIds);
        await release(pets[0].pet_id); assert.equal((await renderer(pets[0].pet_id)).source, '/__assets/deepseek-open.png');
        await inspect('hide-main'); await inspect('show-main-tray');
        return { actualContextMenu: menu, hideShowRecall: true, otherWindowIdsPreserved: true };
      });
    }
    await check('preview actual tray Quit releases its private UI port', quit);
    if (['all', 'dpi'].includes(phase)) for (const scale of [1, 1.5]) {
      await check('process-only rendering scale ' + scale + ' launches without changing Windows display settings', async () => {
        await launch('process-scale-' + scale, true, scale);
        for (const pet of pets) await release(pet.pet_id);
        return verifyDpi('process-only-' + scale, scale);
      });
      await check('process-only scale ' + scale + ' normal tray shutdown', quit);
    }
    await check('original cat dog and cloud files are byte-identical', async () => {
      for (const [name, digest] of Object.entries(sourceHashes)) assert.equal(hash(await fs.readFile(path.join(desktopDir, 'assets', name))), digest);
      return sourceHashes;
    });
    result.status = 'PASSED_WITH_EXPLICIT_LIMITATIONS';
  } catch (cause) {
    result.status = 'FAILED'; result.error = safeError(cause); process.exitCode = 1;
  } finally {
    if (active) {
      const current = active;
      try { await current.app.close(); current.exitExpected = true; }
      catch (cause) { result.cleanupError = safeError(cause); process.exitCode = 1; }
      active = null;
    }
    cookieJar = undefined;
    result.completedAt = new Date().toISOString();
    result.passed = result.checks.filter(item => item.status === 'passed').length;
    result.failed = result.checks.filter(item => item.status === 'failed').length;
    result.skipped = 0;
    result.uiPortStillListening = await portOpen(target.uiPort);
    if (result.uiPortStillListening) { result.status = 'FAILED'; process.exitCode = 1; }
    await save();
    console.log(JSON.stringify({ status: result.status, passed: result.passed, failed: result.failed, skipped: result.skipped,
      resultFile: outputFile, screenshots: result.screenshots.map(item => item.file), performanceSamples: result.performance.length,
      realSystem100And150Tested: false, systemDisplayModified: false }));
  }
}

main().catch(cause => { console.error(String(cause.message)); process.exitCode = 1; });
