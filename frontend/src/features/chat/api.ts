import { assertPetId, assertScope } from '../pets/scope'
import { api, apiBase } from '../../lib/api'
import type { ChatPreferences, GenerationAccepted, GenerationSnapshot, ChatGeneration, PageResult,
  StoredMessage, StoredRecentTopic, StoredSession } from './api-types'
import { validatePreferences, validateRecentTopic } from './topic-validation'
import { validateChatRuntime } from './provider-presentation'

function page<T>(data: PageResult<T>): PageResult<T> {
  if (!data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean'
    || !(data.next_cursor === null || typeof data.next_cursor === 'string')
    || (data.has_more && !data.next_cursor)) throw new Error('聊天服务尚未返回 P3 契约规定的分页数据。')
  return data
}
function session(data: StoredSession): StoredSession {
  if (!data || typeof data.id !== 'string' || typeof data.title !== 'string'
    || !Number.isSafeInteger(data.version) || !('active_generation' in data)) {
    throw new Error('聊天服务返回的会话不符合 P3 契约。')
  }
  return data
}
export function createChatApi(petId?: string) {
const base = petId ? `/api/v1/pets/${assertPetId(petId)}` : '/api/v1/companion'
const sessionPath = (id: string) => `${base}/sessions/${encodeURIComponent(id)}`
const generationPath = (id: string, generationId: string) => `${sessionPath(id)}/generations/${encodeURIComponent(generationId)}`

const checkSession = (value: StoredSession) => { assertScope(value, petId); if (value.active_generation) assertScope(value.active_generation, petId); return session(value) }
const checkAccepted = (value: GenerationAccepted) => { [value.generation, value.user_message, value.assistant_message].forEach((item) => assertScope(item, petId)); return value }
return {
  async runtime(signal: AbortSignal) {
    return validateChatRuntime((await api.get(`${base}/runtime`, { signal })).data)
  },
  async createSession(key: string, signal: AbortSignal) {
    const { data } = await api.post<{ session: StoredSession; idempotent_replay: boolean }>(`${base}/sessions`,
      { title: '新的聊天', ...(!petId ? { companion_id: null } : {}) }, { signal, headers: { 'Idempotency-Key': key } })
    checkSession(data.session)
    return data
  },
  async sessions(cursor: string | undefined, signal: AbortSignal) {
    const { data } = await api.get<PageResult<StoredSession>>(`${base}/sessions`, { signal, params: { limit: 30, cursor } })
    page(data).items.forEach(checkSession)
    return data
  },
  async session(id: string, signal: AbortSignal) {
    return checkSession((await api.get<StoredSession>(sessionPath(id), { signal })).data)
  },
  async rename(id: string, title: string, version: number, signal: AbortSignal) {
    return checkSession((await api.patch<StoredSession>(sessionPath(id), { title, expected_version: version }, { signal })).data)
  },
  async remove(id: string, signal: AbortSignal) { await api.delete(sessionPath(id), { signal }) },
  async messages(id: string, cursor: string | undefined, signal: AbortSignal) {
    const { data } = await api.get<PageResult<StoredMessage>>(`${sessionPath(id)}/messages`, { signal, params: { limit: 50, cursor } })
    page(data).items.forEach((item) => assertScope(item, petId))
    return data
  },
  async send(id: string, content: string, clientId: string, key: string, signal: AbortSignal) {
    return checkAccepted((await api.post<GenerationAccepted>(`${sessionPath(id)}/messages`,
      { content, client_message_id: clientId }, { signal, headers: { 'Idempotency-Key': key } })).data)
  },
  async retry(id: string, previous: string, key: string, signal: AbortSignal) {
    return checkAccepted((await api.post<GenerationAccepted>(`${sessionPath(id)}/generations`,
      { retry_of_generation_id: previous }, { signal, headers: { 'Idempotency-Key': key } })).data)
  },
  async snapshot(id: string, generationId: string, signal: AbortSignal) {
    const value = (await api.get<GenerationSnapshot>(generationPath(id, generationId), { signal })).data
    assertScope(value.generation, petId); assertScope(value.assistant_message, petId)
    return value
  },
  eventsUrl(id: string, generationId: string) {
    // Construct the contracted same-site path instead of trusting an arbitrary returned URL.
    return `${apiBase}${generationPath(id, generationId)}/events`
  },
  async cancel(id: string, generationId: string, signal: AbortSignal) {
    const value = (await api.post<{ generation: ChatGeneration }>(`${generationPath(id, generationId)}/cancel`, {}, { signal })).data
    assertScope(value.generation, petId); return value
  },
  async preferences(signal: AbortSignal) {
    if (petId) throw new Error('宠物最近话题功能尚未开放；不会读取旧版账户话题。')
    return validatePreferences((await api.get<ChatPreferences>(`${base}/preferences`, { signal })).data)
  },
  async setPreferences(enabled: boolean, version: number, signal: AbortSignal) {
    if (petId) throw new Error('宠物最近话题功能尚未开放；不会读取旧版账户话题。')
    const data = validatePreferences((await api.patch<ChatPreferences>(`${base}/preferences`,
      { recent_topic_enabled: enabled, expected_version: version }, { signal })).data)
    if (data.recent_topic_enabled !== enabled) throw new Error('授权设置响应与本次操作不一致，保存结果尚未确认。')
    return data
  },
  async recentTopic(signal: AbortSignal) {
    if (petId) throw new Error('宠物最近话题功能尚未开放；不会读取旧版账户话题。')
    const data = (await api.get<{ item: StoredRecentTopic | null }>(`${base}/recent-topic`, { signal })).data
    return validateRecentTopic(data?.item)
  },
  async dismiss(id: string, version: string, signal: AbortSignal) {
    if (petId) throw new Error('宠物最近话题功能尚未开放；不会读取旧版账户话题。')
    await api.post(`${sessionPath(id)}/topic-dismissals`, { summary_version: version }, { signal })
  },
}

}
export const chatApi = createChatApi()
