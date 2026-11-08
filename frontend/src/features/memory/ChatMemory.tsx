import { usePet } from '../pets/context'
import { memoryLink } from '../pets/scope'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { BookHeart } from 'lucide-react'
import { Button, ErrorState, FormField, Modal } from '../../components/ui'
import { errorMessage } from '../../lib/api'
import { useMemory } from './context'
import type { MemoryCandidate, MemoryContent, MemoryPreview, MemoryReferences } from './types'

const categories: [MemoryContent['category'], string][] = [
  ['career_goal', '个人目标（旧版分类）'], ['communication_preference', '交流偏好'],
  ['experience', '重要经历'], ['open_topic', '待续事项'], ['explicit_note', '明确事项'],
]

/** This dialog holds only this selected user's message and a temporary receipt in RAM. */
export function RememberMessage({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const memory = useMemory()
  const { petId, pet } = usePet()
  const contentId = useId()
  const categoryId = useId()
  const [open, setOpen] = useState(false)
  const [allowPreview, setAllowPreview] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [shown, setShown] = useState<MemoryPreview | null>(null)
  const [candidate, setCandidate] = useState<MemoryCandidate | null>(null)
  const [draft, setDraft] = useState<MemoryContent>({ title: '', content: '', category: 'explicit_note' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [note, setNote] = useState('')
  const alive = useRef(true)
  const version = useRef(0)
  useEffect(() => {
    version.current++
    alive.current = true
    const clear = () => { version.current++; setOpen(false); setShown(null); setCandidate(null); setDraft({ title: '', content: '', category: 'explicit_note' }); setConfirm(false); setAllowPreview(false) }
    window.addEventListener('weibiye:memory-invalidated', clear)
    return () => { alive.current = false; window.removeEventListener('weibiye:memory-invalidated', clear) }
  }, [])
  useEffect(() => {
    if (!shown) return
    const expires = Date.parse(shown.expires_at)
    const expire = () => {
      if (Date.now() < expires) return
      version.current++; setShown(null); setCandidate(null)
      setDraft({ title: '', content: '', category: 'explicit_note' })
      setConfirm(false); setAllowPreview(false)
      setFailure('预览已到期，临时内容已清除。若愿意，可以重新预览。')
    }
    const timer = window.setTimeout(expire, Math.max(0, expires - Date.now()))
    window.addEventListener('focus', expire)
    document.addEventListener('visibilitychange', expire)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', expire); document.removeEventListener('visibilitychange', expire) }
  }, [shown])
  function close() {
    version.current++; setOpen(false); setShown(null); setCandidate(null)
    setDraft({ title: '', content: '', category: 'explicit_note' }); setConfirm(false); setAllowPreview(false); setFailure('')
  }
  async function preview() {
    if (!allowPreview || busy) return
    const own = version.current
    setBusy(true); setFailure('')
    try {
      const result = await memory.preview(sessionId, [messageId])
      if (!alive.current || own !== version.current) return
      setShown(result)
      const first = result.candidates[0]
      if (first) {
        setCandidate(first); setDraft({ title: first.title, content: first.content, category: first.category, expires_at: first.suggested_expires_at })
      } else setFailure('这条消息暂时没有适合保存的候选。没有写入长期记忆。')
    } catch (cause) { if (alive.current && own === version.current) setFailure(errorMessage(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function save() {
    if (!shown || !candidate || !confirm || busy) return
    setBusy(true); setFailure('')
    try {
      await memory.confirmCandidate(shown, candidate, draft)
      if (!alive.current) return
      close(); setNote('已确认保存到当前账户的长期记忆。')
    } catch (cause) { if (alive.current) setFailure(errorMessage(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="chat-memory-action">
    <Button variant="ghost" className="remember-message" disabled={memory.unavailable || pet?.status === 'archived'} onClick={() => { setOpen(true); setNote(''); setFailure('') }}><BookHeart size={13} />记住这条</Button>
    {note && <span role="status">{note}</span>}
    {failure && !open && <ErrorState message={failure} />}
    <Modal open={open} onClose={close} title="记忆候选预览">
      {!memory.preferences?.long_term_memory_enabled ? <><p>长期记忆默认关闭。请先查看说明并主动开启，之后仍需要逐条确认保存。</p><Link to={memoryLink(petId)} className="button button-secondary" onClick={close}>查看长期记忆设置</Link></> : <>
        <p>只读取你选择的这条用户消息。候选来自本地原文摘录，尚未保存；不会自动扫描其他聊天，也没有调用真实模型。</p>
        {!candidate ? <><label className="memory-check"><input type="checkbox" checked={allowPreview} onChange={(event) => setAllowPreview(event.target.checked)} />允许为这条消息生成临时记忆候选</label><Button disabled={!allowPreview || busy || memory.pending || memory.syncing} onClick={() => void preview()}>{busy ? '正在预览…' : '预览候选'}</Button></> : <form onSubmit={(event) => { event.preventDefault(); void save() }} className="memory-form">
          <p className="memory-hint">以下内容由你最后确认。预览回执五分钟失效，保存时会重新校验来源和授权。</p>
          <FormField label="候选标题" required value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.target.value }); setConfirm(false) }} />
          <div className="form-field"><label htmlFor={contentId}>候选内容</label><textarea id={contentId} required rows={4} value={draft.content} onChange={(event) => { setDraft({ ...draft, content: event.target.value }); setConfirm(false) }} /></div>
          <div className="form-field"><label htmlFor={categoryId}>候选类别</label><select id={categoryId} value={draft.category} onChange={(event) => { setDraft({ ...draft, category: event.target.value as MemoryContent['category'] }); setConfirm(false) }}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <p className="memory-hint">来源：当前账户选择的用户消息。有效期至 {draft.expires_at ? new Date(draft.expires_at).toLocaleDateString() : '按类别设置'}。</p>
          <label className="memory-check"><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />我已确认这条内容，并允许保存为长期记忆</label>
          <Button type="submit" disabled={!confirm || busy || memory.pending || memory.syncing || !draft.title.trim() || [...draft.title.trim()].length > 80 || !draft.content.trim() || [...draft.content.trim()].length > 1000}>{busy ? '正在确认…' : '确认保存这条记忆'}</Button>
        </form>}
      </>}
      {failure && <ErrorState message={failure} />}
    </Modal>
  </div>
}

export function MessageMemoryReferences({ sessionId, generationId }: { sessionId: string; generationId: string }) {
  const { petId } = usePet()
  const { generationRefs, preferences, unavailable } = useMemory()
  const [refs, setRefs] = useState<MemoryReferences | null>(null)
  const [revision, setRevision] = useState(0)
  const epoch = useRef(0)
  useEffect(() => {
    const clear = () => { epoch.current++; setRefs(null); setRevision((value) => value + 1) }
    window.addEventListener('weibiye:memory-invalidated', clear)
    return () => window.removeEventListener('weibiye:memory-invalidated', clear)
  }, [])
  useEffect(() => {
    let active = true
    const own = epoch.current
    if (!preferences || unavailable) return
    void generationRefs(sessionId, generationId).then((data) => { if (active && own === epoch.current) setRefs(data) }).catch(() => { if (active && own === epoch.current) setRefs(null) })
    return () => { active = false }
  }, [generationRefs, sessionId, generationId, preferences?.privacy_epoch, preferences, revision, unavailable])
  if (!preferences || unavailable || !refs?.items.length) return null
  const available = refs.items.filter((item) => item.availability === 'available').length
  return <p className="memory-reference-note"><BookHeart size={13} />本次 Mock 上下文曾参考 {refs.items.length} 条授权记忆{available < refs.items.length ? '，其中部分已失效' : ''}。<Link to={memoryLink(petId)}>查看记忆管理</Link></p>
}
