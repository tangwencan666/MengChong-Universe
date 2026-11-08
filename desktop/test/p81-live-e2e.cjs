'use strict';

// Never run automatically: approval must match the full (2) or cancel-only (1)
// synthetic-request budget, which the backend enforces process-wide.
// No model key is read by this process or passed to Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 15000 });
const { desktopEnvironment } = require('../src/launch-env.cjs');
const watchCancellation = require('./p81-cancel-watch.cjs');

const desktopDir = path.resolve(__dirname, '..');
const repository = path.dirname(desktopDir);
const evidenceRoot = path.join(repository, '.verification', 'p81');
const mainFile = path.join(desktopDir, 'src', 'main.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const input = process.argv.slice(2);
const cancelOnly = input.includes('--cancel-only');
const requestBudget = cancelOnly ? 1 : 2;
let stopping = false;
if (input.filter(value => value === '--confirm-paid-requests=' + requestBudget).length !== 1) {
  console.log(JSON.stringify({ status: 'P81_LIVE_NOT_CONFIRMED', modelRequestBudget: 0, modelRequestsByThisProcess: 0 }));
  process.exitCode = 2;
} else {
  main().catch(() => {
    console.error('P8.1 live acceptance setup failed; do not repeat or expose credentials. Preserve the budget evidence.');
    process.exitCode = 1;
  });
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}
async function until(operation, message, timeout = 45000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    if (stopping) throw new Error('The owned P81 live test is stopping.');
    try { const value = await operation(); if (value) return value; } catch (cause) { last = cause; }
    await delay(1000);
  }
  throw new Error(message + (last ? ': ' + last.message : ''));
}
function frames(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n\n')
    .filter(value => value.split('\n').some(line => line.startsWith('data: ')))
    .map(value => {
      const lines = value.split('\n');
      return { id: lines.find(line => line.startsWith('id: '))?.slice(4),
        event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')) };
    });
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(input.every(value => value === '--confirm-paid-requests=' + requestBudget
    || value === '--cancel-only' || value.startsWith('--target=')), 'Unexpected live options.');
  const targetArgs = input.filter(value => value.startsWith('--target='));
  assert.equal(targetArgs.length, 1);
  const targetFile = targetArgs[0].slice('--target='.length);
  assert.ok(path.isAbsolute(targetFile));
  const directory = path.dirname(path.resolve(targetFile));
  assert.equal(path.basename(targetFile), 'target.json');
  assert.equal(path.dirname(directory).toLowerCase(), evidenceRoot.toLowerCase());
  assert.match(path.basename(directory), /^live-[a-f0-9-]{32,36}$/);
  const target = JSON.parse(await fs.readFile(targetFile, 'utf8'));
  const baseline = JSON.parse(await fs.readFile(path.join(repository, '.verification/p6/target.json'), 'utf8'));
  assert.equal(target.modelTransport, 'live-budgeted-' + requestBudget);
  assert.equal(target.acceptanceMode ?? 'full', cancelOnly ? 'cancel-only' : 'full');
  assert.equal(target.maxModelRequests, requestBudget); assert.equal(target.maxOutputTokens, 64);
  assert.equal(target.databaseName, 'weibiye_p6_desktop_test_' + baseline.runId);
  assert.equal(target.cluster, '7703042374370492450'); assert.equal(target.schemaVersion, '0006');
  assert.equal(target.backendOrigin, 'http://127.0.0.1:38329'); assert.equal(target.uiPort, 35329);
  assert.match(target.p81RunId, /^[a-f0-9]{32}$/);
  assert.equal(target.redisPrefix, 'weibiye:p81:live:' + target.p81RunId + ':');
  assert.ok(hash(JSON.stringify(target.accounts)) === hash(JSON.stringify(baseline.accounts)), 'Synthetic identities mismatch.');
  const a = target.accounts.a, b = target.accounts.b;
  assert.equal(target.moonOwnerId, a.user_id); assert.notEqual(a.user_id, b.user_id);
  const moon = a.pets.find(pet => pet.pet_id === target.moonPetId);
  assert.ok(moon && moon.name === '月芽');
  const others = a.pets.filter(pet => pet.pet_id !== moon.pet_id); assert.equal(others.length, 2);
  const origin = 'http://127.0.0.1:' + target.uiPort;
  const runDirectory = path.join(directory, 'electron-' + crypto.randomUUID());
  await fs.mkdir(runDirectory, { recursive: false });
  const resultsFile = path.join(runDirectory, 'results.json');
  const result = { status: 'RUNNING', startedAt: new Date().toISOString(), simulatedModel: false,
    model: 'deepseek-flash', maxModelRequests: requestBudget, maxOutputTokens: 64, actualCostUsd: null,
    acceptanceMode: cancelOnly ? 'cancel-only' : 'full',
    database: target.databaseName, checks: [], screenshots: [], cancellationResult: null,
    notVerified: ['No paid upstream authentication, quota or error injection is attempted; those paths are tested offline.',
      'Cancellation can lose to real model completion. Only a persisted cancelled state counts as actual cancellation.',
      'Screenshots capture actual Electron webContents, not Windows desktop composition or physical pointer input.'] };
  const secrets = [a.email, a.password, b.email, b.password];
  const safeError = cause => {
    let value = String(cause.stack || cause);
    for (const secret of secrets) if (typeof secret === 'string' && secret.length > 5) value = value.split(secret).join('[redacted]');
    return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  };
  const save = () => fs.writeFile(resultsFile, JSON.stringify(result, null, 2) + '\n');
  let app, page, chat, first, firstIntent, exited = false, stopWatcher;
  async function check(name, operation) {
    try { const detail = await operation(); result.checks.push({ name,
      status: detail?.verification === 'not_verified' ? 'not_verified' : 'passed',
      ...(detail === undefined ? {} : { detail }) }); }
    catch (cause) { result.checks.push({ name, status: 'failed', error: safeError(cause) }); throw cause; }
    finally { await save(); }
  }
  async function requests() {
    try {
      const rows = (await fs.readFile(path.join(directory, 'transport-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      const calls = rows.filter(row => row.event === 'request');
      assert.ok(calls.length <= requestBudget, 'Backend request budget was exceeded.');
      return calls.length;
    } catch (cause) { if (cause.code === 'ENOENT') return 0; throw cause; }
  }
  async function api(view, method, route, body, key, headers = {}, csrf = true) {
    return view.evaluate(async input => {
      const headers = { ...input.headers };
      if (!['GET', 'HEAD'].includes(input.method) && input.csrf) {
        const response = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
        if (!response.ok) throw new Error('Authenticated CSRF fetch failed.');
        headers['X-CSRF-Token'] = (await response.json()).csrf_token;
      }
      if (input.key) headers['Idempotency-Key'] = input.key;
      if (input.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(input.route, { credentials: 'include', method: input.method, headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: AbortSignal.timeout(60000) });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data };
    }, { method, route, body, key, headers, csrf });
  }
  async function login(account) {
    await page.goto(origin + '/login');
    await page.getByLabel('邮箱', { exact: true }).fill(account.email); await page.getByLabel('密码', { exact: true }).fill(account.password);
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/api/v1/auth/login'));
    await page.getByRole('button', { name: '登录', exact: true }).click(); assert.equal((await response).status(), 200);
    await page.waitForURL(url => url.origin === origin && url.pathname !== '/login');
    const me = await api(page, 'GET', '/api/v1/auth/me'); assert.equal(me.status, 200); assert.equal(me.data.id, account.user_id);
  }
  async function model(view, pet, provider) {
    const response = await api(view, 'GET', '/api/v1/pets/' + pet.pet_id + '/runtime');
    assert.equal(response.status, 200); assert.equal(response.data.provider, provider);
    assert.equal(response.data.model, provider === 'mock' ? null : 'deepseek-flash');
    assert.equal(response.data.mode, provider === 'mock' ? 'mock' : 'real');
    if (provider !== 'mock') assert.equal(response.data.memory_injection_enabled, false);
    return response.data;
  }
  async function send(view, pet, text, provider) {
    await model(view, pet, provider);
    await expect(view.locator('#composer-disclosure')).toContainText(provider === 'mock' ? '本地 Mock' : '可能产生 API 费用');
    await view.getByLabel('聊天消息', { exact: true }).fill(text);
    const response = view.waitForResponse(value => value.request().method() === 'POST'
      && value.url().includes('/api/v1/pets/' + pet.pet_id + '/sessions/') && value.url().endsWith('/messages'));
    await view.getByRole('button', { name: '发送消息', exact: true }).click();
    const accepted = await response; assert.equal(accepted.status(), 202); const data = await accepted.json();
    assert.equal(data.generation.provider, provider); assert.equal(data.generation.pet_id, pet.pet_id);
    return { accepted: data, body: accepted.request().postDataJSON(), key: accepted.request().headers()['idempotency-key'] };
  }
  const generationPath = accepted => '/api/v1/pets/' + moon.pet_id + '/sessions/' + accepted.generation.session_id + '/generations/' + accepted.generation.id;
  async function snapshot(view, accepted) {
    const response = await api(view, 'GET', generationPath(accepted)); assert.equal(response.status, 200); return response.data;
  }
  async function capture(view, label) {
    const expectedURL = view.url(); assert.ok(expectedURL.startsWith(origin + '/'));
    const win = await app.browserWindow(view);
    const image = await win.evaluate(async (window, url) => {
      if (window.isDestroyed() || window.webContents.getURL() !== url) throw new Error('Capture target changed.');
      const image = await window.webContents.capturePage(); if (image.isEmpty()) throw new Error('Actual capture is empty.');
      return { windowId: window.id, webContentsId: window.webContents.id, size: image.getSize(), png: image.toPNG().toString('base64') };
    }, expectedURL);
    const file = path.join(runDirectory, label + '.png'), bytes = Buffer.from(image.png, 'base64');
    await fs.writeFile(file, bytes, { flag: 'wx' }); delete image.png;
    result.screenshots.push({ ...image, file, sha256: hash(bytes), captureType: 'Actual Electron webContents' });
  }

  try {
    await check('explicit budgeted live manifest, unused port and zero existing upstream attempts', async () => {
      assert.equal(await portOpen(target.uiPort), false); assert.equal(await requests(), 0);
      assert.equal((await fetch(target.backendOrigin + '/health/ready')).status, 200);
      return { approvedRequestBudget: requestBudget, outputTokenCapPerRequest: 64 };
    });
    await check('real Electron uses backend-only credentials, Cookie/CSRF and Moon-only provider', async () => {
      app = await _electron.launch({ executablePath: path.join(desktopDir, 'node_modules/electron/dist/electron.exe'),
        args: [desktopDir, '--ui-port=' + target.uiPort, '--backend-origin=' + target.backendOrigin,
          '--profile-dir=' + path.join(runDirectory, 'profile'), '--local-character-preview=deepseek',
          '--preview-owner-id=' + a.user_id, '--preview-pet-id=' + moon.pet_id], env: desktopEnvironment(process.env), timeout: 30000 });
      stopWatcher = setInterval(() => {
        if (stopping) return;
        void fs.access(path.join(directory, 'stop-requested')).then(() => {
          if (stopping) return;
          stopping = true;
          void app.close().catch(() => {});
        }).catch(() => {});
      }, 250);
      stopWatcher.unref();
      page = await app.firstWindow(); page.setDefaultTimeout(20000); await page.waitForLoadState('load');
      await expect.poll(() => page.evaluate(() => typeof window.weibiyeDesktop)).toBe('object');
      assert.equal((await api(page, 'GET', '/api/v1/pets/' + moon.pet_id + '/runtime')).status, 401);
      assert.deepEqual(await app.evaluate(() => Object.keys(process.env).filter(name => /^(?:WEIBIYE_|OPENAI_|DEEPSEEK_)/i.test(name))), []);
      await login(a); await model(page, moon, 'deepseek');
      for (const pet of others) await model(page, pet, 'mock');
      const denied = await api(page, 'POST', '/api/v1/pets/' + moon.pet_id + '/sessions', { title: 'P81 live CSRF rejection' }, crypto.randomUUID(), {}, false);
      assert.equal(denied.status, 403); assert.equal(await page.evaluate(() => document.cookie.includes('weibiye_session')), false);
      assert.equal(await requests(), 0);
      return { csrf: 403, httpOnlySessionNotReadable: true, otherPets: 'mock', modelEnvironmentForwarded: false };
    });
    await check('existing Moon pet renderer opens its scoped real-provider chat', async () => {
      await page.goto(origin + '/companions');
      const card = page.locator('.pet-card').filter({ has: page.getByRole('heading', { name: moon.name, exact: true }) });
      await card.getByRole('button', { name: '放到桌面', exact: true }).click();
      const petPage = await until(async () => {
        for (const view of app.windows()) if (view.url().endsWith('/__pet/pet.html')
          && await view.evaluate(id => document.body.dataset.petId === id && !document.getElementById('pet-hitbox').disabled, moon.pet_id)) return view;
        return null;
      }, 'Owned Moon renderer was not created.');
      await petPage.getByRole('button', { name: '和' + moon.name + '聊天', exact: true }).click();
      chat = await until(async () => app.windows().find(view => view !== page && view.url().startsWith(origin + '/pets/' + moon.pet_id)), 'Moon chat was not opened.');
      await chat.waitForLoadState('load'); await expect(chat.locator('#composer-disclosure')).toContainText('DeepSeek · deepseek-flash');
      assert.equal(await requests(), 0); return { openedFromActualPetRenderer: true, physicalMouseUsed: false };
    });
    if (!cancelOnly) {
      await check('paid request 1 completes through actual SSE, persists and survives reload', async () => {
        firstIntent = await send(chat, moon, 'Say hello in one short sentence.', 'deepseek'); first = firstIntent.accepted;
        const done = await until(async () => {
          const value = await snapshot(chat, first);
          if (value.generation.state === 'failed') throw new Error('The real provider request failed; no automatic retry is permitted.');
          return value.generation.state === 'completed' ? value : null;
        }, 'Real request 1 did not complete.');
        assert.ok(done.assistant_message.content.trim().length > 0);
        const events = await api(chat, 'GET', generationPath(first) + '/events'); assert.equal(events.status, 200);
        const journal = frames(events.data); assert.ok(journal.some(event => event.event === 'delta'));
        assert.equal(journal.at(-1).event, 'completed'); assert.equal(journal.at(-1).data.content, done.assistant_message.content);
        await expect(chat.getByRole('log')).toContainText(done.assistant_message.content);
        await chat.reload(); await expect(chat.getByRole('log')).toContainText(done.assistant_message.content);
        assert.equal(await requests(), 1); await capture(chat, 'actual-moon-real-deepseek-chat');
        return { generationId: first.generation.id, sessionId: first.generation.session_id,
          contentLength: done.assistant_message.content.length, finishReason: done.generation.finish_reason,
          usage: journal.at(-1).data.usage ?? null, sseDeltaObserved: true, historyRestored: true };
      });
      await check('same-key POST and Last-Event-ID journal replay do not spend another request', async () => {
        const replay = await api(chat, 'POST', '/api/v1/pets/' + moon.pet_id + '/sessions/' + first.generation.session_id + '/messages', firstIntent.body, firstIntent.key);
        assert.equal(replay.status, 202); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.generation.id, first.generation.id);
        const initial = await api(chat, 'GET', generationPath(first) + '/events'); const journal = frames(initial.data);
        const cursor = journal.find(event => event.event === 'delta').id;
        const resumed = await api(chat, 'GET', generationPath(first) + '/events', undefined, undefined, { 'Last-Event-ID': cursor });
        assert.equal(resumed.status, 200); const suffix = frames(resumed.data);
        assert.equal(suffix.at(-1).event, 'completed'); assert.ok(suffix.every(event => Number(event.id.split(':').at(-1)) > Number(cursor.split(':').at(-1))));
        assert.equal(new Set(suffix.map(event => event.id)).size, suffix.length); assert.equal(await requests(), 1);
        firstIntent = undefined; return { sameGeneration: true, replayWithoutNewModelRequest: true, admittedRequests: 1 };
      });
    }
    await check('SSE delta and visible DOM trigger cancellation and verify its authoritative terminal state', async () => {
      const sessions = await api(page, 'GET', '/api/v1/pets/' + moon.pet_id + '/sessions');
      assert.equal(sessions.status, 200);
      const otherSession = first?.generation.session_id ?? sessions.data.items[0]?.id;
      const otherRoute = otherSession ? '/api/v1/pets/' + moon.pet_id + '/sessions/' + otherSession + '/messages' : null;
      const otherBefore = otherRoute ? await api(page, 'GET', otherRoute) : null;
      if (otherBefore) assert.equal(otherBefore.status, 200);
      await chat.goto(origin + '/pets/' + moon.pet_id);
      const sent = await send(chat, moon, 'Count from one to twenty, one number per line.', 'deepseek');
      if (otherSession) assert.notEqual(sent.accepted.generation.session_id, otherSession);
      let resolveAck;
      const acknowledgement = new Promise(resolve => { resolveAck = resolve; });
      let cancelCalls = 0;
      const cancelURL = generationPath(sent.accepted) + '/cancel';
      const onResponse = response => {
        if (response.request().method() === 'POST' && new URL(response.url()).pathname === cancelURL) {
          cancelCalls += 1; resolveAck(response.status());
        }
      };
      chat.on('response', onResponse);
      let observed, cancelHttpStatus = null;
      try {
        observed = await chat.evaluate(watchCancellation, { petId: moon.pet_id,
          sessionId: sent.accepted.generation.session_id, generationId: sent.accepted.generation.id,
          messageId: sent.accepted.assistant_message.id, timeoutMs: 45000 });
        if (observed.stopClicked) {
          cancelHttpStatus = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Cancellation HTTP acknowledgement missing.')), 5000);
            acknowledgement.then(value => { clearTimeout(timer); resolve(value); });
          });
          assert.ok([200, 202].includes(cancelHttpStatus)); assert.equal(cancelCalls, 1);
        }
      } finally { chat.off('response', onResponse); }
      const current = await snapshot(chat, sent.accepted);
      assert.equal(current.generation.state, observed.state);
      assert.equal(current.assistant_message.status, observed.state);
      assert.equal(current.assistant_message.content, observed.content);
      if (observed.state === 'cancelled') assert.equal(observed.stopClicked, true);
      const journalResponse = await api(chat, 'GET', generationPath(sent.accepted) + '/events');
      assert.equal(journalResponse.status, 200);
      const journal = frames(journalResponse.data);
      assert.equal(journal.filter(event => ['completed', 'cancelled', 'error'].includes(event.event)).length, 1);
      assert.equal(journal.at(-1).event, observed.state);
      assert.equal(new Set(journal.map(event => event.id)).size, journal.length);
      const resumed = await api(chat, 'GET', generationPath(sent.accepted) + '/events', undefined, undefined,
        { 'Last-Event-ID': journal.at(-1).id });
      assert.equal(resumed.status, 200); assert.equal(resumed.data, '');
      const stable = await snapshot(chat, sent.accepted);
      assert.deepEqual(stable, current);
      if (otherRoute) {
        const otherAfter = await api(page, 'GET', otherRoute);
        assert.equal(otherAfter.status, 200); assert.deepEqual(otherAfter.data.items, otherBefore.data.items);
      }
      await expect(chat.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
      await chat.reload(); await expect(chat.getByRole('log')).toContainText(current.assistant_message.content);
      if (observed.state === 'cancelled') await expect(chat.getByRole('log')).toContainText('已停止生成');
      assert.equal(await requests(), requestBudget);
      result.cancellationResult = { stopClicked: observed.stopClicked, state: observed.state,
        actualCancellationVerified: observed.state === 'cancelled', completionWonRace: observed.state === 'completed',
        mechanism: observed.mechanism, firstDeltaReceivedAt: observed.firstDeltaReceivedAt,
        stopClickedAt: observed.stopClickedAt, terminalReceivedAt: observed.terminalReceivedAt,
        firstDeltaSequence: observed.firstDeltaSequence, terminalSequence: observed.terminalSequence,
        cancelHttpStatus, terminalEventCount: 1, noPostTerminalEvents: true, messageStableAfterTerminal: true,
        stopButtonHidden: true, otherSessionComparison: otherRoute ? 'unchanged' : 'not_available' };
      if (cancelOnly) first = sent.accepted;
      if (observed.state === 'completed') result.notVerified.push('Actual in-flight cancellation was not verified; completion won.');
      await capture(chat, 'actual-moon-real-cancel-or-completion-race');
      return { generationId: sent.accepted.generation.id, contentLength: current.assistant_message.content.length,
        verification: observed.state === 'cancelled' ? 'verified' : 'not_verified', ...result.cancellationResult };
    });
    await check('other pets and second account remain Mock and cannot access Moon resources', async () => {
      for (const pet of others) {
        await page.goto(origin + '/pets/' + pet.pet_id);
        await send(page, pet, 'P81 live-stage Mock-only isolation.', 'mock');
        await expect(page.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。');
      }
      assert.equal(await requests(), requestBudget);
      await page.goto(origin + '/me'); await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.waitForURL(url => url.origin === origin && url.pathname === '/login');
      const base = '/api/v1/pets/' + moon.pet_id + '/sessions/' + first.generation.session_id;
      assert.equal((await api(page, 'GET', base + '/messages')).status, 401);
      await login(b); await model(page, b.pets[0], 'mock');
      for (const route of ['/api/v1/pets/' + moon.pet_id + '/runtime', base, base + '/messages', generationPath(first) + '/events']) {
        assert.equal((await api(page, 'GET', route)).status, 404);
      }
      assert.equal((await api(page, 'POST', generationPath(first) + '/cancel', {})).status, 404);
      assert.equal(await requests(), requestBudget);
      await page.goto(origin + '/me'); await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.waitForURL(url => url.origin === origin && url.pathname === '/login');
      return { otherPetsRemainMock: true, afterLogout: 401, crossOwner: 404, admittedRequests: requestBudget };
    });
    await check('actual tray Quit releases this Electron gateway without touching the backend', async () => {
      const closed = app.waitForEvent('close', { timeout: 20000 });
      await app.evaluate(async (_electron, file) => {
        const nodeRequire = process.getBuiltinModule('module').createRequire(file), runtime = nodeRequire(file).getRuntime();
        const manager = runtime.manager || runtime, item = manager.trayMenu.getMenuItemById('quit');
        if (!item?.enabled) throw new Error('Actual Quit unavailable.'); setImmediate(() => item.click(item, manager.mainWindow, {}));
      }, mainFile);
      await closed; exited = true; assert.equal(await portOpen(target.uiPort), false);
      return { exitedNormally: true, uiPortReleased: true };
    });
    result.status = result.cancellationResult.actualCancellationVerified ? 'P81_LIVE_ELECTRON_VERIFIED' : 'P81_LIVE_COMPLETED_WITH_CANCEL_RACE';
  } catch (cause) { result.status = 'FAILED'; result.error = safeError(cause); process.exitCode = 1; }
  finally {
    clearInterval(stopWatcher);
    if (app && !exited) { try { await app.close(); } catch (cause) { result.cleanupError = safeError(cause); result.status = 'FAILED'; process.exitCode = 1; } }
    result.completedAt = new Date().toISOString(); result.passed = result.checks.filter(value => value.status === 'passed').length;
    result.failed = result.checks.filter(value => value.status === 'failed').length; result.skipped = 0;
    result.unverified = result.checks.filter(value => value.status === 'not_verified').length;
    result.admittedModelRequests = await requests(); result.uiPortStillListening = await portOpen(target.uiPort);
    if (result.uiPortStillListening) { result.status = 'FAILED'; process.exitCode = 1; }
    await save(); console.log(JSON.stringify({ status: result.status, passed: result.passed, failed: result.failed,
      admittedModelRequests: result.admittedModelRequests, actualCostUsd: null, cancellationResult: result.cancellationResult,
      resultsFile, uiPortStillListening: result.uiPortStillListening }));
  }
}
