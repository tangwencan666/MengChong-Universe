import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loginAccount, registerAccount } from '../e2e/helpers/auth'

export const origin = process.env.WEIBIYE_MEMORY_UI_ORIGIN ?? 'http://127.0.0.1:35305'
export const memoryPrefix = '/api/v1/memory'
export const chatPrefix = '/api/v1/companion'
export const fact = '希望优先考虑后端研发岗位，关注星河团队。'
export const query = '想聊聊后端求职准备。'
export const fixedReply = '你可以用它体验已保存会话的流式显示。'
export type Item = { id: string; title: string; content: string; version: number; status: string;
  sources: { kind: string; session_id: string | null; message_id: string | null }[] }

export async function setup(page: Page) {
  const email = await registerAccount(page, 'P4C 合成测试同学')
  await loginAccount(page, email)
  return email
}

export async function command(page: Page, method: string, path: string, data?: object, key: string = crypto.randomUUID()) {
  const csrf = await (await page.request.get('/api/v1/auth/csrf')).json() as { csrf_token: string }
  return page.request.fetch(path, { method, data, headers: {
    Origin: origin, 'X-CSRF-Token': csrf.csrf_token, 'Idempotency-Key': key,
  } })
}

export async function preferences(page: Page) {
  const response = await page.request.get(memoryPrefix + '/preferences')
  expect(response.status()).toBe(200)
  return await response.json() as { long_term_memory_enabled: boolean; version: number; revision: string }
}

export async function items(page: Page): Promise<Item[]> {
  const response = await page.request.get(memoryPrefix + '/items?limit=100')
  expect(response.status()).toBe(200)
  return (await response.json() as { items: Item[] }).items
}

export async function memoryPage(page: Page) {
  await page.goto('/memory')
  await expect(page.getByRole('heading', { name: /^记忆管理/ })).toBeVisible()
  await expect(page.getByRole('switch', { name: '长期记忆授权', exact: true })).toBeEnabled()
}

export async function enable(page: Page) {
  await memoryPage(page)
  const toggle = page.getByRole('switch', { name: '长期记忆授权', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  const dialog = page.getByRole('dialog', { name: '开启长期记忆', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认开启', exact: true })).toBeDisabled()
  await dialog.getByLabel('我了解并同意以上长期记忆说明', { exact: true }).check()
  await dialog.getByRole('button', { name: '确认开启', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(toggle).toBeChecked()
  expect((await preferences(page)).long_term_memory_enabled).toBe(true)
}

export async function add(page: Page, title = '后端求职目标', content = fact) {
  await page.getByRole('button', { name: '添加记忆', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加一条记忆', exact: true })
  await dialog.getByLabel('记忆标题', { exact: true }).fill(title)
  await dialog.getByLabel('记忆内容', { exact: true }).fill(content)
  await dialog.getByLabel('记忆类别', { exact: true }).selectOption('career_goal')
  await expect(dialog.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  await dialog.getByLabel('我已核对以上内容，同意保存这条长期记忆', { exact: true }).check()
  await dialog.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByTestId('memory-item').filter({ hasText: title })).toContainText(content)
  const item = (await items(page)).find((entry) => entry.title === title)
  expect(item).toBeTruthy()
  return item!
}

export async function detail(page: Page, title: string) {
  await page.getByRole('button', { name: `查看记忆：${title}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '记忆详情', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

export async function send(page: Page, content: string) {
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/api\/v1\/companion\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname))
  await page.getByLabel('聊天消息', { exact: true }).fill(content)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const response = await accepted
  expect(response.status()).toBe(202)
  await expect(page).toHaveURL(/\/chat\/[a-f\d-]+$/)
  return await response.json() as { generation: { id: string; session_id: string }; events_url: string;
    user_message: { id: string }; assistant_message: { id: string } }
}

export async function complete(page: Page) {
  await expect(page.getByRole('log')).toContainText(fixedReply, { timeout: 20_000 })
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
}

export async function screenshot(page: Page, filename: string) {
  await mkdir('../.verification/screenshots', { recursive: true })
  await page.screenshot({ path: `../.verification/screenshots/${filename}`, fullPage: true })
}

export async function observations() {
  const text = await readFile(process.env.WEIBIYE_MEMORY_OBSERVATIONS ?? '../.verification/p4c-provider-observations.jsonl', 'utf8')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    provider: string; memories: { memory_id: string; version: number; content_sha256: string }[]
  })
}

export function digest(value: string) { return createHash('sha256').update(value).digest('hex') }

export function frames(body: string) {
  return body.split(/\r?\n\r?\n/).filter((block) => block.includes('data:')).map((block) => {
    const lines = block.split(/\r?\n/)
    const data = JSON.parse(lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')) as {
      content?: string; reason?: string; sequence?: number
    }
    return { id: lines.find((line) => line.startsWith('id:'))?.slice(3).trim(),
      event: lines.find((line) => line.startsWith('event:'))?.slice(6).trim(), data }
  })
}
