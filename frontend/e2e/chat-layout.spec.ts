import { expect, test } from '@playwright/test'
import { loadDemoHistory, openTopicSettings } from './helpers/preview'
import { registerAccount, loginAccount } from './helpers/auth'

test('history renders the selected fixture without a repeated welcome', async ({ page }) => {
  await loadDemoHistory(page)
  const history = page.getByRole('navigation', { name: '历史会话', exact: true })
  await history.getByRole('link', { name: '今天有一点累', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/preview-a-demo-mood$/)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toHaveCount(0)
  await expect(page.locator('.session-heading')).toContainText('虚构演示会话')
  await expect(page.getByRole('log')).toContainText('我想给这一周留一点自己的时间。')
  await expect(page.locator('.message-user')).toHaveCount(2)
  await history.getByRole('link', { name: '周末想做点喜欢的事', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('周末想去散步，也想找一本喜欢的书。')
  await expect(page.getByRole('log')).not.toContainText('我想给这一周留一点自己的时间。')
  await expect(page.locator('.message-user')).toHaveCount(1)
  await page.screenshot({ path: '.verification/chat-history-desktop.png', fullPage: true })
})

test('desktop sidebar collapses and expands with usable navigation', async ({ page }) => {
  const email = await registerAccount(page)
  await loginAccount(page, email)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  await expect(page.locator('#desktop-sidebar')).toHaveClass(/is-collapsed/)
  await expect(page.locator('#desktop-sidebar')).toHaveCSS('width', '76px')
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '历史会话', exact: true }).click()
  await expect(page.locator('#desktop-sidebar')).not.toHaveClass(/is-collapsed/)
  await expect(page.getByRole('navigation', { name: '历史会话' })).toBeVisible()
  await page.getByRole('link', { name: '记忆管理', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('记忆管理')
})

test('quick actions fill the composer without sending a request', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/companion/demo/stream')) requests.push(request.url())
  })
  await page.goto('/')
  const input = page.getByLabel('聊天消息', { exact: true })
  for (const [label, prompt] of [
    ['聊聊心情', '我想聊聊最近的心情。'],
    ['轻松闲聊', '想和你轻松聊聊天。'],
    ['分享日常', '想和你分享今天的一件小事。'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(input).toHaveValue(prompt)
    await expect(input).toBeFocused()
  }
  expect(requests).toEqual([])
})

test('IME composition and Shift+Enter never accidentally submit', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/companion/demo/stream')) requests.push(request.url())
  })
  await page.goto('/')
  const input = page.getByLabel('聊天消息', { exact: true })
  await input.fill('一段中文输入')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })
  await expect(input).toHaveValue('一段中文输入')
  await input.press('End')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('一段中文输入\n')
  expect(requests).toEqual([])
  await input.press('Enter')
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  expect(requests).toHaveLength(1)
})

test('page-local conversations survive navigation and stay isolated', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('聊天消息', { exact: true }).fill('仅属于第一段预览的文字')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  const firstUrl = page.url()
  await openTopicSettings(page)
  await page.getByRole('navigation', { name: '历史会话' }).getByRole('link', { name: '仅属于第一段预览的文字', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('仅属于第一段预览的文字')
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await page.getByLabel('聊天消息', { exact: true }).fill('仅属于第二段预览的文字')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  expect(page.url()).not.toBe(firstUrl)
  await expect(page.getByRole('log')).not.toContainText('仅属于第一段预览的文字')
  await page.getByRole('navigation', { name: '历史会话' }).getByRole('link', { name: '仅属于第一段预览的文字', exact: true }).click()
  await expect(page.getByRole('log')).not.toContainText('仅属于第二段预览的文字')
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: '这段对话暂时找不到了' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '今天还顺利吗？' })).toHaveCount(0)
})

test('API failures stay visible and never produce a fake assistant reply', async ({ page }) => {
  await page.route('**/api/v1/companion/demo/stream', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: '演示服务暂时不可用' } }),
  }))
  await page.goto('/')
  await page.getByLabel('聊天消息', { exact: true }).fill('一段虚构的测试文字')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('演示服务暂时不可用')
  await expect(page.locator('.message-assistant')).not.toContainText('真实陪伴能力将在后续阶段接入')
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await expect(page.getByLabel('聊天消息', { exact: true })).toBeEnabled()
})

test('stopping and opening a different conversation cannot mix late responses', async ({ page }) => {
  let release = () => undefined as void
  let handled = () => undefined as void
  const released = new Promise<void>((resolve) => { release = resolve })
  const completed = new Promise<void>((resolve) => { handled = resolve })
  await page.route('**/api/v1/companion/demo/stream', async (route) => {
    await released
    try {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        'event: meta\ndata: {"mode":"mock","persisted":false}\n\nevent: delta\ndata: {"text":"不应出现在其他会话的迟到回复"}\n\nevent: done\ndata: {"mode":"mock","persisted":false}\n\n' })
    } finally { handled() }
  })
  await loadDemoHistory(page)
  await page.getByLabel('聊天消息', { exact: true }).fill('测试停止生成')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('已停止生成')
  await page.getByRole('navigation', { name: '历史会话' }).getByRole('link', { name: '今天有一点累', exact: true }).click()
  release()
  await completed
  await expect(page.getByRole('log')).not.toContainText('不应出现在其他会话的迟到回复')
  await expect(page.getByRole('log')).not.toContainText('测试停止生成')
})

test('account links show unknown balance and retain all personal pages', async ({ page }) => {
  const email = await registerAccount(page)
  await loginAccount(page, email)
  await page.goto('/')
  const wallet = page.getByRole('link', { name: '查看 Token 余额，尚未开通', exact: true })
  await expect(wallet).toContainText('—')
  await wallet.click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Token 钱包')
  await page.getByLabel('账户头像，打开账户菜单', { exact: true }).click()
  const account = page.getByRole('navigation', { name: '账户选项', exact: true })
  await expect(account).toContainText(email)
  await account.getByRole('link', { name: '个人中心', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('个人中心')
  await page.getByLabel('账户头像，打开账户菜单', { exact: true }).click()
  await account.getByRole('link', { name: '管理后台', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('没有访问权限')
  await page.getByRole('link', { name: '我的宠物', exact: true }).click()
  await page.getByRole('button', { name: '添加宠物', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '添加宠物', exact: true })).toContainText('宠物名字')
  await expect(page.getByRole('dialog')).toContainText('完整 Live2D 和公开下载安装尚未开放')
  await expect(page.getByRole('dialog')).toContainText('聊天模型由服务端配置')
  await expect(page.getByRole('dialog')).not.toContainText('真实模型尚未开放')
})

test('mobile drawer traps focus and Escape restores its opener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const opener = page.getByRole('button', { name: '打开导航', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: '导航菜单' })
  await expect(dialog).toBeVisible()
  for (let index = 0; index < 14; index++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.querySelector('#mobile-sidebar')?.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(opener).toBeFocused()
  await expect(opener).toHaveAttribute('aria-expanded', 'false')
})

test('mobile visual viewport resizing keeps the composer above the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const input = page.getByLabel('聊天消息', { exact: true })
  await input.fill('软键盘布局测试')
  await expect(input).toHaveCSS('font-size', '16px')
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error('VisualViewport required for this test')
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 460 })
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await expect(page.locator('.companion-shell')).toHaveCSS('height', '460px')
  const composer = await page.getByRole('form', { name: '聊天输入框' }).boundingBox()
  expect(composer).not.toBeNull()
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(460)
  await input.press('End')
  await input.press('Enter')
  await expect(input).toHaveValue('软键盘布局测试\n')
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await page.screenshot({ path: '.verification/chat-keyboard-mobile.png', fullPage: true })
})
