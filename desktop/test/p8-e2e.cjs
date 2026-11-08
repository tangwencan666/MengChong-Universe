'use strict';

// Real Windows/Electron/React/FastAPI/PostgreSQL/Redis acceptance. The ordinary
// DeepSeek SDK/provider/factory/runner execute against p8_offline_server.py's
// in-process HTTPX MockTransport. This is explicitly NOT a real model test.
// No credentials, request bodies, prompts or response transcripts are saved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');

const runFile = promisify(execFile);
const desktopDir = path.resolve(__dirname, '..');
const repository = path.dirname(desktopDir);
const evidenceRoot = path.join(repository, '.verification', 'p8');
const mainFile = path.join(desktopDir, 'src', 'main.cjs');
const argument = (name, fallback) => process.argv.slice(2).find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;
const targetFile = path.resolve(argument('target', path.join(evidenceRoot, 'target.json')));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPLETE = '【DeepSeek 离线模拟】SDK 流式链路已连通；没有访问真实模型。';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function until(operation, message, timeout = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { const value = await operation(); if (value) return value; }
    catch (cause) { last = cause; }
    await delay(100);
  }
  throw new Error(message + (last ? ': ' + last.message : ''));
}

function eventFrames(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n\n')
    .filter(frame => frame.split('\n').some(line => line.startsWith('data: ')))
    .map(frame => {
      const lines = frame.split('\n');
      return { event: lines.find(line => line.startsWith('event: '))?.slice(7),
        id: lines.find(line => line.startsWith('id: '))?.slice(4),
        data: JSON.parse(lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')) };
    });
}

async function main() {
  assert.equal(process.platform, 'win32', 'P8 native acceptance requires Windows.');
  const target = JSON.parse(await fs.readFile(targetFile, 'utf8'));
  const baseline = JSON.parse(await fs.readFile(path.join(repository, '.verification/p6/target.json'), 'utf8'));
  assert.equal(target.databaseName, 'weibiye_p6_desktop_test_' + baseline.runId);
  assert.notEqual(target.databaseName, 'weibiye');
  assert.equal(target.cluster, '7703042374370492450');
  assert.equal(target.schemaVersion, '0006');
  assert.equal(target.backendOrigin, 'http://127.0.0.1:38318');
  assert.equal(target.uiPort, 35318);
  assert.match(target.p8RunId, /^[0-9a-f]{32}$/);
  assert.equal(target.redisPrefix, 'weibiye:p8:' + target.p8RunId + ':');
  // Compare without an assertion diff that could print fixture credentials.
  assert.ok(hash(JSON.stringify(target.accounts)) === hash(JSON.stringify(baseline.accounts)), 'P8 must use the preverified synthetic P6 identities.');
  for (const key of ['a', 'b']) {
    const account = target.accounts[key];
    assert.match(account.user_id, UUID);
    assert.ok(typeof account.email === 'string' && /@example\.(com|test)$/.test(account.email), 'Synthetic test email required.');
    assert.ok(typeof account.password === 'string' && account.password.length >= 12, 'Synthetic test password required.');
    assert.ok(account.pets.length >= (key === 'a' ? 3 : 1));
    for (const pet of account.pets) assert.match(pet.pet_id, UUID);
  }
  assert.notEqual(target.accounts.a.user_id, target.accounts.b.user_id);
  const accountA = target.accounts.a, accountB = target.accounts.b;
  const pets = accountA.pets.slice(0, 3);
  const uiOrigin = 'http://127.0.0.1:' + target.uiPort;
  const runDirectory = path.join(evidenceRoot, 'electron-offline-' + crypto.randomUUID());
  await fs.mkdir(runDirectory, { recursive: false });
  const resultFile = path.join(runDirectory, 'results.json');
  const result = {
    startedAt: new Date().toISOString(), status: 'RUNNING', simulatedModel: true,
    infrastructure: 'Real Electron/React/FastAPI/PostgreSQL/Redis; existing isolated 0006 test database only',
    provider: 'Actual DeepSeek adapter with in-process HTTPX MockTransport; no real model endpoint contacted',
    externalModelRequests: 0, actualExternalApiFee: 0, realModelVerified: false,
    database: target.databaseName, redisPrefix: target.redisPrefix,
    checks: [], screenshots: [], authAttempts: [], notVerified: [
      'Real DeepSeek API connectivity, model quality, billable usage and actual provider pricing require a separately approved request.',
      'This run does not migrate the shared development database or change any Docker resources.',
      'Upstream resource cleanup is observed through local transport close events; no long-duration leak or performance claim is made.',
    ],
  };
  let app, mainPage, exitedNormally = false;
  const secrets = [accountA.password, accountB.password, accountA.email, accountB.email];
  const safeError = cause => {
    let text = String(cause.stack || cause);
    for (const secret of secrets) if (typeof secret === 'string' && secret.length > 5) text = text.split(secret).join('[redacted]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  };
  const save = () => fs.writeFile(resultFile, JSON.stringify(result, null, 2) + '\n');
  async function check(name, operation) {
    const started = Date.now();
    try {
      const detail = await operation();
      result.checks.push({ name, status: 'passed', durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
      console.log('PASS ' + name);
    } catch (cause) {
      result.checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: safeError(cause) });
      throw cause;
    } finally { await save(); }
  }
  async function observations() {
    try {
      const entries = (await fs.readFile(path.join(evidenceRoot, 'transport-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      assert.ok(entries.every(entry => ['request', 'stream_closed'].includes(entry.event)));
      assert.ok(entries.every(entry => entry.event === 'request'
        ? entry.model === 'deepseek-flash' && Object.keys(entry).length === 2
        : Object.keys(entry).length === 1), 'Offline observations must not contain bodies, headers or credentials.');
      return { requests: entries.filter(entry => entry.event === 'request').length,
        closed: entries.filter(entry => entry.event === 'stream_closed').length };
    } catch (cause) { if (cause.code === 'ENOENT') return { requests: 0, closed: 0 }; throw cause; }
  }
  async function inspect(operation, payload) {
    return app.evaluate(async ({ BrowserWindow, screen }, input) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(input.mainFile);
      const runtime = nodeRequire(input.mainFile).getRuntime();
      const manager = runtime.manager || runtime;
      const handle = win => win && !win.isDestroyed() ? win.getNativeWindowHandle().readBigUInt64LE().toString() : null;
      const snapshot = () => ({ pid: process.pid, mainHandle: handle(manager.mainWindow), ownerId: manager.ownerId,
        records: [...manager.records.values()].map(record => ({ petId: record.identity.pet_id, ownerId: record.identity.owner_id,
          windowId: record.window.id, handle: handle(record.window), bounds: record.window.getBounds(),
          visible: record.window.isVisible(), topmost: record.window.isAlwaysOnTop(),
          chatId: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.id : null,
          chatURL: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.webContents.getURL() : null })),
        windows: BrowserWindow.getAllWindows().length });
      switch (input.operation) {
        case 'snapshot': return snapshot();
        case 'cookie-flags': {
          const flags = cookie => ({ name: cookie.name, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite });
          return { ui: (await manager.session.cookies.get({ url: manager.origin })).map(flags),
            pet: (await manager.petSession.cookies.get({ url: manager.origin })).map(flags) };
        }
        case 'arrange': {
          const area = screen.getPrimaryDisplay().workArea;
          manager.mainWindow.setBounds(area); manager.mainWindow.show(); manager.mainWindow.focus(); manager.mainWindow.setAlwaysOnTop(true);
          const motion = nodeRequire(nodeRequire('node:path').join(nodeRequire('node:path').dirname(input.mainFile), 'motion.cjs'));
          let index = 0;
          for (const record of manager.records.values()) {
            const point = { x: area.x + 65 + 225 * index, y: area.y + Math.max(120, Math.min(430, area.height - 240)) };
            motion.beginDrag(manager.world, record.identity.pet_id, point); motion.endDrag(manager.world, record.identity.pet_id);
            const pet = manager.world.pets.get(record.identity.pet_id); pet.nextAt = Number.MAX_SAFE_INTEGER;
            record.window.setBounds({ ...point, width: 188, height: 196 }); record.window.showInactive(); record.window.moveTop(); index++;
          }
          return snapshot();
        }
        case 'main-normal': manager.mainWindow.setAlwaysOnTop(false); return true;
        case 'capture-target': {
          const win = input.payload ? manager.records.get(input.payload)?.chatWindow : manager.mainWindow;
          if (!win || win.isDestroyed()) throw new Error('The expected capture window is unavailable.');
          win.show(); win.focus(); win.moveTop();
          return { pid: process.pid, handle: handle(win) };
        }
        case 'focus-pet': {
          // Arrange only this acceptance instance. Never click through or hide
          // another application's covering window to force a native input.
          manager.mainWindow.setAlwaysOnTop(false); manager.mainWindow.hide();
          for (const record of manager.records.values()) {
            if (record.chatWindow && !record.chatWindow.isDestroyed()) record.chatWindow.hide();
          }
          const win = manager.records.get(input.payload).window;
          win.show(); win.focus(); win.moveTop(); return true;
        }
        case 'quit-tray': {
          const item = manager.trayMenu.getMenuItemById('quit');
          if (!item?.enabled) throw new Error('The actual tray Quit action is unavailable.');
          setImmediate(() => item.click(item, manager.mainWindow, {})); return true;
        }
        default: throw new Error('Unsupported P8 observation.');
      }
    }, { mainFile, operation, payload });
  }
  async function api(page, method, requestPath, body, idempotencyKey, extraHeaders = {}, csrf = true) {
    return page.evaluate(async input => {
      const headers = { ...input.extraHeaders };
      if (!['GET', 'HEAD'].includes(input.method) && input.csrf) {
        const token = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
        if (!token.ok) throw new Error('P8 could not obtain the authenticated CSRF token.');
        headers['X-CSRF-Token'] = (await token.json()).csrf_token;
      }
      if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
      if (input.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(input.requestPath, { method: input.method, headers, credentials: 'include',
        body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data };
    }, { method, requestPath, body, idempotencyKey, extraHeaders, csrf });
  }
  async function login(account) {
    await mainPage.goto(uiOrigin + '/login');
    await mainPage.getByLabel('邮箱', { exact: true }).fill(account.email);
    await mainPage.getByLabel('密码', { exact: true }).fill(account.password);
    const pending = mainPage.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/login'));
    await mainPage.getByRole('button', { name: '登录', exact: true }).click();
    const response = await pending;
    result.authAttempts.push({ status: response.status() });
    assert.equal(response.status(), 200, 'P8 real isolated login failed; no limiter keys will be deleted.');
    await mainPage.waitForURL(url => url.origin === uiOrigin && url.pathname !== '/login');
    const profile = await api(mainPage, 'GET', '/api/v1/auth/me');
    assert.equal(profile.status, 200); assert.equal(profile.data.id, account.user_id);
    return profile.data.id;
  }
  async function command(name, petId) {
    return mainPage.evaluate(async input => window.weibiyeDesktop[input.name](input.petId), { name, petId });
  }
  async function petPage(id) {
    return until(async () => {
      for (const page of app.windows()) {
        if (!page.url().includes('/__pet/pet.html')) continue;
        const current = await page.evaluate(() => ({ id: document.body.dataset.petId, enabled: !document.getElementById('pet-hitbox').disabled }));
        if (current.id === id && current.enabled) return page;
      }
      return null;
    }, 'The authorized native pet renderer did not initialize.');
  }
  async function nativeClick(id) {
    const renderer = await petPage(id);
    await renderer.evaluate(() => {
      window.__p8PointerEvents = [];
      const button = document.getElementById('pet-hitbox');
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        button.addEventListener(type, event => window.__p8PointerEvents.push({ type, trusted: event.isTrusted }));
      }
    });
    await inspect('focus-pet', id);
    await delay(250);
    const snapshot = await inspect('snapshot');
    const record = snapshot.records.find(item => item.petId === id);
    await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'native-interaction.ps1'), '-WindowHandle', record.handle,
      '-ExpectedProcessId', String(snapshot.pid), '-Action', 'click'], { windowsHide: true, timeout: 15000 });
    try { return await until(async () => {
      const current = (await inspect('snapshot')).records.find(item => item.petId === id);
      if (!current?.chatId) return null;
      for (const page of app.windows()) if (page !== mainPage && page.url().includes('/pets/' + id)) {
        await page.waitForLoadState('load'); return page;
      }
      return null;
    }, 'The native click did not open the matching pet chat.'); }
    catch (cause) {
      result.nativeInputFailure = { petId: id, events: await renderer.evaluate(() => window.__p8PointerEvents) };
      throw cause;
    }
  }
  async function assertRuntime(page) {
    const response = await api(page, 'GET', '/api/v1/companion/runtime');
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { schema_version: 'chat-runtime/1', provider: 'deepseek', model: 'deepseek-flash',
      mode: 'real', billing: 'external_provider', memory_injection_enabled: false });
    return response.data;
  }
  async function assertDisclosure(page) {
    await expect(page.locator('#composer-disclosure')).toContainText('DeepSeek · deepseek-flash');
    await expect(page.locator('#composer-disclosure')).toContainText('可能产生 API 费用');
    await expect(page.locator('#composer-disclosure')).toContainText('本次消息及当前会话历史将发往模型服务商');
    await expect(page.locator('#composer-disclosure')).toContainText('本次不额外注入长期记忆');
    await expect(page.locator('#composer-disclosure')).not.toContainText('不计费');
  }
  async function sendUi(page, petId, message) {
    await assertDisclosure(page);
    // Record lengths only, never save private message text in acceptance output.
    await page.evaluate(() => {
      window.__p8Lengths = [];
      window.__p8Observer?.disconnect();
      window.__p8Observer = new MutationObserver(() => {
        const paragraph = [...document.querySelectorAll('.message-assistant .message-body > p')].at(-1);
        const content = paragraph?.textContent ?? '';
        const count = content.startsWith('【DeepSeek') ? content.length : 0;
        if (count && window.__p8Lengths.at(-1) !== count) window.__p8Lengths.push(count);
      });
      window.__p8Observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByLabel('聊天消息', { exact: true }).fill(message);
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().includes('/api/v1/pets/' + petId + '/sessions/') && response.url().endsWith('/messages'));
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 202);
    const accepted = await response.json();
    assert.equal(accepted.generation.pet_id, petId); assert.equal(accepted.generation.provider, 'deepseek');
    assert.equal(accepted.generation.model, 'deepseek-flash');
    // These request details remain in this Node process only, for an exact replay.
    return { accepted, body: response.request().postDataJSON(), key: response.request().headers()['idempotency-key'] };
  }
  async function completeUi(page) {
    await expect(page.locator('.message-assistant').last()).toContainText(COMPLETE, { timeout: 30000 });
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(page.locator('.message-assistant .message-author').last()).toContainText('DeepSeek');
  }
  async function captureNative() {
    const snapshot = await inspect('arrange'); await delay(350);
    const file = path.join(runDirectory, 'windows-three-pets.png');
    try {
      const output = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'capture.ps1'), '-WindowHandle', snapshot.mainHandle, '-ExpectedProcessId', String(snapshot.pid),
        '-OutputPath', file, '-AllowedDirectory', runDirectory], { windowsHide: true, timeout: 15000 });
      const detail = JSON.parse(output.stdout.trim()); result.screenshots.push(detail); return detail;
    } finally { await inspect('main-normal'); }
  }
  async function captureChat(petId, label) {
    // Chromium screenshots of occluded Electron windows can stall even after
    // successful streaming. Capture the actual, PID-verified Windows surface.
    const target = await inspect('capture-target', petId);
    await delay(300);
    const file = path.join(runDirectory, label + '.png');
    const output = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'capture.ps1'), '-WindowHandle', target.handle, '-ExpectedProcessId', String(target.pid),
      '-OutputPath', file, '-AllowedDirectory', runDirectory], { windowsHide: true, timeout: 15000 });
    const detail = JSON.parse(output.stdout.trim()); result.screenshots.push(detail); return detail;
  }
  function generationPath(petId, accepted) {
    return '/api/v1/pets/' + petId + '/sessions/' + accepted.generation.session_id + '/generations/' + accepted.generation.id;
  }
  let chatA, firstAccepted, firstRequest, initialTransport;
  try {
    await check('verified isolated target, healthy real API and unused P8 UI port', async () => {
      assert.equal(await portOpen(target.uiPort), false, 'An existing UI owns the P8 port; refuse duplicate startup.');
      assert.equal((await fetch(target.backendOrigin + '/health/live')).status, 200);
      assert.equal((await fetch(target.backendOrigin + '/health/ready')).status, 200);
      initialTransport = await observations();
      return { database: target.databaseName, schemaVersion: target.schemaVersion, backendOrigin: target.backendOrigin,
        uiPort: target.uiPort, transportCountsBefore: initialTransport, simulatedModel: true };
    });
    await check('actual Electron starts without receiving model key environment variables', async () => {
      const env = desktopEnvironment(process.env);
      app = await _electron.launch({ executablePath: path.join(desktopDir, 'node_modules/electron/dist/electron.exe'),
        args: [desktopDir, '--ui-port=' + target.uiPort, '--backend-origin=' + target.backendOrigin,
          '--profile-dir=' + path.join(runDirectory, 'profile'), '--local-character-preview=deepseek',
          '--preview-owner-id=' + accountA.user_id, '--preview-pet-id=' + pets[0].pet_id], env, timeout: 30000 });
      mainPage = await app.firstWindow(); mainPage.setDefaultTimeout(15000);
      await mainPage.waitForLoadState('load');
      await expect.poll(() => mainPage.evaluate(() => typeof window.weibiyeDesktop)).toBe('object');
      const runtime = await api(mainPage, 'GET', '/api/v1/companion/runtime');
      assert.equal(runtime.status, 401);
      return { unauthenticatedRuntime: 401, modelEnvironmentForwarded: false, actualNativePid: (await inspect('snapshot')).pid };
    });
    await check('real Cookie login, CSRF enforcement and six-field runtime disclosure', async () => {
      assert.equal(await login(accountA), accountA.user_id);
      const flags = await inspect('cookie-flags');
      const auth = flags.ui.find(cookie => cookie.name.endsWith('weibiye_session'));
      assert.ok(auth?.httpOnly); assert.equal(auth.sameSite, 'lax');
      assert.equal(flags.pet.some(cookie => cookie.name.endsWith('weibiye_session')), false);
      assert.equal(await mainPage.evaluate(() => document.cookie.includes('weibiye_session')), false);
      const forbidden = await api(mainPage, 'POST', '/api/v1/pets/' + pets[0].pet_id + '/sessions', { title: 'P8 CSRF rejection' }, crypto.randomUUID(), {}, false);
      assert.equal(forbidden.status, 403);
      const runtime = await assertRuntime(mainPage);
      const synced = await command('syncSession'); assert.equal(synced.owner_id, accountA.user_id);
      return { runtime, httpOnly: true, sameSite: auth.sameSite, missingCsrfStatus: forbidden.status };
    });
    await check('three real native pets retain distinct owner and pet identities', async () => {
      await mainPage.goto(uiOrigin + '/companions');
      for (const pet of pets) {
        const card = mainPage.locator('.pet-card').filter({ has: mainPage.getByRole('heading', { name: pet.name, exact: true }) });
        await card.getByRole('button', { name: '放到桌面', exact: true }).click();
        await petPage(pet.pet_id);
      }
      const snapshot = await inspect('snapshot');
      assert.equal(snapshot.records.length, 3);
      assert.equal(new Set(snapshot.records.map(item => item.windowId)).size, 3);
      assert.ok(snapshot.records.every(item => item.visible && item.topmost && item.ownerId === accountA.user_id));
      await captureNative();
      return snapshot.records.map(({ petId, windowId, visible, topmost }) => ({ petId, windowId, visible, topmost }));
    });
    await check('actual native clicks open three matching React chat windows', async () => {
      const chats = [];
      for (const pet of pets) {
        const page = await nativeClick(pet.pet_id); await assertDisclosure(page); chats.push(page);
      }
      const records = (await inspect('snapshot')).records;
      assert.equal(new Set(records.map(item => item.chatId)).size, 3);
      assert.ok(records.every(item => item.chatURL.includes('/pets/' + item.petId)));
      chatA = chats[0];
      return records.map(({ petId, chatId }) => ({ petId, chatId }));
    });
    await check('real UI sends through the offline DeepSeek adapter, streams and persists history', async () => {
      await inspect('capture-target', pets[0].pet_id);
      const before = await observations();
      firstRequest = await sendUi(chatA, pets[0].pet_id, 'P8 离线桌面链路验收 ' + crypto.randomUUID());
      firstAccepted = firstRequest.accepted;
      await completeUi(chatA);
      const lengths = await chatA.evaluate(() => { window.__p8Observer?.disconnect(); return window.__p8Lengths; });
      assert.ok(new Set(lengths).size >= 2, 'The actual React renderer must show multiple streamed lengths.');
      await until(async () => (await observations()).closed > before.closed, 'Completed DeepSeek response was not closed.');
      assert.equal((await observations()).requests, before.requests + 1);
      const history = await api(chatA, 'GET', '/api/v1/pets/' + pets[0].pet_id + '/sessions/' + firstAccepted.generation.session_id + '/messages');
      assert.equal(history.status, 200);
      const saved = history.data.items.find(item => item.id === firstAccepted.assistant_message.id);
      assert.equal(saved.content, COMPLETE); assert.equal(saved.provider, 'deepseek'); assert.equal(saved.pet_id, pets[0].pet_id);
      await chatA.reload(); await completeUi(chatA); await assertDisclosure(chatA);
      await captureChat(pets[0].pet_id, 'deepseek-offline-chat-a');
      return { sessionId: firstAccepted.generation.session_id, generationId: firstAccepted.generation.id,
        assistantMessageId: saved.id, renderedLengths: lengths, realApiHistory: true, restoredAfterReload: true, simulatedModel: true };
    });
    await check('exact idempotent POST replay returns the same task without another upstream request', async () => {
      const before = await observations();
      const replay = await api(chatA, 'POST', '/api/v1/pets/' + pets[0].pet_id + '/sessions/' + firstAccepted.generation.session_id + '/messages', firstRequest.body, firstRequest.key);
      assert.equal(replay.status, 202); assert.equal(replay.data.idempotent_replay, true);
      assert.equal(replay.data.generation.id, firstAccepted.generation.id);
      assert.equal(replay.data.user_message.id, firstAccepted.user_message.id);
      await delay(300); assert.equal((await observations()).requests, before.requests);
      firstRequest = undefined;
      return { idempotentReplay: true, sameGeneration: true, sameUserMessage: true, extraUpstreamRequests: 0 };
    });
    await check('live SSE disconnect resumes with Last-Event-ID and replays the journal without duplicate generation', async () => {
      const before = await observations();
      const base = '/api/v1/pets/' + pets[0].pet_id + '/sessions/' + firstAccepted.generation.session_id;
      const sent = await api(chatA, 'POST', base + '/messages', { content: 'P8 隔离 SSE 恢复验收 ' + crypto.randomUUID(), client_message_id: crypto.randomUUID() }, crypto.randomUUID());
      assert.equal(sent.status, 202);
      const accepted = sent.data, eventPath = generationPath(pets[0].pet_id, accepted) + '/events';
      const partial = await chatA.evaluate(async input => {
        const controller = new AbortController();
        const response = await fetch(input.path, { credentials: 'include', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('P8 live event subscription failed.');
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) throw new Error('Expected a delta before disconnect.');
            text += decoder.decode(chunk.value, { stream: true });
            const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
            if (normalized.includes('event: delta\n') && normalized.endsWith('\n\n')) {
              await reader.cancel(); controller.abort(); return { status: response.status, text };
            }
          }
        } finally { clearTimeout(timeout); controller.abort(); }
      }, { path: eventPath });
      const firstFrames = eventFrames(partial.text);
      assert.ok(firstFrames.some(frame => frame.event === 'start'));
      assert.ok(firstFrames.some(frame => frame.event === 'delta'));
      assert.equal(firstFrames.some(frame => frame.event === 'completed'), false);
      const cursor = firstFrames.at(-1).id;
      assert.ok(cursor && cursor.startsWith(accepted.generation.id + ':'));
      const resumed = await api(chatA, 'GET', eventPath, undefined, undefined, { 'Last-Event-ID': cursor });
      assert.equal(resumed.status, 200);
      const replay = eventFrames(resumed.data);
      assert.ok(replay.length > 0);
      const sequence = frame => Number(frame.id.split(':').at(-1));
      assert.ok(replay.every(frame => frame.data.pet_id === pets[0].pet_id && sequence(frame) > sequence(firstFrames.at(-1))));
      assert.equal(new Set([...firstFrames, ...replay].map(frame => frame.id)).size, firstFrames.length + replay.length);
      const terminal = replay.at(-1);
      assert.equal(terminal.event, 'completed'); assert.equal(terminal.data.content, COMPLETE);
      assert.deepEqual(terminal.data.usage, { input_tokens: 40, output_tokens: 20 });
      const replayAgain = await api(chatA, 'GET', eventPath, undefined, undefined, { 'Last-Event-ID': cursor });
      assert.equal(replayAgain.status, 200); assert.deepEqual(eventFrames(replayAgain.data).map(frame => frame.id), replay.map(frame => frame.id));
      const snapshot = await api(chatA, 'GET', generationPath(pets[0].pet_id, accepted));
      assert.equal(snapshot.status, 200); assert.equal(snapshot.data.generation.state, 'completed'); assert.equal(snapshot.data.assistant_message.content, COMPLETE);
      await until(async () => (await observations()).closed > before.closed, 'Recovered provider stream was not closed.');
      assert.equal((await observations()).requests, before.requests + 1);
      return { generationId: accepted.generation.id, firstEvents: firstFrames.length, replayedEvents: replay.length,
        resumeCursor: cursor, duplicateEventIds: 0, upstreamRequests: 1, identicalSecondReplay: true, usage: terminal.data.usage };
    });
    await check('actual UI stop reaches cancelled terminal state and closes the provider stream', async () => {
      await chatA.goto(uiOrigin + '/pets/' + pets[0].pet_id);
      const before = await observations();
      const sent = await sendUi(chatA, pets[0].pet_id, 'P8 取消生成验收 ' + crypto.randomUUID());
      await until(async () => (await observations()).requests === before.requests + 1, 'DeepSeek adapter did not begin the cancellable response.');
      await chatA.getByRole('button', { name: '停止生成', exact: true }).click();
      const snapshot = await until(async () => {
        const value = await api(chatA, 'GET', generationPath(pets[0].pet_id, sent.accepted));
        assert.equal(value.status, 200); return value.data.generation.state === 'cancelled' ? value.data : null;
      }, 'Stop did not reach the persisted cancelled terminal state.');
      assert.equal(snapshot.assistant_message.status, 'cancelled');
      await expect(chatA.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
      await expect(chatA.getByRole('log')).toContainText('已停止生成');
      const events = await api(chatA, 'GET', generationPath(pets[0].pet_id, sent.accepted) + '/events');
      assert.equal(events.status, 200); assert.equal(eventFrames(events.data).at(-1).event, 'cancelled');
      await until(async () => (await observations()).closed > before.closed, 'Cancellation did not close the upstream response.');
      assert.equal((await observations()).requests, before.requests + 1);
      return { generationId: sent.accepted.generation.id, state: 'cancelled', assistantStatus: 'cancelled', upstreamCloseObserved: true };
    });
    await check('same account cannot read or send through another pet scope', async () => {
      const base = '/api/v1/pets/' + pets[1].pet_id + '/sessions/' + firstAccepted.generation.session_id;
      const before = await observations();
      const detail = await api(mainPage, 'GET', base);
      const messages = await api(mainPage, 'GET', base + '/messages');
      const events = await api(mainPage, 'GET', base + '/generations/' + firstAccepted.generation.id + '/events');
      const send = await api(mainPage, 'POST', base + '/messages', { content: '不应创建跨宠物消息', client_message_id: crypto.randomUUID() }, crypto.randomUUID());
      for (const response of [detail, messages, events, send]) assert.equal(response.status, 404);
      assert.equal((await observations()).requests, before.requests);
      const own = await api(mainPage, 'GET', '/api/v1/pets/' + pets[1].pet_id + '/sessions');
      assert.equal(own.status, 200); assert.ok(own.data.items.every(item => item.pet_id === pets[1].pet_id));
      assert.ok(!own.data.items.some(item => item.id === firstAccepted.generation.session_id));
      return { detail: 404, messages: 404, events: 404, send: 404, extraUpstreamRequests: 0 };
    });
    await check('real logout revokes API access and removes native private windows', async () => {
      await mainPage.goto(uiOrigin + '/me');
      await mainPage.getByRole('button', { name: '退出登录', exact: true }).click();
      await mainPage.waitForURL(url => url.origin === uiOrigin && url.pathname === '/login');
      const runtime = await api(mainPage, 'GET', '/api/v1/companion/runtime');
      const history = await api(mainPage, 'GET', '/api/v1/pets/' + pets[0].pet_id + '/sessions/' + firstAccepted.generation.session_id + '/messages');
      assert.equal(runtime.status, 401); assert.equal(history.status, 401);
      await until(async () => (await inspect('snapshot')).records.length === 0, 'Logout left private native pet or chat windows alive.');
      return { runtime: 401, privateHistory: 401, nativePrivateWindows: 0 };
    });
    await check('second real account cannot read, stream, cancel or mutate the first account resources', async () => {
      assert.equal(await login(accountB), accountB.user_id);
      const synced = await command('syncSession'); assert.equal(synced.owner_id, accountB.user_id);
      assert.equal((await inspect('snapshot')).records.length, 0);
      const base = '/api/v1/pets/' + pets[0].pet_id + '/sessions/' + firstAccepted.generation.session_id;
      const before = await observations();
      const responses = [await api(mainPage, 'GET', '/api/v1/pets/' + pets[0].pet_id),
        await api(mainPage, 'GET', base), await api(mainPage, 'GET', base + '/messages'),
        await api(mainPage, 'GET', base + '/generations/' + firstAccepted.generation.id + '/events'),
        await api(mainPage, 'POST', base + '/generations/' + firstAccepted.generation.id + '/cancel', {})];
      for (const response of responses) assert.equal(response.status, 404);
      assert.equal((await observations()).requests, before.requests);
      const petB = accountB.pets[0]; await mainPage.goto(uiOrigin + '/pets/' + petB.pet_id);
      await assertDisclosure(mainPage);
      const sent = await sendUi(mainPage, petB.pet_id, 'P8 第二测试账号隔离验收 ' + crypto.randomUUID());
      await completeUi(mainPage); await mainPage.reload(); await completeUi(mainPage);
      const history = await api(mainPage, 'GET', '/api/v1/pets/' + petB.pet_id + '/sessions/' + sent.accepted.generation.session_id + '/messages');
      assert.equal(history.status, 200); assert.ok(history.data.items.every(item => item.pet_id === petB.pet_id));
      await captureChat(null, 'deepseek-offline-chat-b');
      await until(async () => (await observations()).closed > before.closed, 'Second account provider response was not closed.');
      assert.equal((await observations()).requests, before.requests + 1);
      await mainPage.goto(uiOrigin + '/me');
      await mainPage.getByRole('button', { name: '退出登录', exact: true }).click();
      await mainPage.waitForURL(url => url.origin === uiOrigin && url.pathname === '/login');
      assert.equal((await api(mainPage, 'GET', '/api/v1/pets/' + petB.pet_id + '/sessions/' + sent.accepted.generation.session_id + '/messages')).status, 401);
      return { foreignPet: 404, foreignSession: 404, foreignMessages: 404, foreignEvents: 404, foreignCancel: 404,
        ownSessionId: sent.accepted.generation.session_id, ownPetId: petB.pet_id, refreshedOwnHistory: true, secondLogoutHistory: 401, extraForeignUpstreamRequests: 0 };
    });
    await check('actual tray Quit closes Electron and releases only its P8 private UI port', async () => {
      const closed = app.waitForEvent('close', { timeout: 20000 });
      await inspect('quit-tray'); await closed; exitedNormally = true;
      await until(async () => !(await portOpen(target.uiPort)), 'The private P8 gateway did not release its port.');
      assert.equal((await fetch(target.backendOrigin + '/health/ready')).status, 200, 'Desktop Quit must not stop the separately owned test backend.');
      return { normalTrayExit: true, uiPortReleased: true, separateBackendRemainsHealthy: true };
    });
    result.status = 'VERIFIED_OFFLINE_DEEPSEEK_ADAPTER';
  } catch (cause) {
    result.status = 'FAILED'; result.error = safeError(cause); process.exitCode = 1;
  } finally {
    if (app && !exitedNormally) {
      try { await app.close(); }
      catch (cause) { result.cleanupError = safeError(cause); process.exitCode = 1; result.status = 'FAILED'; }
    }
    result.completedAt = new Date().toISOString();
    result.passed = result.checks.filter(check => check.status === 'passed').length;
    result.failed = result.checks.filter(check => check.status === 'failed').length;
    result.skipped = 0;
    result.notRun = result.status === 'VERIFIED_OFFLINE_DEEPSEEK_ADAPTER' ? 0 : 13 - result.checks.length;
    result.transportCountsAfter = await observations();
    result.transportRequestsThisRun = result.transportCountsAfter.requests - (initialTransport?.requests ?? result.transportCountsAfter.requests);
    result.transportCloseEventsThisRun = result.transportCountsAfter.closed - (initialTransport?.closed ?? result.transportCountsAfter.closed);
    result.uiPortStillListening = await portOpen(target.uiPort);
    if (result.uiPortStillListening) { result.status = 'FAILED'; process.exitCode = 1; }
    await save();
    console.log(JSON.stringify({ status: result.status, passed: result.passed, failed: result.failed, skipped: result.skipped,
      notRun: result.notRun, simulatedModel: true, realModelVerified: false, externalModelRequests: 0, actualExternalApiFee: 0,
      resultFile, screenshots: result.screenshots.map(item => item.file), uiPortStillListening: result.uiPortStillListening }));
  }
}

main().catch(cause => { console.error('P8 acceptance setup failed: ' + String(cause.message)); process.exitCode = 1; });
