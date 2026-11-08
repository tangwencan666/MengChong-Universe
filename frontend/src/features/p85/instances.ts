import { petConfiguration, petDefinitions } from '../p84/catalog.ts'
import { assertPetId } from '../pets/scope.ts'
import type { Pet } from '../pets/api'
import { appearanceFor } from './appearances.ts'

export type SpeciesId = 'moon' | 'doubao' | 'xiaoyun' | 'maodie' | 'hajimi' | 'niwa' | 'daodun' | 'whale'
export interface PetInstance extends Pet {
  species_id: SpeciesId; species_source: 'registered_asset' | 'legacy_role'
  pet_instance_id: string; owner_user_id: string
  appearance_id: string; personality_snapshot: Pet['persona_config']; personality_snapshot_version: number
}
export interface AdoptionPayload { species_id: SpeciesId; name: string }
export interface AdoptionIntent { payload: string; key: string }
export function adoption(species: string, name: string): AdoptionPayload {
  const template = petConfiguration(species)
  const actual = name.trim() || template.name
  if ([...actual].length > 60 || [...actual].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('名字需为 1～60 个字符，不能包含控制字符。')
  return { species_id: species as SpeciesId, name: actual }
}
export function adoptionIntent(previous: AdoptionIntent | null, payload: AdoptionPayload, createKey = () => crypto.randomUUID()): AdoptionIntent {
  const encoded = JSON.stringify(payload)
  return previous?.payload === encoded ? previous : { payload: encoded, key: createKey() }
}
export function instance(value: PetInstance, ownerId: string, expected?: string): PetInstance {
  const id = assertPetId(value?.pet_instance_id)
  if (value.pet_id !== id || (expected && id !== expected) || value.owner_user_id !== assertPetId(ownerId)
    || !petDefinitions.some(definition => definition.id === value.species_id)
    || !['registered_asset', 'legacy_role'].includes(value.species_source)
    || !['active', 'hidden', 'archived'].includes(value.status) || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.name !== 'string' || !value.name.trim() || [...value.name].length > 60
    || !value.persona_config || !value.appearance_config || typeof value.appearance_id !== 'string' || value.personality_snapshot_version !== value.version
    || value.personality_snapshot?.description !== value.persona_config.description || value.personality_snapshot?.tone !== value.persona_config.tone) throw new Error('宠物实例响应与当前账号不匹配。')
  appearanceFor(value.species_id, value.appearance_id)
  return value
}
export const speciesName = (id: string) => petDefinitions.find(value => value.id === id)?.name ?? '旧版伙伴'
export const retentionNotice = {
  instance: '从活跃列表删除并归档，停止生成和桌面显示。按现有规则，归档后不能撤销或继续聊天。',
  chat: '聊天记录保留为只读记录；本操作不删除聊天正文。',
  memory: '长期记忆保留且仍可管理。可在专属记忆页另行关闭授权、撤销、删除或清空；删除记忆正文不可撤销。',
}
