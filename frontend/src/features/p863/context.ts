export const moodNames = { happy: '开心', calm: '平静', curious: '好奇', angry: '生气', upset: '委屈', sad: '难过', shy: '害羞', sleepy: '困倦' } as const
export type PetMood = keyof typeof moodNames
export interface CompanionContext {
  schema: 'pet-local-context/1'
  owner_id: string
  pet_id: string
  session_id: string | null
  mood: PetMood | null
  source_event_ids: string[]
  story: { event_id: string; text: string; source: 'local-event' } | null
  reason: string
  model_injection: false
  rag: false
}
export interface ContextChange { owner_id: string; pet_id: string; mood: PetMood | null; event_ids: string[] }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const mood = (value: unknown) => value === null || (typeof value === 'string' && Object.hasOwn(moodNames, value))
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every(uuid) && new Set(value).size === value.length
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function readContext(value: unknown, owner: string, pet: string, session: string | null): CompanionContext {
  if (!record(value) || value.schema !== 'pet-local-context/1' || !uuid(owner) || !uuid(pet) || (session !== null && !uuid(session))
    || value.owner_id !== owner || value.pet_id !== pet || value.session_id !== session || !mood(value.mood)
    || !ids(value.source_event_ids) || value.model_injection !== false || value.rag !== false
    || typeof value.reason !== 'string' || !['idle', 'unavailable', 'cooldown', 'shared', 'already-shared', 'no-event'].includes(value.reason)) throw new Error('桌面小记身份无法确认。')
  if (value.story !== null && (!record(value.story) || !uuid(value.story.event_id) || !value.source_event_ids.includes(value.story.event_id)
    || value.story.source !== 'local-event' || typeof value.story.text !== 'string' || !value.story.text.length || value.story.text.length > 512)) throw new Error('桌面小记来源无法确认。')
  return value as unknown as CompanionContext
}

export function readContextChange(value: unknown, owner: string, pet: string): ContextChange | null {
  if (!record(value) || value.owner_id !== owner || value.pet_id !== pet || !mood(value.mood) || !ids(value.event_ids)) return null
  return value as unknown as ContextChange
}
