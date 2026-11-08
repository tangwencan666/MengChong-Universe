import { useEffect, useRef, useState } from 'react'
import { Button, Card, Modal } from '../../components/ui'
import type { DesktopBridge } from '../desktop/bridge'
import { speciesName } from '../p85/instances'
import { acceptSociety, actionNames, eventNames, moodNames } from './society'
import type { SharedEvent, SocialAction, SocialSettings, SocietyEnvelope } from './society'
import './society.css'
import { AlarmClock, Check, ChevronRight, CirclePause } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { Link } from 'react-router'

export function SocietyPanel({ owner, bridge, names, visibleIds, compact = false }: { owner: string; bridge: DesktopBridge | undefined; names: { pet_instance_id: string; name: string }[]; visibleIds: string[]; compact?: boolean }) {
  const [value, setValue] = useState<SocietyEnvelope | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<SharedEvent | null>(null), [history, setHistory] = useState(false), [allPets, setAllPets] = useState(false)
  const alive = useRef(true), locked = useRef(false), pending = useRef<{ id: string; action: SocialAction; key: string; version: number } | null>(null)
  const { hash } = useLocation(), navigate = useNavigate(), ready = Boolean(value?.state)
  useEffect(() => {
    if (!['#desktop-interactions', '#pet-relations', '#shared-events'].includes(hash)) return
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(hash.slice(1))
      if (element instanceof HTMLDetailsElement) element.open = true
      element?.scrollIntoView({ block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [hash, ready])
  useEffect(() => {
    alive.current = true
    const receive = (v: SocietyEnvelope) => { if (alive.current && v.owner_id === owner) { try { setValue(acceptSociety(v, owner)); setError('') } catch { setError('桌面事件暂时无法验证。') } } }
    const unsubscribe = bridge?.onSociety?.(receive)
    void bridge?.society?.(owner).then(receive).catch(() => { if (alive.current) setError('社会状态尚未就绪，可放出宠物后刷新。') })
    return () => { alive.current = false; unsubscribe?.() }
  }, [bridge, owner])
  if (!bridge?.society) return null
  const state = value?.state
  const showHistory = history || hash === '#shared-events'
  const label = (id: string) => `${names.find(p => p.pet_instance_id === id)?.name ?? speciesName(state?.pets.find(p => p.id === id)?.species ?? '')} · ${id.slice(0, 8)}`
  async function run(send: () => Promise<SocietyEnvelope>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { const v = await send(); if (alive.current) { setValue(acceptSociety(v, owner)); pending.current = null; setRemove(null) } }
    catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : '请刷新后再试。')
        const v = await bridge?.society?.(owner).catch(() => null)
        if (v && alive.current) { setValue(acceptSociety(v, owner)); if (pending.current && (v.state?.ledger.some(l => l.request === pending.current?.key) || v.state?.revision !== pending.current.version)) pending.current = null }
      }
    } finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  const settings = (patch: Partial<SocialSettings>) => { if (bridge.socialSettings) void run(() => bridge.socialSettings!(owner, patch)) }
  function quietFor(clickedAt: number, minutes: number) { settings({ quiet_until: Math.round(performance.timeOrigin + clickedAt) + minutes * 60000 }) }
  function interact(id: string, action: SocialAction) {
    if (!state || !bridge?.socialAction) return
    if (!pending.current || pending.current.id !== id || pending.current.action !== action) pending.current = { id, action, key: crypto.randomUUID(), version: state.revision }
    const operation = pending.current
    void run(() => bridge.socialAction!(owner, id, action, operation.key, operation.version))
  }
  if (compact) return <Card className="p863-life" id="desktop-interactions"><h2><AlarmClock size={25} />伙伴们，自己去溜达吧</h2>
    <p>{state?.settings.quiet_until && state.settings.quiet_until > state.at ? '伙伴们正在安静休息。' : state?.settings.enabled ? '自主互动已开启。心情藏在动作里，想听它们说说近况，就点宠物聊聊。' : '自主互动已暂停。你仍可随时点宠物聊天。'}</p>
    <div className="pet-actions"><Button disabled={busy || !state} variant="secondary" onClick={event => quietFor(event.timeStamp, 1)}>全部安静一分钟</Button><Link className="button button-ghost" to="/me#pet-social">互动偏好与隐私</Link></div>
    {(error || value?.error) && <p role="alert">{error || value?.error}</p>}
  </Card>
  return <Card className="p86-society" id="desktop-interactions" data-testid="pet-society">
    <h2><AlarmClock size={26} />桌面伙伴的小日子</h2>
    {error && <p role="alert">{error}</p>}{value?.error && <p role="alert">{value.error}</p>}
    {!state ? <p>放出伙伴后，可在这里查看心情、关系和共同事件。</p> : <>
      <div className="p862-social-overview"><div className="p862-feature-chips">{[['自主活动', state.settings.enabled], ['轻松争执', state.settings.conflicts], ['结伴玩耍', state.settings.enabled], ['情绪变化', true], ['事件记忆', true]].map(([title, enabled]) => <span className={enabled ? 'is-enabled' : ''} key={String(title)}><Check size={14} />{title}</span>)}</div><Button disabled={busy} onClick={event => quietFor(event.timeStamp, 1)}><CirclePause size={17} />全部安静一分钟</Button></div>
      <p className="p862-frequency">当前互动频率：{state.settings.frequency === 'normal' ? '低频' : '更安静'}{state.settings.quiet_until > state.at ? ' · 暂时安静中' : ''} · 本地规则，不消耗模型 Token</p>
      <details className="p862-social-settings"><summary>互动设置 · 社交、气泡与静音</summary>
      <div className="p86-controls">
        {(['enabled', 'conflicts', 'bubbles', 'muted'] as const).map(key => <Button key={key} variant="ghost" disabled={busy} aria-pressed={state.settings[key]} onClick={() => settings({ [key]: !state.settings[key] })}>{{ enabled: '自主社交', conflicts: '轻松争执', bubbles: '社交气泡', muted: '社交静音' }[key]}{state.settings[key] ? '已开启' : '已关闭'}</Button>)}
        <Button variant="ghost" disabled={busy} onClick={() => settings({ frequency: state.settings.frequency === 'normal' ? 'rare' : 'normal' })}>频率：{state.settings.frequency === 'normal' ? '低频' : '更安静'}</Button>
        <Button disabled={busy} onClick={event => quietFor(event.timeStamp, 10)}>全部安静十分钟</Button>
        {state.settings.quiet_until > state.at && <Button variant="ghost" disabled={busy} onClick={() => settings({ quiet_until: 0 })}>恢复自主活动</Button>}
      </div>
      </details>
      <details className="p862-feature-row" id="pet-moods"><summary><ChevronRight size={21} /><span>查看心情与免费互动<small>抚摸、安慰、免费投喂，随时陪伴</small></span></summary><Button variant="ghost" onClick={() => setAllPets(!allPets)}>{allPets ? '只看桌面伙伴' : '查看所有本地伙伴'}</Button><div className="p86-pets">{state.pets.filter(p => allPets || visibleIds.includes(p.id)).map(p => <section data-social-pet={p.id} key={p.id}>
        <h3>{label(p.id)}</h3><p data-mood={p.mood}>心情：{moodNames[p.mood]}</p>
        <div className="p86-needs">{([['energy', '精力'], ['hunger', '饥饿'], ['boredom', '无聊'], ['social', '想找伙伴']] as const).map(([key, title]) => <span key={key}>{title} <meter min={0} max={100} value={p.needs[key]} /> {Math.round(p.needs[key])}</span>)}</div>
        <div className="p86-controls">{(Object.keys(actionNames) as SocialAction[]).map(action => <Button key={action} variant="ghost" disabled={busy || (['mediate', 'support'].includes(action) && !p.current_event)} onClick={() => interact(p.id, action)}>{actionNames[action]}</Button>)}</div>
      </section>)}</div></details>
      <details className="p862-feature-row" id="pet-relations"><summary><ChevronRight size={21} /><span>查看伙伴关系<small>查看共同事件、亲密度与小团体</small></span></summary>{!state.relations.length ? <p>一起活动后会慢慢熟悉。</p> : <ul>{state.relations.map(r => <li key={r.pets.join(':')}>{r.pets.map(label).join(' ↔ ')}：{r.friend ? '朋友' : '慢慢熟悉'} · 好感 {Math.round(r.affinity)} · 信任 {Math.round(r.trust)} · 熟悉 {Math.round(r.familiarity)}{r.competition > 3 ? ' · 有点小竞争' : ''}{r.alliance_until > state.at ? ` · 暂时结伴至 ${new Date(r.alliance_until).toLocaleTimeString()}` : ''}</li>)}</ul>}</details>
      <details className="p862-feature-row"><summary><ChevronRight size={21} /><span>免费互动使用记录<small>已使用的安慰、投喂等互动记录</small></span></summary>{!state.ledger.length && <p>还没有免费互动记录。</p>}<ul>{state.ledger.slice(0, 20).map(l => <li key={l.request}>{label(l.pet)} · {actionNames[l.action]} · {l.consumed ? '免费提供并使用 1 份' : '免费互动'} · {new Date(l.at).toLocaleTimeString()}</li>)}</ul></details>
      <div className="p862-shared-events" id="shared-events"><Button variant="ghost" onClick={() => { setHistory(!showHistory); if (hash === '#shared-events') void navigate('/companions', { replace: true }) }}><ChevronRight size={21} />{showHistory ? '收起共同事件' : '查看共同事件'}</Button>
      {showHistory && <div className="p86-events">{!state.events.length && <p>一起活动后，实际发生的共同事件会记录在这里。</p>}{state.events.map(e => <article data-social-event={e.id} key={e.id}><strong>{eventNames[e.kind] ?? '桌面事件'}</strong> · {e.participants.map(label).join('、')}<p>{new Date(e.started_at).toLocaleTimeString()} · {e.ended_at ? '已结束' : '正在发生'} · {e.user_actions.length ? '用户参与' : '本地自主活动'}</p><Button variant="ghost" disabled={busy} onClick={() => setRemove(e)}>删除这条事件</Button></article>)}</div>}</div>
    </>}
    <Button variant="ghost" disabled={busy} onClick={() => void run(() => bridge.society!(owner))}>刷新伙伴状态</Button>
    <p className="memory-fine-print">保留最近 200 条本地共同事件，仅参与宠物可查询。这些记录当前不提供给 AI 聊天，私人授权记忆仍在原入口。安慰始终免费，免费道具无真实余额或付款。</p>
    <Modal open={!!remove} title="删除共同事件记录" onClose={() => setRemove(null)}>{remove && <><p>移除这条事件及参与者引用；不清空聊天、私人记忆，也不追溯重置关系数值。</p><Button disabled={busy} onClick={() => void run(() => bridge.deleteSocialEvent!(owner, remove.id))}>确认删除此事件</Button><Button variant="ghost" onClick={() => setRemove(null)}>保留事件</Button></>}</Modal>
  </Card>
}
