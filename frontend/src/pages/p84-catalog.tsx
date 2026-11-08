import { Link, useLocation } from 'react-router'
import { Card } from '../components/ui'
import { useAuth } from '../features/auth/context'
import { AdoptionPanel } from '../features/p85/AdoptionPanel'
import './p84-catalog.css'

export function PetCatalogEntry() {
  const { pathname } = useLocation()
  const { user } = useAuth()
  if (!user || pathname !== '/companions') return null
  return <aside className="p84-catalog-entry"><Link to="/pet-catalog">八种伙伴 · 选择宠物模板</Link><span>同种可重复领养，桌面同时最多五只</span></aside>
}
export function PetCatalogPage() {
  const { user, scopeVersion } = useAuth()
  return <div className="page-stack p84-catalog"><Card><h1>选择你的桌面伙伴</h1><p>可以重复领养同一种。每次领养创建独立身份、名字、人格、聊天和记忆，不改变已有伙伴。</p><Link to="/companions" className="button button-ghost">返回我的宠物并管理实例</Link></Card>
    <AdoptionPanel key={`${user?.id}:${scopeVersion}`} />
  </div>
}
