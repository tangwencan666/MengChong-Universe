import document from '../../../../desktop/assets/p85-appearances.json' with { type: 'json' }

export interface AppearanceDefinition {
  appearance_id: string; species_id: string; asset_version: number
  kind: 'local-raster' | 'shipped-svg'; restriction: 'local-verification-only' | 'shipped'
  front_asset: string; side_asset: string | null; back_asset: string | null
  side_facing: string | null; quality_notes: string[]; fallback_asset: string
}
export const appearances: readonly AppearanceDefinition[] = document.appearances.map(value => {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.appearance_id) || !['local-raster', 'shipped-svg'].includes(value.kind)
    || !['local-verification-only', 'shipped'].includes(value.restriction)) throw new Error('外观清单无法确认。')
  return value as AppearanceDefinition
})
export function appearanceFor(species: string, id?: string) {
  const value = id ? appearances.find(item => item.appearance_id === id) : appearances.find(item => item.species_id === species)
  if (!value || value.species_id !== species) throw new Error('外观与宠物种类不匹配。')
  return value
}
export function availableViews(species: string, id?: string) {
  const value = appearanceFor(species, id)
  return [value.front_asset ? '正面' : '', value.side_asset ? '左侧面' : '', value.back_asset ? '背面' : ''].filter(Boolean)
}
