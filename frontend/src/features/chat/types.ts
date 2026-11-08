export type MessageStatus = 'queued' | 'complete' | 'streaming' | 'interrupted' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  error?: string
  generationId?: string
  provider?: string | null
  finishReason?: string | null
}

export interface ChatSession {
  id: string
  ownerScopeId: string
  title: string
  source: 'demo' | 'local' | 'server'
  version?: number
  lastMessageAt: string
  messages: ChatMessage[]
}

export type PreviewIdentityId = 'preview-a' | 'preview-b'

/** Recent topics are revocable UI suggestions, not long-term memories. */
export interface RecentConversationSummary {
  conversationId: string
  ownerScopeId: string
  title: string
  summary: string
  lastMessageAt: string
  followUpText: string
  dismissed: boolean
  source: 'mock' | 'message-excerpt'
  sourceMessageIds: string[]
  summaryVersion?: string
}

export interface ChatContextValue {
  sessions: ChatSession[]
  previewIdentityId: PreviewIdentityId
  switchPreviewIdentity: (identity: PreviewIdentityId) => void
  demoHistoryLoaded: boolean
  loadDemoHistory: () => void
  deleteSession: (sessionId: string) => void | Promise<void>
  recentTopicEnabled: boolean
  setRecentTopicEnabled: (enabled: boolean) => void | Promise<void>
  recentTopic: RecentConversationSummary | null
  dismissRecentTopic: (conversationId: string) => void | Promise<void>
  generatingSessionId: string | null
  sendMessage: (text: string, sessionId?: string) => string | Promise<string>
  stopGeneration: () => void | Promise<void>
  privateChat?: PrivateChatControls
}

export interface PrivateChatControls {
  runtime: ChatRuntime | null
  runtimeLoading: boolean
  runtimeError: string
  reloadRuntime: () => void
  selectedSessionId?: string
  selectSession: (sessionId?: string) => void
  loading: boolean
  historyLoading: boolean
  historyError: string
  error: string
  readError: string
  retryRead: () => void
  sending: boolean
  retryBlocked: boolean
  cancelling: boolean
  connectionState: string
  hasMoreSessions: boolean
  hasMoreMessages: boolean
  loadingMoreMessages: boolean
  loadMoreSessions: () => void
  loadMoreMessages: () => void
  prepareRename: (sessionId: string) => Promise<{ title: string; version: number }>
  rename: (sessionId: string, title: string, expectedVersion: number) => Promise<void>
  retryPendingSend: () => Promise<string>
  hasPendingSend: boolean
  retryGeneration: (generationId: string) => Promise<void>
  reconnect: () => void
  refreshHistory: () => void
  preferencesLoading: boolean
  preferencesSaving: boolean
  preferencesRequested: boolean | null
  preferencesError: string
}
import type { ChatRuntime } from './provider-presentation'
