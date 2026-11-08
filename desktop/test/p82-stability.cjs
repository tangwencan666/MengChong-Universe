'use strict';

// Actual Electron/FastAPI/SQLite, local Mock only. No shared DB or model keys.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const desktop = path.resolve(__dirname, '..'), root = path.dirname(desktop);
const runtimeRoot = path.resolve(process.argv.find(v => v.startsWith('--runtime-root='))?.slice(15) ?? desktop);
const mainFile = path.join(runtimeRoot, 'src/main.cjs');
const benchmark = process.argv.includes('--benchmark');
const minutes = Number(process.argv.find(v => v.startsWith('--minutes='))?.slice(10) ?? 30);
assert.ok(benchmark || Number.isInteger(minutes) && minutes >= 30 && minutes <= 60, 'Soak must run 30–60 actual minutes');
const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) ?? 'optimized';
assert.match(label, /^[a-z0-9-]{1,40}$/);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
  });
}
async function until(test, message, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await test()) return; await delay(200); }
  throw new Error(message);
}
async function sourceHashes() {
  const files = ['package.json', 'ui-dist/UI_ASSETS.json'];
  for (const folder of ['src', 'renderer']) {
    for (const name of await fs.readdir(path.join(runtimeRoot, folder))) {
      if (/\.(?:cjs|js|css|html)$/.test(name)) files.push(folder + '/' + name);
    }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file,
    createHash('sha256').update(await fs.readFile(path.join(runtimeRoot, file))).digest('hex')])));
}

async function main() {
  assert.equal(process.platform, 'win32');
  const run = path.join(root, '.verification/p82-phase2', label + '-' + randomUUID());
  await fs.mkdir(run, { recursive: true });
  const uiPort = await freePort(), backendPort = await freePort();
  const env = desktopEnvironment(process.env);
  const log = await fs.open(path.join(run, 'backend.log'), 'wx');
  const backend = spawn(path.join(root, 'backend/.venv/Scripts/python.exe'), ['-B', path.join(__dirname, 'fixtures/p82_server.py'),
    '--output', run, '--port', String(backendPort), '--ui-port', String(uiPort)],
  { cwd: path.join(root, 'backend'), env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  const exit = new Promise(resolve => backend.once('exit', (code, signal) => resolve({ code, signal })));
  const result = { status: 'RUNNING', label, benchmark, requestedMinutes: benchmark ? 0 : minutes,
    startedAt: new Date().toISOString(), realModelRequests: 0, sharedDatabaseAccess: false,
    inactiveWindowInstrumentation: true, phases: {}, cycles: [], pids: [], anomalies: [] };
  result.sourceHashes = await sourceHashes();
  let app, target, moon, other;
  const save = () => fs.writeFile(path.join(run, 'results.json'), JSON.stringify(result, null, 2));
  const inspect = (action, data) => app.evaluate(async ({ app: host, BrowserWindow }, input) => {
    const require = process.getBuiltinModule('module').createRequire(input.mainFile);
    const manager = require(input.mainFile).getRuntime();
    if (input.action === 'quiet-test-windows') {
      globalThis.__p82Lifecycle = [];
      host.on('browser-window-created', (_event, window) => {
        window.show = () => window.showInactive();
        const id = window.id;
        const event = (name, detail = {}) => {
          // The first BrowserWindow can be created before getRuntime is assigned.
          const current = require(input.mainFile).getRuntime();
          const record = [...(current?.records.values() ?? [])].find(r => r.window === window || r.chatWindow === window);
          globalThis.__p82Lifecycle.push({ at: Date.now(), windowId: id, event: name,
            role: window === current?.mainWindow ? 'main' : record?.window === window ? 'pet' : record ? 'chat' : 'unregistered', ...detail });
        };
        event('created');
        window.on('close', () => event('close'));
        window.on('closed', () => event('closed'));
        window.webContents.on('render-process-gone', (_e, details) => event('renderer-gone', { reason: details.reason }));
        window.webContents.on('did-fail-load', (_e, code, _description, _url, mainFrame) => { if (mainFrame) event('load-failed', { code }); });
      });
      return process.pid;
    }
    if (input.action === 'release') return manager.release(input.data);
    if (input.action === 'chat') return manager.openChat(input.data);
    if (input.action === 'hide-main') { manager.mainWindow?.close(); return null; }
    if (input.action === 'show-main') { manager.showMain(); return null; }
    if (input.action === 'close-chat') {
      await require(input.closeHelperFile).closeWindowAndWait(manager.records.get(input.data)?.chatWindow);
      return null;
    }
    if (input.action === 'quit') { manager.trayMenu.getMenuItemById('quit').click(); return null; }
    if (input.action === 'sample') {
      const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(window => {
        const record = [...manager.records.values()].find(r => r.window === window || r.chatWindow === window);
        return { role: window === manager.mainWindow ? 'main' : record?.window === window ? 'pet' : record ? 'chat' : 'other',
          windowId: window.id, rendererPid: window.webContents.getOSProcessId(), visible: window.isVisible(),
          activity: record?.activity.state ?? null, loading: window.webContents.isLoadingMainFrame() };
      });
      return { at: Date.now(), processes: host.getAppMetrics(), windows,
        records: manager.records.size, authenticated: Boolean(manager.ownerId), senderCount: manager.senderCount ?? null,
        lifecycle: globalThis.__p82Lifecycle,
        mainParked: !manager.mainWindow || manager.mainWindow.isDestroyed() };
    }
    throw new Error('Unknown stability action');
  }, { mainFile, action, data, closeHelperFile: path.join(__dirname, 'window-close.cjs') });

  async function sample() {
    const value = await inspect('sample');
    if (!value.authenticated || value.records !== 3 || value.windows.length > 6
      || value.windows.filter(w => w.role === 'pet').length !== 3
      || value.windows.filter(w => w.role === 'chat').length !== 2
      || value.senderCount !== null && value.senderCount !== value.windows.length
      || value.windows.some(w => w.role === 'other')) {
      result.anomalies.push({ reason: 'unexpected-windows', snapshot: value });
      await save();
    }
    assert.equal(value.authenticated, true); assert.equal(value.records, 3);
    assert.ok(value.windows.length <= 6, 'Unexpected duplicate windows');
    assert.equal(value.windows.filter(w => w.role === 'pet').length, 3);
    assert.equal(value.windows.filter(w => w.role === 'chat').length, 2);
    if (value.senderCount !== null) assert.equal(value.senderCount, value.windows.length, 'Stale window sender retained');
    assert.ok(value.windows.every(w => w.role !== 'other'));
    value.aggregate = {
      cpuPercent: value.processes.reduce((n, p) => n + p.cpu.percentCPUUsage, 0),
      workingSetKiB: value.processes.reduce((n, p) => n + p.memory.workingSetSize, 0),
      privateKiB: value.processes.reduce((n, p) => n + (p.memory.privateBytes ?? 0), 0),
    };
    return value;
  }
  async function phase(name, durationMs, intervalMs = 1000) {
    const samples = [], start = Date.now();
    do { samples.push(await sample()); await delay(intervalMs); } while (Date.now() - start < durationMs);
    const average = field => samples.reduce((n, s) => n + s.aggregate[field], 0) / samples.length;
    result.phases[name] = { elapsedMs: Date.now() - start, samples,
      averageCpuPercent: average('cpuPercent'), averageWorkingSetMiB: average('workingSetKiB') / 1024,
      averagePrivateMiB: average('privateKiB') / 1024,
      peakWorkingSetMiB: Math.max(...samples.map(s => s.aggregate.workingSetKiB)) / 1024,
      peakPrivateMiB: Math.max(...samples.map(s => s.aggregate.privateKiB)) / 1024 };
    await save(); console.log(JSON.stringify({ phase: name, label, ...Object.fromEntries(Object.entries(result.phases[name]).filter(([k]) => k !== 'samples')) }));
  }
  try {
    await until(async () => {
      if (backend.exitCode !== null) throw new Error('Offline fixture exited');
      try { const r = await fetch(`http://127.0.0.1:${backendPort}/__p82_fixture/ready`); return r.status === 200; } catch { return false; }
    }, 'Fixture readiness failed');
    target = JSON.parse(await fs.readFile(path.join(run, 'target.json'), 'utf8'));
    assert.equal(target.fixture, 'p82-sqlite-mock-only/1'); assert.equal(path.dirname(target.database), run);
    moon = target.accounts[0].pets[0]; other = target.accounts[0].pets[1];
    app = await _electron.launch({ args: [runtimeRoot, '--profile-dir', path.join(run, 'profile'), '--ui-port', String(uiPort), '--backend-origin', target.backend_origin], env, timeout: 45000 });
    app.process().stdout?.on('data', bytes => { void fs.appendFile(path.join(run, 'electron.stdout.log'), bytes); });
    app.process().stderr?.on('data', bytes => { void fs.appendFile(path.join(run, 'electron.stderr.log'), bytes); });
    result.pids.push(app.process().pid, await inspect('quiet-test-windows'));
    const page = await app.firstWindow();
    await page.waitForURL(target.ui_origin + '/companions', { timeout: 30000 });
    await page.goto(target.ui_origin + '/login');
    await page.getByLabel('邮箱', { exact: true }).fill(target.accounts[0].email);
    await page.getByLabel('密码', { exact: true }).fill(target.accounts[0].password);
    const login = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/auth/login'));
    await page.getByRole('button', { name: '登录', exact: true }).click(); assert.equal((await login).status(), 200);
    await page.waitForURL(url => url.pathname !== '/login', { timeout: 30000 });
    await page.goto(target.ui_origin + '/companions');
    for (const pet of target.accounts[0].pets) await inspect('release', pet.pet_id);
    for (const pet of [moon, other]) {
      await inspect('chat', pet.pet_id);
      let chat;
      await until(() => { chat = app.windows().find(p => p.url().startsWith(target.ui_origin + '/pets/' + pet.pet_id)); return Promise.resolve(Boolean(chat)); }, 'Scoped chat missing');
      await expect(chat.locator('#composer-disclosure')).toContainText('本地 Mock', { timeout: 20000 });
      await chat.getByLabel('聊天消息', { exact: true }).fill('P8.2 本地稳定性测试，不调用真实模型。');
      await chat.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。', { timeout: 20000 });
      await expect(chat.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    }
    if (benchmark) {
      result.closeWaitSmoke = [];
      for (const pet of [moon, other]) {
        const before = await inspect('sample');
        await inspect('close-chat', pet.pet_id);
        const closed = await inspect('sample');
        assert.equal(closed.windows.filter(w => w.role === 'chat').length, 1);
        await inspect('chat', pet.pet_id); await delay(500);
        const reopened = await sample();
        result.closeWaitSmoke.push({ beforeWindowCount: before.windows.length,
          afterCloseWindowCount: closed.windows.length, afterReopenWindowCount: reopened.windows.length });
      }
    }
    await delay(15000);
    await phase('main-visible', 30000);
    await inspect('hide-main'); await delay(75000);
    await phase('main-hidden', 30000);
    if (!benchmark) {
      result.soakStartedAt = new Date().toISOString(); const started = Date.now();
      const samples = [], duration = minutes * 60000; let nextCycle = 120000;
      while (Date.now() - started < duration) {
        const value = await sample(); value.elapsedMs = Date.now() - started; samples.push(value);
        if (Date.now() - started >= nextCycle) {
          const beforeMain = (await inspect('sample')).windows.find(w => w.role === 'main')?.windowId ?? null;
          await inspect('show-main');
          await inspect('close-chat', moon.pet_id); await inspect('chat', moon.pet_id);
          await inspect('close-chat', other.pet_id); await inspect('chat', other.pet_id);
          await delay(3000); await inspect('hide-main');
          const afterMain = (await inspect('sample')).windows.find(w => w.role === 'main')?.windowId ?? null;
          result.cycles.push({ elapsedMs: Date.now() - started, operation: 'reopen-main-and-recreate-two-scoped-chats', mainActuallyRecreated: beforeMain === null && afterMain !== null, records: 3 });
          nextCycle += 120000;
        }
        result.soakProgressMs = Date.now() - started;
        result.soak = { elapsedMs: result.soakProgressMs, samples };
        await save();
        if (samples.length % 6 === 0) console.log(JSON.stringify({ label, soakMinutes: Math.round(result.soakProgressMs / 6000) / 10, samples: samples.length, cycles: result.cycles.length }));
        await delay(10000);
      }
      samples.push(await sample()); result.soak = { elapsedMs: Date.now() - started, samples };
      assert.ok(result.soak.elapsedMs >= duration);
      const parked = samples.filter(s => s.mainParked);
      const early = parked.filter(s => s.elapsedMs >= 300000 && s.elapsedMs <= 600000);
      const late = parked.filter(s => s.elapsedMs >= result.soak.elapsedMs - 300000);
      assert.ok(early.length >= 5 && late.length >= 5, 'Insufficient matched parked-window samples');
      const average = (values, field) => values.reduce((n, s) => n + s.aggregate[field], 0) / values.length;
      result.guards = { peakPrivateMiB: Math.max(...samples.map(s => s.aggregate.privateKiB)) / 1024,
        parkedAverageCpuPercent: average(parked, 'cpuPercent'),
        earlyParkedPrivateMiB: average(early, 'privateKiB') / 1024,
        lateParkedPrivateMiB: average(late, 'privateKiB') / 1024 };
      result.guards.parkedPrivateGrowthMiB = result.guards.lateParkedPrivateMiB - result.guards.earlyParkedPrivateMiB;
      assert.ok(result.guards.peakPrivateMiB <= 768, 'Private memory guard exceeded');
      assert.ok(result.guards.parkedAverageCpuPercent <= 2, 'Parked CPU guard exceeded');
      assert.ok(result.guards.parkedPrivateGrowthMiB <= 64, 'Private memory trend guard exceeded');
      result.soakCompletedAt = new Date().toISOString();
    }
    assert.deepEqual(await sourceHashes(), result.sourceHashes, 'Runtime source changed during measurement');
    result.sourceUnchanged = true;
    result.status = benchmark ? 'P82_BENCHMARK_COMPLETED' : 'P82_30_MINUTE_SOAK_COMPLETED';
  } catch (error) {
    result.status = 'P82_STABILITY_FAILED'; result.error = String(error.stack || error); process.exitCode = 1;
    if (app) { try { result.failureSnapshot = await inspect('sample'); } catch { result.failureSnapshotUnavailable = true; } }
  }
  finally {
    if (app) {
      const child = app.process();
      try { await inspect('quit'); await until(() => Promise.resolve(child.exitCode !== null), 'Electron exit timeout', 15000); result.electronExitCode = child.exitCode; }
      catch { result.anomalies.push('Graceful quit did not complete; closing only owned Playwright instance'); await app.close(); result.electronExitCode = child.exitCode; }
    }
    await fs.writeFile(path.join(run, 'stop-requested'), 'stop');
    result.backendExit = await Promise.race([exit, delay(15000, undefined, { ref: false }).then(() => ({ timedOut: true }))]);
    await log.close(); result.uiPortReleased = !(await listening(uiPort)); result.backendPortReleased = !(await listening(backendPort));
    if (!result.uiPortReleased || !result.backendPortReleased || result.backendExit.code !== 0 || result.electronExitCode !== 0) {
      result.status = 'P82_STABILITY_CLEANUP_BLOCKED'; process.exitCode = 1;
    }
    result.completedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: result.status, label, run, soakElapsedMs: result.soak?.elapsedMs ?? 0 }));
  }
}
main().catch(error => { console.error(String(error.message)); process.exitCode = 1; });
