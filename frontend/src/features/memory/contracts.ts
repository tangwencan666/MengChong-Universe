import type { MemoryCandidate, MemoryChanges, MemoryContent, MemoryExport, MemoryItem, MemoryPage,
  MemoryPreferences, MemoryPreview, MemoryReferences, MemorySource } from './types.ts'

export const MEMORY_CONSENT = { confirmed: true, policy_version: 'memory-policy/1', notice_version: 'memory-notice/1' } as const
export const categories = ['career_goal', 'communication_preference', 'experience', 'open_topic', 'explicit_note'] as const
export class MemoryProtocolError extends Error {
  constructor() { super('记忆服务返回了无法确认的数据，请重新读取。') }
}
function valid(condition: unknown): asserts condition { if (!condition) throw new MemoryProtocolError() }
function object(value: unknown): asserts value is Record<string, unknown> { valid(!!value && typeof value === 'object' && !Array.isArray(value)) }
function text(value: unknown): asserts value is string { valid(typeof value === 'string') }
export function memoryId(value: unknown): asserts value is string {
  valid(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
}
function version(value: unknown) { valid(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647) }
export function decimal(value: unknown): asserts value is string {
  valid(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n)
}
function time(value: unknown) { valid(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) }
function optionalTime(value: unknown) { if (value !== null) time(value) }
function keys(value: Record<string, unknown>, names: string[]) { valid(Object.keys(value).every((key) => names.includes(key))) }
function category(value: unknown) { valid(categories.includes(value as typeof categories[number])) }
function source(value: unknown) {
  object(value)
  valid(['manual', 'chat_message', 'legacy_unverified'].includes(String(value.kind)))
  valid(['available', 'source_deleted', 'legacy_unverified'].includes(String(value.availability)))
  if (value.session_id !== null) memoryId(value.session_id)
  if (value.message_id !== null) memoryId(value.message_id)
  if (value.kind === 'manual') valid(value.session_id === null && value.message_id === null)
  if (value.kind === 'chat_message') { memoryId(value.session_id); memoryId(value.message_id) }
}
export function validateMemoryPreferences(value: unknown): MemoryPreferences {
  object(value); valid(typeof value.long_term_memory_enabled === 'boolean'); version(value.version)
  decimal(value.privacy_epoch); decimal(value.context_epoch_floor); decimal(value.revision)
  valid(BigInt(value.context_epoch_floor) <= BigInt(value.privacy_epoch))
  optionalTime(value.context_not_before); text(value.sync_cursor); valid(value.sync_cursor.length > 0 && value.sync_cursor.length <= 1024)
  valid(value.policy_version === 'memory-policy/1' && value.notice_version === 'memory-notice/1')
  return value as unknown as MemoryPreferences
}
export function validateMemoryItem(value: unknown): MemoryItem {
  object(value); memoryId(value.id); version(value.version); valid(Number(value.version) >= 1)
  for (const name of ['title', 'content', 'summary']) text(value[name])
  valid(['active', 'revoked', 'expired', 'legacy_unconfirmed'].includes(String(value.status)))
  if (value.category !== null) category(value.category)
  decimal(value.revision); time(value.created_at); time(value.updated_at)
  optionalTime(value.expires_at); optionalTime(value.last_confirmed_at)
  valid(Array.isArray(value.sources) && value.sources.length <= 5); value.sources.forEach(source)
  if (value.consent_ref !== null) {
    object(value.consent_ref); memoryId(value.consent_ref.id); time(value.consent_ref.occurred_at)
    text(value.consent_ref.policy_version); text(value.consent_ref.notice_version)
  }
  if (value.status === 'active') valid(value.category !== null && value.expires_at !== null && value.consent_ref !== null && value.sources.length > 0)
  return value as unknown as MemoryItem
}
export function validateMemoryPage(value: unknown): MemoryPage {
  object(value); decimal(value.snapshot_revision)
  valid(Array.isArray(value.items) && value.items.length <= 100); value.items.forEach(validateMemoryItem)
  valid(typeof value.has_more === 'boolean' && (value.next_cursor === null || typeof value.next_cursor === 'string'))
  valid(!value.has_more || !!value.next_cursor)
  return value as unknown as MemoryPage
}
export function validateMemoryPreview(value: unknown): MemoryPreview {
  object(value); valid(value.persisted === false && value.extractor_version === 'local-excerpt/1')
  text(value.preview_token); valid(value.preview_token.length > 0 && value.preview_token.length <= 2048); time(value.expires_at)
  valid(Array.isArray(value.candidates) && value.candidates.length <= 3)
  for (const candidate of value.candidates) {
    object(candidate); memoryId(candidate.candidate_id); category(candidate.category)
    for (const name of ['title', 'content', 'summary']) text(candidate[name])
    valid(Array.isArray(candidate.source_refs) && candidate.source_refs.length >= 1 && candidate.source_refs.length <= 5)
    candidate.source_refs.forEach(source); valid(candidate.source_refs.every((item: MemorySource) => item.kind === 'chat_message' && item.availability === 'available'))
    time(candidate.suggested_expires_at)
  }
  return value as unknown as MemoryPreview
}
export function validateMemoryChanges(value: unknown): MemoryChanges {
  object(value); decimal(value.high_watermark); text(value.next_cursor)
  valid(typeof value.has_more === 'boolean' && typeof value.reset_required === 'boolean' && Array.isArray(value.items) && value.items.length <= 200)
  for (const item of value.items) {
    object(item); decimal(item.revision); text(item.action); time(item.occurred_at); valid(typeof item.affected_all === 'boolean')
    if (item.memory_id !== null) memoryId(item.memory_id)
    if (item.memory_version !== null) version(item.memory_version)
  }
  return value as unknown as MemoryChanges
}
export function validateMemoryExport(value: unknown): MemoryExport {
  object(value); valid(value.schema_version === (value.pet_id ? 'pet-memory/1' : 'p4-memory/1.0-draft')); time(value.exported_at); decimal(value.snapshot_revision)
  keys(value, ['pet_id', 'schema_version', 'exported_at', 'snapshot_revision', 'items'])
  valid(Array.isArray(value.items) && value.items.length <= 200); value.items.forEach(validateMemoryItem)
  for (const item of value.items) {
    keys(item, ['pet_id', 'id', 'title', 'content', 'summary', 'category', 'status', 'version', 'created_at', 'updated_at', 'last_confirmed_at', 'expires_at', 'revision', 'sources', 'consent_ref'])
    for (const ref of item.sources) keys(ref, ['kind', 'session_id', 'message_id', 'availability', 'source_message_version'])
    if (item.consent_ref) keys(item.consent_ref, ['id', 'policy_version', 'notice_version', 'occurred_at'])
  }
  valid(new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2 * 1024 * 1024)
  return value as unknown as MemoryExport
}
export function validateMemoryReferences(value: unknown): MemoryReferences {
  object(value); decimal(value.privacy_epoch); valid(Array.isArray(value.items) && value.items.length <= 5)
  for (const item of value.items) {
    object(item); memoryId(item.memory_id); version(item.memory_version)
    valid(item.availability === 'available' || item.availability === 'unavailable')
  }
  return value as unknown as MemoryReferences
}
export function normalizeMemoryContent(value: MemoryContent, now = Date.now()): MemoryContent {
  const title = value.title.replace(/\r\n?/g, '\n').trim(), content = value.content.replace(/\r\n?/g, '\n').trim()
  if (![...title].length || [...title].length > 80 || ![...content].length || [...content].length > 1000) {
    throw new Error('标题需要1–80个字符，记忆内容需要1–1000个字符。')
  }
  category(value.category)
  if (value.expires_at) {
    const at = Date.parse(value.expires_at)
    if (!Number.isFinite(at) || at <= now || at > now + 365 * 86400_000) throw new Error('请选择未来一年内的有效期。')
  }
  return { title, content, category: value.category, ...(value.expires_at ? { expires_at: value.expires_at } : {}) }
}

export interface SnapshotPort {
  preferences(signal: AbortSignal): Promise<MemoryPreferences>
  list(revision: string, cursor: string | undefined, signal: AbortSignal): Promise<MemoryPage>
  changes(cursor: string, signal: AbortSignal): Promise<MemoryChanges>
}
export class MemorySnapshotChanged extends Error {
  constructor() { super('记忆状态已更新，请重新读取后再确认。') }
}
export async function loadMemorySnapshot(port: SnapshotPort, signal: AbortSignal, first?: MemoryPreferences) {
  const preferences = first ?? await port.preferences(signal)
  const items: MemoryItem[] = [], seen = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await port.list(preferences.revision, cursor, signal)
    if (page.snapshot_revision !== preferences.revision) throw new MemorySnapshotChanged()
    for (const item of page.items) {
      if (seen.has(item.id) || item.revision !== preferences.revision) throw new MemoryProtocolError()
      seen.add(item.id); items.push(item)
    }
    if (items.length > 200) throw new MemoryProtocolError()
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined
    if (cursor && cursors.has(cursor)) throw new MemoryProtocolError()
    if (cursor) cursors.add(cursor)
    if (cursors.size > 3) throw new MemoryProtocolError()
  } while (cursor)
  const changes = await port.changes(preferences.sync_cursor, signal)
  if (changes.reset_required || changes.has_more || changes.items.length || changes.high_watermark !== preferences.revision) throw new MemorySnapshotChanged()
  return { preferences, items }
}

export function candidateSelection(preview: MemoryPreview, candidate: MemoryCandidate) {
  if (!preview.candidates.includes(candidate) || Date.parse(preview.expires_at) <= Date.now()) {
    throw new Error('预览已失效，请重新选择消息。')
  }
  const refs = candidate.source_refs
  if (!refs.length || refs.some((ref) => ref.kind !== 'chat_message' || ref.availability !== 'available' || ref.session_id !== refs[0].session_id)) throw new MemoryProtocolError()
  const sessionId = refs[0].session_id
  memoryId(sessionId)
  const messageIds = refs.map((ref) => { memoryId(ref.message_id); return ref.message_id })
  if (new Set(messageIds).size !== messageIds.length) throw new MemoryProtocolError()
  return { sessionId, messageIds }
}

/** Retry an uncertain write using its exact original payload/key, only in this in-memory auth scope. */
export class MemoryIntentKeys {
  private readonly intents = new Map<string, { key: string; payload: unknown }>()
  peek(identity: string) { return this.intents.get(identity) }
  obtain<T>(identity: string, payload: T): { key: string; payload: T } {
    const old = this.intents.get(identity)
    if (old) return old as { key: string; payload: T }
    if (this.intents.size >= 30) throw new Error('有较多未确认操作，请重新登录并核对状态后继续。')
    const intent = { key: crypto.randomUUID(), payload: structuredClone(payload) }
    this.intents.set(identity, intent)
    return intent
  }
  complete(identity: string) { this.intents.delete(identity) }
  clear() { this.intents.clear() }
}
