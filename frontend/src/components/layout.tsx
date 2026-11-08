import { usePet } from '../features/pets/context'
import { chatHome, chatLink, memoryLink } from '../features/pets/scope'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router'
import { ArrowUpRight, BookHeart, CalendarDays, ChevronDown, CircleUserRound, Clock3, Coins, House, Info, Leaf, LogIn, Menu, MessageCircle, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, ShieldCheck, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { useAuth } from '../features/auth/context'
import { useChat } from '../features/chat/context'
import type { ChatSession } from '../features/chat/types'
import { useMediaQuery, useVisualViewport } from '../lib/viewport'
import { Button, ErrorState, FormField, Loading, Modal } from './ui'
import { errorMessage } from '../lib/api'
import { brand } from '../lib/brand'
import { navigationActive, petNavigation } from '../features/p862/navigation'
import { Landscape, SkyBackdrop } from '../features/p862/landscape'

const navigationIcons = { home: House, chat: MessageCircle, users: UsersRound, calendar: CalendarDays, settings: Settings }

export function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname, hash } = useLocation()
  return <nav className="navigation" aria-label="主导航">{petNavigation.map(({ to, title, icon }) => {
    const Icon = navigationIcons[icon], active = navigationActive(to, pathname, hash)
    return <Link key={to} to={to} title={title} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={active ? 'nav-link active' : 'nav-link'}>
      <Icon size={24} /><span className="sidebar-label">{title}</span>
    </Link>
  })}</nav>
}

function SidebarContent({ collapsed, onNavigate, onToggle, mobile = false }:
  { collapsed: boolean; onNavigate: () => void; onToggle: () => void; mobile?: boolean }) {
  const { petId } = usePet()
  const home = chatHome(petId)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { sessions, stopGeneration, deleteSession, privateChat } = useChat()
  const [historyOpen, setHistoryOpen] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [renaming, setRenaming] = useState<ChatSession | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const preparingRename = useRef(false)
  function leaveConversation() { if (!privateChat) void stopGeneration(); onNavigate() }
  function newChat() {
    leaveConversation()
    // Clear an existing blank-chat draft explicitly. Re-navigating the same
    // route can otherwise remount it after the user has started typing.
    window.dispatchEvent(new Event('weibiye:new-chat'))
    if (pathname !== home) navigate(home)
  }
  function renderSession(session: ChatSession) {
    const path = chatLink(session.id, petId)
    return <div className="history-row" key={session.id}>
      <Link to={path} onClick={leaveConversation} title={`${session.title}${session.source === 'demo' ? '（虚构演示）' : ''}`} aria-current={pathname === path ? 'page' : undefined} className="history-link"><MessageCircle size={14} /><span>{session.title}</span></Link>
      {privateChat && <button className="history-rename" disabled={busy} aria-label={`重命名会话：${session.title}`} onClick={() => {
        if (busy || preparingRename.current) return
        preparingRename.current = true; setBusy(true); setHistoryError('')
        void privateChat.prepareRename(session.id).then((fresh) => {
          setRenaming({ ...session, ...fresh }); setTitle(fresh.title)
        }).catch((cause: unknown) => {
          if (cause && typeof cause === 'object' && (('name' in cause && cause.name === 'AbortError')
            || ('code' in cause && cause.code === 'ERR_CANCELED'))) return
          setHistoryError(errorMessage(cause))
        }).finally(() => { preparingRename.current = false; setBusy(false) })
      }}><Pencil size={13} /></button>}
      <button className="history-delete" title={privateChat ? '删除已保存会话' : '删除本页会话'} disabled={busy} aria-label={`删除会话：${session.title}`} onClick={() => {
        setBusy(true); setHistoryError('')
        void Promise.resolve(deleteSession(session.id)).then(() => {
          if (window.location.pathname === path) navigate(home)
          onNavigate()
        }).catch((cause: unknown) => {
          if (cause && typeof cause === 'object' && (('name' in cause && cause.name === 'AbortError')
            || ('code' in cause && cause.code === 'ERR_CANCELED'))) return
          setHistoryError(errorMessage(cause))
        }).finally(() => setBusy(false))
      }}><Trash2 size={13} /></button>
    </div>
  }
  return <>
    <div className="sidebar-brand-row">
      <span className="sidebar-label p862-navigation-label">我的陪伴空间</span>
      {!collapsed && <Button className="sidebar-toggle icon-button" variant="ghost" onClick={onToggle} aria-label={mobile ? '关闭导航' : '收起侧边栏'} aria-controls={mobile ? 'mobile-sidebar' : 'desktop-sidebar'} aria-expanded={mobile ? undefined : true}>
        {mobile ? <X size={19} /> : <PanelLeftClose size={18} />}
      </Button>}
    </div>
    {collapsed && <Button className="sidebar-expand icon-button" variant="ghost" onClick={onToggle} aria-label="展开侧边栏" aria-controls="desktop-sidebar" aria-expanded={false}><PanelLeftOpen size={20} /></Button>}
    <Navigation onNavigate={leaveConversation} />
    <Button className="new-chat-button" variant="secondary" title="新建聊天" aria-label="新建聊天" onClick={newChat}><Plus size={19} /><span className="sidebar-label">新建聊天</span></Button>
    <div className="sidebar-middle">
      <div className="sidebar-history">
        <button className="history-toggle" title="历史会话" aria-expanded={!collapsed && historyOpen} onClick={() => {
          if (collapsed) { onToggle(); setHistoryOpen(true) } else setHistoryOpen((value) => !value)
        }}><Clock3 size={17} /><span className="sidebar-label">历史会话</span><ChevronDown className={`history-chevron sidebar-label ${historyOpen ? '' : 'closed'}`} size={14} /></button>
        {!collapsed && historyOpen && <nav className="history-list" aria-label="历史会话">
          <p className="history-caption">{privateChat ? petId ? '当前宠物 · 已保存的会话' : '旧版账户 · 已保存的会话' : '仅本页预览 · 刷新后清空'}</p>
          {privateChat?.historyLoading && <Loading message="正在加载历史…" />}
          {(historyError || privateChat?.historyError) && <><ErrorState message={historyError || privateChat?.historyError || ''} />{privateChat && <Button variant="ghost" onClick={privateChat.refreshHistory}>重新加载历史</Button>}</>}
          {sessions.filter((session) => session.source === 'server').map(renderSession)}
          {sessions.some((session) => session.source === 'local') && <span className="history-group">本页对话</span>}
          {sessions.filter((session) => session.source === 'local').map(renderSession)}
          {sessions.some((session) => session.source === 'demo') && <span className="history-group">演示会话 <span className="history-demo-badge">虚构</span></span>}
          {sessions.filter((session) => session.source === 'demo').map(renderSession)}
          {sessions.length === 0 && !privateChat?.historyLoading && !privateChat?.historyError && !historyError && <div className="history-empty"><span>{privateChat ? '还没有已保存的会话' : '还没有本页对话'}</span><small>想聊的时候，随时可以开始。</small></div>}
          {privateChat?.hasMoreSessions && <Button variant="ghost" onClick={privateChat.loadMoreSessions}>加载更多会话</Button>}
        </nav>}
      </div>
      <div className="sidebar-nav-divider" />
    </div>
    <div className="sidebar-utilities">
      <NavLink to={memoryLink(petId)} className="nav-link" title="记忆管理" onClick={leaveConversation}><BookHeart size={19} /><span className="sidebar-label">记忆管理</span></NavLink>
      <NavLink to="/welcome" className="nav-link" title={`关于${brand.name}`} onClick={leaveConversation}><Info size={19} /><span className="sidebar-label">关于{brand.name}</span></NavLink>
      {!petId && <NavLink to="/beta" className="nav-link" title="内测与反馈" onClick={leaveConversation}><Info size={19} /><span className="sidebar-label">内测与反馈</span></NavLink>}
      <p className="sidebar-signoff sidebar-label"><Leaf size={13} />慢慢来，也在向前。</p>
    </div>
    <div className="p862-sidebar-landscape"><Landscape trees /></div>
    {renaming && <Modal open onClose={() => setRenaming(null)} title="重命名会话"><form onSubmit={(event) => {
      event.preventDefault()
      if (!renaming || !privateChat || busy) return
      if (!Number.isInteger(renaming.version) || (renaming.version ?? 0) < 1) {
        setHistoryError('会话版本尚未确认，请重新加载历史后再试。'); privateChat.refreshHistory(); return
      }
      setBusy(true)
      void privateChat.rename(renaming.id, title, renaming.version!).then(() => setRenaming(null)).catch((cause: unknown) => setHistoryError(errorMessage(cause))).finally(() => setBusy(false))
    }}><FormField label="会话标题" value={title} onChange={(event) => setTitle(event.target.value)} />{historyError && <ErrorState message={historyError} />}<Button type="submit" disabled={busy || !title.trim()}>保存标题</Button></form></Modal>}
  </>
}

export function Sidebar({ collapsed, onToggle, open, onClose }:
  { collapsed: boolean; onToggle: () => void; open: boolean; onClose: () => void }) {
  const drawer = useRef<HTMLDialogElement>(null)
  const mobile = useMediaQuery('(max-width: 767px)')
  useEffect(() => {
    const element = drawer.current
    if (mobile && open && !element?.open) element?.showModal()
    if ((!mobile || !open) && element?.open) element.close()
  }, [mobile, open])
  useEffect(() => {
    if (!open || !mobile) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open, mobile])
  return <>
    <aside id="desktop-sidebar" className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="侧边栏">
      <SidebarContent collapsed={collapsed} onToggle={onToggle} onNavigate={() => undefined} />
    </aside>
    <dialog id="mobile-sidebar" ref={drawer} className="sidebar-drawer" aria-label="导航菜单" onClose={onClose} onCancel={onClose} onKeyDown={(event) => {
      if (event.key !== 'Tab') return
      const items = Array.from(drawer.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') ?? [])
        .filter((element) => element.getClientRects().length > 0)
      const first = items[0]
      const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }} onClick={(event) => {
      if (event.target === drawer.current && event.clientX > drawer.current.getBoundingClientRect().right) onClose()
    }}>
      <SidebarContent collapsed={false} mobile onToggle={onClose} onNavigate={onClose} />
    </dialog>
  </>
}

function AccountMenu() {
  const { petId } = usePet()
  const menu = useRef<HTMLDetailsElement>(null)
  const { previewIdentityId } = useChat()
  const { user } = useAuth()
  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false
        menu.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [])
  const close = () => { if (menu.current) menu.current.open = false }
  return <details className="account-menu" ref={menu}>
    <summary aria-label={user ? '账户头像，打开账户菜单' : '访客头像，打开账户菜单'}><span className="user-avatar"><CircleUserRound size={22} /></span><span className="account-name">{user?.display_name ?? '访客'}</span><ChevronDown size={12} /></summary>
    <nav className="account-dropdown" aria-label="账户选项">
      <div className="account-caption">{user ? user.display_name : '当前为访客预览'}<span>{user ? user.email : `演示访客 ${previewIdentityId === 'preview-a' ? 'A' : 'B'} · 仅本页预览`}</span></div>
      <Link to="/me" onClick={close}><CircleUserRound size={16} />个人中心</Link>
      <Link to="/wallet" onClick={close}><Coins size={16} />Token 钱包</Link>
      <Link to={memoryLink(petId)} onClick={close}><BookHeart size={16} />记忆管理</Link>
      <Link to="/preferences/conversations" onClick={close}><ShieldCheck size={16} />话题续聊设置</Link>
      <Link to="/admin" onClick={close}><ShieldCheck size={16} />管理后台</Link>
      {!user && <Link to="/login" onClick={close}><LogIn size={16} />登录 / 注册</Link>}
      {user && <Link to="/me/sessions" onClick={close}><ShieldCheck size={16} />登录会话</Link>}
    </nav>
  </details>
}

export function Header({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
  const { privateChat } = useChat()
  const { petId, pet } = usePet()
  return <header className="header">
    <div className="header-left">
      <Button className="mobile-only icon-button" variant="ghost" onClick={onMenu} aria-label="打开导航" aria-controls="mobile-sidebar" aria-expanded={menuOpen}><Menu size={21} /></Button>
      <Link to={chatHome(petId)} className="header-title">{pet?.name ?? '小未'}<span className="header-title-note">AI 宠物</span></Link>
      <span className="chat-mode-badge"><i />{privateChat ? petId ? '宠物独立聊天' : '旧版账户聊天' : 'Mock 演示'}</span>
    </div>
    <div className="header-actions">
      <Link to="/wallet" className="token-entry" aria-label="查看 Token 余额，尚未开通"><Coins size={16} /><span>Token<span className="token-balance">—</span></span></Link>
      <Link to="/me" className="profile-entry">个人中心</Link>
      <AccountMenu />
    </div>
  </header>
}

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const { pathname } = useLocation()
  const isChat = pathname === '/' || pathname.startsWith('/chat/') || /^\/pets\/[^/]+(?:\/chat\/[^/]+)?$/.test(pathname)
  useVisualViewport()
  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${isChat ? 'companion-shell' : ''}`}>
    <SkyBackdrop />
    <a href="#main" className="skip-link">跳转到正文</a>
    <div className="p862-masthead">
      <Link to="/companions" className="p862-brand" aria-label={`${brand.name}首页`}><span className="p862-brand-mark"><Sparkles size={33} /></span><span>{brand.name}<small>{brand.subtitle}</small></span></Link>
      <div className="p862-masthead-actions"><Button className="mobile-only icon-button" variant="ghost" onClick={() => setMenuOpen(true)} aria-label="打开导航" aria-controls="mobile-sidebar" aria-expanded={menuOpen}><Menu size={23} /></Button>{!isChat && <AccountMenu />}</div>
    </div>
    <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} open={menuOpen} onClose={() => setMenuOpen(false)} />
    <div className="workspace">{isChat && <Header onMenu={() => setMenuOpen(true)} menuOpen={menuOpen} />}
      <main id="main" className={isChat ? 'chat-main' : 'content-main'} tabIndex={-1}><Outlet /></main>
      {!isChat && <footer className="page-footer"><span>{brand.name} · {brand.subtitle}</span><Link to="/welcome">关于{brand.name} <ArrowUpRight size={13} /></Link></footer>}
    </div>
  </div>
}
