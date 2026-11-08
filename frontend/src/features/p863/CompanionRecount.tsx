import { useEffect, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { useParams } from 'react-router'
import { useAuth } from '../auth/context'
import { desktopBridge } from '../desktop/bridge'
import { moodNames, readContext, readContextChange } from './context'
import type { CompanionContext, ContextChange, PetMood } from './context'
import './immersive.css'

export function CompanionRecount({ sessionId }: { sessionId?: string }) {
  const { petId } = useParams()
  const { user, scopeVersion } = useAuth()
  return user && petId ? <Recount key={`${user.id}:${scopeVersion}:${petId}:${sessionId ?? ''}`} owner={user.id} pet={petId} session={sessionId ?? null} /> : null
}

function Recount({ owner, pet, session }: { owner: string; pet: string; session: string | null }) {
  const bridge = desktopBridge()
  const [feeling, setFeeling] = useState<PetMood | null>(null)
  const [story, setStory] = useState<CompanionContext['story']>(null)
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)
  const request = useRef<(mode: 'peek' | 'recount') => void>(() => {})
  useEffect(() => {
    if (!bridge?.companionContext) return
    let active = true, pending = false, revision = 0, latest: ContextChange | null = null
    async function load(mode: 'peek' | 'recount') {
      if (pending) return
      pending = true; const current = revision
      if (mode === 'recount') setBusy(true)
      try {
        const value = readContext(await bridge!.companionContext!(pet, session, mode), owner, pet, session)
        if (!active || (current !== revision && !latest)) return
        setVerified(true)
        const permitted = current === revision ? value.source_event_ids : latest!.event_ids
        const nextStory = value.story && permitted.includes(value.story.event_id) ? value.story : null
        setFeeling(current === revision ? value.mood : latest!.mood)
        setStory(previous => nextStory ?? (previous && permitted.includes(previous.event_id) ? previous : null))
        if (mode === 'recount') setNote(nextStory ? '' : ({ cooldown: '刚聊过这件小事，先聊聊别的吧。', 'already-shared': '最近的共同经历已经和你分享过了。', 'no-event': '还没有可以分享的共同经历，想聊聊今天吗？' }[value.reason] ?? '桌面小记暂时不可用，正常聊天不受影响。'))
      } catch {
        if (active) { setVerified(false); setStory(null); setFeeling(null); setNote('暂时无法确认桌面小记，正常聊天不受影响。') }
      } finally { pending = false; if (active) setBusy(false) }
    }
    request.current = mode => { void load(mode) }
    const off = bridge.onCompanionContext?.(raw => {
      const change = readContextChange(raw, owner, pet)
      // Reconcile an in-flight response against newer permissions without polling.
      revision += 1; latest = change
      if (!change) { setVerified(false); setStory(null); setFeeling(null); return }
      setFeeling(change.mood)
      setStory(previous => previous && change.event_ids.includes(previous.event_id) ? previous : null)
    })
    const focus = () => { void load('peek') }
    window.addEventListener('focus', focus)
    void load('peek')
    return () => { active = false; request.current = () => {}; off?.(); window.removeEventListener('focus', focus) }
  }, [bridge, owner, pet, session])
  if (!bridge?.companionContext || !verified) return null
  return <aside className="p863-recount" aria-label="宠物桌面小记">
    <div><span>{feeling ? `现在${moodNames[feeling]}` : '桌面小记'}</span><button type="button" disabled={busy} onClick={() => request.current('recount')}><MessageCircle size={16} />{busy ? '想一想…' : '最近和伙伴怎么样？'}</button></div>
    {story && <p data-event-id={story.event_id}>{story.text}</p>}
    {note && <p role="status">{note}</p>}
    <small>本地共同事件 · 不计费 · 不写入 AI 聊天或长期记忆</small>
  </aside>
}
