import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowLeft, Sprout } from 'lucide-react'
import { Button, Card, ErrorState, FormField, Loading } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { useAuth } from '../features/auth/context'

function RecoveryFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="auth-wrap"><Link to="/login" className="back-link"><ArrowLeft size={15} />返回登录</Link>
    <Card className="auth-card"><span className="brand-mark"><Sprout size={28} /></span>
      <h1>{title}</h1><p className="auth-hint">当前使用本地 Mock 邮件，不会发送真实邮件。请通过本地收件箱中的链接继续。</p>
      {children}
    </Card></div>
}

export function RecoveryRequestPage({ verification = false }: { verification?: boolean }) {
  const auth = useAuth()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = new FormData(event.currentTarget).get('email')
    setBusy(true); setMessage(''); setError('')
    try {
      const { data } = await api.post<{ message: string }>(`/api/v1/auth/${verification ? 'resend-verification' : 'forgot-password'}`, { email })
      setMessage(data.message)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  if (auth.loading) return <Loading message="正在确认账户状态…" />
  return <RecoveryFrame title={verification ? '重新验证邮箱' : '找回密码'}><form onSubmit={submit}>
    <FormField label="邮箱" name="email" type="email" autoComplete="username" maxLength={254} required defaultValue={auth.user?.email} />
    {message && <p role="status" className="auth-hint">{message}</p>}{error && <ErrorState message={error} />}
    <Button type="submit" disabled={busy} className="full-width">{busy ? '请稍候…' : verification ? '重发验证邮件' : '请求重置密码'}</Button>
    </form><p className="auth-switch"><Link to={verification ? '/verify-email' : '/reset-password'}>手动粘贴{verification ? '验证' : '重置'}令牌</Link></p>
  </RecoveryFrame>
}

export function RecoveryTokenPage({ verification = false }: { verification?: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const [selection, setSelection] = useState(() => ({
    seenHash: location.hash, token: new URLSearchParams(location.hash.slice(1)).get('token') ?? '', id: 0,
  }))
  useEffect(() => {
    if (!auth.loading && (location.hash || location.search)) navigate(location.pathname, { replace: true })
  }, [auth.loading, location.hash, location.pathname, location.search, navigate])
  // Keep the captured credential after URL cleanup; a new fragment starts a fresh form.
  if (selection.seenHash !== location.hash) {
    setSelection({ seenHash: location.hash,
      token: location.hash ? new URLSearchParams(location.hash.slice(1)).get('token') ?? '' : selection.token,
      id: location.hash ? selection.id + 1 : selection.id })
  }
  if (auth.loading) return <Loading message="正在确认账户状态…" />
  return <RecoveryTokenForm key={selection.id} verification={verification} initialToken={selection.token} />
}

function RecoveryTokenForm({ verification, initialToken }: { verification: boolean; initialToken: string }) {
  const navigate = useNavigate()
  const auth = useAuth()
  const [token, setToken] = useState(initialToken)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    setError(''); setMessage('')
    if (!verification && values.get('password') !== values.get('confirmation')) {
      setError('两次输入的密码不一致。'); return
    }
    setBusy(true)
    try {
      const { data } = await api.post<{ message: string }>(`/api/v1/auth/${verification ? 'verify-email' : 'reset-password'}`,
        verification ? { token } : { token, password: values.get('password') })
      if (verification) { await auth.refresh(); setMessage(data.message); setToken('') }
      else { auth.invalidate(data.message); navigate('/login', { replace: true }) }
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  if (auth.loading) return <Loading message="正在确认账户状态…" />
  return <RecoveryFrame title={verification ? '验证邮箱' : '设置新密码'}>
    {message ? <><p role="status">{message}</p><Link to="/me" className="button button-primary">前往个人中心</Link></> : <form onSubmit={submit}>
      <FormField label={verification ? '验证令牌' : '重置令牌'} name="token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} minLength={43} maxLength={128} required />
      {!verification && <><FormField label="新密码" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required hint="12–128 位，至少包含大小写字母、数字、符号中的三类。" />
        <FormField label="确认新密码" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></>}
      {error && <ErrorState message={error} />}
      <Button type="submit" disabled={busy} className="full-width">{busy ? '请稍候…' : verification ? '确认验证邮箱' : '更新密码并退出旧会话'}</Button>
    </form>}
    <p className="auth-switch"><Link to={verification ? '/resend-verification' : '/forgot-password'}>重新请求链接</Link></p>
  </RecoveryFrame>
}
