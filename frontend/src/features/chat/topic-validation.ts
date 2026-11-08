import type { ChatPreferences, StoredRecentTopic } from './api-types.ts'

function valid(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))

/** Consent must be a real boolean: malformed responses never enable private recommendations. */
export function validatePreferences(data: ChatPreferences): ChatPreferences {
  valid(data && typeof data.recent_topic_enabled === 'boolean' && Number.isSafeInteger(data.version)
    && data.version >= 0 && (data.consented_at === null || timestamp(data.consented_at)),
  '话题授权数据不符合 P3 契约，未启用推荐。')
  return data
}
export function validateRecentTopic(item: StoredRecentTopic | null): StoredRecentTopic | null {
  if (item === null) return null
  valid(item && typeof item.conversation_id === 'string' && item.conversation_id.length > 0
    && typeof item.title === 'string' && typeof item.summary === 'string' && timestamp(item.last_message_at)
    && typeof item.follow_up_text === 'string' && item.source === 'message-excerpt' && item.dismissed === false
    && Array.isArray(item.source_message_ids) && item.source_message_ids.length === 2
    && item.source_message_ids.every((id) => typeof id === 'string' && id.length > 0)
    && typeof item.summary_version === 'string' && item.summary_version.length > 0,
  '话题摘录数据不符合 P3 契约，已停止展示。')
  return item
}
