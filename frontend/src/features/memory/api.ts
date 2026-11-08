import { assertPetId, assertScope } from '../pets/scope'
import { api } from '../../lib/api'
import { memoryId, validateMemoryChanges, validateMemoryExport, validateMemoryItem, validateMemoryPage,
  validateMemoryPreferences, validateMemoryPreview, validateMemoryReferences } from './contracts'

export function createMemoryApi(petId?: string) {
const base = petId ? `/api/v1/pets/${assertPetId(petId)}/memory` : '/api/v1/memory'
const scoped = (value: unknown): unknown => {
  assertScope(value, petId)
  const items = (value as { items?: unknown }).items
  if (Array.isArray(items)) for (const item of items) {
    if (item && typeof item === 'object' && 'id' in item) assertScope(item, petId)
  }
  return value
}
const path = (id: string) => { memoryId(id); return `${base}/items/${encodeURIComponent(id)}` }
const options = (signal: AbortSignal, key?: string) => ({ signal, ...(key ? { headers: { 'Idempotency-Key': key } } : {}) })

return {
  async preferences(signal: AbortSignal) { return validateMemoryPreferences(scoped((await api.get(`${base}/preferences`, { signal })).data)) },
  async list(revision: string, cursor: string | undefined, signal: AbortSignal) {
    return validateMemoryPage(scoped((await api.get(`${base}/items`, { signal, params: { limit: 100, snapshot_revision: revision, cursor } })).data))
  },
  async changes(cursor: string, signal: AbortSignal) { return validateMemoryChanges(scoped((await api.get(`${base}/changes`, { signal, params: { cursor, limit: 200 } })).data)) },
  async detail(id: string, signal: AbortSignal) { return validateMemoryItem(scoped((await api.get(path(id), { signal })).data)) },
  async setPreferences(payload: unknown, key: string, signal: AbortSignal) {
    return validateMemoryPreferences(scoped((await api.patch(`${base}/preferences`, payload, options(signal, key))).data))
  },
  async create(payload: unknown, key: string, signal: AbortSignal) {
    const result = (await api.post(`${base}/items`, payload, options(signal, key))).data as { item?: unknown; idempotent_replay?: unknown }
    if (typeof result?.idempotent_replay !== 'boolean') throw new Error('保存结果尚未确认，请重新读取。')
    return validateMemoryItem(scoped(result.item))
  },
  async edit(id: string, payload: unknown, key: string, signal: AbortSignal) {
    return validateMemoryItem(scoped((await api.patch(path(id), payload, options(signal, key))).data))
  },
  async remove(id: string, payload: unknown, key: string, signal: AbortSignal) {
    await api.delete(path(id), { ...options(signal, key), data: payload })
  },
  async revoke(id: string, payload: unknown, key: string, signal: AbortSignal) {
    const value = (await api.post(`${path(id)}/revocations`, payload, options(signal, key))).data as { id?: unknown; status?: unknown }
    scoped(value)
    if (value.id !== id || value.status !== 'revoked') throw new Error('撤销结果与当前记忆不匹配，请重新读取。')
  },
  async clear(payload: unknown, key: string, signal: AbortSignal) { await api.post(`${base}/clear`, payload, options(signal, key)) },
  async export(signal: AbortSignal) {
    return validateMemoryExport(scoped((await api.post(`${base}/export`, { format: 'json', include_inactive: true }, options(signal))).data))
  },
  async preview(sessionId: string, messageIds: string[], preferencesVersion: number, signal: AbortSignal) {
    memoryId(sessionId); messageIds.forEach(memoryId)
    if (messageIds.length < 1 || messageIds.length > 5 || new Set(messageIds).size !== messageIds.length) throw new Error('请选择1–5条不同的本人消息。')
    return validateMemoryPreview(scoped((await api.post(`${base}/previews`, {
      session_id: sessionId, message_ids: messageIds, expected_preferences_version: preferencesVersion,
      consent: { confirmed: true, notice_version: 'memory-preview/1' },
    }, options(signal))).data))
  },
  async generationRefs(sessionId: string, generationId: string, signal: AbortSignal) {
    memoryId(sessionId); memoryId(generationId)
    return validateMemoryReferences(scoped((await api.get(`${petId ? `/api/v1/pets/${petId}` : '/api/v1/companion'}/sessions/${encodeURIComponent(sessionId)}/generations/${encodeURIComponent(generationId)}/memory-refs`, { signal })).data))
  },
}

}
export const memoryApi = createMemoryApi()
