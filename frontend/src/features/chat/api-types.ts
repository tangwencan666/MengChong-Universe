/** Wire DTOs: docs/P3_CHAT_API_CONTRACT.md, including integration metadata recovery. */
export type GenerationState = 'queued' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled'
export type FinishReason = 'stop' | 'length' | null
export type StoredMessageStatus = 'queued' | 'streaming' | 'completed' | 'failed' | 'cancelled'
export interface SafeError { code: string; message: string; retryable?: boolean }
export interface StoredMessage {
  pet_id?: string | null
  id: string; session_id: string; client_message_id: string | null; sequence: number
  role: 'user' | 'assistant'; content: string; status: StoredMessageStatus; provider: string | null
  created_at: string; completed_at: string | null; generation_id: string | null; finish_reason: FinishReason
}
export interface ChatGeneration {
  pet_id?: string | null
  id: string; session_id: string; user_message_id: string; assistant_message_id: string
  retry_of_generation_id: string | null; state: GenerationState; provider: string; model: string | null
  prompt_version: string; created_at: string; started_at: string | null; finished_at: string | null
  last_event_id: string | null; error: SafeError | null; finish_reason: FinishReason
}
export interface StoredSession {
  pet_id?: string | null
  id: string; companion_id: string; title: string; created_at: string; updated_at: string
  last_message_at: string | null; last_activity_at: string; version: number
  active_generation: ChatGeneration | null
}
export interface PageResult<T> { items: T[]; next_cursor: string | null; has_more: boolean }
export interface GenerationAccepted {
  generation: ChatGeneration; user_message: StoredMessage; assistant_message: StoredMessage
  events_url: string; idempotent_replay: boolean
}
export interface GenerationSnapshot {
  generation: ChatGeneration; assistant_message: StoredMessage; resume_after_event_id: string | null
}
export interface ChatPreferences { recent_topic_enabled: boolean; version: number; consented_at: string | null }
export interface StoredRecentTopic {
  conversation_id: string; title: string; summary: string; last_message_at: string; follow_up_text: string
  dismissed: boolean; source: 'message-excerpt'; source_message_ids: string[]; summary_version: string
}
export function isTerminal(state: GenerationState) {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}
