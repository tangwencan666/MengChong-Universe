import document from '../../../../desktop/assets/pet-definitions.json' with { type: 'json' }
import type { PetConfig } from '../pets/api'

export interface PetDefinition {
  id: string; name: string; role_type: PetConfig['role_type']; tone: PetConfig['persona_config']['tone']
  tint: string; persona: string; greeting: string
}
export const petDefinitions: readonly PetDefinition[] = document.pets.map(value => {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value.id) || !['cat', 'dog', 'custom'].includes(value.role_type)
    || !['warm', 'calm', 'playful'].includes(value.tone) || value.persona.length > 600) throw new Error('宠物目录无效。')
  return { ...value, role_type: value.role_type as PetConfig['role_type'], tone: value.tone as PetConfig['persona_config']['tone'] }
})
export function petConfiguration(id: string): PetConfig {
  const definition = petDefinitions.find(value => value.id === id)
  if (!definition) throw new Error('请选择目录中的宠物。')
  return { name: definition.name, role_type: definition.role_type,
    persona_config: { description: definition.persona, tone: definition.tone },
    appearance_config: { asset_id: definition.id, tint: definition.tint, scale: 1 } }
}
