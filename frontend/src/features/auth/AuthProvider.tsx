import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import axios from 'axios'
import { useQueryClient } from '@tanstack/react-query'
import { api, errorMessage, resetAuthTransport } from '../../lib/api'
import { AuthContext } from './context'
import type { AuthUser } from './context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [scopeVersion, setScopeVersion] = useState(0)
  const current = useRef<AuthUser | null>(null)
  const revision = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)
  const queries = useQueryClient()
  const apply = useCallback((next: AuthUser | null) => {
    revision.current += 1
    resetAuthTransport()
    void queries.cancelQueries()
    queries.clear()
    current.current = next
    setUser(next)
    setScopeVersion((value) => value + 1)
    setLoading(false)
  }, [queries])
  const refresh = useCallback(async () => {
    const ownRevision = revision.current
    try {
      const { data } = await api.get<AuthUser>('/api/v1/auth/me')
      if (ownRevision !== revision.current) return
      if (data.id !== current.current?.id) apply(data)
      else { current.current = data; setUser(data) }
    } catch (cause) {
      if (ownRevision !== revision.current) return
      if (axios.isAxiosError(cause) && cause.response?.status === 401) {
        if (current.current) apply(null)
      } else setNotice(errorMessage(cause))
    } finally { if (ownRevision === revision.current) setLoading(false) }
  }, [apply])
  useEffect(() => {
    let active = true
    // A microtask avoids launching the discarded StrictMode effect's request.
    void Promise.resolve().then(() => { if (active) return refresh() })
    function expired() {
      if (!current.current) return
      setNotice('登录已过期，请重新登录。')
      apply(null)
    }
    function focused() { if (current.current) void refresh() }
    window.addEventListener('weibiye:unauthenticated', expired)
    window.addEventListener('focus', focused)
    const timer = window.setInterval(focused, 60_000)
    return () => {
      active = false
      window.removeEventListener('weibiye:unauthenticated', expired)
      window.removeEventListener('focus', focused)
      window.clearInterval(timer)
    }
  }, [refresh, apply])
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    const connection = new BroadcastChannel('weibiye-auth')
    channel.current = connection
    connection.onmessage = () => {
      // Broadcast only an invalidation signal, never credentials or user content.
      apply(null)
      setLoading(true)
      setNotice('其他页面更新了账户状态。')
      void refresh()
    }
    return () => { channel.current = null; connection.close() }
  }, [apply, refresh])
  const login = useCallback(async (email: string, password: string) => {
    const ownRevision = ++revision.current
    resetAuthTransport()
    setNotice('')
    const { data } = await api.post<AuthUser>('/api/v1/auth/login', { email, password })
    if (ownRevision !== revision.current) throw new Error('账户状态已变更，请重试。')
    apply(data)
    channel.current?.postMessage('changed')
  }, [apply])
  const logout = useCallback(async (all = false) => {
    await api.post(`/api/v1/auth/${all ? 'logout-all' : 'logout'}`)
    setNotice('')
    apply(null)
    channel.current?.postMessage('changed')
  }, [apply])
  const invalidate = useCallback((message = '') => {
    setNotice(message)
    apply(null)
    channel.current?.postMessage('changed')
  }, [apply])
  const value = useMemo(() => ({ user, loading, notice, scopeVersion, login, logout, refresh, invalidate }),
    [user, loading, notice, scopeVersion, login, logout, refresh, invalidate])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
