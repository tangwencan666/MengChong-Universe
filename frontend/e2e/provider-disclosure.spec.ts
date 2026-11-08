import { expect, test } from '@playwright/test'
import { loginAccount, registerAccount } from './helpers/auth'
import { disposeP3ChatMock, installP3ChatMock } from './helpers/p3-chat-mock'

test.describe('P8 模型披露（HTTP fixture，不调用真实模型）', () => {
  test.afterEach(async ({ page }) => { await disposeP3ChatMock(page) })

  test('DeepSeek 服务端模式在发送前披露费用，回复按真实元数据标记', async ({ page }) => {
    const fixture = await installP3ChatMock(page, { provider: 'deepseek' })
    const email = await registerAccount(page, '模型披露测试')
    await loginAccount(page, email)
    const disclosure = page.locator('#composer-disclosure')
    await expect(disclosure).toContainText('DeepSeek · deepseek-flash')
    await expect(disclosure).toContainText('可能产生 API 费用')
    await expect(disclosure).toContainText('本次消息及当前会话历史将发往模型服务商')
    await expect(disclosure).toContainText('本次不额外注入长期记忆')
    await expect(disclosure).not.toContainText('不计费')
    await page.getByLabel('聊天消息', { exact: true }).fill('仅用于本地 HTTP fixture 的消息')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('log').locator('.message-author')).toContainText('DeepSeek')
    expect(fixture.stats.acceptedSends).toBe(1)
    await page.reload()
    await expect(page.getByRole('log').locator('.message-author')).toContainText('DeepSeek')
  })

  test('配置读取失败不猜测为 Mock，仍可读历史且不发送新请求', async ({ page }) => {
    const fixture = await installP3ChatMock(page)
    await page.route('**/api/v1/companion/runtime', (route) => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_RUNTIME_UNAVAILABLE', message: '测试配置暂不可读' } }) }))
    const email = await registerAccount(page, '配置未知测试')
    await loginAccount(page, email)
    const session = await fixture.seed('已保存的 Mock 历史')
    await page.goto(`/chat/${session}`)
    await expect(page.getByRole('log')).toContainText('固定本地回复')
    await expect(page.locator('#composer-disclosure')).toContainText('模型配置尚未确认')
    await expect(page.locator('#composer-disclosure')).not.toContainText('不计费')
    await page.getByLabel('聊天消息', { exact: true }).fill('不应被发送')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
    expect(fixture.stats.sendCalls).toBe(0)
    await page.unroute('**/api/v1/companion/runtime')
    await page.getByRole('button', { name: '重新确认模型配置' }).click()
    await expect(page.locator('#composer-disclosure')).toContainText('本地 Mock')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  })

  test('后端从 Mock 切为真实配置时中止旧点击，先更新费用提示', async ({ page }) => {
    const fixture = await installP3ChatMock(page)
    const email = await registerAccount(page, '配置变化测试')
    await loginAccount(page, email)
    await expect(page.locator('#composer-disclosure')).toContainText('本地 Mock')
    await page.route('**/api/v1/companion/runtime', (route) => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ schema_version: 'chat-runtime/1', provider: 'deepseek', model: 'deepseek-flash',
        mode: 'real', billing: 'external_provider', memory_injection_enabled: false }) }))
    await page.getByLabel('聊天消息', { exact: true }).fill('只有再次确认后才能发送')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('alert').first()).toContainText('聊天模型配置已变化')
    await expect(page.locator('#composer-disclosure')).toContainText('可能产生 API 费用')
    expect(fixture.stats.sendCalls).toBe(0)
    expect(fixture.stats.createCalls).toBe(0)
  })

  test('发送前配置复核失败时不复用旧的免费提示发送', async ({ page }) => {
    const fixture = await installP3ChatMock(page)
    const email = await registerAccount(page, '复核失败测试')
    await loginAccount(page, email)
    await expect(page.locator('#composer-disclosure')).toContainText('本地 Mock')
    await page.route('**/api/v1/companion/runtime', (route) => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_RUNTIME_UNAVAILABLE', message: '测试配置复核失败' } }) }))
    await page.getByLabel('聊天消息', { exact: true }).fill('这条请求必须停在模型复核之前')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.locator('#composer-disclosure')).toContainText('模型配置尚未确认')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
    expect(fixture.stats.sendCalls).toBe(0)
    expect(fixture.stats.createCalls).toBe(0)
  })
})
