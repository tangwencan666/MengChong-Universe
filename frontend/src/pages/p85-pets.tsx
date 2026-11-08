import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Button, Card, EmptyState, ErrorState, FormField, Loading, Modal } from '../components/ui'
import { useAuth } from '../features/auth/context'
import { chatHome, memoryLink } from '../features/pets/scope'
import { AdoptionPanel } from '../features/p85/AdoptionPanel'
import { instancesApi } from '../features/p85/api'
import { retentionNotice, speciesName } from '../features/p85/instances'
import type { PetInstance } from '../features/p85/instances'
import { useDesktop } from '../features/p85/useDesktop'
import { errorMessage } from '../lib/api'
import './p85-pets.css'
import { appearanceFor, availableViews } from '../features/p85/appearances'
import { SocietyPanel } from '../features/p86/SocietyPanel'
import { Layers3, RotateCcw, Upload } from 'lucide-react'
import { ProjectIntro } from '../features/p862/ProjectIntro'
import { PetPortrait } from '../features/p862/PetPortrait'
import { DesktopChooser } from '../features/p863/DesktopChooser'
import { desktopChoice } from '../features/p863/selection'
import '../features/p863/immersive.css'

export function P85PetsPage() {
  const { user, scopeVersion } = useAuth()
  return user ? <Instances key={`${user.id}:${scopeVersion}`} owner={user.id} /> : null
}
function Editor({ pet, busy, save }: { pet: PetInstance; busy: boolean; save: (name: string, persona: PetInstance['persona_config']) => void }) {
  const [name, setName] = useState(pet.name), [persona, setPersona] = useState({ ...pet.persona_config })
  return <form className="memory-form" onSubmit={event => { event.preventDefault(); save(name.trim(), persona) }}>
    <p>种类：{speciesName(pet.species_id)} · 实例 {pet.pet_instance_id.slice(0, 8)}。更名不会更换身份、聊天或记忆。</p>
    <FormField label="宠物名字" value={name} onChange={event => setName(event.target.value)} required maxLength={60} />
    <label>人格说明<textarea aria-label="人格说明" value={persona.description} maxLength={600} rows={4} onChange={event => setPersona({ ...persona, description: event.target.value })} /></label>
    <label>交流风格<select aria-label="交流风格" value={persona.tone} onChange={event => setPersona({ ...persona, tone: event.target.value as PetInstance['persona_config']['tone'] })}><option value="warm">温和</option><option value="playful">活泼</option><option value="calm">平静</option></select></label>
    <Button type="submit" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存名字与人格'}</Button>
  </form>
}
function Instances({ owner }: { owner: string }) {
  const queries = useQueryClient(), scope = ['p85-instances', owner]
  const { bridge, pets: desktop, layout } = useDesktop(owner)
  const limit = layout?.max_visible ?? 5
  const visible = desktop.filter(pet => !pet.hidden)
  const [status, setStatus] = useState<PetInstance['status']>('active'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [editor, setEditor] = useState<PetInstance | null>(null), [details, setDetails] = useState<PetInstance | null>(null)
  const [removal, setRemoval] = useState<PetInstance | null>(null), [step, setStep] = useState(1), [agreed, setAgreed] = useState(false)
  const [notice, setNotice] = useState('')
  const operation = useRef<AbortController | null>(null), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current?.abort() } }, [])
  const list = useInfiniteQuery({ queryKey: [...scope, status], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => instancesApi.list(owner, status, pageParam, signal), retry: false,
    getNextPageParam: page => page.has_more ? page.next_cursor ?? undefined : undefined })
  const selectable = useInfiniteQuery({ queryKey: [...scope, 'active'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => instancesApi.list(owner, 'active', pageParam, signal), retry: false,
    getNextPageParam: page => page.has_more ? page.next_cursor ?? undefined : undefined })
  async function action(send: (signal: AbortSignal) => Promise<unknown>) {
    if (operation.current) return
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError('')
    try {
      await send(controller.signal)
      if (!alive.current || controller.signal.aborted) return
      setEditor(null); setRemoval(null)
      await queries.invalidateQueries({ queryKey: scope })
      await bridge?.syncSession().catch(() => {})
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) {
        setError(errorMessage(cause))
        await bridge?.syncSession().catch(() => {})
      }
    }
    finally { if (alive.current) { operation.current = null; setBusy(false) } }
  }
  const items = list.data?.pages.flatMap(page => page.items) ?? []
  const candidates = selectable.data?.pages.flatMap(page => page.items) ?? []
  function choose(id: string) {
    if (!bridge || operation.current) return
    const intent = desktopChoice(id, desktop, limit)
    if (intent === 'limit') { setNotice('桌面最多同时显示 5 只伙伴，点一只已选伙伴收回后再试。'); return }
    setNotice('')
    void action(() => bridge[intent](id))
  }
  return <div className="p862-dashboard"><div className="page-stack p85-management">
    <div className="page-title"><div><h1>我的宠物</h1><p>相同种类，各自生活。收回只离开桌面，不删除记录。</p></div></div>
    <Card className="p862-combination"><div className="p862-card-heading"><h2><Layers3 size={26} />桌面组合 <span className="p862-count" aria-label={`当前桌面显示 ${visible.length} 只，上限 ${limit} 只`}>{visible.length} / {limit}</span></h2><p>{bridge ? `桌面显示 ${visible.length} / ${limit} 只，另有 ${desktop.length - visible.length} 只隐藏。` : 'Windows 客户端支持同时显示五只宠物'}</p></div>
      <p className="p863-choice-hint">点选想一起溜达的伙伴，再点一次收回。每只伙伴都有独立身份。</p>
      {bridge ? <DesktopChooser pets={candidates} desktop={desktop} busy={busy} limit={limit} choose={choose} /> : <p>请在 Windows 客户端召唤桌面伙伴；网页仍可聊天、领养和管理数据。</p>}
      {selectable.isPending && <Loading message="读取已领养伙伴…" />}{selectable.isError && <ErrorState message={errorMessage(selectable.error)} onRetry={() => void selectable.refetch()} />}
      {selectable.hasNextPage && <Button variant="ghost" disabled={selectable.isFetchingNextPage} onClick={() => void selectable.fetchNextPage()}>更多已领养伙伴</Button>}
      {notice && <p role="status" className="p863-light-notice">{notice}</p>}{error && <ErrorState message={error} />}
      {bridge && visible.length >= limit && <p role="status">桌面已达到 {limit} 只上限，请先隐藏或收回任意一只，再召唤其他伙伴。</p>}
      {bridge && <div className="pet-actions"><Button variant="secondary" disabled={busy || !desktop.length || !bridge.recallAll} onClick={() => void action(() => bridge.recallAll!(owner))}><Upload size={18} />一键收回全部</Button><Button variant="secondary" disabled={busy || desktop.length > 0 || !layout?.restore_available || !bridge.restoreCombination} onClick={() => void action(() => bridge.restoreCombination!(owner))}><RotateCcw size={18} />恢复上次桌面组合</Button></div>}
      <p className="memory-fine-print">可直接召唤列表中的任意伙伴；隐藏不占显示名额。重启后登录原账号，恢复对应实例与位置。</p>
      <p className="memory-fine-print">收回会关闭对应聊天窗口；记录保留，请先保存未发送的草稿。</p>
      {layout?.reduced_motion && <p role="status">资源保护已开启：暂缓新增窗口，暂停随机互动和自主移动；已有聊天、收回及退出仍可使用。</p>}
      {!!layout?.skipped_count && <p role="status">有 {layout.skipped_count} 只因归档、无法访问或资源限制而未恢复；其他实例不受影响。</p>}
    </Card>
    <SocietyPanel compact owner={owner} bridge={bridge} names={candidates} visibleIds={visible.map(p => p.pet_id)} />
    <details className="p863-manage-details"><summary>宠物资料与隐私管理</summary><section id="owned-pets" aria-label="已领养宠物"><h2>已领养的伙伴</h2>
      <div className="pet-filters">{(['active', 'hidden', 'archived'] as const).map(value => <Button key={value} variant={value === status ? 'primary' : 'ghost'} aria-pressed={value === status} onClick={() => setStatus(value)}>{{ active: '我的伙伴', hidden: '已隐藏', archived: '已删除 / 归档' }[value]}</Button>)}</div>
      {error && <ErrorState message={error} />}
      {list.isPending ? <Loading message="读取宠物实例…" /> : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} /> : !items.length ? <Card><EmptyState title="暂无此类宠物" description="从上方选择一种伙伴开始领养。" /></Card> : <div className="pet-grid">{items.map(pet => {
        const current = desktop.find(value => value.pet_id === pet.pet_instance_id)
        return <Card key={pet.pet_instance_id} className="pet-card">
          <PetPortrait key={pet.appearance_id} species={pet.species_id} appearance={pet.appearance_id} name={pet.name} />
          <h3>{pet.name}</h3><p>{speciesName(pet.species_id)} · 实例 {pet.pet_instance_id.slice(0, 8)}{pet.species_source === 'legacy_role' ? ' · 旧版兼容外观' : ''}</p><p>{pet.persona_config.description || '独立的桌面伙伴'}</p>
          <div className="pet-actions"><Link className="button button-primary" to={chatHome(pet.pet_instance_id)}>{pet.status === 'archived' ? '查看聊天记录' : '开始聊天'}</Link><Link className="button button-ghost" to={memoryLink(pet.pet_instance_id)}>专属记忆</Link><Button variant="ghost" onClick={() => setDetails(pet)}>基本资料</Button></div>
          {pet.status !== 'archived' && <div className="pet-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setEditor(pet)}>重命名与人格</Button>
            {bridge && (!current ? <Button disabled={busy || visible.length >= limit} onClick={() => void action(() => bridge.release(pet.pet_instance_id))}>召唤到桌面</Button> : <><Button variant="ghost" disabled={busy || (current.hidden && visible.length >= limit)} onClick={() => void action(() => current.hidden ? bridge.show(pet.pet_instance_id) : bridge.hide(pet.pet_instance_id))}>{current.hidden ? '显示桌宠' : '隐藏桌宠'}</Button><Button variant="ghost" disabled={busy} onClick={() => void action(() => bridge.recall(pet.pet_instance_id))}>收回桌宠</Button></>)}
            <Button variant="ghost" disabled={busy} onClick={() => { setRemoval(pet); setStep(1); setAgreed(false); setError('') }}>删除宠物</Button>
          </div>}
        </Card>
      })}</div>}
      {list.hasNextPage && <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>更多宠物</Button>}
      <p className="memory-fine-print">旧版聊天与账户记忆仍在原入口，不自动分配给任何新宠物。当前外观含原创占位素材，本地角色预览仍按单个实例授权。</p>
    </section></details>
    <details className="p863-manage-details"><summary>领养新伙伴 · 八种角色可重复领养</summary><AdoptionPanel onAdopt={() => { setStatus('active'); void queries.invalidateQueries({ queryKey: scope }) }} />
    <Link className="button button-secondary" to="/pet-catalog">八种伙伴 · 选择宠物模板</Link></details>
    <Modal open={!!editor} title="重命名与独立人格" onClose={() => { if (!busy) setEditor(null) }}>{editor && <Editor key={`${editor.pet_instance_id}:${editor.version}`} pet={editor} busy={busy} save={(name, persona) => void action(signal => instancesApi.edit(owner, editor, name, persona, signal))} />}</Modal>
    <Modal open={!!details} title="宠物实例资料" onClose={() => setDetails(null)}>{details && <dl><dt>名字</dt><dd>{details.name}</dd><dt>种类 species_id</dt><dd>{details.species_id}</dd><dt>独立身份 pet_instance_id</dt><dd className="p85-identity">{details.pet_instance_id}</dd><dt>所属用户 owner_user_id</dt><dd className="p85-identity">{details.owner_user_id}</dd><dt>外观 appearance_id</dt><dd>{details.appearance_id} · {availableViews(details.species_id, details.appearance_id).join('、')}</dd><dt>当前独立人格快照</dt><dd>{details.personality_snapshot.description} · {details.personality_snapshot.tone} · 配置版本 {details.personality_snapshot_version}</dd><dt>素材限制</dt><dd>{appearanceFor(details.species_id, details.appearance_id).quality_notes.join(' ') || '沿用原有素材与动作。'}</dd><dt>状态 / 配置版本</dt><dd>{details.status} / {details.version}</dd><dt>领养时间</dt><dd>{new Date(details.created_at).toLocaleString()}</dd></dl>}</Modal>
    <Modal open={!!removal} title={step === 1 ? '删除前请确认数据处理' : '再次确认删除此实例'} onClose={() => { if (!busy) setRemoval(null) }}>
      {removal && <><p>{removal.name} · {speciesName(removal.species_id)}</p><p className="p85-identity">实例：{removal.pet_instance_id}</p><ul><li><strong>宠物实例：</strong>{retentionNotice.instance}</li><li><strong>聊天记录：</strong>{retentionNotice.chat}</li><li><strong>长期记忆：</strong>{retentionNotice.memory}</li></ul>
        {step === 1 ? <Button onClick={() => setStep(2)}>继续确认删除</Button> : <><label className="p85-confirm"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />我确认仅归档上述实例，并保留聊天和长期记忆，理解归档不可撤销。</label><Button disabled={!agreed || busy} onClick={() => void action(signal => instancesApi.remove(owner, removal, signal))}>{busy ? '处理中…' : '确认删除并归档'}</Button></>}
        <Button variant="ghost" disabled={busy} onClick={() => setRemoval(null)}>取消，保留宠物</Button>{error && <ErrorState message={error} />}</>}
    </Modal>
  </div><ProjectIntro /></div>
}
