import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { useAuth } from '../auth/context'
import { api } from '../../lib/api'

export function BetaUsage() {
  const { user, scopeVersion } = useAuth()
  const ownerId = user?.id
  const { pathname } = useLocation()
  useEffect(() => {
    if (!ownerId || !pathname.startsWith('/pets/')) return
    const controller = new AbortController()
    let allowed = false, sentDay = '', checking = false
    const refresh = () => {
      if (document.hidden || controller.signal.aborted || checking) return
      checking = true
      void api.get<{ available: boolean; enabled: boolean }>('/api/v1/beta/privacy', { signal: controller.signal })
        .then(({ data }) => { allowed = data.available && data.enabled }).catch(() => { allowed = false })
        .finally(() => { checking = false })
    }
    refresh()
    const active = (event: Event) => {
      const today = new Date().toISOString().slice(0, 10)
      if (!event.isTrusted || !allowed || controller.signal.aborted || document.hidden || sentDay === today) return
      sentDay = today
      void api.post('/api/v1/beta/privacy/events', { kind: 'active' }, { signal: controller.signal }).catch(() => {})
    }
    window.addEventListener('pointerdown', active, { passive: true })
    window.addEventListener('keydown', active, { passive: true })
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.abort(); window.removeEventListener('pointerdown', active); window.removeEventListener('keydown', active)
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh)
    }
  }, [ownerId, scopeVersion, pathname])
  return null
}
