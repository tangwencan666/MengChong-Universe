import { expect, test } from '@playwright/test'
import { loadDemoHistory, openTopicSettings } from './helpers/preview'

test('first visit has no history, no recommendation, and the gentle composer copy', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await expect(page.getByText('不管发生了什么，都可以和我聊聊。', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '最近话题', exact: true })).toHaveCount(0)
  await expect(page.locator('.history-link')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '历史会话' }).getByText('还没有本页对话', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
})

test('consent without an actual conversation never invents a topic', async ({ page }) => {
  await page.goto('/preferences/conversations')
  const consent = page.getByRole('checkbox', { name: '允许本页历史话题推荐' })
  await expect(consent).not.toBeChecked()
  await consent.check()
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题', exact: true })).toHaveCount(0)
  await expect(page.locator('.history-link')).toHaveCount(0)
})

test('loading clearly fictional history does not implicitly grant consent', async ({ page }) => {
  await loadDemoHistory(page)
  await expect(page.getByRole('navigation', { name: '历史会话' }).locator('.history-link')).toHaveCount(2)
  await expect(page.getByRole('region', { name: '最近话题', exact: true })).toHaveCount(0)
  await openTopicSettings(page)
  await expect(page.getByRole('checkbox', { name: '允许本页历史话题推荐' })).not.toBeChecked()
  await expect(page.getByText('最近话题与长期记忆分开', { exact: true })).toBeVisible()
})

test('authorized latest topic shows traceable mock content and timestamp on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 })
  await loadDemoHistory(page, true)
  const topic = page.getByRole('region', { name: '最近话题', exact: true })
  await expect(topic).toHaveAttribute('data-conversation-id', 'preview-a-demo-mood')
  await expect(topic.getByRole('heading', { name: '接着上次的话题聊聊？', exact: true })).toBeVisible()
  await expect(topic).toContainText('Mock 会话 · 演示时间')
  await expect(topic).toContainText('忙碌了一天，想给这一周留一点自己的时间。')
  await expect(topic).toContainText('上次你想给自己留一点时间。今天愿意接着聊聊吗？')
  await expect(topic.locator('time')).toHaveAttribute('datetime', '2026-10-31T12:30:00Z')
  const card = await topic.boundingBox()
  const composer = await page.getByRole('form', { name: '聊天输入框' }).boundingBox()
  expect(card!.y + card!.height).toBeLessThan(composer!.y)
  await page.screenshot({ path: '.verification/recent-topic-card-desktop.png', fullPage: true })
})

test('continue reopens the original conversation without duplicate messages or requests', async ({ page }) => {
  const modelRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/companion/demo/stream')) modelRequests.push(request.url())
  })
  await loadDemoHistory(page, true)
  await page.getByRole('region', { name: '最近话题' }).getByRole('link', { name: '继续聊聊', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/preview-a-demo-mood$/)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
  await expect(page.locator('.message-user')).toHaveCount(2)
  await expect(page.locator('.message-assistant')).toHaveCount(2)
  await expect(page.getByRole('navigation', { name: '历史会话' }).locator('.history-link')).toHaveCount(2)
  expect(modelRequests).toEqual([])
})

test('temporarily dismissing a topic stays dismissed through navigation', async ({ page }) => {
  await loadDemoHistory(page, true)
  await page.getByRole('button', { name: '暂时不看', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
  await openTopicSettings(page)
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '历史会话' }).locator('.history-link')).toHaveCount(2)
  await openTopicSettings(page)
  await expect(page.getByRole('checkbox', { name: '允许本页历史话题推荐' })).toBeChecked()
})

test('turning recommendations off prevents them after a new conversation too', async ({ page }) => {
  await loadDemoHistory(page, true)
  await openTopicSettings(page)
  await page.getByRole('checkbox', { name: '允许本页历史话题推荐' }).uncheck()
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
  await page.getByLabel('聊天消息', { exact: true }).fill('这是一段关闭推荐后的本页预览。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '历史会话' }).locator('.history-link')).toHaveCount(3)
})

test('deleted topics are never recommended or silently reloaded', async ({ page }) => {
  const deletionRequests: string[] = []
  page.on('request', (request) => { if (request.method() === 'DELETE') deletionRequests.push(request.url()) })
  await loadDemoHistory(page, true)
  await page.getByRole('button', { name: '删除会话：今天有一点累', exact: true }).click()
  const topic = page.getByRole('region', { name: '最近话题' })
  await expect(topic).toHaveAttribute('data-conversation-id', 'preview-a-demo-interview')
  await expect(topic).toContainText('周末想散步、找一本喜欢的书。')
  await expect(topic).not.toContainText('忙碌了一天，想给这一周留一点自己的时间。')
  await page.getByRole('button', { name: '删除会话：周末想做点喜欢的事', exact: true }).click()
  await expect(topic).toHaveCount(0)
  await expect(page.locator('.history-link')).toHaveCount(0)
  await openTopicSettings(page)
  await expect(page.getByRole('button', { name: '已加载虚构历史', exact: true })).toBeDisabled()
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  await expect(topic).toHaveCount(0)
  expect(deletionRequests).toEqual([])
})

test('deleting an open conversation returns home and its old route becomes unavailable', async ({ page }) => {
  await loadDemoHistory(page, true)
  await page.getByRole('link', { name: '继续聊聊', exact: true }).click()
  await page.getByRole('button', { name: '删除会话：今天有一点累', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: '这段对话暂时找不到了', exact: true })).toBeVisible()
  await expect(page.getByRole('log')).toHaveCount(0)
})

test('earlier history remains selectable and opening it does not change the latest topic', async ({ page }) => {
  await loadDemoHistory(page, true)
  await page.getByRole('navigation', { name: '历史会话' }).getByRole('link', { name: '周末想做点喜欢的事', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/preview-a-demo-interview$/)
  await expect(page.getByRole('log')).toContainText('周末想去散步，也想找一本喜欢的书。')
  await expect(page.getByRole('log')).not.toContainText('我想给这一周留一点自己的时间。')
  await expect(page.getByRole('heading', { name: '今天还顺利吗？' })).toHaveCount(0)
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveAttribute('data-conversation-id', 'preview-a-demo-mood')
})

test('switching preview identities clears history and consent and blocks the old route', async ({ page }) => {
  await loadDemoHistory(page, true)
  await page.getByRole('link', { name: '继续聊聊', exact: true }).click()
  await openTopicSettings(page)
  await page.getByLabel('演示访客', { exact: true }).selectOption('preview-b')
  await expect(page.getByRole('checkbox', { name: '允许本页历史话题推荐' })).not.toBeChecked()
  await expect(page.locator('.history-link')).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/chat\/preview-a-demo-mood$/)
  await expect(page.getByRole('heading', { name: '这段对话暂时找不到了', exact: true })).toBeVisible()
  await expect(page.getByRole('log')).toHaveCount(0)
  await openTopicSettings(page)
  await page.getByRole('button', { name: '加载虚构历史', exact: true }).click()
  await page.getByRole('checkbox', { name: '允许本页历史话题推荐' }).check()
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveAttribute('data-conversation-id', 'preview-b-demo-mood')
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
})

test('local summaries use actual excerpts, including happy conversations', async ({ page }) => {
  await page.goto('/preferences/conversations')
  await page.getByRole('checkbox', { name: '允许本页历史话题推荐' }).check()
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  const message = '今天很开心，终于收到同学的一句鼓励。'
  await page.getByLabel('聊天消息', { exact: true }).fill(message)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  const originalUrl = page.url()
  await page.getByRole('button', { name: '新建聊天', exact: true }).click()
  const topic = page.getByRole('region', { name: '最近话题' })
  await expect(topic).toContainText('本页消息摘录')
  await expect(topic.locator('.recent-topic-summary')).toHaveText(message)
  await expect(topic).not.toContainText('120份简历')
  await topic.getByRole('link', { name: '继续聊聊', exact: true }).click()
  await expect(page).toHaveURL(originalUrl)
  await expect(page.locator('.message-user')).toHaveCount(1)
})

test('switching visitors removes local text as well as mock fixtures', async ({ page }) => {
  await page.goto('/')
  const message = '只属于演示访客A的一段本页便签。'
  await page.getByLabel('聊天消息', { exact: true }).fill(message)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-assistant')).toContainText('真实陪伴能力将在后续阶段接入')
  await openTopicSettings(page)
  await page.getByLabel('演示访客', { exact: true }).selectOption('preview-b')
  await expect(page.locator('body')).not.toContainText(message)
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  await expect(page.locator('.history-link')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
})

test('refresh resets consent and does not pretend to persist restored history', async ({ page }) => {
  await loadDemoHistory(page, true)
  await expect(page.getByRole('region', { name: '最近话题' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
  await expect(page.locator('.history-link')).toHaveCount(0)
  await page.getByRole('link', { name: '话题续聊设置', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '允许本页历史话题推荐' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '加载虚构历史', exact: true })).toBeEnabled()
})

test('mobile card remains light, resumes correctly and supports deletion in the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loadDemoHistory(page, true)
  const topic = page.getByRole('region', { name: '最近话题' })
  await expect(topic).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const card = await topic.boundingBox()
  const composer = await page.getByRole('form', { name: '聊天输入框' }).boundingBox()
  expect(card!.y + card!.height).toBeLessThan(composer!.y)
  await page.screenshot({ path: '.verification/recent-topic-card-mobile.png', fullPage: true })
  await topic.getByRole('link', { name: '继续聊聊', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('我想给这一周留一点自己的时间。')
  await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await page.getByRole('dialog', { name: '导航菜单' }).getByRole('button', { name: '删除会话：今天有一点累', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '导航菜单' })).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  await expect(topic).toHaveAttribute('data-conversation-id', 'preview-a-demo-interview')
})

test('a 320px screen and a resized visual viewport keep input usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await loadDemoHistory(page, true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByLabel('聊天消息', { exact: true }).fill('只是一句轻轻的问候。')
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error('VisualViewport required')
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 390 })
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await expect(page.locator('.companion-shell')).toHaveCSS('height', '390px')
  const composer = await page.getByRole('form', { name: '聊天输入框' }).boundingBox()
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(390)
  await expect(page.getByLabel('聊天消息', { exact: true })).toBeEnabled()
  await page.screenshot({ path: '.verification/recent-topic-small-keyboard.png', fullPage: true })
})

test('switching visitors cancels in-flight replies and cannot repopulate the new visitor', async ({ page }) => {
  let release = () => undefined as void
  let handled = () => undefined as void
  let intercepted = () => undefined as void
  const released = new Promise<void>((resolve) => { release = resolve })
  const completed = new Promise<void>((resolve) => { handled = resolve })
  const requested = new Promise<void>((resolve) => { intercepted = resolve })
  await page.route('**/api/v1/companion/demo/stream', async (route) => {
    intercepted()
    await released
    try {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        'event: meta\ndata: {"mode":"mock","persisted":false}\n\nevent: delta\ndata: {"text":"属于旧访客的迟到回复"}\n\nevent: done\ndata: {"mode":"mock","persisted":false}\n\n' })
    } finally { handled() }
  })
  await page.goto('/')
  await page.getByLabel('聊天消息', { exact: true }).fill('旧访客独有的生成中消息')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await requested
  await openTopicSettings(page)
  await page.getByLabel('演示访客', { exact: true }).selectOption('preview-b')
  release()
  await completed
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
  await expect(page.locator('body')).not.toContainText('旧访客独有的生成中消息')
  await expect(page.locator('body')).not.toContainText('属于旧访客的迟到回复')
  await expect(page.locator('.history-link')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '最近话题' })).toHaveCount(0)
})

test('a shorter desktop keeps the welcome visible and composer pinned', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await loadDemoHistory(page, true)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
  const composer = await page.getByRole('form', { name: '聊天输入框' }).boundingBox()
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(720)
  const viewport = await page.locator('.conversation-scroll').boundingBox()
  const title = await page.getByRole('heading', { name: '今天还顺利吗？', exact: true }).boundingBox()
  expect(title!.y).toBeGreaterThanOrEqual(viewport!.y)
  expect(title!.y + title!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height)
})
