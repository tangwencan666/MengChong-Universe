import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowRight, ShieldCheck, Wallet } from 'lucide-react'
import { Button, Card, EmptyState, ErrorState, Loading } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { DemoNotice } from '../components/demo-notice'
import { useAuth } from '../features/auth/context'
import { PetSocialSettings } from '../features/p863/PetSocialSettings'

function ApiProbe({ endpoint }: { endpoint: string }) {
  const result = useQuery({
    queryKey: ['capability', endpoint], enabled: false,
    queryFn: async () => (await api.get(endpoint)).data as unknown,
  })
  return <div className="api-probe"><Button variant="secondary" onClick={() => void result.refetch()} disabled={result.isFetching}>检查接口状态</Button>{result.isFetching && <Loading message="正在检查接口…" />}{result.isError && <ErrorState message={errorMessage(result.error)} />}{result.isSuccess && <p role="status">接口已响应。此检查不代表业务已实现。</p>}</div>
}

export function WalletPage() {
  return <><div className="page-title"><div><span className="eyebrow">TOKEN WALLET</span><h1>Token 钱包<span className="title-dot">.</span></h1><p>清晰了解每一次使用，安心探索 AI 的可能。</p></div><Wallet size={30} className="muted" /></div><DemoNotice>钱包尚未开通。没有真实余额、兑换比例或充值入口，Mock 体验不计费。</DemoNotice><div className="wallet-grid"><Card className="balance-card"><span>可用余额</span><strong>— <small>整数单位待定义</small></strong><p>账户与账本结构已建立，尚未实现余额查询。</p><span className="pill">未开通</span></Card><Card className="privacy-card"><ShieldCheck size={27} /><h3>透明，从基础开始</h3><p>未来的使用量、额度预留、扣费与返还会通过幂等账本追踪。本阶段只提供数据结构与服务契约。</p></Card></div><Card><EmptyState title="账本功能尚未开放" description="当前没有交易记录可展示。系统未接入支付，不会产生充值或扣费。" /></Card><ApiProbe endpoint="/api/v1/wallet" /></>
}

export function ProfilePage() {
  const { user, logout } = useAuth()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function leave(all = false) {
    setBusy(true); setError('')
    try { await logout(all) } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <><div className="page-title"><div><span className="eyebrow">YOUR OWN LITTLE CORNER</span><h1>个人中心<span className="title-dot">.</span></h1><p>管理你的账户与登录安全。</p></div></div>
    <Card className="profile-card"><h2>{user?.display_name}</h2><p>{user?.email}</p><p>邮箱：{user?.email_verified ? '已验证' : '尚未验证（本地 Mock 邮件）'}</p>
      <Link to="/me/sessions" className="button button-secondary">管理登录会话 <ArrowRight size={16} /></Link>
      {!user?.email_verified && <Link to="/resend-verification" className="button button-secondary">验证邮箱</Link>}
      <div className="auth-actions"><Button disabled={busy} onClick={() => void leave()}>退出登录</Button><Button variant="secondary" disabled={busy} onClick={() => void leave(true)}>退出所有会话</Button></div>
      {error && <ErrorState message={error} />}
    </Card><PetSocialSettings /></>
}

export function AdminPage() {
  return <><div className="page-title"><div><span className="eyebrow">ADMINISTRATION</span><h1>管理后台<span className="title-dot">.</span></h1><p>账户与安全管理入口，范围待确认。</p></div><ShieldCheck size={30} className="muted" /></div><DemoNotice>当前仅展示管理入口。后端已设置管理员角色依赖，实际管理操作尚未实现。</DemoNotice><Card><EmptyState title="管理功能尚未开放" description="本页面没有真实管理数据，也不提供读取私人会话或记忆的入口。" /></Card><ApiProbe endpoint="/api/v1/admin" /></>
}
