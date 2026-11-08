/** Actual browser and authenticated FastAPI; persistence/cache depend on the selected test lane. */
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { browserPassword, loginAccount } from '../e2e/helpers/auth'
import {
  add, chatPrefix, command, complete, detail, digest, enable, fact, frames, items,
  memoryPage, memoryPrefix, observations, origin, preferences, query, screenshot, send, setup,
} from './helpers'

test('默认关闭、开启需明确授权；最近话题与长期记忆独立且刷新保存服务器状态', async ({ page }) => {
  await setup(page)
  await memoryPage(page)
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
  expect(await items(page)).toEqual([])
  const recent = await (await page.request.get(chatPrefix + '/preferences')).json() as { version: number }
  const changed = await command(page, 'PATCH', chatPrefix + '/preferences', { recent_topic_enabled: true, expected_version: recent.version })
  expect(changed.status()).toBe(200)
  await enable(page)
  expect((await (await page.request.get(chatPrefix + '/preferences')).json() as { recent_topic_enabled: boolean }).recent_topic_enabled).toBe(true)
  expect(await items(page)).toEqual([])
  await page.reload()
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).toBeChecked()
  await page.getByRole('switch', { name: '长期记忆授权', exact: true }).click()
  const closed = page.getByRole('dialog', { name: '关闭长期记忆', exact: true })
  await closed.getByRole('button', { name: '确认关闭', exact: true }).click()
  await expect(closed).not.toBeVisible()
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
  expect((await (await page.request.get(chatPrefix + '/preferences')).json() as { recent_topic_enabled: boolean }).recent_topic_enabled).toBe(true)
})

test('真实身份恢复未完成时不显示访客发送框，恢复后只创建真实私人会话', async ({ page }) => {
  await setup(page)
  const identity = await (await page.request.get('/api/v1/auth/me')).json() as { id: string }
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  let released = false
  const demoCalls: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/companion/demo/stream')) demoCalls.push(request.url())
  })
  // Network fault injection only delays real authenticated /me responses.
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    expect((await response.json() as { id: string }).id).toBe(identity.id)
    if (!released) { held += 1; await gate }
    await route.fulfill({ response })
  })
  try {
    await page.goto('/')
    await expect.poll(() => held).toBeGreaterThan(0)
    await expect(page.getByText('正在确认登录状态…', { exact: true })).toBeVisible()
    await expect(page.getByLabel('聊天消息', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveCount(0)
    expect(demoCalls).toEqual([])
    released = true; release()
    await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
    const accepted = await send(page, '身份恢复后验证真实私人聊天。'); await complete(page)
    expect(accepted.generation.session_id).toMatch(/^[a-f\d-]{36}$/)
    const history = await page.request.get(chatPrefix + `/sessions/${accepted.generation.session_id}/messages`)
    expect(history.status()).toBe(200)
    expect((await history.json() as { items: unknown[] }).items).toHaveLength(2)
    expect(demoCalls).toEqual([])
  } finally { released = true; release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('手动逐条确认、详情来源、纠正、导出、删除后检索与旧请求不复活', async ({ page }) => {
  await setup(page); await enable(page)
  const submitted = page.waitForRequest((request) => request.method() === 'POST'
    && new URL(request.url()).pathname === memoryPrefix + '/items')
  const item = await add(page)
  const createRequest = await submitted
  const originalPayload = createRequest.postDataJSON() as object
  const originalKey = createRequest.headers()['idempotency-key']!
  expect(item.sources).toEqual([expect.objectContaining({ kind: 'manual', session_id: null, message_id: null })])
  await screenshot(page, 'p4c-memory-desktop.png')
  const shown = await detail(page, item.title)
  await expect(shown).toContainText('本人手动添加')
  await shown.getByRole('button', { name: '编辑记忆', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑这条记忆', exact: true })
  const revised = '希望优先考虑后端研发岗位，关注青岚团队。'
  await editor.getByLabel('记忆内容', { exact: true }).fill(revised)
  await expect(editor.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true })).not.toBeChecked()
  await editor.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true }).check()
  await editor.getByRole('button', { name: '确认修改', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByTestId('memory-item')).toContainText(revised)
  expect((await items(page))[0]?.version).toBe(item.version + 1)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出记忆', exact: true }).click()
  const download = await downloaded
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as { items: { content: string }[] }
  expect(exported.items.map((entry) => entry.content)).toEqual([revised])
  const updated = (await items(page))[0]!
  const dialog = await detail(page, updated.title)
  await dialog.getByRole('button', { name: '删除这条记忆', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条记忆', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.getByTestId('memory-item')).toHaveCount(0)
  expect((await page.request.get(memoryPrefix + `/items/${item.id}`)).status()).toBe(404)
  const oldRequest = await command(page, 'POST', memoryPrefix + '/items', originalPayload, originalKey)
  expect(oldRequest.status()).toBe(410)
  expect((await oldRequest.json() as { error: { code: string } }).error.code).toBe('MEMORY_UNAVAILABLE')
  const retrieved = await command(page, 'POST', memoryPrefix + '/retrieval-preview', { query, expected_preferences_version: (await preferences(page)).version })
  expect(retrieved.status()).toBe(200)
  expect((await retrieved.json() as { items: unknown[] }).items).toEqual([])
})

test('撤销保留本人管理内容，清空需要单独确认，导出不包含删除内容', async ({ page }) => {
  await setup(page); await enable(page)
  const item = await add(page)
  const shown = await detail(page, item.title)
  await shown.getByRole('button', { name: '撤销这条记忆', exact: true }).click()
  await page.getByRole('dialog', { name: '撤销这条记忆', exact: true }).getByRole('button', { name: '确认撤销', exact: true }).click()
  await expect(page.getByTestId('memory-item')).toContainText('已撤销')
  expect((await items(page))[0]?.content).toBe(fact)
  await page.getByRole('button', { name: '清空记忆', exact: true }).click()
  const clear = page.getByRole('dialog', { name: '清空全部记忆', exact: true })
  await expect(clear.getByRole('button', { name: '确认清空', exact: true })).toBeDisabled()
  await clear.getByLabel('我确认清空当前账户的全部长期记忆', { exact: true }).check()
  await clear.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(clear).not.toBeVisible()
  await expect(page.getByTestId('memory-item')).toHaveCount(0)
  expect(await items(page)).toEqual([])
  const data = await command(page, 'POST', memoryPrefix + '/export', { format: 'json', include_inactive: true })
  expect(data.status()).toBe(200)
  expect((await data.json() as { items: unknown[] }).items).toEqual([])
})

test('本人聊天候选只预览不保存，逐条确认后来源可追溯，Mock实际收到授权内容', async ({ page }) => {
  await setup(page); await enable(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
  await expect(page.getByText('不管发生了什么，都可以和我聊聊。', { exact: true })).toBeVisible()
  const first = await send(page, fact); await complete(page)
  expect(await items(page)).toEqual([])
  await page.getByRole('button', { name: '记住这条', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '记忆候选预览', exact: true })
  await dialog.getByLabel('允许为这条消息生成临时记忆候选', { exact: true }).check()
  await dialog.getByRole('button', { name: '预览候选', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '候选内容', exact: true })).toHaveValue(fact)
  expect(await items(page)).toEqual([])
  await expect(dialog.getByRole('button', { name: '确认保存这条记忆', exact: true })).toBeDisabled()
  await dialog.getByLabel('我已确认这条内容，并允许保存为长期记忆', { exact: true }).check()
  await dialog.getByRole('button', { name: '确认保存这条记忆', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const saved = (await items(page))[0]!
  expect(saved.sources[0]).toMatchObject({ kind: 'chat_message', session_id: first.generation.session_id, message_id: first.user_message.id })
  const accepted = await send(page, query); await complete(page)
  const refs = await page.request.get(chatPrefix + `/sessions/${accepted.generation.session_id}/generations/${accepted.generation.id}/memory-refs`)
  expect(refs.status()).toBe(200)
  expect((await refs.json() as { items: { memory_id: string; availability: string }[] }).items).toContainEqual(expect.objectContaining({ memory_id: saved.id, availability: 'available' }))
  await expect.poll(async () => (await observations()).some((entry) => entry.memories.some((memory) => memory.memory_id === saved.id && memory.content_sha256 === digest(fact)))).toBe(true)
  await expect(page.getByText(/本次 Mock 上下文曾参考 1 条授权记忆/)).toBeVisible()
  const before = (await observations()).length
  const completeStream = await page.request.get(accepted.events_url)
  const journal = frames(await completeStream.text())
  expect(journal.at(-1)?.event).toBe('completed')
  const cursor = journal[0]!.id!
  const replayed = await page.request.get(accepted.events_url, { headers: { 'Last-Event-ID': cursor } })
  const replay = frames(await replayed.text())
  expect(replay.some((frame) => frame.id === cursor)).toBe(false)
  expect(new Set(replay.map((frame) => frame.id)).size).toBe(replay.length)
  expect((await observations()).length).toBe(before)
  expect(await items(page)).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('log')).toContainText(fact)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toHaveCount(0)
})

test('两账号的授权、记忆、来源、检索、会话及同一浏览器切号缓存隔离', async ({ page, browser }) => {
  await setup(page); await enable(page)
  const a = await add(page, '同名求职方向', fact)
  await page.goto('/')
  const accepted = await send(page, query); await complete(page)
  const otherContext = await browser.newContext({ baseURL: origin })
  try {
    const b = await otherContext.newPage()
    const emailB = await setup(b)
    await memoryPage(b)
    await expect(b.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
    expect((await b.request.get(memoryPrefix + `/items/${a.id}`)).status()).toBe(404)
    expect((await b.request.get(memoryPrefix + `/items/${a.id}/sources`)).status()).toBe(404)
    expect((await b.request.get(chatPrefix + `/sessions/${accepted.generation.session_id}`)).status()).toBe(404)
    expect((await b.request.get(chatPrefix + `/sessions/${accepted.generation.session_id}/generations/${accepted.generation.id}/memory-refs`)).status()).toBe(404)
    await enable(b)
    const bFact = '希望优先考虑后端研发岗位，关注青岚团队。'
    const own = await add(b, '同名求职方向', bFact)
    const answer = await command(b, 'POST', memoryPrefix + '/retrieval-preview', { query, expected_preferences_version: (await preferences(b)).version })
    const hits = (await answer.json() as { items: { memory_id: string }[] }).items
    expect(hits.map((hit) => hit.memory_id)).toContain(own.id)
    expect(hits.map((hit) => hit.memory_id)).not.toContain(a.id)
    expect((await page.request.get(memoryPrefix + `/items/${own.id}`)).status()).toBe(404)
    await page.goto('/me')
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByLabel('访客头像，打开账户菜单', { exact: true })).toBeVisible()
    expect((await page.request.get(memoryPrefix + `/items/${a.id}`)).status()).toBe(401)
    await loginAccount(page, emailB)
    await memoryPage(page)
    await expect(page.getByTestId('memory-item')).toContainText(bFact)
    await expect(page.getByTestId('memory-item')).not.toContainText(fact)
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(storage).not.toContain(fact)
    expect(storage).not.toContain(bFact)
    expect(storage).not.toContain(browserPassword)
  } finally { await otherContext.close() }
})

test('五分钟后清除临时候选正文、回执和确认状态，原始聊天保留且没有保存事实', async ({ page }) => {
  await setup(page); await enable(page)
  await page.goto('/')
  await send(page, fact); await complete(page)
  // Advance only the browser clock: authentication and all API responses stay real.
  await page.clock.install()
  await page.getByRole('button', { name: '记住这条', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '记忆候选预览', exact: true })
  await dialog.getByLabel('允许为这条消息生成临时记忆候选', { exact: true }).check()
  await dialog.getByRole('button', { name: '预览候选', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '候选内容', exact: true })).toHaveValue(fact)
  await dialog.getByLabel('我已确认这条内容，并允许保存为长期记忆', { exact: true }).check()
  await page.clock.fastForward(301_000)
  await expect(dialog).toContainText('预览已到期，临时内容已清除。若愿意，可以重新预览。')
  await expect(dialog.getByRole('textbox', { name: '候选内容', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '确认保存这条记忆', exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('允许为这条消息生成临时记忆候选', { exact: true })).not.toBeChecked()
  await expect(page.getByRole('log')).toContainText(fact)
  expect(await items(page)).toEqual([])
})

test('同账号另一标签页关闭授权后，当前页面同步撤销且重新开启不复活', async ({ page }) => {
  await setup(page); await enable(page)
  const item = await add(page)
  const second = await page.context().newPage()
  try {
    await memoryPage(second)
    await second.getByRole('switch', { name: '长期记忆授权', exact: true }).click()
    await second.getByRole('dialog', { name: '关闭长期记忆', exact: true }).getByRole('button', { name: '确认关闭', exact: true }).click()
    await page.bringToFront()
    await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked({ timeout: 10_000 })
    await expect(page.getByTestId('memory-item')).toContainText('已撤销')
    expect((await items(page)).find((entry) => entry.id === item.id)?.status).toBe('revoked')
    await enable(page)
    expect((await items(page)).find((entry) => entry.id === item.id)?.status).toBe('revoked')
    const result = await command(page, 'POST', memoryPrefix + '/retrieval-preview', { query, expected_preferences_version: (await preferences(page)).version })
    expect((await result.json() as { items: unknown[] }).items).toEqual([])
  } finally { await second.close() }
})

test('同页切号时丢弃另一账号已返回但延迟送达的真实记忆响应', async ({ page, browser }) => {
  await setup(page); await enable(page)
  const a = await add(page, '旧账号求职方向', fact)
  const contextB = await browser.newContext({ baseURL: origin })
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = false
  let delivered = false
  try {
    const b = await contextB.newPage()
    const emailB = await setup(b); await enable(b)
    const bFact = '希望优先考虑后端研发岗位，关注青岚团队。'
    await add(b, '新账号求职方向', bFact)
    // Fault injection delays one real A response; it does not fabricate API data.
    await page.route('**/api/v1/memory/items**', async (route) => {
      if (!held && route.request().method() === 'GET'
        && new URL(route.request().url()).pathname === memoryPrefix + '/items') {
        const response = await route.fetch()
        expect((await response.json() as { items: { id: string }[] }).items.map((entry) => entry.id)).toContain(a.id)
        held = true
        await gate
        try { await route.fulfill({ response }) } catch { /* Aborting an old scope is also correct. */ }
        finally { delivered = true }
      } else await route.continue()
    })
    await page.getByRole('button', { name: '刷新记忆', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    // React navigation retains the application; a full reload would mask stale-scope bugs.
    await page.locator('.profile-entry').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByLabel('邮箱', { exact: true }).fill(emailB)
    await page.getByLabel('密码', { exact: true }).fill(browserPassword)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByLabel('账户头像，打开账户菜单', { exact: true })).toBeVisible()
    await page.getByLabel('账户头像，打开账户菜单', { exact: true }).click()
    await page.getByRole('navigation', { name: '账户选项', exact: true }).getByRole('link', { name: '记忆管理', exact: true }).click()
    await expect(page.getByTestId('memory-item')).toContainText(bFact)
    release()
    await expect.poll(() => delivered).toBe(true)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByTestId('memory-item')).not.toContainText(fact)
    expect((await items(page)).map((entry) => entry.content)).toEqual([bFact])
  } finally { release(); await contextB.close() }
})

test('Cookie和CSRF真实校验，拒绝伪造owner，取消生成和重放不保存记忆', async ({ page }) => {
  await setup(page); await enable(page)
  const cookies = await page.context().cookies(origin)
  expect(cookies).toContainEqual(expect.objectContaining({ name: 'weibiye_session', httpOnly: true, sameSite: 'Lax' }))
  const rejected = await page.request.post(memoryPrefix + '/items', { data: {
    title: '不允许保存', content: fact, category: 'career_goal', source: { kind: 'manual' },
    expected_preferences_version: (await preferences(page)).version,
    consent: { confirmed: true, policy_version: 'memory-policy/1', notice_version: 'memory-notice/1' },
  }, headers: { Origin: origin, 'Idempotency-Key': crypto.randomUUID() } })
  expect(rejected.status()).toBe(403)
  const owner = await command(page, 'POST', memoryPrefix + '/retrieval-preview', { query, owner_id: crypto.randomUUID(), expected_preferences_version: (await preferences(page)).version })
  expect(owner.status()).toBe(422)
  await page.goto('/')
  const accepted = await send(page, fact)
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  const cancelled = await page.request.get(accepted.events_url)
  const events = frames(await cancelled.text())
  expect(events.at(-1)?.event).toBe('cancelled')
  expect(events.filter((frame) => ['completed', 'error', 'cancelled'].includes(frame.event ?? ''))).toHaveLength(1)
  const cursor = events[0]!.id!
  const replay = await page.request.get(accepted.events_url, { headers: { 'Last-Event-ID': cursor } })
  expect(frames(await replay.text()).some((frame) => frame.id === cursor)).toBe(false)
  expect(await items(page)).toEqual([])
})

test('一次真实SSE连接故障后恢复，消息和长期记忆不重复', async ({ page }) => {
  await setup(page); await enable(page)
  await add(page)
  await page.goto('/')
  let interrupted = false
  // Explicit network fault injection; successful responses still come from the real API.
  await page.route('**/api/v1/companion/sessions/*/generations/*/events', async (route) => {
    if (!interrupted) { interrupted = true; await route.abort('failed') }
    else await route.continue()
  })
  const accepted = await send(page, query); await complete(page)
  expect(interrupted).toBe(true)
  const history = await page.request.get(chatPrefix + `/sessions/${accepted.generation.session_id}/messages`)
  expect((await history.json() as { items: unknown[] }).items).toHaveLength(2)
  expect(await items(page)).toHaveLength(1)
  await expect(page.getByRole('log').locator('.message-user')).toHaveCount(1)
  await expect(page.getByRole('log').locator('.message-assistant')).toHaveCount(1)
})

test('离线保存不显示成功，恢复后按服务器状态重新读取', async ({ page }) => {
  await setup(page); await enable(page)
  await page.getByRole('button', { name: '添加记忆', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '添加一条记忆', exact: true })
  await editor.getByLabel('记忆标题', { exact: true }).fill('尚未保存的离线条目')
  await editor.getByLabel('记忆内容', { exact: true }).fill(fact)
  await editor.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true }).check()
  await page.context().setOffline(true)
  try {
    await editor.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.getByRole('alert').first()).toBeVisible()
    await expect(page.getByTestId('memory-item')).toHaveCount(0)
  } finally { await page.context().setOffline(false) }
  await page.reload()
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).toBeChecked()
  expect(await items(page)).toEqual([])
})

for (const operation of ['delete', 'revoke', 'disable'] as const) {
  const label = { delete: '删除单条', revoke: '撤销单条', disable: '关闭长期记忆授权' }[operation]
  test(`${label}后新会话的实际Mock输入和生成引用不再包含旧记忆`, async ({ page }) => {
    await setup(page); await enable(page)
    const saved = await add(page)
    await page.goto('/')
    const first = await send(page, query); await complete(page)
    const firstRefs = await page.request.get(chatPrefix + `/sessions/${first.generation.session_id}/generations/${first.generation.id}/memory-refs`)
    expect(firstRefs.status()).toBe(200)
    expect((await firstRefs.json() as { items: { memory_id: string }[] }).items).toContainEqual(expect.objectContaining({ memory_id: saved.id }))
    const before = await observations()
    expect(before.at(-1)?.memories).toContainEqual({ memory_id: saved.id, version: saved.version, content_sha256: digest(fact) })

    await memoryPage(page)
    if (operation === 'disable') {
      await page.getByRole('switch', { name: '长期记忆授权', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '关闭长期记忆', exact: true })
      await dialog.getByRole('button', { name: '确认关闭', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
      expect((await preferences(page)).long_term_memory_enabled).toBe(false)
    } else {
      const shown = await detail(page, saved.title)
      const action = operation === 'delete' ? '删除这条记忆' : '撤销这条记忆'
      const confirmation = operation === 'delete' ? '确认删除' : '确认撤销'
      await shown.getByRole('button', { name: action, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: action, exact: true })
      await dialog.getByRole('button', { name: confirmation, exact: true }).click()
      await expect(dialog).not.toBeVisible()
    }
    if (operation === 'delete') {
      expect((await page.request.get(memoryPrefix + `/items/${saved.id}`)).status()).toBe(404)
    } else {
      expect((await items(page)).find((entry) => entry.id === saved.id)?.status).toBe('revoked')
    }

    // A new real generation, rather than retrieval-preview alone, proves that
    // provider dispatch no longer receives the old authorized memory block.
    await page.goto('/')
    const next = await send(page, query); await complete(page)
    expect(next.generation.session_id).not.toBe(first.generation.session_id)
    await expect.poll(async () => (await observations()).length).toBe(before.length + 1)
    const dispatched = (await observations()).slice(before.length)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.memories).toEqual([])
    const refs = await page.request.get(chatPrefix + `/sessions/${next.generation.session_id}/generations/${next.generation.id}/memory-refs`)
    expect(refs.status()).toBe(200)
    expect((await refs.json() as { items: unknown[] }).items).toEqual([])
    const history = await page.request.get(chatPrefix + `/sessions/${next.generation.session_id}/messages`)
    expect(history.status()).toBe(200)
    expect((await history.json() as { items: unknown[] }).items).toHaveLength(2)
  })
}

test('页面驻留跨过有效期后立即更新状态和详情操作，已撤销记录不会改显示为已过期', async ({ page }) => {
  await setup(page); await enable(page)
  const expires = new Date(Date.now() + 120_000).toISOString()
  const titles = ['即将到期的合成记忆', '已撤销的合成记忆']
  for (const title of titles) {
    // Minute-scale synthetic expiry is created through the actual API; the
    // product's date-only form and its explicit consent flow are covered above.
    const response = await command(page, 'POST', memoryPrefix + '/items', {
      title, content: fact, category: 'career_goal', expires_at: expires,
      source: { kind: 'manual' }, expected_preferences_version: (await preferences(page)).version,
      consent: { confirmed: true, policy_version: 'memory-policy/1', notice_version: 'memory-notice/1' },
    })
    expect(response.status()).toBe(201)
    const item = (await response.json() as { item: { id: string; version: number } }).item
    if (title === titles[1]) {
      expect((await command(page, 'POST', memoryPrefix + `/items/${item.id}/revocations`, { expected_version: item.version })).status()).toBe(200)
    }
  }
  // Only the browser clock moves. API data, server time and database remain real.
  await page.clock.install()
  await memoryPage(page)
  const active = page.getByTestId('memory-item').filter({ hasText: titles[0]! })
  const revoked = page.getByTestId('memory-item').filter({ hasText: titles[1]! })
  await expect(active.getByText('允许参考', { exact: true })).toBeVisible()
  await expect(revoked.getByText('已撤销', { exact: true })).toBeVisible()
  const shown = await detail(page, titles[0]!)
  await expect(shown.getByRole('button', { name: '编辑记忆', exact: true })).toBeVisible()
  await page.clock.fastForward(121_000)
  await expect(active.getByText('已过期', { exact: true })).toBeVisible()
  await expect(revoked.getByText('已撤销', { exact: true })).toBeVisible()
  await expect(shown.getByText('已过期', { exact: true })).toBeVisible()
  await expect(shown.getByRole('button', { name: '编辑记忆', exact: true })).toHaveCount(0)
  await expect(shown.getByRole('button', { name: '撤销这条记忆', exact: true })).toHaveCount(0)
  await expect(shown.getByRole('button', { name: '删除这条记忆', exact: true })).toBeVisible()
  await shown.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await page.getByRole('combobox', { name: /筛选记忆状态/ }).selectOption('已过期')
  await expect(page.getByTestId('memory-item')).toHaveCount(1)
  await expect(page.getByTestId('memory-item')).toContainText(titles[0]!)
  await page.getByRole('combobox', { name: /筛选记忆状态/ }).selectOption('已撤销')
  await expect(page.getByTestId('memory-item')).toHaveCount(1)
  await expect(page.getByTestId('memory-item')).toContainText(titles[1]!)
})

test.describe('移动端', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('授权、确认、详情和聊天抽屉保持可用且无横向溢出', async ({ page }) => {
    await setup(page); await enable(page)
    const item = await add(page)
    await screenshot(page, 'p4c-memory-mobile.png')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const shown = await detail(page, item.title)
    await expect(shown.getByText(fact, { exact: true })).toBeVisible()
    await shown.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    await page.goto('/')
    await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
    await send(page, query); await complete(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
