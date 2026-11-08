import type { Page } from '@playwright/test'

/** Explicit UI setup, never a hidden seed or fake authenticated session. */
export async function loadDemoHistory(page: Page, consent = false) {
  await page.goto('/')
  await page.getByRole('link', { name: '话题续聊设置', exact: true }).click()
  await page.getByRole('button', { name: '加载虚构历史', exact: true }).click()
  if (consent) await page.getByRole('checkbox', { name: '允许本页历史话题推荐' }).check()
  await page.getByRole('link', { name: '返回聊天首页', exact: true }).click()
}

export async function openTopicSettings(page: Page) {
  await page.getByLabel('访客头像，打开账户菜单', { exact: true }).click()
  await page.getByRole('navigation', { name: '账户选项', exact: true })
    .getByRole('link', { name: '话题续聊设置', exact: true }).click()
}
