import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button, Card, ErrorState, FormField } from '../../components/ui'
import { useAuth } from '../auth/context'
import { petDefinitions } from '../p84/catalog'
import { errorMessage } from '../../lib/api'
import { adoption, adoptionIntent } from './instances'
import type { AdoptionIntent, PetInstance } from './instances'
import { instancesApi } from './api'
import { AppearancePreview } from './AppearancePreview'

export function AdoptionPanel({ onAdopt }: { onAdopt?: (pet: PetInstance) => void }) {
  const { user } = useAuth()
  const [names, setNames] = useState<Record<string, string>>({})
  const [naming, setNaming] = useState(false)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [latest, setLatest] = useState<PetInstance | null>(null)
  const pending = useRef<AbortController | null>(null), intent = useRef<AdoptionIntent | null>(null), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort() } }, [])
  async function adopt(species: string) {
    if (!user || pending.current) return
    const operation = new AbortController(); pending.current = operation; setBusy(species); setError('')
    try {
      const payload = adoption(species, names[species] ?? '')
      intent.current = adoptionIntent(intent.current, payload)
      const pet = await instancesApi.adopt(user.id, payload, intent.current.key, operation.signal)
      if (!alive.current || operation.signal.aborted) return
      intent.current = null // The next deliberate adoption creates a new instance/key.
      setLatest(pet); onAdopt?.(pet)
    } catch (cause) { if (alive.current && !operation.signal.aborted) setError(errorMessage(cause)) }
    finally { if (alive.current) { pending.current = null; setBusy('') } }
  }
  return <section className="p85-adoption" aria-label="领养宠物">
    <h2>领养新的伙伴</h2><p>当前可选 {petDefinitions.length} 种角色。同一种可领养多只，名字也可以相同；每次成功领养都有独立身份、人格快照、聊天和记忆。拥有数量不受桌面五只上限限制。</p>
    <Button variant="ghost" onClick={() => { if (naming) setNames({}); setNaming(!naming) }}>{naming ? '清空取名并收起' : '自定义领养名字'}</Button>
    {naming && <p className="memory-fine-print">取名区展开时会保留后台窗口，保护尚未领养的名字；收起会清空取名输入，已领养宠物不受影响。</p>}
    {error && <ErrorState message={error} />}
    {latest && <p role="status">已领养 {latest.name} · 实例 {latest.pet_instance_id.slice(0, 8)}。<Link to={`/pets/${latest.pet_instance_id}`}>打开这只宠物的聊天</Link> · 可以继续领养同一种。</p>}
    <div className="p84-catalog-grid">{petDefinitions.map(definition => <Card key={definition.id}>
      <AppearancePreview species={definition.id} name={definition.name} />
      <h3>{definition.name}</h3><p>{definition.greeting}</p><p className="muted">{definition.persona}</p>
      {naming && <FormField label={`给${definition.name}取名`} value={names[definition.id] ?? ''} placeholder={definition.name} maxLength={60} onChange={event => setNames(previous => ({ ...previous, [definition.id]: event.target.value }))} />}
      <Button disabled={!!busy} onClick={() => void adopt(definition.id)}>{busy === definition.id ? '正在领养…' : `领养${definition.name}`}</Button>
    </Card>)}</div>
  </section>
}
