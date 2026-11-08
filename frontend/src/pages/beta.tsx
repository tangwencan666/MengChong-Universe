import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Card, ErrorState } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { makeFeedback } from '../features/beta/feedback'
import type { FeedbackCategory } from '../features/beta/feedback'

type Quota = { claimed: boolean; remaining: number; daily_remaining: number; active: number; expires_at?: string }
type Privacy = { available: boolean; enabled: boolean; policy_version: string; notice: string }

export function BetaPage() {
  const [quota, setQuota] = useState<Quota>()
  const [privacy, setPrivacy] = useState<Privacy>()
  const [choice, setChoice] = useState(false)
  const [invitation, setInvitation] = useState('')
  const [category, setCategory] = useState<FeedbackCategory>('connection')
  const [error, setError] = useState('')
  const [quotaNotice, setQuotaNotice] = useState('正在读取内测额度。')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void api.get<Quota>('/api/v1/beta/quota', { signal: controller.signal }).then(({ data }) => { setQuota(data); setQuotaNotice('') })
      .catch(() => { if (!controller.signal.aborted) setQuotaNotice('本环境暂未开放内测额度，不会自动领取或收费。') })
    void api.get<Privacy>('/api/v1/beta/privacy', { signal: controller.signal }).then(({ data }) => { setPrivacy(data); setChoice(data.enabled) }).catch(() => {})
    return () => controller.abort()
  }, [])
  async function claim(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const { data } = await api.post<Quota>('/api/v1/beta/quota/claim', { invitation })
      setQuota(data); setQuotaNotice(''); setNotice('已确认当前账号的免费额度；重复操作不会增加额度。')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setInvitation(''); setBusy(false) }
  }
  async function savePrivacy() {
    if (!privacy) return
    setBusy(true); setError('')
    try {
      const { data } = await api.post<Privacy>('/api/v1/beta/privacy/consent', { enabled: choice, policy_version: privacy.policy_version })
      setPrivacy(data); setChoice(data.enabled); setNotice(data.enabled ? '已开启最小统计。' : '已关闭统计并删除对应事件。')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  function download() {
    const payload = makeFeedback(category, crypto.randomUUID(), new Date().toISOString())
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'weibiye-beta-feedback-v1.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    setNotice('反馈单不会自动发送，请通过内测组织者提供的渠道提交。')
    if (privacy?.enabled && category === 'connection') void api.post('/api/v1/beta/privacy/events', { kind: 'fault_network' }).catch(() => {})
  }
  return <div className="page-stack">
    <Card><h1>内测与反馈</h1><p>免费额度由服务端控制，当前阶段不提供支付或充值。额度不足会停止新请求，历史记录仍可读取；已派发后失败或停止不承诺免除用量。</p>
      {quotaNotice && <p role="status">{quotaNotice}</p>}
      {quota && <p>剩余 {quota.remaining} 次 · 今日可用 {quota.daily_remaining} 次 · 进行中 {quota.active} 次</p>}
      {quota && !quota.claimed && <form onSubmit={claim}><label className="form-field">内测邀请码<input aria-label="内测邀请码" value={invitation} onChange={event => setInvitation(event.target.value)} minLength={32} maxLength={128} required autoComplete="off" /></label><Button type="submit" disabled={busy}>领取免费额度</Button></form>}
    </Card>
    <Card><h2>使用统计由你选择</h2><p>{privacy?.notice ?? '统计默认关闭，未读取到服务说明时不能开启。'}</p>
      <label><input type="checkbox" checked={choice} disabled={!privacy?.available || busy} onChange={event => setChoice(event.target.checked)} />我同意上述最小统计</label>
      <p><Button disabled={!privacy?.available || busy} onClick={() => void savePrivacy()}>保存统计选择</Button></p>
      <p>本地诊断日志也默认关闭，不自动上传；需要时可由内测组织者指导开启。未提交的聊天和记忆不会附入反馈单。</p>
    </Card>
    <Card><h2>生成反馈单</h2><p>只导出所选类别、随机编号和时间。若已同意统计，选择连接问题时也会记录一个固定故障类别；反馈文件仍不会自动上传。</p>
      <label>问题类别<select aria-label="反馈问题类别" value={category} onChange={event => setCategory(event.target.value as FeedbackCategory)}><option value="installation">安装或启动</option><option value="connection">服务连接</option><option value="window">窗口或宠物显示</option><option value="performance">性能</option><option value="other">其他</option></select></label>
      <p><Button onClick={download}>下载最小反馈单</Button></p>
    </Card>
    {error && <ErrorState message={error} />}{notice && <p role="status">{notice}</p>}
  </div>
}
