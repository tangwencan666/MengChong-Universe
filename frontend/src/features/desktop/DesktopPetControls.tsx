import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui'
import { useAuth } from '../auth/context'
import { desktopBridge } from './bridge'
import type { DesktopPet } from './bridge'

export function DesktopPetControls({ petId }: { petId: string }) {
  const bridge = desktopBridge()
  const { user } = useAuth()
  const ownerId = user?.id
  const [snapshot, setSnapshot] = useState<{ ownerId?: string; pets: DesktopPet[] }>({ pets: [] })
  const [operation, setOperation] = useState<{ ownerId?: string; busy: boolean; error: string }>({ busy: false, error: '' })
  const generation = useRef(0)
  useEffect(() => {
    const ownGeneration = ++generation.current
    let active = true
    if (!bridge) return () => { active = false; generation.current += 1 }
    let revision = 0
    const unsubscribe = bridge.onChange((state) => {
      revision += 1
      if (active) setSnapshot({ ownerId, pets: state.authenticated && state.owner_id === ownerId ? state.pets : [] })
    })
    void bridge.list().then((next) => {
      if (active && generation.current === ownGeneration && revision === 0) setSnapshot({ ownerId, pets: next })
    }).catch(() => { if (active) setOperation({ ownerId, busy: false, error: '暂时无法读取桌面状态，可以稍后重试。' }) })
    return () => { active = false; generation.current += 1; unsubscribe() }
  }, [bridge, ownerId])
  if (!bridge) return null
  const pets = snapshot.ownerId === ownerId ? snapshot.pets : []
  const busy = operation.ownerId === ownerId && operation.busy
  const error = operation.ownerId === ownerId ? operation.error : ''
  const current = pets.find((pet) => pet.pet_id === petId)
  async function action(send: () => Promise<unknown>) {
    if (busy) return
    const ownGeneration = generation.current
    setOperation({ ownerId, busy: true, error: '' })
    try { await send() }
    catch { if (generation.current === ownGeneration) setOperation({ ownerId, busy: false, error: '暂时无法完成桌面操作。请确认已登录，且桌面上不超过三只宠物。' }); return }
    if (generation.current === ownGeneration) setOperation({ ownerId, busy: false, error: '' })
  }
  return <div className="desktop-pet-controls">
    <div className="pet-actions" aria-label="桌面宠物操作">
      {!current ? <Button disabled={busy} onClick={() => void action(() => bridge.release(petId))}>放到桌面</Button> : <>
        <Button disabled={busy} variant="ghost" onClick={() => void action(() => current.hidden ? bridge.show(petId) : bridge.hide(petId))}>{current.hidden ? '显示桌宠' : '隐藏桌宠'}</Button>
        <Button disabled={busy} variant="ghost" onClick={() => void action(() => bridge.recall(petId))}>收回桌宠</Button>
      </>}
    </div>
    {error && <p className="memory-fine-print" role="alert">{error}</p>}
  </div>
}
