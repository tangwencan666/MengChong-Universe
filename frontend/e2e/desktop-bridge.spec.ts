/** Browser-only native-bridge regression. Auth/pets/chat use the isolated SQLite
 * e2e_server and its real Cookie/CSRF APIs; this does not claim native Windows UI.
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { DesktopPet, DesktopState } from '../src/features/desktop/bridge'
import { browserPassword, loginAccount, registerAccount } from './helpers/auth'

interface PendingList {
  owner: string | null
  resolve: (pets: DesktopPet[]) => void
}
interface FixtureControl {
  documentId: string
  owner: string | null
  pets: DesktopPet[]
  holdOwner: string | null
  pending: PendingList[]
  emit: (state: DesktopState) => void
  settle: (owner: string, pets: DesktopPet[]) => number
}
type FixtureWindow = Window & { __weibiyeDesktopFixture: FixtureControl }
type Pet = { pet_id: string; name: string }

async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Set<(state: DesktopState) => void>()
    const control: FixtureControl = {
      documentId: crypto.randomUUID(), owner: null, pets: [], holdOwner: null, pending: [],
      emit(state) { for (const listener of [...listeners]) listener(state) },
      settle(owner, pets) {
        const selected = control.pending.filter((item) => item.owner === owner)
        control.pending = control.pending.filter((item) => item.owner !== owner)
        for (const item of selected) item.resolve(pets)
        return selected.length
      },
    }
    Object.defineProperty(window, '__weibiyeDesktopFixture', { value: control })
    const unsupported = async () => { throw new Error('Native window actions are outside this browser fixture.') }
    Object.defineProperty(window, 'weibiyeDesktop', { value: Object.freeze({
      version: 'browser-regression-fixture/1',
      list: () => control.holdOwner && control.owner === control.holdOwner
        ? new Promise<DesktopPet[]>((resolve) => control.pending.push({ owner: control.owner, resolve }))
        : Promise.resolve(control.pets),
      release: unsupported, hide: unsupported, show: unsupported, recall: unsupported, openChat: unsupported,
      async syncSession() {
        const response = await fetch('/api/v1/auth/me', { credentials: 'include', cache: 'no-store' })
        const next = response.ok ? (await response.json() as { id: string }).id : null
        const changed = control.owner !== next
        control.owner = next
        return { authenticated: Boolean(next), owner_id: next, changed }
      },
      onChange(callback: (state: DesktopState) => void) {
        listeners.add(callback)
        return () => { listeners.delete(callback) }
      },
    }) })
  })
}

async function command(page: Page, method: string, path: string, data: object) {
  const tokenResponse = await page.request.get('/api/v1/auth/csrf')
  expect(tokenResponse.status()).toBe(200)
  const { csrf_token: token } = await tokenResponse.json() as { csrf_token: string }
  return page.request.fetch(path, { method, data, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': token, 'Idempotency-Key': crypto.randomUUID(),
  } })
}

async function currentOwner(page: Page) {
  const response = await page.request.get('/api/v1/auth/me')
  expect(response.status()).toBe(200)
  return (await response.json() as { id: string }).id
}

async function createPet(page: Page, name: string): Promise<Pet> {
  const response = await command(page, 'POST', '/api/v1/pets', {
    name, role_type: 'cat', persona_config: { description: '浏览器桥接回归专用合成角色。', tone: 'calm' },
  })
  expect(response.status()).toBe(201)
  return response.json() as Promise<Pet>
}

function desktopPet(pet: Pet): DesktopPet {
  return { pet_id: pet.pet_id, name: pet.name, role_type: 'cat', tint: '#7E9F84',
    state: 'idle', direction: 'right', hidden: false, chat_open: false }
}

async function openPetsWithoutReload(page: Page) {
  await page.locator('#desktop-sidebar').getByRole('link', { name: '我的宠物', exact: true }).click()
  await expect(page).toHaveURL(/\/companions$/)
}

test('Web without a native bridge retains real account and pet UI without desktop controls', async ({ page }) => {
  const email = await registerAccount(page, 'Web 桥接边界')
  await loginAccount(page, email)
  const pet = await createPet(page, 'Web 专用伙伴')
  await openPetsWithoutReload(page)
  const card = page.locator('.pet-card').filter({ hasText: pet.name })
  await expect(card).toBeVisible()
  await expect(card.getByRole('link', { name: '开始聊天', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '放到桌面', exact: true })).toHaveCount(0)
  await expect(page.getByText('Windows 桌面客户端提供本地预览，尚未公开发行。', { exact: false })).toBeVisible()
  expect(await page.evaluate(() => typeof window.weibiyeDesktop)).toBe('undefined')
})

test('a native invalidation signal removes live private React history without deleting persisted data', async ({ page }) => {
  await installBridge(page)
  const email = await registerAccount(page, 'Native 失效缓存验收')
  await loginAccount(page, email)
  const pet = await createPet(page, '缓存隔离伙伴')
  await page.goto(`/pets/${pet.pet_id}`)
  await expect(page.getByPlaceholder('愿意和我聊聊吗？', { exact: true })).toBeVisible()
  const owner = await currentOwner(page)
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__weibiyeDesktopFixture.owner)).toBe(owner)
  const privateText = `合成私人消息 ${crypto.randomUUID()}`
  await page.getByLabel('聊天消息', { exact: true }).fill(privateText)
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().includes(`/pets/${pet.pet_id}/sessions/`) && response.url().endsWith('/messages'))
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const acceptedResponse = await accepted
  expect(acceptedResponse.status()).toBe(202)
  const data = await acceptedResponse.json() as { generation: { session_id: string } }
  await expect(page.getByRole('log')).toContainText(privateText)
  await expect(page.locator('.message-assistant').last()).toContainText('你可以用它体验已保存会话的流式显示。')
  const conversationURL = page.url()

  await page.evaluate(() => (window as unknown as FixtureWindow).__weibiyeDesktopFixture.emit({ authenticated: false, owner_id: null, pets: [] }))
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('status')).toContainText('桌面账户状态已变化')
  await expect(page.getByLabel('访客头像，打开账户菜单', { exact: true })).toBeVisible()
  await expect(page.getByRole('log')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '历史会话', exact: true })).not.toContainText(privateText)
  await expect(page.locator('body')).not.toContainText(privateText)
  // The native UI signal clears frontend scope, not the real Cookie or database.
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200)
  expect((await page.request.get(`/api/v1/pets/${pet.pet_id}/sessions/${data.generation.session_id}`)).status()).toBe(200)
  // The Cookie intentionally remains valid, so reloading /login here would
  // auto-restore it and conceal whether the native signal cleared live state.
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(browserPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(conversationURL)
  await expect(page.getByRole('log')).toContainText(privateText)
  await page.reload()
  await expect(page.getByRole('log')).toContainText(privateText)
})

test('a delayed account A desktop list cannot replace account B state after a same-document switch', async ({ page }) => {
  await installBridge(page)
  const emailA = await registerAccount(page, '延迟桥接账户 A')
  await loginAccount(page, emailA)
  const ownerA = await currentOwner(page)
  const petA = await createPet(page, 'A 的延迟私人伙伴')
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__weibiyeDesktopFixture.owner)).toBe(ownerA)
  const documentId = await page.evaluate((id) => {
    const fixture = (window as unknown as FixtureWindow).__weibiyeDesktopFixture
    fixture.holdOwner = id
    return fixture.documentId
  }, ownerA)
  await openPetsWithoutReload(page)
  await expect(page.locator('.pet-card').filter({ hasText: petA.name })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__weibiyeDesktopFixture.pending.length)).toBeGreaterThan(0)

  const emailB = `desktop-bridge-${crypto.randomUUID()}@example.com`
  const registration = await command(page, 'POST', '/api/v1/auth/register', {
    email: emailB, password: browserPassword, display_name: '延迟桥接账户 B',
  })
  expect(registration.status()).toBe(202)
  await page.locator('.profile-entry').click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  // Use the real form without page.goto: the old Promise must survive in this
  // same browser document, otherwise a full reload would hide the stale-result bug.
  await page.getByLabel('邮箱', { exact: true }).fill(emailB)
  await page.getByLabel('密码', { exact: true }).fill(browserPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  // The protected /me page supplies next=/me on logout; preserve that real
  // return-path behavior rather than forcing a new document or the homepage.
  await expect(page).toHaveURL(/\/me$/)
  await expect(page.getByRole('heading', { name: '延迟桥接账户 B', exact: true })).toBeVisible()
  await expect(page.locator('main')).toContainText(emailB)
  const ownerB = await currentOwner(page)
  expect(ownerB).not.toBe(ownerA)
  const petB = await createPet(page, 'B 的当前私人伙伴')
  const releasedB = desktopPet(petB)
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__weibiyeDesktopFixture.owner)).toBe(ownerB)
  await page.evaluate((value) => { (window as unknown as FixtureWindow).__weibiyeDesktopFixture.pets = [value] }, releasedB)
  await openPetsWithoutReload(page)
  const cardB = page.locator('.pet-card').filter({ hasText: petB.name })
  await expect(cardB.getByRole('button', { name: '隐藏桌宠', exact: true })).toBeVisible()
  const settled = await page.evaluate(({ owner, pet }) => {
    const fixture = (window as unknown as FixtureWindow).__weibiyeDesktopFixture
    return { count: fixture.settle(owner, [pet]), documentId: fixture.documentId }
  }, { owner: ownerA, pet: desktopPet(petA) })
  expect(settled.documentId).toBe(documentId)
  expect(settled.count).toBeGreaterThan(0)
  // An old A array would remove B's matching record and incorrectly show “放到桌面”.
  await expect(cardB.getByRole('button', { name: '隐藏桌宠', exact: true })).toBeVisible()
  await expect(cardB.getByRole('button', { name: '放到桌面', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(petA.name)
  expect((await page.request.get(`/api/v1/pets/${petA.pet_id}`)).status()).toBe(404)
})
