import { Check, Plus } from 'lucide-react'
import type { DesktopPet } from '../desktop/bridge'
import type { PetInstance } from '../p85/instances'
import { PetPortrait } from '../p862/PetPortrait'

export function DesktopChooser({ pets, desktop, busy, limit, choose }: {
  pets: PetInstance[]; desktop: DesktopPet[]; busy: boolean; limit: number; choose: (id: string) => void
}) {
  return <div className="p863-chooser" aria-label="直接选择桌面伙伴">{pets.map(pet => {
    const current = desktop.find(value => value.pet_id === pet.pet_instance_id), selected = Boolean(current && !current.hidden)
    return <button type="button" className={`p863-choice ${selected ? 'is-selected' : ''}`} key={pet.pet_instance_id}
      data-instance-id={pet.pet_instance_id} aria-pressed={selected} disabled={busy}
      aria-label={`${selected ? '收回' : '召唤'}${pet.name} · ${pet.pet_instance_id.slice(0, 8)}`} onClick={() => choose(pet.pet_instance_id)}>
      <span className="p863-selection-mark" aria-hidden="true">{selected ? <Check size={16} /> : <Plus size={16} />}</span>
      <PetPortrait key={pet.appearance_id} species={pet.species_id} appearance={pet.appearance_id} name={pet.name} />
      <strong>{pet.name}</strong><span className={selected ? 'p862-on-desktop' : 'p863-in-list'}>{selected ? '在桌面 · 点击收回' : current?.hidden ? '已隐藏 · 点击显示' : '在列表 · 点击召唤'}</span>
      <small>实例 {pet.pet_instance_id.slice(0, 8)}{!selected && desktop.filter(p => !p.hidden).length >= limit ? ' · 桌面已满' : ''}</small>
    </button>
  })}</div>
}
