export type MemoryCategory = 'career_goal' | 'communication_preference' | 'experience' | 'open_topic' | 'explicit_note'
export type MemoryStatus = 'active' | 'revoked' | 'expired' | 'legacy_unconfirmed'

export interface MemoryPreferences {
  long_term_memory_enabled: boolean
  version: number
  privacy_epoch: string
  context_epoch_floor: string
  context_not_before: string | null
  revision: string
  sync_cursor: string
  policy_version: 'memory-policy/1'
  notice_version: 'memory-notice/1'
}

export interface MemorySource {
  kind: 'manual' | 'chat_message' | 'legacy_unverified'
  session_id: string | null
  message_id: string | null
  availability: 'available' | 'source_deleted' | 'legacy_unverified'
  source_message_version?: number
}

export interface MemoryContent {
  title: string
  content: string
  category: MemoryCategory
  expires_at?: string
}

export interface MemoryItem {
  id: string
  title: string
  content: string
  summary: string
  category: MemoryCategory | null
  status: MemoryStatus
  version: number
  created_at: string
  updated_at: string
  last_confirmed_at: string | null
  expires_at: string | null
  revision: string
  sources: MemorySource[]
  consent_ref: { id: string; policy_version: string; notice_version: string; occurred_at: string } | null
}

export interface MemoryPage {
  items: MemoryItem[]
  next_cursor: string | null
  has_more: boolean
  snapshot_revision: string
}

export type SourceInput = { kind: 'manual' } | {
  kind: 'chat_message'; session_id: string; message_ids: string[]; preview_token: string
}

export interface MemoryCandidate {
  candidate_id: string
  title: string
  content: string
  summary: string
  category: MemoryCategory
  source_refs: MemorySource[]
  suggested_expires_at: string
}

export interface MemoryPreview {
  candidates: MemoryCandidate[]
  preview_token: string
  expires_at: string
  extractor_version: 'local-excerpt/1'
  persisted: false
}

export interface MemoryChanges {
  items: { revision: string; action: string; memory_id: string | null; memory_version: number | null; affected_all: boolean; occurred_at: string }[]
  next_cursor: string
  has_more: boolean
  high_watermark: string
  reset_required: boolean
}

export interface MemoryExport {
  schema_version: 'p4-memory/1.0-draft' | 'pet-memory/1'
  exported_at: string
  snapshot_revision: string
  items: MemoryItem[]
}

export interface MemoryReferences {
  items: { memory_id: string; memory_version: number; availability: 'available' | 'unavailable' }[]
  privacy_epoch: string
}

export interface MemoryContextValue {
  preferences: MemoryPreferences | null
  items: MemoryItem[]
  loading: boolean
  syncing: boolean
  pending: boolean
  error: string
  notice: string
  unavailable: boolean
  refresh(): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
  create(content: MemoryContent, source?: SourceInput): Promise<MemoryItem>
  edit(item: MemoryItem, content: MemoryContent): Promise<MemoryItem>
  remove(item: MemoryItem): Promise<void>
  revoke(item: MemoryItem): Promise<void>
  clear(): Promise<void>
  exportMemories(): Promise<MemoryExport>
  preview(sessionId: string, messageIds: string[]): Promise<MemoryPreview>
  confirmCandidate(preview: MemoryPreview, candidate: MemoryCandidate, content: MemoryContent): Promise<MemoryItem>
  generationRefs(sessionId: string, generationId: string): Promise<MemoryReferences>
}
