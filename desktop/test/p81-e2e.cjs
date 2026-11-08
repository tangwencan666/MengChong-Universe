'use strict';

// P8.1 offline-only acceptance. Actual Electron/React/FastAPI/PG/Redis and
// ordinary DeepSeek SDK run; the backend's only upstream is HTTPX MockTransport.
// No physical mouse, OS-wide input, screen scraping or real model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');

const desktopDir = path.resolve(__dirname, '..');
const repository = path.dirname(desktopDir);
const evidenceRoot = path.join(repository, '.verification', 'p81');
const mainFile = path.join(desktopDir, 'src', 'main.cjs');
const COMPLETE = '【P8.1 离线模拟】月芽的 DeepSeek 流式链路已连通，没有调用真实模型。';
const MOCK_COMPLETE = '你可以用它体验已保存会话的流式显示。';
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
async function until(operation, message, timeout = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { const value = await operation(); if (value) return value; }
    catch (cause) { last = cause; }
    await delay(1000);
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
  assert.equal(process.platform, 'win32', 'P8.1 actual Electron acceptance requires Windows.');
  const target = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'target.json'), 'utf8'));
  const baseline = JSON.parse(await fs.readFile(path.join(repository, '.verification/p6/target.json'), 'utf8'));
  assert.equal(target.modelTransport, 'httpx-mock-only', 'This automated suite is forbidden against a real model service.');
  assert.equal(target.databaseName, 'weibiye_p6_desktop_test_' + baseline.runId);
  assert.equal(target.cluster, '7703042374370492450');
  assert.equal(target.schemaVersion, '0006');
  assert.equal(target.backendOrigin, 'http://127.0.0.1:38319');
  assert.equal(target.uiPort, 35319);
  assert.match(target.p81RunId, /^[0-9a-f]{32}$/);
  assert.equal(target.redisPrefix, 'weibiye:p81:' + target.p81RunId + ':');
  assert.ok(hash(JSON.stringify(target.accounts)) === hash(JSON.stringify(baseline.accounts)), 'Only existing verified synthetic identities may be used.');
  for (const name of ['a', 'b']) {
    const account = target.accounts[name];
    assert.match(account.user_id, UUID);
    assert.ok(typeof account.email === 'string' && /@example\.(com|test)$/.test(account.email), 'Only synthetic identities may be used.');
    assert.ok(typeof account.password === 'string' && account.password.length >= 12);
    for (const pet of account.pets) assert.match(pet.pet_id, UUID);
  }
  const accountA = target.accounts.a, accountB = target.accounts.b;
  assert.notEqual(accountA.user_id, accountB.user_id);
  assert.equal(target.moonOwnerId, accountA.user_id);
  assert.match(target.moonPetId, UUID);
  const pets = accountA.pets;
  assert.equal(pets.length, 3);
  const moon = pets.find(pet => pet.pet_id === target.moonPetId);
  assert.ok(moon && moon.name === '月芽', 'The explicitly bound target must be the verified Moon pet.');
  const otherPets = pets.filter(pet => pet.pet_id !== moon.pet_id);
  assert.deepEqual(new Set(otherPets.map(pet => pet.name)), new Set(['豆包', '小云']));
  const uiOrigin = 'http://127.0.0.1:' + target.uiPort;
  const runDirectory = path.join(evidenceRoot, 'electron-offline-' + crypto.randomUUID());
  await fs.mkdir(runDirectory, { recursive: false });
  const resultsFile = path.join(runDirectory, 'results.json');
  const result = {
    startedAt: new Date().toISOString(), status: 'RUNNING', simulatedModel: true,
    realModelVerified: false, externalModelRequests: 0, actualExternalApiFee: 0,
    database: target.databaseName, redisPrefix: target.redisPrefix,
    scope: { ownerId: target.moonOwnerId, petId: target.moonPetId, provider: 'deepseek', model: 'deepseek-flash' },
    inputMethod: 'Playwright input in the actual Electron renderer; no global Windows mouse input',
    checks: [], screenshots: [], authAttempts: [], notVerified: [
      'Real DeepSeek network, model quality and billing require a separately approved bounded request.',
      'Renderer captures prove actual Electron webContents output, not Windows desktop composition or physical mouse hit testing.',
      'No native physical pointer, DPI, animation-performance or long-duration resource claim is made by this suite.',
    ],
  };
  const secrets = [accountA.email, accountB.email, accountA.password, accountB.password];
  const safeError = cause => {
    let value = String(cause.stack || cause);
    for (const secret of secrets) if (typeof secret === 'string' && secret.length > 5) value = value.split(secret).join('[redacted]');
    return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  };
  const save = () => fs.writeFile(resultsFile, JSON.stringify(result, null, 2) + '\n');
  let app, mainPage, exitedNormally = false;
  const chatPages = new Map();
  const expectedChecks = 15;
  let initialTransport;

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
      const rows = (await fs.readFile(path.join(evidenceRoot, 'transport-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      assert.ok(rows.every(row => ['request', 'stream_closed'].includes(row.event)));
      assert.ok(rows.every(row => Object.keys(row).every(key => ['event', 'model', 'status'].includes(key))), 'Transport evidence must not contain request contents or credentials.');
      return { requests: rows.filter(row => row.event === 'request').length,
        closed: rows.filter(row => row.event === 'stream_closed').length };
    } catch (cause) { if (cause.code === 'ENOENT') return { requests: 0, closed: 0 }; throw cause; }
  }
  async function inspect(operation) {
    return app.evaluate(async (_electron, input) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(input.mainFile);
      const runtime = nodeRequire(input.mainFile).getRuntime();
      const manager = runtime.manager || runtime;
      switch (input.operation) {
        case 'snapshot': return { pid: process.pid, ownerId: manager.ownerId,
          records: [...manager.records.values()].map(record => ({ petId: record.identity.pet_id, ownerId: record.identity.owner_id,
            windowId: record.window.id, webContentsId: record.window.webContents.id,
            visible: record.window.isVisible(), topmost: record.window.isAlwaysOnTop(),
            chatId: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.id : null,
            chatURL: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.webContents.getURL() : null })) };
        case 'cookie-flags': {
          const flags = cookie => ({ name: cookie.name, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite });
          return { ui: (await manager.session.cookies.get({ url: manager.origin })).map(flags),
            pet: (await manager.petSession.cookies.get({ url: manager.origin })).map(flags) };
        }
        case 'quit-tray': {
          const item = manager.trayMenu.getMenuItemById('quit');
          if (!item?.enabled) throw new Error('Actual tray Quit unavailable.');
          setImmediate(() => item.click(item, manager.mainWindow, {})); return true;
        }
        default: throw new Error('Unsupported read-only acceptance observation.');
      }
    }, { operation, mainFile });
  }
  async function api(page, method, requestPath, body, key, extraHeaders = {}, csrf = true) {
    return page.evaluate(async input => {
      const headers = { ...input.extraHeaders };
      if (!['GET', 'HEAD'].includes(input.method) && input.csrf) {
        const token = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
        if (!token.ok) throw new Error('Actual CSRF fetch failed.');
        headers['X-CSRF-Token'] = (await token.json()).csrf_token;
      }
      if (input.key) headers['Idempotency-Key'] = input.key;
      if (input.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(input.path, { method: input.method, credentials: 'include', headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data };
    }, { method, path: requestPath, body, key, extraHeaders, csrf });
  }
  async function login(account) {
    await mainPage.goto(uiOrigin + '/login');
    await mainPage.getByLabel('邮箱', { exact: true }).fill(account.email);
    await mainPage.getByLabel('密码', { exact: true }).fill(account.password);
    const pending = mainPage.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/login'));
    await mainPage.getByRole('button', { name: '登录', exact: true }).click();
    const response = await pending;
    result.authAttempts.push({ status: response.status() });
    assert.equal(response.status(), 200, 'Synthetic login failed; no limiter keys will be cleared.');
    await mainPage.waitForURL(url => url.origin === uiOrigin && url.pathname !== '/login');
    const me = await api(mainPage, 'GET', '/api/v1/auth/me');
    assert.equal(me.status, 200); assert.equal(me.data.id, account.user_id);
  }
  async function runtime(page, pet, provider) {
    const route = pet ? '/api/v1/pets/' + pet.pet_id + '/runtime' : '/api/v1/companion/runtime';
    const response = await api(page, 'GET', route);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.data).sort(), ['schema_version', 'provider', 'model', 'mode', 'billing', 'memory_injection_enabled'].sort());
    assert.equal(response.data.schema_version, 'chat-runtime/1');
    assert.equal(response.data.provider, provider);
    assert.equal(response.data.model, provider === 'mock' ? null : 'deepseek-flash');
    assert.equal(response.data.mode, provider === 'mock' ? 'mock' : 'real');
    assert.equal(response.data.billing, provider === 'mock' ? 'none' : 'external_provider');
    assert.equal(typeof response.data.memory_injection_enabled, 'boolean');
    if (provider === 'deepseek') assert.equal(response.data.memory_injection_enabled, false);
    return response.data;
  }
  async function disclosure(page, provider) {
    const view = page.locator('#composer-disclosure');
    // Three native chat windows start independent authenticated requests. Wait
    // for the real disclosure state, rather than treating pending UI as Mock.
    await expect(view).not.toContainText('模型配置尚未确认', { timeout: 15000 });
    if (provider === 'deepseek') {
      await expect(view).toContainText('DeepSeek · deepseek-flash');
      await expect(view).toContainText('可能产生 API 费用');
      await expect(view).toContainText('本次消息及当前会话历史将发往模型服务商');
      await expect(view).toContainText('本次不额外注入长期记忆');
      await expect(view).not.toContainText('不计费');
    } else {
      await expect(view).toContainText('本地 Mock');
      await expect(view).toContainText('不计费');
      await expect(view).not.toContainText('DeepSeek');
    }
  }
  async function petPage(petId) {
    return until(async () => {
      for (const page of app.windows()) {
        if (!page.url().includes('/__pet/pet.html')) continue;
        const value = await page.evaluate(() => ({ petId: document.body.dataset.petId,
          enabled: !document.getElementById('pet-hitbox').disabled }));
        if (value.petId === petId && value.enabled) return page;
      }
      return null;
    }, 'Actual owned pet renderer did not initialize.');
  }
  async function openChat(pet) {
    const page = await petPage(pet.pet_id);
    // CDP input targets this actual renderer. It does not move the OS mouse and
    // still executes pointer handler -> preload -> checked IPC -> real auth API.
    await page.getByRole('button', { name: '和' + pet.name + '聊天', exact: true }).click();
    const chat = await until(async () => {
      const record = (await inspect('snapshot')).records.find(item => item.petId === pet.pet_id);
      if (!record?.chatId) return null;
      for (const candidate of app.windows()) {
        if (candidate === mainPage || !candidate.url().startsWith(uiOrigin + '/pets/' + pet.pet_id)) continue;
        await candidate.waitForLoadState('load'); return candidate;
      }
      return null;
    }, 'Actual pet renderer click did not open its scoped chat.');
    chatPages.set(pet.pet_id, chat); return chat;
  }
  async function capture(page, label, petId) {
    const expectedURL = page.url();
    assert.ok(expectedURL.startsWith(uiOrigin + '/'), 'Only this acceptance origin may be captured.');
    if (petId) assert.ok(expectedURL.startsWith(uiOrigin + '/pets/' + petId));
    const win = await app.browserWindow(page);
    const captured = await Promise.race([
      win.evaluate(async (window, expected) => {
        if (window.isDestroyed() || window.webContents.getURL() !== expected) throw new Error('Capture window changed.');
        const image = await window.webContents.capturePage();
        if (image.isEmpty()) throw new Error('Actual webContents capture is empty.');
        return { windowId: window.id, webContentsId: window.webContents.id, rendererPid: window.webContents.getOSProcessId(),
          url: window.webContents.getURL(), size: image.getSize(), png: image.toPNG().toString('base64') };
      }, expectedURL),
      delay(12000).then(() => { throw new Error('Actual Electron webContents capture timed out.'); }),
    ]);
    const bytes = Buffer.from(captured.png, 'base64');
    assert.ok(bytes.length > 100 && captured.size.width > 0 && captured.size.height > 0);
    assert.equal(captured.url, expectedURL);
    const file = path.join(runDirectory, label + '.png');
    await fs.writeFile(file, bytes, { flag: 'wx' });
    delete captured.png;
    result.screenshots.push({ ...captured, file, sha256: hash(bytes), captureType: 'Actual Electron webContents, not Windows desktop composition' });
  }
  async function sendUi(page, pet, content, provider) {
    await disclosure(page, provider);
    await page.getByLabel('聊天消息', { exact: true }).fill(content);
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().includes('/api/v1/pets/' + pet.pet_id + '/sessions/') && response.url().endsWith('/messages'));
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 202);
    const accepted = await response.json();
    assert.equal(accepted.generation.pet_id, pet.pet_id);
    assert.equal(accepted.generation.provider, provider);
    assert.equal(accepted.generation.model, provider === 'mock' ? null : 'deepseek-flash');
    // Exact intent is RAM-only, for an idempotency regression. Never persisted.
    return { accepted, body: response.request().postDataJSON(), key: response.request().headers()['idempotency-key'] };
  }
  async function completed(page, provider) {
    await expect(page.locator('.message-assistant').last()).toContainText(provider === 'mock' ? MOCK_COMPLETE : COMPLETE, { timeout: 30000 });
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(page.locator('.message-assistant .message-author').last()).toContainText(provider === 'mock' ? 'Mock' : 'DeepSeek');
  }
  function generationPath(pet, accepted) {
    return '/api/v1/pets/' + pet.pet_id + '/sessions/' + accepted.generation.session_id + '/generations/' + accepted.generation.id;
  }
  let moonPage, firstRequest, firstAccepted;

  try {
    await check('strict isolated offline manifest and real dependency readiness', async () => {
      assert.equal(await portOpen(target.uiPort), false, 'Do not reuse an unrelated existing UI service.');
      assert.equal((await fetch(target.backendOrigin + '/health/live')).status, 200);
      assert.equal((await fetch(target.backendOrigin + '/health/ready')).status, 200);
      initialTransport = await observations();
      return { database: target.databaseName, schema: target.schemaVersion, modelTransport: target.modelTransport };
    });
    await check('real Electron launches with no backend model environment and unauthenticated runtime is denied', async () => {
      app = await _electron.launch({ executablePath: path.join(desktopDir, 'node_modules/electron/dist/electron.exe'),
        args: [desktopDir, '--ui-port=' + target.uiPort, '--backend-origin=' + target.backendOrigin,
          '--profile-dir=' + path.join(runDirectory, 'profile'), '--local-character-preview=deepseek',
          '--preview-owner-id=' + accountA.user_id, '--preview-pet-id=' + moon.pet_id],
        env: desktopEnvironment(process.env), timeout: 30000 });
      mainPage = await app.firstWindow(); mainPage.setDefaultTimeout(15000);
      await mainPage.waitForLoadState('load');
      await expect.poll(() => mainPage.evaluate(() => typeof window.weibiyeDesktop)).toBe('object');
      const environment = await app.evaluate(() => Object.keys(process.env).filter(name => /^(?:WEIBIYE_|OPENAI_|DEEPSEEK_)/i.test(name)));
      assert.deepEqual(environment, []);
      assert.equal((await api(mainPage, 'GET', '/api/v1/pets/' + moon.pet_id + '/runtime')).status, 401);
      return { modelEnvironmentForwarded: false, unauthenticatedPetRuntime: 401 };
    });
    await check('Cookie, CSRF and effective per-pet model disclosure use actual authentication', async () => {
      await login(accountA);
      const flags = await inspect('cookie-flags');
      const session = flags.ui.find(cookie => cookie.name.endsWith('weibiye_session'));
      assert.ok(session?.httpOnly); assert.equal(session.sameSite, 'lax');
      assert.equal(flags.pet.some(cookie => cookie.name.endsWith('weibiye_session')), false);
      assert.equal(await mainPage.evaluate(() => document.cookie.includes('weibiye_session')), false);
      const forbidden = await api(mainPage, 'POST', '/api/v1/pets/' + moon.pet_id + '/sessions', { title: 'P81 CSRF rejection' }, crypto.randomUUID(), {}, false);
      assert.equal(forbidden.status, 403);
      const legacy = await runtime(mainPage, null, 'mock');
      const modes = [];
      for (const pet of pets) modes.push({ petId: pet.pet_id, ...(await runtime(mainPage, pet, pet.pet_id === moon.pet_id ? 'deepseek' : 'mock')) });
      return { httpOnly: true, sameSite: session.sameSite, csrfStatus: forbidden.status, legacyProvider: legacy.provider, pets: modes };
    });
    await check('actual React UI releases three native pets with independent identities', async () => {
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
      for (const pet of pets) {
        const renderer = await petPage(pet.pet_id);
        const source = await renderer.locator('#pet-art').getAttribute('src');
        assert.equal(source === '/__assets/deepseek-open.png', pet.pet_id === moon.pet_id);
      }
      await capture(mainPage, 'actual-electron-three-pet-controls');
      await capture(await petPage(moon.pet_id), 'actual-moon-pet-renderer');
      return { nativePetWindows: 3, physicalMouseUsed: false, targetPreviewOnly: true };
    });
    await check('real pet renderer clicks open matching private chats without global mouse input', async () => {
      for (const pet of pets) {
        const chat = await openChat(pet);
        await disclosure(chat, pet.pet_id === moon.pet_id ? 'deepseek' : 'mock');
      }
      const records = (await inspect('snapshot')).records;
      assert.equal(new Set(records.map(item => item.chatId)).size, 3);
      assert.ok(records.every(item => item.chatURL.startsWith(uiOrigin + '/pets/' + item.petId)));
      moonPage = chatPages.get(moon.pet_id);
      return records.map(({ petId, chatId }) => ({ petId, chatId }));
    });
    await check('Doubao and Xiaoyun remain Mock with stored history and no DeepSeek transport requests', async () => {
      const before = await observations();
      const checked = [];
      for (const pet of otherPets) {
        const page = chatPages.get(pet.pet_id);
        const sent = await sendUi(page, pet, 'P81 Mock pet regression ' + crypto.randomUUID(), 'mock');
        await completed(page, 'mock');
        const history = await api(page, 'GET', '/api/v1/pets/' + pet.pet_id + '/sessions/' + sent.accepted.generation.session_id + '/messages');
        assert.equal(history.status, 200);
        const assistant = history.data.items.find(item => item.id === sent.accepted.assistant_message.id);
        assert.equal(assistant.provider, 'mock'); assert.equal(assistant.pet_id, pet.pet_id);
        await page.reload(); await completed(page, 'mock'); await disclosure(page, 'mock');
        checked.push({ petId: pet.pet_id, provider: 'mock', historyRestored: true });
      }
      assert.equal((await observations()).requests, before.requests);
      // Keep the existing 120 owner reads/minute protection intact. Three native
      // windows already revalidate identity; separate the chat-heavy scenarios
      // instead of clearing limiter keys or increasing production limits.
      console.log('Pacing the next phase for the unchanged owner read limit.');
      await delay(60000);
      return { pets: checked, extraDeepSeekRequests: 0 };
    });
    await check('Moon uses the offline DeepSeek SDK with visible streaming and persisted history', async () => {
      const before = await observations();
      await moonPage.evaluate(() => {
        window.__p81Lengths = [];
        window.__p81Observer = new MutationObserver(() => {
          const value = [...document.querySelectorAll('.message-assistant .message-body > p')].at(-1)?.textContent ?? '';
          if (value.startsWith('【P8.1') && window.__p81Lengths.at(-1) !== value.length) window.__p81Lengths.push(value.length);
        });
        window.__p81Observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      firstRequest = await sendUi(moonPage, moon, 'P81 Moon offline SDK streaming ' + crypto.randomUUID(), 'deepseek');
      firstAccepted = firstRequest.accepted;
      await completed(moonPage, 'deepseek');
      const lengths = await moonPage.evaluate(() => { window.__p81Observer.disconnect(); return window.__p81Lengths; });
      assert.ok(new Set(lengths).size >= 2, 'Actual React must render at least two streamed content lengths.');
      const history = await api(moonPage, 'GET', '/api/v1/pets/' + moon.pet_id + '/sessions/' + firstAccepted.generation.session_id + '/messages');
      assert.equal(history.status, 200);
      const saved = history.data.items.find(item => item.id === firstAccepted.assistant_message.id);
      assert.equal(saved.content, COMPLETE); assert.equal(saved.provider, 'deepseek'); assert.equal(saved.pet_id, moon.pet_id);
      const refs = await api(moonPage, 'GET', generationPath(moon, firstAccepted) + '/memory-refs');
      assert.equal(refs.status, 200); assert.equal(refs.data.pet_id, moon.pet_id); assert.deepEqual(refs.data.items, []);
      await moonPage.reload(); await completed(moonPage, 'deepseek'); await disclosure(moonPage, 'deepseek');
      await until(async () => (await observations()).closed > before.closed, 'Completed upstream stream was not closed.');
      assert.equal((await observations()).requests, before.requests + 1);
      await capture(moonPage, 'actual-moon-offline-sdk-chat', moon.pet_id);
      return { sessionId: firstAccepted.generation.session_id, generationId: firstAccepted.generation.id,
        assistantMessageId: saved.id, renderedLengths: lengths, historyRestored: true, provider: 'deepseek', simulatedModel: true };
    });
    await check('same idempotent message reuses its frozen Moon generation without another model request', async () => {
      const before = await observations();
      const response = await api(moonPage, 'POST', '/api/v1/pets/' + moon.pet_id + '/sessions/' + firstAccepted.generation.session_id + '/messages', firstRequest.body, firstRequest.key);
      assert.equal(response.status, 202); assert.equal(response.data.idempotent_replay, true);
      assert.equal(response.data.generation.id, firstAccepted.generation.id);
      assert.equal(response.data.user_message.id, firstAccepted.user_message.id);
      assert.equal(response.data.generation.provider, 'deepseek'); assert.equal(response.data.generation.pet_id, moon.pet_id);
      await delay(250); assert.equal((await observations()).requests, before.requests);
      firstRequest = undefined;
      return { sameGeneration: true, sameUserMessage: true, extraDeepSeekRequests: 0 };
    });
    await check('SSE disconnect replays the same Moon journal with Last-Event-ID and no duplicate generation', async () => {
      const before = await observations();
      const base = '/api/v1/pets/' + moon.pet_id + '/sessions/' + firstAccepted.generation.session_id;
      const sent = await api(moonPage, 'POST', base + '/messages', { content: 'P81 SSE replay ' + crypto.randomUUID(), client_message_id: crypto.randomUUID() }, crypto.randomUUID());
      assert.equal(sent.status, 202); assert.equal(sent.data.generation.provider, 'deepseek');
      const eventPath = generationPath(moon, sent.data) + '/events';
      const partial = await moonPage.evaluate(async route => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(route, { credentials: 'include', signal: controller.signal });
          if (!response.ok || !response.body) throw new Error('Actual Moon SSE connection failed.');
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
          while (true) {
            const next = await reader.read(); if (next.done) throw new Error('SSE ended before a delta.');
            text += decoder.decode(next.value, { stream: true });
            const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
            if (normalized.includes('event: delta\n') && normalized.endsWith('\n\n')) {
              await reader.cancel(); controller.abort(); return text;
            }
          }
        } finally { clearTimeout(timeout); controller.abort(); }
      }, eventPath);
      const prefix = eventFrames(partial);
      assert.ok(prefix.some(event => event.event === 'start'));
      assert.ok(prefix.some(event => event.event === 'delta'));
      assert.equal(prefix.some(event => event.event === 'completed'), false);
      const cursor = prefix.at(-1).id;
      assert.ok(cursor.startsWith(sent.data.generation.id + ':'));
      const replay = await api(moonPage, 'GET', eventPath, undefined, undefined, { 'Last-Event-ID': cursor });
      assert.equal(replay.status, 200);
      const suffix = eventFrames(replay.data), seq = event => Number(event.id.split(':').at(-1));
      assert.ok(suffix.length > 0 && suffix.every(event => event.data.pet_id === moon.pet_id && seq(event) > seq(prefix.at(-1))));
      assert.equal(new Set([...prefix, ...suffix].map(event => event.id)).size, prefix.length + suffix.length);
      assert.equal(suffix.at(-1).event, 'completed'); assert.equal(suffix.at(-1).data.content, COMPLETE);
      assert.deepEqual(suffix.at(-1).data.usage, { input_tokens: 40, output_tokens: 20 });
      const second = await api(moonPage, 'GET', eventPath, undefined, undefined, { 'Last-Event-ID': cursor });
      assert.equal(second.status, 200); assert.deepEqual(eventFrames(second.data).map(event => event.id), suffix.map(event => event.id));
      await until(async () => (await observations()).closed > before.closed, 'Replayed generation stream did not close.');
      assert.equal((await observations()).requests, before.requests + 1);
      return { generationId: sent.data.generation.id, prefixEvents: prefix.length, replayEvents: suffix.length,
        duplicateEventIds: 0, extraGenerations: 0, upstreamRequests: 1, usage: suffix.at(-1).data.usage };
    });
    await check('actual UI cancel persists a terminal state and closes the Moon provider stream', async () => {
      await moonPage.goto(uiOrigin + '/pets/' + moon.pet_id);
      const before = await observations();
      const sent = await sendUi(moonPage, moon, 'P81 cancel ' + crypto.randomUUID(), 'deepseek');
      await until(async () => (await observations()).requests === before.requests + 1, 'Cancellable Moon stream did not start.');
      await moonPage.getByRole('button', { name: '停止生成', exact: true }).click();
      const snapshot = await until(async () => {
        const response = await api(moonPage, 'GET', generationPath(moon, sent.accepted));
        assert.equal(response.status, 200);
        return response.data.generation.state === 'cancelled' ? response.data : null;
      }, 'Moon cancel did not persist.');
      assert.equal(snapshot.assistant_message.status, 'cancelled');
      await expect(moonPage.getByRole('log')).toContainText('已停止生成');
      await expect(moonPage.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
      const events = await api(moonPage, 'GET', generationPath(moon, sent.accepted) + '/events');
      assert.equal(events.status, 200); assert.equal(eventFrames(events.data).at(-1).event, 'cancelled');
      await until(async () => (await observations()).closed > before.closed, 'Cancelled upstream stream did not close.');
      assert.equal((await observations()).requests, before.requests + 1);
      return { generationId: sent.accepted.generation.id, state: 'cancelled', streamClosed: true };
    });
    await check('simulated upstream 429 becomes a persisted safe error without automatic paid retry', async () => {
      // Deliberately independent session: the fixture marker must not enter a
      // later test's history or be interpreted as a production control route.
      await moonPage.goto(uiOrigin + '/pets/' + moon.pet_id);
      const before = await observations();
      const sent = await sendUi(moonPage, moon, 'P81_SIMULATE_UPSTREAM_429', 'deepseek');
      const snapshot = await until(async () => {
        const response = await api(moonPage, 'GET', generationPath(moon, sent.accepted));
        assert.equal(response.status, 200);
        return response.data.generation.state === 'failed' ? response.data : null;
      }, 'Upstream failure was not persisted.');
      assert.equal(snapshot.assistant_message.status, 'failed');
      assert.equal(snapshot.generation.error.code, 'PROVIDER_FAILED');
      assert.equal(typeof snapshot.generation.error.message, 'string');
      await expect(moonPage.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
      const events = await api(moonPage, 'GET', generationPath(moon, sent.accepted) + '/events');
      assert.equal(events.status, 200); assert.equal(eventFrames(events.data).at(-1).event, 'error');
      await moonPage.reload();
      await expect(moonPage.getByRole('log')).toContainText('这次回复未完成');
      await delay(300); assert.equal((await observations()).requests, before.requests + 1);
      await capture(moonPage, 'actual-moon-safe-upstream-error', moon.pet_id);
      return { generationId: sent.accepted.generation.id, state: 'failed', safeErrorCode: snapshot.generation.error.code,
        persistedAfterReload: true, upstreamRequests: 1, automaticRetry: false };
    });
    await check('same account cannot cross pet session, message, event or cancellation boundaries', async () => {
      const before = await observations();
      const base = '/api/v1/pets/' + otherPets[0].pet_id + '/sessions/' + firstAccepted.generation.session_id;
      const responses = [await api(mainPage, 'GET', base), await api(mainPage, 'GET', base + '/messages'),
        await api(mainPage, 'GET', base + '/generations/' + firstAccepted.generation.id + '/events'),
        await api(mainPage, 'POST', base + '/generations/' + firstAccepted.generation.id + '/cancel', {}),
        await api(mainPage, 'POST', base + '/messages', { content: 'P81 denied cross-pet request', client_message_id: crypto.randomUUID() }, crypto.randomUUID())];
      assert.ok(responses.every(response => response.status === 404));
      assert.equal((await observations()).requests, before.requests);
      return { foreignPetSession: 404, foreignPetMessages: 404, foreignPetEvents: 404, foreignPetCancel: 404, foreignPetSend: 404 };
    });
    await check('logout revokes Cookie access and removes all private native pet/chat windows', async () => {
      await mainPage.goto(uiOrigin + '/me');
      await mainPage.getByRole('button', { name: '退出登录', exact: true }).click();
      await mainPage.waitForURL(url => url.origin === uiOrigin && url.pathname === '/login');
      assert.equal((await api(mainPage, 'GET', '/api/v1/pets/' + moon.pet_id + '/runtime')).status, 401);
      assert.equal((await api(mainPage, 'GET', '/api/v1/pets/' + moon.pet_id + '/sessions/' + firstAccepted.generation.session_id + '/messages')).status, 401);
      await until(async () => (await inspect('snapshot')).records.length === 0, 'Logout retained native private resources.');
      return { privateRuntime: 401, privateMessages: 401, privateNativeWindows: 0 };
    });
    await check('second real account has Mock runtime and cannot access or mutate the first owner Moon', async () => {
      await login(accountB);
      const petB = accountB.pets[0], before = await observations();
      await runtime(mainPage, petB, 'mock');
      const base = '/api/v1/pets/' + moon.pet_id + '/sessions/' + firstAccepted.generation.session_id;
      const denied = [await api(mainPage, 'GET', '/api/v1/pets/' + moon.pet_id + '/runtime'),
        await api(mainPage, 'GET', '/api/v1/pets/' + moon.pet_id), await api(mainPage, 'GET', base),
        await api(mainPage, 'GET', base + '/messages'), await api(mainPage, 'GET', base + '/generations/' + firstAccepted.generation.id + '/events'),
        await api(mainPage, 'GET', '/api/v1/pets/' + moon.pet_id + '/memory/preferences'),
        await api(mainPage, 'POST', base + '/generations/' + firstAccepted.generation.id + '/cancel', {})];
      assert.ok(denied.every(response => response.status === 404));
      assert.equal(await mainPage.evaluate(async petId => {
        try { await window.weibiyeDesktop.openChat(petId); return false; } catch { return true; }
      }, moon.pet_id), true);
      await mainPage.goto(uiOrigin + '/pets/' + petB.pet_id);
      const pref = await api(mainPage, 'GET', '/api/v1/pets/' + petB.pet_id + '/memory/preferences');
      assert.equal(pref.status, 200); assert.equal(pref.data.long_term_memory_enabled, false);
      const sent = await sendUi(mainPage, petB, 'P81 second-account Mock isolation ' + crypto.randomUUID(), 'mock');
      await completed(mainPage, 'mock'); await mainPage.reload(); await completed(mainPage, 'mock');
      const history = await api(mainPage, 'GET', '/api/v1/pets/' + petB.pet_id + '/sessions/' + sent.accepted.generation.session_id + '/messages');
      assert.equal(history.status, 200); assert.ok(history.data.items.every(message => message.pet_id === petB.pet_id));
      assert.equal((await observations()).requests, before.requests);
      await capture(mainPage, 'actual-second-account-mock-chat', petB.pet_id);
      await mainPage.goto(uiOrigin + '/me');
      await mainPage.getByRole('button', { name: '退出登录', exact: true }).click();
      await mainPage.waitForURL(url => url.origin === uiOrigin && url.pathname === '/login');
      assert.equal((await api(mainPage, 'GET', '/api/v1/pets/' + petB.pet_id + '/sessions/' + sent.accepted.generation.session_id + '/messages')).status, 401);
      return { foreignResources: 404, foreignNativeChatDenied: true, ownProvider: 'mock', ownHistoryRestored: true,
        ownMemoryDefaultDisabled: true, extraDeepSeekRequests: 0, logoutHistory: 401 };
    });
    await check('actual tray Quit closes only this Electron instance and releases its P8.1 UI port', async () => {
      const closed = app.waitForEvent('close', { timeout: 20000 });
      await inspect('quit-tray'); await closed; exitedNormally = true;
      await until(async () => !(await portOpen(target.uiPort)), 'P8.1 gateway port was not released.');
      assert.equal((await fetch(target.backendOrigin + '/health/ready')).status, 200);
      return { exitedNormally: true, uiPortReleased: true, ownedBackendNotStoppedByDesktop: true };
    });
    assert.equal(result.checks.length, expectedChecks);
    result.status = 'P81_OFFLINE_ELECTRON_VERIFIED';
  } catch (cause) {
    result.status = 'FAILED'; result.error = safeError(cause); process.exitCode = 1;
  } finally {
    if (app && !exitedNormally) {
      try { await app.close(); }
      catch (cause) { result.cleanupError = safeError(cause); result.status = 'FAILED'; process.exitCode = 1; }
    }
    result.completedAt = new Date().toISOString();
    result.passed = result.checks.filter(check => check.status === 'passed').length;
    result.failed = result.checks.filter(check => check.status === 'failed').length;
    result.skipped = 0; result.notRun = expectedChecks - result.checks.length;
    result.transportCountsAfter = await observations();
    result.transportRequestsThisRun = result.transportCountsAfter.requests - (initialTransport?.requests ?? result.transportCountsAfter.requests);
    result.transportCloseEventsThisRun = result.transportCountsAfter.closed - (initialTransport?.closed ?? result.transportCountsAfter.closed);
    result.uiPortStillListening = await portOpen(target.uiPort);
    if (result.uiPortStillListening) { result.status = 'FAILED'; process.exitCode = 1; }
    await save();
    console.log(JSON.stringify({ status: result.status, passed: result.passed, failed: result.failed, skipped: result.skipped,
      notRun: result.notRun, simulatedModel: true, externalModelRequests: 0, actualExternalApiFee: 0,
      resultsFile, screenshots: result.screenshots.map(item => item.file), uiPortStillListening: result.uiPortStillListening }));
  }
}

main().catch(() => { console.error('P8.1 acceptance setup failed; preserve its evidence and inspect the isolated configuration.'); process.exitCode = 1; });
