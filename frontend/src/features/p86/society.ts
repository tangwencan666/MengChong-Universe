export type SocialAction = 'pet' | 'comfort' | 'chicken' | 'fish' | 'toy' | 'blanket' | 'mediate' | 'support'
export interface SocialPet { id: string; species: string; mood: string; needs: { energy: number; hunger: number; boredom: number; social: number }; current_event: string | null; partners: string[] }
export interface SharedEvent { id: string; kind: string; participants: string[]; started_at: number; ended_at: number | null; outcome: string; user_actions: { action: string; pet: string; at: number }[] }
export interface SocialSettings { enabled: boolean; conflicts: boolean; bubbles: boolean; muted: boolean; frequency: 'normal' | 'rare'; quiet_until: number }
export interface SocialState {
  owner_id: string; at: number; revision: number; settings: SocialSettings; pets: SocialPet[]
  relations: { pets: string[]; affinity: number; trust: number; familiarity: number; competition: number; alliance_until: number; friend: boolean }[]
  events: SharedEvent[]; ledger: { request: string; pet: string; action: SocialAction; consumed: number; source: 'local_free'; at: number }[]
}
export interface SocietyEnvelope { owner_id: string | null; available: boolean; error: string | null; state: SocialState | null }
export const moodNames: Record<string, string> = { happy: '开心', calm: '平静', curious: '好奇', angry: '有点生气', upset: '有点委屈', sad: '难过', shy: '害羞', sleepy: '困倦' }
export const eventNames: Record<string, string> = { greeting: '打招呼', play: '一起玩耍', cooperate: '小队合作', conflict: '玩具小争执', reconcile: '自然和解', rest: '休息', wander: '散步', observe: '观察', pet: '抚摸', comfort: '安慰', feed: '免费点心', toy: '免费玩具', blanket: '免费毯子', mediate: '用户调解', support: '用户支持' }
export const actionNames: Record<SocialAction, string> = { pet: '轻轻抚摸', comfort: '免费安慰', chicken: '免费鸡腿', fish: '免费小鱼干', toy: '免费玩具', blanket: '免费小毯子', mediate: '调解当前事件', support: '支持这只宠物' }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function acceptSociety(value: SocietyEnvelope, owner: string) {
  const s = value?.state
  if (!uuid.test(owner) || value.owner_id !== owner || typeof value.available !== 'boolean' || (s && s.owner_id !== owner)
    || (value.available && (!s || s.owner_id !== owner || !Number.isSafeInteger(s.revision) || s.revision < 1
      || !Array.isArray(s.pets) || s.pets.length > 256 || !s.pets.every(p => uuid.test(p.id) && !!moodNames[p.mood] && Object.values(p.needs).every(n => Number.isFinite(n) && n >= 0 && n <= 100))
      || !Array.isArray(s.events) || s.events.length > 200 || !s.events.every(e => uuid.test(e.id) && e.participants.every(id => s.pets.some(p => p.id === id)))
      || !Array.isArray(s.relations) || s.relations.length > 512 || !Array.isArray(s.ledger) || s.ledger.length > 512))) throw new Error('桌面事件与当前账号不匹配。')
  return value
}
export function participantEvents(state: SocialState, owner: string, pet: string) {
  if (owner !== state.owner_id || !state.pets.some(p => p.id === pet)) throw new Error('无法访问此宠物的共同事件。')
  return state.events.filter(event => event.participants.includes(pet))
}
