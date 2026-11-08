/** Real HTTP + PostgreSQL + Redis. No route.fulfill or P3 response fixtures. */
import { mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loginAccount, registerAccount } from '../e2e/helpers/auth'
import type { GenerationAccepted, GenerationSnapshot, StoredSession } from '../src/features/chat/api-types'

const prefix = '/api/v1/companion'
const origin = 'http://127.0.0.1:35174'
const apiOrigin = 'http://127.0.0.1:38101'
const fixedReply = '你可以用它体验已保存会话的流式显示。'
const execute = promisify(execFile)

async function fixture(operation: string, payload: object) {
  const python = process.env.WEIBIYE_TEST_PYTHON ?? '../backend/.venv/Scripts/python.exe'
  const result = await execute(python, ['-B', '../backend/scripts/p3_integration_acceptance.py',
    'fixture', operation, JSON.stringify(payload)], { encoding: 'utf8' })
  return JSON.parse(result.stdout) as Record<string, string>
}

async function setup(page: Page) {
  const email = await registerAccount(page, '真实集成测试账户')
  await loginAccount(page, email)
  return email
}
async function command(page: Page, method: string, path: string, data: object = {}, key?: string) {
  const csrf = await (await page.request.get('/api/v1/auth/csrf')).json() as { csrf_token: string }
  return page.request.fetch(prefix + path, {
    method, data, headers: { Origin: origin, 'X-CSRF-Token': csrf.csrf_token,
      ...(key ? { 'Idempotency-Key': key } : {}) },
  })
}
async function session(page: Page, title = '真实 API 联调会话') {
  const response = await command(page, 'POST', '/sessions', { title, companion_id: null }, crypto.randomUUID())
  expect(response.status()).toBe(201)
  return (await response.json() as { session: StoredSession }).session
}
async function accept(page: Page, id: string, content = '真实服务的本地 Mock 验证输入') {
  const response = await command(page, 'POST', `/sessions/${id}/messages`,
    { content, client_message_id: crypto.randomUUID() }, crypto.randomUUID())
  expect(response.status()).toBe(202)
  return await response.json() as GenerationAccepted
}
async function send(page: Page, content: string) {
  await page.getByLabel('聊天消息', { exact: true }).fill(content)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/[a-f\d-]+$/)
}
async function complete(page: Page) {
  await expect(page.getByRole('log')).toContainText(fixedReply, { timeout: 20_000 })
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
}
async function logout(page: Page) {
  await page.goto('/me')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('访客头像，打开账户菜单', { exact: true })).toBeVisible()
}
function frames(text: string) {
  return text.split(/\r?\n\r?\n/).filter((block) => block.includes('data:')).map((block) => {
    const lines = block.split(/\r?\n/)
    const data = JSON.parse(lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
    return { id: lines.find((line) => line.startsWith('id:'))?.slice(3).trim(),
      event: lines.find((line) => line.startsWith('event:'))?.slice(6).trim(), data }
  })
}

test('真实注册、登录、多轮聊天及刷新/重新登录后的 PostgreSQL 历史恢复', async ({ page }) => {
  const logged: string[] = []
  page.on('console', (message) => logged.push(message.text()))
  const email = await setup(page)
  const sentinel = `私人日志检查-${crypto.randomUUID()}`
  await send(page, sentinel); await complete(page)
  const route = new URL(page.url()).pathname
  await send(page, '第二轮真实持久化输入'); await complete(page)
  await expect(page.getByRole('log').locator('.message-user')).toHaveCount(2)
  await page.reload()
  await expect(page.getByRole('log')).toContainText(sentinel)
  await expect(page.getByRole('log')).toContainText('第二轮真实持久化输入')
  await logout(page)
  await expect(page.getByRole('main')).not.toContainText(sentinel)
  await loginAccount(page, email); await page.goto(route)
  await expect(page.getByRole('log').locator('.message-user')).toHaveCount(2)
  expect(logged.some((line) => line.includes(sentinel))).toBe(false)
  await mkdir('.verification/p3-real', { recursive: true })
  await page.screenshot({ path: '.verification/p3-real/desktop.png', fullPage: true })
})

test('真实 Cookie、CSRF、CORS 与输入限制，不存在浏览器持久化令牌', async ({ page, context }) => {
  await setup(page)
  const cookie = (await context.cookies()).find((item) => item.name === 'weibiye_session')!
  expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Lax'); expect(cookie.secure).toBe(false)
  expect(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)).toBe(0)
  const id = (await session(page)).id
  const path = `/sessions/${id}/messages`
  const payload = { content: '安全边界输入', client_message_id: crypto.randomUUID() }
  expect((await page.request.post(prefix + path, { data: payload, headers: { Origin: origin } })).status()).toBe(403)
  const csrf = await (await page.request.get('/api/v1/auth/csrf')).json()
  expect((await page.request.post(prefix + path, { data: payload, headers: {
    Origin: 'https://untrusted.example', 'X-CSRF-Token': csrf.csrf_token,
  } })).status()).toBe(403)
  const preflight = await page.request.fetch(apiOrigin + prefix + path, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-CSRF-Token,Idempotency-Key,Last-Event-ID',
  } })
  expect(preflight.status()).toBe(200)
  expect(preflight.headers()['access-control-allow-origin']).toBe(origin)
  expect(preflight.headers()['access-control-allow-credentials']).toBe('true')
  const denied = await page.request.fetch(apiOrigin + prefix + path, { method: 'OPTIONS', headers: {
    Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'POST',
  } })
  expect(denied.headers()['access-control-allow-origin']).toBeUndefined()
  const invalid = await command(page, 'POST', path, { ...payload, content: '😀'.repeat(4001) }, crypto.randomUUID())
  expect(invalid.status()).toBe(422)
  expect(await invalid.text()).not.toContain('😀')
})

test('真实账号 A/B 的会话、消息、SSE、取消、重试与隐藏均校验 owner', async ({ page, browser }) => {
  await setup(page); await send(page, '账户 A 私人缓存探针'); await complete(page)
  const aId = new URL(page.url()).pathname.split('/').at(-1)!
  const accepted = await accept(page, aId)
  const other = await browser.newContext({ baseURL: origin })
  try {
    const b = await other.newPage(); const bEmail = await setup(b)
    const bId = (await session(b, '账户 B 的会话')).id
    expect((await page.request.get(`${prefix}/sessions/${bId}`)).status()).toBe(404)
    const generation = accepted.generation.id
    for (const suffix of ['', '/messages', `/generations/${generation}`, `/generations/${generation}/events`]) {
      expect((await b.request.get(`${prefix}/sessions/${aId}${suffix}`)).status()).toBe(404)
    }
    for (const [method, suffix, body] of [
      ['PATCH', '', { title: '越权修改', expected_version: 1 }], ['DELETE', '', {}],
      ['POST', '/messages', { content: '越权输入', client_message_id: crypto.randomUUID() }],
      ['POST', `/generations/${generation}/cancel`, {}],
      ['POST', '/generations', { retry_of_generation_id: generation }],
      ['POST', '/topic-dismissals', { summary_version: 'not-owned' }],
    ] as const) {
      expect((await command(b, method, `/sessions/${aId}${suffix}`, body, crypto.randomUUID())).status()).toBe(404)
    }
    await logout(page); await loginAccount(page, bEmail)
    await expect(page.getByRole('main')).not.toContainText('账户 A 私人缓存探针')
    await page.goto(`/chat/${bId}`)
    await expect(page.getByRole('main')).not.toContainText('账户 A 私人缓存探针')
  } finally { await other.close() }
})

test('真实 SSE 帧按顺序持久化，Last-Event-ID 重放与快照全文一致', async ({ page }) => {
  await setup(page)
  const id = (await session(page)).id; const accepted = await accept(page, id)
  const generation = accepted.generation.id
  const path = `${prefix}/sessions/${id}/generations/${generation}`
  const response = await page.request.get(`${path}/events`, { headers: { Accept: 'text/event-stream' } })
  expect(response.headers()['content-type']).toContain('text/event-stream')
  expect(response.headers()['cache-control']).toContain('no-store')
  const events = frames(await response.text())
  expect(events[0].event).toBe('start'); expect(events.at(-1)?.event).toBe('completed')
  expect(events.some((event) => event.event === 'delta')).toBe(true)
  events.forEach((event, index) => {
    expect(event.id).toBe(`${generation}:${index + 1}`)
    expect(event.data).toMatchObject({ version: 1, scope: 'generation', session_id: id, generation_id: generation,
      message_id: accepted.assistant_message.id, sequence: index + 1 })
  })
  expect(events.at(-1)?.data.usage).toBeNull()
  const snapshot = await (await page.request.get(path)).json() as GenerationSnapshot
  expect(snapshot.assistant_message.content).toBe(events.at(-1)?.data.content)
  expect(snapshot.resume_after_event_id).toBe(events.at(-1)?.id)
  const resumed = frames(await (await page.request.get(`${path}/events`, { headers: { 'Last-Event-ID': `${generation}:2` } })).text())
  expect(resumed[0].id).toBe(`${generation}:3`)
  expect(new Set([...events.slice(0, 2), ...resumed].map((event) => event.id)).size).toBe(events.length)
  expect((await page.request.get(`${path}/events`, { headers: { 'Last-Event-ID': `${generation}:999` } })).status()).toBe(422)
})

test('真实停止生成等待服务器 cancelled，保留部分消息且不重复输入', async ({ page }) => {
  await setup(page); await send(page, '真实取消任务输入')
  await expect(page.getByRole('log')).toContainText('【Mock 演示】')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('已停止生成', { timeout: 15_000 })
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  const result = await (await page.request.get(`${prefix}/sessions/${id}/messages`)).json()
  expect(result.items.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
  expect(result.items.at(-1).status).toBe('cancelled')
  await page.reload(); await expect(page.getByRole('log')).toContainText('已停止生成')
})

test('真实网络断开后仅 GET 同一任务并去重，不重新发送用户消息', async ({ page, context }) => {
  await setup(page)
  let sends = 0; const resumes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) sends++
    if (request.url().endsWith('/events') && request.headers()['last-event-id']) resumes.push(request.headers()['last-event-id'])
  })
  await send(page, '真实断网恢复探针')
  await expect(page.getByRole('log')).toContainText('【Mock 演示】')
  await context.setOffline(true)
  await page.waitForTimeout(900)
  await context.setOffline(false)
  await complete(page)
  expect(sends).toBe(1)
  await expect(page.getByRole('log').locator('.message-user')).toHaveCount(1)
  expect(resumes.length).toBeGreaterThan(0)
  const text = await page.getByRole('log').locator('.message-assistant .message-body > p').first().textContent()
  expect(text?.split('【Mock 演示】')).toHaveLength(2)
})

test('真实 SSE 网络停滞触发超时，恢复后读取原任务而不重新生成', async ({ page, context }) => {
  await setup(page)
  let sends = 0; let reads = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) sends++
    if (request.url().endsWith('/events')) reads++
  })
  const cdp = await context.newCDPSession(page)
  let held = false; let released = 0; let status = 0
  const continuationErrors: string[] = []
  const continuations: Promise<void>[] = []
  cdp.on('Fetch.requestPaused', (event) => {
    if (!held) {
      held = true; status = event.responseStatusCode ?? 0
      // Hold the real server's first SSE response at the browser transport.
      // No headers, status codes, frames or API results are synthesized.
      return
    }
    continuations.push(cdp.send('Fetch.continueResponse', { requestId: event.requestId })
      .then(() => { released++ }).catch((cause: unknown) => { continuationErrors.push(String(cause)) }))
  })
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/events', requestStage: 'Response' }] })
    await send(page, '真实流超时探针')
    await expect.poll(() => held).toBe(true)
    expect(status).toBe(200)
    await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThan(1)
    await expect.poll(() => released).toBeGreaterThan(0)
    await Promise.all(continuations)
    expect(continuationErrors).toEqual([])
  } finally {
    await cdp.send('Fetch.disable')
    await cdp.detach()
  }
  await complete(page)
  expect(sends).toBe(1)
})

test('真实 PostgreSQL 并发幂等请求只创建一组消息及一个任务', async ({ page }) => {
  await setup(page)
  const id = (await session(page)).id; const key = crypto.randomUUID()
  const payload = { content: '真实并发幂等输入', client_message_id: crypto.randomUUID() }
  const replies = await Promise.all([command(page, 'POST', `/sessions/${id}/messages`, payload, key),
    command(page, 'POST', `/sessions/${id}/messages`, payload, key)])
  expect(replies.map((response) => response.status())).toEqual([202, 202])
  const results = await Promise.all(replies.map((response) => response.json()))
  expect(results[0].generation.id).toBe(results[1].generation.id)
  expect(results[0].user_message.id).toBe(results[1].user_message.id)
  expect((await command(page, 'POST', `/sessions/${id}/messages`, { ...payload, content: '指纹冲突' }, key)).status()).toBe(409)
  expect((await command(page, 'POST', `/sessions/${id}/messages`, payload, crypto.randomUUID())).status()).toBe(409)
  const history = await (await page.request.get(`${prefix}/sessions/${id}/messages`)).json()
  expect(history.items).toHaveLength(2)
})

test('真实最近话题授权、继续、隐藏、关闭与删除保持一致', async ({ page }) => {
  await setup(page); await send(page, '真实推荐授权探针'); await complete(page)
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  let sends = 0
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/messages')) sends++ })
  await page.goto('/preferences/conversations')
  const consent = page.getByRole('checkbox', { name: '允许当前账户历史话题推荐' })
  await expect(consent).not.toBeChecked()
  const enabled = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/preferences'))
  await consent.check(); expect((await enabled).status()).toBe(200)
  await expect(page.getByText('正在保存授权设置…', { exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  const card = page.getByRole('region', { name: '最近话题', exact: true })
  await expect(card).toContainText('真实推荐授权探针')
  await card.getByRole('link', { name: '继续聊聊' }).click()
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`)); expect(sends).toBe(0)
  await page.goto('/')
  const dismissed = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/topic-dismissals'))
  await card.getByRole('button', { name: '暂时不看', exact: true }).click()
  expect((await dismissed).status()).toBe(204)
  await expect(card).toHaveCount(0)
  await page.reload(); await expect(card).toHaveCount(0)
  expect((await (await page.request.get(`${prefix}/recent-topic`)).json()).item).toBeNull()
  await page.goto('/preferences/conversations')
  await expect(consent).toBeEnabled(); await expect(consent).toBeChecked()
  const disabled = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/preferences'))
  await consent.uncheck(); expect((await disabled).status()).toBe(200)
  await expect(page.getByText('正在保存授权设置…', { exact: true })).toHaveCount(0)
  await page.reload(); await expect(consent).toBeEnabled(); await expect(consent).not.toBeChecked()
  const reenabled = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/preferences'))
  await consent.check(); expect((await reenabled).status()).toBe(200)
  await expect(page.getByText('正在保存授权设置…', { exact: true })).toHaveCount(0)
  await page.goto('/'); await expect(card).toBeVisible()
  const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/sessions/${id}`))
  await page.getByRole('button', { name: '删除会话：新的聊天', exact: true }).click()
  expect((await deleted).status()).toBe(204)
  await expect(card).toHaveCount(0)
  expect((await (await page.request.get(`${prefix}/recent-topic`)).json()).item).toBeNull()
})

test('真实会话重命名版本与逻辑删除，刷新后不恢复墓碑', async ({ page }) => {
  await setup(page); await send(page, '重命名删除探针'); await complete(page)
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  await page.getByRole('button', { name: '重命名会话：新的聊天', exact: true }).click()
  await page.getByLabel('会话标题', { exact: true }).fill('集成已重命名会话')
  const renamed = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/sessions/${id}`))
  await page.getByRole('button', { name: '保存标题', exact: true }).click()
  expect((await renamed).status()).toBe(200)
  await expect(page.getByRole('heading', { name: '集成已重命名会话', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除会话：集成已重命名会话', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  expect((await page.request.get(`${prefix}/sessions/${id}`)).status()).toBe(404)
  await page.reload()
  await expect(page.getByRole('navigation', { name: '历史会话' })).not.toContainText('集成已重命名会话')
})

test('真实移动端 390/320px、抽屉和输入交互保持可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page)
  await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '导航菜单' })).toBeVisible()
  await page.getByRole('button', { name: '关闭导航', exact: true }).click()
  const input = page.getByLabel('聊天消息', { exact: true })
  await input.fill('手机输入第一行'); await input.press('Enter'); await input.type('第二行')
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: '发送消息', exact: true }).click(); await complete(page)
  await expect(page.getByRole('log')).toContainText('手机输入第一行\n第二行')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mkdir('.verification/p3-real', { recursive: true })
  await page.screenshot({ path: '.verification/p3-real/mobile.png', fullPage: true })
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('真实 Cookie 失效后 401 清理私人消息与历史缓存', async ({ page, context }) => {
  await setup(page); await send(page, '认证失效的私人探针'); await complete(page)
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  await context.clearCookies()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByLabel('访客头像，打开账户菜单', { exact: true })).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('认证失效的私人探针')
  expect((await page.request.get(`${prefix}/sessions/${id}`)).status()).toBe(401)
})

test('真实 Redis 限制同用户最多三条 SSE，断开后释放连接配额', async ({ page }) => {
  await setup(page)
  const id = (await session(page)).id; const accepted = await accept(page, id)
  const path = `${prefix}/sessions/${id}/generations/${accepted.generation.id}/events`
  const result = await page.evaluate(async (path) => {
    const controllers = Array.from({ length: 3 }, () => new AbortController())
    const streams = await Promise.all(controllers.map((controller) => fetch(path, {
      credentials: 'include', headers: { Accept: 'text/event-stream' }, signal: controller.signal,
    })))
    try {
      const fourth = await fetch(path, { credentials: 'include' })
      const blocked = fourth.status
      await fourth.body?.cancel()
      controllers.forEach((controller) => controller.abort())
      await new Promise((resolve) => setTimeout(resolve, 250))
      const restored = await fetch(path, { credentials: 'include' })
      const recovered = restored.status; await restored.body?.cancel()
      return { statuses: streams.map((stream) => stream.status), blocked, recovered }
    } finally { controllers.forEach((controller) => controller.abort()) }
  }, path)
  expect(result).toEqual({ statuses: [200, 200, 200], blocked: 429, recovered: 200 })
})

test('真实双账号的推荐来源及授权偏好隔离，另一标签关闭后首页复核', async ({ page, browser }) => {
  await setup(page); await send(page, 'A 专属话题与授权探针'); await complete(page)
  const aId = new URL(page.url()).pathname.split('/').at(-1)!
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const prefs = await (await page.request.get(`${prefix}/preferences`)).json()
  expect(prefs.recent_topic_enabled).toBe(false)
  expect((await command(page, 'PATCH', '/preferences', { recent_topic_enabled: true, expected_version: prefs.version })).status()).toBe(200)
  const aTopic = (await (await page.request.get(`${prefix}/recent-topic`)).json()).item
  expect(aTopic.conversation_id).toBe(aId)
  expect(aTopic.summary).toContain('A 专属话题与授权探针')
  expect(aTopic.source_message_ids).toHaveLength(2)
  const other = await browser.newContext({ baseURL: origin })
  try {
    const b = await other.newPage(); const email = await setup(b)
    expect((await (await b.request.get(`${prefix}/preferences`)).json()).recent_topic_enabled).toBe(false)
    expect((await (await b.request.get(`${prefix}/recent-topic`)).json()).item).toBeNull()
    await send(b, 'B 专属话题与授权探针'); await complete(b)
    const bId = new URL(b.url()).pathname.split('/').at(-1)!
    expect((await command(b, 'PATCH', '/preferences', { recent_topic_enabled: true, expected_version: 0 })).status()).toBe(200)
    const bTopic = (await (await b.request.get(`${prefix}/recent-topic`)).json()).item
    expect(bTopic.conversation_id).toBe(bId)
    expect(bTopic.source_message_ids.some((id: string) => aTopic.source_message_ids.includes(id))).toBe(false)
    expect((await (await page.request.get(`${prefix}/recent-topic`)).json()).item.conversation_id).toBe(aId)
    await page.goto('/'); await expect(page.getByRole('region', { name: '最近话题', exact: true })).toContainText('A 专属话题与授权探针')
    const latest = await (await page.request.get(`${prefix}/preferences`)).json()
    expect((await command(page, 'PATCH', '/preferences', { recent_topic_enabled: false, expected_version: latest.version })).status()).toBe(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('region', { name: '最近话题', exact: true })).toHaveCount(0)
    expect((await (await b.request.get(`${prefix}/preferences`)).json()).recent_topic_enabled).toBe(true)
    await logout(page); await loginAccount(page, email)
    await expect(page.getByRole('region', { name: '最近话题', exact: true })).toContainText('B 专属话题与授权探针')
    await expect(page.getByRole('main')).not.toContainText('A 专属话题与授权探针')
    expect((await (await page.request.get('/api/v1/auth/me')).json()).id).not.toBe(me.id)
  } finally { await other.close() }
})

test('真实服务端会话过期时 Cookie 仍在，但401清理旧账户缓存', async ({ page, context }) => {
  await setup(page); await send(page, '服务端过期私人消息'); await complete(page)
  const owner = await (await page.request.get('/api/v1/auth/me')).json()
  const sessions = await (await page.request.get('/api/v1/auth/sessions')).json()
  const current = sessions.find((item: { current: boolean }) => item.current)
  expect((await context.cookies()).some((cookie) => cookie.name === 'weibiye_session')).toBe(true)
  await fixture('expire-session', { owner_id: owner.id, auth_session_id: current.id })
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByLabel('访客头像，打开账户菜单', { exact: true })).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('服务端过期私人消息')
})

test('真实长度终态在首次快照、刷新与历史切换后保留截断提示', async ({ page }) => {
  await setup(page); await send(page, '[integration-length] 合成长度边界')
  const warning = page.getByText('回复已达到本次长度上限。', { exact: true })
  // The actual private runner caps this test-only Mock at 8000 Unicode points.
  await expect(warning).toBeVisible({ timeout: 20_000 })
  const route = new URL(page.url()).pathname
  const id = route.split('/').at(-1)!
  const history = await (await page.request.get(`${prefix}/sessions/${id}/messages`)).json()
  expect(history.items.at(-1).finish_reason).toBe('length')
  expect([...history.items.at(-1).content]).toHaveLength(8000)
  const gen = history.items.at(-1).generation_id
  const snapshot = await (await page.request.get(`${prefix}/sessions/${id}/generations/${gen}`)).json()
  expect(snapshot.generation.finish_reason).toBe('length')
  expect(snapshot.assistant_message.finish_reason).toBe('length')
  await page.reload(); await expect(warning).toBeVisible()
  await page.goto('/'); await page.goto(route); await expect(warning).toBeVisible()
})

test('真实跨源 Cookie SSE 限流响应向浏览器暴露 Retry-After', async ({ page }) => {
  await setup(page)
  const id = (await session(page)).id; const accepted = await accept(page, id)
  const url = `${apiOrigin}${prefix}/sessions/${id}/generations/${accepted.generation.id}/events`
  const result = await page.evaluate(async (url) => {
    const controllers = Array.from({ length: 3 }, () => new AbortController())
    const streams = await Promise.all(controllers.map((controller) => fetch(url, {
      credentials: 'include', signal: controller.signal, headers: { Accept: 'text/event-stream' },
    })))
    try {
      const fourth = await fetch(url, { credentials: 'include' })
      const result = { statuses: streams.map((response) => response.status), status: fourth.status,
        retryAfter: fourth.headers.get('Retry-After') }
      await fourth.body?.cancel()
      return result
    } finally { controllers.forEach((controller) => controller.abort()) }
  }, url)
  expect(result.statuses).toEqual([200, 200, 200]); expect(result.status).toBe(429)
  expect(Number(result.retryAfter)).toBeGreaterThan(0)
})

test('真实请求已提交而响应丢失时，同幂等键重试不产生重复消息', async ({ page }) => {
  await setup(page)
  let intercepted = false; const attempts: string[] = []
  await page.route('**/api/v1/companion/sessions/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts.push(route.request().headers()['idempotency-key'])
    if (intercepted) return route.continue()
    intercepted = true
    const committed = await route.fetch()
    expect(committed.status()).toBe(202)
    // Fault injection drops only the response; no success response is synthesized.
    await route.abort('failed')
  })
  await send(page, '已提交但响应丢失的幂等输入'); await complete(page)
  expect(attempts).toHaveLength(2); expect(attempts[0]).toBe(attempts[1])
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  const history = await (await page.request.get(`${prefix}/sessions/${id}/messages`)).json()
  expect(history.items).toHaveLength(2)
})

for (const operation of ['journal-gap', 'expire-replay'] as const) {
  test(`真实 ${operation} 后浏览器 SSE 客户端读取权威快照，恢复同一任务`, async ({ page }) => {
    await setup(page)
    const owner = await (await page.request.get('/api/v1/auth/me')).json()
    const id = (await session(page)).id; const accepted = await accept(page, id)
    const generationId = accepted.generation.id
    const path = `${prefix}/sessions/${id}/generations/${generationId}`
    // This is a genuine earlier server snapshot retained by a disconnected client.
    const stale = await (await page.request.get(path)).json() as GenerationSnapshot
    expect(['queued', 'running']).toContain(stale.generation.state)
    await expect.poll(async () => (await (await page.request.get(path)).json()).generation.state).toBe('completed')
    const payload = { owner_id: owner.id, session_id: id, generation_id: generationId }
    const changed = await fixture(operation, payload)
    try {
      const raw = await page.request.get(`${path}/events`)
      if (operation === 'journal-gap') {
        expect(raw.status()).toBe(200)
        expect(frames(await raw.text()).at(-1)?.data).toMatchObject({ scope: 'connection', error: { code: 'STREAM_UNAVAILABLE' } })
      } else expect(raw.status()).toBe(410)
      const result = await page.evaluate(async ({ stale, path, id, generationId }) => {
        const modulePath = '/src/features/chat/private-stream.ts'
        const { watchGeneration } = await import(/* @vite-ignore */ modulePath) as typeof import('../src/features/chat/private-stream')
        let snapshots = 0; let latest: GenerationSnapshot['assistant_message'] | null = null
        let latestState = ''; const states: string[] = []
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        try {
          await watchGeneration({ sessionId: id, generationId, url: `${path}/events`, signal: controller.signal,
            snapshot: async () => ++snapshots === 1 ? stale : await (await fetch(path, { credentials: 'include' })).json(),
            onUpdate: (message, generation) => { latest = message; latestState = generation.state },
            onState: (state) => states.push(state), onUnauthorized: () => { throw new Error('Unexpected auth failure') },
          })
          return { snapshots, latest: latest as GenerationSnapshot['assistant_message'] | null, latestState, states }
        } finally { clearTimeout(timer) }
      }, { stale, path, id, generationId })
      expect(result.snapshots).toBe(2); expect(result.latestState).toBe('completed')
      expect(result.states).toContain('reconnecting')
      expect(result.latest).toMatchObject({ id: accepted.assistant_message.id, status: 'completed', finish_reason: 'stop' })
      const history = await (await page.request.get(`${prefix}/sessions/${id}/messages`)).json()
      expect(history.items).toHaveLength(2)
      expect(result.latest!.content).toBe(history.items.at(-1).content)
    } finally {
      await fixture(operation === 'journal-gap' ? 'restore-journal' : 'restore-replay', { ...payload, ...changed })
    }
  })
}

test('真实另一标签重命名导致旧编辑器409，不能覆盖最新标题', async ({ page }) => {
  await setup(page); await send(page, '真实版本冲突探针'); await complete(page)
  const id = new URL(page.url()).pathname.split('/').at(-1)!
  const before = await (await page.request.get(`${prefix}/sessions/${id}`)).json()
  await page.getByRole('button', { name: '重命名会话：新的聊天', exact: true }).click()
  await page.getByLabel('会话标题', { exact: true }).fill('旧窗口覆盖标题')
  expect((await command(page, 'PATCH', `/sessions/${id}`, { title: '另一窗口的新标题', expected_version: before.version })).status()).toBe(200)
  const failed = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/sessions/${id}`))
  await page.getByRole('button', { name: '保存标题', exact: true }).click()
  expect((await failed).status()).toBe(409)
  expect((await (await page.request.get(`${prefix}/sessions/${id}`)).json()).title).toBe('另一窗口的新标题')
})
