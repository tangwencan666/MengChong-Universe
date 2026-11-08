import type { DesktopPet } from '../desktop/bridge'

export function desktopChoice(id: string, pets: readonly DesktopPet[], limit = 5) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('宠物身份无效。')
  const current = pets.find(pet => pet.pet_id === id)
  if (current && !current.hidden) return 'recall'
  const maximum = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5) : 5
  if (pets.filter(pet => !pet.hidden).length >= maximum) return 'limit'
  return current ? 'show' : 'release'
}
