import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { registerAccount, loginAccount } from '../e2e/helpers/auth'

const origin = 'http://127.0.0.1:35306'
const consent = { confirmed: true, policy_version: 'memory-policy/1', notice_version: 'memory-notice/1' }
type Pet = { pet_id: string; name: string; version: number }
async function command(page: Page, method: string, path: string, data?: object, key = crypto.randomUUID()) {
  const token = (await (await page.request.get('/api/v1/auth/csrf')).json() as { csrf_token: string }).csrf_token
  return page.request.fetch(path, { method, data, headers: { Origin: origin, 'X-CSRF-Token': token, 'Idempotency-Key': key } })
}
async function setup(page: Page) { const email = await registerAccount(page, '宠物验收账号'); await loginAccount(page, email); return email }
async function create(page: Page, name: string): Promise<Pet> {
  const response = await command(page, 'POST', '/api/v1/pets', { name, role_type: 'cat', persona_config: { description: '说话简短自然', tone: 'calm' } })
  expect(response.status()).toBe(201); return response.json() as Promise<Pet>
}
async function preferences(page: Page, id: string) { return (await page.request.get(`/api/v1/pets/${id}/memory/preferences`)).json() as Promise<{ version: number; long_term_memory_enabled: boolean }> }
async function enable(page: Page, id: string) {
  const pref = await preferences(page, id)
  const response = await command(page, 'PATCH', `/api/v1/pets/${id}/memory/preferences`, { long_term_memory_enabled: true, expected_version: pref.version, consent })
  expect(response.status()).toBe(200)
}
async function send(page: Page, pet: Pet, content: string) {
  await page.goto(`/pets/${pet.pet_id}`)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
  await page.getByLabel('聊天消息', { exact: true }).fill(content)
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/pets/${pet.pet_id}/sessions/`) && response.url().endsWith('/messages'))
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const response = await accepted
  expect(response.status()).toBe(202)
  const data = await response.json() as { generation: { id: string; session_id: string; pet_id: string }; user_message: { id: string } }
  expect(data.generation.pet_id).toBe(pet.pet_id)
  await expect(page).toHaveURL(new RegExp(`/pets/${pet.pet_id}/chat/`))
  return data
}
async function complete(page: Page) {
  await expect(page.locator('.message-assistant').last()).toContainText('你可以用它体验已保存会话的流式显示。')
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
}

test('真实宠物创建、编辑、隐藏、恢复显示与归档，旧数据保持独立', async ({ page }) => {
  await setup(page); await page.goto('/companions')
  await page.getByRole('button', { name: '添加宠物', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加宠物', exact: true })
  await dialog.getByLabel('宠物名字', { exact: true }).fill('独立的小叶')
  await dialog.getByLabel('人格说明', { exact: true }).fill('温和简短的交流')
  await dialog.getByRole('button', { name: '创建宠物', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const card = page.locator('.pet-card').filter({ hasText: '独立的小叶' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '编辑设置', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑宠物', exact: true })
  await editor.getByLabel('宠物名字', { exact: true }).fill('小叶的新名字')
  await editor.getByRole('button', { name: '保存宠物设置', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const renamed = page.locator('.pet-card').filter({ hasText: '小叶的新名字' })
  await renamed.getByRole('button', { name: '隐藏', exact: true }).click()
  await expect(renamed).toHaveCount(0)
  await page.getByRole('button', { name: '已隐藏', exact: true }).click()
  await renamed.getByRole('button', { name: '取消隐藏', exact: true }).click()
  await page.getByRole('button', { name: '我的伙伴', exact: true }).click()
  await renamed.getByRole('button', { name: '归档', exact: true }).click()
  await page.getByRole('dialog', { name: '归档这个伙伴？', exact: true }).getByRole('button', { name: '确认归档', exact: true }).click()
  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await renamed.getByRole('link', { name: '查看聊天', exact: true }).click()
  await expect(page.getByLabel('聊天消息', { exact: true })).toBeDisabled()
})

test('两只宠物独立聊天、SSE、刷新历史；切换后缓存和欢迎语正确', async ({ page }) => {
  await setup(page)
  const a = await create(page, '小叶 A'), b = await create(page, '小叶 B')
  const accepted = await send(page, a, '只属于小叶 A 的聊天内容。')
  await complete(page)
  await page.reload()
  await expect(page.getByRole('log')).toContainText('只属于小叶 A 的聊天内容。')
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toHaveCount(0)
  await page.locator('#desktop-sidebar').getByRole('link', { name: '我的宠物', exact: true }).click()
  await page.locator('.pet-card').filter({ hasText: '小叶 B' }).getByRole('link', { name: '开始聊天', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '历史会话', exact: true })).not.toContainText('只属于小叶 A')
  const denied = await page.request.get(`/api/v1/pets/${b.pet_id}/sessions/${accepted.generation.session_id}/messages`)
  expect(denied.status()).toBe(404)
  await send(page, b, '只属于小叶 B 的聊天。'); await complete(page)
  await expect(page.getByRole('log')).not.toContainText('只属于小叶 A')
  expect((await page.request.get('/api/v1/companion/sessions')).status()).toBe(200)
  const legacy = await (await page.request.get('/api/v1/companion/sessions')).json() as { items: unknown[] }
  expect(legacy.items).toEqual([])
  await page.screenshot({ path: '../.verification/pet-scope/pet-chat-desktop.png', fullPage: true })
})

test('每只宠物分别授权、逐条保存、导出与删除，Mock上下文仅使用本宠物记忆', async ({ page }) => {
  await setup(page)
  const a = await create(page, '记忆伙伴 A'), b = await create(page, '记忆伙伴 B')
  expect((await preferences(page, a.pet_id)).long_term_memory_enabled).toBe(false)
  expect((await preferences(page, b.pet_id)).long_term_memory_enabled).toBe(false)
  await page.goto(`/pets/${a.pet_id}/memory`)
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
  await page.getByRole('switch', { name: '长期记忆授权', exact: true }).click()
  const permit = page.getByRole('dialog', { name: '开启长期记忆', exact: true })
  await permit.getByLabel('我了解并同意以上长期记忆说明', { exact: true }).check()
  await permit.getByRole('button', { name: '确认开启', exact: true }).click()
  await expect(permit).not.toBeVisible()
  await page.getByRole('button', { name: '添加记忆', exact: true }).click()
  const add = page.getByRole('dialog', { name: '添加一条记忆', exact: true })
  await add.getByLabel('记忆标题', { exact: true }).fill('喜欢森林散步')
  await add.getByLabel('记忆内容', { exact: true }).fill('我喜欢在森林里慢慢散步。')
  await add.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true }).check()
  await add.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(add).not.toBeVisible()
  await expect(page.getByTestId('memory-item')).toContainText('喜欢森林散步')
  const list = await (await page.request.get(`/api/v1/pets/${a.pet_id}/memory/items`)).json() as { items: { id: string; version: number }[] }
  const item = list.items[0]!
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出记忆', exact: true }).click()
  const download = await downloaded
  const file = await download.path()
  const exported = JSON.parse(await readFile(file!, 'utf8')) as { pet_id: string; items: unknown[] }
  expect(exported.pet_id).toBe(a.pet_id); expect(exported.items).toHaveLength(1)
  await send(page, a, '我喜欢怎样的森林散步？'); await complete(page)
  await expect.poll(async () => (await readFile('../.verification/pet-scope/provider-observations.jsonl', 'utf8')).includes(item.id)).toBe(true)
  const before = (await readFile('../.verification/pet-scope/provider-observations.jsonl', 'utf8')).trim().split('\n').length
  await send(page, b, '我喜欢怎样的森林散步？'); await complete(page)
  const newCalls = (await readFile('../.verification/pet-scope/provider-observations.jsonl', 'utf8')).trim().split('\n').slice(before)
  expect(newCalls.join('\n')).not.toContain(item.id)
  expect((await preferences(page, b.pet_id)).long_term_memory_enabled).toBe(false)
  expect((await page.request.get(`/api/v1/pets/${b.pet_id}/memory/items/${item.id}`)).status()).toBe(404)
  expect((await command(page, 'DELETE', `/api/v1/pets/${a.pet_id}/memory/items/${item.id}`, { expected_version: item.version })).status()).toBe(204)
  expect((await page.request.get(`/api/v1/pets/${a.pet_id}/memory/items/${item.id}`)).status()).toBe(404)
})

test('消息候选仅逐条确认保存，来源回到正确宠物会话', async ({ page }) => {
  await setup(page); const a = await create(page, '来源伙伴'); await enable(page, a.pet_id)
  const accepted = await send(page, a, '我喜欢简短自然的交流。'); await complete(page)
  await page.getByRole('button', { name: '记住这条', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '记忆候选预览', exact: true })
  await dialog.getByLabel('允许为这条消息生成临时记忆候选', { exact: true }).check()
  await dialog.getByRole('button', { name: '预览候选', exact: true }).click()
  await expect(dialog.getByLabel('候选标题', { exact: true })).toBeVisible()
  const unconfirmed = await (await page.request.get(`/api/v1/pets/${a.pet_id}/memory/items`)).json() as { items: unknown[] }
  expect(unconfirmed.items).toHaveLength(0)
  await dialog.getByLabel('我已确认这条内容，并允许保存为长期记忆', { exact: true }).check()
  await dialog.getByRole('button', { name: '确认保存这条记忆', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.goto(`/pets/${a.pet_id}/memory`)
  await page.getByRole('button', { name: /^查看记忆：/ }).click()
  const detail = page.getByRole('dialog', { name: '记忆详情', exact: true })
  await expect(detail.getByRole('link', { name: '查看原始会话', exact: true })).toHaveAttribute('href', `/pets/${a.pet_id}/chat/${accepted.generation.session_id}`)
})

test('Cookie/CSRF和双账号隔离宠物、消息、授权、记忆，退出清除私人缓存', async ({ page, browser }) => {
  const email = await setup(page); const a = await create(page, '账号 A 私人宠物')
  await enable(page, a.pet_id)
  const accepted = await send(page, a, '账号 A 的私人历史'); await complete(page)
  const otherContext = await browser.newContext({ baseURL: origin })
  try {
    const other = await otherContext.newPage(); const emailB = await setup(other); const b = await create(other, '账号 B 私人宠物')
    for (const path of [`/api/v1/pets/${a.pet_id}`, `/api/v1/pets/${a.pet_id}/memory/preferences`, `/api/v1/pets/${a.pet_id}/memory/items`, `/api/v1/pets/${b.pet_id}/sessions/${accepted.generation.session_id}`]) expect((await other.request.get(path)).status()).toBe(404)
    expect((await command(other, 'PATCH', `/api/v1/pets/${a.pet_id}`, { name: '越权改名', expected_version: a.version })).status()).toBe(404)
    expect((await other.request.post('/api/v1/pets', { data: { name: '缺少 CSRF' }, headers: { Origin: origin } })).status()).toBe(403)
    await other.goto(`/pets/${b.pet_id}`); await expect(other.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
    await expect(other.locator('body')).not.toContainText('账号 A 的私人历史')
    await page.goto('/me'); await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page).toHaveURL(/\/login/)
    expect((await page.request.get(`/api/v1/pets/${a.pet_id}/sessions`)).status()).toBe(401)
    await loginAccount(page, emailB)
    await page.goto(`/pets/${b.pet_id}`)
    await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('账号 A 的私人历史')
    expect(emailB).not.toBe(email)
    const cookies = await page.context().cookies()
    expect(cookies.find((cookie) => cookie.name === 'weibiye_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' })
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
  } finally { await otherContext.close() }
})

test('宠物SSE断线重放、停止与幂等重试保持原身份和单一终态', async ({ page }) => {
  await setup(page); const pet = await create(page, '流式伙伴')
  let faults = 0
  await page.route(`**/api/v1/pets/${pet.pet_id}/sessions/*/generations/*/events`, async (route) => {
    if (faults++ === 0) { await route.abort('connectionreset'); return }
    await route.continue()
  })
  const task = await send(page, pet, '这条消息只发送一次。')
  await complete(page); expect(faults).toBeGreaterThan(0)
  const url = `/api/v1/pets/${pet.pet_id}/sessions/${task.generation.session_id}/generations/${task.generation.id}`
  const eventResponse = await page.request.get(url + '/events')
  expect(eventResponse.status()).toBe(200)
  const text = await eventResponse.text()
  const frames = text.split('\n\n').filter((value) => value.includes('data: ')).map((value) => JSON.parse(value.split('\n').find((line) => line.startsWith('data: '))!.slice(6))) as { pet_id: string; sequence: number }[]
  expect(frames.length).toBeGreaterThan(1); expect(frames.every((value) => value.pet_id === pet.pet_id)).toBe(true)
  const replay = await page.request.get(url + '/events', { headers: { 'Last-Event-ID': `${task.generation.id}:1` } })
  expect(await replay.text()).not.toContain(`id: ${task.generation.id}:1\n`)
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByLabel('聊天消息', { exact: true }).fill('这条回复想中途停止。')
  const accepted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const response = await accepted; const request = response.request()
  const next = await response.json() as { generation: { id: string; state: string } }
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get(url.replace(task.generation.id, next.generation.id))).json() as { generation: { state: string } }).generation.state).toBe('cancelled')
  const repeated = await command(page, 'POST', new URL(request.url()).pathname, request.postDataJSON() as object, request.headers()['idempotency-key'])
  expect(repeated.status()).toBe(202)
  expect((await repeated.json() as { generation: { id: string } }).generation.id).toBe(next.generation.id)
  const messages = await (await page.request.get(`/api/v1/pets/${pet.pet_id}/sessions/${task.generation.session_id}/messages`)).json() as { items: unknown[] }
  expect(messages.items).toHaveLength(4)
})

test('移动端宠物导航、专属记忆与输入框不横向溢出', async ({ page }) => {
  await setup(page); const a = await create(page, '移动伙伴'); await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/pets/${a.pet_id}`)
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await page.getByRole('dialog', { name: '导航菜单', exact: true }).getByRole('link', { name: '记忆管理', exact: true }).click()
  await expect(page).toHaveURL(`/pets/${a.pet_id}/memory`)
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '../.verification/pet-scope/pet-memory-mobile.png', fullPage: true })
})

test('归档后仍可关闭授权、删除和清空记忆，不能开启或添加', async ({ page }) => {
  await setup(page); const pet = await create(page, '已归档的隐私控制')
  const base = '/api/v1/pets/' + pet.pet_id
  await enable(page, pet.pet_id)
  const ids: string[] = []
  for (const title of ['归档记忆一', '归档记忆二']) {
    const response = await command(page, 'POST', base + '/memory/items', {
      title, content: '我喜欢自然简短的交流。', category: 'communication_preference',
      expected_preferences_version: (await preferences(page, pet.pet_id)).version,
      consent, source: { kind: 'manual' },
    })
    expect(response.status()).toBe(201)
    ids.push((await response.json() as { item: { id: string } }).item.id)
  }
  expect((await command(page, 'POST', base + '/archive', { expected_version: pet.version })).status()).toBe(200)
  await page.goto('/pets/' + pet.pet_id + '/memory')
  await expect(page.getByText('这只宠物已归档，不能新增或修改记忆；你仍可关闭授权、撤销、删除、清空和导出。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '添加记忆', exact: true })).toBeDisabled()
  await page.getByRole('switch', { name: '长期记忆授权', exact: true }).click()
  await page.getByRole('dialog', { name: '关闭长期记忆', exact: true }).getByRole('button', { name: '确认关闭', exact: true }).click()
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '查看记忆：归档记忆一', exact: true }).click()
  await page.getByRole('dialog', { name: '记忆详情', exact: true }).getByRole('button', { name: '删除这条记忆', exact: true }).click()
  await page.getByRole('dialog', { name: '删除这条记忆', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '删除这条记忆', exact: true })).not.toBeVisible()
  expect((await page.request.get(base + '/memory/items/' + ids[0])).status()).toBe(404)
  await page.getByRole('button', { name: '清空记忆', exact: true }).click()
  const clear = page.getByRole('dialog', { name: '清空全部记忆', exact: true })
  await clear.getByLabel('我确认清空这只宠物的全部长期记忆', { exact: true }).check()
  await clear.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(page.getByTestId('memory-item')).toHaveCount(0)
  expect((await page.request.get(base + '/memory/items/' + ids[1])).status()).toBe(404)
  const head = await preferences(page, pet.pet_id)
  expect((await command(page, 'PATCH', base + '/memory/preferences', { long_term_memory_enabled: true, expected_version: head.version, consent })).status()).toBe(409)
})
