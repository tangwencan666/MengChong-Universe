import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loginAccount, registerAccount } from './helpers/auth'

// Actual Cookie/CSRF authentication and pet CRUD use this run's temporary SQLite
// server. Only the designated pet's public runtime response is a local fixture.
// No provider request or real model call is made by these disclosure tests.
interface Pet { pet_id: string; name: string }
const deepseek = { schema_version: 'chat-runtime/1', provider: 'deepseek', model: 'deepseek-flash',
  mode: 'real', billing: 'external_provider', memory_injection_enabled: false }
const mock = { schema_version: 'chat-runtime/1', provider: 'mock', model: null,
  mode: 'mock', billing: 'none', memory_injection_enabled: false }

async function petsFor(page: Page) {
  const email = await registerAccount(page, 'P8.1 宠物模式测试')
  await loginAccount(page, email)
  const token = (await (await page.request.get('/api/v1/auth/csrf')).json() as { csrf_token: string }).csrf_token
  const pets: Pet[] = []
  for (const name of ['月芽', '豆包', '小云']) {
    const response = await page.request.post('/api/v1/pets', { data: { name, role_type: 'custom' },
      headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': token, 'Idempotency-Key': crypto.randomUUID() } })
    expect(response.status()).toBe(201)
    pets.push(await response.json() as Pet)
  }
  return pets as [Pet, Pet, Pet]
}

async function openFromList(page: Page, pet: Pet) {
  if (new URL(page.url()).pathname !== '/companions') {
    await page.locator('#desktop-sidebar').getByRole('link', { name: '我的宠物', exact: true }).click()
  }
  await expect(page).toHaveURL(/\/companions$/)
  const card = page.locator('.pet-card').filter({ has: page.getByRole('heading', { name: pet.name, exact: true }) })
  await card.getByRole('link', { name: '开始聊天', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/pets/${pet.pet_id}$`))
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
}

test.describe('P8.1 按宠物披露（真实本地认证，非真实模型）', () => {
  test.afterEach(async ({ page }) => {
    await page.goto('about:blank')
    await page.unrouteAll({ behavior: 'wait' })
  })

  test('月芽显示 scoped DeepSeek，豆包和小云保持 Mock；切换不复用旧模式', async ({ page }) => {
    const [moon, bean, cloud] = await petsFor(page)
    const paths: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/runtime')) paths.push(path)
    })
    await page.route(`**/api/v1/pets/${moon.pet_id}/runtime`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(deepseek) }))
    // An unrelated global runtime must not determine any pet's next provider.
    await page.route('**/api/v1/companion/runtime', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(deepseek) }))
    await page.goto('/companions')
    await openFromList(page, moon)
    const disclosure = page.locator('#composer-disclosure')
    await expect(disclosure).toContainText('DeepSeek · deepseek-flash')
    await expect(disclosure).toContainText('可能产生 API 费用')
    await expect(disclosure).toContainText('本次不额外注入长期记忆')
    for (const pet of [bean, cloud]) {
      await openFromList(page, pet)
      await expect(disclosure).toContainText('本地 Mock')
      await expect(disclosure).toContainText('不计费')
      await expect(disclosure).not.toContainText('DeepSeek')
    }
    await openFromList(page, moon)
    await expect(disclosure).toContainText('DeepSeek · deepseek-flash')
    expect(paths).toContain(`/api/v1/pets/${moon.pet_id}/runtime`)
    expect(paths).toContain(`/api/v1/pets/${bean.pet_id}/runtime`)
    expect(paths).toContain(`/api/v1/pets/${cloud.pet_id}/runtime`)
    await page.reload()
    await expect(disclosure).toContainText('DeepSeek · deepseek-flash')
  })

  test('宠物 runtime 失败不回退全局免费提示，另一只宠物仍可确认 Mock', async ({ page }) => {
    const [moon, bean] = await petsFor(page)
    const commands: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/sessions(?:\/|$)/.test(new URL(request.url()).pathname)) commands.push(new URL(request.url()).pathname)
    })
    await page.route(`**/api/v1/pets/${moon.pet_id}/runtime`, route => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'LOCAL_RUNTIME_UNAVAILABLE', message: '本地测试配置暂不可读' } }) }))
    await page.goto('/companions')
    await openFromList(page, moon)
    await expect(page.locator('#composer-disclosure')).toContainText('模型配置尚未确认')
    await expect(page.locator('#composer-disclosure')).not.toContainText('不计费')
    await page.getByLabel('聊天消息', { exact: true }).fill('未知模式不应发送')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
    await openFromList(page, bean)
    await expect(page.locator('#composer-disclosure')).toContainText('本地 Mock')
    await page.getByLabel('聊天消息', { exact: true }).fill('仅确认另一个作用域可用，不发送')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
    expect(commands).toEqual([])
  })

  test('发送前 scoped 模式变化先更新披露，不提交消息或创建会话', async ({ page }) => {
    const [moon] = await petsFor(page)
    let current: typeof mock | typeof deepseek = mock
    let runtimeReads = 0
    const commands: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.startsWith(`/api/v1/pets/${moon.pet_id}/sessions`)) commands.push(path)
    })
    await page.route(`**/api/v1/pets/${moon.pet_id}/runtime`, route => {
      runtimeReads++
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) })
    })
    await page.goto('/companions')
    await openFromList(page, moon)
    await expect(page.locator('#composer-disclosure')).toContainText('本地 Mock')
    const previousReads = runtimeReads
    current = deepseek
    await page.getByLabel('聊天消息', { exact: true }).fill('配置改变时这次点击应被中止')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('alert').first()).toContainText('聊天模型配置已变化')
    await expect(page.locator('#composer-disclosure')).toContainText('DeepSeek · deepseek-flash')
    expect(runtimeReads).toBeGreaterThan(previousReads)
    expect(commands).toEqual([])
  })

  test('同名未指定宠物不因名称得到 DeepSeek 披露', async ({ page }) => {
    const [moon] = await petsFor(page)
    const token = (await (await page.request.get('/api/v1/auth/csrf')).json() as { csrf_token: string }).csrf_token
    const response = await page.request.post('/api/v1/pets', { data: { name: '月芽', role_type: 'custom' },
      headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': token, 'Idempotency-Key': crypto.randomUUID() } })
    expect(response.status()).toBe(201)
    const other = await response.json() as Pet
    expect(other.pet_id).not.toBe(moon.pet_id)
    await page.route(`**/api/v1/pets/${moon.pet_id}/runtime`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(deepseek) }))
    await page.goto(`/pets/${other.pet_id}`)
    await expect(page.locator('#composer-disclosure')).toContainText('本地 Mock')
    await expect(page.locator('#composer-disclosure')).not.toContainText('DeepSeek')
  })
})
