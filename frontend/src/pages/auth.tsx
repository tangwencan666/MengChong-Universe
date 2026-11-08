import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react'
import { Button, Card, ErrorState, FormField, Loading } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { useAuth } from '../features/auth/context'

function destination(search: string) {
  const next = new URLSearchParams(search).get('next') ?? '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  const url = new URL(next, window.location.origin)
  let normalized: string
  try { normalized = decodeURIComponent(url.pathname).toLowerCase().replace(/\/+$/, '') }
  catch { return '/' }
  return url.origin === window.location.origin && !['/login', '/register'].includes(normalized)
    ? url.pathname + url.search : '/'
}

export function AuthPage({ register = false }: { register?: boolean }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [capabilities, setCapabilities] = useState<{ email_verification_required: boolean; mail_mode: 'mock' | 'external' }>()
  useEffect(() => {
    if (!register) return
    const controller = new AbortController()
    void api.get('/api/v1/auth/capabilities', { signal: controller.signal }).then(({ data }) => setCapabilities(data)).catch(() => {})
    return () => controller.abort()
  }, [register])
  if (auth.loading) return <Loading message="正在确认登录状态…" />
  if (auth.user) return <Navigate to={destination(location.search)} replace />
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setSubmitting(true); setError('')
    try {
      if (register) {
        const { data } = await api.post<{ message: string }>('/api/v1/auth/register', {
          email: form.get('email'), password: form.get('password'), display_name: form.get('display_name'),
        })
        navigate('/login', { replace: true, state: { registrationMessage: data.message } })
      } else {
        await auth.login(String(form.get('email')), String(form.get('password')))
        navigate(destination(location.search), { replace: true })
      }
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setSubmitting(false) }
  }
  const registrationMessage = (location.state as { registrationMessage?: string } | null)?.registrationMessage
  return <div className="auth-wrap"><Link to="/" className="back-link"><ArrowLeft size={15} />回到首页</Link>
    <Card className="auth-card"><span className="brand-mark"><Sparkles size={28} /></span><span className="eyebrow">欢迎来到萌宠溜达</span>
      <h1>{register ? '新的旅程，从这里开始' : '欢迎回来，慢慢来'}</h1>
      <p className="muted">你的桌面 AI 宠物伙伴</p>
      {register && <p className="auth-hint">{!capabilities ? '正在读取服务的邮箱验证规则。' : `${capabilities.mail_mode === 'mock' ? '本环境使用本地 Mock 邮件，不会发送真实邮件。' : '注册后请查收服务发送的邮件。'}${capabilities.email_verification_required ? '验证邮箱后才能登录。' : '当前可在注册后登录，验证状态会在个人中心标明。'}`}</p>}
      {(registrationMessage || auth.notice) && <p className="auth-hint" role="status">{registrationMessage || auth.notice}</p>}
      <form onSubmit={submit}>
        {register && <FormField label="昵称" name="display_name" autoComplete="nickname" maxLength={60} required />}
        <FormField label="邮箱" name="email" type="email" autoComplete="username" maxLength={254} placeholder="you@example.com" required />
        <FormField label="密码" name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : 1} maxLength={128}
          hint={register ? '12–128 位，至少包含大小写字母、数字、符号中的三类。' : undefined} required />
        {error && <ErrorState message={error} />}
        <Button type="submit" disabled={submitting} className="full-width">{submitting ? '请稍候…' : register ? '注册' : '登录'}<ArrowRight size={16} /></Button>
      </form><p className="auth-switch">{register ? '已有账户？' : '还没有账户？'}<Link to={register ? '/login' : '/register'}>{register ? '登录' : '注册'}</Link></p>
      <p className="auth-switch"><Link to="/forgot-password">忘记密码</Link><span> · </span><Link to="/resend-verification">重发验证邮件</Link></p>
    </Card></div>
}
