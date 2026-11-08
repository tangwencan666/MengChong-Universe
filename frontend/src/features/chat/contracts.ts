import type { ChatSession, RecentConversationSummary } from './types'

/**
 * UI history port. Private wire DTOs/commands live in api-types.ts and api.ts.
 * The server must derive its owner from the authenticated principal, never from
 * the preview identity selector or an arbitrary client-supplied user ID.
 * Clear client caches and cancel requests on identity changes, deletion, or revocation.
 */
export interface ConversationHistoryPort {
  getRecentTopic(signal?: AbortSignal): Promise<RecentConversationSummary | null>
  getConversation(conversationId: string, signal?: AbortSignal): Promise<ChatSession>
  setRecentTopicConsent(enabled: boolean, signal?: AbortSignal): Promise<void>
  dismissTopic(conversationId: string, summaryVersion: string, signal?: AbortSignal): Promise<void>
  deleteConversation(conversationId: string, signal?: AbortSignal): Promise<void>
}

/** Long-term memory requires separate, purpose-specific consent. Not implemented. */
export interface AuthorizedLongTermMemory {
  id: string
  sourceConversationId: string
  sourceMessageIds: string[]
  category: 'experience' | 'career-goal' | 'communication-preference'
  content: string
  authorizedAt: string
}

export interface LongTermMemoryPort {
  listAuthorized(signal?: AbortSignal): Promise<AuthorizedLongTermMemory[]>
  grantConsent(purpose: 'long-term-memory', signal?: AbortSignal): Promise<void>
  revokeConsent(signal?: AbortSignal): Promise<void>
  deleteMemory(memoryId: string, signal?: AbortSignal): Promise<void>
}
