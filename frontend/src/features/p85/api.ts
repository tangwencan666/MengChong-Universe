import { api } from '../../lib/api'
import { assertPetId } from '../pets/scope'
import { instance } from './instances'
import type { AdoptionPayload, PetInstance } from './instances'

const path = (id: string) => `/api/v1/pet-instances/${assertPetId(id)}`
export const instancesApi = {
  async list(owner: string, status: PetInstance['status'], cursor: string | undefined, signal: AbortSignal) {
    const { data } = await api.get<{ items: PetInstance[]; has_more: boolean; next_cursor: string | null }>('/api/v1/pet-instances', { signal, params: { status, limit: 30, cursor } })
    if (!Array.isArray(data?.items) || typeof data.has_more !== 'boolean' || data.has_more && typeof data.next_cursor !== 'string') throw new Error('实例列表响应无法确认。')
    data.items.forEach(value => instance(value, owner)); return data
  },
  async adopt(owner: string, payload: AdoptionPayload, key: string, signal: AbortSignal) {
    return instance((await api.post<PetInstance>('/api/v1/pet-instances', payload, { signal, headers: { 'Idempotency-Key': key } })).data, owner)
  },
  async edit(owner: string, pet: PetInstance, name: string, persona: PetInstance['persona_config'], signal: AbortSignal) {
    return instance((await api.patch<PetInstance>(path(pet.pet_instance_id), { name, persona_config: persona, expected_version: pet.version }, { signal })).data, owner, pet.pet_instance_id)
  },
  async remove(owner: string, pet: PetInstance, signal: AbortSignal) {
    const { data } = await api.delete<{ instance: PetInstance; lifecycle: { can_undo_archive: boolean } }>(path(pet.pet_instance_id), { signal, data: { expected_version: pet.version, confirmation_instance_id: pet.pet_instance_id, data_handling: 'archive_keep_data' } })
    const value = instance(data.instance, owner, pet.pet_instance_id)
    if (value.status !== 'archived' || data.lifecycle.can_undo_archive !== false) throw new Error('归档结果无法确认，请刷新查看。')
    return value
  },
}
