import { useEffect } from 'react'
import { useAuth } from '../auth/context'
import { desktopBridge } from './bridge'

export function DesktopIdentitySync() {
  const { user, loading, scopeVersion, invalidate } = useAuth()
  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge || loading || !user) return
    return bridge.onChange((state) => {
      if (!state.authenticated || state.owner_id !== user.id) {
        // Clear live React caches too, rather than only Chromium disk storage.
        invalidate('桌面账户状态已变化，请重新确认登录。')
      }
    })
  }, [user, loading, invalidate])
  useEffect(() => {
    if (!loading) void desktopBridge()?.syncSession().catch(() => {
      // The native host closes private windows when identity cannot be verified.
      // Identity comes from the server Cookie, never a user id supplied by React.
    })
  }, [user?.id, loading, scopeVersion])
  return null
}
