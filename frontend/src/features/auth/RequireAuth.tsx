import { Navigate, Outlet, useLocation } from 'react-router'
import { Card, Loading } from '../../components/ui'
import { useAuth } from './context'

export function RequireAuth({ admin = false }: { admin?: boolean }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Loading message="正在确认登录状态…" />
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (admin && user.role !== 'admin') return <Card><h1>没有访问权限</h1><p>这个入口需要管理员权限。</p></Card>
  return <Outlet />
}
