import { useEffect, useId, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { PawPrint, Plus } from 'lucide-react'
import { Button, Card, EmptyState, ErrorState, FormField, Loading, Modal } from '../components/ui'
import { petsApi } from '../features/pets/api'
import type { Pet, PetConfig } from '../features/pets/api'
import { useAuth } from '../features/auth/context'
import { errorMessage } from '../lib/api'
import { chatHome, memoryLink } from '../features/pets/scope'
import { desktopBridge } from '../features/desktop/bridge'
import { DesktopPetControls } from '../features/desktop/DesktopPetControls'
import { P85PetsPage } from './p85-pets'

const initial: PetConfig = { name: '', role_type: 'custom', persona_config: { description: '', tone: 'warm' }, appearance_config: { asset_id: 'pet-default', tint: '#7E9F84', scale: 1 } }
function PetEditor({ value, busy, save }: { value?: Pet; busy: boolean; save: (config: PetConfig) => void }) {
  const [config, setConfig] = useState<PetConfig>(value ? { name: value.name, role_type: value.role_type, persona_config: value.persona_config, appearance_config: value.appearance_config } : initial)
  const id = useId()
  return <form className="memory-form" onSubmit={(event) => { event.preventDefault(); save(config) }}>
    <FormField label="宠物名字" required maxLength={60} value={config.name} onChange={(event) => setConfig({ ...config, name: event.target.value })} />
    <div className="form-field"><label htmlFor={`${id}-type`}>角色类型</label><select id={`${id}-type`} value={config.role_type} onChange={(event) => setConfig({ ...config, role_type: event.target.value as PetConfig['role_type'] })}><option value="cat">猫咪</option><option value="dog">小狗</option><option value="custom">自定义伙伴</option></select></div>
    <div className="form-field"><label htmlFor={`${id}-tone`}>交流风格</label><select id={`${id}-tone`} value={config.persona_config.tone} onChange={(event) => setConfig({ ...config, persona_config: { ...config.persona_config, tone: event.target.value as PetConfig['persona_config']['tone'] } })}><option value="warm">温和</option><option value="playful">活泼</option><option value="calm">平静</option></select></div>
    <div className="form-field"><label htmlFor={`${id}-persona`}>人格说明</label><textarea id={`${id}-persona`} rows={3} maxLength={600} value={config.persona_config.description} onChange={(event) => setConfig({ ...config, persona_config: { ...config.persona_config, description: event.target.value } })} /><small>用简短的话描述这个伙伴。不会改变安全规则或自动保存聊天。</small></div>
    <FormField label="外观颜色" type="color" value={config.appearance_config.tint} onChange={(event) => setConfig({ ...config, appearance_config: { ...config.appearance_config, tint: event.target.value } })} />
    <p className="memory-fine-print">当前使用原创简约外观。完整 Live2D 和公开下载安装尚未开放；聊天模型由服务端配置。</p>
    <Button type="submit" disabled={busy || !config.name.trim()}>{busy ? '正在确认…' : value ? '保存宠物设置' : '创建宠物'}</Button>
  </form>
}

export function LegacyCompanionsPage() {
  const { user, scopeVersion } = useAuth()
  const queries = useQueryClient()
  const [status, setStatus] = useState<Pet['status']>('active')
  const [editor, setEditor] = useState<Pet | 'new' | null>(null)
  const [archive, setArchive] = useState<Pet | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scope = ['pets', user?.id, scopeVersion]
  const operations = useRef(new Set<AbortController>())
  const alive = useRef(true)
  const intent = useRef<{ payload: string; key: string } | null>(null)
  useEffect(() => { alive.current = true; const active = operations.current; return () => { alive.current = false; for (const controller of active) controller.abort(); active.clear() } }, [])
  const list = useInfiniteQuery({ queryKey: [...scope, status], initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => petsApi.list(status, pageParam, signal), retry: false,
    getNextPageParam: (page) => page.has_more ? page.next_cursor ?? undefined : undefined })
  async function action(send: (signal: AbortSignal) => Promise<unknown>) {
    if (busy) return
    const controller = new AbortController(); operations.current.add(controller)
    setBusy(true); setError('')
    try { await send(controller.signal); if (!alive.current) return; setEditor(null); setArchive(null); intent.current = null; await queries.invalidateQueries({ queryKey: scope }) }
    catch (cause) { if (alive.current && !controller.signal.aborted) setError(errorMessage(cause)) }
    finally { operations.current.delete(controller); if (alive.current) setBusy(false) }
  }
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  return <>
    <div className="page-title"><div><span className="eyebrow">YOUR PETS</span><h1>我的宠物<span className="title-dot">.</span></h1><p>每个伙伴，都有自己的故事和记忆。</p></div><Button onClick={() => { setEditor('new'); setError('') }}><Plus size={17} />添加宠物</Button></div>
    <Card><p>宠物之间不共享私人聊天或长期记忆。旧版记录仍在<Link to="/">旧版聊天</Link>和<Link to="/memory">账户记忆</Link>中，不会自动分配给新宠物。</p><p className="memory-fine-print">聊天前可查看模型及费用说明 · {desktopBridge() ? '桌面预览：可以同时放出三只宠物，点击宠物即可聊天。隐藏或收回不删除聊天和记忆。' : 'Windows 桌面客户端提供本地预览，尚未公开发行。'}</p></Card>
    <div className="pet-filters" aria-label="宠物筛选">{(['active', 'hidden', 'archived'] as const).map((value) => <Button key={value} variant={status === value ? 'primary' : 'ghost'} aria-pressed={status === value} onClick={() => setStatus(value)}>{{ active: '我的伙伴', hidden: '已隐藏', archived: '已归档' }[value]}</Button>)}</div>
    {error && !editor && !archive && <ErrorState message={error} />}
    {list.isPending ? <Loading message="正在读取宠物…" /> : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} /> : !items.length ? <Card><EmptyState title="这里还没有宠物" description="想好名字后，可以创建一个自己的伙伴。" /></Card> : <div className="pet-grid">{items.map((pet) => <Card key={pet.pet_id} className="pet-card">
      <span className="welcome-sprout" style={{ color: pet.appearance_config.tint }}><PawPrint size={30} /></span><h2>{pet.name}</h2><p>{pet.persona_config.description || '一个可以随时聊聊的伙伴。'}</p><small>{pet.role_type} · {{ warm: '温和', playful: '活泼', calm: '平静' }[pet.persona_config.tone]}</small>
      <div className="pet-actions"><Link className="button button-primary" to={chatHome(pet.pet_id)}>{pet.status === 'archived' ? '查看聊天' : '开始聊天'}</Link><Link className="button button-ghost" to={memoryLink(pet.pet_id)}>专属记忆</Link></div>
      {pet.status !== 'archived' && <DesktopPetControls petId={pet.pet_id} />}
      {pet.status !== 'archived' && <div className="pet-actions"><Button variant="ghost" disabled={busy} onClick={() => { setEditor(pet); setError('') }}>编辑设置</Button><Button variant="ghost" disabled={busy} onClick={() => void action((signal) => petsApi.visibility(pet, pet.status !== 'hidden', signal))}>{pet.status === 'hidden' ? '取消隐藏' : '隐藏'}</Button><Button variant="ghost" disabled={busy} onClick={() => { setArchive(pet); setError('') }}>归档</Button></div>}
    </Card>)}</div>}
    {list.hasNextPage && <Button variant="ghost" onClick={() => void list.fetchNextPage()}>更多宠物</Button>}
    <Modal open={!!editor} title={editor === 'new' ? '添加宠物' : '编辑宠物'} onClose={() => { if (!busy) setEditor(null) }}>
      {editor && <PetEditor key={editor === 'new' ? 'new' : `${editor.pet_id}:${editor.version}`} value={editor === 'new' ? undefined : editor} busy={busy} save={(config) => void action((signal) => {
        if (editor !== 'new') return petsApi.edit(editor, config, signal)
        const payload = JSON.stringify(config)
        if (!intent.current || intent.current.payload !== payload) intent.current = { payload, key: crypto.randomUUID() }
        return petsApi.create(config, intent.current.key, signal)
      })} />}{error && <ErrorState message={error} />}
    </Modal>
    <Modal open={!!archive} title="归档这个伙伴？" onClose={() => { if (!busy) setArchive(null) }}><p>保留聊天与记忆供你查看；停止正在生成的回复，之后不能继续聊天或更改配置。仍可关闭记忆授权、撤销、删除或清空记忆。当前版本不提供取消归档。</p>{error && <ErrorState message={error} />}<Button disabled={busy} onClick={() => { if (archive) void action((signal) => petsApi.archive(archive, signal)) }}>确认归档</Button></Modal>
  </>
}

export function CompanionsPage() { return <P85PetsPage /> }
