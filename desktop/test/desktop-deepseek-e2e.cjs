'use strict';
// Real Windows Electron + isolated API/storage + real SDK over HTTPX MockTransport.
// Never inherits model credentials, moves the global mouse, or calls a real model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const root = path.resolve(__dirname, '../..');
const desktop = path.join(root, 'desktop');
const mainFile = path.join(desktop, 'src/main.cjs');
const run = path.join(root, '.verification/desktop-chat/electron-' + randomUUID());
const env = desktopEnvironment(process.env);
for (const key of Object.keys(env)) if (/^(?:VITE_|QQ_|LANGSMITH|LANGCHAIN)/i.test(key)) delete env[key];
const result = { status: 'RUNNING', run, platform: process.platform,
  realModelRequests: 0, transport: 'httpx-mock-only', sharedDatabaseAccess: false,
  checks: [], screenshots: [], pageErrors: [], externalRequests: [], pids: [] };
let app, page, backend, backendExit, log, target, ports;
const save = () => fs.writeFile(path.join(run, 'results.json'), JSON.stringify(result, null, 2));
async function until(fn, message, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(100); }
  throw Error(message);
}
async function check(name, fn) {
  try { const detail = await fn(); result.checks.push({ name, status: 'passed', detail }); console.log('PASS ' + name); }
  catch (error) { result.checks.push({ name, status: 'failed', error: error.message }); throw error; }
  finally { await save(); }
}
async function port() {
  const server = net.createServer();
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const value = server.address().port; await new Promise(ok => server.close(ok)); return value;
}
async function portOpen(value) {
  return new Promise(ok => {
    const socket = net.connect(value, '127.0.0.1');
    const done = value => { socket.destroy(); ok(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}
function watch(window) {
  window.on('pageerror', error => result.pageErrors.push(error.message));
  window.on('request', request => {
    if (/^https?:/.test(request.url()) && ![target.ui_origin, target.backend_origin].includes(new URL(request.url()).origin)) {
      result.externalRequests.push(new URL(request.url()).origin);
    }
  });
}
async function inspect(action, data) {
  return app.evaluate(async ({ app }, { file, action, data }) => {
    const require = process.getBuiltinModule('module').createRequire(file), manager = require(file).getRuntime();
    if (action === 'sync') return manager.syncSession();
    if (action === 'quiet') {
      manager.configureSociety?.({ enabled: false });
      return Promise.all([...manager.records.keys()].map(id => manager.configurePet(id, { random: false, autoMove: false })));
    }
    return { owner: manager.ownerId, pets: [...manager.records.values()].map(record => ({
      id: record.identity.pet_id, hidden: record.hidden, visible: record.window?.isVisible(),
      position: record.window?.getBounds(),
    })), processes: app.getAppMetrics().map(value => ({ pid: value.pid, type: value.type })) };
  }, { file: mainFile, action, data });
}
async function launch() {
  app = await _electron.launch({ args: [desktop, '--profile-dir', path.join(run, 'profile'),
    '--ui-port', String(ports.ui), '--backend-origin', target.backend_origin], env, timeout: 45000 });
  result.pids.push(app.process().pid);
  app.on('window', watch);
  page = await app.firstWindow(); watch(page);
  await page.getByLabel('邮箱', { exact: true }).waitFor({ state: 'visible', timeout: 45000 });
}
async function login(account) {
  await page.getByLabel('邮箱', { exact: true }).fill(account.email);
  await page.getByLabel('密码', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await until(async () => (await inspect()).owner === account.owner_id, 'Account identity sync');
  await page.goto(target.ui_origin + '/companions');
  await expect(page.getByRole('heading', { name: '我的宠物', exact: true })).toBeVisible();
  await inspect('sync');
  await page.evaluate(owner => window.weibiyeDesktop.socialSettings(owner, { enabled: false }), account.owner_id);
}
async function quit() {
  if (!app) return;
  const child = app.process(); await app.evaluate(({ app }) => app.quit());
  await until(() => child.exitCode !== null, 'Owned Electron did not exit normally');
  assert.equal(child.exitCode, 0); app = null;
}
const card = id => page.locator(`.p863-choice[data-instance-id="${id}"]`);
async function summon(id) {
  await card(id).click();
  await until(async () => (await inspect()).pets.some(pet => pet.id === id && pet.visible && !pet.hidden), 'Selected instance not shown');
  await inspect('quiet');
}
async function chatFor(id) {
  await page.evaluate(id => window.weibiyeDesktop.openChat(id), id);
  await until(() => app.windows().some(window => window.url() === target.ui_origin + '/pets/' + id), 'Instance chat window missing');
  const window = app.windows().find(window => window.url() === target.ui_origin + '/pets/' + id);
  await expect(window.getByLabel('聊天消息', { exact: true })).toBeVisible(); return window;
}
async function api(window, method, route, body) {
  return window.evaluate(async ({ method, route, body }) => {
    const headers = {};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = crypto.randomUUID();
      headers['X-CSRF-Token'] = (await (await fetch('/api/v1/auth/csrf')).json()).csrf_token;
    }
    const response = await fetch('/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }, { method, route, body });
}
async function send(window, content) {
  await window.getByLabel('聊天消息', { exact: true }).fill(content);
  const sent = window.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  const accepted = await sent; assert.equal(accepted.status(), 202); return accepted.json();
}
async function terminal(window, id, accepted) {
  const route = `/pets/${id}/sessions/${accepted.generation.session_id}/generations/${accepted.generation.id}`;
  let value;
  await until(async () => {
    value = await api(window, 'GET', route);
    assert.equal(value.status, 200, 'Acceptance reads must stay within the unchanged owner rate limit');
    if (['completed', 'failed', 'cancelled'].includes(value.data.generation.state)) return true;
    await delay(1000); return false;
  }, 'Generation did not reach terminal state');
  return value.data;
}
async function shot(name, window = page) {
  const file = path.join(run, name); await window.screenshot({ path: file });
  result.screenshots.push({ file, source: 'Actual Windows Electron renderer; offline SDK transport', composite: false });
}
async function metrics() { return (await fetch(target.backend_origin + '/__desktop_chat_fixture/ready')).json(); }
async function main() {
  assert.equal(process.platform, 'win32'); await fs.mkdir(run, { recursive: true }); await save();
  ports = { backend: await port(), ui: await port() }; result.ports = ports;
  log = await fs.open(path.join(run, 'backend.log'), 'wx');
  backend = spawn(path.join(root, 'backend/.venv/Scripts/python.exe'), ['-B',
    path.join(__dirname, 'fixtures/desktop_deepseek_server.py'), '--output', run,
    '--port', String(ports.backend), '--ui-port', String(ports.ui)], {
    cwd: path.join(root, 'backend'), env, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  });
  result.pids.push(backend.pid); backendExit = new Promise(ok => backend.once('exit', (code, signal) => ok({ code, signal })));
  await until(async () => {
    if (backend.exitCode !== null) throw Error('Owned offline API stopped; inspect its saved log');
    try { return (await fetch(`http://127.0.0.1:${ports.backend}/__desktop_chat_fixture/ready`)).ok; } catch { return false; }
  }, 'Offline SDK fixture ready', 60000);
  target = JSON.parse(await fs.readFile(path.join(run, 'target.json'), 'utf8'));
  assert.equal(target.fixture, 'desktop-deepseek-sdk-offline/1'); await launch();
  await check('actual login restores eight species plus a distinct same-species instance', async () => {
    await login(target.accounts[0]); assert.equal(await page.locator('.p863-choice').count(), 9);
    assert.equal((await inspect()).pets.length, 0); assert.equal((await metrics()).mock_upstream_attempts, 0);
    await shot('01-pet-selection.png'); return { instances: 9, initialVisible: 0 };
  });
  await check('seventh and eighth pets summon directly from zero without list reordering', async () => {
    const pets = target.accounts[0].pets; await summon(pets[6].pet_id); await summon(pets[7].pet_id);
    assert.deepEqual((await inspect()).pets.map(value => value.id).sort(), [pets[6].pet_id, pets[7].pet_id].sort());
    await page.getByRole('button', { name: '一键收回全部', exact: true }).click();
    await until(async () => !(await inspect()).pets.length, 'Recall all');
  });
  const [firstId, secondId] = target.selected_pet_ids;
  let first, second;
  await check('same-name pets open separate chats with backend-confirmed DeepSeek disclosure', async () => {
    await summon(firstId); await summon(secondId); first = await chatFor(firstId); second = await chatFor(secondId);
    for (const window of [first, second]) await expect(window.locator('#composer-disclosure')).toContainText('DeepSeek');
    await expect(first.locator('#composer-disclosure')).toContainText('本次不额外注入长期记忆');
    assert.notEqual(first.url(), second.url()); await shot('02-offline-SDK-chat.png', first);
  });
  await check('SSE shows SDK chunks and completes with persisted input/output usage', async () => {
    let stream = false; first.on('response', response => { if (response.headers()['content-type']?.includes('text/event-stream')) stream = true; });
    const accepted = await send(first, 'FIRST_INSTANCE_PRIVATE_5b1');
    const completed = await terminal(first, firstId, accepted);
    assert.equal(completed.generation.state, 'completed'); assert.equal(accepted.generation.provider, 'deepseek');
    await expect(first.locator('.message-assistant p').last()).toContainText('非真实模型');
    assert.equal(stream, true); assert.equal((await metrics()).mock_upstream_attempts, 1);
    await shot('03-SSE-completed.png', first);
  });
  await check('second instance and refresh keep private histories isolated without extra dispatch', async () => {
    const accepted = await send(second, 'SECOND_INSTANCE_PRIVATE_71c');
    assert.equal((await terminal(second, secondId, accepted)).generation.state, 'completed');
    await expect(second.locator('.chat-transcript')).not.toContainText('FIRST_INSTANCE_PRIVATE_5b1');
    await first.reload(); await expect(first.getByText('FIRST_INSTANCE_PRIVATE_5b1', { exact: true })).toBeVisible();
    await expect(first.locator('.chat-transcript')).not.toContainText('SECOND_INSTANCE_PRIVATE_71c');
    assert.equal((await metrics()).mock_upstream_attempts, 2); await shot('04-instance-isolation.png', second);
  });
  await check('deterministic in-flight stop closes the fake upstream and reaches cancelled', async () => {
    const previous = await first.locator('.message-assistant').count();
    const accepted = await send(first, 'OFFLINE_HOLD controlled cancellation');
    await expect(first.locator('.message-assistant')).toHaveCount(previous + 1);
    await expect(first.locator('.message-assistant').last().locator('p')).toContainText('离线协议测试');
    await first.getByRole('button', { name: '停止生成', exact: true }).click();
    assert.equal((await terminal(first, firstId, accepted)).generation.state, 'cancelled');
    assert.equal((await metrics()).mock_upstream_attempts, 3); await shot('05-cancelled.png', first);
  });
  await check('upstream failure is not retried and the shared run budget blocks another dispatch', async () => {
    await fs.writeFile(path.join(run, 'upstream-status'), '429');
    const failed = await send(second, 'controlled synthetic failure');
    assert.equal((await terminal(second, secondId, failed)).generation.state, 'failed');
    assert.equal((await metrics()).mock_upstream_attempts, 4);
    await expect(second.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
    const denied = await send(second, 'the fifth request must stay local');
    const stopped = await terminal(second, secondId, denied);
    assert.equal(stopped.generation.error.code, 'LOCAL_MODEL_BUDGET_EXHAUSTED');
    await expect(second.getByText('本次本地体验的模型请求额度已用完，请联系运行者确认。', { exact: true })).toBeVisible();
    assert.equal((await metrics()).mock_upstream_attempts, 4); await shot('06-budget-stop.png', second);
  });
  const savedPositions = (await inspect()).pets.map(pet => ({ id: pet.id, position: pet.position }));
  await check('foreign-account pet access is denied and unselected pets remain Mock', async () => {
    const foreign = target.accounts[1].pets[4].pet_id;
    assert.equal((await api(first, 'GET', `/pets/${foreign}/runtime`)).status, 404);
    const other = target.accounts[0].pets[0].pet_id;
    assert.equal((await api(first, 'GET', `/pets/${other}/runtime`)).data.provider, 'mock');
  });
  await check('normal application restart restores selected instance positions without new model requests', async () => {
    await quit();
    // The accelerated scenario issues many legitimate UI reads. Respect the
    // existing UTC-minute quota; never clear its keys or increase its limit.
    const waitMs = 60000 - Date.now() % 60000 + 750;
    result.restartReadQuotaWaitMs = waitMs;
    console.log('Waiting for the existing read-quota window before restart');
    await delay(waitMs);
    await launch(); await login(target.accounts[0]);
    await until(async () => (await inspect()).pets.length === 2, 'Selected instances restore');
    const restored = (await inspect()).pets.map(pet => ({ id: pet.id, position: pet.position }));
    assert.deepEqual(restored, savedPositions);
    assert.equal((await metrics()).mock_upstream_attempts, 4); await shot('07-restarted.png');
  });
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.externalRequests, []);
  result.status = 'DESKTOP_DEEPSEEK_OFFLINE_WINDOWS_VERIFIED';
}
main().catch(error => { result.status = 'FAILED'; result.error = error.message; process.exitCode = 1; })
  .finally(async () => {
    try {
      await quit(); result.electronClosed = true;
      if (backend) {
        await fs.writeFile(path.join(run, 'stop-requested'), 'owned fixture stop');
        const closed = await Promise.race([backendExit, delay(20000).then(() => null)]);
        assert.ok(closed, 'Owned backend did not stop; no force termination attempted');
        assert.equal(closed.code, 0); result.backendClosed = true;
      }
      if (ports) { result.portsReleased = !(await portOpen(ports.backend)) && !(await portOpen(ports.ui)); assert.equal(result.portsReleased, true); }
      if (target) result.transportSummary = JSON.parse(await fs.readFile(path.join(run, 'transport-summary.json'), 'utf8'));
    } catch (error) { result.cleanupError = error.message; result.status = 'CLEANUP_BLOCKED'; process.exitCode = 1; }
    if (log) await log.close(); await save(); console.log(JSON.stringify({ status: result.status, passed: result.checks.filter(c => c.status === 'passed').length, run }));
  });
