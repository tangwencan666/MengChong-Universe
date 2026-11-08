'use strict';
// Windows/Electron/API/SQLite are real. The only upstream is the explicit paced Mock.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util'), { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises'), { _electron, expect } = require('@playwright/test');
const desktop = path.resolve(__dirname, '..'), root = path.dirname(desktop), mainFile = path.join(desktop, 'src/main.cjs');
const smoke = process.argv.includes('--smoke'), minutes = Number(process.argv.find(arg => arg.startsWith('--minutes='))?.slice(10) ?? 0);
const eight=process.argv.includes('--eight-role'),selectedSpecies=eight?'whale':'hajimi',petName=eight?'鲸鱼娘':'哈吉米';
const lifecycleOnly=process.argv.includes('--lifecycle-only');
const p86=process.argv.includes('--p86');
assert.ok(!p86||eight&&!lifecycleOnly);
assert.ok(!lifecycleOnly||eight&&minutes===0&&!smoke);
const appearanceDocument=require('../assets/p85-appearances.json');
assert.ok(minutes === 0 || minutes === 30);
assert.ok(!(smoke && minutes));
const env = {};
for (const name of Object.keys(process.env))
    if (!/^(?:WEIBIYE_|DEEPSEEK_|OPENAI_|VITE_|ELECTRON_RUN_AS_NODE$)/i.test(name))
        env[name] = process.env[name];
async function freePort() { const s = net.createServer(); await new Promise((ok, no) => { s.once('error', no); s.listen(0, '127.0.0.1', ok); }); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; }
async function portOpen(port) { return new Promise(ok => { const socket = net.connect(port, '127.0.0.1'), done = value => { socket.destroy(); ok(value); }; socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false)); }); }
async function until(check, message, timeout = 30000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
        if (await check())
            return;
        await delay(100);
    }
    throw Error(message);
}
async function sourceHashes() {
    const names = ['frontend/src/pages/companions.tsx', 'frontend/src/pages/p84-catalog.tsx', 'frontend/src/pages/p85-pets.tsx', 'frontend/src/pages/p85-pets.css', 'frontend/src/features/desktop/bridge.ts', 'backend/app/api/router.py', 'desktop/ui-dist/UI_ASSETS.json', 'desktop/test/fixtures/p85_server.py', 'desktop/test/fixtures/p85-focus-window.ps1','desktop/scripts/prepare-p85-local-assets.ps1','desktop/test/p85-passthrough.ps1'];
    if(p86){names.push('desktop/test/p86-e2e.cjs','desktop/test/p86-social-checks.cjs','desktop/test/fixtures/p86_server.py');for(const name of await fs.readdir(path.join(root,'frontend/src/features/p86')))names.push('frontend/src/features/p86/'+name);}
    for (const folder of ['desktop/src', 'desktop/renderer', 'desktop/assets', 'frontend/src/features/p85', 'backend/app/modules/pet_instances'])
        for (const name of await fs.readdir(path.join(root, folder)))
            if (/\.(?:cjs|js|json|svg|png|ico|css|html|py|ts|tsx)$/.test(name))
                names.push(folder + '/' + name);
    if(eight)for(const name of Object.keys(appearanceDocument.assets))names.push('desktop/local-preview/p85-eight-v1/'+name);
    return Object.fromEntries(await Promise.all(names.map(async (name) => [name, createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')])));
}
async function main() {
    assert.equal(process.platform, 'win32');
    const run = path.join(root, p86?'.verification/p86':'.verification/p85', (p86?'windows-':eight?'eight-windows-':'windows-') + randomUUID());
    await fs.mkdir(run, { recursive: true });
    const uiPort = await freePort(), backendPort = await freePort(), profile = path.join(run, 'profile');
    const result = { status: 'RUNNING', startedAt: new Date().toISOString(), run, smoke, minutes,eightRole:eight,p86,selectedSpecies,realModelRequests: 0, sharedDatabaseAccess: false, ports: { uiPort, backendPort }, checks: [], performance: {}, native: [], pids: [], sourceHashes: await sourceHashes() };
    await fs.copyFile(__filename, path.join(run, 'acceptance-driver.cjs'));
    const save = () => fs.writeFile(path.join(run, 'results.json'), JSON.stringify(result, null, 2));
    await save();
    const backendLog = await fs.open(path.join(run, 'backend.log'), 'wx');
    const backend = spawn(path.join(root, 'backend/.venv/Scripts/python.exe'), ['-B', path.join(__dirname, p86?'fixtures/p86_server.py':'fixtures/p85_server.py'), '--output', run, '--port', String(backendPort), '--ui-port', String(uiPort)], { cwd: path.join(root, 'backend'), env, windowsHide: true, stdio: ['ignore', backendLog.fd, backendLog.fd] });
    result.pids.push(backend.pid);
    const backendExit = new Promise(ok => backend.once('exit', (code, signal) => ok({ code, signal })));
    let app, page, target, hostPid;
    async function inspect(action, data) {
        return app.evaluate(async ({ app: host, BrowserWindow, screen, powerSaveBlocker }, { mainFile, action, data }) => {
            const require = process.getBuiltinModule('module').createRequire(mainFile), manager = require(mainFile).getRuntime();
            if(action==='society')return manager.society?.view(manager.ownerId,Date.now())??null;
            if(action==='society-sync')return manager.socialState(manager.ownerId);
            if(action==='society-trigger'){
                const {triggerForTest}=require('./p86-society.cjs');
                const accepted=triggerForTest(manager.society,data.kind,data.ids,Date.now(),{bypassCooldown:true});
                if(accepted)await manager.tickSociety();return accepted;
            }
            if(action==='society-ready'){
                const actions=require('./pet-actions.cjs');
                for(const r of manager.records.values()){actions.tick(r.actor,Date.now(),{reducedMotion:true,autonomous:false});r.actor.nextRandom=Date.now()+60000;r.actor.nextMove=Date.now()+60000;}
                await manager.tickSociety();return;
            }
            if(action==='trace-start'){
                globalThis.__p85TraceStop?.();
                globalThis.__p85Trace=[];
                const add=value=>{globalThis.__p85Trace.push({at:Date.now(),...value});globalThis.__p85Trace=globalThis.__p85Trace.slice(-512);};
                const fetch=manager.session.fetch.bind(manager.session);
                const trackedFetch=async(url,options)=>{
                    const route=new URL(url).pathname;
                    options?.signal?.addEventListener('abort',()=>add({kind:'abort',route}),{once:true});
                    try{const response=await fetch(url,options);add({kind:'fetch',route,status:response.status});return response;}
                    catch(error){add({kind:'fetch-error',route,error:error.name});throw error;}
                };
                manager.session.fetch=trackedFetch;
                const cookieListener=(_event,cookie,cause,removed)=>{
                    if(['weibiye_session','__Host-weibiye_session'].includes(cookie?.name))add({kind:'auth-cookie-event',cause,removed});
                };
                manager.session.cookies.on('changed',cookieListener);
                const traceWindow=manager.mainWindow,send=traceWindow.webContents.send.bind(traceWindow.webContents);
                traceWindow.webContents.send=(channel,value)=>{
                    if(channel==='weibiye:desktop-state')add({kind:'state',authenticated:value.authenticated,owner:value.owner_id,petCount:value.pets.length});
                    return send(channel,value);
                };
                globalThis.__p85TraceStop=()=>{manager.session.fetch=fetch;manager.session.cookies.removeListener('changed',cookieListener);if(!traceWindow.isDestroyed())traceWindow.webContents.send=send;};
                return;
            }
            if(action==='trace-stop'){globalThis.__p85TraceStop?.();globalThis.__p85TraceStop=null;const saved=globalThis.__p85Trace??[];globalThis.__p85Trace=[];return saved;}
            if(action==='trace-read')return {trace:globalThis.__p85Trace??[],state:{owner:manager.ownerId,windows:BrowserWindow.getAllWindows().length,petCount:manager.records.size}};
            if (action === 'stats'){
                const liveWindows=BrowserWindow.getAllWindows().flatMap(w=>{try{const contents=w.webContents;if(w.isDestroyed()||!contents||contents.isDestroyed())return [];return [{id:w.id,visible:w.isVisible(),role:w===manager.mainWindow?'main':[...manager.records.values()].some(r=>r.window===w)?'pet':[...manager.records.values()].some(r=>r.chatWindow===w)?'chat':'other',route:new URL(contents.getURL()||'about:blank').pathname,rendererPid:contents.getOSProcessId()}];}catch{return [];}});
                return { owner: manager.ownerId, windows: liveWindows.length, senders: manager.senderCount, layout: manager.layoutState(), actions: { ...manager.actionStats }, cache: manager.assetStats.petCache,localCache:manager.assetStats.localCache,society:{pending:manager.societyPending,stats:{...manager.societyStats},revision:manager.society?.view(manager.ownerId,Date.now()).revision??null},
                    windowEvents:globalThis.__p85WindowEvents??[],
                    windowDetails:liveWindows,
                    displays: screen.getAllDisplays().map(d => ({ id: d.id, scaleFactor: d.scaleFactor, workArea: d.workArea })),
                    pets: [...manager.records.values()].map(r => ({ id: r.identity.pet_id, name: r.identity.name, species: r.actor.definition, action: r.actor.action, priority:r.actor.priority, sequence: r.actor.sequence, bounds: r.window.getBounds(), hidden: r.hidden, windowId: r.window.id,
                        rendererPid: r.window.webContents.getOSProcessId(), chatRendererPid: r.chatWindow?.webContents?.getOSProcessId() ?? null, chatId: r.chatWindow?.id ?? null, chatURL: r.chatWindow?.webContents?.getURL() ?? null, handle: r.window.getNativeWindowHandle().readBigUInt64LE().toString() })) };}
            if (action === 'metrics')
                return manager.measureResources();
            if (action === 'release')
                return manager.release(data);
            if (action === 'chat')
                return manager.openChat(data);
            if (action === 'hide')
                return manager.hide(data);
            if (action === 'show')
                return manager.show(data);
            if (action === 'configure')
                return manager.configurePet(data.id, data.preferences);
            if (action === 'play')
                return manager.playAction(data.id, data.action);
            if (action === 'recall-all')
                return manager.recallAll();
            if (action === 'restore')
                return manager.restoreCombination();
            if (action === 'close-chat') {
                const win = manager.records.get(data)?.chatWindow;
                if (win) {
                    const ended = new Promise(ok => win.once('closed', ok));
                    win.close();
                    await ended;
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
            if (action === 'quit') {
                manager.trayMenu.getMenuItemById('quit').click();
                return;
            }
            if (action === 'pulse') {
                const actions = require('./pet-actions.cjs');
                let i = 0;
                for (const r of manager.records.values())
                    actions.start(r.actor, i++ % 2 ? 'roll' : 'jump', Date.now(), { direct: true });
                return;
            }
            if (action === 'menu') {
                const menu = manager.lastContextMenu, items = menu.items.map(item => ({ id: item.id, label: item.label, type: item.type }));
                menu.closePopup();
                return items;
            }
            if (action === 'background') {
                globalThis.__p85WindowEvents=[];
                const add=value=>{globalThis.__p85WindowEvents.push({at:Date.now(),...value});globalThis.__p85WindowEvents=globalThis.__p85WindowEvents.slice(-64);};
                const quiet = win => {
                    const windowId=win.id;
                    win.show = () => win.showInactive(); win.focus = () => { };
                    win.once('closed',()=>add({kind:'closed',id:windowId}));
                    win.webContents.on('before-mouse-event',(_event,mouse)=>{
                        if(['mouseDown','mouseUp'].includes(mouse.type)&&new URL(win.webContents.getURL()||'about:blank').pathname==='/__pet/pet.html')add({kind:'pet-mouse',id:windowId,type:mouse.type,button:mouse.button});
                    });
                };
                BrowserWindow.getAllWindows().forEach(quiet);
                host.on('browser-window-created', (_e, win) => {add({kind:'created',id:win.id,stack:new Error().stack});quiet(win);});
                globalThis.__p85Blocker = powerSaveBlocker.start('prevent-app-suspension');
                return;
            }
            if (action === 'stop-blocker') {
                if (globalThis.__p85Blocker !== undefined)
                    powerSaveBlocker.stop(globalThis.__p85Blocker);
                return;
            }
            throw Error('Unknown inspection action');
        }, { mainFile, action, data });
    }
    async function check(name, work) {
        try {
            const detail = await work();
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
    async function native(file, args) { const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, file), ...args], { env, windowsHide: true, timeout: 20000 }); const data = JSON.parse(stdout.trim()); result.native.push(data); return data; }
    async function login(account) {
        await page.goto(target.ui_origin + '/login');
        await page.getByLabel('邮箱', { exact: true }).fill(account.email);
        await page.getByLabel('密码', { exact: true }).fill(account.password);
        const signed = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/v1/auth/login'));
        await page.getByRole('button', { name: '登录', exact: true }).click();
        assert.equal((await signed).status(), 200);
        await until(async () => (await inspect('stats')).owner === account.owner_id, 'Owner synchronization failed');
        await page.goto(target.ui_origin + '/companions');
        await expect(page.getByRole('heading', { name: '我的宠物', exact: true })).toBeVisible();
    }
    async function launch() { app = await _electron.launch({ args: [desktop, '--profile-dir', profile, '--ui-port', String(uiPort), '--backend-origin', target.backend_origin,'--local-diagnostics'], env, timeout: 45000 }); result.pids.push(app.process().pid); hostPid = await app.evaluate(() => process.pid); page = await app.firstWindow(); await page.waitForURL(target.ui_origin + '/companions'); await login(target.accounts[0]); if(eight)await inspect('trace-start'); }
    async function quit() {
        if (!app)
            return;
        const child = app.process();
        await inspect('stop-blocker');
        await inspect('quit');
        await until(() => Promise.resolve(child.exitCode !== null), 'Normal Electron exit timeout', 15000);
        assert.equal(child.exitCode, 0);
        app = null;
    }
    async function api(method, route, body, caller = page) {
        return caller.evaluate(async ({ method, route, body }) => {
            let headers = {};
            if (method !== 'GET') {
                const csrf = await (await fetch('/api/v1/auth/csrf')).json();
                headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token, 'Idempotency-Key': crypto.randomUUID() };
            }
            const response = await fetch('/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: response.status, data: response.status === 204 ? null : await response.json() };
        }, { method, route, body });
    }
    async function awaitCompleted(route) {
        const end = performance.now() + 45000;
        while (performance.now() < end) {
            const response = await api('GET', route);
            assert.equal(response.status, 200, 'Generation read refused: ' + response.status);
            assert.ok(response.data.generation, 'Missing scoped generation response');
            if (response.data.generation.state === 'completed')
                return;
            assert.ok(!['failed', 'cancelled'].includes(response.data.generation.state), 'Unexpected terminal generation state');
            await delay(1500);
        }
        throw Error('Local Mock did not complete before deadline');
    }
    async function petPage(id) {
        const record = (await inspect('stats')).pets.find(p => p.id === id);
        for (const candidate of app.windows()) {
            const win = await app.browserWindow(candidate);
            if (await win.evaluate(w => w.id) === record.windowId)
                return candidate;
        }
        throw Error('Pet renderer missing');
    }
    async function chatPage(id) {
        await inspect('chat', id);
        await until(() => Promise.resolve(app.windows().some(p => p.url().startsWith(target.ui_origin + '/pets/' + id))), 'Chat window missing');
        const chat = app.windows().find(p => p.url().startsWith(target.ui_origin + '/pets/' + id));
        await chat.waitForLoadState('load');
        await expect(chat.locator('#composer-disclosure')).toBeVisible();
        return chat;
    }
    async function quiet(ids) {
        for (const id of ids)
            await inspect('configure', { id, preferences: { random: false, autoMove: false } });
        await delay(smoke ? 100 : 6500);
    }
    function petCard(id) { return page.locator('.pet-card').filter({ has: page.locator(`a[href="/pets/${id}"]`) }); }
    async function releaseUI(id) { const card = petCard(id); await card.getByRole('button', { name: '召唤到桌面', exact: true }).click(); await until(async () => (await inspect('stats')).pets.some(p => p.id === id), 'Instance summon failed'); }
    async function measure(label, duration = 21000) {
        if (smoke)
            return { label, notMeasured: true };
        const start = performance.now(), wall = Date.now(), samples = [], seen = new Set();
        while (performance.now() - start < duration) {
            await delay(1000);
            for (const s of await inspect('metrics'))
                if (s.at >= wall && s.elapsedMs > 0 && !seen.has(s.sequence)) {
                    seen.add(s.sequence);
                    samples.push(s);
                }
        }
        assert.ok(samples.length >= 3, 'Insufficient independent metrics intervals');
        const totals = samples.map(s => ({ elapsedMs: s.elapsedMs, cpu: s.metrics.reduce((n, p) => n + p.cpu.percentCPUUsage, 0), workingSetKiB: s.metrics.reduce((n, p) => n + p.memory.workingSetSize, 0), privateKiB: s.privateKiB }));
        const result = { label, elapsedMs: performance.now() - start, sampleCount: samples.length, averageCpu: totals.reduce((n, s) => n + s.cpu * s.elapsedMs, 0) / totals.reduce((n, s) => n + s.elapsedMs, 0), peakWorkingSetKiB: Math.max(...totals.map(s => s.workingSetKiB)), peakPrivateKiB: Math.max(...totals.map(s => s.privateKiB)), samples };
        assert.ok(result.peakPrivateKiB < 1024 * 1024 && result.peakWorkingSetKiB < 1800 * 1024);
        return result;
    }
    try {
        await until(async () => {
            if (backend.exitCode !== null)
                throw Error('P85 Mock backend exited');
            try {
                const r = await fetch(`http://127.0.0.1:${backendPort}/__p85_fixture/ready`);
                return r.ok && (await r.json()).schema_ready;
            }
            catch {
                return false;
            }
        }, 'Fresh P85 fixture not ready', 60000);
        target = JSON.parse(await fs.readFile(path.join(run, 'target.json'), 'utf8'));
        assert.equal(target.fixture, 'p85-sqlite-mock-only/1');
        assert.equal(target.real_model_requests, 0);
        await launch();
        const allStock=target.accounts[0].pets;
        const stock=eight?[...allStock.slice(5),...allStock.slice(3,5),...allStock.slice(0,3)]:allStock,ids=[];
        await check('real UI repeats adoption of five same-name '+selectedSpecies+' with distinct UUIDs and operation keys', async () => {
            const keys = [];
            await page.getByRole('button', { name: '自定义领养名字', exact: true }).click();
            await page.getByLabel(`给${petName}取名`, { exact: true }).fill(`同名${petName}`);
            for (let i = 0; i < 5; i++) {
                const pending = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/v1/pet-instances'));
                await page.getByRole('button', { name: `领养${petName}`, exact: true }).click();
                const response = await pending, pet = await response.json();
                assert.equal(response.status(), 201);
                assert.equal(pet.species_id, selectedSpecies);
                assert.equal(pet.owner_user_id, target.accounts[0].owner_id);
                assert.equal(pet.name, `同名${petName}`);
                assert.equal(pet.pet_id, pet.pet_instance_id);
                ids.push(pet.pet_id);
                keys.push(response.request().headers()['idempotency-key']);
                await expect(page.getByRole('button', { name: `领养${petName}`, exact: true })).toBeEnabled();
            }
            await page.getByLabel(`给${petName}取名`, { exact: true }).fill('');
            await page.getByRole('button', { name: '清空取名并收起', exact: true }).click();
            await expect(page.getByLabel(`给${petName}取名`, { exact: true })).toHaveCount(0);
            assert.equal(new Set(ids).size, 5);
            assert.equal(new Set(keys).size, 5);
            const list = await api('GET', '/pet-instances');
            assert.equal(list.status, 200);
            assert.equal(list.data.items.length, allStock.length+5);
            return { instances: ids, uniqueOperationKeys: 5, ownedInstances: allStock.length+5, visibleLimit: 5 };
        });
        if(lifecycleOnly){
            await check('native close/reopen and repeated open reuse five-instance chat windows',async()=>{
                for(const id of ids)await releaseUI(id);
                await quiet(ids);await inspect('background');
                await chatPage(ids[0]);await chatPage(ids[1]);
                console.log('PACE lifecycle setup complete');await delay(65000);
                const states=[];
                for(let cycle=0;cycle<6;cycle++){
                    const id=ids[cycle%ids.length],chat=ids[cycle%2];
                    await inspect('hide',id);await inspect('show',id);
                    await inspect('close-chat',chat);await chatPage(chat);await chatPage(chat);
                    const state=await inspect('stats');states.push(state);result.lifecycleStates=states;await save();
                    assert.equal(state.windows,8,JSON.stringify(state.windowDetails));assert.equal(state.senders,8);
                    await delay(15000);
                }
                await inspect('stop-blocker');return {cycles:states.length,maxWindows:Math.max(...states.map(s=>s.windows))};
            });
            result.status='P85_EIGHT_LIFECYCLE_VERIFIED';return;
        }
        for (const [count, additions] of [[1, [0]], [3, [1, 2]], [5, [3, 4]]])
            await check(`mixed ${count} pets use independent bounded real desktop windows`, async () => {
                for (const index of additions)
                    await releaseUI(stock[index].pet_id);
                if (count >= 3) {
                    await chatPage(stock[0].pet_id);
                    await chatPage(stock[1].pet_id);
                }
                await quiet(stock.slice(0, count).map(p => p.pet_id));
                const state = await inspect('stats');
                assert.equal(state.pets.length, count);
                assert.equal(new Set(state.pets.map(p => p.rendererPid)).size, count);
                result.performance['mixed' + count] = await measure('mixed ' + count + ', ' + (count >= 3 ? 2 : 0) + ' chats');
                return { count, windows: state.windows, display: state.displays };
            });
        if(eight)await check('eight original species rotate real desktop windows; source views, overlays and PNG lifetime stay bounded',async()=>{
            await inspect('trace-start');
            await inspect('recall-all');
            if(smoke){console.log('PACE before eight-role resource cycle');await delay(65000);}
            const views=[];
            for(const pet of stock){
                await releaseUI(pet.pet_id);
                await inspect('configure',{id:pet.pet_id,preferences:{random:false,autoMove:false}});
                const state=await inspect('stats');assert.equal(state.pets.length,1);
                await native('p85-passthrough.ps1',['-WindowHandle',state.pets[0].handle,'-ExpectedProcessId',String(hostPid)]);
                const species=state.pets[0].species,a=appearanceDocument.appearances.find(a=>a.species_id===species),sprite=await petPage(pet.pet_id);
                await until(()=>sprite.locator('#pet-art').evaluate(img=>img.complete&&img.naturalWidth>0),'Original role image did not decode');
                if(a.kind==='local-raster'){
                    await expect(sprite.locator('#pet-art')).toHaveAttribute('src','/__assets/'+a.front_asset);
                    assert.equal(await sprite.locator('#pet-art').evaluate(img=>img.naturalWidth),256);
                    await sprite.screenshot({path:path.join(run,'actual-'+species+'-front.png')});
                    const preview=page.getByAltText(pet.name+'外观预览',{exact:true});await preview.scrollIntoViewIfNeeded();
                    await expect(preview).toHaveAttribute('src','/__assets/'+a.front_asset);
                    await until(()=>preview.evaluate(img=>img.complete&&img.naturalWidth===256),'Local catalog thumbnail did not decode');
                    const choices=species==='niwa'?['look','turn','sway','jump','sleep','wake']:species==='daodun'?['look','turn','guard','patrol','jump','sleep','wake']:['look','turn','wave','sway','jump','sleep','wake'];
                    for(const action of choices){
                        await delay(750);assert.equal(await inspect('play',{id:pet.pet_id,action}),true);
                        const desired=action==='look'?'side':action==='turn'?'back':'front';
                        if(['look','turn'].includes(action)){
                            const expected=a[desired+'_asset']??a.front_asset;
                            await expect(sprite.locator('#pet-art')).toHaveAttribute('src','/__assets/'+expected);
                            if(!a[desired+'_asset'])await expect(sprite.locator('body')).toHaveAttribute('data-view-fallback','occluded-reference');
                            views.push({species,action,requested:desired,actual:a[desired+'_asset']?desired:'front',occludedReference:!a[desired+'_asset']});
                        }
                    }
                }else await expect(sprite.locator('#pet-art')).toHaveAttribute('src',/\.svg$/);
                await page.locator('.pet-card').filter({has:page.locator(`a[href="/pets/${pet.pet_id}"]`)}).getByRole('button',{name:'收回桌宠',exact:true}).click();
                await until(async()=>(await inspect('stats')).pets.length===0,'Recalled role renderer retained');
            }
            const state=await inspect('stats');assert.equal(state.windows,1);assert.equal(state.actions.recoveries,0);
            assert.ok(state.localCache.available&&state.localCache.bytes<=state.localCache.budget&&state.localCache.rejected===0);
            console.log('PACE eight-role action cycle finished; preserve the existing read limit');await delay(65000);
            await page.getByRole('button',{name:'恢复上次桌面组合',exact:true}).click();
            await until(async()=>(await inspect('stats')).pets.length===5,'Mixed combination did not restore after rotation');
            result.rotationStateTrace=await inspect('trace-stop');
            return {speciesCount:stock.length,views,localCache:state.localCache,normalPetWindowsAfterRecall:0,mirroredEquipment:false,realModelRequests:0};
        });
        await check('double confirmation cancels safely, archives one instance and keeps chat/memory lifecycle explicit', async () => {
            await page.getByRole('button', { name: '一键收回全部', exact: true }).click();
            await until(async () => (await inspect('stats')).pets.length === 0, 'Recall all did not close windows');
            const pet = stock[1], card = petCard(pet.pet_id);
            await card.getByRole('button', { name: '删除宠物', exact: true }).click();
            let dialog = page.getByRole('dialog', { name: '删除前请确认数据处理' });
            await expect(dialog).toContainText('聊天记录');
            await expect(dialog).toContainText('长期记忆');
            await dialog.getByRole('button', { name: '取消，保留宠物', exact: true }).click();
            assert.equal((await api('GET', '/pet-instances/' + pet.pet_id)).data.status, 'active');
            await card.getByRole('button', { name: '删除宠物', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: '继续确认删除', exact: true }).click();
            dialog = page.getByRole('dialog', { name: '再次确认删除此实例' });
            await expect(dialog.getByRole('button', { name: '确认删除并归档', exact: true })).toBeDisabled();
            await dialog.getByRole('checkbox').check();
            const pending = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith('/pet-instances/' + pet.pet_id));
            await dialog.getByRole('button', { name: '确认删除并归档', exact: true }).click();
            const response = await pending;
            assert.equal(response.status(), 200);
            assert.equal((await response.json()).lifecycle.can_undo_archive, false);
            await expect(page.getByRole('dialog')).not.toBeVisible();
            await expect(page.getByRole('button', { name: '恢复上次桌面组合', exact: true })).toBeEnabled();
            await page.getByRole('button', { name: '恢复上次桌面组合', exact: true }).click();
            await until(async () => (await inspect('stats')).pets.length === 4, 'Valid combination siblings did not restore');
            const state = await inspect('stats');
            assert.equal(state.layout.skipped_count, 1);
            assert.ok(!state.pets.some(p => p.id === pet.pet_id));
            await inspect('recall-all');
            return { cancelKeptActive: true, doubleConfirmation: true, archivedId: pet.pet_id, validSiblingsRestored: 4, skippedArchived: 1, hardErase: false };
        });
        await check('five same-species instances reuse one asset family; sixth summon is denied without losing ownership', async () => {
            for (const id of ids)
                await releaseUI(id);
            await quiet(ids);
            const state = await inspect('stats');
            assert.equal(state.pets.length, 5);
            assert.ok(state.pets.every(p => p.species === selectedSpecies));
            assert.equal(new Set(state.pets.map(p => p.windowId)).size, 5);
            await assert.rejects(inspect('release', stock[0].pet_id));
            assert.equal((await inspect('stats')).pets.length, 5);
            assert.equal((await api('GET', '/pet-instances/' + stock[0].pet_id)).status, 200);
            result.performance.same5 = await measure('5 '+selectedSpecies+', 0 chats');
            return { distinctWindows: 5, ownedMoreThanFive: true, cache: state.cache };
        });
        await check('renaming an active instance updates only its native label, identity and independent persona', async () => {
            const card = petCard(ids[0]);
            await card.getByRole('button', { name: '重命名与人格', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: '重命名与独立人格' });
            await dialog.getByLabel('宠物名字', { exact: true }).fill('小'+petName+'一号');
            await dialog.getByLabel('人格说明', { exact: true }).fill('安静陪伴，只属于这个实例。');
            await dialog.getByRole('button', { name: '保存名字与人格', exact: true }).click();
            await expect(dialog).not.toBeVisible();
            await until(async () => (await inspect('stats')).pets.find(p => p.id === ids[0])?.name === '小'+petName+'一号', 'Native rename did not refresh');
            const state = await inspect('stats');
            assert.ok(state.pets.filter(p => p.id !== ids[0]).every(p => p.name === `同名${petName}`));
            const value = (await api('GET', '/pet-instances/' + ids[0])).data;
            assert.equal(value.pet_instance_id, ids[0]);
            assert.equal(value.species_id, selectedSpecies);
            await card.getByRole('button', { name: '基本资料', exact: true }).click();
            const details = page.getByRole('dialog', { name: '宠物实例资料' });
            await expect(details).toContainText(ids[0]);
            await expect(details).toContainText(selectedSpecies);
            await details.getByRole('button', { name: '关闭弹窗' }).click();
            await page.screenshot({ path: path.join(run, 'actual-pet-management.png') });
            return { id: ids[0], name: '小'+petName+'一号', unchangedSiblings: 4 };
        });
        // Subsequent checks are below; all raw evidence remains in this fresh directory.
        await finishChecks({ stock, ids });
        assert.equal(result.checks.length, (minutes ? 15 : 14)+(eight?1:0)+(p86?5:0));
        assert.ok(result.checks.every(c => c.status === 'passed'));
        assert.deepEqual(await sourceHashes(), result.sourceHashes, 'Product sources changed during native acceptance');
        result.status = p86?(minutes?'P86_WINDOWS_VERIFIED':'P86_WINDOWS_SMOKE_VERIFIED'):eight?(minutes?'P85_EIGHT_WINDOWS_VERIFIED':smoke?'P85_EIGHT_SMOKE_VERIFIED':'P85_EIGHT_SHORT_VERIFIED'):minutes ? 'P85_WINDOWS_MULTI_INSTANCE_VERIFIED' : smoke ? 'P85_WINDOWS_INTERACTION_SMOKE_VERIFIED' : 'P85_WINDOWS_MULTI_INSTANCE_SHORT_VERIFIED';
    }
    catch (error) {
        if(app&&eight)result.failureHostTrace=await inspect('trace-read').catch(()=>null);
        if (page && !page.isClosed())
            await page.screenshot({ path: path.join(run, 'failure-page.png'), timeout: 3000 }).catch(() => { });
        result.status = p86?'P86_WINDOWS_FAILED':eight?'P85_EIGHT_WINDOWS_FAILED':'P85_WINDOWS_MULTI_INSTANCE_FAILED';
        result.failureStack = String(error.stack);
        result.failure = String(error.message);
        throw error;
    }
    finally {
        if (await fs.access(path.join(run, 'hold-stream')).then(() => true, () => false))
            await fs.writeFile(path.join(run, 'release-stream'), 'release during cleanup', { flag: 'wx' }).catch(error => {
                if (error.code !== 'EEXIST')
                    throw error;
            });
        try {
            await quit();
        }
        catch {
            result.electronCleanupFailed = true;
        }
        await fs.writeFile(path.join(run, 'stop-requested'), 'stop');
        let timer;
        try {
            const exit = await Promise.race([backendExit, new Promise((_ok, no) => { timer = setTimeout(() => no(Error('Backend normal exit timeout')), 15000); })]);
            assert.equal(exit.code, 0);
            result.backendExit = exit;
            await backendLog.close();
        }
        catch {
            result.backendCleanupFailed = true;
        }
        finally {
            clearTimeout(timer);
        }
        result.uiPortReleased = !(await portOpen(uiPort));
        result.backendPortReleased = !(await portOpen(backendPort));
        result.completedAt = new Date().toISOString();
        if (result.electronCleanupFailed || result.backendCleanupFailed || !result.uiPortReleased || !result.backendPortReleased) {
            result.status = 'P85_WINDOWS_CLEANUP_BLOCKED';
            process.exitCode = 1;
        }
        await save();
        console.log(JSON.stringify({ status: result.status, run }));
    }
    async function finishChecks({ ids }) {
        if (smoke || eight) {
            console.log('PACE setup bursts completed; allow the existing per-user read window to reset');
            await delay(65000);
        }
        if(eight)await inspect('trace-start');
        const consent = { confirmed: true, policy_version: 'memory-policy/1', notice_version: 'memory-notice/1' }, memoryIds = [];
        await check('same-species memory and session URLs stay separate through real authenticated local APIs', async () => {
            for (const [index, id] of ids.slice(0, 2).entries()) {
                const prefs = await api('GET', `/pets/${id}/memory/preferences`);
                assert.equal(prefs.status, 200);
                const enabled = await api('PATCH', `/pets/${id}/memory/preferences`, { long_term_memory_enabled: true, expected_version: prefs.data.version, consent });
                assert.equal(enabled.status, 200);
                const created = await api('POST', `/pets/${id}/memory/items`, { title: 'P85合成测试偏好', content: `此记录只属于本地哈吉米实例${index + 1}，喜欢简短自然的交流。`, category: 'communication_preference', source: { kind: 'manual' }, expected_preferences_version: enabled.data.version, consent });
                assert.equal(created.status, 201);
                memoryIds.push(created.data.item.id);
            }
            for (const [index, id] of ids.slice(0, 2).entries()) {
                const rows = await api('GET', `/pets/${id}/memory/items`);
                assert.deepEqual(rows.data.items.map(r => r.id), [memoryIds[index]]);
                assert.equal((await api('GET', `/pets/${id}/memory/items/${memoryIds[1 - index]}`)).status, 404);
            }
            return { petIds: ids.slice(0, 2), memoryIds, crossPetReadStatus: 404, syntheticDataOnly: true };
        });
        await check('real Windows drag/click during Mock SSE and recall during a held Mock generation keep independent state', async () => {
            const chat = await chatPage(ids[0]), sprite = await petPage(ids[0]);
            await expect(chat.locator('#composer-disclosure')).toContainText('本地 Mock');
            await sprite.evaluate(() => { window.p85Frames = []; window.p85Unsubscribe = window.weibiyePet.onState(value => window.p85Frames.push({ action: value.action, activity: value.activity })); });
            await chat.getByLabel('聊天消息', { exact: true }).fill('P85第一只独立哈吉米的合成消息');
            const accepted = chat.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/messages'));
            await chat.getByRole('button', { name: '发送消息', exact: true }).click();
            const first = await (await accepted).json();
            assert.equal(first.generation.provider, 'mock');
            await until(async () => (await inspect('stats')).pets.find(p => p.id === ids[0])?.action === 'speaking', 'Mock delta did not drive the matching pet');
            const record = (await inspect('stats')).pets.find(p => p.id === ids[0]);
            await native('native-interaction.ps1', ['-WindowHandle', record.handle, '-ExpectedProcessId', String(hostPid), '-Action', 'drag', '-DeltaY', '-210', '-HitTestTimeoutMs', '1000']);
            const after = (await inspect('stats')).pets.find(p => p.id === ids[0]);
            assert.ok(Math.abs(record.bounds.y - after.bounds.y) > 100);
            assert.ok(Math.abs(after.bounds.width - 188) <= 1);
            const sessionId = first.generation.session_id ?? first.session?.id ?? new URL(chat.url()).pathname.split('/').at(-1);
            const generationPath = `/pets/${ids[0]}/sessions/${sessionId}/generations/${first.generation.id}`;
            await awaitCompleted(generationPath);
            const frames = await sprite.evaluate(() => window.p85Frames);
            assert.ok(frames.some(f => f.action === 'thinking'));
            assert.ok(frames.some(f => f.action === 'speaking'));
            await sprite.evaluate(() => window.p85Unsubscribe());
            const second = (await inspect('stats')).pets.find(p => p.id === ids[1]);
            await native('native-interaction.ps1', ['-WindowHandle', second.handle, '-ExpectedProcessId', String(hostPid), '-Action', 'click', '-HitTestTimeoutMs', '1000']);
            await until(async () => (await inspect('stats')).pets.find(p => p.id === ids[1])?.chatURL?.startsWith(target.ui_origin + '/pets/' + ids[1]), 'Click opened the wrong same-species chat');
            await native('native-interaction.ps1', ['-WindowHandle', second.handle, '-ExpectedProcessId', String(hostPid), '-Action', 'context', '-HitTestTimeoutMs', '1000']);
            const menu = await inspect('menu');
            assert.ok(menu.some(item => item.id === 'random'));
            assert.ok(menu.some(item => item.id === 'auto-move'));
            await fs.writeFile(path.join(run, 'hold-stream'), 'hold local Mock after its first delta', { flag: 'wx' });
            await chat.getByLabel('聊天消息', { exact: true }).fill('P85收回窗口不删除已保存对话');
            const next = chat.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/messages'));
            await chat.getByRole('button', { name: '发送消息', exact: true }).click();
            const turn = await (await next).json();
            assert.equal(turn.generation.provider, 'mock');
            await until(() => fs.access(path.join(run, 'stream-paused')).then(() => true, () => false), 'Owned deterministic Mock gate not reached');
            await inspect('pulse');
            const concurrent = await inspect('stats');
            assert.equal(concurrent.pets.length, 5);
            assert.ok(concurrent.pets.filter(p => ['jump', 'roll', 'speaking', 'thinking'].includes(p.action)).length >= 4);
            await page.getByRole('button', { name: '一键收回全部', exact: true }).click();
            await until(async () => (await inspect('stats')).pets.length === 0, 'Recall during generation did not close windows');
            const heldPath = `/pets/${ids[0]}/sessions/${sessionId}/generations/${turn.generation.id}`;
            const held = await api('GET', heldPath);
            assert.equal(held.status, 200, 'Held generation read refused: ' + held.status);
            assert.equal(held.data.generation.state, 'running');
            await fs.writeFile(path.join(run, 'release-stream'), 'resume the local Mock only', { flag: 'wx' });
            await awaitCompleted(heldPath);
            await page.getByRole('button', { name: '恢复上次桌面组合', exact: true }).click();
            await until(async () => (await inspect('stats')).pets.length === 5, 'Same-species combination did not restore');
            const reopened = await chatPage(ids[0]);
            await reopened.goto(target.ui_origin + `/pets/${ids[0]}/chat/${sessionId}`);
            await reopened.reload();
            await expect(reopened.getByRole('log')).toContainText('P85收回窗口不删除已保存对话');
            const counts = await Promise.all(ids.map(async (id) => (await api('GET', `/pets/${id}/sessions`)).data.items.length));
            assert.deepEqual(counts, [1, 0, 0, 0, 0]);
            for (const id of ids.slice(1))
                assert.equal((await api('GET', `/pets/${id}/sessions/${sessionId}`)).status, 404);
            await (await petPage(ids[0])).screenshot({ path: path.join(run, 'actual-renamed-'+selectedSpecies+'.png') });
            return { physicalDrag: true, physicalClick: true, physicalContextMenu: true, frames, sessionId, sessionCounts: counts, recallWhileMockRunning: true, completedAfterRecall: true, realModelRequests: 0, gate: 'explicit synthetic Mock only, no upstream cancellation claim' };
        });
        await check('five simultaneous finite animations remain independent with bounded cached resources', async () => {
            if(eight){console.log('PACE after authenticated chat and isolation checks');await delay(65000);}
            await chatPage(ids[0]);
            await chatPage(ids[1]);
            await quiet(ids);
            let max = 0;
            const animation = (async () => {
                for (let i = 0; i < (smoke ? 1 : 9); i++) {
                    await inspect('pulse');
                    await delay(100);
                    max = Math.max(max, (await inspect('stats')).pets.filter(p => ['jump', 'roll'].includes(p.action)).length);
                    await delay(2400);
                }
            })();
            const outcomes = await Promise.allSettled([measure('five same-species simultaneous animations / 2 chats'), animation]);
            for (const outcome of outcomes)
                if (outcome.status === 'rejected')
                    throw outcome.reason;
            assert.equal(max, 5);
            result.performance.animations = outcomes[0].value;
            const state = await inspect('stats');
            assert.ok(state.cache.bytes <= state.cache.budget);
            assert.equal(state.actions.recoveries, 0);
            return { simultaneous: max, cache: state.cache };
        });
        await check('hidden sprites unload images, chat windows close and a draft-free dashboard parks', async () => {
            await expect(page.locator('input,textarea,form,[contenteditable=true],[role=dialog],[aria-modal=true]')).toHaveCount(0);
            for (const id of ids) {
                await inspect('hide', id);
                await inspect('close-chat', id);
            }
            await inspect('hide-main');
            await delay(smoke ? 1200 : 70000);
            for (const id of ids)
                assert.equal(await (await petPage(id)).locator('#pet-art').getAttribute('src'), null);
            result.performance.hidden = await measure('five hidden '+selectedSpecies+', no chats or active dashboard');
            const state = await inspect('stats');
            assert.equal(state.windows, smoke ? 6 : 5);
            for (const id of ids)
                await inspect('show', id);
            await inspect('show-main');
            await until(() => { page = app.windows().find(p => p.url() === target.ui_origin + '/companions'); return Promise.resolve(Boolean(page)); }, 'Dashboard did not restore');
            return { imagesReleased: 5, windows: state.windows, dashboardParkingMeasured: !smoke };
        });
        await check('restart automatically restores authenticated same-species selection, hidden flags and native positions', async () => {
            const before = await inspect('stats');
            await inspect('hide', ids[3]);
            await quit();
            assert.equal(await portOpen(uiPort), false);
            await launch();
            await until(async () => (await inspect('stats')).pets.length === 5, 'Combination did not restore automatically after login');
            const after = await inspect('stats');
            assert.deepEqual(after.pets.map(p => p.id).sort(), [...ids].sort());
            assert.equal(after.pets.find(p => p.id === ids[3]).hidden, true);
            for (const current of after.pets) {
                const prior = before.pets.find(p => p.id === current.id);
                assert.ok(Math.abs(current.bounds.x - prior.bounds.x) <= 1 && Math.abs(current.bounds.y - prior.bounds.y) <= 1);
                assert.ok(!['thinking', 'speaking', 'dragging'].includes(current.action));
            }
            assert.ok(after.pets.every(p => p.chatId === null));
            await inspect('show', ids[3]);
            await quiet(ids);
            return { restoredIds: ids, nativePositionsRestored: true, hiddenInstanceRestored: ids[3], privateChatsNotAutoOpened: true };
        });
        await check('ordinary native background activity does not steal an independent foreground window', async () => {
            const directory = path.join(run, 'focus-probe');
            await fs.mkdir(directory);
            const log = await fs.open(path.join(directory, 'helper.log'), 'wx');
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'fixtures/p85-focus-window.ps1'), '-EvidenceDirectory', directory], { env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
            const exit = new Promise(ok => child.once('exit', code => ok(code)));
            let timer;
            try {
                await until(async () => {
                    if (child.exitCode !== null)
                        throw Error('Owned focus probe exited');
                    return fs.access(path.join(directory, 'focus-window.json')).then(() => true, () => false);
                }, 'Focus probe not ready');
                const target = JSON.parse((await fs.readFile(path.join(directory, 'focus-window.json'), 'utf8')).replace(/^\uFEFF/, ''));
                await native('native-interaction.ps1', ['-WindowHandle', target.handle, '-ExpectedProcessId', String(target.pid), '-Action', 'click', '-OffsetX', '180', '-OffsetY', '140', '-HitTestTimeoutMs', '2000']);
                await fs.writeFile(path.join(directory,'release-topmost'),'release owned probe topmost',{flag:'wx'});
                await until(()=>fs.access(path.join(directory,'topmost-released')).then(()=>true,()=>false),'Owned probe did not restore ordinary window level');
                const pet = (await inspect('stats')).pets[0], observation = await native('p82-focus-observe.ps1', ['-WindowHandle', pet.handle, '-ExpectedProcessId', String(hostPid)]);
                assert.equal(observation.baselineIsOtherProcess, true);
                assert.equal(observation.stable, true);
                return observation;
            }
            finally {
                await fs.writeFile(path.join(directory, 'stop-focus'), 'stop', { flag: 'wx' });
                try {
                    const code = await Promise.race([exit, new Promise((_ok, no) => { timer = setTimeout(() => no(Error('Focus probe did not exit normally')), 10000); })]);
                    assert.equal(code, 0);
                }
                finally {
                    clearTimeout(timer);
                    await log.close();
                }
            }
        });
        if(p86)await require('./p86-social-checks.cjs')({check,inspect,until,native,petPage,quiet,quit,launch,page:()=>page,target,ids,run,result,save,delay,host:()=>hostPid});
        if(eight)result.postRotationStateTrace=await inspect('trace-stop');
        if (minutes)
            await check('thirty-minute five-same-species stability bounds windows, memory growth, motion and lifecycle reuse', async () => {
                result.soakInstrumentation = { localMockOnly: true, focusSuppressedDuringSoak: true, showInactiveInsteadOfShow: true, powerBlocker: 'prevent-app-suspension; stopped on exit', cpuClock: 'central shared 5-second metrics history; intervals weighted, no second app.getAppMetrics reader' };
                await inspect('background');
                for (const id of ids)
                    await inspect('configure', { id, preferences: { random: true, autoMove: true } });
                await chatPage(ids[0]);
                await chatPage(ids[1]);
                const start = performance.now(), wall = Date.now(), samples = [], seen = new Set(), beforeSocial=p86?await inspect('society'):null;
                let cycles = 0, lastCycle = start, lastTick = start;
                try{while (performance.now() - start < minutes * 60000) {
                    await delay(10000);
                    assert.ok(performance.now() - lastTick < 30000, 'Sleep or sampling stall cannot count as stable runtime');
                    lastTick = performance.now();
                    if (await fs.access(path.join(run, 'stop-soak')).then(() => true, () => false))
                        throw Error('Soak explicitly interrupted');
                    const state = await inspect('stats');
                    assert.equal(state.pets.length, 5);
                    assert.ok(state.pets.every(p => p.species === selectedSpecies));
                    if(state.windows>8||state.senders>8){result.failedWindowState=state;await save();}
                    assert.ok(state.windows <= 8 && state.senders <= 8);
                    assert.equal(state.actions.recoveries, 0);
                    assert.equal(state.layout.reduced_motion, false);
                    assert.ok(state.cache.bytes <= state.cache.budget);
                    if(eight)assert.ok(state.localCache.bytes<=state.localCache.budget&&state.localCache.rejected===0);
                    for (const sample of await inspect('metrics'))
                        if (sample.at >= wall && sample.elapsedMs > 0 && !seen.has(sample.sequence)) {
                            seen.add(sample.sequence);
                            samples.push({ ...sample, state, elapsedMsFromStart: performance.now() - start });
                        }
                    if (performance.now() - lastCycle > 120000) {
                        const id = ids[cycles % ids.length];
                        await inspect('hide', id);
                        await inspect('show', id);
                        await inspect('close-chat', cycles % 2 ? ids[0] : ids[1]);
                        await chatPage(cycles % 2 ? ids[0] : ids[1]);
                        cycles++;
                        lastCycle = performance.now();
                    }
                    result.soak = { elapsedMs: performance.now() - start, cycles, sampleCount: samples.length, lastPrivateKiB: samples.at(-1)?.privateKiB };
                    await save();
                    if (samples.length && Math.floor((performance.now() - start) / 60000) > Math.floor((performance.now() - start - 10000) / 60000))
                        console.log('SOAK ' + Math.floor((performance.now() - start) / 60000) + 'm / 30m');
                }}catch(error){await fs.writeFile(path.join(run,'soak-partial-samples.json'),JSON.stringify(samples,null,2),{flag:'wx'});throw error;}
                const file = path.join(run, 'soak-samples.json');
                await fs.writeFile(file, JSON.stringify(samples, null, 2), { flag: 'wx' });
                assert.ok(samples.length >= 330);
                const elapsedMs = performance.now() - start;
                assert.ok(elapsedMs >= 1800000);
                const early = samples.filter(s => s.at - wall >= 60000 && s.at - wall < 360000), late = samples.filter(s => s.at - wall >= elapsedMs - 300000);
                assert.ok(early.length >= 50 && late.length >= 50);
                const mean = list => list.reduce((n, s) => n + s.privateKiB, 0) / list.length, growth = mean(late) - mean(early), peakPrivateKiB = Math.max(...samples.map(s => s.privateKiB)), peakWorkingSetKiB = Math.max(...samples.map(s => s.metrics.reduce((n, p) => n + p.memory.workingSetSize, 0)));
                assert.ok(growth < 96 * 1024, 'Sustained private commit growth exceeds 96 MiB');
                assert.ok(peakPrivateKiB < 1024 * 1024 && peakWorkingSetKiB < 1800 * 1024);
                const final = await inspect('stats');
                if(p86){const after=await inspect('society'),known=new Set(beforeSocial.events.map(e=>e.id)),events=after.events.filter(e=>!known.has(e.id)&&e.started_at>=wall);assert.ok(events.some(e=>e.participants.length>=2&&e.ended_at&&e.outcome==='friendly'&&e.user_actions.length===0),'No naturally selected social event observed');result.naturalSocialEvents=events;}
                assert.ok(final.actions.coordinated > 0 && final.actions.moves > 0);
                result.soak = { elapsedMs, cycles, sampleCount: samples.length, privateGrowthKiB: growth, peakPrivateKiB, peakWorkingSetKiB, averageCpu: samples.reduce((n, s) => n + s.metrics.reduce((a, p) => a + p.cpu.percentCPUUsage, 0) * s.elapsedMs, 0) / samples.reduce((n, s) => n + s.elapsedMs, 0), actions: final.actions, file };
                await inspect('stop-blocker');
                return result.soak;
            });
        await check('account switching rejects other-owner instances/memories and normal exit releases every owned window', async () => {
            await api('POST', '/auth/logout');
            await until(async () => (await inspect('stats')).pets.length === 0, 'Logout left private windows');
            await login(target.accounts[1]);
            if(p86){const social=await inspect('society');assert.equal(social.owner_id,target.accounts[1].owner_id);assert.equal(social.events.length,0);assert.equal(social.ledger.length,0);const denied=await page.evaluate(async old=>{try{await window.weibiyeDesktop.society(old);return false;}catch{return true;}},target.accounts[0].owner_id);assert.equal(denied,true);}
            assert.equal((await inspect('stats')).pets.length, 0);
            for (const [index, id] of ids.slice(0, 2).entries()) {
                assert.equal((await api('GET', '/pet-instances/' + id)).status, 404);
                assert.equal((await api('GET', `/pets/${id}/memory/items/${memoryIds[index]}`)).status, 404);
            }
            const own = (await api('GET', '/pet-instances')).data.items;
            assert.ok(own.every(p => p.owner_user_id === target.accounts[1].owner_id));
            await api('POST', '/auth/logout');
            await until(async () => (await inspect('stats')).owner === null, 'Second logout did not invalidate');
            await quit();
            assert.equal(await portOpen(uiPort), false);
            return { otherOwnerReadStatus: 404, otherOwnerAutoRestored: 0, normalExitCode: 0, uiPortReleased: true };
        });
    }
}
main().catch(error => { console.error(String(error.message)); process.exitCode = 1; });
