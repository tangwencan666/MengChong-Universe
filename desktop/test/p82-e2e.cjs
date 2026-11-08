'use strict';

// Actual Windows Electron + existing React + actual FastAPI/SSE, offline Mock only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const { samplePerformance } = require('./performance.cjs');
const desktop = path.resolve(__dirname, '..'), repository = path.dirname(desktop);
const packagedExecutable = process.argv.find(value => value.startsWith('--executable='))?.slice('--executable='.length);
if (packagedExecutable) assert.ok(path.isAbsolute(packagedExecutable) && !path.relative(path.join(desktop, 'out'), packagedExecutable).startsWith('..'), 'Explicit project-owned build required');
const mainFile = packagedExecutable ? path.join(path.dirname(packagedExecutable), 'resources/app.asar/src/main.cjs') : path.join(desktop, 'src/main.cjs');
const localDiagnostics = process.argv.includes('--local-diagnostics');
const exec = promisify(execFile);

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve)); return value;
}
async function portOpen(value) {
  return new Promise(resolve => {
    const client = net.connect(value, '127.0.0.1');
    const finish = result => { client.destroy(); resolve(result); };
    client.once('connect', () => finish(true)); client.once('error', () => finish(false)); client.setTimeout(500, () => finish(false));
  });
}
async function until(operation, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await operation()) return; await delay(200); }
  throw new Error(message);
}

async function main() {
  assert.equal(process.platform, 'win32');
  const run = path.join(repository, '.verification/p82', 'desktop-' + randomUUID());
  await fs.mkdir(run, { recursive: true });
  const uiPort = await port(), backendPort = await port();
  const environment = desktopEnvironment(process.env);
  const result = { status: 'RUNNING', startedAt: new Date().toISOString(), run,
    model: 'local Mock only', realModelRequests: 0, sharedDatabaseAccess: false,
    packagedExecutable: packagedExecutable ?? null, localDiagnostics,
    checks: [], native: [], screenshots: [], notVerified: [], pids: [] };
  const logfile = await fs.open(path.join(run, 'backend.log'), 'wx');
  const backend = spawn(path.join(repository, 'backend/.venv/Scripts/python.exe'), ['-B',
    path.join(__dirname, 'fixtures/p82_server.py'), '--output', run, '--port', String(backendPort), '--ui-port', String(uiPort)],
  { cwd: path.join(repository, 'backend'), env: environment, windowsHide: true, stdio: ['ignore', logfile.fd, logfile.fd] });
  const backendExit = new Promise(resolve => backend.once('exit', (code, signal) => resolve({ code, signal })));
  let app, target, mainPage, runtimePid;
  const profile = path.join(run, 'profile');
  const save = () => fs.writeFile(path.join(run, 'results.json'), JSON.stringify(result, null, 2));
  async function check(name, action) {
    try { const detail = await action(); result.checks.push({ name, status: 'passed', detail }); console.log('PASS ' + name); }
    catch (error) { result.checks.push({ name, status: 'failed', error: String(error.message) }); throw error; }
    finally { await save(); }
  }
  async function inspect(action, data) {
    return app.evaluate(async ({ BrowserWindow, screen }, input) => {
      const require = process.getBuiltinModule('module').createRequire(input.mainFile);
      const manager = require(input.mainFile).getRuntime();
      if (input.action === 'release') return manager.release(input.data);
      if (input.action === 'hide') return manager.hide(input.data);
      if (input.action === 'show') return manager.show(input.data);
      if (input.action === 'recall') return manager.recall(input.data);
      if (input.action === 'quit') { manager.trayMenu.getMenuItemById('quit').click(); return null; }
      if (input.action === 'windows') return Promise.all([...manager.records.values()].map(async record => ({
        id: record.identity.pet_id, windowId: record.window.id, bounds: record.window.getBounds(),
        handle: record.window.getNativeWindowHandle().readBigUInt64LE().toString(),
        visible: record.window.isVisible(), focused: record.window.isFocused(),
        transparent: record.window.getBackgroundColor(), topmost: record.window.isAlwaysOnTop(),
        cornerAlpha: (await record.window.webContents.capturePage()).toBitmap()[3],
        activity: record.activity.state, chatId: record.chatWindow?.id ?? null,
        chatURL: record.chatWindow?.webContents.getURL() ?? null,
      })));
      if (input.action === 'metrics') return { displays: screen.getAllDisplays().map(d => ({ id: d.id, scaleFactor: d.scaleFactor, workArea: d.workArea })),
        windows: BrowserWindow.getAllWindows().length, owner: manager.ownerId };
      if (input.action === 'chat') return manager.openChat(input.data);
      throw new Error('Unknown acceptance action');
    }, { mainFile, action, data });
  }
  async function launch() {
    app = await _electron.launch({ ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      args: [...(packagedExecutable ? [] : [desktop]), '--profile-dir', profile, '--ui-port', String(uiPort),
        '--backend-origin', target.backend_origin, ...(localDiagnostics ? ['--local-diagnostics'] : [])], env: environment, timeout: 45000 });
    result.pids.push(app.process().pid);
    runtimePid = await app.evaluate(() => process.pid);
    result.pids.push(runtimePid);
    mainPage = await app.firstWindow(); await mainPage.waitForURL(target.ui_origin + '/companions');
    await mainPage.goto(target.ui_origin + '/login');
    await mainPage.getByLabel('邮箱', { exact: true }).fill(target.accounts[0].email);
    await mainPage.getByLabel('密码', { exact: true }).fill(target.accounts[0].password);
    const response = mainPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/v1/auth/login'));
    await mainPage.getByRole('button', { name: '登录', exact: true }).click();
    assert.equal((await response).status(), 200);
    await mainPage.waitForURL(url => url.origin === target.ui_origin && url.pathname !== '/login');
    await until(async () => Boolean((await inspect('metrics')).owner), 'Native authenticated identity not synchronized');
  }
  async function quit() {
    if (!app) return;
    const child = app.process();
    await inspect('quit');
    await until(() => Promise.resolve(child.exitCode !== null), 'Owned Electron did not exit', 15000);
    assert.equal(child.exitCode, 0); app = null;
  }
  async function native(script, args) {
    try {
      if (script === 'native-interaction.ps1') args = [...args, '-HitTestTimeoutMs', '1000'];
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, script), ...args],
        { windowsHide: true, timeout: 20000, env: environment });
      return JSON.parse(stdout.trim());
    } catch (error) {
      if (error.stdout?.trim()) { try { result.native.push(JSON.parse(error.stdout.trim())); } catch {} }
      throw error;
    }
  }
  try {
    await until(async () => {
      if (backend.exitCode !== null) throw new Error('Offline backend exited during startup; inspect backend.log');
      try {
        const response = await fetch(`http://127.0.0.1:${backendPort}/__p82_fixture/ready`);
        const value = await response.json();
        return response.status === 200 && value.fixture === 'p82-sqlite-mock-only/1' && value.schema_ready === true;
      } catch { return false; }
    }, 'Offline fixture readiness failed', 60000);
    target = JSON.parse(await fs.readFile(path.join(run, 'target.json'), 'utf8'));
    assert.equal(target.fixture, 'p82-sqlite-mock-only/1');
    assert.equal(target.real_model_requests, 0); assert.equal(path.dirname(target.database), run);
    await check('actual Electron and React authenticate to new offline-only SQLite fixture', launch);
    const pets = target.accounts[0].pets, moon = pets[0];
    await check('three transparent independent pet windows use showInactive', async () => {
      for (const pet of pets) await inspect('release', pet.pet_id);
      const windows = await inspect('windows'); assert.equal(windows.length, 3);
      assert.equal(new Set(windows.map(w => w.windowId)).size, 3);
      for (const w of windows) { assert.equal(w.visible, true); assert.equal(w.focused, false); assert.equal(w.cornerAlpha, 0); }
      return windows;
    });
    let windows = await inspect('windows'), one = windows.find(w => w.id === moon.pet_id);
    await check('native Windows inspection and scoped physical mouse drag', async () => {
      try {
        const args = ['-WindowHandle', one.handle, '-ExpectedProcessId', String(runtimePid)];
        const observation = await native('native-interaction.ps1', [...args, '-Action', 'inspect']); result.native.push(observation);
        const metrics = await inspect('metrics'); result.displays = metrics.displays;
        const area = metrics.displays.find(d => one.bounds.x >= d.workArea.x && one.bounds.x < d.workArea.x + d.workArea.width)?.workArea;
        const dx = one.bounds.x + 188 + 120 < area.x + area.width ? 120 : -120;
        const dy = one.bounds.y - 120 >= area.y ? -120 : 120;
        const drag = await native('native-interaction.ps1', [...args, '-Action', 'drag', '-DeltaX', String(dx), '-DeltaY', String(dy)]);
        result.native.push(drag);
        const moved = (await inspect('windows')).find(w => w.id === moon.pet_id);
        assert.ok(Math.hypot(moved.bounds.x - one.bounds.x, moved.bounds.y - one.bounds.y) > 40);
        assert.equal(moved.chatId, null);
        const shot = await native('capture.ps1', [...args, '-AllowedDirectory', run, '-OutputPath', path.join(run, 'windows-desktop-pet.png')]);
        result.screenshots.push({ ...shot, evidenceType: 'actual Windows screen pixels, not webContents or simulated desktop' });
        one = moved;
        return { moved: true, physicalInput: true, capture: shot };
      } catch (error) {
        result.notVerified.push('Native physical input or desktop capture: ' + error.message);
        throw error;
      }
    });
    const savedBounds = one.bounds;
    await check('restart with same profile restores position after fresh authentication', async () => {
      await quit(); assert.equal(await portOpen(uiPort), false);
      await launch(); await inspect('release', moon.pet_id);
      const current = (await inspect('windows'))[0];
      assert.ok(Math.abs(current.bounds.x - savedBounds.x) <= 1 && Math.abs(current.bounds.y - savedBounds.y) <= 1);
      const state = JSON.parse(await fs.readFile(path.join(profile, 'pet-positions-v1.json'), 'utf8'));
      assert.equal(state.version, 1); assert.equal(JSON.stringify(state).includes(moon.pet_id), false);
      return { before: savedBounds, after: current.bounds, restoredWithoutRestoringLogin: true };
    });
    one = (await inspect('windows'))[0];
    await check('idle pet timers preserve the existing independent Windows foreground without changing it', async () => {
      const observed = await native('p82-focus-observe.ps1', ['-WindowHandle', one.handle, '-ExpectedProcessId', String(runtimePid)]);
      assert.equal(observed.stable, true); result.native.push(observed); return observed;
    });
    await check('physical click opens exactly the existing scoped React chat', async () => {
      const click = await native('native-interaction.ps1', ['-WindowHandle', one.handle, '-ExpectedProcessId', String(runtimePid), '-Action', 'click']);
      result.native.push(click);
      await until(async () => Boolean((await inspect('windows'))[0].chatId), 'Physical pet click did not open a chat');
      const state = (await inspect('windows'))[0];
      assert.ok(state.chatURL.startsWith(target.ui_origin + '/pets/' + moon.pet_id));
      return { chatId: state.chatId, petId: moon.pet_id, physicalInput: true };
    });
    const chatId = (await inspect('windows'))[0].chatId;
    let chat;
    await until(async () => {
      chat = app.windows().find(page => page.url().startsWith(target.ui_origin + '/pets/' + moon.pet_id)); return Boolean(chat);
    }, 'Chat renderer unavailable');
    await check('local Mock SSE drives thinking and speaking without changing sibling pets', async () => {
      for (const pet of pets.slice(1)) await inspect('release', pet.pet_id);
      windows = await inspect('windows');
      // Find the exact main-process window, since all pet renderer URLs are equal.
      const pages = [];
      for (const page of app.windows()) {
        const handle = await app.browserWindow(page);
        if (await handle.evaluate(win => win.id) === one.windowId) pages.push(page);
      }
      const moonPage = pages[0];
      assert.ok(moonPage && chatId);
      await moonPage.evaluate(() => {
        window.p82States = [document.body.dataset.activity];
        window.weibiyePet.onState(value => window.p82States.push(value.activity));
      });
      await expect(chat.locator('#composer-disclosure')).toContainText('本地 Mock', { timeout: 20000 });
      await chat.getByLabel('聊天消息', { exact: true }).fill('这是P8.2离线桌面回归，请给我一个简单问候。');
      const response = chat.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/messages'));
      await chat.getByRole('button', { name: '发送消息', exact: true }).click();
      const accepted = await response; assert.equal(accepted.status(), 202);
      const data = await accepted.json(); assert.equal(data.generation.provider, 'mock');
      await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。', { timeout: 30000 });
      await expect(chat.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 20000 });
      const states = await moonPage.evaluate(() => window.p82States);
      assert.ok(states.includes('thinking'), JSON.stringify(states)); assert.ok(states.includes('speaking'), JSON.stringify(states));
      assert.ok(states.includes('happy'), JSON.stringify(states));
      const scoped = await inspect('windows');
      for (const pet of pets.slice(1)) assert.ok(!['thinking', 'speaking'].includes(scoped.find(w => w.id === pet.pet_id).activity));
      await chat.reload(); await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。', { timeout: 20000 });
      await chat.screenshot({ path: path.join(run, 'actual-react-offline-chat.png') });
      result.screenshots.push({ file: path.join(run, 'actual-react-offline-chat.png'), evidenceType: 'actual Electron renderer, local Mock response; not Windows desktop capture' });
      return { states, generationId: data.generation.id, provider: 'mock', persistedAfterReload: true };
    });
    await check('switching to Doubao opens its own empty history without sharing Moon chat', async () => {
      const other = (await inspect('windows')).find(w => w.id === pets[1].pet_id);
      const click = await native('native-interaction.ps1', ['-WindowHandle', other.handle,
        '-ExpectedProcessId', String(runtimePid), '-Action', 'click']);
      result.native.push(click);
      await until(async () => Boolean((await inspect('windows')).find(w => w.id === pets[1].pet_id).chatId), 'Doubao chat not opened');
      const otherPage = app.windows().find(page => page.url().startsWith(target.ui_origin + '/pets/' + pets[1].pet_id));
      assert.ok(otherPage); await expect(otherPage.locator('#composer-disclosure')).toContainText('本地 Mock', { timeout: 20000 });
      const counts = await otherPage.evaluate(async ids => {
        const values = [];
        for (const id of ids) {
          const response = await fetch('/api/v1/pets/' + id + '/sessions', { credentials: 'include' });
          if (response.status !== 200) throw new Error('Scoped history unavailable');
          values.push((await response.json()).items.length);
        }
        return values;
      }, pets.map(pet => pet.pet_id));
      assert.deepEqual(counts, [1, 0, 0]);
      return { petNames: pets.map(p => p.name), sessionCounts: counts, physicalInput: true };
    });
    await check('three-pet steady idle resource observation', async () => {
      await delay(6500);
      result.performance = await samplePerformance(app, 'P8.2 three-pet quiet idle', 11000, 1000);
      // Explicit guardrails are generous for a development Electron build; retain measurements.
      assert.ok(result.performance.averageCpuPercent < 15, 'Idle CPU exceeds 15% app-metric budget');
      assert.ok(result.performance.peakWorkingSetKiB < 1200 * 1024, 'Working set exceeds 1.2GiB development budget');
      return { averageCpuPercent: result.performance.averageCpuPercent,
        peakWorkingSetMiB: result.performance.peakWorkingSetKiB / 1024 };
    });
    await check('recalling one pet preserves sibling windows and quit exits normally', async () => {
      await inspect('recall', moon.pet_id); assert.equal((await inspect('windows')).length, 2);
      await quit(); assert.equal(await portOpen(uiPort), false);
      return { recalledOneOnly: true, electronExitCode: 0, uiPortReleased: true };
    });
    if (localDiagnostics) await check('opt-in diagnostics persist only fixed local event metadata', async () => {
      const content = await fs.readFile(path.join(profile, 'diagnostics-v1/events.jsonl'), 'utf8');
      const rows = content.trim().split('\n').map(line => JSON.parse(line));
      const allowed = new Set(['schema', 'at', 'version', 'event', 'role', 'reason', 'windowCount', 'petCount']);
      assert.ok(rows.length > 0 && rows.every(row => row.schema === 'weibiye-diagnostics/1' && Object.keys(row).every(key => allowed.has(key))));
      assert.ok(rows.some(row => row.event === 'started') && rows.some(row => row.event === 'stopped'));
      for (const privateValue of [target.accounts[0].email, target.accounts[0].password, moon.pet_id, '这是P8.2离线桌面回归']) assert.equal(content.includes(privateValue), false);
      const profileFiles = await fs.readdir(profile, { recursive: true });
      const dumpFiles = profileFiles.filter(file => path.extname(file).toLowerCase() === '.dmp');
      assert.equal(dumpFiles.length, 0);
      return { events: rows.map(row => row.event), uploaded: false, dumpFilesFoundInProfile: dumpFiles.length };
    });
    result.status = 'P82_WINDOWS_MVP_OFFLINE_VERIFIED';
    result.notVerified.push('Only current Windows host/display topology tested; physical multi-monitor hotplug and other DPI configurations remain unverified.',
      'No real model request; real upstream cancellation remains unverified per P8.1 closeout.',
      'This short native test does not verify installer/uninstaller, clean-machine deployment or long-duration stability; see the separate stability result.');
  } catch (error) {
    result.status = 'P82_ACCEPTANCE_FAILED'; result.failure = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    if (app) { try { await quit(); } catch { result.notVerified.push('Normal Electron quit failed; only owned Playwright instance close attempted.'); await app.close(); app = null; } }
    await fs.writeFile(path.join(run, 'stop-requested'), new Date().toISOString());
    result.backendExit = await Promise.race([backendExit, delay(15000, undefined, { ref: false }).then(() => ({ timedOut: true }))]);
    await logfile.close();
    result.uiPortReleased = !(await portOpen(uiPort)); result.backendPortReleased = !(await portOpen(backendPort));
    result.completedAt = new Date().toISOString();
    if (result.backendExit.timedOut || !result.uiPortReleased || !result.backendPortReleased) {
      result.status = 'P82_CLEANUP_BLOCKED'; process.exitCode = 1;
    } else if (result.backendExit.code !== 0) {
      result.status = 'P82_ACCEPTANCE_FAILED'; process.exitCode = 1;
    }
    await save(); console.log(JSON.stringify({ status: result.status, passed: result.checks.filter(c => c.status === 'passed').length,
      failed: result.checks.filter(c => c.status === 'failed').length, evidence: path.join(run, 'results.json') }));
  }
}
main().catch(error => { console.error(String(error.message)); process.exitCode = 1; });
