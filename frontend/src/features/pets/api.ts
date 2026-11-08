import { api } from '../../lib/api'
import { assertPetId } from './scope'

export interface PetConfig {
  name: string
  role_type: 'cat' | 'dog' | 'custom'
  persona_config: { description: string; tone: 'warm' | 'playful' | 'calm' }
  appearance_config: { asset_id: string; tint: string; scale: number }
}
export interface Pet extends PetConfig {
  pet_id: string; status: 'active' | 'hidden' | 'archived'; version: number
  created_at: string; updated_at: string
}
function pet(value: Pet, expected?: string) {
  assertPetId(value?.pet_id)
  if ((expected && value.pet_id !== expected) || !value.name || !['active', 'hidden', 'archived'].includes(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1 || !value.persona_config || !value.appearance_config) throw new Error('宠物配置响应无法确认。')
  return value
}
const path = (id: string) => `/api/v1/pets/${assertPetId(id)}`
export const petsApi = {
  async list(status: Pet['status'], cursor: string | undefined, signal: AbortSignal) {
    const { data } = await api.get<{ items: Pet[]; has_more: boolean; next_cursor: string | null }>('/api/v1/pets', { signal, params: { status, limit: 30, cursor } })
    if (!Array.isArray(data?.items) || typeof data.has_more !== 'boolean' || (data.has_more && !data.next_cursor)) throw new Error('宠物列表响应无法确认。')
    data.items.forEach((value) => pet(value)); return data
  },
  async detail(id: string, signal: AbortSignal) { return pet((await api.get<Pet>(path(id), { signal })).data, id) },
  async create(config: PetConfig, key: string, signal: AbortSignal) {
    const { data } = await api.post<Pet>('/api/v1/pets', config, { signal, headers: { 'Idempotency-Key': key } })
    return pet(data)
  },
  async edit(value: Pet, config: PetConfig, signal: AbortSignal) {
    return pet((await api.patch<Pet>(path(value.pet_id), { ...config, expected_version: value.version }, { signal })).data, value.pet_id)
  },
  async visibility(value: Pet, hidden: boolean, signal: AbortSignal) {
    return pet((await api.post<Pet>(`${path(value.pet_id)}/visibility`, { hidden, expected_version: value.version }, { signal })).data, value.pet_id)
  },
  async archive(value: Pet, signal: AbortSignal) {
    return pet((await api.post<Pet>(`${path(value.pet_id)}/archive`, { expected_version: value.version }, { signal })).data, value.pet_id)
  },
}
