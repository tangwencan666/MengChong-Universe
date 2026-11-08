import { useEffect, useState } from 'react'
import { desktopBridge } from '../desktop/bridge'
import type { DesktopLayout, DesktopPet } from '../desktop/bridge'

/** One subscription/list per management page, independent of adoption count. */
export function useDesktop(owner: string) {
  const bridge = desktopBridge()
  const [pets, setPets] = useState<DesktopPet[]>([]), [layout, setLayout] = useState<DesktopLayout | null>(null)
  useEffect(() => {
    let alive = true, revision = 0, reading = false, reread = false
    if (!bridge) return
    async function readLayout() {
      if (!bridge?.layout) return
      if (reading) { reread = true; return }
      reading = true
      try { const value = await bridge.layout(); if (alive && value.owner_id === owner) setLayout(value) }
      catch { if (alive) setLayout(null) }
      finally { reading = false; if (alive && reread) { reread = false; void readLayout() } }
    }
    const unsubscribe = bridge.onChange(value => {
      revision++
      if (!alive) return
      setPets(value.authenticated && value.owner_id === owner ? value.pets : [])
      void readLayout()
    })
    void bridge.list().then(value => { if (alive && revision === 0) setPets(value) }).catch(() => { if (alive) setPets([]) })
    void readLayout()
    return () => { alive = false; unsubscribe() }
  }, [bridge, owner])
  return { bridge, pets, layout }
}
