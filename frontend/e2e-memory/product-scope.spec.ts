import { expect, test } from '@playwright/test'
import { enable, memoryPrefix, setup } from './helpers'

test('consumer memory defaults to an explicit note and preserves the legacy category contract', async ({ page }) => {
  await setup(page)
  await enable(page)
  await page.getByRole('button', { name: '添加记忆', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加一条记忆', exact: true })
  const category = dialog.getByLabel('记忆类别', { exact: true })
  await expect(category).toHaveValue('explicit_note')
  await expect(category.locator('option[value="career_goal"]')).toHaveText('个人目标（旧版分类）')
  await dialog.getByLabel('记忆标题', { exact: true }).fill('喜欢的音乐')
  await dialog.getByLabel('记忆内容', { exact: true }).fill('我喜欢在放松时听轻音乐。')
  const save = dialog.getByRole('button', { name: '确认保存', exact: true })
  await expect(save).toBeDisabled()
  await dialog.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true }).check()
  const saved = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${memoryPrefix}/items`)
  await save.click()
  const response = await saved
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON()).toMatchObject({ category: 'explicit_note' })
  await expect(dialog).not.toBeVisible()
  await expect(page.getByTestId('memory-item').filter({ hasText: '喜欢的音乐' })).toContainText('其他明确事项')
})
