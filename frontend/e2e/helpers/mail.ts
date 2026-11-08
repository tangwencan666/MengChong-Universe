import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from '@playwright/test'

interface MockMail { id: string; recipient: string; purpose: string; link: string | null; created_at: string; mock: boolean; filePath: string }
const directory = resolve(process.cwd(), '../.verification/p25/browser-mail')

async function messages(folder: string): Promise<MockMail[]> {
  let entries
  try { entries = await readdir(folder, { withFileTypes: true }) } catch { return [] }
  const output: MockMail[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) output.push(...await messages(path))
    else if (entry.name.endsWith('.json')) {
      try {
        const message = JSON.parse(await readFile(path, 'utf8')) as MockMail
        if (message.mock) output.push({ ...message, filePath: path })
      } catch { /* The writer may not yet have finished this new local file. */ }
    }
  }
  return output
}

/** Filesystem-only test helper. No public HTTP inbox or test authentication shortcut. */
export async function waitForMail(email: string, purpose: string, previousId?: string): Promise<MockMail> {
  let result: MockMail | undefined
  await expect.poll(async () => {
    result = (await messages(directory)).filter((message) => message.recipient === email
      && message.purpose === purpose && message.id !== previousId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
    return Boolean(result)
  }, { timeout: 10_000 }).toBe(true)
  return result!
}
