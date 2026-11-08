import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export const browserPassword = 'Local-Browser-Safe!2026'

export async function registerAccount(page: Page, name = '测试同学') {
  const email = `browser-${crypto.randomUUID()}@example.com`
  await page.goto('/register')
  await page.getByLabel('昵称', { exact: true }).fill(name)
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(browserPassword)
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('status')).toContainText('本地 Mock 邮件')
  return email
}

export async function loginAccount(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(browserPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '今天还顺利吗？', exact: true })).toBeVisible()
}
