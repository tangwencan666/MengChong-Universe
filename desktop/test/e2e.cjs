'use strict'

// Real Windows/Electron + real isolated FastAPI/PostgreSQL/Redis acceptance.
// Never supplies mock HTTP responses or a test-only IPC channel.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const { _electron, expect } = require('@playwright/test')
const { samplePerformance } = require('./performance.cjs')

const runFile = promisify(execFile)
const desktopDir = path.resolve(__dirname, '..')
const repository = path.resolve(desktopDir, '..')
const evidenceRoot = path.join(repository, '.verification', 'p6')
const manifestFile = path.resolve(process.argv.slice(2).find((argument) => !argument.startsWith('--')) || path.join(evidenceRoot, 'target.json'))
const resumeFile = process.argv.slice(2).find((argument) => argument.startsWith('--resume='))?.slice('--resume='.length)
const phase = process.argv.slice(2).find((argument) => argument.startsWith('--phase='))?.slice('--phase='.length) || 'full'
const packagedExecutable = process.argv.slice(2).find((argument) => argument.startsWith('--executable='))?.slice('--executable='.length)
const completeText = '你可以用它体验已保存会话的流式显示。'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
  })
}

async function until(predicate, message, timeout = 15000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeout) {
    try { const result = await predicate(); if (result) return result } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(message + (lastError ? ': ' + lastError.message : ''))
}

async function readTarget() {
  const target = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  assert.equal(process.platform, 'win32', 'Native acceptance requires Windows; do not claim another platform passed')
  assert.match(target.runId, /^[A-Za-z0-9_-]{6,100}$/)
  assert.match(target.databaseName, /p6/i, 'Only the explicitly named P6 isolated database is allowed')
  assert.notEqual(target.databaseName, 'weibiye')
  assert.equal(target.schemaVersion, '0006')
  assert.equal(target.uiPort, 35316)
  assert.equal(target.backendOrigin, 'http://127.0.0.1:38316')
  for (const key of ['a', 'b']) {
    assert.match(target.accounts[key].email, /@example\.(com|test)$/)
    assert.ok(target.accounts[key].password.length >= 12)
    assert.ok(target.accounts[key].pets.length >= (key === 'a' ? 3 : 1))
    for (const pet of target.accounts[key].pets) { assert.match(pet.pet_id, uuid); assert.ok(pet.name) }
  }
  assert.notEqual(target.accounts.a.email, target.accounts.b.email)
  assert.equal(new Set([...target.accounts.a.pets, ...target.accounts.b.pets].map((pet) => pet.pet_id)).size,
    target.accounts.a.pets.length + target.accounts.b.pets.length)
  return target
}

async function main() {
  const target = await readTarget()
  assert.ok(['full', 'security', 'security-tail', 'performance', 'packaged-smoke', 'gesture'].includes(phase))
  if (['security', 'security-tail', 'performance'].includes(phase)) assert.ok(resumeFile, 'A focused continuation must reference the original real acceptance evidence')
  if (phase === 'packaged-smoke') {
    assert.ok(packagedExecutable && path.isAbsolute(packagedExecutable))
    const relative = path.relative(repository, packagedExecutable)
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'Only this project portable artifact may be launched')
    assert.ok((await fs.stat(packagedExecutable)).isFile())
  }
  const previous = resumeFile ? JSON.parse(await fs.readFile(path.resolve(resumeFile), 'utf8')) : null
  const previousChecks = new Map()
  for (const check of previous?.checks || []) if (check.status === 'passed') previousChecks.set(check.name, check)
  for (const check of previous?.reusedEvidence || []) if (check.originalStatus === 'passed') previousChecks.set(check.name, check)
  const requiredSetup = new Set(['isolated target and unused native UI port', 'start actual Electron with a new private profile',
    'real login, HttpOnly Cookie and CSRF rejection', 'release three pets through real companions UI',
    'resume validates the exact previously confirmed private memory without changing it',
    'resume validates previously persisted pet conversation', 'real tray Quit exits this instance and releases its UI port'])
  if (!['performance', 'security-tail'].includes(phase)) requiredSetup.add('real click opens a single chat for the clicked pet')
  if (phase === 'security-tail') requiredSetup.add('security continuation primes real private chat cache before switching accounts')
  const performanceChecks = new Set(['three-pet idle CPU and memory, actual Electron process tree',
    'three-pet movement CPU and memory, actual renderer state'])
  const packagedChecks = new Set(['isolated target and unused native UI port', 'start actual Electron with a new private profile',
    'real login, HttpOnly Cookie and CSRF rejection', 'packaged main releases one authenticated native pet',
    'real tray Quit exits this instance and releases its UI port'])
  const gestureChecks = new Set([...packagedChecks, 'release three pets through real companions UI',
    'actual three-pet Windows screenshot', 'real mouse drag exceeds threshold without opening chat',
    'real click opens a single chat for the clicked pet'])
  if (phase === 'gesture') for (const name of gestureChecks) requiredSetup.add(name)
  const reusableChecks = new Set([...previousChecks.keys()].filter((name) => !requiredSetup.has(name)))
  if (previous) {
    assert.equal(previous.database, target.databaseName)
    assert.ok(['FAILED', 'PARTIAL'].includes(previous.status))
    const failure = previous.checks.find((check) => check.status === 'failed')?.name
    assert.ok(['real Mock SSE, pet identity and persisted history after reload',
      'three-pet idle CPU and memory, actual Electron process tree',
      'logout destroys private windows and session API becomes 401',
      'network authentication failure closes old native private windows', undefined].includes(failure), 'Unsupported continuation checkpoint')
    for (const name of ['per-pet memory defaults off and explicit UI confirmation saves only one pet',
      'three native windows, transparency and taskbar isolation']) assert.ok(previousChecks.has(name))
  }
  const runDirectory = path.join(evidenceRoot, 'desktop-' + target.runId + '-' + crypto.randomUUID())
  await fs.mkdir(runDirectory, { recursive: true })
  const result = { startedAt: new Date().toISOString(), status: 'RUNNING',
    database: target.databaseName, schemaVersion: target.schemaVersion,
    provider: 'Mock; no GPT/DeepSeek requests', nativePlatform: process.platform,
    testedWindows: 'Current host only; Windows 10 was not tested', checks: [], screenshots: [], performance: [],
    phase, executable: packagedExecutable || 'project-local Electron executable', authAttempts: [], nativeInteractions: [], pendingChecks: [], notScheduled: [],
    reusedEvidence: [], ...(previous ? { continuationOf: path.resolve(resumeFile) } : {}) }
  const resultsFile = path.join(runDirectory, 'results.json')
  let app
  let mainPage
  let expectedQuit = false
  let ownerA
  let sessionA
  let generationA
  let messageA
  let memoryA
  const petA = target.accounts.a.pets[0]
  const petA2 = target.accounts.a.pets[1]
  const petA3 = target.accounts.a.pets[2]
  const petB = target.accounts.b.pets[0]
  const uiOrigin = 'http://127.0.0.1:' + target.uiPort
  const packageInfo = JSON.parse(await fs.readFile(path.join(desktopDir, 'package.json'), 'utf8'))
  const mainFile = packagedExecutable ? path.join(path.dirname(packagedExecutable), 'resources', 'app', packageInfo.main)
    : path.join(desktopDir, packageInfo.main)
  const save = () => fs.writeFile(resultsFile, JSON.stringify(result, null, 2) + '\n')
  async function check(name, operation) {
    if ((phase === 'packaged-smoke' && !packagedChecks.has(name)) || (phase === 'gesture' && !gestureChecks.has(name))) {
      result.notScheduled.push(name); return
    }
    if (['security', 'security-tail'].includes(phase) && performanceChecks.has(name)) {
      result.pendingChecks.push(name)
      console.log('PENDING separate quiet-workload performance phase: ' + name)
      await save(); return
    }
    if (previous && reusableChecks.has(name)) {
      const verified = previousChecks.get(name)
      result.reusedEvidence.push({ name, source: verified.source || path.resolve(resumeFile), originalStatus: 'passed', detail: verified.detail })
      if (name === 'actual three-pet Windows screenshot') result.screenshots.push(...previous.screenshots)
      console.log('PRIOR VERIFIED ' + name + ' (original evidence retained, not counted as a new execution)')
      await save()
      return
    }
    const start = Date.now()
    try {
      const detail = await operation()
      result.checks.push({ name, status: 'passed', durationMs: Date.now() - start, ...(detail === undefined ? {} : { detail }) })
      console.log('PASS ' + name)
    } catch (error) {
      result.checks.push({ name, status: 'failed', durationMs: Date.now() - start, error: String(error.stack || error) })
      throw error
    } finally { await save() }
  }
  async function inspect(operation, payload) {
    return app.evaluate(async ({ app: electronApp, BrowserWindow, session }, data) => {
      const nodeRequire = process.getBuiltinModule('module').createRequire(data.mainFile)
      const runtime = nodeRequire(data.mainFile).getRuntime()
      const manager = runtime.manager || runtime
      const handle = (window) => window && !window.isDestroyed()
        ? window.getNativeWindowHandle().readBigUInt64LE().toString() : null
      const windows = () => [...manager.records.entries()].map(([petId, record]) => ({
        petId, owner: record.identity.owner_id, hidden: record.hidden,
        state: manager.world.pets.get(petId)?.state,
        windowId: record.window && !record.window.isDestroyed() ? record.window.id : null,
        handle: handle(record.window), bounds: record.window && !record.window.isDestroyed() ? record.window.getBounds() : null,
        visible: !!record.window && !record.window.isDestroyed() && record.window.isVisible(),
        alwaysOnTop: !!record.window && !record.window.isDestroyed() && record.window.isAlwaysOnTop(),
        background: record.window && !record.window.isDestroyed() ? record.window.getBackgroundColor() : null,
        chatId: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.id : null,
        chatUrl: record.chatWindow && !record.chatWindow.isDestroyed() ? record.chatWindow.webContents.getURL() : null,
        chatHandle: handle(record.chatWindow),
      }))
      switch (data.operation) {
        case 'snapshot': return { pid: process.pid, records: windows(), mainId: manager.mainWindow.id,
          mainHandle: handle(manager.mainWindow), mainBounds: manager.mainWindow.getBounds(),
          windowCount: BrowserWindow.getAllWindows().length,
          versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
          security: manager.mainWindow.webContents.getLastWebPreferences() }
        case 'arrange': {
          const display = nodeRequire('electron').screen.getDisplayMatching(manager.mainWindow.getBounds())
          manager.mainWindow.setBounds(display.workArea)
          manager.mainWindow.show(); manager.mainWindow.setAlwaysOnTop(true); manager.mainWindow.focus()
          const motion = nodeRequire(nodeRequire('node:path').join(nodeRequire('node:path').dirname(data.mainFile), 'motion.cjs'))
          let index = 0
          for (const record of manager.records.values()) {
            if (!record.window || record.window.isDestroyed() || record.hidden) continue
            const point = { x: display.workArea.x + 60 + index * 220, y: display.workArea.y + Math.min(440, Math.max(160, display.workArea.height - 250)) }
            motion.beginDrag(manager.world, record.identity.pet_id, point)
            motion.endDrag(manager.world, record.identity.pet_id)
            const pet = manager.world.pets.get(record.identity.pet_id)
            pet.nextAt = Date.now() + 60000
            record.window.setBounds({ ...point, width: 188, height: 196 })
            record.window.showInactive(); record.window.moveTop(); index++
          }
          return { mainBounds: manager.mainWindow.getBounds(), records: windows() }
        }
        case 'restore-topmost': manager.mainWindow.setAlwaysOnTop(false); return true
        case 'benchmark': {
          const bounds = manager.world.bounds
          const observation = []
          let index = 0
          for (const [id, pet] of manager.world.pets) {
            pet.x = bounds.x + 35 + index * 220
            pet.y = bounds.y + bounds.height - 215
            pet.state = data.payload === 'walking' ? 'walking' : 'idle'
            pet.nextAt = Date.now() + 60000
            pet.target = data.payload === 'walking' ? { x: pet.x, y: bounds.y + 25 } : null
            pet.motionX = pet.x; pet.motionY = pet.y; pet.speed = 10
            manager.records.get(id).lastState = null
            observation.push({ petId: id, x: pet.x, y: pet.y, state: pet.state }); index++
          }
          return { instrumentation: 'Controlled real native motion-world benchmark, no simulated resource metrics', pets: observation }
        }
        case 'motion': return [...manager.world.pets.values()].map((pet) => ({ petId: pet.pet_id, x: pet.x, y: pet.y, state: pet.state }))
        case 'cookie-flags': {
          const uiCookies = await manager.session.cookies.get({ url: manager.origin })
          const petCookies = await manager.petSession.cookies.get({ url: manager.origin })
          return { ui: uiCookies.map(({ name, httpOnly, secure, sameSite }) => ({ name, httpOnly, secure, sameSite })),
            pet: petCookies.map(({ name }) => ({ name })) }
        }
        case 'clear-auth-cookie': {
          const cookies = await manager.session.cookies.get({ url: manager.origin })
          for (const cookie of cookies) if (['weibiye_session', '__Host-weibiye_session'].includes(cookie.name)) await manager.session.cookies.remove(manager.origin, cookie.name)
          return true
        }
        case 'focus-pet': {
          const record = manager.records.get(data.payload)
          manager.mainWindow.setAlwaysOnTop(false)
          record.window.moveTop()
          return record.window.isFocused()
        }
        case 'menu': {
          const menu = manager.lastContextMenu || manager.records.get(data.payload)?.contextMenu
          if (!menu) return null
          return menu.items.map((item) => ({ id: item.id, label: item.label, enabled: item.enabled, visible: item.visible }))
        }
        case 'close-menu': {
          const menu = manager.lastContextMenu || manager.records.get(data.payload)?.contextMenu
          if (menu) menu.closePopup(); return true
        }
        case 'crash': manager.records.get(data.payload).window.webContents.forcefullyCrashRenderer(); return true
        case 'offline': {
          manager.session.enableNetworkEmulation({ offline: false })
          await manager.session.setProxy(data.payload
            ? { mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:38319;https=127.0.0.1:38319', proxyBypassRules: '<-loopback>' }
            : { mode: 'direct' })
          await manager.session.closeAllConnections()
          return { scope: 'only this Electron private UI session', networkFailure: data.payload, proxyRestored: !data.payload }
        }
        case 'alpha': {
          const image = await manager.records.get(data.payload).window.webContents.capturePage()
          const bitmap = image.toBitmap()
          return { size: image.getSize(), cornerBGRA: [...bitmap.subarray(0, 4)] }
        }
        case 'quit-menu': {
          const menu = runtime.trayMenu || runtime.tray?.menu
          const item = menu?.getMenuItemById('quit') || menu?.items.find((entry) => entry.label === '退出未毕业')
          if (!item || !item.enabled) throw new Error('Real tray Quit command is unavailable')
          setImmediate(() => item.click(item, manager.mainWindow, {}))
          return true
        }
        default: throw new Error('Unknown inspector observation')
      }
    }, { mainFile, operation, payload })
  }
  async function realApi(page, method, requestPath, body, idempotencyKey, extraHeaders = {}, csrf = true) {
    return page.evaluate(async (input) => {
      const headers = { ...input.extraHeaders }
      if (!['GET', 'HEAD'].includes(input.method) && input.csrf) {
        const response = await fetch('/api/v1/auth/csrf', { credentials: 'include' })
        if (!response.ok) throw new Error('Unable to obtain the real CSRF token')
        headers['X-CSRF-Token'] = (await response.json()).csrf_token
      }
      if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey
      if (input.body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch(input.requestPath, { method: input.method, headers,
        credentials: 'include', body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(45000) })
      const text = await response.text()
      let data; try { data = JSON.parse(text) } catch { data = text }
      return { status: response.status, data, headers: { contentType: response.headers.get('content-type') } }
    }, { method, requestPath, body, idempotencyKey, extraHeaders, csrf })
  }
  async function login(account) {
    await mainPage.goto(uiOrigin + '/login')
    await mainPage.getByLabel('邮箱', { exact: true }).fill(account.email)
    await mainPage.getByLabel('密码', { exact: true }).fill(account.password)
    const responsePromise = mainPage.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/auth/login'))
    await mainPage.getByRole('button', { name: '登录', exact: true }).click()
    const response = await responsePromise
    const body = await response.json()
    result.authAttempts.push({ status: response.status(), errorCode: body.error?.code || null,
      retryAfter: response.headers()['retry-after'] || null })
    await save()
    assert.equal(response.status(), 200, 'Real login failed; inspect authAttempts for HTTP status/Retry-After (credentials are not logged)')
    await expect(mainPage).toHaveURL(/\/$/, { timeout: 15000 })
    await expect(mainPage.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
    return (await realApi(mainPage, 'GET', '/api/v1/auth/me')).data
  }
  async function logout() {
    await mainPage.goto(uiOrigin + '/me')
    await mainPage.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(mainPage).toHaveURL(/\/login(?:\?next=%2Fme)?$/)
    const redirect = new URL(mainPage.url())
    assert.equal(redirect.origin, uiOrigin); assert.equal(redirect.pathname, '/login')
    assert.ok(redirect.searchParams.get('next') === null || redirect.searchParams.get('next') === '/me')
  }
  async function desktopCommand(name, petId) {
    return mainPage.evaluate(async ({ name, petId }) => {
      try { return { ok: true, value: await window.weibiyeDesktop[name](petId) } }
      catch (error) { return { ok: false, error: error.message } }
    }, { name, petId })
  }
  async function petRecord(petId) { return (await inspect('snapshot')).records.find((record) => record.petId === petId) }
  async function nativeInput(petId, action, delta = {}) {
    let rendererState
    let rendererPage
    if (action !== 'inspect') {
      rendererState = await until(async () => {
        for (const page of app.windows()) {
          if (!page.url().includes('/__pet/pet.html')) continue
          const value = await page.evaluate(() => ({ petId: document.body.dataset.petId, state: document.body.dataset.state,
            enabled: !document.getElementById('pet-hitbox').disabled }))
          if (value.petId === petId && value.enabled) { rendererPage = page; return value }
        }
        return null
      }, 'The real pet renderer is not initialized for safe native input')
      await rendererPage.evaluate(() => {
        window.__p6PointerEvents = []
        if (window.__p6PointerObserver) return
        window.__p6PointerObserver = true
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'click', 'blur']) {
          window.addEventListener(type, (event) => {
            if (window.__p6PointerEvents.length >= 40) return
            window.__p6PointerEvents.push({ type: event.type, target: event.target.id,
              hitbox: !!event.target.closest?.('#pet-hitbox'), screenX: event.screenX,
              screenY: event.screenY, clientX: event.clientX, clientY: event.clientY,
              button: event.button, buttons: event.buttons, isTrusted: event.isTrusted })
          }, true)
        }
      })
    }
    await inspect('focus-pet', petId)
    const snapshot = await inspect('snapshot')
    const record = snapshot.records.find((item) => item.petId === petId)
    assert.ok(record?.handle, 'Expected a real, visible native pet window')
    const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-interaction.ps1'),
      '-WindowHandle', record.handle, '-ExpectedProcessId', String(snapshot.pid), '-Action', action]
    if (delta.x !== undefined) args.push('-DeltaX', String(delta.x))
    if (delta.y !== undefined) args.push('-DeltaY', String(delta.y))
    const output = await runFile('powershell.exe', args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    assert.equal(output.stderr.trim(), '')
    const interaction = JSON.parse(output.stdout.trim())
    const pointer = rendererPage ? await rendererPage.evaluate(() => ({ devicePixelRatio, innerWidth, innerHeight,
      events: window.__p6PointerEvents, hitbox: document.getElementById('pet-hitbox').getBoundingClientRect().toJSON() })) : null
    result.nativeInteractions.push({ petId, rendererBefore: rendererState, nativeBefore: record, interaction, pointer,
      nativeAfter: await petRecord(petId) })
    await save()
    if (action !== 'inspect') assert.ok(pointer.events.some((event) => event.type === 'pointerdown' && event.hitbox && event.isTrusted),
      'The real Windows pointer must reach the authorized pet hitbox; inspect nativeInteractions for DPI/occlusion evidence')
    return interaction
  }
  async function chatFor(petId) {
    const record = await until(async () => { const current = await petRecord(petId); return current?.chatId && current }, 'Expected an independent native chat window')
    return until(async () => {
      for (const page of app.windows()) if (page !== mainPage && page.url().includes('/pets/' + petId)) return page
      return null
    }, 'Chat renderer did not navigate to its own pet scope').then(async (page) => {
      await page.waitForLoadState('load')
      return { page, record }
    })
  }
  async function sendChat(page, petId, text) {
    await page.getByLabel('聊天消息', { exact: true }).fill(text)
    const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().includes('/api/v1/pets/' + petId + '/sessions/') && response.url().endsWith('/messages'), { timeout: 20000 })
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const response = await responsePromise
    assert.equal(response.status(), 202)
    const accepted = await response.json()
    assert.equal(accepted.generation.pet_id, petId)
    return { accepted, request: { body: response.request().postDataJSON(), headers: response.request().headers() } }
  }
  async function completed(page) {
    await expect(page.locator('.message-assistant').last()).toContainText(completeText, { timeout: 45000 })
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  }
  function eventFrames(text) {
    return text.replaceAll('\r\n', '\n').split('\n\n').filter((frame) => frame.includes('data: ')).map((frame) => {
      const lines = frame.split('\n'); const data = JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6))
      return { event: lines.find((line) => line.startsWith('event: '))?.slice(7), id: lines.find((line) => line.startsWith('id: '))?.slice(4), data }
    })
  }
  async function providerObservations() {
    try { return (await fs.readFile(path.join(evidenceRoot, 'provider-observations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  try {
    await check('isolated target and unused native UI port', async () => {
      assert.equal(await portIsOpen(target.uiPort), false, 'Existing service owns the P6 UI port; refusing to start another')
      const ready = await fetch(target.backendOrigin + '/health/ready')
      assert.equal(ready.status, 200)
      return { backend: target.backendOrigin, uiPort: target.uiPort, isolatedDatabase: target.databaseName }
    })
    await check('start actual Electron with a new private profile', async () => {
      const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
      app = await _electron.launch({ executablePath: packagedExecutable || path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
        args: [...(packagedExecutable ? [] : [desktopDir]), '--ui-port=' + target.uiPort, '--backend-origin=' + target.backendOrigin,
          '--profile-dir=' + path.join(runDirectory, 'profile')], env: environment, timeout: 30000 })
      mainPage = await app.firstWindow()
      mainPage.setDefaultTimeout(15000)
      await mainPage.waitForLoadState('domcontentloaded')
      await mainPage.goto(uiOrigin + '/register')
      const snapshot = await inspect('snapshot')
      assert.equal(snapshot.versions.electron, '45.2.1')
      assert.equal(snapshot.security.contextIsolation, true)
      assert.equal(snapshot.security.nodeIntegration, false)
      assert.equal(snapshot.security.sandbox, true)
      return { pid: snapshot.pid, versions: snapshot.versions, nodeIntegration: false, contextIsolation: true, sandbox: true }
    })
    await check('real registration and local Mock mail boundary', async () => {
      const email = 'p6-native-' + crypto.randomUUID() + '@example.com'
      await mainPage.getByLabel('昵称', { exact: true }).fill('P6 桌面注册验收')
      await mainPage.getByLabel('邮箱', { exact: true }).fill(email)
      await mainPage.getByLabel('密码', { exact: true }).fill(target.accounts.a.password)
      await mainPage.getByRole('button', { name: '注册', exact: true }).click()
      await expect(mainPage).toHaveURL(/\/login$/)
      await expect(mainPage.getByRole('status')).toContainText('本地 Mock 邮件')
      return { registration: 'real isolated API', mail: 'local Mock only' }
    })
    await check('real login, HttpOnly Cookie and CSRF rejection', async () => {
      ownerA = await login(target.accounts.a)
      assert.ok(uuid.test(ownerA.id))
      const cookies = await inspect('cookie-flags')
      const authCookie = cookies.ui.find((cookie) => cookie.name === 'weibiye_session')
      assert.ok(authCookie); assert.equal(authCookie.httpOnly, true); assert.equal(authCookie.sameSite, 'lax')
      assert.equal(cookies.pet.some((cookie) => cookie.name === 'weibiye_session'), false)
      assert.equal(await mainPage.evaluate(() => document.cookie.includes('weibiye_session')), false)
      const response = await realApi(mainPage, 'POST', '/api/v1/pets', { name: 'Forbidden without CSRF' }, crypto.randomUUID(), {}, false)
      assert.equal(response.status, 403)
      assert.equal(await mainPage.evaluate(() => localStorage.length + sessionStorage.length), 0)
      return { httpOnly: true, sameSite: authCookie.sameSite, localSecure: authCookie.secure, missingCsrfStatus: response.status }
    })
    if (phase === 'packaged-smoke') await check('packaged main releases one authenticated native pet', async () => {
      await mainPage.goto(uiOrigin + '/companions')
      const card = mainPage.locator('.pet-card').filter({ has: mainPage.getByRole('heading', { name: petA.name, exact: true }) })
      await card.getByRole('button', { name: '放到桌面', exact: true }).click()
      const record = await until(async () => { const value = await petRecord(petA.pet_id); return value?.visible && value }, 'Packaged application did not release its own pet')
      assert.equal(record.owner, ownerA.id); assert.equal(record.alwaysOnTop, true)
      assert.equal((await inspect('snapshot')).records.length, 1)
      return { petId: petA.pet_id, ownerId: ownerA.id, visible: true, alwaysOnTop: true, executable: packagedExecutable }
    })
    await check('release three pets through real companions UI', async () => {
      await mainPage.goto(uiOrigin + '/companions')
      for (const pet of [petA, petA2, petA3]) {
        const card = mainPage.locator('.pet-card').filter({ has: mainPage.getByRole('heading', { name: pet.name, exact: true }) })
        await card.getByRole('button', { name: '放到桌面', exact: true }).click()
        await until(async () => (await petRecord(pet.pet_id))?.visible, 'Pet did not appear on the Windows desktop')
      }
      const snapshot = await inspect('snapshot')
      assert.equal(snapshot.records.length, 3)
      assert.ok(snapshot.records.every((record) => record.owner === ownerA.id && record.visible && record.alwaysOnTop))
      return snapshot.records.map(({ petId, owner, visible, bounds }) => ({ petId, owner, visible, bounds }))
    })
    await check('three native windows, transparency and taskbar isolation', async () => {
      await inspect('arrange'); await delay(250)
      const windows = (await inspect('snapshot')).records
      const observations = []
      for (const window of windows) {
        const flags = await nativeInput(window.petId, 'inspect')
        assert.equal(flags.caption, false); assert.equal(flags.topmost, true)
        const alpha = await inspect('alpha', window.petId)
        assert.equal(alpha.cornerBGRA[3], 0, 'Actual renderer corner must be transparent')
        observations.push({ petId: window.petId, flags, alpha,
          taskbarPolicy: 'Native host constructs the real window with skipTaskbar:true, covered by host unit tests. Electron provides no skipTaskbar getter; TOOLWINDOW is recorded but is not an equivalent assertion.' })
      }
      for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i].bounds, b = windows[j].bounds
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'Pet windows overlap')
      }
      return observations
    })
    await check('actual three-pet Windows screenshot', async () => {
      await inspect('arrange'); await delay(350)
      const snapshot = await inspect('snapshot')
      const file = path.join(runDirectory, 'windows-three-pets.png')
      const capture = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'capture.ps1'), '-WindowHandle', snapshot.mainHandle, '-ExpectedProcessId', String(snapshot.pid),
        '-OutputPath', file, '-AllowedDirectory', runDirectory], { windowsHide: true, timeout: 15000 })
      const detail = JSON.parse(capture.stdout.trim())
      result.screenshots.push(detail)
      await inspect('restore-topmost')
      return detail
    })
    await check('real mouse drag exceeds threshold without opening chat', async () => {
      await inspect('arrange'); await delay(150)
      const interaction = await nativeInput(petA.pet_id, 'drag', { x: 0, y: -110 })
      assert.ok(Math.abs(interaction.after.x - interaction.before.x) < 30)
      assert.ok(Math.abs(interaction.after.y - interaction.before.y) >= 70)
      assert.equal((await petRecord(petA.pet_id)).chatId, null)
      return interaction
    })
    await check('real right-click opens only authorized native pet menu', async () => {
      await nativeInput(petA.pet_id, 'context')
      const items = await until(() => inspect('menu', petA.pet_id), 'Native context menu did not appear')
      for (const label of ['打开聊天', '隐藏这只宠物', '收回这只宠物', '显示主界面']) assert.ok(items.some((item) => item.label === label && item.enabled))
      await inspect('close-menu', petA.pet_id)
      return items
    })
    await check('real click opens a single chat for the clicked pet', async () => {
      await inspect('benchmark', 'walking')
      // Let the actual 50 ms native timer apply its first controlled position;
      // otherwise the first sample would still describe the prior drag location.
      await delay(150)
      const motionStarted = Date.now()
      const motionSizes = []
      for (let sample = 0; sample <= 5; sample++) {
        if (sample) await delay(2200)
        const snapshot = await inspect('snapshot')
        const observed = snapshot.records.map(({ petId, state, bounds, handle }) => ({ petId, state, bounds, handle }))
        const native = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(__dirname, 'native-observe.ps1'), '-ExpectedProcessId', String(snapshot.pid), '-WindowsJson',
          JSON.stringify(observed.map(({ petId, handle }) => ({ petId, handle })))], { windowsHide: true, timeout: 15000 })
        const physical = JSON.parse(native.stdout.trim())
        const dpr = await mainPage.evaluate(() => devicePixelRatio)
        motionSizes.push({ sample, elapsedMs: Date.now() - motionStarted, pets: observed, physical, dpr })
      }
      result.motionSizeRegression = motionSizes
      await save()
      assert.ok(motionSizes.at(-1).elapsedMs >= 10000)
      assert.ok(motionSizes.every((sample) => sample.pets.every((pet) => Math.abs(pet.bounds.width - 188) <= 1 && Math.abs(pet.bounds.height - 196) <= 1)),
        'Native pet geometry must stay within one DIP of 188x196 during fractional-DPI motion')
      for (const pet of motionSizes[0].pets) {
        const sizes = motionSizes.map((sample) => sample.pets.find((value) => value.petId === pet.petId))
        assert.ok(Math.max(...sizes.map((value) => value.bounds.width)) - Math.min(...sizes.map((value) => value.bounds.width)) <= 1)
        assert.ok(Math.max(...sizes.map((value) => value.bounds.height)) - Math.min(...sizes.map((value) => value.bounds.height)) <= 1)
        assert.ok(Math.abs(sizes.at(-1).bounds.y - sizes[0].bounds.y) > 20)
      }
      await nativeInput(petA.pet_id, 'click')
      const { page, record } = await chatFor(petA.pet_id)
      await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
      const firstId = record.chatId
      assert.equal((await desktopCommand('openChat', petA.pet_id)).ok, true)
      assert.equal((await petRecord(petA.pet_id)).chatId, firstId, 'Repeated click must reuse the existing pet chat')
      return { chatWindowId: firstId, petId: petA.pet_id }
    })
    await check('per-pet memory defaults off and explicit UI confirmation saves only one pet', async () => {
      const pref1 = await realApi(mainPage, 'GET', '/api/v1/pets/' + petA.pet_id + '/memory/preferences')
      const pref2 = await realApi(mainPage, 'GET', '/api/v1/pets/' + petA2.pet_id + '/memory/preferences')
      assert.equal(pref1.data.long_term_memory_enabled, false)
      assert.equal(pref2.data.long_term_memory_enabled, false)
      await mainPage.goto(uiOrigin + '/pets/' + petA.pet_id + '/memory')
      await mainPage.getByRole('switch', { name: '长期记忆授权', exact: true }).click()
      const permit = mainPage.getByRole('dialog', { name: '开启长期记忆', exact: true })
      await permit.getByLabel('我了解并同意以上长期记忆说明', { exact: true }).check()
      await permit.getByRole('button', { name: '确认开启', exact: true }).click()
      await expect(permit).not.toBeVisible()
      await mainPage.getByRole('button', { name: '添加记忆', exact: true }).click()
      const add = mainPage.getByRole('dialog', { name: '添加一条记忆', exact: true })
      await add.getByLabel('记忆标题', { exact: true }).fill('森林散步偏好')
      await add.getByLabel('记忆内容', { exact: true }).fill('我喜欢在森林里慢慢散步。')
      await add.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true }).check()
      await add.getByRole('button', { name: '确认保存', exact: true }).click()
      await expect(add).not.toBeVisible()
      const saved = await realApi(mainPage, 'GET', '/api/v1/pets/' + petA.pet_id + '/memory/items')
      assert.equal(saved.status, 200); assert.equal(saved.data.items.length, 1)
      memoryA = saved.data.items[0].id
      assert.equal(saved.data.items[0].pet_id, petA.pet_id)
      assert.equal((await realApi(mainPage, 'GET', '/api/v1/pets/' + petA2.pet_id + '/memory/items/' + memoryA)).status, 404)
      assert.equal((await realApi(mainPage, 'GET', '/api/v1/pets/' + petA2.pet_id + '/memory/preferences')).data.long_term_memory_enabled, false)
      return { savedMemoryId: memoryA, petId: petA.pet_id, otherPetDefaultsOff: true, explicitConfirmation: true }
    })
    if (previous) await check('resume validates the exact previously confirmed private memory without changing it', async () => {
      const prior = previousChecks.get('per-pet memory defaults off and explicit UI confirmation saves only one pet').detail
      assert.equal(prior.petId, petA.pet_id)
      memoryA = prior.savedMemoryId
      const expectedOwner = previousChecks.get('release three pets through real companions UI').detail[0].owner
      assert.equal(ownerA.id, expectedOwner)
      const saved = await realApi(mainPage, 'GET', '/api/v1/pets/' + petA.pet_id + '/memory/items/' + memoryA)
      assert.equal(saved.status, 200); assert.equal(saved.data.pet_id, petA.pet_id); assert.equal(saved.data.id, memoryA)
      assert.equal(saved.data.title, '森林散步偏好'); assert.equal(saved.data.content, '我喜欢在森林里慢慢散步。')
      assert.equal((await realApi(mainPage, 'GET', '/api/v1/pets/' + petA.pet_id + '/memory/preferences')).data.long_term_memory_enabled, true)
      assert.equal((await realApi(mainPage, 'GET', '/api/v1/pets/' + petA2.pet_id + '/memory/preferences')).data.long_term_memory_enabled, false)
      assert.equal((await realApi(mainPage, 'GET', '/api/v1/pets/' + petA2.pet_id + '/memory/items/' + memoryA)).status, 404)
      return { savedMemoryId: memoryA, petId: petA.pet_id, ownerId: ownerA.id, contentMatched: true, mutations: 0 }
    })
    if (previousChecks.has('real Mock SSE, pet identity and persisted history after reload')) {
      await check('resume validates previously persisted pet conversation', async () => {
        const prior = previousChecks.get('real Mock SSE, pet identity and persisted history after reload').detail
        assert.equal(prior.petId, petA.pet_id)
        sessionA = prior.sessionId; generationA = prior.generationId
        const history = await realApi(mainPage, 'GET', '/api/v1/pets/' + petA.pet_id + '/sessions/' + sessionA + '/messages')
        assert.equal(history.status, 200)
        assert.ok(history.data.items.every((message) => message.pet_id === petA.pet_id))
        const message = history.data.items.find((message) => message.role === 'user' && message.content.startsWith('P6 私人聊天 A '))
        assert.ok(message); messageA = message.content
        return { petId: petA.pet_id, sessionId: sessionA, generationId: generationA, userMessageId: message.id, mutations: 0 }
      })
    }
    if (phase === 'security-tail') await check('security continuation primes real private chat cache before switching accounts', async () => {
      assert.equal((await desktopCommand('openChat', petA.pet_id)).ok, true)
      const { page } = await chatFor(petA.pet_id)
      await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
      await page.locator('a[href="/pets/' + petA.pet_id + '/chat/' + sessionA + '"]').first().click()
      await expect(page.getByRole('log')).toContainText(messageA)
      await mainPage.goto(uiOrigin + '/pets/' + petA.pet_id + '/chat/' + sessionA)
      await expect(mainPage.getByRole('log')).toContainText(messageA)
      return { petId: petA.pet_id, sessionId: sessionA, mainAndNativeChatPrimed: true, providerCalled: false }
    })
    await check('real Mock SSE, pet identity and persisted history after reload', async () => {
      const { page } = await chatFor(petA.pet_id)
      const text = 'P6 私人聊天 A ' + crypto.randomUUID() + '。我喜欢怎样的森林散步？'
      const observationsBefore = (await providerObservations()).length
      const task = await sendChat(page, petA.pet_id, text)
      await completed(page)
      sessionA = task.accepted.generation.session_id; generationA = task.accepted.generation.id; messageA = text
      const history = await realApi(page, 'GET', '/api/v1/pets/' + petA.pet_id + '/sessions/' + sessionA + '/messages')
      assert.equal(history.status, 200)
      assert.ok(history.data.items.some((message) => message.content === text))
      assert.ok(history.data.items.some((message) => message.role === 'assistant' && message.content.includes(completeText)))
      assert.ok(history.data.items.every((message) => message.pet_id === petA.pet_id))
      await page.reload()
      await expect(page.getByRole('log')).toContainText(text)
      await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toHaveCount(0)
      const observations = (await providerObservations()).slice(observationsBefore)
      assert.equal(observations.length, 1, 'This sequential real generation must add exactly one Provider observation')
      assert.ok(observations[0].memories.some((memory) => memory.memory_id === memoryA), 'The real Mock Provider must receive the authorized relevant memory ID')
      return { petId: petA.pet_id, sessionId: sessionA, generationId: generationA, messageCount: history.data.items.length,
        provider: 'Mock', providerObservedMemoryId: memoryA }
    })
    await check('actual Windows screenshot includes persisted chat and three native pets', async () => {
      await mainPage.goto(uiOrigin + '/pets/' + petA.pet_id + '/chat/' + sessionA)
      await expect(mainPage.getByRole('log')).toContainText(messageA)
      await inspect('arrange'); await delay(350)
      const snapshot = await inspect('snapshot')
      const file = path.join(runDirectory, 'windows-pet-chat.png')
      try {
        const capture = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(__dirname, 'capture.ps1'), '-WindowHandle', snapshot.mainHandle, '-ExpectedProcessId', String(snapshot.pid),
          '-OutputPath', file, '-AllowedDirectory', runDirectory], { windowsHide: true, timeout: 15000 })
        const detail = JSON.parse(capture.stdout.trim()); result.screenshots.push(detail); return detail
      } finally { await inspect('restore-topmost') }
    })
    await check('separate pet chat has separate history and rejects foreign session', async () => {
      assert.equal((await desktopCommand('openChat', petA2.pet_id)).ok, true)
      const { page: second, record } = await chatFor(petA2.pet_id)
      assert.notEqual(record.chatId, (await petRecord(petA.pet_id)).chatId)
      await expect(second.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
      await expect(second.getByRole('navigation', { name: '历史会话', exact: true })).not.toContainText(messageA)
      const denied = await realApi(second, 'GET', '/api/v1/pets/' + petA2.pet_id + '/sessions/' + sessionA + '/messages')
      assert.equal(denied.status, 404)
      const observationsBefore = (await providerObservations()).length
      await sendChat(second, petA2.pet_id, 'P6 只属于第二只宠物。森林散步。'); await completed(second)
      await expect(second.getByRole('log')).not.toContainText(messageA)
      const observations = (await providerObservations()).slice(observationsBefore)
      assert.equal(observations.length, 1, 'The second pet must add exactly one separate Provider observation')
      assert.equal(observations[0].memories.some((memory) => memory.memory_id === memoryA), false)
      return { separateChatWindow: true, crossPetStatus: denied.status }
    })
    await check('SSE transport fault reconnects GET without repeating POST', async () => {
      const { page } = await chatFor(petA.pet_id)
      let aborted = 0
      let posts = 0
      const count = (request) => { if (request.method() === 'POST' && request.url().endsWith('/messages')) posts++ }
      page.on('request', count)
      const pattern = '**/api/v1/pets/' + petA.pet_id + '/sessions/*/generations/*/events'
      await page.route(pattern, async (route) => { if (aborted++ === 0) await route.abort('connectionreset'); else await route.continue() })
      try {
        const task = await sendChat(page, petA.pet_id, 'P6 断线恢复保持单条消息')
        await completed(page)
        assert.ok(aborted >= 2, 'The browser must really retry the SSE GET')
        assert.equal(posts, 1)
        const base = '/api/v1/pets/' + petA.pet_id + '/sessions/' + task.accepted.generation.session_id + '/generations/' + task.accepted.generation.id
        const events = await realApi(page, 'GET', base + '/events')
        assert.equal(events.status, 200)
        const frames = eventFrames(events.data)
        assert.ok(frames.length > 2); assert.equal(new Set(frames.map((frame) => frame.id)).size, frames.length)
        assert.ok(frames.every((frame) => frame.data.pet_id === petA.pet_id))
        assert.equal(frames.filter((frame) => ['completed', 'cancelled', 'error'].includes(frame.event)).length, 1)
        const replay = await realApi(page, 'GET', base + '/events', undefined, undefined, { 'Last-Event-ID': frames[0].id })
        assert.equal(replay.status, 200)
        assert.ok(eventFrames(replay.data).every((frame) => frame.data.sequence > frames[0].data.sequence))
        const retry = await realApi(page, 'POST', '/api/v1/pets/' + petA.pet_id + '/sessions/' + task.accepted.generation.session_id + '/messages',
          task.request.body, task.request.headers['idempotency-key'])
        assert.equal(retry.status, 202)
        assert.equal(retry.data.generation.id, task.accepted.generation.id)
        assert.equal(retry.data.user_message.id, task.accepted.user_message.id)
        return { abortedGet: 1, getAttempts: aborted, messagePosts: posts, replayEvents: eventFrames(replay.data).length, idempotentGeneration: true }
      } finally { page.off('request', count); await page.unroute(pattern) }
    })
    await check('stop generation and durable single terminal event', async () => {
      const { page } = await chatFor(petA.pet_id)
      const task = await sendChat(page, petA.pet_id, 'P6 这一条希望中途停止生成')
      await page.getByRole('button', { name: '停止生成', exact: true }).click()
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 15000 })
      const base = '/api/v1/pets/' + petA.pet_id + '/sessions/' + task.accepted.generation.session_id + '/generations/' + task.accepted.generation.id
      const state = await until(async () => {
        const value = await realApi(page, 'GET', base)
        assert.equal(value.status, 200)
        return ['cancelled', 'completed', 'error'].includes(value.data.generation.state) && value
      }, 'Cancellation did not reach a durable terminal state')
      assert.equal(state.data.generation.state, 'cancelled')
      const events = eventFrames((await realApi(page, 'GET', base + '/events')).data)
      assert.equal(events.filter((frame) => ['completed', 'cancelled', 'error'].includes(frame.event)).length, 1)
      assert.equal(events.at(-1).event, 'cancelled')
      assert.ok(events.every((frame) => frame.data.pet_id === petA.pet_id))
      return { state: state.data.generation.state, terminalEvents: 1, petId: petA.pet_id }
    })
    await check('hide, show and recall affect only the selected native pet', async () => {
      assert.equal((await desktopCommand('hide', petA3.pet_id)).ok, true)
      await until(async () => (await petRecord(petA3.pet_id))?.visible === false, 'Hidden pet remained visible')
      assert.equal((await petRecord(petA.pet_id)).visible, true)
      assert.equal((await petRecord(petA2.pet_id)).visible, true)
      assert.equal((await desktopCommand('show', petA3.pet_id)).ok, true)
      await until(async () => (await petRecord(petA3.pet_id))?.visible, 'Hidden pet did not return')
      assert.equal((await desktopCommand('recall', petA3.pet_id)).ok, true)
      await until(async () => !(await petRecord(petA3.pet_id)), 'Recalled pet record/window remained alive')
      assert.equal((await inspect('snapshot')).records.length, 2)
      assert.equal((await desktopCommand('release', petA3.pet_id)).ok, true)
      await until(async () => (await inspect('snapshot')).records.length === 3, 'Releasing a recalled pet failed')
      return { hide: true, show: true, recall: true, otherPetsPreserved: true }
    })
    await check('three-pet idle CPU and memory, actual Electron process tree', async () => {
      console.log('WAIT performance gate: require the coordinator to confirm no competing test workload')
      await until(async () => {
        try {
          const permit = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'performance-ready.json'), 'utf8'))
          return permit.runId === target.runId && permit.ready === true
        } catch (error) { if (error.code === 'ENOENT') return false; throw error }
      }, 'Performance blocked: no explicit quiet-workload confirmation', 900000)
      await inspect('arrange')
      const setup = await inspect('benchmark', 'idle')
      const sample = await samplePerformance(app, 'three pets controlled idle', 11000, 1000, () => inspect('motion'))
      assert.ok(sample.samples.every((value) => value.petStates.every((pet) => pet.state === 'idle')))
      result.performance.push(sample)
      return { setup, durationMs: sample.durationMs, sampleCount: sample.sampleCount, averageCpuPercent: sample.averageCpuPercent,
        averageWorkingSetKiB: sample.averageWorkingSetKiB, caveat: sample.caveat }
    })
    await check('three-pet movement CPU and memory, actual renderer state', async () => {
      const pages = app.windows().filter((page) => page.url().includes('pet.html'))
      assert.equal(pages.length, 3, 'Performance needs three real pet renderers')
      const states = await Promise.all(pages.map((page) => page.evaluate(() => ({ petId: document.body.dataset.petId, state: document.body.dataset.state }))))
      const setup = await inspect('benchmark', 'walking')
      await delay(150)
      const moving = await Promise.all(pages.map((page) => page.evaluate(() => document.body.dataset.state)))
      assert.ok(moving.every((state) => state === 'walking'))
      const sample = await samplePerformance(app, 'three pets controlled walking', 11000, 1000, () => inspect('motion'))
      assert.ok(sample.samples.every((value) => value.petStates.every((pet) => pet.state === 'walking')))
      assert.ok(sample.samples.at(-1).petStates.every((pet, index) => Math.abs(pet.y - sample.samples[0].petStates[index].y) > 50))
      result.performance.push(sample)
      return { setup, initialStates: states, movementStates: moving, durationMs: sample.durationMs, sampleCount: sample.sampleCount,
        averageCpuPercent: sample.averageCpuPercent, averageWorkingSetKiB: sample.averageWorkingSetKiB, caveat: sample.caveat }
    })
    await check('renderer crash reclaims only that pet and its chat', async () => {
      assert.equal((await desktopCommand('openChat', petA3.pet_id)).ok, true)
      const old = await petRecord(petA3.pet_id)
      await inspect('crash', petA3.pet_id)
      await until(async () => !(await petRecord(petA3.pet_id)), 'Crashed renderer leaked its record/window')
      const snapshot = await inspect('snapshot')
      assert.equal(snapshot.records.length, 2)
      assert.ok(snapshot.records.every((record) => record.windowId !== old.windowId && record.chatId !== old.chatId))
      assert.equal((await desktopCommand('release', petA3.pet_id)).ok, true)
      await until(async () => (await inspect('snapshot')).records.length === 3, 'Crashed pet could not be safely released again')
      return { rendererCrashed: old.windowId, petRecovered: true, otherPetsPreserved: true }
    })
    await check('logout destroys private windows and session API becomes 401', async () => {
      await logout()
      await until(async () => (await inspect('snapshot')).records.length === 0, 'Logout left private pet/chat windows alive')
      const denied = await realApi(mainPage, 'GET', '/api/v1/pets/' + petA.pet_id + '/sessions/' + sessionA + '/messages')
      assert.equal(denied.status, 401)
      const native = await desktopCommand('release', petA.pet_id)
      assert.equal(native.ok, false)
      return { privateApiStatus: 401, windowsRemaining: 0, nativeReleaseDenied: true }
    })
    await check('account B cannot access account A pets, messages or native window', async () => {
      const ownerB = await login(target.accounts.b)
      assert.notEqual(ownerB.id, ownerA.id)
      for (const requestPath of ['/api/v1/pets/' + petA.pet_id,
        '/api/v1/pets/' + petA.pet_id + '/sessions/' + sessionA + '/messages',
        '/api/v1/pets/' + petA.pet_id + '/memory/preferences', '/api/v1/pets/' + petA.pet_id + '/memory/items',
        '/api/v1/pets/' + petA.pet_id + '/memory/items/' + memoryA,
        '/api/v1/pets/' + petB.pet_id + '/memory/items/' + memoryA]) {
        assert.equal((await realApi(mainPage, 'GET', requestPath)).status, 404)
      }
      assert.equal((await desktopCommand('release', petA.pet_id)).ok, false)
      assert.equal((await inspect('snapshot')).records.length, 0)
      assert.equal((await desktopCommand('release', petB.pet_id)).ok, true)
      await until(async () => (await petRecord(petB.pet_id))?.visible, 'Account B own pet failed')
      const record = await petRecord(petB.pet_id)
      assert.equal(record.owner, ownerB.id)
      assert.equal((await realApi(mainPage, 'GET', '/api/v1/pets/' + petB.pet_id + '/memory/preferences')).data.long_term_memory_enabled, false)
      assert.equal((await desktopCommand('openChat', petB.pet_id)).ok, true)
      const { page } = await chatFor(petB.pet_id)
      await expect(page.locator('body')).not.toContainText(messageA)
      await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
      return { crossUserStatus: 404, nativeForeignPetDenied: true, currentOwner: ownerB.id, currentPet: petB.pet_id }
    })
    await check('network authentication failure closes old native private windows', async () => {
      assert.equal(await portIsOpen(38319), false, 'The isolated dead-proxy port is already in use; no network configuration was changed')
      const before = await inspect('snapshot')
      assert.ok(before.records.length > 0 && before.records.some((record) => record.chatId), 'Fault injection requires real private pet and chat windows')
      await inspect('offline', true)
      try {
        const transport = await mainPage.evaluate(async () => {
          try { const response = await fetch('/api/v1/auth/me', { credentials: 'include', signal: AbortSignal.timeout(5000) }); return { reachedServer: true, status: response.status } }
          catch (error) { return { reachedServer: false, errorType: error.name } }
        })
        assert.equal(transport.reachedServer, false, 'The transport fault must really prevent /me from reaching the API')
        const denied = await desktopCommand('syncSession')
        assert.equal(denied.ok, false, 'An unverified offline identity must not authorize native resources')
        await until(async () => (await inspect('snapshot')).records.length === 0, 'Network failure left private windows alive')
        return { failure: 'real unreachable loopback proxy scoped to this Electron UI session', transport,
          authenticatedBefore: before.records[0].owner, privateWindowsBefore: before.records.length,
          privateWindowsRemaining: 0, systemProxyModified: false }
      } finally { await inspect('offline', false) }
    })
    await check('expired/revoked Cookie fails closed and no cached owner is reused', async () => {
      await inspect('clear-auth-cookie')
      const response = await realApi(mainPage, 'GET', '/api/v1/auth/me')
      assert.equal(response.status, 401)
      assert.equal((await desktopCommand('release', petB.pet_id)).ok, false)
      assert.equal((await inspect('snapshot')).records.length, 0)
      return { expiredSessionStatus: 401, nativeResourcesDenied: true }
    })
    await check('real tray Quit exits this instance and releases its UI port', async () => {
      const exited = app.waitForEvent('close', { timeout: 15000 })
      await inspect('quit-menu')
      await exited
      expectedQuit = true
      await until(async () => !(await portIsOpen(target.uiPort)), 'Electron UI port remained open after safe Quit')
      return { exited: true, uiPortReleased: true, externalBackendNotStopped: true }
    })
    result.status = result.pendingChecks.length ? 'PARTIAL' : 'PASSED'
  } catch (error) {
    result.status = 'FAILED'
    result.error = String(error.stack || error)
    console.error(error.message)
    process.exitCode = 1
  } finally {
    if (app && !expectedQuit) {
      try { await inspect('offline', false) } catch { /* Already exited. */ }
      try { await app.close() } catch (error) { result.cleanupError = String(error); process.exitCode = 1 }
    }
    result.completedAt = new Date().toISOString()
    result.passed = result.checks.filter((check) => check.status === 'passed').length
    result.failed = result.checks.filter((check) => check.status === 'failed').length
    result.skipped = 0
    result.uiPortStillOpen = await portIsOpen(target.uiPort)
    if (result.uiPortStillOpen) { result.status = 'FAILED'; process.exitCode = 1 }
    await save()
    console.log(JSON.stringify({ status: result.status, passed: result.passed, failed: result.failed, skipped: result.skipped,
      resultsFile, reusedEvidence: result.reusedEvidence.length, screenshots: result.screenshots.map((screenshot) => screenshot.file) }))
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
