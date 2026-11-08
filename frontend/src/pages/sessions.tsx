import { useQuery } from '@tanstack/react-query'
import { Button, Card, EmptyState, ErrorState, Loading } from '../components/ui'
import { useAuth } from '../features/auth/context'
import { api, errorMessage } from '../lib/api'
import { useState } from 'react'

interface SessionView { id: string; created_at: string; expires_at: string; last_seen_at: string; current: boolean }

export function SessionsPage() {
  const auth = useAuth()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sessions = useQuery({ queryKey: ['auth-sessions', auth.user?.id],
    queryFn: async ({ signal }) => (await api.get<SessionView[]>('/api/v1/auth/sessions', { signal })).data })
  async function revoke(session: SessionView) {
    setBusy(true); setError('')
    try {
      await api.delete(`/api/v1/auth/sessions/${session.id}`)
      if (session.current) await auth.refresh()
      else await sessions.refetch()
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <><div className="page-title"><div><h1>登录会话</h1><p>查看有效会话，或撤销不再使用的登录。</p></div></div>
    {error && <ErrorState message={error} />}{sessions.isPending && <Loading />}
    {sessions.isError && <ErrorState message={errorMessage(sessions.error)} />}
    <div className="auth-session-list">{sessions.data?.map((session) => <Card key={session.id} className="auth-session-card">
      <h2>{session.current ? '当前会话' : '其他登录会话'}</h2>
      <p>登录时间：{new Date(session.created_at).toLocaleString('zh-CN')}</p><p>有效至：{new Date(session.expires_at).toLocaleString('zh-CN')}</p>
      <Button variant="secondary" disabled={busy} onClick={() => void revoke(session)}>{session.current ? '退出当前会话' : '撤销此会话'}</Button>
    </Card>)}</div>
    {sessions.data?.length === 0 && <EmptyState title="没有有效会话" description="请重新登录。" />}
  </>
}
