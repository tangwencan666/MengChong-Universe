import type { MessageStatus } from '../chat/types'
import type { DesktopActivitySignal } from './bridge'

// Only state metadata crosses the desktop bridge, never message or memory text.
export function desktopActivitySignal(message: { generationId?: string; status: MessageStatus; hasOutput: boolean },
  sessionId: string, revision: number): DesktopActivitySignal | null {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const states = { queued: 'queued', streaming: 'running', complete: 'completed', interrupted: 'cancelled', error: 'failed' } as const
  if (!uuid.test(message.generationId ?? '') || !uuid.test(sessionId) || !Object.hasOwn(states, message.status)
    || !Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) return null
  return { generation_id: message.generationId!, session_id: sessionId,
    sequence: revision, state: states[message.status], has_output: message.hasOutput }
}
