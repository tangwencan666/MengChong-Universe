'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const policy = require('./policy.cjs');
const motion = require('./motion.cjs');
const { selectedAsset, validateLocalCharacter } = require('./local-character.cjs');
const layout = require('./display-layout.cjs');
const activity = require('./pet-activity.cjs');
const { registry } = require('./pet-registry.cjs');
const actions = require('./pet-actions.cjs');
const { createCoordinator, interactionStep } = require('./pet-coordinator.cjs');
const { createPreferences } = require('./pet-preferences.cjs');
const { createLayoutStore } = require('./p85-layout-store.cjs');
const { createResourceMonitor } = require('./p85-resources.cjs');
const { createSociety } = require('./p86-society.cjs');
const { createSocietyStore } = require('./p86-store.cjs');
const { createRecountStore } = require('./p863-recount-store.cjs');
const { eventFacts, makeCompanionContext } = require('./p863-context.cjs');
const { validateServiceProfile } = require('./service-profile.cjs');

const MAX_PETS = registry.maxVisible;
const PET_WIDTH = 188;
const PET_HEIGHT = 196;
const FETCH_LIMIT = 512 * 1024;
const DRAG_LEASE_MS = 10000;
const EXPORT_LIMIT = 10 * 1024 * 1024;
const MAIN_PARK_AFTER_MS = 60000;

function createManager({ electron, origin: requestedOrigin, assetOrigin: requestedAssetOrigin, serviceProfile, rootDir, now = Date.now, localCharacter, positionStore, diagnostics, onSupport, behaviorStore, layoutStore, resourceMonitor }) {
  const { BrowserWindow, session: sessionModule, ipcMain, screen, Tray, Menu, nativeImage, app } = electron;
  const profile = validateServiceProfile(serviceProfile ?? { schema: 'weibiye-service/1', mode: 'local', origin: null });
  const origin = profile.mode === 'hosted' ? profile.origin : policy.origin(requestedOrigin);
  if (profile.mode === 'hosted' && requestedOrigin !== origin) throw policy.fail('INVALID_ORIGIN');
  const assetOrigin = policy.origin(requestedAssetOrigin ?? origin);
  const characterPreview = validateLocalCharacter(localCharacter);
  const suffix = randomUUID();
  // Both partitions are memory-only. Pet artwork has no authentication cookies.
  const uiSession = sessionModule.fromPartition(`weibiye-ui-${suffix}`, { cache: false });
  const petSession = sessionModule.fromPartition(`weibiye-pet-${suffix}`, { cache: false });
  const records = new Map();
  const societyStore = createSocietyStore(app.getPath?.('userData'));
  const recounts = createRecountStore(app.getPath?.('userData'));
  const contextNotifications = new WeakMap();
  let society = null, societyTimer = null, societyError = null;
  const societyStats = { wakes: 0, intents: 0, writes: 0 };
  const preferences = behaviorStore ?? createPreferences(app.getPath?.('userData'));
  const combinations = layoutStore ?? createLayoutStore(app.getPath?.('userData'));
  const resources = resourceMonitor ?? createResourceMonitor(() => app.getAppMetrics?.(), now);
  let restoredEpoch = -1, restoreSkipped = 0;
  const coordinator = createCoordinator();
  const actionStats = { transitions: 0, coordinated: 0, coordinatedMoves: 0, moves: 0, recoveries: 0 };
  const senders = new Map();
  const handlers = new Map();
  const bounds = screen.getPrimaryDisplay().workArea;
  const displays = () => {
    const primary = screen.getPrimaryDisplay();
    return (screen.getAllDisplays?.() ?? [{ id: 'primary', workArea: primary.workArea }])
      .sort((a, b) => Number(b.id === primary.id) - Number(a.id === primary.id));
  };
  const world = motion.createWorld({ bounds, displays: displays(), width: PET_WIDTH, height: PET_HEIGHT, now: now(), autonomous: false });
  const greeted = new Set();
  const preload = path.join(rootDir, 'src', 'preload.cjs');
  let ownerId = null;
  let epoch = 0;
  let stopped = false;
  let mainWindow;
  let mainHiddenAt = null;
  let parkPending = false;
  const parkingWindows = new WeakSet();
  let tray;
  let trayMenu;
  let lastContextMenu;
  let chain = Promise.resolve();
  let pollPending = false;
  let stopPromise;
  const controllers = new Set();
  const downloads = new Set();

  function queue(action) {
    const next = chain.then(() => {
      if (stopped) throw policy.fail('STOPPED', '桌面客户端正在退出。');
      return action();
    });
    chain = next.catch(() => {});
    return next;
  }

  function clearUiCache() {
    // Keep the new user's cookies after a switch, but never retain private cache.
    void Promise.allSettled([
      uiSession.clearCache(),
      uiSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] }),
    ]);
  }

  function closeSociety() {
    clearTimeout(societyTimer); societyTimer = null;
    if (society) { society.stop(now()); try { societyStore.save(society.owner, society.export()); } catch { /* Never overwrite invalid state. */ } }
    society = null; societyError = null;
  }
  function socialResponse() {
    return {owner_id:ownerId,available:Boolean(society&&societyStore.healthy&&!societyError),error:societyError,state:society&&!societyError&&society.owner===ownerId?society.view(ownerId,now()):null};
  }
  function publishSociety() {
    if(mainWindow&&!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('weibiye:society-state',socialResponse());
      const match=policy.localURL(mainWindow.webContents.getURL(),origin)?.pathname.match(/^\/pets\/([a-f0-9-]{36})(?:\/chat\/[a-f0-9-]{36})?$/);
      if(match)notifyContext(mainWindow,match[1]);
    }
    for(const record of records.values())if(record.chatWindow&&!record.chatWindow.isDestroyed())notifyContext(record.chatWindow,record.identity.pet_id);
  }
  function notifyContext(win,id) {
    const own=!societyError&&society?.owner===ownerId?society.pet(ownerId,id,now()):null;
    const value={owner_id:ownerId,pet_id:id,mood:own?.mood??null,event_ids:own?society.eventsFor(ownerId,id).map(e=>e.id):[]};
    const key=JSON.stringify(value);
    if(contextNotifications.get(win)!==key){contextNotifications.set(win,key);win.webContents.send('weibiye:companion-context-changed',value);}
  }

  async function companionContext(entry,id,sessionId=null,mode='peek') {
    id=policy.petId(id);if(sessionId!==null)sessionId=policy.petId(sessionId);
    if(!['peek','recount'].includes(mode))throw policy.fail('INVALID_ACTION');
    const path=policy.localURL(entry.win.webContents.getURL(),origin)?.pathname;
    if(path!==(sessionId?`/pets/${id}/chat/${sessionId}`:`/pets/${id}`)||entry.record&&entry.record.identity.pet_id!==id)throw policy.fail('INVALID_TARGET');
    const identity=await checkPet(id),version=epoch,owner=identity.owner_id;
    if(sessionId){const value=await json(`/api/v1/pets/${id}/sessions/${sessionId}`);if(value.session?.id!==sessionId||value.pet_id!==id)throw policy.fail('INVALID_TARGET');}
    const instance=await json('/api/v1/pet-instances/'+id);
    const view=!societyError&&society?.owner===owner?society.view(owner,now()):null;
    const events=view?.pets.some(p=>p.id===id)?society.eventsFor(owner,id):[];
    const facts=view?eventFacts({owner,pet:id,view,events,at:now()}):[];
    const names={};for(const peer of new Set(facts.slice(0,3).flatMap(e=>e.participant_ids).filter(peer=>peer!==id))){
      try{const value=policy.identity(owner,await json('/api/v1/pets/'+peer));if(value.pet_id===peer)names[peer]=value.name;}catch{ /* Unverified peers never enter a narrative. */ }
    }
    if(epoch!==version||ownerId!==owner||entry.win.isDestroyed()||policy.localURL(entry.win.webContents.getURL(),origin)?.pathname!==path)throw policy.fail('SESSION_CHANGED');
    const ids=new Set(facts.slice(0,3).filter(e=>e.participant_ids.every(peer=>peer===id||Object.hasOwn(names,peer))).map(e=>e.event_id));
    return makeCompanionContext({owner,pet:id,sessionId,instance,view,events:events.filter(e=>ids.has(e.id)),names,at:now(),mode,ledger:recounts});
  }
  function presence(record) {
    if(!society||record.window?.isDestroyed()||record.identity.owner_id!==society.owner)return;
    const p=world.pets.get(record.identity.pet_id);if(!p)return;
    const emotional=activity.view(record.activity,now()),display=layout.nearest(world.displayAreas,p,PET_WIDTH,PET_HEIGHT);
    society.setPresence({id:record.identity.pet_id,species:record.identity.definition_id,visible:!record.hidden,available:!record.drag&&!['thinking','speaking'].includes(emotional.activity)&&record.actor.priority<90,random:record.actor.preferences.random&&!resources.state.reduced_motion,autoMove:record.actor.preferences.autoMove,display:display.id,x:p.x,y:p.y},now());
  }
  function socialAutonomous(record) {
    return !society||societyError?true:society.autonomous(record.identity.pet_id,now());
  }
  function persistSociety() {
    if(!society)return;
    if(!societyStore.save(society.owner,society.export()))societyError='社会状态保存失败，社交已暂停。原文件已保留。';
    else societyStats.writes++;
  }
  function scheduleSociety() {
    clearTimeout(societyTimer);societyTimer=null;
    if(stopped||!society||societyError||![...records.values()].some(r=>!r.hidden))return;
    const background=societyBackground();
    const wait=society.nextWake(now(),background),version=epoch;
    if(wait===null)return;
    societyTimer=setTimeout(()=>{societyTimer=null;void queue(async()=>{if(epoch!==version)return;const auth=await checkOwner();await checkDesktopPets(auth);tickSociety();}).catch(()=>{});},wait);
    societyTimer.unref?.();
  }
  function tickSociety() {
    if(!society||societyError||stopped)return;
    for(const r of records.values())presence(r);
    const background=societyBackground();
    const intents=society.advance(now(),{background});societyStats.wakes++;
    for(const value of intents){
      const r=records.get(value.pet);if(!r||r.hidden||r.drag||r.actor.priority>=90)continue;
      const action=value.action==='look'&&value.toward&&r.actor.preferences.autoMove?'follow':value.action;
      if(actions.start(r.actor,action,now())){
        societyStats.intents++;
        if(value.toward)actionStats.coordinated++;
        if(value.toward&&r.actor.preferences.autoMove){const self=world.pets.get(value.pet),other=world.pets.get(value.toward),point=interactionStep(action==='evade'?'evade':'follow',self,other);if(point){r.actor.motion=r.actor.sequence;for(const factor of [1,.5,.25,.125])if(motion.moveTo(world,value.pet,{x:self.x+(point.x-self.x)*factor,y:self.y+(point.y-self.y)*factor},30)){actionStats.moves++;actionStats.coordinatedMoves++;break;}}}
      }
    }
    for(const r of records.values())sendPetState(r);
    persistSociety();publishSociety();scheduleSociety();
  }
  function societyBackground(){return !mainWindow||mainWindow.isDestroyed()||!(typeof mainWindow.isFocused==='function'?mainWindow.isFocused():mainWindow.isVisible());}
  async function socialState(expectedOwner) {
    const auth=await combinationAuth(expectedOwner);if(society?.owner!==auth.id&&!societyError)throw policy.fail('SESSION_CHANGED');return socialResponse();
  }
  async function socialInteract(expectedOwner,id,action,request,revision) {
    const auth=await combinationAuth(expectedOwner);await checkPet(id);
    if(!society||societyError||society.owner!==auth.id)throw policy.fail('SOCIETY_UNAVAILABLE','本地社交暂不可用，聊天仍可正常使用。');
    try{society.interact(auth.id,id,action,request,revision??society.view(auth.id,now()).revision,now());}
    catch{throw policy.fail('SOCIAL_ACTION_REJECTED','状态已变化或此互动已结束，请刷新后再试。');}
    tickSociety();return socialResponse();
  }
  async function socialConfigure(expectedOwner,patch) {
    await combinationAuth(expectedOwner);if(!society||societyError)throw policy.fail('SOCIETY_UNAVAILABLE');
    try{society.configure(ownerId,patch,now());}catch{throw policy.fail('INVALID_SOCIAL_SETTINGS');}
    if(patch.quiet_until>now()||patch.enabled===false)for(const r of records.values()){motion.stopMotion(world,r.identity.pet_id);actions.tick(r.actor,now(),{reducedMotion:true,autonomous:false});}
    tickSociety();return socialResponse();
  }

  function forgetRecord(id) {
    const record = records.get(id);
    if (!record) return;
    society?.remove(id,now());
    rememberPosition(record);
    rememberBehavior(record);actions.dispose(record.actor);preferences.flush();
    records.delete(id);
    if (!stopped && ownerId === record.identity.owner_id) rememberLayout();
    motion.removePet(world, id);
    record.drag = null;
    for (const win of [record.chatWindow, record.window]) {
      if (!win || win.isDestroyed()) continue;
      senders.delete(win.webContents.id);
      win.destroy();
    }
    emit();
    refreshTray();
    persistSociety();scheduleSociety();publishSociety();
  }

  function invalidate(nextOwner = null) {
    closeSociety();
    epoch += 1;
    ownerId = nextOwner;
    coordinator.clear();
    restoreSkipped = 0;
    for (const item of [...downloads]) item.cancel();
    for (const controller of controllers) controller.abort();
    for (const id of [...records.keys()]) forgetRecord(id);
    clearUiCache();
    emit();
  }

  async function json(apiPath) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 3000);
    timeout.unref?.();
    try {
      const response = await uiSession.fetch(`${origin}${apiPath}`, {
        method: 'GET', credentials: 'include', cache: 'no-store',
        redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' },
      });
      if (response.status === 401) throw policy.fail('UNAUTHENTICATED', '请先登录萌宠溜达。');
      if (!response.ok) throw policy.fail(response.status === 404 ? 'PET_UNAVAILABLE' : 'API_UNAVAILABLE');
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > FETCH_LIMIT) throw policy.fail('RESPONSE_LIMIT');
      const reader = response.body?.getReader();
      if (!reader) throw policy.fail('INVALID_RESPONSE');
      let count = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > FETCH_LIMIT) { await reader.cancel(); throw policy.fail('RESPONSE_LIMIT'); }
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw policy.fail('INVALID_RESPONSE'); }
    } catch (error) {
      if (error?.desktopSafe === true) throw error;
      throw policy.fail('NETWORK_UNAVAILABLE', '本机服务暂时不可用，宠物已安全收回。');
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  async function checkOwner() {
    const initialEpoch = epoch;
    let user;
    try { user = await json('/api/v1/auth/me'); }
    catch (error) { invalidate(); throw error; }
    if (initialEpoch !== epoch) throw policy.fail('SESSION_CHANGED', '账户状态已更新，请重试。');
    if (!policy.UUID.test(user?.id ?? '') || user.status !== 'active') {
      invalidate(); throw policy.fail('UNAUTHENTICATED', '请重新登录萌宠溜达。');
    }
    const id = user.id.toLowerCase();
    const changed = ownerId !== id;
    if (changed) invalidate(id);
    if (!society && !societyError) {
      const saved = societyStore.load(id);
      if (societyStore.healthy) {
        const seed = Number.parseInt(id.replaceAll('-', '').slice(-8), 16) || 1;
        society = createSociety({ owner:id, seed, now:now(), snapshot:saved });
        society.advance(now(), { background:true, resuming:true });
      } else societyError = '本地社会状态无法验证，社交暂不可用。聊天不受影响，原文件已保留。';
    }
    return { id, changed, epoch };
  }

  async function checkPet(id, expectedRecord, checkedAuth) {
    id = policy.petId(id);
    const auth = checkedAuth ?? await checkOwner();
    if (auth.epoch !== epoch || ownerId !== auth.id) throw policy.fail('SESSION_CHANGED');
    if (expectedRecord && (records.get(id) !== expectedRecord || expectedRecord.identity.owner_id !== auth.id)) {
      throw policy.fail('SESSION_CHANGED', '这只宠物的桌面状态已更新。');
    }
    let pet;
    try { pet = await json(`/api/v1/pets/${id}`); }
    catch (error) {
      if (error.code === 'PET_UNAVAILABLE') forgetRecord(id);
      else invalidate();
      throw error;
    }
    if (auth.epoch !== epoch || ownerId !== auth.id) throw policy.fail('SESSION_CHANGED');
    let value;
    try { value = policy.identity(auth.id, pet); }
    catch (error) { forgetRecord(id); throw error; }
    if (value.pet_id !== id) { forgetRecord(id); throw policy.fail('INVALID_RESPONSE'); }
    const identity = Object.freeze({ ...value, definition_id: registry.resolve(pet.appearance_config?.asset_id, pet.role_type).id,appearance_id:registry.appearance(pet.appearance_config?.asset_id,pet.role_type)?.appearance_id });
    if (expectedRecord) refreshIdentity(expectedRecord, identity);
    return identity;
  }

  function refreshIdentity(record, identity) {
    const previous=record.identity;
    if(previous.definition_id!==identity.definition_id){
      const next=actions.createActor(identity.definition_id,now(),{preferences:actions.saved(record.actor)});
      next.sequence=record.actor.sequence+1;actions.dispose(record.actor);record.actor=next;
    }
    record.identity=identity;
    if(previous.name!==identity.name||previous.tint!==identity.tint||previous.definition_id!==identity.definition_id||previous.appearance_id!==identity.appearance_id){
      record.window.setTitle?.(identity.name);
      record.chatWindow?.setTitle?.(`与${identity.name}聊聊 · 萌宠溜达`);
      sendPetState(record);emit();refreshTray();
    }
  }

  async function checkDesktopPets(auth) {
    const current=[...records.values()];
    if(current.length<2){for(const record of current)await checkPet(record.identity.pet_id,record,auth);return;}
    // The server filters this list by the authenticated owner. One current list
    // proves every matching sprite; hidden/paginated/absent pets retain the
    // authoritative individual check. No cached authorization crosses a poll.
    let page;
    try { page=await json('/api/v1/pets?status=active&limit=30'); }
    catch(error){invalidate();throw error;}
    if(auth.epoch!==epoch||ownerId!==auth.id)throw policy.fail('SESSION_CHANGED');
    if(!Array.isArray(page?.items)||page.items.length>30||typeof page.has_more!=='boolean'){
      invalidate();throw policy.fail('INVALID_RESPONSE');
    }
    const byId=new Map();
    for(const pet of page.items){
      if(!policy.UUID.test(pet?.pet_id??'')||byId.has(pet.pet_id)){invalidate();throw policy.fail('INVALID_RESPONSE');}
      byId.set(pet.pet_id,pet);
    }
    for(const record of current){
      if(auth.epoch!==epoch||ownerId!==auth.id)throw policy.fail('SESSION_CHANGED');
      const id=record.identity.pet_id,pet=byId.get(id);
      if(records.get(id)!==record||record.identity.owner_id!==auth.id)throw policy.fail('SESSION_CHANGED');
      if(!pet){await checkPet(id,record,auth);continue;}
      try { const value=policy.identity(auth.id,pet);if(value.pet_id!==id)throw policy.fail('INVALID_RESPONSE');
        refreshIdentity(record,Object.freeze({...value,definition_id:registry.resolve(pet.appearance_config?.asset_id,pet.role_type).id,appearance_id:registry.appearance(pet.appearance_config?.asset_id,pet.role_type)?.appearance_id})); }
      catch(error){forgetRecord(id);throw error;}
    }
  }

  function snapshot(record) {
    const position = motion.snapshot(world, record.identity.pet_id);
    return { pet_id: record.identity.pet_id, name: record.identity.name,
      role_type: record.identity.role_type, tint: record.identity.tint,
      state: position?.state ?? 'idle', direction: position?.direction ?? 'right',
      hidden: record.hidden, chat_open: Boolean(record.chatWindow && !record.chatWindow.isDestroyed()) };
  }

  function localState() {
    // Invalidation destroys windows one at a time. Never label a remaining old
    // record with the new owner (or an unauthenticated scope) in an interim IPC.
    return { authenticated: Boolean(ownerId), owner_id: ownerId,
      pets: ownerId ? [...records.values()]
        .filter((record) => record.identity.owner_id === ownerId).map(snapshot) : [] };
  }

  function emit() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('weibiye:desktop-state', localState());
  }

  function sendPetState(record) {
    if (record.window.isDestroyed()) return;
    const value = snapshot(record);
    const { hidden: _hidden, chat_open: _open, ...publicState } = value;
    record.window.webContents.send('weibiye:pet-state', petAppearance(record, publicState));
  }

  function petAppearance(record, value) {
    const asset = selectedAsset(characterPreview, record.identity, ownerId);
    const emotional = activity.view(record.activity, now());
    const frame = actions.tick(record.actor, now(), { hidden:record.hidden, dragging:Boolean(record.drag),activity:emotional.activity,reducedMotion:resources.state.reduced_motion,autonomous:socialAutonomous(record) });
    return { ...value, ...emotional, ...frame, definition_id:record.identity.definition_id,appearance_id:record.identity.appearance_id,
      social:!societyError?society?.pet(ownerId,record.identity.pet_id,now())??null:null,
      ...(asset ? { asset_id: asset } : {}) };
  }
  function greetPet(record,timestamp){
    if(activity.greet(record.activity,record.identity.role_type,timestamp)
      && !['moon','doubao','xiaoyun'].includes(record.actor.definition)){
      record.activity.greeting=registry.get(record.actor.definition).greeting;
    }
  }

  function basePreferences(targetSession, role) {
    return { session: targetSession, preload, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, navigateOnDragDrop: false,
      safeDialogs: true, spellcheck: false, backgroundThrottling: true, additionalArguments: [`--weibiye-role=${role}`] };
  }

  function registerWindow(win, role, record) {
    const entry = { win, role, record };
    const senderId = win.webContents.id;
    senders.set(senderId, entry);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    const permitted = (url) => role === 'pet'
      ? policy.localURL(url, assetOrigin)?.pathname === '/__pet/pet.html'
      : policy.uiNavigation(url, origin, role === 'chat' ? record.identity.pet_id : undefined);
    win.webContents.on('will-navigate', (event, url) => { if (!permitted(url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!permitted(url)) event.preventDefault(); });
    win.webContents.on('did-navigate-in-page', (_event, url) => {
      if (!permitted(url)) {
        if (role === 'chat') win.destroy();
        else if (role === 'main') void win.loadURL(`${origin}/companions`);
        return;
      }
      if (role === 'chat') record.lastScopedChatURL = url;
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (parkingWindows.has(win)) return;
      diagnostics?.write('renderer_gone', { role: role === 'ui' ? 'main' : role,
        reason: ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'].includes(details?.reason) ? details.reason : 'unknown' });
      if (role === 'pet' || role === 'chat') forgetRecord(record.identity.pet_id);
      else { invalidate(); if (!win.isDestroyed()) win.destroy(); }
    });
    win.on('closed', () => {
      senders.delete(senderId);
      if (role === 'pet' && records.get(record.identity.pet_id) === record) forgetRecord(record.identity.pet_id);
      else if (role === 'chat' && record.chatWindow === win) {
        record.chatWindow = null;
        // Closing a view does not cancel its backend generation. Stop showing
        // an unobserved activity; reopening will reconcile the saved chat.
        if (records.get(record.identity.pet_id) === record) {
          record.activity = activity.createActivity(now());
          sendPetState(record); emit();
        }
      }
    });
    return win;
  }

  function checkSender(event, role) {
    const entry = senders.get(event?.sender?.id);
    if (!entry || entry.win.isDestroyed() || event.senderFrame !== event.sender.mainFrame
      || (role === 'pet' ? entry.role !== 'pet' : !['main', 'chat'].includes(entry.role))) {
      throw policy.fail('INVALID_SENDER');
    }
    const url = event.senderFrame.url;
    const valid = entry.role === 'pet'
      ? policy.localURL(url, assetOrigin)?.pathname === '/__pet/pet.html'
      : policy.uiNavigation(url, origin, entry.role === 'chat' ? entry.record.identity.pet_id : undefined);
    if (!valid) throw policy.fail('INVALID_SENDER');
    if (entry.record && (records.get(entry.record.identity.pet_id) !== entry.record
      || entry.record.identity.owner_id !== ownerId)) throw policy.fail('SESSION_CHANGED');
    return entry;
  }

  function safeHandle(channel, role, action, { direct = false } = {}) {
    const handler = async (event, ...args) => {
      try {
        const entry = checkSender(event, role);
        const work = () => {
          checkSender(event, role);
          return action(entry, ...args);
        };
        const value = await (direct ? work() : queue(work));
        return { ok: true, value };
      } catch (error) {
        const known = error?.desktopSafe === true && /^[A-Z_]+$/.test(error.code);
        return { ok: false, error: { code: known ? error.code : 'UNAVAILABLE',
          message: known ? error.message : '暂时无法完成桌面操作。' } };
      }
    };
    handlers.set(channel, handler);
    ipcMain.handle(channel, handler);
  }

  const visiblePetCount = () => [...records.values()].filter(record => !record.hidden).length;
  function requireVisibleSlot(record) {
    if ((!record || record.hidden) && visiblePetCount() >= MAX_PETS)
      throw policy.fail('PET_LIMIT', `目前可以同时显示${MAX_PETS}只宠物，请先隐藏或收回一只。`);
  }

  async function release(id) {
    const value = await checkPet(id);
    id = value.pet_id;
    const existing = records.get(id);
    requireVisibleSlot(existing);
    if (existing) { existing.hidden = false; motion.setVisibility(world, id, true);sendPetState(existing);existing.window.showInactive();rememberLayout();emit();return snapshot(existing); }
    if (records.size >= MAX_PETS) {
      // A hidden sprite is a disposable window cache, not an adoption slot.
      // Keep open chat windows, including unsent drafts, entirely untouched.
      const cached = [...records.values()].find(record => record.hidden && (!record.chatWindow || record.chatWindow.isDestroyed()));
      if (cached) forgetRecord(cached.identity.pet_id);
    }
    requireResources();
    let position;
    try {
      motion.setDisplays(world, displays());
      const saved = positionStore?.get(value.owner_id, id);
      position = motion.spawnPet(world, id, layout.restore(saved, world.displayAreas, PET_WIDTH, PET_HEIGHT));
    } catch { throw policy.fail('PET_SPACE', '当前显示区域放不下更多宠物，请先收回一只。'); }
    const record = { identity: value, window: null, chatWindow: null, hidden: false,
      actor: actions.createActor(value.definition_id,now(),{preferences:preferences.get(value.owner_id,id)}),
      drag: null, activity: activity.createActivity(now()), lastScopedChatURL: `${origin}/pets/${id}` };
    const greetingKey = value.owner_id + ':' + id;
    if (!greeted.has(greetingKey)) {
      greetPet(record, now());
      greeted.add(greetingKey);
      if (greeted.size > 128) greeted.delete(greeted.values().next().value);
    }
    const win = new BrowserWindow({ title: value.name, width: PET_WIDTH, height: PET_HEIGHT,
      x: position.x, y: position.y, transparent: true, frame: false, alwaysOnTop: true,
      thickFrame: false,
      skipTaskbar: true, resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
      webPreferences: basePreferences(petSession, 'pet') });
    record.window = win;
    records.set(id, record);
    presence(record);
    registerWindow(win, 'pet', record);
    win.once('ready-to-show', () => {
      if (!stopped && records.get(id) === record && !record.hidden && record.identity.owner_id === ownerId) win.showInactive();
    });
    try { await win.loadURL(`${assetOrigin}/__pet/pet.html`); }
    catch { forgetRecord(id); throw policy.fail('PET_LOAD_FAILED', '宠物窗口暂时无法打开。'); }
    if (records.get(id) !== record || ownerId !== value.owner_id) throw policy.fail('SESSION_CHANGED');
    rememberLayout();emit(); refreshTray();persistSociety();scheduleSociety();publishSociety(); return snapshot(record);
  }

  function requireRecord(id) {
    const record = records.get(policy.petId(id));
    if (!record) throw policy.fail('PET_NOT_RELEASED', '请先把这只宠物放到桌面。');
    return record;
  }

  async function withRecord(id, action) {
    id = policy.petId(id);
    const record = requireRecord(id);
    await checkPet(id, record);
    const value = action(record);
    emit(); refreshTray(); return value;
  }

  async function openChat(id) {
    id = policy.petId(id);
    return withRecord(id, (record) => {
      actions.start(record.actor, registry.get(record.actor.definition).click, now(), {direct:true});sendPetState(record);
      if (record.chatWindow && !record.chatWindow.isDestroyed()) {
        record.chatWindow.show(); record.chatWindow.focus(); return snapshot(record);
      }
      requireResources();
      const win = new BrowserWindow({ title: `与${record.identity.name}聊聊 · 萌宠溜达`,
        width: 1080, height: 780, minWidth: 420, minHeight: 520, show: false,
        backgroundColor: '#eaf4ff', webPreferences: basePreferences(uiSession, 'chat') });
      record.chatWindow = win;
      registerWindow(win, 'chat', record);
      win.once('ready-to-show', () => { if (!win.isDestroyed() && records.get(id) === record) win.show(); });
      void win.loadURL(record.lastScopedChatURL).catch(() => { if (!win.isDestroyed()) win.destroy(); });
      return snapshot(record);
    });
  }

  const hide = (id) => withRecord(id, (record) => {
    rememberPosition(record); positionStore?.flush();
    record.hidden = true; record.drag = null;sendPetState(record);
    motion.setVisibility(world, record.identity.pet_id, false); record.window.hide();presence(record);persistSociety();scheduleSociety();publishSociety();rememberLayout();return snapshot(record);
  });
  const show = (id) => withRecord(id, (record) => {
    requireVisibleSlot(record);
    record.hidden = false; motion.setVisibility(world, record.identity.pet_id, true);sendPetState(record);
    record.window.showInactive();presence(record);scheduleSociety();rememberLayout();return snapshot(record);
  });
  const recall = (id) => withRecord(id, (record) => { forgetRecord(record.identity.pet_id); return null; });

  async function syncSession() {
    try {
      const auth = await checkOwner();
      if(restoredEpoch!==auth.epoch){
        restoredEpoch=auth.epoch;
        if(records.size===0)await restoreSaved(auth,combinations.get(auth.id).current);
      }
      await checkDesktopPets(auth);
      emit(); return { authenticated: true, owner_id: auth.id, changed: auth.changed };
    } catch (error) {
      if (error.code === 'UNAUTHENTICATED') return { authenticated: false, owner_id: null, changed: true };
      throw error;
    }
  }

  function showMain() {
    if (stopped) return;
    mainHiddenAt = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      const win = createMainWindow();
      diagnostics?.write('ui_restored', { role: 'main' });
      void win.loadURL(`${origin}/companions`).catch(() => { if (!win.isDestroyed()) win.destroy(); });
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }

  function runTray(action) { void queue(action).catch(() => emit()); }

  function refreshTray() {
    if (!tray || stopped) return;
    const menuOwner=ownerId;
    trayMenu = Menu.buildFromTemplate([
      { id: 'show-main', label: '显示主界面', click: showMain },
      { id:'social-quiet',label:'全部安静十分钟',enabled:Boolean(menuOwner),click:()=>runTray(()=>socialConfigure(menuOwner,{quiet_until:now()+600000})) },
      ...(onSupport ? [{ id: 'support', label: '连接帮助与反馈', click: onSupport }] : []),
      { id: 'show-all', label: '显示全部宠物', enabled: records.size > 0,
        click: () => runTray(async () => { for (const id of [...records.keys()]) await show(id); }) },
      { id: 'hide-all', label: '隐藏全部宠物', enabled: records.size > 0,
        click: () => runTray(async () => { for (const id of [...records.keys()]) await hide(id); }) },
      ...[...records.values()].map((record) => ({ label: record.identity.name, submenu: [
        { label: '打开聊天', click: () => runTray(() => openChat(record.identity.pet_id)) },
        { label: record.hidden ? '显示这只宠物' : '隐藏这只宠物',
          click: () => runTray(() => record.hidden ? show(record.identity.pet_id) : hide(record.identity.pet_id)) },
        { label: '收回这只宠物', click: () => runTray(() => recall(record.identity.pet_id)) },
      ] })),
      { id: 'recall-all', label: '收回全部宠物', enabled: records.size > 0,
        click: () => runTray(() => recallAll(menuOwner)) },
      { id:'restore-combination',label:'恢复上次桌面组合',enabled:Boolean(menuOwner&&records.size===0&&combinations.get(menuOwner).previous.length),
        click:()=>runTray(()=>restoreCombination(menuOwner)) },
      ...(resources.state.reduced_motion?[{label:'资源保护：暂停随机互动与新增窗口',enabled:false}]:[]),
      { type: 'separator' },
      { id: 'quit', label: '退出萌宠溜达', click: () => app.quit() },
    ]);
    tray.setContextMenu(trayMenu);
  }

  function petMenu(record) {
    const id = record.identity.pet_id;
    const socialOwner=record.identity.owner_id;
    const interactions=[['pet','轻轻抚摸（免费）'],['comfort','安慰一下（免费）'],['chicken','免费鸡腿'],['fish','免费小鱼干'],['toy','免费玩具'],['blanket','免费小毯子'],['mediate','调解当前冲突'],['support','支持这只宠物']].map(([action,label])=>{
      const key=randomUUID();return {id:'social-'+action,label,click:()=>runTray(()=>socialInteract(socialOwner,id,action,key,null))};
    });
    const menu = Menu.buildFromTemplate([
      { label: '打开聊天', click: () => runTray(() => openChat(id)) },
      ...interactions,
      {id:'social-profile',label:'查看心情与关系',click:showMain},
      ...registry.get(record.actor.definition).menu.map(action=>({
        id:'action-'+action,label:registry.action(action).label,
        click:()=>runTray(()=>playAction(id,action)),
      })),
      {id:'random',label:'允许随机互动',type:'checkbox',checked:record.actor.preferences.random,
        click:item=>runTray(()=>configurePet(id,{random:item.checked}))},
      {id:'auto-move',label:'允许低频自主移动',type:'checkbox',checked:record.actor.preferences.autoMove,
        click:item=>runTray(()=>configurePet(id,{autoMove:item.checked}))},
      { label: '隐藏这只宠物', click: () => runTray(() => hide(id)) },
      { label: '收回这只宠物', click: () => runTray(() => recall(id)) },
      { type: 'separator' }, { label: '显示主界面', click: showMain },
    ]);
    lastContextMenu = menu;
    menu.popup({ window: record.window });
    return null;
  }

  function restrictSession(target, petOnly) {
    target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
    target.on('will-download', (event, item, contents) => {
      // Preserve P4's explicit JSON export, with the native Save dialog. No
      // renderer receives file-system APIs, save paths or a general downloader.
      let entry;
      let selectedPet;
      try {
        if (petOnly || !item || !contents || !ownerId) throw policy.fail('EXPORT_DENIED');
        entry = checkSender({ sender: contents, senderFrame: contents.mainFrame }, 'ui');
        const page = policy.localURL(contents.mainFrame.url, origin)?.pathname;
        const feedback = page === '/beta' && entry.role === 'main';
        const match = /^\/pets\/([^/]+)\/memory$/.exec(page ?? '');
        if (page !== '/memory' && !match && !feedback) throw policy.fail('EXPORT_DENIED');
        selectedPet = match ? checkTarget(entry, match[1]) : null;
        const url = new URL(item.getURL());
        if (url.protocol !== 'blob:' || url.origin !== origin
          || !(feedback ? item.getFilename() === 'weibiye-beta-feedback-v1.json' : /^weibiye-memories-\d{4}-\d{2}-\d{2}\.json$/.test(item.getFilename()))
          || item.getMimeType().split(';')[0].trim().toLowerCase() !== 'application/json'
          || !Number.isFinite(item.getTotalBytes()) || item.getTotalBytes() < 0
          || item.getTotalBytes() > (feedback ? 16384 : EXPORT_LIMIT)) throw policy.fail('EXPORT_DENIED');
        const downloadEpoch = epoch;
        const downloadOwner = ownerId;
        item.pause();
        item.setSaveDialogOptions({ title: feedback ? '保存最小反馈单' : '导出你授权的记忆',
          filters: [{ name: 'JSON 记忆文件', extensions: ['json'] }] });
        downloads.add(item);
        item.once('done', () => downloads.delete(item));
        item.on('updated', () => {
          if (epoch !== downloadEpoch || ownerId !== downloadOwner || entry.win.isDestroyed()) item.cancel();
          if (item.getTotalBytes() > (feedback ? 16384 : EXPORT_LIMIT)
            || (item.getReceivedBytes?.() ?? 0) > (feedback ? 16384 : EXPORT_LIMIT)) item.cancel();
        });
        void queue(async () => {
          if (selectedPet) await checkPet(selectedPet, entry.record);
          else await checkOwner();
          if (epoch !== downloadEpoch || ownerId !== downloadOwner || entry.win.isDestroyed()) throw policy.fail('SESSION_CHANGED');
          item.resume();
        }).catch(() => item.cancel());
      } catch { event.preventDefault(); }
    });
    target.webRequest.onBeforeRequest((details, callback) => {
      const local = policy.localURL(details.url, origin);
      callback({ cancel: petOnly ? !policy.petResource(details.url, assetOrigin) : !local });
    });
  }
  restrictSession(uiSession, false);
  restrictSession(petSession, true);

  const onCookieChanged = (_event, cookie) => {
    if (cookie?.name === 'weibiye_session' || cookie?.name === '__Host-weibiye_session') invalidate();
  };
  uiSession.cookies.on('changed', onCookieChanged);

  function createMainWindow() {
    const win = new BrowserWindow({ title: '萌宠溜达 · 我的 AI 宠物', width: 1160, height: 820,
      minWidth: 420, minHeight: 560, show: false, backgroundColor: '#eaf4ff',
      webPreferences: basePreferences(uiSession, 'ui') });
    win.setMenu?.(null);
    mainWindow = win;
    registerWindow(win, 'main');
    win.on('close', (event) => {
      if (!stopped && tray) { event.preventDefault(); mainHiddenAt ??= now(); win.hide(); }
    });
    win.on('show', () => { mainHiddenAt = null; });
    win.once('ready-to-show', () => { if (!stopped && mainWindow === win && mainHiddenAt === null) win.show(); });
    return win;
  }
  createMainWindow();

  async function sweepUiResources() {
    const win = mainWindow;
    if (stopped || parkPending || !ownerId || !win || win.isDestroyed() || win.isVisible()
      || mainHiddenAt === null || now() - mainHiddenAt < MAIN_PARK_AFTER_MS
      || controllers.size || downloads.size || win.webContents.isLoadingMainFrame()) return false;
    if (policy.localURL(win.webContents.getURL(), origin)?.pathname !== '/companions') return false;
    const version = epoch, hiddenAt = mainHiddenAt;
    parkPending = true;
    try {
      // Fixed read-only predicate; never inspect values or discard a draft/form.
      const safe = await win.webContents.executeJavaScript("location.pathname === '/companions' && !document.querySelector('input,textarea,form,[contenteditable=true],[role=dialog],[aria-modal=true]')");
      if (safe !== true || stopped || epoch !== version || mainWindow !== win || win.isDestroyed()
        || win.isVisible() || mainHiddenAt !== hiddenAt || controllers.size || downloads.size
        || win.webContents.isLoadingMainFrame()
        || policy.localURL(win.webContents.getURL(), origin)?.pathname !== '/companions') return false;
      parkingWindows.add(win); mainWindow = null; mainHiddenAt = null; win.destroy();
      diagnostics?.write('ui_parked', { role: 'main', petCount: records.size });
      return true;
    } catch { return false; }
    finally { parkPending = false; }
  }

  const image = nativeImage.createFromPath(path.join(rootDir, 'assets', 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('萌宠溜达 · 你的桌面 AI 宠物伙伴');
  tray.on('double-click', showMain);
  refreshTray();

  function checkTarget(entry, id) {
    const parsed = policy.petId(id);
    if (entry.role === 'chat' && entry.record.identity.pet_id !== parsed) throw policy.fail('INVALID_SCOPE');
    return parsed;
  }

  async function list() {
    const auth = await checkOwner();
    for (const record of [...records.values()]) await checkPet(record.identity.pet_id, record, auth);
    return [...records.values()].map(snapshot);
  }
  safeHandle('weibiye:desktop:list', 'ui', () => list());
  safeHandle('weibiye:desktop:syncSession', 'ui', () => syncSession());
  safeHandle('weibiye:desktop:society','ui',async(entry,owner)=>{mainOnly(entry);return socialState(owner);});
  safeHandle('weibiye:desktop:companionContext','ui',(entry,id,sessionId,mode)=>companionContext(entry,id,sessionId,mode));
  safeHandle('weibiye:desktop:socialAction','ui',(entry,owner,id,action,key,version)=>{mainOnly(entry);return socialInteract(owner,id,action,key,version);});
  safeHandle('weibiye:desktop:socialSettings','ui',(entry,owner,patch)=>{mainOnly(entry);return socialConfigure(owner,patch);});
  safeHandle('weibiye:desktop:deleteSocialEvent','ui',async(entry,owner,id)=>{mainOnly(entry);await combinationAuth(owner);if(!society)throw policy.fail('SOCIETY_UNAVAILABLE');society.deleteEvent(owner,id,now());tickSociety();return socialResponse();});
  safeHandle('weibiye:pet:sharedEvents','pet',async entry=>{await checkPet(entry.record.identity.pet_id,entry.record);return society?.eventsFor(ownerId,entry.record.identity.pet_id)??[];});
  function mainOnly(entry){if(entry.role!=='main'||entry.win!==mainWindow)throw policy.fail('INVALID_SCOPE');}
  safeHandle('weibiye:desktop:layout','ui',async entry=>{mainOnly(entry);await checkOwner();return layoutState();});
  safeHandle('weibiye:desktop:recallAll','ui',(entry,expectedOwner)=>{mainOnly(entry);return recallAll(expectedOwner);});
  safeHandle('weibiye:desktop:restoreCombination','ui',(entry,expectedOwner)=>{mainOnly(entry);return restoreCombination(expectedOwner);});
  for (const [name, action] of Object.entries({ release, hide, show, recall, openChat })) {
    safeHandle(`weibiye:desktop:${name}`, 'ui', (entry, id) => action(checkTarget(entry, id)));
  }
  safeHandle('weibiye:pet:identity', 'pet', async (entry) => {
    await checkPet(entry.record.identity.pet_id, entry.record);
    const { hidden: _hidden, chat_open: _open, ...value } = snapshot(entry.record);
    return petAppearance(entry.record, value);
  });
  safeHandle('weibiye:pet:chat', 'pet', (entry) => openChat(entry.record.identity.pet_id));
  safeHandle('weibiye:pet:menu', 'pet', async (entry) => {
    await checkPet(entry.record.identity.pet_id, entry.record); return petMenu(entry.record);
  });
  safeHandle('weibiye:desktop:activity', 'ui', (entry, id, signal) => {
    id = checkTarget(entry, id);
    const record = entry.record;
    const pathname = policy.localURL(entry.win.webContents.mainFrame.url, origin)?.pathname;
    if (entry.role !== 'chat' || !record || pathname !== `/pets/${id}/chat/${signal?.session_id}`) {
      throw policy.fail('INVALID_SCOPE');
    }
    try { activity.applySignal(record.activity, signal, now()); }
    catch { throw policy.fail('INVALID_ACTIVITY'); }
    presence(record);scheduleSociety();sendPetState(record); return null;
  }, { direct: true });
  function rememberPosition(record) {
    const point = world.pets.get(record.identity.pet_id);
    if (point) positionStore?.set(record.identity.owner_id, record.identity.pet_id,
      layout.capture(point, world.displayAreas, PET_WIDTH, PET_HEIGHT));
  }
  function rememberBehavior(record){preferences.set(record.identity.owner_id,record.identity.pet_id,actions.saved(record.actor));}
  function currentLayout(){
    const own=[...records.values()].filter(record=>record.identity.owner_id===ownerId);
    const selected=new Set(own.filter(record=>!record.hidden));
    for(const record of own)if(record.hidden&&selected.size<MAX_PETS)selected.add(record);
    return own.filter(record=>selected.has(record)).map(record=>({pet_id:record.identity.pet_id,hidden:record.hidden}));
  }
  function rememberLayout(){if(!stopped&&ownerId){combinations.set(ownerId,{current:currentLayout()});combinations.flush();}}
  function layoutState(){return {owner_id:ownerId,current:currentLayout().map(p=>p.pet_id),previous_count:ownerId?combinations.get(ownerId).previous.length:0,
    restore_available:Boolean(ownerId&&combinations.healthy&&combinations.get(ownerId).previous.length),reduced_motion:resources.state.reduced_motion,
    metrics_available:resources.state.metrics_available,max_visible:MAX_PETS,skipped_count:restoreSkipped};}
  function requireResources(){
    const count=BrowserWindow.getAllWindows?.().length??records.size+[...records.values()].filter(r=>r.chatWindow&&!r.chatWindow.isDestroyed()).length+(mainWindow&&!mainWindow.isDestroyed()?1:0);
    if(!resources.mayAllocate(count)){emit();refreshTray();throw policy.fail('RESOURCE_LIMIT','桌面资源占用较高，已暂停随机互动和新增窗口。可先收回宠物或关闭闲置聊天后再试。');}
  }
  async function restoreSaved(auth,saved){
    restoreSkipped=0;
    for(const item of saved){
      if(auth.epoch!==epoch||auth.id!==ownerId)throw policy.fail('SESSION_CHANGED');
      try{await release(item.pet_id);if(item.hidden)await hide(item.pet_id);}
      catch(error){if(auth.epoch!==epoch||auth.id!==ownerId)throw policy.fail('SESSION_CHANGED');if(!error?.desktopSafe)throw error;restoreSkipped++;}
    }
    if(auth.epoch!==epoch||auth.id!==ownerId)throw policy.fail('SESSION_CHANGED');
    rememberLayout();emit();refreshTray();return layoutState();
  }
  async function combinationAuth(expectedOwner){
    const expected=policy.petId(expectedOwner),initialEpoch=epoch;
    const auth=await checkOwner();
    if(auth.id!==expected||initialEpoch!==auth.epoch)throw policy.fail('SESSION_CHANGED');
    return auth;
  }
  async function recallAll(expectedOwner){
    const auth=await combinationAuth(expectedOwner),current=currentLayout();
    if(current.length){combinations.set(auth.id,{previous:current});combinations.flush();}
    for(const id of [...records.keys()])forgetRecord(id);
    rememberLayout();emit();refreshTray();return layoutState();
  }
  async function restoreCombination(expectedOwner){
    const auth=await combinationAuth(expectedOwner);
    if(records.size)throw policy.fail('RECALL_BEFORE_RESTORE','请先收回当前桌面组合，再恢复之前的组合。');
    return restoreSaved(auth,combinations.get(auth.id).previous);
  }
  function configurePet(id,value){return withRecord(id,record=>{
    const saved=actions.configure(record.actor,value);motion.stopMotion(world,id);
    rememberBehavior(record);preferences.flush();presence(record);scheduleSociety();sendPetState(record);return saved;
  });}
  function playAction(id,action){return withRecord(id,record=>{
    if(!registry.hasAction(action)||actions.BLOCKED.has(action))throw policy.fail('INVALID_ACTION');
    actions.tick(record.actor,now(),{hidden:record.hidden,dragging:Boolean(record.drag),activity:activity.view(record.activity,now()).activity});
    const changed=actions.start(record.actor,action,now(),{direct:true});
    rememberBehavior(record);preferences.flush();sendPetState(record);return changed;
  });}
  function placePet(record, x, y) {
    // setPosition can round-trip the native outer size on fractional Windows
    // DPI scales. Supply the immutable DIP size with every movement instead.
    record.window.setBounds({ x: Math.round(x), y: Math.round(y), width: PET_WIDTH, height: PET_HEIGHT }, false);
  }
  function moveDragPoint(record, position) {
    const next = motion.moveDrag(world, record.identity.pet_id, {
      x: position.x - record.drag.offsetX, y: position.y - record.drag.offsetY,
    });
    if (next) placePet(record, next.x, next.y);
  }
  safeHandle('weibiye:pet:dragStart', 'pet', async (entry, point) => {
    const position = policy.pointer(point);
    const record = entry.record;
    const current = record.window.getBounds();
    // A pointer start must be inside its own window; it cannot move another pet.
    if (position.x < current.x || position.x > current.x + current.width
      || position.y < current.y || position.y > current.y + current.height) throw policy.fail('INVALID_POINTER');
    if (record.drag && record.drag.until >= now()) throw policy.fail('DRAG_ACTIVE');
    const gesture = { epoch, until: now() + DRAG_LEASE_MS, authorized: false,
      offsetX: position.x - current.x, offsetY: position.y - current.y, pendingPoint: null };
    record.drag = gesture;
    record.window.setIgnoreMouseEvents(false);
    record.ignoreMouse = false;
    // Pause only this already-owned local sprite immediately. Awaiting the two
    // API reads while it keeps walking can move the hitbox away from pointerup.
    // No movement/private API result is granted until authentication completes.
    motion.beginDrag(world, record.identity.pet_id, { x: current.x, y: current.y });
    sendPetState(record);
    try {
      await queue(async () => {
        await checkPet(record.identity.pet_id, record);
        if (record.drag !== gesture || gesture.epoch !== epoch || gesture.until < now()) throw policy.fail('DRAG_EXPIRED');
        gesture.authorized = true;
        if (gesture.pendingPoint) { moveDragPoint(record, gesture.pendingPoint); gesture.pendingPoint = null; }
      });
      return null;
    } catch (error) {
      if (records.get(record.identity.pet_id) === record && record.drag === gesture) {
        record.drag = null; motion.endDrag(world, record.identity.pet_id); sendPetState(record);
      }
      throw error;
    }
  }, { direct: true });
  // High-frequency pointer moves use a bounded local gesture lease, not private
  // API reads. Authentication-cookie changes revoke it synchronously; start/end,
  // every other IPC and the 5-second poll revalidate against the real backend.
  safeHandle('weibiye:pet:dragMove', 'pet', (entry, point) => {
    const record = entry.record;
    const position = policy.pointer(point);
    if (!record.drag || record.drag.epoch !== epoch || record.drag.until < now()) {
      record.drag = null; motion.endDrag(world, record.identity.pet_id); throw policy.fail('DRAG_EXPIRED');
    }
    if (!record.drag.authorized) {
      // Keep one bounded point for a fast gesture while its authorization is in
      // flight; never build an unbounded event queue or move an unverified pet.
      record.drag.pendingPoint = position;
      return null;
    }
    moveDragPoint(record, position);
    return null;
  }, { direct: true });
  safeHandle('weibiye:pet:dragEnd', 'pet', async (entry) => {
    const record = entry.record;
    record.drag = null;
    motion.endDrag(world, record.identity.pet_id);
    await checkPet(record.identity.pet_id, record);
    rememberPosition(record); positionStore?.flush();
    sendPetState(record); return null;
  });

  const onDisplayChange = () => {
    try {
      motion.setDisplays(world, displays());
      for (const record of records.values()) {
        record.drag = null;
        const point = motion.snapshot(world, record.identity.pet_id);
        placePet(record, point.x, point.y); rememberPosition(record);
      }
      positionStore?.flush();
      society?.advance(now(),{background:true,resuming:true});tickSociety();
    }
    catch {
      // A removed/tiny display must not crash the host or strand pet windows.
      for (const id of [...records.keys()]) forgetRecord(id);
    }
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  const tickTimer = setInterval(() => {
    if (stopped) return;
    if (![...records.values()].some((record) => !record.hidden)) return;
    const cursor = screen.getCursorScreenPoint();
    const timestamp=now();
    const participants=[];
    for(const record of records.values()){
      if(record.window.isDestroyed()||record.hidden)continue;
      try{
        const pet=world.pets.get(record.identity.pet_id);
        const near=Math.hypot(cursor.x-(pet.x+94),cursor.y-(pet.y+100))<220;
        const before=record.actor.sequence;
        actions.tick(record.actor,timestamp,{dragging:Boolean(record.drag),activity:activity.view(record.activity,timestamp).activity,near,canMove:true,reducedMotion:resources.state.reduced_motion,autonomous:socialAutonomous(record)});
        if(before!==record.actor.sequence){actionStats.transitions++;rememberBehavior(record);preferences.flush();}
        if(!actions.MOTION.has(record.actor.action)||near||record.drag||resources.state.reduced_motion)motion.stopMotion(world,pet.pet_id);
        if(actions.MOTION.has(record.actor.action)&&record.actor.preferences.autoMove&&!near&&!record.drag&&!resources.state.reduced_motion
          &&record.actor.motion!==record.actor.sequence){
          record.actor.motion=record.actor.sequence;
          let dx=(record.actor.random()-.5)*160,dy=(record.actor.random()-.5)*70;
          if(record.actor.action==='follow'){const distance=Math.hypot(cursor.x-pet.x,cursor.y-pet.y)||1;dx=(cursor.x-pet.x)/distance*70;dy=(cursor.y-pet.y)/distance*70;}
          if(motion.moveTo(world,pet.pet_id,{x:pet.x+dx,y:pet.y+dy},record.actor.action==='run'?70:35))actionStats.moves++;
        }
        const display=layout.nearest(world.displayAreas,pet,PET_WIDTH,PET_HEIGHT);
        participants.push({id:pet.pet_id,owner:record.identity.owner_id,definition:record.actor.definition,
          display:display.id,x:pet.x,y:pet.y,visible:!record.hidden,priority:record.actor.priority,...record.actor.preferences,random:record.actor.preferences.random&&!resources.state.reduced_motion});
      }catch{actionStats.recoveries++;motion.stopMotion(world,record.identity.pet_id);
        record.actor=actions.createActor(record.identity.definition_id,timestamp,{preferences:preferences.get(record.identity.owner_id,record.identity.pet_id)});}
    }
    for(const intent of (society?[]:coordinator.plan(participants,timestamp))){
      const record=records.get(intent.id),other=world.pets.get(intent.toward);
      if(record&&other&&actions.start(record.actor,intent.action,timestamp)){
        actionStats.coordinated++;
        const pet=world.pets.get(intent.id);pet.direction=other.x<pet.x?'left':'right';
        const point=interactionStep(intent.action,pet,other);
        if(point&&record.actor.preferences.autoMove){
          record.actor.motion=record.actor.sequence;
          if(motion.moveTo(world,intent.id,point,35)){actionStats.moves++;actionStats.coordinatedMoves++;}
        }
      }
    }
    for (const position of motion.tickWorld(world, now())) {
      const record = records.get(position.pet_id);
      if (!record || record.window.isDestroyed() || record.hidden) continue;
      if (record.drag && record.drag.until < now()) { record.drag = null; motion.endDrag(world, position.pet_id); }
      const current = record.window.getBounds();
      if (current.x !== Math.round(position.x) || current.y !== Math.round(position.y)
        || Math.abs(current.width - PET_WIDTH) > 1 || Math.abs(current.height - PET_HEIGHT) > 1) {
        // A fractional-DPI read can round outward by one DIP. Tolerate that
        // bounded native report while idle; every actual move still supplies
        // the original size, and a larger discrepancy is corrected.
        placePet(record, position.x, position.y);
      }
      if(record.lastMotionState==='walking'&&position.state!=='walking'){rememberPosition(record);positionStore?.flush();}
      record.lastMotionState=position.state;
      const inside = cursor.x >= position.x + 20 && cursor.x <= position.x + 168
        && cursor.y >= position.y + 30 && cursor.y <= position.y + 178;
      const ignoreMouse = !record.drag && !inside;
      if (record.ignoreMouse !== ignoreMouse) {
        record.window.setIgnoreMouseEvents(ignoreMouse, { forward: true });
        record.ignoreMouse = ignoreMouse;
      }
      if (now() >= record.activity.nextGreeting) greetPet(record, now());
      const emotional = activity.view(record.activity, now());
      const stateKey = `${position.state}:${position.direction}:${emotional.activity}:${emotional.greeting ?? ''}:${record.actor.sequence}`;
      if (record.lastState !== stateKey) { record.lastState = stateKey; sendPetState(record); }
    }
  }, 50);
  tickTimer.unref?.();
  const pollTimer = setInterval(() => {
    if (stopped || pollPending) return;
    pollPending = true;
    void queue(async () => {
      const before=resources.state.reduced_motion;resources.sample();if(before!==resources.state.reduced_motion){emit();refreshTray();}
      const auth = await checkOwner();
      await checkDesktopPets(auth);
    }).catch(() => {}).finally(() => { pollPending = false; void sweepUiResources(); });
  }, 5000);
  pollTimer.unref?.();

  async function start() { await mainWindow.loadURL(`${origin}/companions`); }
  function stop() {
    if (stopPromise) return stopPromise;
    closeSociety();stopped = true; epoch += 1;
    for (const item of [...downloads]) item.cancel();
    downloads.clear();
    clearInterval(tickTimer); clearInterval(pollTimer);
    for (const controller of controllers) controller.abort();
    uiSession.cookies.removeListener('changed', onCookieChanged);
    screen.removeListener('display-metrics-changed', onDisplayChange);
    screen.removeListener('display-removed', onDisplayChange);
    screen.removeListener('display-added', onDisplayChange);
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    for (const id of [...records.keys()]) forgetRecord(id);
    positionStore?.flush();
    combinations.flush();resources.close();
    senders.clear();
    motion.disposeWorld(world);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    tray?.destroy();
    stopPromise = Promise.allSettled([uiSession.clearStorageData(), uiSession.clearCache(),
      petSession.clearStorageData(), petSession.clearCache()]).then(() => undefined);
    return stopPromise;
  }

  return { origin, records, world, session: uiSession, petSession, actionStats, configurePet, playAction,
    get society(){return society;},societyStats,tickSociety:()=>queue(async()=>{await checkOwner();tickSociety();}),socialState:owner=>queue(()=>socialState(owner)),
    get societyPending(){return societyTimer!==null;},
    layoutState,measureResources:()=>{resources.sample();return resources.samples;},
    recallAll:expectedOwner=>queue(()=>recallAll(expectedOwner??ownerId)),restoreCombination:expectedOwner=>queue(()=>restoreCombination(expectedOwner??ownerId)),
    get mainWindow() { return mainWindow; }, get senderCount() { return senders.size; }, sweepUiResources,
    get ownerId() { return ownerId; }, get epoch() { return epoch; },
    get tray() { return tray; }, get trayMenu() { return trayMenu; },
    get lastContextMenu() { return lastContextMenu; },
    get stopped() { return stopped; }, start, stop, showMain,
    recover: () => queue(async () => {
      const auth = await checkOwner();
      for (const record of [...records.values()]) await checkPet(record.identity.pet_id, record, auth);
      onDisplayChange();
    }),
    list: () => queue(list),
    release: (id) => queue(() => release(id)), hide: (id) => queue(() => hide(id)),
    show: (id) => queue(() => show(id)), recall: (id) => queue(() => recall(id)),
    openChat: (id) => queue(() => openChat(id)), syncSession: () => queue(syncSession),
    snapshot: () => localState(), MAX_PETS };
}

module.exports = { createManager, MAX_PETS, DRAG_LEASE_MS, FETCH_LIMIT, MAIN_PARK_AFTER_MS };
