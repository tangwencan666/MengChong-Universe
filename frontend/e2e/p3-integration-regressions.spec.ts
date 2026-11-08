/** Deterministic HTTP-contract fault regressions; real API acceptance is separate. */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loginAccount, registerAccount } from './helpers/auth'
import { disposeP3ChatMock, installP3ChatMock } from './helpers/p3-chat-mock'
import type { MockOptions } from './helpers/p3-chat-mock'

test.describe('P3 集成修复：HTTP 契约 Mock 回归', () => {
  test.afterEach(async ({ page }) => { await disposeP3ChatMock(page) })
  async function setup(page: Page, options: MockOptions = {}) {
    const mock = await installP3ChatMock(page, options)
    const email = await registerAccount(page, '集成回归同学')
    await loginAccount(page, email)
    return mock
  }
  async function send(page: Page) {
    await page.getByLabel('聊天消息', { exact: true }).fill('集成回归的当前输入')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page).toHaveURL(/\/chat\/[\da-f-]+$/)
  }

  test('connection STREAM_UNAVAILABLE 恢复快照并使用新游标，无重复发送', async ({ page }) => {
    const mock = await setup(page, { connectionGapOnce: true })
    await send(page)
    await expect(page.getByRole('log')).toContainText('固定本地回复', { timeout: 15000 })
    expect(mock.stats.snapshots).toBeGreaterThanOrEqual(2)
    expect(mock.stats.getEvents).toHaveLength(2)
    expect(mock.stats.getEvents[1].lastEventId).toBe(`${mock.stats.getEvents[1].generationId}:2`)
    expect(mock.stats.sendCalls).toBe(1); expect(mock.stats.acceptedSends).toBe(1)
    await expect(page.getByRole('log').locator('.message-user')).toHaveCount(1)
  })

  test('无活跃摘要时 queued cancel 200 直接恢复终态助手消息', async ({ page }) => {
    const mock = await setup(page, { queued: true, omitActiveSummary: true })
    await send(page)
    await expect(page.getByRole('log')).toContainText('正在排队等待回复')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('log')).toContainText('已停止生成')
    await expect(page.getByRole('button', { name: '重新生成回复', exact: true })).toBeVisible()
    await expect(page.getByRole('log')).not.toContainText('正在排队等待回复')
    expect(mock.stats.cancelCalls).toBe(1); expect(mock.stats.snapshots).toBeGreaterThanOrEqual(2)
  })

  test('完成赢得取消竞态的 200 恢复完整正文，不错误标记为已取消', async ({ page }) => {
    const mock = await setup(page, { queued: true, omitActiveSummary: true, cancelAlreadyCompleted: true })
    await send(page)
    await expect(page.getByRole('log')).toContainText('正在排队等待回复')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('log')).toContainText('固定本地回复')
    await expect(page.getByRole('log')).not.toContainText('已停止生成')
    await expect(page.getByRole('button', { name: '重新生成回复', exact: true })).toHaveCount(0)
    expect(mock.stats.cancelCalls).toBe(1); expect(mock.stats.acceptedSends).toBe(1)
  })

  test('cancel 已确认但终态快照暂时失败时，可 GET 重连而不重复取消', async ({ page }) => {
    const mock = await setup(page, { queued: true, omitActiveSummary: true, snapshotFailAfterCancelOnce: true })
    await send(page)
    await expect(page.getByRole('log')).toContainText('正在排队等待回复')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('任务已结束，回复内容尚未同步')
    const reconnect = page.getByRole('button', { name: '重新连接', exact: true })
    await expect(reconnect).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    expect(mock.stats.cancelCalls).toBe(1)
    await reconnect.click()
    await expect(page.getByRole('log')).toContainText('已停止生成')
    await expect(page.getByRole('button', { name: '重新生成回复', exact: true })).toBeVisible()
    await expect(reconnect).toHaveCount(0)
    expect(mock.stats.cancelCalls).toBe(1); expect(mock.stats.sendCalls).toBe(1)
    expect(mock.stats.snapshots).toBeGreaterThanOrEqual(3)
  })

  test('首次快照已经完成及刷新历史都保留 length 提示', async ({ page }) => {
    const mock = await setup(page, { finishBeforeSnapshot: true, finishReason: 'length' })
    await send(page)
    await expect(page.getByRole('log')).toContainText('固定本地回复')
    await expect(page.getByText('回复已达到本次长度上限。', { exact: true })).toBeVisible()
    expect(mock.stats.getEvents).toHaveLength(0)
    await page.reload()
    await expect(page.getByText('回复已达到本次长度上限。', { exact: true })).toBeVisible()
    expect(mock.stats.sendCalls).toBe(1)
  })

  test('重命名使用打开编辑框时的版本，409 不覆盖另一标签页标题', async ({ page }) => {
    const mock = await setup(page)
    const id = await mock.seed('原始标题', 0)
    await page.reload()
    await page.getByRole('button', { name: '重命名会话：原始标题', exact: true }).click()
    await mock.renameElsewhere(id, '另一标签页的新标题')
    await page.getByLabel('会话标题', { exact: true }).fill('当前过期编辑')
    await page.getByRole('button', { name: '保存标题', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('VERSION_CONFLICT')
    expect(mock.stats.renameExpectedVersions).toEqual([1])
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    await expect(page.getByRole('navigation', { name: '历史会话' })).toContainText('另一标签页的新标题')
    await expect(page.getByRole('navigation', { name: '历史会话' })).not.toContainText('当前过期编辑')
  })

  test('生成终态更新会话版本，迟到的旧详情不会覆盖新版本并导致重命名 409', async ({ page }) => {
    const mock = await setup(page, { delayFirstActiveDetail: true })
    await send(page)
    await expect(page.getByRole('log')).toContainText('固定本地回复')
    await expect.poll(() => mock.stats.detailVersions).toContain(3)
    await page.getByRole('button', { name: '重命名会话：新的聊天', exact: true }).click()
    await page.getByLabel('会话标题', { exact: true }).fill('生成后正常重命名')
    await page.getByRole('button', { name: '保存标题', exact: true }).click()
    await expect(page.getByRole('heading', { name: '生成后正常重命名', exact: true })).toBeVisible()
    expect(mock.stats.renameExpectedVersions).toEqual([3])
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('终态详情尚未同步时打开重命名，先读取服务端版本再显示编辑框', async ({ page }) => {
    const mock = await setup(page, { delayFirstActiveDetail: true, terminalDetailDelayMs: 900 })
    await send(page)
    await expect(page.getByRole('log')).toContainText('固定本地回复')
    // Intentionally do not wait for a version-3 detail response before clicking.
    const rename = page.getByRole('button', { name: '重命名会话：新的聊天', exact: true })
    await rename.click()
    await expect(rename).toBeDisabled()
    await expect(page.getByRole('dialog', { name: '重命名会话', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('会话标题', { exact: true })).toBeVisible()
    await page.getByLabel('会话标题', { exact: true }).fill('准备完成后再编辑的标题')
    await page.getByRole('button', { name: '保存标题', exact: true }).click()
    await expect(page.getByRole('heading', { name: '准备完成后再编辑的标题', exact: true })).toBeVisible()
    expect(mock.stats.renameExpectedVersions).toEqual([3])
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('隐藏话题后等待偏好版本同步，随后关闭推荐不会使用旧版本', async ({ page }) => {
    const mock = await setup(page, { dismissPreferenceReadDelayMs: 700 })
    await mock.seed('隐藏后关闭推荐的会话')
    await page.getByRole('link', { name: '话题续聊设置', exact: true }).click()
    const checkbox = page.getByRole('checkbox', { name: '允许当前账户历史话题推荐' })
    await checkbox.check()
    await expect(page.getByText('正在保存授权设置…', { exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
    await expect(page.getByRole('region', { name: '最近话题', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '暂时不看', exact: true }).click()
    await page.getByRole('link', { name: '话题续聊设置', exact: true }).click()
    await expect(checkbox).toBeDisabled()
    await expect(checkbox).toBeEnabled()
    await checkbox.uncheck()
    await expect(page.getByText('正在保存授权设置…', { exact: true })).toHaveCount(0)
    await expect(checkbox).not.toBeChecked()
    expect(mock.stats.preferenceExpectedVersions).toEqual([0, 2])
    expect(mock.stats.dismissalCalls).toBe(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.reload()
    await expect(checkbox).not.toBeChecked()
  })

  test('首页重新聚焦时先隐藏旧话题并确认另一标签页撤销的授权', async ({ page }) => {
    const mock = await setup(page)
    await mock.seed('等待重新确认的话题')
    await page.getByRole('link', { name: '话题续聊设置', exact: true }).click()
    await page.getByRole('checkbox', { name: '允许当前账户历史话题推荐' }).check()
    await expect(page.getByText('正在保存授权设置…', { exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
    await expect(page.getByRole('region', { name: '最近话题', exact: true })).toBeVisible()
    await mock.preferencesElsewhere(false, 900)
    const before = mock.stats.preferenceReads
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('region', { name: '最近话题', exact: true })).toHaveCount(0)
    await expect.poll(() => mock.stats.preferenceReads).toBeGreaterThan(before)
    await page.getByRole('link', { name: '话题续聊设置', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '允许当前账户历史话题推荐' })).not.toBeChecked()
    await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
    await expect(page.getByRole('region', { name: '最近话题', exact: true })).toHaveCount(0)
  })

  test('重新聚焦同步另一标签页新增的历史和已完成消息', async ({ page }) => {
    const mock = await setup(page)
    const id = await mock.seed('正在阅读的会话')
    await page.goto(`/chat/${id}`)
    await expect(page.getByRole('log')).toContainText('契约测试历史 1')
    await mock.appendElsewhere(id, '另一标签页刚保存的消息')
    await mock.seed('另一标签页创建的会话', 0)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('log')).toContainText('另一标签页刚保存的消息')
    await expect(page.getByRole('navigation', { name: '历史会话' })).toContainText('另一标签页创建的会话')
    expect(mock.stats.sendCalls).toBe(0)
  })
})
