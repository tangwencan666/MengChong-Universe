export interface SendIntent {
  content: string; sessionId?: string; createKey: string; messageKey: string; clientMessageId: string
}
export function normalizeChatText(text: string, maximum = 4000) {
  const value = text.replace(/\r\n?/g, '\n').trim()
  if (!value || [...value].length > maximum) throw new Error(`请输入 1–${maximum} 字的内容。`)
  return value
}
export function createSendIntent(content: string, sessionId?: string): SendIntent {
  return { content: normalizeChatText(content), sessionId, createKey: crypto.randomUUID(),
    messageKey: crypto.randomUUID(), clientMessageId: crypto.randomUUID() }
}
export function retryAfterMilliseconds(value: string, now = Date.now()) {
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0
}
/** A new task observed in the session wins over a terminal snapshot of an older task. */
export function currentSessionGeneration(observed: ChatGeneration | null | undefined, streamed: ChatGeneration | null, sessionId?: string) {
  if (!sessionId) return null
  const live = streamed?.session_id === sessionId ? streamed : null
  const summary = observed?.session_id === sessionId ? observed : null
  return summary && summary.id !== live?.id ? summary : live ?? summary
}

/** Unknown retry results retain their own key without blocking retries in other sessions. */
export class GenerationRetryKeys {
  private keys = new Map<string, string>()
  keyFor(sessionId: string, generationId: string) {
    const scope = `${sessionId}:${generationId}`
    let key = this.keys.get(scope)
    if (!key) { key = crypto.randomUUID(); this.keys.set(scope, key) }
    return key
  }
  confirm(sessionId: string, generationId: string) { this.keys.delete(`${sessionId}:${generationId}`) }
  clear() { this.keys.clear() }
}
/** A retry calls the same closure; keys and message UUID are never regenerated here. */
export async function retryNetworkOnce<T>(operation: () => Promise<T>, networkFailure: (error: unknown) => boolean, signal: AbortSignal) {
  try { return await operation() }
  catch (error) {
    if (signal.aborted || !networkFailure(error)) throw error
    return operation()
  }
}
import type { ChatGeneration } from './api-types.ts'
