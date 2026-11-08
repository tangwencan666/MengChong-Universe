import { usePet } from '../features/pets/context'
import { chatLink } from '../features/pets/scope'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'
import { ArrowRight, BookHeart, Check, Download, LockKeyhole, Plus, RefreshCw, ShieldCheck, Sprout } from 'lucide-react'
import { Button, Card, EmptyState, ErrorState, FormField, Loading, Modal } from '../components/ui'
import { useMemory } from '../features/memory/context'
import type { MemoryCategory, MemoryContent, MemoryItem } from '../features/memory/types'
import { errorMessage } from '../lib/api'

const categories: { value: MemoryCategory; label: string }[] = [
  { value: 'career_goal', label: '个人目标（旧版分类）' },
  { value: 'communication_preference', label: '交流偏好' },
  { value: 'experience', label: '重要经历' },
  { value: 'open_topic', label: '待续事项' },
  { value: 'explicit_note', label: '其他明确事项' },
]
type Action = 'enable' | 'disable' | 'clear' | 'delete' | 'revoke'
type Dialog = { kind: Action } | { kind: 'create' | 'edit' | 'detail'; id?: string }

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '尚未设置'
}
function dayInput(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function categoryLabel(value: MemoryItem['category']) {
  return categories.find((item) => item.value === value)?.label ?? '旧记录'
}
function effectiveStatus(item: MemoryItem, at: number) {
  // Explicit server states stay authoritative; only active records can expire locally.
  return item.status === 'active' && item.expires_at && Date.parse(item.expires_at) <= at ? 'expired' : item.status
}
function itemStatus(item: MemoryItem, enabled: boolean, at: number) {
  const status = effectiveStatus(item, at)
  if (status === 'legacy_unconfirmed') return '旧记录待确认'
  if (status === 'expired') return '已过期'
  if (status === 'revoked') return '已撤销'
  return enabled ? '允许参考' : '已停止参考'
}

function Sources({ item }: { item: MemoryItem }) {
  const { petId } = usePet()
  return <div className="memory-sources"><h3>记忆来源</h3>{item.sources.length ? <ul>{item.sources.map((source, index) => <li key={`${source.kind}-${source.message_id ?? index}`}>
    {source.kind === 'manual' ? <span>本人手动添加</span> : source.availability === 'available' && source.session_id
      ? <><span>本人聊天中的用户消息</span><Link to={chatLink(source.session_id, petId)} className="text-link">查看原始会话 <ArrowRight size={13} /></Link></>
      : <span>{source.availability === 'source_deleted' ? '来源已删除，不再用于参考' : '旧记录来源待核对，不用于参考'}</span>}
  </li>)}</ul> : <p>来源暂不可确认。</p>}<p className="memory-fine-print">来源指向原始记录；内容可能经过你后续确认修改。查看聊天仍需当前账户的访问权限。</p></div>
}

function MemoryEditor({ item, busy, onSave, onClose }: {
  item?: MemoryItem; busy: boolean; onSave: (content: MemoryContent) => Promise<void>; onClose: () => void
}) {
  const contentId = useId()
  const categoryId = useId()
  const [title, setTitle] = useState(item?.title ?? '')
  const [content, setContent] = useState(item?.content ?? '')
  const [category, setCategory] = useState<MemoryCategory>(item?.category ?? 'explicit_note')
  const [expiry, setExpiry] = useState(dayInput(item?.expires_at ?? null))
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const titleLength = [...title.trim()].length
  const contentLength = [...content.trim()].length
  const [maxDate] = useState(() => dayInput(new Date(Date.now() + 365 * 86_400_000).toISOString()))
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (!confirmed || titleLength < 1 || titleLength > 80 || contentLength < 1 || contentLength > 1000) {
      setError('请核对标题和内容长度，并明确确认这条记忆。'); return
    }
    let expires_at: string | undefined
    if (expiry) {
      const date = new Date(`${expiry}T23:59:59`)
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || date.getTime() > Date.now() + 365 * 86_400_000) {
        setError('请选择未来一年以内的有效期。'); return
      }
      expires_at = date.toISOString()
    }
    try {
      await onSave({ title: title.replace(/\r\n?/g, '\n').trim(), content: content.replace(/\r\n?/g, '\n').trim(), category, ...(expires_at ? { expires_at } : {}) })
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
  }
  return <form className="memory-form" onSubmit={(event) => void submit(event)}>
    <p>只保存你现在确认的这一条。开启授权或聊天本身都不会自动保存记忆。</p>
    <FormField label="记忆标题" value={title} onChange={(event) => { setTitle(event.target.value); setConfirmed(false) }} required hint={`${titleLength}/80 个字符`} disabled={busy} />
    <div className="form-field"><label htmlFor={contentId}>记忆内容</label><textarea id={contentId} rows={5} value={content} required disabled={busy} onChange={(event) => { setContent(event.target.value); setConfirmed(false) }} aria-describedby={`${contentId}-hint`} /><small id={`${contentId}-hint`}>{contentLength}/1000 个字符。请勿添加密码、证件号码、精确住址或他人隐私。</small></div>
    <div className="form-field"><label htmlFor={categoryId}>记忆类别</label><select id={categoryId} value={category} onChange={(event) => { setCategory(event.target.value as MemoryCategory); setConfirmed(false) }} disabled={busy}>{categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
    <FormField label="有效期（可选）" type="date" value={expiry} max={maxDate} onChange={(event) => { setExpiry(event.target.value); setConfirmed(false) }} disabled={busy} hint="所选日期按本地当天结束时间保存。留空按类别设置有限有效期，过期不会自动续期。" />
    {item && <p className="memory-fine-print">修改会覆盖当前内容，旧版本不再用于参考；原始来源保持不变。</p>}
    <label className="memory-consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已核对以上内容，同意保存这条长期记忆</span></label>
    {error && <ErrorState message={error} />}
    <div className="memory-dialog-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !confirmed || titleLength < 1 || titleLength > 80 || contentLength < 1 || contentLength > 1000}>{busy ? '正在确认…' : item ? '确认修改' : '确认保存'}</Button></div>
  </form>
}

function MemoryWorkspace() {
  const { petId, pet } = usePet()
  const archived = pet?.status === 'archived'
  const memory = useMemory()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [filter, setFilter] = useState('all')
  const [actionError, setActionError] = useState('')
  const [localNotice, setLocalNotice] = useState('')
  const [viewedAt, setViewedAt] = useState(Date.now)
  const alive = useRef(true)
  const downloads = useRef(new Set<string>())
  useEffect(() => {
    alive.current = true
    const activeDownloads = downloads.current
    return () => { alive.current = false; activeDownloads.forEach((url) => URL.revokeObjectURL(url)); activeDownloads.clear() }
  }, [])
  useEffect(() => {
    let timer: number
    const refreshTime = () => {
      window.clearTimeout(timer)
      const at = Date.now()
      setViewedAt(at)
      const nextExpiry = memory.items.reduce((next, item) => {
        const expires = item.status === 'active' && item.expires_at ? Date.parse(item.expires_at) : NaN
        return expires > at ? Math.min(next, expires) : next
      }, Infinity)
      // Long-lived records exceed the browser's signed 32-bit timeout range.
      // Wake only at the nearest expiry (or a safe intermediate checkpoint).
      if (Number.isFinite(nextExpiry)) timer = window.setTimeout(refreshTime, Math.min(nextExpiry - at, 2_147_483_647))
    }
    const whenVisible = () => { if (document.visibilityState !== 'hidden') refreshTime() }
    timer = window.setTimeout(refreshTime, 0)
    window.addEventListener('focus', refreshTime)
    document.addEventListener('visibilitychange', whenVisible)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refreshTime)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [memory.items])
  const selected = memory.items.find((item) => item.id === selectedId)
  const selectedStatus = selected ? effectiveStatus(selected, viewedAt) : null
  const enabled = memory.preferences?.long_term_memory_enabled === true
  const busy = memory.pending || memory.syncing || memory.loading
  const items = memory.items.filter((item) => filter === 'all' || itemStatus(item, enabled, viewedAt) === filter)
  function open(next: Dialog, item?: MemoryItem) {
    setSelectedId(item?.id ?? ('id' in next ? next.id : undefined) ?? null); setConsent(false); setActionError(''); setLocalNotice(''); setDialog(next)
  }
  function close() { setDialog(null); setSelectedId(null); setConsent(false); setActionError('') }
  async function run(action: () => Promise<unknown>, success: string) {
    setActionError(''); setLocalNotice('')
    try {
      await action()
      if (alive.current) { close(); setLocalNotice(success) }
    } catch (cause) { if (alive.current) setActionError(errorMessage(cause)) }
  }
  async function download() {
    setActionError(''); setLocalNotice('')
    try {
      const data = await memory.exportMemories()
      if (!alive.current) return
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }))
      downloads.current.add(url)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `weibiye-memories-${new Date().toISOString().slice(0, 10)}.json`
      document.body.append(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url) }, 0)
      setLocalNotice('已生成下载文件，请妥善保管。下载后的副本无法由服务器撤回。')
    } catch (cause) { if (alive.current) setActionError(errorMessage(cause)) }
  }
  const action = dialog?.kind
  const actionTitle = action === 'enable' ? '开启长期记忆' : action === 'disable' ? '关闭长期记忆' : action === 'clear' ? '清空全部记忆' : action === 'delete' ? '删除这条记忆' : '撤销这条记忆'

  return <div className="memory-workspace">
    <div className="page-title memory-page-title"><div><span className="eyebrow">ONLY WITH YOUR PERMISSION</span><h1>记忆管理<span className="title-dot">.</span></h1><p>{pet ? `这些是你允许${pet.name}记住的事情。其他宠物不会读取。` : '这些是你允许我记住的事情。'}</p></div><span className="memory-title-icon"><BookHeart size={27} /></span></div>
    {archived && <p role="status">这只宠物已归档，不能新增或修改记忆；你仍可关闭授权、撤销、删除、清空和导出。</p>}
    {memory.loading ? <Loading message="正在读取当前账户的记忆设置…" /> : memory.unavailable || !memory.preferences ? <Card className="memory-unavailable"><LockKeyhole size={27} /><h2>长期记忆暂不可用</h2><p>尚未读到服务器确认的设置。现有聊天仍可使用，不会在这里假定授权或保存成功。</p>{memory.error && <ErrorState message={memory.error} />}<Button variant="secondary" onClick={() => void memory.refresh().catch(() => undefined)}>重新读取设置</Button></Card> : <>
      <Card className="memory-permission"><div className="memory-permission-heading"><span className="memory-soft-icon"><ShieldCheck size={22} /></span><div><h2>长期记忆</h2><p>{enabled ? '已开启 · 每条内容仍需你确认' : '尚未开启 · 默认保护隐私'}</p></div><input role="switch" aria-label="长期记忆授权" type="checkbox" className="memory-switch" checked={enabled} disabled={busy || (archived && !enabled)} onChange={() => open({ kind: enabled ? 'disable' : 'enable' })} /></div><p>允许后，你可以主动添加或预览一条记忆，再确认保存。这里只使用当前账户授权、未撤销且未过期的内容；开启不会自动扫描聊天。{petId ? '每只宠物分别授权和保存，旧版账户记忆不会自动共享。' : '这里保留旧版账户记忆，不会自动共享给新宠物。'}</p><div className="memory-separate-consent"><Sprout size={16} /><span>最近话题只提供继续聊天的入口，与长期记忆分别授权。</span>{!petId && <Link to="/preferences/conversations">话题续聊设置 <ArrowRight size={13} /></Link>}</div></Card>
      <div className="memory-status-line" aria-live="polite">{busy ? <span role="status">正在与服务器确认，请稍候…</span> : <span>{petId ? '当前宠物' : '旧版账户'} · 授权和记忆以服务器状态为准</span>}<Button variant="ghost" disabled={busy} onClick={() => void memory.refresh().catch(() => undefined)} aria-label="刷新记忆"><RefreshCw size={14} />刷新</Button></div>
      {memory.error && <ErrorState message={memory.error} />}
      {actionError && !dialog && <ErrorState message={actionError} />}
      {(localNotice || memory.notice) && <p className="memory-success" role="status"><Check size={16} />{localNotice || memory.notice}</p>}
      <section aria-label="已保存的长期记忆"><div className="memory-list-heading"><div><h2>我允许保存的记忆</h2><p>已保存 {memory.items.length} 条 · 只在相关时参考</p></div><Button disabled={busy || archived || !enabled} onClick={() => open({ kind: 'create' })}><Plus size={16} />添加记忆</Button></div>
        <div className="memory-list-tools"><label>筛选记忆状态<select value={filter} onChange={(event) => setFilter(event.target.value)}>{['all', '允许参考', '已撤销', '已过期', '旧记录待确认', '已停止参考'].map((status) => <option key={status} value={status}>{status === 'all' ? '全部状态' : status}</option>)}</select></label><div><Button variant="ghost" disabled={busy} onClick={() => void download()}><Download size={14} />导出记忆</Button><Button variant="ghost" disabled={busy || !memory.items.length} onClick={() => open({ kind: 'clear' })}>清空记忆</Button></div></div>
        {!items.length ? <Card><EmptyState title={memory.items.length ? '这里暂时没有符合的记忆' : '还没有保存任何记忆'} description={enabled ? '愿意的话，可以主动添加一条；也可以在自己的聊天消息旁选择“记住这条”。保存前会请你核对。' : '不开启也可以继续聊天。已有记忆的查看、删除和导出不需要重新授权。'} /></Card> : <div className="memory-list">{items.map((item) => <Card key={item.id} className="memory-item"><article data-testid="memory-item"><div className="memory-item-top"><span className="memory-category">{categoryLabel(item.category)}</span><span className={`memory-state ${itemStatus(item, enabled, viewedAt) === '允许参考' ? 'memory-state-active' : ''}`}>{itemStatus(item, enabled, viewedAt)}</span></div><h3>{item.title || '旧记忆记录'}</h3><p className="memory-summary">{item.summary || item.content}</p><div className="memory-item-bottom"><span>{item.expires_at ? `有效至 ${new Date(item.expires_at).toLocaleDateString('zh-CN')}` : '需要重新核对有效期'}</span><Button variant="ghost" aria-label={`查看记忆：${item.title || '旧记忆记录'}`} onClick={() => open({ kind: 'detail', id: item.id }, item)}>查看详情 <ArrowRight size={14} /></Button></div></article></Card>)}</div>}
      </section>
      <aside className="memory-boundary"><BookHeart size={19} /><div><h2>由你决定，也可以随时改变</h2><p>撤销会停止后续参考；删除会清除这条记忆的正文，不会删除原聊天。授权改变时，使用旧设置的生成任务可能被停止。已发送的内容、下载文件和备份有各自保留边界。</p><p>记忆管理不代表模型已使用这些内容；真实模型模式暂不注入长期记忆。Token 余额不会决定记忆是否保留，也不影响查看、删除或导出。</p></div></aside>
    </>}

    {dialog?.kind === 'create' && <Modal open onClose={close} title="添加一条记忆"><MemoryEditor busy={busy || archived} onClose={close} onSave={async (content) => { await memory.create(content); if (alive.current) close() }} /></Modal>}
    {dialog?.kind === 'edit' && selected && <Modal open onClose={close} title="编辑这条记忆">{selectedStatus === 'active' && enabled ? <MemoryEditor item={selected} busy={busy || archived} onClose={close} onSave={async (content) => { await memory.edit(selected, content); if (alive.current) close() }} /> : <p>这条记忆当前不用于参考，不能继续编辑。你仍可以查看、导出或删除，也可以明确添加一条新的记忆。</p>}</Modal>}
    {dialog?.kind === 'detail' && selected && <Modal open onClose={close} title="记忆详情"><div className="memory-detail"><span className="memory-state">{itemStatus(selected, enabled, viewedAt)}</span><h3>{selected.title || '旧记忆记录'}</h3><p className="memory-detail-content">{selected.content}</p><dl><div><dt>类别</dt><dd>{categoryLabel(selected.category)}</dd></div><div><dt>最近确认</dt><dd>{dateLabel(selected.last_confirmed_at)}</dd></div><div><dt>有效期</dt><dd>{dateLabel(selected.expires_at)}</dd></div></dl><Sources item={selected} />{selectedStatus !== 'active' && <p className="memory-fine-print">这条记忆当前不用于参考。重新开启总开关不会复活它；如想保留新内容，可以明确添加一条新的记忆。</p>}<div className="memory-detail-actions">{selectedStatus === 'active' && enabled && <Button variant="secondary" disabled={busy || archived} onClick={() => open({ kind: 'edit', id: selected.id }, selected)}>编辑记忆</Button>}{selectedStatus === 'active' && <Button variant="ghost" disabled={busy} onClick={() => open({ kind: 'revoke' }, selected)}>撤销这条记忆</Button>}<Button variant="ghost" disabled={busy} onClick={() => open({ kind: 'delete' }, selected)}>删除这条记忆</Button></div></div></Modal>}
    {dialog && ['enable', 'disable', 'clear', 'delete', 'revoke'].includes(dialog.kind) && <Modal open onClose={close} title={actionTitle}><div className="memory-confirmation">
      {action === 'enable' ? <><p>开启后，你可以保存自己确认的个人目标、交流偏好或普通事项。每条记忆需单独确认，开启本身不会保存聊天内容。</p><p>记忆仅用于{petId ? '当前账户的这只宠物' : '旧版账户'}，设有有效期，你可以查看、编辑、撤销、删除或导出。当前模型为 Mock；请勿保存敏感个人信息。</p><label className="memory-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /><span>我了解并同意以上长期记忆说明</span></label></>
        : action === 'disable' ? <><p>关闭后，停止预览、保存和使用长期记忆，当前允许参考的条目会被撤销，仍可查看、删除或导出。</p><p>重新开启不会恢复旧条目的授权。话题续聊设置和原聊天记录不会改变。</p></>
          : action === 'clear' ? <><p>这会清除{petId ? '这只宠物的' : '旧版账户的'}全部长期记忆的正文，无法从普通界面恢复。原聊天记录、话题续聊授权和长期记忆开关不会因此改变。</p><label className="memory-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /><span>我确认清空{petId ? '这只宠物' : '当前账户'}的全部长期记忆</span></label></>
            : action === 'delete' ? <><p>删除后会清除这条长期记忆的正文，停止后续参考，无法恢复。</p><p>原始聊天和话题续聊设置不受影响。已经发出或下载的内容无法召回。</p></>
              : <><p>撤销后，这条记忆停止用于后续参考，正文仍保留供你查看、导出或删除。</p><p>使用旧记忆设置的生成任务可能被停止，原聊天仍可查看。</p></>}
      {actionError && <ErrorState message={actionError} />}
      <div className="memory-dialog-actions"><Button variant="secondary" disabled={busy} onClick={close}>取消</Button><Button disabled={busy || (archived && action === 'enable') || ((action === 'enable' || action === 'clear') && !consent) || ((action === 'delete' || action === 'revoke') && !selected) || (action === 'revoke' && selectedStatus !== 'active')} onClick={() => {
        if (action === 'enable' || action === 'disable') void run(() => memory.setEnabled(action === 'enable'), action === 'enable' ? '长期记忆授权已由服务器确认开启。' : '长期记忆授权已由服务器确认关闭。')
        else if (action === 'clear') void run(() => memory.clear(), '服务器已确认清空长期记忆，原聊天保留。')
        else if (selected && action === 'delete') void run(() => memory.remove(selected), '服务器已确认删除这条记忆。')
        else if (selected && action === 'revoke') void run(() => memory.revoke(selected), '服务器已确认撤销这条记忆。')
      }}>{busy ? '正在确认…' : action === 'enable' ? '确认开启' : action === 'disable' ? '确认关闭' : action === 'clear' ? '确认清空' : action === 'delete' ? '确认删除' : '确认撤销'}</Button></div>
    </div></Modal>}
  </div>
}

export function MemoryPage() {
  const { preferences } = useMemory()
  // A changed privacy epoch discards open details and drafts from the old snapshot.
  return <MemoryWorkspace key={preferences?.privacy_epoch ?? 'unavailable'} />
}
