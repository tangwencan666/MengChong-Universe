'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createManager, FETCH_LIMIT, DRAG_LEASE_MS, MAIN_PARK_AFTER_MS } = require('../src/manager.cjs');
const policy = require('../src/policy.cjs');
const motion = require('../src/motion.cjs');

const OWNER_A = '10000000-0000-4000-8000-000000000001';
const OWNER_B = '20000000-0000-4000-8000-000000000002';
const IDS = [1, 2, 3, 4, 5, 6].map((n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORIGIN = 'http://127.0.0.1:35316';

function eightOwned(env) {
  const ids=Array.from({length:8},(_,i)=>`30000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
  const definitions=require('../src/pet-registry.cjs').registry.list();
  for(const [i,id] of ids.entries())env.pets.set(id,{owner:OWNER_A,pet_id:id,name:definitions[i].name,role_type:definitions[i].role_type,status:'active',appearance_config:{asset_id:definitions[i].id,tint:definitions[i].tint}});
  return ids;
}

test('local companion IPC is scoped to the exact pet chat route, owned instance and current persona',async t=>{
  const env=environment(t),[one,two]=eightOwned(env);await env.manager.start();await env.manager.release(one);await env.manager.release(two);
  const old=env.state.override;
  env.state.override=url=>url.includes('/pet-instances/')?Response.json({owner_user_id:OWNER_A,pet_id:one,pet_instance_id:one,status:'active',version:1,personality_snapshot_version:1,personality_snapshot:{description:'当前实例人格',tone:'calm'}}):old?.(url);
  const main=env.manager.mainWindow;
  assert.equal((await env.invoke(main,'desktop:companionContext',one,null,'peek')).ok,false);
  main.webContents.mainFrame.url=ORIGIN+'/pets/'+one;
  const response=await env.invoke(main,'desktop:companionContext',one,null,'peek');assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal(response.value.pet_id,one);assert.equal(response.value.model_injection,false);assert.equal(response.value.story,null);
  assert.equal((await env.invoke(main,'desktop:companionContext',two,null,'peek')).ok,false);
  const sprite=env.manager.records.get(one).window;assert.equal((await env.invoke(sprite,'desktop:companionContext',one,null,'peek')).ok,false);
  await env.manager.openChat(one);const chat=env.manager.records.get(one).chatWindow;
  assert.equal((await env.invoke(chat,'desktop:companionContext',two,null,'recount')).ok,false);
  env.state.override=url=>url.includes('/pet-instances/')?Response.json({owner_user_id:OWNER_B}):undefined;
  assert.equal((await env.invoke(chat,'desktop:companionContext',one,null,'recount')).ok,false);
});

test('foreign sessions and owner changes during local context assembly cannot disclose events',async t=>{
  const env=environment(t),[one]=eightOwned(env);await env.manager.start();await env.manager.release(one);
  const win=env.manager.mainWindow,sid=IDS[5];win.webContents.mainFrame.url=ORIGIN+`/pets/${one}/chat/${sid}`;
  env.state.override=url=>url.includes('/sessions/')?Response.json({pet_id:one,session:{id:IDS[4]}}):undefined;
  assert.equal((await env.invoke(win,'desktop:companionContext',one,sid,'peek')).ok,false);
  win.webContents.mainFrame.url=ORIGIN+'/pets/'+one;
  env.state.override=url=>{if(url.includes('/pet-instances/')){env.changeOwner(OWNER_B);return Response.json({});}};
  assert.equal((await env.invoke(win,'desktop:companionContext',one,null,'recount')).ok,false);
});

test('chat social notifications are deduplicated and never include other pets private or event content',async t=>{
  const env=environment(t),[one,two]=eightOwned(env);await env.manager.start();await env.manager.release(one);await env.manager.release(two);await env.manager.openChat(one);
  const chat=env.manager.records.get(one).chatWindow;await env.manager.tickSociety();const count=chat.webContents.messages.filter(v=>v.channel==='weibiye:companion-context-changed').length;
  await env.manager.tickSociety();assert.equal(chat.webContents.messages.filter(v=>v.channel==='weibiye:companion-context-changed').length,count);
  const message=chat.webContents.messages.find(v=>v.channel==='weibiye:companion-context-changed').value;
  assert.equal(message.owner_id,OWNER_A);assert.equal(message.pet_id,one);assert.deepEqual(Object.keys(message).sort(),['event_ids','mood','owner_id','pet_id']);
});

test('eight owned identities can summon the seventh and eighth first from a genuinely empty desktop',async t=>{
  const env=environment(t),ids=eightOwned(env),before=[...env.pets.keys()];await env.manager.start();
  assert.equal(env.manager.records.size,0);
  await env.manager.release(ids[6]);assert.deepEqual([...env.manager.records.keys()],[ids[6]]);assert.equal(env.manager.records.get(ids[6]).actor.definition,'daodun');
  await env.manager.release(ids[7]);assert.equal(env.manager.records.get(ids[7]).actor.definition,'whale');
  for(const id of [ids[0],ids[2],ids[4]])await env.manager.release(id);
  assert.equal(env.manager.records.size,5);await assert.rejects(env.manager.release(ids[5]),{code:'PET_LIMIT'});
  await env.manager.recall(ids[2]);await env.manager.release(ids[5]);assert.equal(env.manager.records.size,5);
  assert.deepEqual([...env.pets.keys()],before);
});

test('restored hidden windows cannot reserve all five visible slots against the seventh owned instance',async t=>{
  const {createLayoutStore}=require('../src/p85-layout-store.cjs'),store=createLayoutStore();
  const env=environment(t,{layoutStore:store}),ids=eightOwned(env);store.set(OWNER_A,{current:ids.slice(0,5).map(pet_id=>({pet_id,hidden:true}))});
  await env.manager.start();await env.manager.syncSession();
  assert.equal([...env.manager.records.values()].filter(r=>!r.hidden).length,0);
  const reply=await env.invoke(env.manager.mainWindow,'desktop:release',ids[6]);
  assert.equal(reply.ok,true,JSON.stringify(reply.error));
  assert.deepEqual([...env.manager.records.values()].filter(r=>!r.hidden).map(r=>r.identity.pet_id),[ids[6]]);
  assert.ok(env.manager.records.size<=5);
});

test('hidden sprites with open chats keep their drafts while visibility, not cached count, enforces five',async t=>{
  const env=environment(t),ids=eightOwned(env);await env.manager.start();const chats=[];
  for(const id of ids.slice(0,5)){await env.manager.release(id);await env.manager.openChat(id);const chat=env.manager.records.get(id).chatWindow;chat.webContents.draft='SYNTHETIC_UNSENT';chats.push(chat);await env.manager.hide(id);}
  await env.manager.release(ids[6]);assert.equal(env.manager.records.size,6);assert.equal(env.manager.senderCount,12);
  assert.ok(chats.every(w=>!w.destroyed&&w.webContents.draft==='SYNTHETIC_UNSENT'));
  for(const id of ids.slice(0,4))await env.manager.show(id);
  assert.equal([...env.manager.records.values()].filter(r=>!r.hidden).length,5);
  await assert.rejects(env.manager.show(ids[4]),{code:'PET_LIMIT'});await assert.rejects(env.manager.release(ids[4]),{code:'PET_LIMIT'});
  assert.deepEqual(new Set(env.manager.layoutState().current),new Set([ids[6],...ids.slice(0,4)]));
  await env.manager.recall(ids[6]);await env.manager.show(ids[4]);assert.equal([...env.manager.records.values()].filter(r=>!r.hidden).length,5);
});

test('replacing a dormant hidden sprite preserves every stored position, identity and relation',async t=>{
  const positions=new Map(),positionStore={get:(owner,id)=>structuredClone(positions.get(id)),set:(owner,id,p)=>{positions.set(id,structuredClone(p));},flush(){}};
  const env=environment(t,{positionStore}),ids=eightOwned(env),original=[...env.pets.values()].map(p=>structuredClone(p));
  for(const [i,id] of ids.entries())positions.set(id,{x:50+i%4*300,y:80+Math.floor(i/4)*300,displayId:'primary',workArea:{x:0,y:0,width:1600,height:1000}});
  const beforePositions=structuredClone(positions);await env.manager.start();for(const id of ids.slice(0,5))await env.manager.release(id);
  const {triggerForTest}=require('../src/p86-society.cjs');assert.equal(triggerForTest(env.manager.society,'cooperate',ids.slice(0,2),1000),true);env.advance(11000);await env.manager.tickSociety();
  const relations=env.manager.society.export().relations;assert.ok(Object.keys(relations).length);
  for(const id of ids.slice(0,5))await env.manager.hide(id);const removed=env.manager.records.get(ids[0]).window;
  await env.manager.release(ids[6]);await env.manager.release(ids[7]);assert.equal(removed.destroyed,true);assert.ok(env.manager.records.size<=5);
  assert.deepEqual(positions,beforePositions);assert.deepEqual([...env.pets.values()],original);assert.deepEqual(env.manager.society.export().relations,relations);
});

test('a selected late instance survives refresh even when absent from the first cached owner page',async t=>{
  const env=environment(t),ids=eightOwned(env);await env.manager.release(ids[6]);await env.manager.release(ids[7]);env.state.calls.length=0;
  env.state.override=url=>url.endsWith('/pets?status=active&limit=30')?Response.json({items:[env.pets.get(ids[7])],has_more:true,next_cursor:'synthetic-page'}):undefined;
  await env.manager.syncSession();assert.deepEqual([...env.manager.records.keys()],[ids[6],ids[7]]);assert.ok(env.state.calls.some(r=>r.url.endsWith('/pets/'+ids[6])));
});

function environment(t, options = {}) {
  let serial = 1;
  let clock = 1000;
  const state = { owner: OWNER_A, calls: [], override: null };
  const pets = new Map(IDS.map((pet_id, i) => [pet_id, { owner: OWNER_A, pet_id,
    name: `测试宠物${i + 1}`, role_type: ['cat', 'dog', 'custom', 'cat', 'cat', 'custom'][i], status: 'active',
    appearance_config: { tint: '#7E9F84' } }]));
  class WebContents extends EventEmitter {
    constructor() { super(); this.id = serial++; this.mainFrame = { url: 'about:blank' }; this.messages = []; }
    send(channel, value) { this.messages.push({ channel, value }); }
    setWindowOpenHandler(handler) { this.newWindow = handler; }
    getURL() { return this.mainFrame.url; }
    isLoadingMainFrame() { return false; }
    async executeJavaScript() { return state.safeToPark === true; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new WebContents(); this.destroyed = false;
      this.visible = false; this.position = { x: options.x ?? 0, y: options.y ?? 0,
        width: options.width, height: options.height }; windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; this.emit('ready-to-show'); }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    restore() {}
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.position }; }
    setPosition(x, y) {
      // Reproduce the observed fractional-DPI outer-size drift of a position-only
      // update. Production must use explicit fixed-size bounds instead.
      this.position.x = x; this.position.y = y;
      this.position.width += 3; this.position.height += 3;
      this.positionOnlyCalls = (this.positionOnlyCalls ?? 0) + 1;
    }
    setBounds(bounds) { this.position = { ...bounds }; (this.fixedBoundsCalls ??= []).push({ ...bounds }); }
    setIgnoreMouseEvents(ignore, options) { this.ignore = ignore; this.ignoreOptions = options; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const windows = [];
  const sessions = [];
  function newSession(partition, options) {
    const result = new EventEmitter();
    Object.assign(result, { partition, options, cookies: new EventEmitter(), clears: [],
      fetch: async (url, config) => {
        state.calls.push({ url, config, session: result });
        if (state.override) {
          const response = await state.override(url, config);
          if (response !== undefined) return response;
        }
        if (url.endsWith('/api/v1/auth/me')) {
          return Response.json(state.owner ? { id: state.owner, status: 'active' } : {}, { status: state.owner ? 200 : 401 });
        }
        if(url.endsWith('/api/v1/pets?status=active&limit=30'))return Response.json({items:[...pets.values()].filter(pet=>pet.owner===state.owner&&pet.status==='active'),has_more:false,next_cursor:null});
        const id = url.slice(url.lastIndexOf('/') + 1);
        const pet = pets.get(id);
        return pet && pet.owner === state.owner
          ? Response.json(pet) : Response.json({}, { status: 404 });
      },
      clearCache: async () => { result.clears.push('cache'); },
      clearStorageData: async (value) => { result.clears.push(value ?? 'all'); },
      setPermissionRequestHandler: (handler) => { result.permissionRequest = handler; },
      setPermissionCheckHandler: (handler) => { result.permissionCheck = handler; },
      webRequest: { onBeforeRequest: (handler) => { result.beforeRequest = handler; } },
    });
    sessions.push(result); return result;
  }
  class FakeTray extends EventEmitter {
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (items) => ({ items,
    getMenuItemById: (id) => items.find((value) => value.id === id),
    popup() { this.popped = true; },
  }) };
  const ipc = new Map();
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } });
  screen.getCursorScreenPoint = () => ({ x: -200, y: -200 });
  const app = { quit: () => { app.quitCalls = (app.quitCalls ?? 0) + 1; } };
  const manager = createManager({ electron: { BrowserWindow: Window,
    session: { fromPartition: newSession }, ipcMain: {
      handle: (channel, callback) => { assert.equal(ipc.has(channel), false); ipc.set(channel, callback); },
      removeHandler: (channel) => ipc.delete(channel),
    }, screen, Tray: FakeTray, Menu, nativeImage: { createFromPath: (value) => value }, app },
  origin: options.origin ?? ORIGIN, assetOrigin: options.assetOrigin, serviceProfile: options.serviceProfile,
  rootDir: path.resolve(__dirname, '..'), now: () => clock,
  localCharacter: options.localCharacter, positionStore: options.positionStore,layoutStore:options.layoutStore,resourceMonitor:options.resourceMonitor });
  t.after(() => manager.stop());
  const event = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return { manager, state, pets, windows, sessions, ipc, event, app, screen,
    advance: (ms) => { clock += ms; },
    invoke: (win, name, ...args) => ipc.get(`weibiye:${name}`)(event(win), ...args),
    changeOwner(id) { state.owner = id; manager.session.cookies.emit('changed', {}, { name: 'weibiye_session' }, 'explicit', false); },
  };
}

test('hidden safe dashboard parks after a grace period and restores without destroying private pets', async t => {
  const env = environment(t); await env.manager.start(); await env.manager.release(IDS[0]);
  const original = env.manager.mainWindow, pet = env.manager.records.get(IDS[0]).window;
  env.state.safeToPark = true;
  original.emit('close', { preventDefault() {} });
  assert.equal(await env.manager.sweepUiResources(), false);
  env.advance(MAIN_PARK_AFTER_MS + 1);
  assert.equal(await env.manager.sweepUiResources(), true);
  assert.equal(original.destroyed, true); assert.equal(env.manager.mainWindow, null);
  assert.equal(env.manager.records.get(IDS[0]).window, pet); assert.equal(pet.destroyed, false);
  assert.equal(env.manager.senderCount, 1);
  assert.equal((await env.invoke(original, 'desktop:list')).ok, false);
  env.manager.showMain();
  assert.notEqual(env.manager.mainWindow, original); assert.equal(env.manager.mainWindow.visible, true);
  assert.equal(env.manager.mainWindow.webContents.getURL(), ORIGIN + '/companions');
  assert.equal(env.manager.ownerId, OWNER_A); assert.equal(env.manager.senderCount, 2);
});

test('draft-bearing or non-dashboard hidden windows are never discarded', async t => {
  const env = environment(t); await env.manager.start(); await env.manager.release(IDS[0]);
  const win = env.manager.mainWindow;
  win.emit('close', { preventDefault() {} }); env.advance(MAIN_PARK_AFTER_MS + 1);
  assert.equal(await env.manager.sweepUiResources(), false);
  env.state.safeToPark = true; win.webContents.mainFrame.url = ORIGIN + '/memory';
  assert.equal(await env.manager.sweepUiResources(), false); assert.equal(win.destroyed, false);
  env.manager.showMain(); win.webContents.mainFrame.url = ORIGIN + '/companions';
  assert.equal(await env.manager.sweepUiResources(), false);
});

test('a cookie epoch change during the parking predicate prevents stale resource disposal', async t => {
  const env = environment(t); await env.manager.start(); await env.manager.release(IDS[0]);
  const win = env.manager.mainWindow; win.emit('close', { preventDefault() {} }); env.advance(MAIN_PARK_AFTER_MS + 1);
  let resolve;
  win.webContents.executeJavaScript = () => new Promise(done => { resolve = done; });
  const pending = env.manager.sweepUiResources();
  env.changeOwner(OWNER_B); resolve(true);
  assert.equal(await pending, false); assert.equal(win.destroyed, false);
  assert.equal(env.manager.records.size, 0);
});

test('navigation or loading during a pending parking predicate preserves the main view', async t => {
  for (const change of ['route', 'loading']) {
    const env = environment(t); await env.manager.start(); await env.manager.release(IDS[0]);
    const win = env.manager.mainWindow; win.emit('close', { preventDefault() {} }); env.advance(MAIN_PARK_AFTER_MS + 1);
    let resolve;
    win.webContents.executeJavaScript = () => new Promise(done => { resolve = done; });
    const pending = env.manager.sweepUiResources();
    if (change === 'route') win.webContents.mainFrame.url = ORIGIN + '/memory';
    else win.webContents.isLoadingMainFrame = () => true;
    resolve(true);
    assert.equal(await pending, false); assert.equal(win.destroyed, false);
  }
});

test('repeated window reuse and recreation keep live senders bounded and pet scopes separate', async t => {
  const env = environment(t); await env.manager.start();
  for (const id of IDS.slice(0, 3)) await env.manager.release(id);
  env.state.safeToPark = true;
  for (let cycle = 0; cycle < 50; cycle++) {
    env.manager.showMain();
    for (const id of IDS.slice(0, 2)) {
      await env.manager.openChat(id);
      const win = env.manager.records.get(id).chatWindow;
      await env.manager.openChat(id); assert.equal(env.manager.records.get(id).chatWindow, win);
      assert.ok(win.webContents.getURL().startsWith(ORIGIN + '/pets/' + id));
    }
    assert.equal(env.manager.senderCount, 6);
    for (const id of IDS.slice(0, 2)) {
      const old = env.manager.records.get(id).chatWindow; old.destroy();
      assert.equal((await env.invoke(old, 'desktop:list')).ok, false);
    }
    env.manager.mainWindow.emit('close', { preventDefault() {} }); env.advance(MAIN_PARK_AFTER_MS + 1);
    assert.equal(await env.manager.sweepUiResources(), true);
    assert.equal(env.manager.senderCount, 3); assert.equal(env.manager.records.size, 3);
  }
  await env.manager.stop(); assert.equal(env.manager.senderCount, 0);
});

test('one desktop refresh shares only its current owner proof and still validates every pet', async t => {
  const env = environment(t); for (const id of IDS.slice(0, 3)) await env.manager.release(id);
  env.state.calls.length = 0; await env.manager.list();
  assert.equal(env.state.calls.filter(call => call.url.endsWith('/auth/me')).length, 1);
  assert.equal(env.state.calls.filter(call => /\/pets\//.test(call.url)).length, 3);
});

test('approved hosted UI keeps authentication remote and pet resources local with no API access', async t => {
  const remote = 'https://beta.weibiye.test';
  const env = environment(t, {origin:remote,assetOrigin:ORIGIN,
    serviceProfile:{schema:'weibiye-service/1',mode:'hosted',origin:remote}});
  await env.manager.start(); await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]);
  assert.equal(record.window.webContents.getURL(), ORIGIN + '/__pet/pet.html');
  assert.equal(record.chatWindow.webContents.getURL(), remote + '/pets/' + IDS[0]);
  assert.ok(env.state.calls.every(call => call.url.startsWith(remote + '/api/v1/')));
  env.manager.session.beforeRequest({url:ORIGIN + '/api/v1/auth/me'}, v => assert.equal(v.cancel,true));
  env.manager.session.beforeRequest({url:remote + '/api/v1/auth/me'}, v => assert.equal(v.cancel,false));
  env.manager.petSession.beforeRequest({url:remote + '/api/v1/auth/me'}, v => assert.equal(v.cancel,true));
  env.manager.petSession.beforeRequest({url:ORIGIN + '/__assets/cat.svg'}, v => assert.equal(v.cancel,false));
});

test('activity IPC binds generation metadata to the registered chat, pet and current session', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.release(IDS[1]);
  await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]), sibling = env.manager.records.get(IDS[1]);
  record.chatWindow.webContents.mainFrame.url = `${ORIGIN}/pets/${IDS[0]}/chat/${IDS[2]}`;
  const signal = { generation_id: IDS[3], session_id: IDS[2], sequence: 2, state: 'running', has_output: false };
  assert.equal((await env.invoke(env.manager.mainWindow, 'desktop:activity', IDS[0], signal)).ok, false);
  assert.equal((await env.invoke(record.window, 'desktop:activity', IDS[0], signal)).ok, false);
  assert.equal((await env.invoke(record.chatWindow, 'desktop:activity', IDS[1], signal)).ok, false);
  assert.equal((await env.invoke(record.chatWindow, 'desktop:activity', IDS[0], { ...signal, session_id: IDS[1] })).ok, false);
  assert.equal((await env.invoke(record.chatWindow, 'desktop:activity', IDS[0], signal)).ok, true);
  assert.equal(record.activity.state, 'thinking'); assert.equal(sibling.activity.generation, null);
  const calls = env.state.calls.length;
  assert.equal((await env.invoke(record.chatWindow, 'desktop:activity', IDS[0], { ...signal, sequence: 3, has_output: true })).ok, true);
  assert.equal(record.activity.state, 'speaking'); assert.equal(env.state.calls.length, calls);
  await env.invoke(record.chatWindow, 'desktop:activity', IDS[0], { ...signal, sequence: 4, state: 'completed', has_output: true });
  await env.invoke(record.chatWindow, 'desktop:activity', IDS[0], { ...signal, sequence: 5, state: 'running' });
  assert.equal(record.activity.state, 'happy');
  const oldChat = record.chatWindow;
  env.changeOwner(OWNER_B);
  assert.equal((await env.invoke(oldChat, 'desktop:activity', IDS[0], signal)).ok, false);
});

test('drag-end persists only authenticated per-pet geometry and release restores it', async (t) => {
  const saved = new Map(), store = { flushes: 0,
    get: (owner, pet) => saved.get(owner + pet),
    set: (owner, pet, value) => saved.set(owner + pet, value),
    flush() { this.flushes += 1; } };
  const env = environment(t, { positionStore: store });
  await env.manager.release(IDS[0]); const win = env.manager.records.get(IDS[0]).window;
  const box = win.getBounds();
  await env.invoke(win, 'pet:dragStart', { x: box.x + 50, y: box.y + 50 });
  await env.invoke(win, 'pet:dragMove', { x: 650, y: 450 });
  assert.equal(store.flushes, 0);
  await env.invoke(win, 'pet:dragEnd');
  assert.equal(store.flushes, 1);
  const stored = saved.get(OWNER_A + IDS[0]);
  assert.deepEqual({ x: stored.x, y: stored.y }, { x: 600, y: 400 });
  await env.manager.recall(IDS[0]); await env.manager.release(IDS[0]);
  assert.equal(env.manager.records.get(IDS[0]).window.getBounds().x, 600);
  assert.equal(env.manager.records.get(IDS[0]).window.focused, undefined);
});

test('closing a chat clears unobserved presentation without issuing a backend cancel', async (t) => {
  const env = environment(t); await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]);
  record.activity.state = 'thinking';
  const calls = env.state.calls.length;
  record.chatWindow.destroy();
  assert.equal(record.activity.state, 'idle'); assert.equal(record.chatWindow, null);
  assert.equal(env.state.calls.length, calls); assert.equal(env.manager.records.size, 1);
});

test('local character modifies only the authenticated target pet renderer, not UI snapshots or other pets', async (t) => {
  const { manager, invoke } = environment(t, { localCharacter: {
    kind: 'deepseek', ownerId: OWNER_A, petId: IDS[0], assetId: 'deepseek-local-preview',
  } });
  for (const id of IDS.slice(0, 3)) await manager.release(id);
  for (const id of IDS.slice(0, 3)) {
    const record = manager.records.get(id);
    const response = await invoke(record.window, 'pet:identity', IDS[1]);
    assert.equal(response.ok, true);
    assert.equal(response.value.pet_id, id);
    assert.equal(response.value.asset_id, id === IDS[0] ? 'deepseek-local-preview' : undefined);
    assert.equal(Object.hasOwn(response.value, 'asset_id'), id === IDS[0]);
  }
  assert.ok(manager.snapshot().pets.every((pet) => !Object.hasOwn(pet, 'asset_id')));
  await new Promise((resolve) => setTimeout(resolve, 70));
  for (const id of IDS.slice(0, 3)) {
    const messages = manager.records.get(id).window.webContents.messages.filter((item) => item.channel === 'weibiye:pet-state');
    assert.ok(messages.length > 0);
    assert.ok(messages.every((message) => message.value.pet_id === id));
    assert.ok(messages.every((message) => Object.hasOwn(message.value, 'asset_id') === (id === IDS[0])));
  }
});

test('a preview owner or pet mismatch leaves a legitimate own pet on its original asset', async (t) => {
  const preview = { kind: 'deepseek', ownerId: OWNER_B, petId: IDS[0], assetId: 'deepseek-local-preview' };
  const env = environment(t, { localCharacter: preview });
  await env.manager.release(IDS[0]);
  const first = await env.invoke(env.manager.records.get(IDS[0]).window, 'pet:identity');
  assert.equal(first.ok, true);
  assert.equal(Object.hasOwn(first.value, 'asset_id'), false);
  env.changeOwner(OWNER_B);
  env.pets.get(IDS[1]).owner = OWNER_B;
  await env.manager.release(IDS[1]);
  const second = await env.invoke(env.manager.records.get(IDS[1]).window, 'pet:identity');
  assert.equal(second.ok, true);
  assert.equal(Object.hasOwn(second.value, 'asset_id'), false);
});

test('local preview never bypasses Cookie authentication or permits a stale renderer', async (t) => {
  const env = environment(t, { localCharacter: {
    kind: 'deepseek', ownerId: OWNER_A, petId: IDS[0], assetId: 'deepseek-local-preview',
  } });
  await env.manager.release(IDS[0]);
  const oldWindow = env.manager.records.get(IDS[0]).window;
  env.state.owner = null;
  const response = await env.invoke(oldWindow, 'pet:identity');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'UNAUTHENTICATED');
  assert.equal(response.value, undefined);
  assert.equal(env.manager.records.size, 0);
  assert.equal(oldWindow.destroyed, true);
  const stale = await env.invoke(oldWindow, 'pet:identity');
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'INVALID_SENDER');
});

test('native identity adds only bounded presentation metadata without any preview or private content', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const response = await env.invoke(env.manager.records.get(IDS[0]).window, 'pet:identity');
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.value).sort(), ['action', 'action_label', 'action_sequence', 'activity', 'appearance_id', 'definition_id', 'direction', 'greeting', 'name', 'pet_id', 'role_type', 'social', 'state', 'tint']);
  assert.equal(response.value.social.id,IDS[0]);assert.equal(Object.hasOwn(response.value.social,'events'),false);
  assert.equal(response.value.activity, 'happy');
});

test('origin policy permits loopback only and rejects credentials or alternate schemes', () => {
  assert.equal(policy.origin(ORIGIN), ORIGIN);
  for (const value of ['https://example.com', 'http://localhost:1234', 'file:///etc/passwd',
    'http://user:pass@127.0.0.1:35316', `${ORIGIN}/api`]) assert.throws(() => policy.origin(value));
});

test('navigation policy binds chats to exactly one pet and rejects non-UI paths', () => {
  assert.equal(policy.uiNavigation(`${ORIGIN}/pets/${IDS[0]}/chat/${IDS[3]}`, ORIGIN, IDS[0]), true);
  assert.equal(policy.uiNavigation(`${ORIGIN}/pets/${IDS[1]}`, ORIGIN, IDS[0]), false);
  for (const url of [`${ORIGIN}/__pet/pet.html`, `${ORIGIN}/api/v1/auth/me`, 'javascript:alert(1)',
    'file:///C:/private', 'https://example.com']) assert.equal(policy.uiNavigation(url, ORIGIN), false);
  assert.equal(policy.uiNavigation(`${ORIGIN}/login`, ORIGIN), true);
});

test('pet resource policy allows only fixed local renderer and asset paths', () => {
  assert.equal(policy.petResource(`${ORIGIN}/__pet/pet.js`, ORIGIN), true);
  assert.equal(policy.petResource(`${ORIGIN}/__assets/cat.svg`, ORIGIN), true);
  for (const value of [`${ORIGIN}/api/v1/auth/me`, `${ORIGIN}/__assets/../api`,
    'https://example.com/__pet/pet.js']) assert.equal(policy.petResource(value, ORIGIN), false);
});

test('partitions are separate, non-persistent and do not share authentication storage', (t) => {
  const { manager, sessions } = environment(t);
  assert.equal(sessions.length, 2);
  assert.notEqual(manager.session, manager.petSession);
  for (const value of sessions) {
    assert.equal(value.partition.startsWith('persist:'), false);
    assert.equal(value.options.cache, false);
  }
});

test('all native renderers have sandbox and isolated constrained preloads', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  for (const window of env.windows) {
    const prefs = window.options.webPreferences;
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.webviewTag, false); assert.equal(prefs.allowRunningInsecureContent, false);
  }
  assert.equal(env.manager.records.get(IDS[0]).window.options.webPreferences.session, env.manager.petSession);
  assert.equal(env.manager.records.get(IDS[0]).chatWindow.options.webPreferences.session, env.manager.session);
});

test('three pets have independent immutable identities, windows and non-overlapping positions', async (t) => {
  const { manager } = environment(t);
  for (const id of IDS.slice(0, 3)) await manager.release(id);
  assert.equal(manager.records.size, 3);
  const records = [...manager.records.values()];
  assert.equal(new Set(records.map((value) => value.window)).size, 3);
  assert.equal(new Set(records.map((value) => value.window.position.x)).size, 3);
  for (const record of records) {
    assert.equal(Object.isFrozen(record.identity), true);
    assert.equal(record.identity.owner_id, OWNER_A);
    assert.equal(record.window.options.transparent, true);
    assert.equal(record.window.options.frame, false);
    assert.equal(record.window.options.thickFrame, false);
    assert.equal(record.window.options.alwaysOnTop, true);
  }
});

test('a sixth pet is refused and duplicate release reuses its window', async (t) => {
  const { manager } = environment(t);
  for (const id of IDS.slice(0, 5)) await manager.release(id);
  const original = manager.records.get(IDS[0]).window;
  await manager.release(IDS[0]);
  assert.equal(manager.records.get(IDS[0]).window, original);
  await assert.rejects(manager.release(IDS[5]), { code: 'PET_LIMIT' });
  assert.equal(manager.records.size, 5);
});

test('hide, show and recall affect only the selected pet and preserve backend data', async (t) => {
  const { manager, state } = environment(t);
  await manager.release(IDS[0]); await manager.release(IDS[1]);
  await manager.hide(IDS[0]);
  assert.equal(manager.records.get(IDS[0]).window.visible, false);
  assert.equal(manager.records.get(IDS[1]).window.visible, true);
  await manager.show(IDS[0].toUpperCase());
  assert.equal(manager.records.get(IDS[0]).window.visible, true);
  await manager.recall(IDS[0]);
  assert.equal(manager.records.has(IDS[0]), false); assert.equal(manager.records.has(IDS[1]), true);
  assert.equal(state.calls.every((value) => value.config.method === 'GET'), true);
});

test('server owner filtering rejects another user pet without creating a window', async (t) => {
  const { manager, pets } = environment(t);
  pets.get(IDS[0]).owner = OWNER_B;
  await assert.rejects(manager.release(IDS[0]), { code: 'PET_UNAVAILABLE' });
  assert.equal(manager.records.size, 0);
});

test('archived pet is rejected and newly archived active pet is immediately recalled on list', async (t) => {
  const { manager, pets } = environment(t);
  pets.get(IDS[0]).status = 'archived';
  await assert.rejects(manager.release(IDS[0]), { code: 'PET_UNAVAILABLE' });
  await manager.release(IDS[1]);
  pets.get(IDS[1]).status = 'archived';
  await assert.rejects(manager.list(), { code: 'PET_UNAVAILABLE' });
  assert.equal(manager.records.size, 0);
});

test('authentication cookie changes immediately close old pets and chats before an account switch', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]); const chat = record.chatWindow;
  env.changeOwner(OWNER_B);
  assert.equal(record.window.destroyed, true); assert.equal(chat.destroyed, true);
  assert.equal(env.manager.records.size, 0); assert.equal(env.manager.ownerId, null);
  const result = await env.manager.syncSession();
  assert.equal(result.owner_id, OWNER_B); assert.equal(result.authenticated, true);
  assert.equal(env.manager.snapshot().pets.length, 0);
  assert.equal(env.manager.session.clears.length > 0, true);
});

test('CSRF cookie changes do not discard a valid authenticated pet', async (t) => {
  const { manager } = environment(t);
  await manager.release(IDS[0]);
  manager.session.cookies.emit('changed', {}, { name: 'weibiye_csrf' });
  assert.equal(manager.records.size, 1);
});

test('every intermediate event excludes old pets when the server silently changes owner without a Cookie event', async (t) => {
  const env = environment(t);
  for (const id of IDS.slice(0, 3)) await env.manager.release(id);
  const oldWindows = [...env.manager.records.values()].map((record) => record.window);
  env.manager.mainWindow.webContents.messages.length = 0;
  // Deliberately omit cookies.changed: a poll/action must independently discover
  // the server identity change, and each per-window cleanup emits an event.
  env.state.owner = OWNER_B;
  expectOwnerResult(await env.manager.syncSession(), OWNER_B);
  const events = env.manager.mainWindow.webContents.messages
    .filter((event) => event.channel === 'weibiye:desktop-state').map((event) => event.value);
  assert.ok(events.length >= 4, 'observe intermediate window removals as well as the final state');
  for (const value of events) {
    assert.equal(value.authenticated, true);
    assert.equal(value.owner_id, OWNER_B);
    assert.deepEqual(value.pets, [], 'no event for B may contain even one remaining A pet');
  }
  assert.equal(env.manager.records.size, 0);
  assert.equal(oldWindows.every((window) => window.destroyed), true);
});

function expectOwnerResult(result, owner) {
  assert.equal(result.authenticated, true);
  assert.equal(result.owner_id, owner);
  assert.equal(result.changed, true);
}

test('every intermediate Cookie invalidation event with three pets has an empty unauthenticated payload', async (t) => {
  const env = environment(t);
  for (const id of IDS.slice(0, 3)) await env.manager.release(id);
  env.manager.mainWindow.webContents.messages.length = 0;
  env.changeOwner(null);
  const events = env.manager.mainWindow.webContents.messages
    .filter((event) => event.channel === 'weibiye:desktop-state').map((event) => event.value);
  assert.ok(events.length >= 4);
  for (const value of events) {
    assert.equal(value.authenticated, false);
    assert.equal(value.owner_id, null);
    assert.deepEqual(value.pets, []);
  }
});

test('logout and network errors fail closed without exposing server response bodies', async (t) => {
  const env = environment(t);
  await env.manager.start();
  await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  env.state.owner = null;
  const result = await env.manager.syncSession();
  assert.equal(result.authenticated, false); assert.equal(env.manager.records.size, 0);
  env.state.owner = OWNER_A;
  await env.manager.release(IDS[1]);
  env.state.override = () => { throw Object.assign(new Error('PRIVATE_BODY_COOKIE_SECRET'), { code: 'NETWORK_UNAVAILABLE' }); };
  const response = await env.invoke(env.manager.mainWindow, 'desktop:list');
  assert.equal(response.ok, false); assert.equal(response.error.code, 'NETWORK_UNAVAILABLE');
  assert.equal(JSON.stringify(response).includes('PRIVATE_BODY_COOKIE_SECRET'), false);
  assert.equal(env.manager.records.size, 0);
});

test('delayed authentication response cannot create a window after a cookie epoch change', async (t) => {
  const env = environment(t);
  let unblock;
  env.state.override = (url) => url.endsWith('/auth/me')
    ? new Promise((resolve) => { unblock = () => resolve(Response.json({ id: OWNER_A, status: 'active' })); }) : undefined;
  const pending = env.manager.release(IDS[0]);
  await new Promise((resolve) => setImmediate(resolve));
  env.changeOwner(OWNER_B); unblock();
  await assert.rejects(pending, { code: 'SESSION_CHANGED' });
  assert.equal(env.manager.records.size, 0);
});

test('delayed pet response cannot create a stale owner window after cookie replacement', async (t) => {
  const env = environment(t);
  let unblock;
  env.state.override = (url) => url.endsWith(`/pets/${IDS[0]}`)
    ? new Promise((resolve) => { unblock = () => resolve(Response.json(env.pets.get(IDS[0]))); }) : undefined;
  const pending = env.manager.release(IDS[0]);
  await new Promise((resolve) => setImmediate(resolve));
  env.changeOwner(OWNER_B); unblock();
  await assert.rejects(pending, { code: 'SESSION_CHANGED' });
  assert.equal(env.manager.records.size, 0);
});

test('oversized API responses fail closed before content parsing', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  env.state.override = () => new Response('{}', { headers: { 'content-length': String(FETCH_LIMIT + 1) } });
  await assert.rejects(env.manager.list(), { code: 'RESPONSE_LIMIT' });
  assert.equal(env.manager.records.size, 0);
});

test('unexpected API identity and malformed JSON cannot create a pet', async (t) => {
  const env = environment(t);
  env.state.override = (url) => url.endsWith(`/pets/${IDS[0]}`) ? Response.json(env.pets.get(IDS[1])) : undefined;
  await assert.rejects(env.manager.release(IDS[0]), { code: 'INVALID_RESPONSE' });
  env.state.override = () => new Response('not-json');
  await assert.rejects(env.manager.syncSession(), { code: 'INVALID_RESPONSE' });
  assert.equal(env.manager.records.size, 0);
});

test('unregistered senders, subframes and wrong document URLs are refused before network access', async (t) => {
  const env = environment(t);
  await env.manager.start();
  const win = env.manager.mainWindow;
  const handler = env.ipc.get('weibiye:desktop:list');
  const count = env.state.calls.length;
  assert.equal((await handler({ sender: { id: 999 }, senderFrame: {} })).ok, false);
  assert.equal((await handler({ sender: win.webContents, senderFrame: { url: win.webContents.mainFrame.url } })).ok, false);
  win.webContents.mainFrame.url = 'https://example.com';
  assert.equal((await handler(env.event(win))).ok, false);
  assert.equal(env.state.calls.length, count);
});

test('a chat window cannot invoke a desktop action for another pet', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.release(IDS[1]);
  await env.manager.openChat(IDS[0]);
  const chat = env.manager.records.get(IDS[0]).chatWindow;
  const result = await env.invoke(chat, 'desktop:hide', IDS[1]);
  assert.equal(result.error.code, 'INVALID_SCOPE');
  assert.equal(env.manager.records.get(IDS[1]).hidden, false);
});

test('pet IPC cannot impersonate a UI sender or use a stale destroyed window', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const win = env.manager.records.get(IDS[0]).window;
  assert.equal((await env.invoke(win, 'desktop:list')).error.code, 'INVALID_SENDER');
  await env.manager.recall(IDS[0]);
  assert.equal((await env.invoke(win, 'pet:identity')).error.code, 'INVALID_SENDER');
});

test('drag leases require an in-window start and never use private APIs for pointer moves', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const win = env.manager.records.get(IDS[0]).window;
  assert.equal((await env.invoke(win, 'pet:dragMove', { x: 300, y: 300 })).error.code, 'DRAG_EXPIRED');
  const at = win.getBounds();
  assert.equal((await env.invoke(win, 'pet:dragStart', { x: -900, y: -900 })).ok, false);
  assert.equal((await env.invoke(win, 'pet:dragStart', { x: at.x + 94, y: at.y + 100 })).ok, true);
  const count = env.state.calls.length;
  assert.equal((await env.invoke(win, 'pet:dragMove', { x: 600, y: 400 })).ok, true);
  assert.equal(env.state.calls.length, count);
  assert.equal(win.getBounds().x, 506); assert.equal(win.getBounds().y, 300);
  assert.equal((await env.invoke(win, 'pet:dragEnd')).ok, true);
  assert.equal(env.state.calls.length > count, true);
});

test('drag coordinates are bounded, clamped and revoked after ten seconds', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const win = env.manager.records.get(IDS[0]).window;
  const at = win.getBounds();
  await env.invoke(win, 'pet:dragStart', { x: at.x + 94, y: at.y + 100 });
  for (const point of [{ x: NaN, y: 1 }, { x: Infinity, y: 1 }, { x: 1, y: 1, id: IDS[1] }]) {
    assert.equal((await env.invoke(win, 'pet:dragMove', point)).error.code, 'INVALID_POINTER');
  }
  await env.invoke(win, 'pet:dragMove', { x: 9999, y: 9999 });
  assert.equal(win.getBounds().x, 1600 - 188); assert.equal(win.getBounds().y, 1000 - 196);
  env.advance(DRAG_LEASE_MS + 1);
  assert.equal((await env.invoke(win, 'pet:dragMove', { x: 500, y: 500 })).error.code, 'DRAG_EXPIRED');
});

test('pointerdown pauses a walking pet before slow authorization and buffers only the latest fast pointer move', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const record = env.manager.records.get(IDS[0]); const win = record.window;
  const at = win.getBounds();
  const animated = env.manager.world.pets.get(IDS[0]);
  animated.state = 'walking'; animated.target = { x: 1000, y: 100 }; animated.speed = 500;
  let unblock;
  env.state.override = (url) => url.endsWith('/auth/me')
    ? new Promise((resolve) => { unblock = () => resolve(Response.json({ id: OWNER_A, status: 'active' })); }) : undefined;
  const pending = env.invoke(win, 'pet:dragStart', { x: at.x + 94, y: at.y + 100 });
  assert.equal(animated.state, 'dragging', 'pause before any HTTP response or queue completion');
  await new Promise((resolve) => setImmediate(resolve));
  env.advance(200);
  motion.tickWorld(env.manager.world, 1200);
  assert.equal(animated.x, at.x); assert.equal(animated.y, at.y);
  await env.invoke(win, 'pet:dragMove', { x: 400, y: 300 });
  await env.invoke(win, 'pet:dragMove', { x: 600, y: 400 });
  assert.equal(record.drag.authorized, false);
  assert.deepEqual(record.drag.pendingPoint, { x: 600, y: 400 });
  assert.deepEqual(win.getBounds(), at, 'unverified pointer moves must not reposition the native window');
  unblock();
  assert.equal((await pending).ok, true);
  assert.equal(record.drag.authorized, true); assert.equal(record.drag.pendingPoint, null);
  assert.equal(win.getBounds().x, 506); assert.equal(win.getBounds().y, 300);
});

test('failed pointerdown authorization never applies a buffered move and safely recalls the sprite', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const record = env.manager.records.get(IDS[0]); const win = record.window; const at = win.getBounds();
  let unblock;
  env.state.override = (url) => url.endsWith('/auth/me')
    ? new Promise((resolve) => { unblock = () => resolve(Response.json({}, { status: 401 })); }) : undefined;
  const pending = env.invoke(win, 'pet:dragStart', { x: at.x + 94, y: at.y + 100 });
  await new Promise((resolve) => setImmediate(resolve));
  await env.invoke(win, 'pet:dragMove', { x: 600, y: 400 });
  unblock();
  assert.equal((await pending).ok, false);
  assert.deepEqual(win.getBounds(), at);
  assert.equal(win.destroyed, true); assert.equal(env.manager.records.size, 0);
});

test('repeated autonomous movement and dragging preserve fixed DIP dimensions instead of native size round-trips', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const record = env.manager.records.get(IDS[0]); const win = record.window;
  const animated = env.manager.world.pets.get(IDS[0]);
  record.activity.state='idle';record.activity.until=0;
  Object.assign(record.actor,{action:'walk',priority:30,until:12000,motion:record.actor.sequence});
  record.actor.preferences.autoMove=true;
  animated.state = 'walking'; animated.target = { x: 1300, y: 100 }; animated.speed = 45;
  for (let i = 0; i < 200; i += 1) { env.advance(50); t.mock.timers.tick(50); }
  assert.ok(win.fixedBoundsCalls.length > 100, 'exercise the real host tick callback across ten seconds of logical motion');
  assert.equal(win.positionOnlyCalls ?? 0, 0);
  const at = win.getBounds();
  await env.invoke(win, 'pet:dragStart', { x: at.x + 94, y: at.y + 100 });
  for (let i = 0; i < 25; i += 1) await env.invoke(win, 'pet:dragMove', { x: 600 + i, y: 400 + i });
  for (const bounds of win.fixedBoundsCalls) {
    assert.equal(bounds.width, 188); assert.equal(bounds.height, 196);
  }
  assert.equal(win.getBounds().width, 188); assert.equal(win.getBounds().height, 196);
  assert.equal(win.positionOnlyCalls ?? 0, 0);
});

test('one-DIP native rounding does not trigger repeated idle updates but a three-DIP discrepancy is corrected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const win = env.manager.records.get(IDS[0]).window;
  const getBounds = win.getBounds.bind(win); const setBounds = win.setBounds.bind(win);
  let outwardRounding = 1;
  win.getBounds = () => {
    const value = getBounds();
    return { ...value, width: value.width + outwardRounding, height: value.height + outwardRounding };
  };
  win.setBounds = (value) => { setBounds(value); outwardRounding = 1; };
  for (let i = 0; i < 12; i += 1) t.mock.timers.tick(50);
  assert.equal(win.fixedBoundsCalls?.length ?? 0, 0, 'bounded outward reports must not cause a 20 Hz idle resize loop');
  outwardRounding = 3;
  t.mock.timers.tick(50);
  assert.equal(win.fixedBoundsCalls.length, 1, 'larger anomalies still require a fixed-size correction');
  assert.equal(win.fixedBoundsCalls[0].width, 188); assert.equal(win.fixedBoundsCalls[0].height, 196);
  for (let i = 0; i < 12; i += 1) t.mock.timers.tick(50);
  assert.equal(win.fixedBoundsCalls.length, 1);
});

test('account switch during dragging invalidates the lease and destroys its old sender', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const win = env.manager.records.get(IDS[0]).window; const at = win.getBounds();
  await env.invoke(win, 'pet:dragStart', { x: at.x + 94, y: at.y + 100 });
  env.changeOwner(OWNER_B);
  assert.equal((await env.invoke(win, 'pet:dragMove', { x: 500, y: 500 })).error.code, 'INVALID_SENDER');
  assert.equal(env.manager.records.size, 0);
});

test('native context menu and tray have scoped actions and a stable safe quit item', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  const win = env.manager.records.get(IDS[0]).window;
  assert.equal((await env.invoke(win, 'pet:menu')).ok, true);
  assert.equal(env.manager.lastContextMenu.popped, true);
  assert.deepEqual(env.manager.lastContextMenu.items.filter((item) => item.label).map((item) => item.label),
    ['打开聊天','轻轻抚摸（免费）','安慰一下（免费）','免费鸡腿','免费小鱼干','免费玩具','免费小毯子','调解当前冲突','支持这只宠物','查看心情与关系', '轻轻跳一下', '伸个懒腰', '小睡一会…', '醒来啦', '允许随机互动', '允许低频自主移动', '隐藏这只宠物', '收回这只宠物', '显示主界面']);
  env.manager.trayMenu.getMenuItemById('quit').click();
  assert.equal(env.app.quitCalls, 1);
});

test('society IPC enforces owner and main-window scope; item retries never duplicate consumption',async t=>{
  const env=environment(t);await env.manager.start();await env.manager.release(IDS[0]);await env.manager.release(IDS[1]);
  const main=env.manager.mainWindow,pet=env.manager.records.get(IDS[0]).window;
  const initial=await env.invoke(main,'desktop:society',OWNER_A);assert.equal(initial.ok,true);
  const key='40000000-0000-4000-8000-000000000001',version=initial.value.state.revision;
  const first=await env.invoke(main,'desktop:socialAction',OWNER_A,IDS[0],'chicken',key,version);assert.equal(first.ok,true);assert.equal(first.value.state.ledger.length,1);
  const retry=await env.invoke(main,'desktop:socialAction',OWNER_A,IDS[0],'chicken',key,version);assert.equal(retry.ok,true);assert.equal(retry.value.state.ledger.length,1);
  assert.equal((await env.invoke(pet,'desktop:society',OWNER_A)).error.code,'INVALID_SENDER');
  await env.manager.openChat(IDS[0]);const chat=env.manager.records.get(IDS[0]).chatWindow;
  assert.equal((await env.invoke(chat,'desktop:society',OWNER_A)).error.code,'INVALID_SCOPE');
  const own=await env.invoke(pet,'pet:sharedEvents',IDS[1]);assert.ok(own.value.every(e=>e.participants.includes(IDS[0])));
  env.changeOwner(OWNER_B);await env.manager.syncSession();
  assert.equal((await env.invoke(main,'desktop:society',OWNER_A)).error.code,'SESSION_CHANGED');
  const next=await env.invoke(main,'desktop:society',OWNER_B);assert.deepEqual(next.value.state.events,[]);assert.deepEqual(next.value.state.ledger,[]);
});

test('all-hidden and recalled pets leave no society timeout; restoring schedules only one and exit clears it',async t=>{
  const env=environment(t);await env.manager.release(IDS[0]);assert.equal(env.manager.societyPending,true);
  await env.manager.hide(IDS[0]);assert.equal(env.manager.societyPending,false);
  await env.manager.show(IDS[0]);assert.equal(env.manager.societyPending,true);
  await env.manager.recall(IDS[0]);assert.equal(env.manager.societyPending,false);
  await env.manager.release(IDS[0]);await env.manager.stop();assert.equal(env.manager.societyPending,false);assert.equal(env.manager.society,null);
});

test('native menus retained across a switch cannot operate on a new account', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  await env.invoke(env.manager.records.get(IDS[0]).window, 'pet:menu');
  const menu = env.manager.lastContextMenu;
  env.changeOwner(OWNER_B);
  menu.items[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.manager.records.size, 0);
});

test('external windows, webviews, permissions and downloads are denied', (t) => {
  const env = environment(t);
  assert.deepEqual(env.manager.mainWindow.webContents.newWindow({ url: 'https://example.com' }), { action: 'deny' });
  let prevented = false;
  env.manager.mainWindow.webContents.emit('will-attach-webview', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  for (const session of env.sessions) {
    assert.equal(session.permissionCheck(), false);
    session.permissionRequest({}, 'media', (granted) => assert.equal(granted, false));
    prevented = false;
    session.emit('will-download', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  }
});

test('pet session cannot fetch API or remote content even though the UI can use its own origin', (t) => {
  const { manager } = environment(t);
  manager.petSession.beforeRequest({ url: `${ORIGIN}/api/v1/pets` }, (result) => assert.equal(result.cancel, true));
  manager.petSession.beforeRequest({ url: `${ORIGIN}/__pet/pet.html` }, (result) => assert.equal(result.cancel, false));
  manager.session.beforeRequest({ url: `${ORIGIN}/api/v1/pets` }, (result) => assert.equal(result.cancel, false));
  manager.session.beforeRequest({ url: 'https://example.com/api' }, (result) => assert.equal(result.cancel, true));
});

test('cross-pet history navigation closes only the invalid chat window', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]); const win = record.chatWindow;
  win.webContents.emit('did-navigate-in-page', {}, `${ORIGIN}/pets/${IDS[1]}`);
  assert.equal(win.destroyed, true); assert.equal(record.chatWindow, null);
  assert.equal(env.manager.records.size, 1);
});

test('chat remembers only its scoped route and reopens that history', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]);
  const url = `${ORIGIN}/pets/${IDS[0]}/chat/${IDS[3]}`;
  record.chatWindow.webContents.emit('did-navigate-in-page', {}, url);
  record.chatWindow.destroy();
  await env.manager.openChat(IDS[0]);
  assert.equal(record.chatWindow.webContents.mainFrame.url, url);
});

test('pet renderer crash closes its companion chat and removes its motion record', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]); await env.manager.openChat(IDS[0]);
  const record = env.manager.records.get(IDS[0]); const chat = record.chatWindow;
  record.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(env.manager.records.size, 0); assert.equal(chat.destroyed, true);
});

test('main close hides to tray and complete stop releases handlers, windows and storage', async (t) => {
  const env = environment(t);
  await env.manager.start(); await env.manager.release(IDS[0]);
  let prevented = false;
  env.manager.mainWindow.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(env.manager.mainWindow.visible, false);
  await env.manager.stop(); await env.manager.stop();
  assert.equal(env.manager.stopped, true); assert.equal(env.ipc.size, 0);
  assert.equal(env.manager.records.size, 0); assert.equal(env.manager.mainWindow.destroyed, true);
  assert.equal(env.manager.tray.destroyed, true); assert.equal(env.manager.world.disposed, true);
  assert.equal(env.screen.listenerCount('display-removed'), 0);
  for (const session of env.sessions) assert.equal(session.clears.includes('all'), true);
  await assert.rejects(env.manager.list(), { code: 'STOPPED' });
});

test('a tiny display recalls existing pets safely and prevents off-screen new windows', async (t) => {
  const env = environment(t);
  await env.manager.release(IDS[0]);
  env.screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 100, height: 100 } });
  assert.doesNotThrow(() => env.screen.emit('display-metrics-changed'));
  assert.equal(env.manager.records.size, 0);
  await assert.rejects(env.manager.release(IDS[0]), { code: 'PET_SPACE' });
});

function downloadItem(changes = {}) {
  const item = new EventEmitter();
  return Object.assign(item, {
    getURL: () => `blob:${ORIGIN}/${IDS[3]}`,
    getFilename: () => 'weibiye-memories-2026-11-02.json',
    getMimeType: () => 'application/json;charset=utf-8', getTotalBytes: () => 1200,
    pause: () => { item.paused = true; }, resume: () => { item.resumed = true; },
    cancel: () => { item.cancelled = true; item.emit('done', {}, 'cancelled'); },
    setSaveDialogOptions: (value) => { item.dialog = value; }, ...changes,
  });
}

test('explicit P4 JSON export retains a scoped native save dialog after fresh authentication', async (t) => {
  const env = environment(t);
  await env.manager.start(); await env.manager.syncSession();
  await env.manager.mainWindow.loadURL(`${ORIGIN}/memory`);
  let prevented = false;
  const item = downloadItem();
  env.manager.session.emit('will-download', { preventDefault: () => { prevented = true; } }, item, env.manager.mainWindow.webContents);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, false); assert.equal(item.paused, true); assert.equal(item.resumed, true);
  assert.deepEqual(item.dialog.filters, [{ name: 'JSON 记忆文件', extensions: ['json'] }]);
  item.emit('done', {}, 'completed');
});

test('downloads reject external/data URLs, wrong types, filenames, pages and oversized exports', async (t) => {
  const env = environment(t);
  await env.manager.start(); await env.manager.syncSession();
  await env.manager.mainWindow.loadURL(`${ORIGIN}/memory`);
  for (const changes of [
    { getURL: () => 'https://example.com/memory.json' },
    { getURL: () => 'data:application/json,{}' },
    { getURL: () => 'blob:https://example.com/abc' },
    { getMimeType: () => 'application/javascript' },
    { getFilename: () => 'evil.exe' },
    { getTotalBytes: () => 11 * 1024 * 1024 },
  ]) {
    let prevented = false;
    env.manager.session.emit('will-download', { preventDefault: () => { prevented = true; } }, downloadItem(changes), env.manager.mainWindow.webContents);
    assert.equal(prevented, true);
  }
  await env.manager.mainWindow.loadURL(`${ORIGIN}/companions`);
  let prevented = false;
  env.manager.session.emit('will-download', { preventDefault: () => { prevented = true; } }, downloadItem(), env.manager.mainWindow.webContents);
  assert.equal(prevented, true);
});

test('an account change cancels in-flight exported memory and cannot resume the old content', async (t) => {
  const env = environment(t);
  await env.manager.start(); await env.manager.syncSession();
  await env.manager.mainWindow.loadURL(`${ORIGIN}/memory`);
  let unblock;
  env.state.override = (url) => url.endsWith('/auth/me')
    ? new Promise((resolve) => { unblock = () => resolve(Response.json({ id: OWNER_A, status: 'active' })); }) : undefined;
  const item = downloadItem();
  env.manager.session.emit('will-download', { preventDefault() { assert.fail('valid export prematurely refused'); } }, item, env.manager.mainWindow.webContents);
  await new Promise((resolve) => setImmediate(resolve));
  env.changeOwner(OWNER_B); unblock();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.cancelled, true); assert.notEqual(item.resumed, true);
});

test('feedback export is confined to the main beta page and cancels an oversized transfer', async t => {
  const env=environment(t);await env.manager.start();await env.manager.syncSession();
  await env.manager.mainWindow.loadURL(ORIGIN+'/beta');
  const item=downloadItem({getFilename:()=> 'weibiye-beta-feedback-v1.json',getTotalBytes:()=>0,getReceivedBytes:()=>17000});
  env.manager.session.emit('will-download',{preventDefault(){assert.fail('Owned feedback refused');}},item,env.manager.mainWindow.webContents);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(item.resumed,true);
  item.emit('updated');assert.equal(item.cancelled,true);
});

test('resume recovery rechecks every pet, clamps to current displays and never focuses', async t => {
  const env=environment(t);await env.manager.start();
  for(const id of IDS.slice(0,3))await env.manager.release(id);
  const before=env.state.calls.length;
  env.screen.getPrimaryDisplay=()=>({workArea:{x:-1024,y:0,width:1024,height:768}});
  await env.manager.recover();
  const calls=env.state.calls.slice(before);
  assert.equal(calls.filter(call=>call.url.endsWith('/auth/me')).length,1);
  for(const id of IDS.slice(0,3)) {
    assert.equal(calls.filter(call=>call.url.endsWith('/pets/'+id)).length,1);
    const win=env.manager.records.get(id).window, bounds=win.getBounds();
    assert.ok(bounds.x>=-1024 && bounds.x+bounds.width<=0);
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=768);
    assert.notEqual(win.focused,true);
  }
  assert.notEqual(env.manager.mainWindow.focused,true);
});

test('resume recovery invalidates all old pets if authentication expired during sleep', async t => {
  const env=environment(t);await env.manager.start();await env.manager.release(IDS[0]);
  const old=env.manager.records.get(IDS[0]).window;
  env.state.owner=null;await assert.rejects(env.manager.recover(),{code:'UNAUTHENTICATED'});
  assert.equal(old.destroyed,true);assert.equal(env.manager.records.size,0);
  assert.equal(env.manager.ownerId,null);assert.notEqual(env.manager.mainWindow.focused,true);
});

test('five-pet polling uses one current owner-filtered list and individually checks omitted hidden pets',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const env=environment(t);
  for(const id of IDS.slice(0,5))await env.manager.release(id);
  env.state.calls.length=0;env.advance(5000);t.mock.timers.tick(5000);await new Promise(setImmediate);
  assert.equal(env.state.calls.filter(c=>c.url.endsWith('/api/v1/pets?status=active&limit=30')).length,1);
  assert.equal(env.state.calls.filter(c=>/\/pets\/[a-f0-9-]{36}$/.test(c.url)).length,0);
  assert.equal(env.manager.records.size,5);
  env.pets.get(IDS[4]).status='hidden';env.state.calls.length=0;
  env.advance(5000);t.mock.timers.tick(5000);await new Promise(setImmediate);
  assert.equal(env.state.calls.filter(c=>c.url.endsWith('/pets/'+IDS[4])).length,1);
  assert.equal(env.manager.records.size,5);
});

test('an account change during a pending list proof cannot resurrect or animate old pets',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const env=environment(t);
  for(const id of IDS.slice(0,5))await env.manager.release(id);
  let unblock;env.state.override=url=>url.endsWith('/api/v1/pets?status=active&limit=30')?new Promise(resolve=>{unblock=resolve;}):undefined;
  env.advance(5000);t.mock.timers.tick(5000);await new Promise(setImmediate);assert.equal(typeof unblock,'function');
  env.changeOwner(OWNER_B);unblock(Response.json({items:[...env.pets.values()],has_more:false}));await new Promise(setImmediate);
  assert.equal(env.manager.records.size,0);assert.equal(env.manager.ownerId,null);
});

test('malformed or duplicated list proof fails closed without weakening the server read limit',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const env=environment(t);
  for(const id of IDS.slice(0,5))await env.manager.release(id);
  env.state.override=url=>url.endsWith('/api/v1/pets?status=active&limit=30')?Response.json({items:[env.pets.get(IDS[0]),env.pets.get(IDS[0])],has_more:false}):undefined;
  env.advance(5000);t.mock.timers.tick(5000);await new Promise(setImmediate);
  assert.equal(env.manager.records.size,0);
});

test('hiding explicitly releases only the owned pet presentation even without a visibility event',async t=>{
  const env=environment(t);await env.manager.release(IDS[0]);await env.manager.release(IDS[1]);
  const one=env.manager.records.get(IDS[0]),other=env.manager.records.get(IDS[1]);
  const otherSequence=other.actor.sequence;
  await env.manager.hide(IDS[0]);assert.equal(one.window.webContents.messages.at(-1).value.action,'hidden');
  assert.equal(other.actor.sequence,otherSequence);assert.equal(other.hidden,false);
  await env.manager.show(IDS[0]);assert.notEqual(one.window.webContents.messages.at(-1).value.action,'hidden');
});

test('new definitions have independent local greetings without a model request',async t=>{
  const env=environment(t),{registry}=require('../src/pet-registry.cjs');
  env.pets.get(IDS[0]).appearance_config.asset_id='maodie';env.pets.get(IDS[1]).appearance_config.asset_id='hajimi';
  for(const id of IDS.slice(0,2))await env.manager.release(id);
  for(const [id,definition]of [[IDS[0],'maodie'],[IDS[1],'hajimi']]){
    const reply=await env.invoke(env.manager.records.get(id).window,'pet:identity');
    assert.equal(reply.value.greeting,registry.get(definition).greeting);
  }
  assert.notEqual(env.manager.records.get(IDS[0]).activity.greeting,env.manager.records.get(IDS[1]).activity.greeting);
});

test('a retained behavior menu cannot change old preferences after account invalidation',async t=>{
  const env=environment(t);await env.manager.release(IDS[0]);const record=env.manager.records.get(IDS[0]);
  await env.invoke(record.window,'pet:menu');const item=env.manager.lastContextMenu.getMenuItemById('auto-move');
  env.changeOwner(OWNER_B);item.click({checked:true});await new Promise(setImmediate);
  assert.equal(record.actor.preferences.autoMove,false);assert.equal(env.manager.records.size,0);
});

test('same species and names keep five distinct actors and rename only the matching instance',async t=>{
  const env=environment(t);for(const id of IDS.slice(0,5)){Object.assign(env.pets.get(id),{name:'同名',role_type:'cat',appearance_config:{asset_id:'hajimi',tint:'#abcdef'}});await env.manager.release(id);}
  assert.equal(env.manager.records.size,5);assert.equal(new Set([...env.manager.records.values()].map(r=>r.window)).size,5);
  await env.manager.playAction(IDS[0],'affection');assert.equal(env.manager.records.get(IDS[0]).actor.action,'affection');
  assert.ok(IDS.slice(1,5).every(id=>env.manager.records.get(id).actor.action!=='affection'));
  const record=env.manager.records.get(IDS[0]);env.pets.get(IDS[0]).name='新名字';await env.manager.syncSession();
  assert.equal(record.identity.name,'新名字');assert.equal(record.identity.pet_id,IDS[0]);assert.equal(record.actor.definition,'hajimi');
  assert.ok(IDS.slice(1,5).every(id=>env.manager.records.get(id).identity.name==='同名'));
});

test('restart restores only authenticated owner combination; recall-all and restore preserve hidden IDs',async t=>{
  const {createLayoutStore}=require('../src/p85-layout-store.cjs'),store=createLayoutStore();
  const first=environment(t,{layoutStore:store});for(const id of IDS.slice(0,3))await first.manager.release(id);await first.manager.hide(IDS[1]);await first.manager.stop();
  assert.equal(store.get(OWNER_A).current.length,3);
  const next=environment(t,{layoutStore:store});await next.manager.start();await next.manager.syncSession();
  assert.deepEqual([...next.manager.records.keys()],IDS.slice(0,3));assert.equal(next.manager.records.get(IDS[1]).hidden,true);
  await next.manager.recallAll(OWNER_A);assert.equal(next.manager.records.size,0);assert.equal(next.manager.layoutState().previous_count,3);
  await next.manager.restoreCombination(OWNER_A);assert.equal(next.manager.records.size,3);
  next.changeOwner(OWNER_B);await next.manager.syncSession();assert.equal(next.manager.records.size,0);assert.equal(next.manager.layoutState().previous_count,0);
  await assert.rejects(next.manager.restoreCombination(OWNER_A),{code:'SESSION_CHANGED'});
  next.changeOwner(OWNER_A);await next.manager.syncSession();assert.equal(next.manager.records.size,3);
});

test('stale global controls and chat renderers cannot recall a different owner combination',async t=>{
  const env=environment(t);await env.manager.start();await env.manager.release(IDS[0]);
  const old=env.manager.trayMenu.getMenuItemById('recall-all');
  env.changeOwner(OWNER_B);env.pets.get(IDS[1]).owner=OWNER_B;await env.manager.release(IDS[1]);
  old.click();await new Promise(setImmediate);assert.equal(env.manager.records.size,1);
  assert.equal((await env.invoke(env.manager.mainWindow,'desktop:recallAll',OWNER_A)).error.code,'SESSION_CHANGED');
  await env.manager.openChat(IDS[1]);const chat=env.manager.records.get(IDS[1]).chatWindow;
  assert.equal((await env.invoke(chat,'desktop:recallAll',OWNER_B)).error.code,'INVALID_SCOPE');assert.equal(env.manager.records.size,1);
});

test('archived saved instances are skipped while valid siblings restore without retry loops',async t=>{
  const {createLayoutStore}=require('../src/p85-layout-store.cjs'),store=createLayoutStore();
  store.set(OWNER_A,{current:IDS.slice(0,2).map(pet_id=>({pet_id,hidden:false}))});
  const env=environment(t,{layoutStore:store});env.pets.get(IDS[0]).status='archived';await env.manager.syncSession();
  assert.equal(env.manager.records.has(IDS[0]),false);assert.equal(env.manager.records.has(IDS[1]),true);
  assert.equal(env.manager.layoutState().skipped_count,1);const window=env.manager.records.get(IDS[1]).window;await env.manager.syncSession();assert.equal(env.manager.records.get(IDS[1]).window,window);
});

test('resource pressure refuses new allocations but preserves existing chat and recall paths',async t=>{
  const {createResourceMonitor,HIGH_KIB}=require('../src/p85-resources.cjs');let amount=100;
  const monitor=createResourceMonitor(()=>[{memory:{privateBytes:amount},cpu:{percentCPUUsage:0}}]);
  const env=environment(t,{resourceMonitor:monitor});await env.manager.release(IDS[0]);await env.manager.openChat(IDS[0]);const chat=env.manager.records.get(IDS[0]).chatWindow;
  amount=HIGH_KIB;await assert.rejects(env.manager.release(IDS[1]),{code:'RESOURCE_LIMIT'});
  await env.manager.openChat(IDS[0]);assert.equal(env.manager.records.get(IDS[0]).chatWindow,chat);
  await env.manager.recallAll(OWNER_A);assert.equal(env.manager.records.size,0);
  amount=100;await env.manager.restoreCombination(OWNER_A);assert.equal(env.manager.records.size,1);
});

test('an account change during pending combination restore cannot resurrect old windows',async t=>{
  const env=environment(t);await env.manager.release(IDS[0]);await env.manager.recallAll(OWNER_A);
  let unblock;env.state.override=url=>url.endsWith('/pets/'+IDS[0])?new Promise(resolve=>{unblock=resolve;}):undefined;
  const pending=env.manager.restoreCombination(OWNER_A);await new Promise(setImmediate);assert.equal(typeof unblock,'function');
  env.changeOwner(OWNER_B);unblock(Response.json(env.pets.get(IDS[0])));
  await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(env.manager.records.size,0);
});
