import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { loginAccount, registerAccount } from './helpers/auth'

test('consumer routes render and home clearly labels current Mock behavior', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1050 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('今天还顺利吗？')
  await expect(page.getByText('不管发生了什么，都可以和我聊聊。', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
  await expect(page.getByText('Mock 固定回复 · 不分析输入 · 不计费 · 本页记录刷新即清空')).toBeVisible()
  await mkdir('.verification', { recursive: true })
  await page.screenshot({ path: '.verification/recent-topic-empty-desktop.png', fullPage: true })
  for (const path of ['/companion', '/companions', '/wallet', '/memory', '/me', '/login', '/register', '/admin', '/welcome', '/preferences/conversations', '/not-found']) {
    await page.goto(path)
    await expect(page.locator('main h1, main h3').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  expect(errors).toEqual([])
})

test('retired community and career routes use the safe fallback without business requests', async ({ page }) => {
  const retiredRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/v1/community') || path.startsWith('/api/v1/applications')) retiredRequests.push(path)
  })
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true })
  await expect(navigation.getByRole('link', { name: '社区广场', exact: true })).toHaveCount(0)
  await expect(navigation.getByRole('link', { name: '求职记录', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '求职建议', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '面试复盘', exact: true })).toHaveCount(0)
  await page.goto('/welcome')
  await expect(page.locator('main')).toContainText('多宠物 AI 桌面陪伴软件')
  await expect(page.locator('main')).toContainText('Windows 桌面本地预览')
  await expect(page.locator('main')).toContainText('尚未公开发行')
  await expect(page.locator('a[href="/community"], a[href^="/posts/"], a[href="/applications"]')).toHaveCount(0)
  for (const path of ['/community', '/posts/demo-1', '/applications']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: '这片小天地还没开垦', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '发布帖子', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /社区广场|求职记录/ })).toHaveCount(0)
    await page.locator('main').getByRole('link', { name: '回到首页', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  }
  expect(retiredRequests).toEqual([])
})

test('real local SSE reaches the page and remains mock', async ({ page }) => {
  await page.goto('/companion')
  await expect(page).toHaveURL(/\/$/)
  await page.getByLabel('聊天消息', { exact: true }).fill('你好，小未')
  const response = page.waitForResponse((result) => result.url().includes('/companion/demo/stream'))
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  expect((await response).status()).toBe(200)
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  await expect(page.getByLabel('聊天消息', { exact: true })).toBeEnabled()
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  await expect(page.locator('.message-assistant')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
})

test('invalid login has a generic error and does not create authenticated state', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('邮箱', { exact: true }).fill('fictional@example.com')
  await page.getByLabel('密码', { exact: true }).fill('fictional-test-only')
  const response = page.waitForResponse((result) => result.url().includes('/auth/login'))
  await page.getByRole('button', { name: '登录', exact: true }).click()
  expect((await response).status()).toBe(401)
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确')
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
})

test('mobile navigation and layouts fit a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '.verification/recent-topic-empty-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '打开导航', exact: true }).click()
  const navigation = page.getByRole('dialog', { name: '导航菜单' }).getByRole('navigation', { name: '主导航' })
  await expect(navigation.getByRole('link', { name: '社区广场', exact: true })).toHaveCount(0)
  await expect(navigation.getByRole('link', { name: '求职记录', exact: true })).toHaveCount(0)
  await navigation.getByRole('link', { name: '我的宠物', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('欢迎回来')
  await expect(page.getByRole('button', { name: '打开导航', exact: true })).toHaveAttribute('aria-expanded', 'false')
  for (const path of ['/welcome', '/companions', '/companion', '/wallet', '/memory', '/login', '/register', '/admin']) {
    await page.goto(path)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`pet, memory and chat remain accessible without social or career navigation at ${viewport.width}px`, async ({ page }) => {
    const email = await registerAccount(page, '宠物体验用户')
    await loginAccount(page, email)
    await page.setViewportSize(viewport)
    if (viewport.width < 768) await page.getByRole('button', { name: '打开导航', exact: true }).click()
    const navigation = viewport.width < 768
      ? page.getByRole('dialog', { name: '导航菜单' }).getByRole('navigation', { name: '主导航' })
      : page.getByRole('navigation', { name: '主导航', exact: true })
    await expect(navigation.getByRole('link', { name: '社区广场', exact: true })).toHaveCount(0)
    await expect(navigation.getByRole('link', { name: '求职记录', exact: true })).toHaveCount(0)
    await navigation.getByRole('link', { name: '我的宠物', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('我的宠物')
    if (viewport.width < 768) {
      await expect(page.getByRole('dialog', { name: '导航菜单' })).not.toBeVisible()
      await page.getByRole('button', { name: '打开导航', exact: true }).click()
    }
    const sidebar = viewport.width < 768 ? page.getByRole('dialog', { name: '导航菜单' }) : page.locator('#desktop-sidebar')
    await sidebar.getByRole('link', { name: '记忆管理', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('记忆管理')
    if (viewport.width < 768) await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await sidebar.getByRole('button', { name: '新建聊天', exact: true }).click()
    await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
