'use strict';
// Real Windows/Electron/React/API/SSE, new SQLite and explicit Mock only.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto'), { setTimeout: delay } = require('node:timers/promises');
const { _electron, expect } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const { samplePerformance } = require('./performance.cjs');
const desktop = path.resolve(__dirname, '..'), root = path.dirname(desktop), mainFile = path.join(desktop, 'src/main.cjs');
const minutes = Number(process.argv.find(arg => arg.startsWith('--minutes='))?.slice(10) ?? 0);
const fast = process.argv.includes('--fast-interaction-smoke');
assert.ok(minutes === 0 || Number.isInteger(minutes) && minutes >= 30 && minutes <= 60);
assert.ok(!(fast && minutes), 'Fast interaction smoke cannot claim a soak');
async function freePort() { const s = net.createServer(); await new Promise((yes, no) => { s.once('error', no); s.listen(0, '127.0.0.1', yes); }); const p = s.address().port; await new Promise(yes => s.close(yes)); return p; }
async function openPort(port) { return new Promise(yes => { const s = net.connect(port, '127.0.0.1'); const done = value => { s.destroy(); yes(value); }; s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(1000, () => done(false)); }); }
async function until(check, message, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await check())
            return;
        await delay(100);
    }
    throw Error(message);
}
async function hashes() {
    const names = ['ui-dist/UI_ASSETS.json', '../frontend/src/App.tsx', '../frontend/src/pages/p84-catalog.tsx', '../frontend/src/pages/p84-catalog.css', '../frontend/src/features/p84/catalog.ts',
        'test/fixtures/p84_server.py', 'test/fixtures/p84-focus-window.ps1', 'test/p84-cursor.ps1', 'test/native-interaction.ps1', 'test/p82-focus-observe.ps1', 'test/performance.cjs'];
    for (const folder of ['src', 'renderer', 'assets'])
        for (const file of await fs.readdir(path.join(desktop, folder)))
            if (/\.(?:cjs|js|css|html|svg|png|json|ico)$/.test(file))
                names.push(folder + '/' + file);
    return Object.fromEntries(await Promise.all(names.map(async (name) => [name, createHash('sha256').update(await fs.readFile(path.join(desktop, name))).digest('hex')])));
}
async function main() {
    assert.equal(process.platform, 'win32');
    const run = path.join(root, '.verification/p84', 'windows-' + randomUUID());
    await fs.mkdir(run, { recursive: true });
    const profile = path.join(run, 'profile'), uiPort = await freePort(), backendPort = await freePort(), env = desktopEnvironment(process.env);
    const result = { status: 'RUNNING', run, startedAt: new Date().toISOString(), minutes, realModelRequests: 0, sharedDatabaseAccess: false, ports: { uiPort, backendPort }, checks: [], performance: {}, native: [], screenshots: [], pids: [] };
    result.sourceHashes = await hashes();
    await fs.copyFile(__filename, path.join(run, 'acceptance-driver.cjs'));
    const save = () => fs.writeFile(path.join(run, 'results.json'), JSON.stringify(result, null, 2));
    const log = await fs.open(path.join(run, 'backend.log'), 'wx');
    const backend = spawn(path.join(root, 'backend/.venv/Scripts/python.exe'), ['-B', path.join(__dirname, 'fixtures/p84_server.py'), '--output', run, '--port', String(backendPort), '--ui-port', String(uiPort)], { cwd: path.join(root, 'backend'), env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    result.pids.push(backend.pid);
    const backendExit = new Promise(yes => backend.once('exit', (code, signal) => yes({ code, signal })));
    let app, target, page, hostPid;
    async function check(name, fn) {
        try {
            const detail = await fn();
            result.checks.push({ name, status: 'passed', detail });
            console.log('PASS ' + name);
        }
        catch (error) {
            result.checks.push({ name, status: 'failed', error: String(error.message) });
            throw error;
        }
        finally {
            await save();
        }
    }
    async function inspect(action, data) {
        return app.evaluate(async ({ app: host, BrowserWindow, screen, powerSaveBlocker }, { mainFile, action, data }) => {
            const require = process.getBuiltinModule('module').createRequire(mainFile), manager = require(mainFile).getRuntime();
            if (action === 'owner')
                return manager.ownerId;
            if (action === 'release')
                return manager.release(data);
            if (action === 'recall')
                return manager.recall(data);
            if (action === 'hide')
                return manager.hide(data);
            if (action === 'show')
                return manager.show(data);
            if (action === 'chat')
                return manager.openChat(data);
            if (action === 'configure')
                return manager.configurePet(data.id, data.preferences);
            if (action === 'play')
                return manager.playAction(data.id, data.action);
            if (action === 'pulse-local-animation') {
                // Deterministic local scheduler stimulus, not repeated user API commands.
                const engine = require('./pet-actions.cjs');
                let index = 0;
                for (const record of manager.records.values())
                    engine.start(record.actor, index++ % 2 ? 'roll' : 'jump', Date.now(), { direct: true });
                return;
            }
            if (action === 'quit') {
                manager.trayMenu.getMenuItemById('quit').click();
                return;
            }
            if (action === 'stats')
                return { windows: BrowserWindow.getAllWindows().length, senders: manager.senderCount, actions: { ...manager.actionStats }, cache: manager.assetStats.petCache,
                    displays: screen.getAllDisplays().map(d => ({ id: d.id, scaleFactor: d.scaleFactor, workArea: d.workArea })),
                    pets: [...manager.records.values()].map(r => ({ id: r.identity.pet_id, definition: r.actor.definition, action: r.actor.action, sequence: r.actor.sequence,
                        preferences: { ...r.actor.preferences }, windowId: r.window.id, bounds: r.window.getBounds(), hidden: r.hidden,
                        handle: r.window.getNativeWindowHandle().readBigUInt64LE().toString(), rendererPid: r.window.webContents.getOSProcessId(), chatRendererPid: r.chatWindow?.webContents.getOSProcessId() ?? null, chatId: r.chatWindow?.id ?? null, chatURL: r.chatWindow?.webContents.getURL() ?? null })) };
            if (action === 'close-chat') {
                const win = manager.records.get(data).chatWindow;
                if (win) {
                    const closed = new Promise(yes => win.once('closed', yes));
                    win.close();
                    await closed;
                }
                return;
            }
            if (action === 'hide-main') {
                manager.mainWindow?.close();
                return;
            }
            if (action === 'show-main') {
                manager.showMain();
                return;
            }
            if (action === 'menu') {
                const record = manager.records.get(data);
                const handler = manager.lastContextMenu;
                const detail = handler.items.map(item => ({ id: item.id, label: item.label, type: item.type, checked: item.checked }));
                handler.closePopup();
                return { detail, definition: record.actor.definition };
            }
            if (action === 'background-soak') {
                const quiet = win => { win.show = () => win.showInactive(); win.focus = () => { }; };
                BrowserWindow.getAllWindows().forEach(quiet);
                host.on('browser-window-created', (_event, win) => quiet(win));
                globalThis.__p84Blocker = powerSaveBlocker.start('prevent-app-suspension');
                return true;
            }
            if (action === 'stop-blocker') {
                if (globalThis.__p84Blocker !== undefined)
                    powerSaveBlocker.stop(globalThis.__p84Blocker);
                return;
            }
            throw Error('Unknown inspection action');
        }, { mainFile, action, data });
    }
    async function native(file, args) { const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, file), ...args], { env, windowsHide: true, timeout: 20000 }); const data = JSON.parse(stdout.trim()); result.native.push(data); return data; }
    async function quit() {
        if (!app)
            return;
        const child = app.process();
        await inspect('stop-blocker');
        await inspect('quit');
        await until(() => Promise.resolve(child.exitCode !== null), 'Electron normal exit timeout', 15000);
        assert.equal(child.exitCode, 0);
        app = null;
    }
    async function launch() {
        app = await _electron.launch({ args: [desktop, '--profile-dir', profile, '--ui-port', String(uiPort), '--backend-origin', target.backend_origin], env, timeout: 45000 });
        result.pids.push(app.process().pid);
        hostPid = await app.evaluate(() => process.pid);
        page = await app.firstWindow();
        await page.waitForURL(target.ui_origin + '/companions');
        await page.goto(target.ui_origin + '/login');
        await page.getByLabel('邮箱', { exact: true }).fill(target.accounts[0].email);
        await page.getByLabel('密码', { exact: true }).fill(target.accounts[0].password);
        const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/auth/login'));
        await page.getByRole('button', { name: '登录', exact: true }).click();
        assert.equal((await response).status(), 200);
        await until(async () => Boolean(await inspect('owner')), 'Native account synchronization failed');
        await page.goto(target.ui_origin + '/companions');
    }
    async function petPage(id) {
        const stats = await inspect('stats'), record = stats.pets.find(p => p.id === id);
        for (const candidate of app.windows()) {
            const win = await app.browserWindow(candidate);
            if (await win.evaluate(w => w.id) === record.windowId)
                return candidate;
        }
        throw Error('Pet renderer missing');
    }
    async function chatPage(id) { await inspect('chat', id); await until(() => Promise.resolve(app.windows().some(p => p.url().startsWith(target.ui_origin + '/pets/' + id))), 'Chat missing'); return app.windows().find(p => p.url().startsWith(target.ui_origin + '/pets/' + id)); }
    async function quiet(ids) {
        for (const id of ids)
            await inspect('configure', { id, preferences: { random: false, autoMove: false } });
        await delay(6500);
    }
    try {
        await until(async () => {
            if (backend.exitCode !== null)
                throw Error('Fresh Mock backend exited; inspect owned backend.log');
            try {
                const response = await fetch(`http://127.0.0.1:${backendPort}/__p84_fixture/ready`);
                return response.ok && (await response.json()).schema_ready === true;
            }
            catch {
                return false;
            }
        }, 'P84 fixture not ready', 60000);
        target = JSON.parse(await fs.readFile(path.join(run, 'target.json'), 'utf8'));
        assert.equal(target.fixture, 'p84-sqlite-mock-only/1');
        assert.equal(target.real_model_requests, 0);
        await check('actual React authenticates and registers a new Maodie from the shared five-pet catalog', async () => {
            await launch();
            await page.getByRole('link', { name: /^(?:五|八)种伙伴 · 选择宠物模板$/ }).click();
            await page.waitForURL(target.ui_origin + '/pet-catalog');
            for (const name of ['月芽', '豆包', '小云', '耄耋', '哈吉米'])
                await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
            const response = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/v1\/(?:pets|pet-instances)$/.test(r.url()));
            await page.getByRole('button', { name: '领养耄耋', exact: true }).click();
            const created = await (await response).json();
            assert.equal(created.name, '耄耋');
            assert.equal(created.appearance_config.asset_id, 'maodie');
            assert.equal(created.persona_config.tone, 'playful');
            assert.ok(!target.accounts[0].pets.some(p => p.pet_id === created.pet_id));
            await page.goto(target.ui_origin + '/companions');
            return { catalog: 5, newDistinctPet: true, provider: 'Mock only' };
        });
        const pets = target.accounts[0].pets, ids = pets.map(p => p.pet_id), moon = ids[0], maodie = ids[3], hajimi = ids[4];
        async function releaseViaUI(id) { const card = page.locator('.pet-card').filter({ has: page.locator(`a[href="/pets/${id}"]`) }); await card.getByRole('button', { name: /^(?:放到桌面|召唤到桌面)$/ }).click(); await until(async () => (await inspect('stats')).pets.some(p => p.id === id), 'UI release failed'); }
        for (const [count, additions] of [[1, [0]], [3, [1, 2]], [5, [3, 4]]]) {
            await check(count + ' pets release through real UI with independent original art and bounded idle resources', async () => {
                for (const index of additions)
                    await releaseViaUI(ids[index]);
                if (count >= 3) {
                    await chatPage(ids[0]);
                    await chatPage(ids[1]);
                }
                await quiet(ids.slice(0, count));
                const state = await inspect('stats');
                assert.equal(state.pets.length, count);
                assert.equal(new Set(state.pets.map(p => p.windowId)).size, count);
                if (count === 5)
                    assert.deepEqual(state.pets.map(p => p.definition), ['moon', 'doubao', 'xiaoyun', 'maodie', 'hajimi']);
                if (fast)
                    return { pets: count, performanceNotMeasured: true };
                const performance = await samplePerformance(app, `P84 ${count} pets, ${count >= 3 ? 2 : 0} chat windows`, 11000, 1000);
                result.performance['idle' + count] = performance;
                assert.ok(performance.averageCpuPercent < 15);
                assert.ok(performance.peakWorkingSetKiB < (count === 5 ? 1800 : 1300) * 1024);
                return { pets: count, chats: count >= 3 ? 2 : 0, cpu: performance.averageCpuPercent, peakWorkingSetMiB: performance.peakWorkingSetKiB / 1024 };
            });
        }
        await check('five-pet native Windows drag and click preserve DPI dimensions and scoped chat', async () => {
            const state = await inspect('stats');
            result.displays = state.displays;
            const record = state.pets.find(p => p.id === maodie);
            const common = ['-WindowHandle', record.handle, '-ExpectedProcessId', String(hostPid)];
            const observation = await native('native-interaction.ps1', [...common, '-Action', 'inspect']);
            assert.equal(observation.caption, false);
            assert.equal(observation.topmost, true);
            await native('native-interaction.ps1', [...common, '-Action', 'drag', '-DeltaX', '0', '-DeltaY', '-210', '-HitTestTimeoutMs', '1000']);
            const after = (await inspect('stats')).pets.find(p => p.id === maodie);
            assert.ok(Math.abs(after.bounds.y - record.bounds.y) > 100);
            assert.ok(Math.abs(after.bounds.width - 188) <= 1);
            const image = await native('capture.ps1', [...common, '-AllowedDirectory', run, '-OutputPath', path.join(run, 'actual-windows-maodie.png')]);
            result.screenshots.push(image);
            await inspect('close-chat', ids[1]);
            const renderer = await petPage(maodie);
            await renderer.evaluate(() => { window.p84ClickFrames = []; window.p84ClickUnsubscribe = window.weibiyePet.onState(value => window.p84ClickFrames.push(value.action)); });
            await native('native-interaction.ps1', [...common, '-Action', 'click', '-HitTestTimeoutMs', '1000']);
            await until(async () => (await inspect('stats')).pets.find(p => p.id === maodie).chatId !== null, 'Physical click did not open Maodie chat');
            assert.equal(await renderer.evaluate(() => window.p84ClickFrames.includes('innocent')), true);
            await renderer.evaluate(() => window.p84ClickUnsubscribe());
            assert.ok((await inspect('stats')).pets.find(p => p.id === maodie).chatURL.startsWith(target.ui_origin + '/pets/' + maodie));
            return { physicalDrag: true, physicalClick: true, clickAction: 'innocent', before: record.bounds, after: after.bounds };
        });
        await check('new pet actions render, a physical context menu exposes scoped behavior switches, cursor proximity reacts', async () => {
            const mouseRecord = (await inspect('stats')).pets.find(p => p.id === hajimi), mouseRenderer = await petPage(hajimi);
            await mouseRenderer.evaluate(() => { window.p84PointerFrames = []; window.p84PointerUnsubscribe = window.weibiyePet.onState(value => window.p84PointerFrames.push(value.action)); });
            await inspect('configure', { id: hajimi, preferences: { random: true, autoMove: false } });
            await native('p84-cursor.ps1', ['-WindowHandle', mouseRecord.handle, '-ExpectedProcessId', String(hostPid)]);
            await until(() => mouseRenderer.evaluate(() => window.p84PointerFrames.includes('rub')), 'Cursor proximity did not produce a rub action');
            await mouseRenderer.screenshot({ path: path.join(run, 'actual-hajimi-rub.png') });
            result.screenshots.push({ file: path.join(run, 'actual-hajimi-rub.png'), kind: 'actual Electron renderer' });
            await mouseRenderer.evaluate(() => window.p84PointerUnsubscribe());
            await inspect('configure', { id: hajimi, preferences: { random: false, autoMove: false } });
            const seen = {};
            for (const [id, names] of [[maodie, ['fluff', 'jump', 'run', 'turn', 'innocent', 'sleep', 'wake']], [hajimi, ['stretch', 'roll', 'belly', 'rub', 'affection', 'sleep', 'wake']]]) {
                const renderer = await petPage(id);
                seen[id] = [];
                for (const action of names) {
                    await delay(650);
                    assert.equal(await inspect('play', { id, action }), true);
                    await expect(renderer.locator('body')).toHaveAttribute('data-action', action);
                    seen[id].push(action);
                }
            }
            const record = (await inspect('stats')).pets.find(p => p.id === hajimi);
            await native('native-interaction.ps1', ['-WindowHandle', record.handle, '-ExpectedProcessId', String(hostPid), '-Action', 'context', '-HitTestTimeoutMs', '1000']);
            const menu = await inspect('menu', hajimi);
            assert.ok(menu.detail.some(item => item.id === 'random' && item.type === 'checkbox'));
            assert.ok(menu.detail.some(item => item.id === 'auto-move' && item.type === 'checkbox'));
            return { seen, physicalContextMenu: true, physicalCursorNoClick: true };
        });
        if (fast) {
            // Keep the existing per-owner server limit while pacing the burst
            // of fourteen authorized actions before the next API-heavy group.
            console.log('PACE fast action burst completed; preserve the server read limit');
            await delay(65000);
        }
        await check('actual Mock SSE overrides local gestures and never changes sibling chat or pet state', async () => {
            const chat = await chatPage(maodie), renderer = await petPage(maodie);
            await renderer.evaluate(() => { window.p84States = []; window.p84Unsubscribe = window.weibiyePet.onState(value => window.p84States.push({ action: value.action, activity: value.activity })); });
            await expect(chat.locator('#composer-disclosure')).toContainText('本地 Mock');
            await inspect('play', { id: maodie, action: 'stretch' });
            await chat.getByLabel('聊天消息', { exact: true }).fill('P84离线对话与动作联动');
            await chat.getByRole('button', { name: '发送消息', exact: true }).click();
            await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。', { timeout: 30000 });
            const states = await renderer.evaluate(() => window.p84States);
            assert.ok(states.some(s => s.action === 'thinking'));
            assert.ok(states.some(s => s.action === 'speaking'));
            await renderer.evaluate(() => window.p84Unsubscribe());
            await chat.reload();
            await expect(chat.getByRole('log')).toContainText('你可以用它体验已保存会话的流式显示。');
            const counts = await chat.evaluate(async (ids) => Promise.all(ids.map(async (id) => (await (await fetch('/api/v1/pets/' + id + '/sessions')).json()).items.length)), ids);
            assert.deepEqual(counts, [0, 0, 0, 1, 0]);
            return { states, sessionCounts: counts, persisted: true, realModelRequests: 0 };
        });
        await check('five simultaneous finite motions keep independent renderers and bounded resources', async () => {
            await quiet(ids);
            let simultaneous = 0;
            const animate = async () => {
                for (let round = 0; round < (fast ? 1 : 5); round++) {
                    await inspect('pulse-local-animation');
                    await delay(100);
                    simultaneous = Math.max(simultaneous, (await inspect('stats')).pets.filter(p => ['roll', 'jump'].includes(p.action)).length);
                    await delay(2400);
                }
            };
            const outcomes = await Promise.allSettled([fast ? Promise.resolve(null) : samplePerformance(app, 'P84 five simultaneous motions', 12000, 1000), animate()]);
            for (const outcome of outcomes)
                if (outcome.status === 'rejected')
                    throw outcome.reason;
            const metrics = outcomes[0].value;
            result.performance.animations = metrics;
            const state = await inspect('stats');
            assert.equal(state.pets.length, 5);
            assert.ok(state.cache.bytes <= state.cache.budget);
            if (metrics)
                assert.ok(metrics.averageCpuPercent < 20);
            assert.equal(simultaneous, 5);
            return { simultaneous, cpu: metrics?.averageCpuPercent ?? null, peakWorkingSetMiB: metrics ? metrics.peakWorkingSetKiB / 1024 : null, cache: state.cache };
        });
        await check('hidden images unload; closed chat resources and a parked dashboard reduce tray work', async () => {
            for (const id of ids) {
                await inspect('hide', id);
                await inspect('close-chat', id);
            }
            await inspect('hide-main');
            await delay(fast ? 1200 : 70000);
            for (const id of ids)
                assert.equal(await (await petPage(id)).locator('#pet-art').getAttribute('src'), null);
            const metrics = fast ? null : await samplePerformance(app, 'P84 five hidden pets, no chat or dashboard renderer', 11000, 1000);
            result.performance.tray = metrics;
            const state = await inspect('stats');
            assert.equal(state.windows, fast ? 6 : 5);
            assert.equal(state.senders, fast ? 6 : 5);
            for (const id of ids)
                await inspect('show', id);
            await inspect('show-main');
            for (const id of ids)
                await expect((await petPage(id)).locator('#pet-art')).toHaveAttribute('src', /\.svg$/);
            return { hiddenImagesReleased: true, dashboardParkingMeasured: !fast, windows: state.windows, cpu: metrics?.averageCpuPercent ?? null, peakWorkingSetMiB: metrics ? metrics.peakWorkingSetKiB / 1024 : null };
        });
        await check('restart restores native placement and scoped behavior settings without restoring stale chat state', async () => {
            await inspect('configure', { id: maodie, preferences: { random: false, autoMove: false } });
            await inspect('configure', { id: hajimi, preferences: { random: false, autoMove: true } });
            await inspect('play', { id: hajimi, action: 'sleep' });
            const before = (await inspect('stats')).pets.find(p => p.id === maodie).bounds;
            await quit();
            assert.equal(await openPort(uiPort), false);
            await launch();
            for (const id of ids)
                await inspect('release', id);
            const after = await inspect('stats'), record = after.pets.find(p => p.id === maodie);
            assert.ok(Math.abs(before.x - record.bounds.x) <= 1 && Math.abs(before.y - record.bounds.y) <= 1);
            assert.equal(record.preferences.autoMove, false);
            assert.equal(record.preferences.random, false);
            const restored = after.pets.find(p => p.id === hajimi);
            assert.equal(restored.preferences.autoMove, true);
            assert.equal(restored.action, 'sleep');
            assert.ok(after.pets.every(p => !['thinking', 'speaking', 'dragging'].includes(p.action)));
            await quiet(ids);
            return { before, after: record.bounds, preferencesRestored: true, staleGenerationNotRestored: true };
        });
        await check('native background activity preserves the current external foreground', async () => {
            const directory = path.join(run, 'focus-probe');
            await fs.mkdir(directory);
            const focusLog = await fs.open(path.join(directory, 'helper.log'), 'wx');
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'fixtures/p84-focus-window.ps1'), '-EvidenceDirectory', directory], { env, windowsHide: true, stdio: ['ignore', focusLog.fd, focusLog.fd] });
            const exit = new Promise(yes => child.once('exit', code => yes(code)));
            let observedSuccessfully = false;
            try {
                await until(() => {
                    if (child.exitCode !== null)
                        throw Error('Focus helper exited; inspect helper.log');
                    return fs.access(path.join(directory, 'focus-window.json')).then(() => true, () => false);
                }, 'Independent focus probe not ready');
                const target = JSON.parse((await fs.readFile(path.join(directory, 'focus-window.json'), 'utf8')).replace(/^\uFEFF/, ''));
                await native('native-interaction.ps1', ['-WindowHandle', target.handle, '-ExpectedProcessId', String(target.pid), '-Action', 'click', '-OffsetX', '180', '-OffsetY', '140', '-HitTestTimeoutMs', '1000']);
                const record = (await inspect('stats')).pets[0], observed = await native('p82-focus-observe.ps1', ['-WindowHandle', record.handle, '-ExpectedProcessId', String(hostPid)]);
                assert.equal(observed.baselineIsOtherProcess, true);
                assert.equal(observed.stable, true);
                observedSuccessfully = true;
                return observed;
            }
            finally {
                await fs.writeFile(path.join(directory, 'stop-focus'), 'stop', { flag: 'wx' });
                const code = await Promise.race([exit, delay(10000).then(() => { throw Error('Owned focus helper did not exit'); })]);
                await focusLog.close();
                if (observedSuccessfully)
                    assert.equal(code, 0);
            }
        });
        if (minutes)
            await check('thirty-minute real five-pet stability with bounded movement and lifecycle reuse', async () => {
                result.soakInstrumentation = { showInactiveInsteadOfShow: true, focusSuppressedDuringSoak: true, powerBlocker: 'prevent-app-suspension, stopped on exit' };
                await inspect('background-soak');
                for (const id of ids)
                    await inspect('configure', { id, preferences: { random: true, autoMove: true } });
                await chatPage(maodie);
                await chatPage(hajimi);
                const clock = () => performance.now();
                const start = clock(), samples = [];
                let cycle = 0, lastCycle = start, lastSample = start;
                while (clock() - start < minutes * 60000) {
                    if (await fs.access(path.join(run, 'stop-soak')).then(() => true, () => false))
                        throw Error('Soak explicitly interrupted, no verified completion');
                    await delay(10000);
                    assert.ok(clock() - lastSample < 30000, 'Sampling gap: sleep/stall cannot count as running soak');
                    lastSample = clock();
                    const metrics = await app.evaluate(({ app }) => app.getAppMetrics()), state = await inspect('stats');
                    assert.equal(state.pets.length, 5);
                    assert.ok(state.windows <= 8 && state.senders <= 8);
                    assert.ok(state.cache.bytes <= state.cache.budget);
                    assert.equal(state.actions.recoveries, 0);
                    const total = metrics.reduce((sum, p) => ({ cpu: sum.cpu + p.cpu.percentCPUUsage, workingSetKiB: sum.workingSetKiB + p.memory.workingSetSize, privateKiB: sum.privateKiB + (p.memory.privateBytes ?? 0) }), { cpu: 0, workingSetKiB: 0, privateKiB: 0 });
                    assert.ok(total.privateKiB > 0, 'Private commit metric unavailable');
                    samples.push({ elapsedMs: clock() - start, at: new Date().toISOString(), total, metrics, state });
                    if (clock() - lastCycle > 120000) {
                        const id = ids[cycle % ids.length];
                        await inspect('hide', id);
                        await inspect('show', id);
                        await inspect('close-chat', cycle % 2 ? maodie : hajimi);
                        await chatPage(cycle % 2 ? maodie : hajimi);
                        cycle++;
                        lastCycle = clock();
                    }
                    result.soak = { elapsedMs: clock() - start, cycles: cycle, sampleCount: samples.length, last: total };
                    await save();
                    if (samples.length % 6 === 0)
                        console.log('SOAK ' + Math.floor((clock() - start) / 60000) + 'm / ' + minutes + 'm');
                }
                const elapsedMs = clock() - start;
                assert.ok(elapsedMs >= minutes * 60000);
                assert.ok(samples.length >= 170);
                const average = list => list.reduce((sum, s) => sum + s.total.privateKiB, 0) / list.length;
                const privateGrowthKiB = average(samples.slice(-30)) - average(samples.slice(6, 36));
                const peakPrivateKiB = Math.max(...samples.map(s => s.total.privateKiB)), peakWorkingSetKiB = Math.max(...samples.map(s => s.total.workingSetKiB));
                assert.ok(privateGrowthKiB < 96 * 1024, 'Sustained private memory growth exceeds 96 MiB');
                assert.ok(peakPrivateKiB < 1100 * 1024);
                assert.ok(peakWorkingSetKiB < 1800 * 1024);
                const final = await inspect('stats');
                assert.ok(final.actions.transitions > 10);
                assert.ok(final.actions.moves > 0);
                assert.ok(final.actions.coordinated > 0);
                const file = path.join(run, 'soak-samples.json');
                await fs.writeFile(file, JSON.stringify(samples, null, 2), { flag: 'wx' });
                result.soak = { elapsedMs, cycles: cycle, sampleCount: samples.length, privateGrowthKiB, peakPrivateKiB, peakWorkingSetKiB, averageCpu: samples.reduce((s, p) => s + p.total.cpu, 0) / samples.length, actions: final.actions, file };
                await inspect('stop-blocker');
                return result.soak;
            });
        await check('owner invalidation and quit remove every pet/chat sender and release the UI port', async () => {
            const page = app.windows().find(p => p.url().startsWith(target.ui_origin) && !p.url().startsWith(target.ui_origin + '/pets/'));
            assert.ok(page);
            await page.evaluate(async () => {
                const csrf = await (await fetch('/api/v1/auth/csrf')).json();
                const response = await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf.csrf_token } });
                if (!response.ok)
                    throw Error('Logout failed');
            });
            await until(async () => (await inspect('stats')).pets.length === 0, 'Logged out pet windows remain');
            const state = await inspect('stats');
            assert.ok(state.windows <= 1 && state.senders <= 1);
            await quit();
            assert.equal(await openPort(uiPort), false);
            return { normalExitCode: 0, petWindowsRemoved: true, uiPortReleased: true };
        });
        assert.deepEqual(await hashes(), result.sourceHashes, 'Product source changed during measured acceptance');
        result.status = minutes ? 'P84_WINDOWS_ACTION_SYSTEM_VERIFIED' : fast ? 'P84_INTERACTION_SMOKE_VERIFIED' : 'P84_WINDOWS_ACTION_SMOKE_VERIFIED';
        if (fast)
            result.performanceNotVerified = true;
        result.notVerified = ['other physical displays/DPI/Windows versions', 'low-end hardware', 'real DeepSeek/real upstream cancellation', 'public release'];
    }
    catch (error) {
        result.status = 'P84_WINDOWS_ACTION_FAILED';
        result.failure = String(error.message);
        throw error;
    }
    finally {
        try {
            await quit();
        }
        catch {
            result.electronCleanupFailed = true;
        }
        try {
            await fs.writeFile(path.join(run, 'stop-requested'), 'stop', { flag: 'wx' });
            const exit = await Promise.race([backendExit, delay(15000).then(() => { throw Error('Owned backend did not exit; no force kill'); })]);
            assert.equal(exit.code, 0);
            result.backendExit = exit;
            await log.close();
        }
        catch {
            result.backendCleanupFailed = true;
        }
        result.uiPortReleased = !(await openPort(uiPort));
        result.backendPortReleased = !(await openPort(backendPort));
        result.completedAt = new Date().toISOString();
        await save();
        console.log(JSON.stringify({ status: result.status, run }));
    }
}
main().catch(error => { console.error(String(error.message)); process.exitCode = 1; });
