import { usePet } from '../features/pets/context'
import { chatHome, chatLink, memoryLink } from '../features/pets/scope'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowDown, ArrowUp, Heart, LockKeyhole, MessageCircle, ShieldCheck, Sparkles, Sprout, Square, Sun } from 'lucide-react'
import { Button, EmptyState, ErrorState, Loading } from '../components/ui'
import { useChat } from '../features/chat/context'
import { useMediaQuery } from '../lib/viewport'
import { RecentTopicCard } from '../features/chat/RecentTopicCard'
import { composerDisclosure, replyProviderLabel } from '../features/chat/provider-presentation'
import { RememberMessage, MessageMemoryReferences } from '../features/memory/ChatMemory'
import { useMemory } from '../features/memory/context'
import { CompanionRecount } from '../features/p863/CompanionRecount'

const quickActions = [
  { label: '聊聊心情', prompt: '我想聊聊最近的心情。', icon: Heart },
  { label: '轻松闲聊', prompt: '想和你轻松聊聊天。', icon: Sparkles },
  { label: '分享日常', prompt: '想和你分享今天的一件小事。', icon: Sun },
]

function ChatWorkspace({ sessionId }: { sessionId?: string }) {
  const { sessions, generatingSessionId, sendMessage, stopGeneration, recentTopic, recentTopicEnabled, privateChat } = useChat()
  const memory = useMemory()
  const { petId, pet } = usePet()
  const archived = pet?.status === 'archived'
  const selectSession = privateChat?.selectSession
  const navigate = useNavigate()
  const session = sessions.find((item) => item.id === sessionId)
  const messages = useMemo(() => session?.messages ?? [], [session])
  const running = generatingSessionId === sessionId && sessionId !== undefined
  const [input, setInput] = useState('')
  const [submitError, setSubmitError] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const followsEnd = useRef(true)
  const earlierAnchor = useRef<{ height: number; top: number; count: number } | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const mobile = useMediaQuery('(max-width: 767px)')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const resetDraft = () => { setInput(''); setSubmitError('') }
    window.addEventListener('weibiye:new-chat', resetDraft)
    return () => window.removeEventListener('weibiye:new-chat', resetDraft)
  }, [])
  useEffect(() => {
    selectSession?.(sessionId)
    // The replacement chat route selects its own ID. Clearing between two chat
    // components would cancel a query whose final key can remain unchanged.
    return () => { if (!window.location.pathname.startsWith(petId ? `/pets/${petId}/chat/` : '/chat/')) selectSession?.() }
  }, [sessionId, selectSession, petId])

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`
  }, [input])
  useEffect(() => {
    const element = scrollArea.current
    if (!element) return
    if (earlierAnchor.current && messages.length > earlierAnchor.current.count) {
      element.scrollTop = element.scrollHeight - earlierAnchor.current.height + earlierAnchor.current.top
      earlierAnchor.current = null
    } else if (messages.length > 0 && followsEnd.current) element.scrollTop = element.scrollHeight
  }, [messages])

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (archived || !input.trim() || running || privateChat?.sending || privateChat?.retryBlocked || (privateChat && !privateChat.runtime)) return
    try {
      followsEnd.current = true
      const nextId = await sendMessage(input, sessionId)
      if (!mounted.current) return
      setInput(''); setSubmitError('')
      if (!sessionId) navigate(chatLink(nextId, petId))
    } catch (error) { if (mounted.current) setSubmitError(error instanceof Error ? error.message : '发送失败，请重试。') }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 || mobile) return
    event.preventDefault()
    void submit()
  }
  function scrollToEnd() {
    const element = scrollArea.current
    if (element) element.scrollTop = element.scrollHeight
    followsEnd.current = true
    setShowScrollButton(false)
  }

  if (sessionId && privateChat && (privateChat.selectedSessionId !== sessionId || privateChat.loading)) return <Loading message="正在读取私人会话…" />
  if (sessionId && privateChat?.readError && !messages.length) return <div className="missing-chat"><ErrorState message={privateChat.readError} /><Button variant="secondary" onClick={privateChat.retryRead}>重新读取会话</Button></div>
  if (sessionId && !session) return <div className="missing-chat">{privateChat?.error && <ErrorState message={privateChat.error} />}<EmptyState title="这段对话暂时找不到了" description={privateChat ? '当前会话不可读取，请返回首页刷新历史。' : '本页演示刷新后会清空；读取已保存的私人会话需要登录。'} action={<Link to={privateChat ? chatHome(petId) : '/login'} className="button button-primary">{privateChat ? '返回首页' : '登录读取私人会话'}</Link>} /></div>

  return <div className="conversation">
    <div className={`conversation-scroll ${messages.length ? 'has-messages' : ''}`} ref={scrollArea} onScroll={(event) => {
      const element = event.currentTarget
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      followsEnd.current = atEnd
      setShowScrollButton(!atEnd)
    }}>
      <CompanionRecount sessionId={sessionId} />
      {!messages.length ? <section className={`chat-welcome ${recentTopic ? 'with-recent-topic' : ''}`} aria-label="新会话">
        <span className="welcome-sprout" aria-hidden="true"><Sprout size={42} strokeWidth={1.65} /><i /></span>
        <span className="chat-welcome-eyebrow">一段对话，一点陪伴</span>
        <h1>今天还顺利吗？</h1>
        <p>不管发生了什么，都可以和我聊聊。</p>
        {!petId && <RecentTopicCard />}
        <div className="chat-quick-actions" aria-label="快捷操作">{quickActions.map(({ label, prompt, icon: Icon }) =>
          <button key={label} onClick={() => { setInput(prompt); textarea.current?.focus() }}><Icon size={16} /><span>{label}</span></button>,
        )}</div>
        {!petId && <Link to="/preferences/conversations" className="recent-topic-settings-link" aria-label="话题续聊设置"><ShieldCheck size={12} />话题续聊 · {recentTopicEnabled ? privateChat ? '当前账户已允许' : '已允许，仅本页' : '默认关闭'}</Link>}
      </section> : <div className="conversation-content">
        <div className="session-heading"><h1>{session?.title}</h1><span>{privateChat ? '当前账户 · 已保存' : session?.source === 'demo' ? '虚构演示会话' : '本页预览对话'}</span></div>
        {privateChat?.hasMoreMessages && <Button variant="ghost" disabled={privateChat.loadingMoreMessages} onClick={() => {
          if (scrollArea.current) earlierAnchor.current = { height: scrollArea.current.scrollHeight, top: scrollArea.current.scrollTop, count: messages.length }
          followsEnd.current = false; privateChat.loadMoreMessages()
        }}>加载更早消息</Button>}
        <div role="log" aria-label="聊天记录" aria-live="polite" aria-busy={running} className="chat-transcript">
          {messages.map((message) => <article key={message.id} className={`conversation-message message-${message.role}`}>
            {message.role === 'assistant' && <span className="message-avatar" aria-hidden="true"><Sprout size={21} /></span>}
            <div className="message-body">
              {message.role === 'assistant' && <span className="message-author">{pet?.name ?? '小未'} <span>{replyProviderLabel(message.provider, !privateChat)}</span></span>}
              {message.content ? <p>{message.content}</p> : ['queued', 'streaming'].includes(message.status) ? <span className="generating-indicator" role="status">{message.status === 'queued' ? '正在排队等待回复' : privateChat ? '正在生成回复' : '正在生成演示回复'}<span>···</span></span> : <p className="muted">尚未收到完整回复。</p>}
              {message.error && <ErrorState message={message.error} />}
              {message.finishReason === 'length' && <p className="chat-stream-note">回复已达到本次长度上限。</p>}
              {privateChat && sessionId && message.role === 'user' && message.status === 'complete' && <RememberMessage sessionId={sessionId} messageId={message.id} />}
              {privateChat && sessionId && message.role === 'assistant' && message.generationId && message.status === 'complete' && <MessageMemoryReferences sessionId={sessionId} generationId={message.generationId} />}
              {privateChat && message.generationId && !running && ['error', 'interrupted'].includes(message.status) && message.id === messages.at(-1)?.id
                && <Button variant="ghost" disabled={privateChat.sending || privateChat.retryBlocked || !privateChat.runtime} onClick={() => void privateChat.retryGeneration(message.generationId!)}>重新生成回复</Button>}
            </div>
          </article>)}
        </div>
      </div>}
    </div>
    {showScrollButton && <Button className="scroll-to-end icon-button" variant="secondary" onClick={scrollToEnd} aria-label="回到最新消息"><ArrowDown size={18} /></Button>}
    <div className="composer-dock">
      {archived && <p role="status">这只宠物已归档，保留的聊天仅供查看。</p>}
      {privateChat?.error && <ErrorState message={privateChat.error} />}
      {submitError && <ErrorState message={submitError} />}
      {privateChat && ['connecting', 'reconnecting', 'disconnected'].includes(privateChat.connectionState) && <div className="chat-stream-note" role="status">{privateChat.connectionState === 'disconnected' ? '连接已中断，回复尚未确认完成。' : '正在连接并同步已保存的回复…'}{privateChat.connectionState === 'disconnected' && <Button variant="ghost" onClick={privateChat.reconnect}>重新连接</Button>}</div>}
      {privateChat?.hasPendingSend && !privateChat.sending && <Button variant="ghost" disabled={privateChat.retryBlocked || !privateChat.runtime} onClick={() => {
        void privateChat.retryPendingSend().then((id) => { setSubmitError(''); setInput(''); navigate(chatLink(id, petId)) }).catch(() => undefined)
      }}>重试原发送请求</Button>}
      <form className="chat-composer" onSubmit={(event) => void submit(event)} aria-label="聊天输入框">
        <label htmlFor="chat-message" className="sr-only">聊天消息</label>
        <textarea id="chat-message" ref={textarea} rows={2} maxLength={privateChat ? undefined : 2000} value={input} disabled={archived || running || privateChat?.sending} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} placeholder="愿意和我聊聊吗？" enterKeyHint={mobile ? 'enter' : 'send'} aria-describedby="composer-disclosure" />
        <div className="composer-toolbar"><span className="composer-partner"><Sprout size={16} />{pet?.name ?? '小未'}<span className="composer-partner-divider" />陪伴模式</span><div className="composer-send-group"><span className="composer-key-hint">Enter 发送</span>{running
          ? <Button className="send-message-button" disabled={privateChat?.cancelling || privateChat?.retryBlocked} onClick={() => void stopGeneration()} aria-label="停止生成"><Square size={17} fill="currentColor" /></Button>
          : <Button className="send-message-button" type="submit" disabled={archived || !input.trim() || privateChat?.sending || privateChat?.retryBlocked || (!!privateChat && (!privateChat.runtime || [...input].length > 4000))} aria-label="发送消息"><ArrowUp size={21} /></Button>}</div></div>
      </form>
      {privateChat?.sending && <p className="chat-stream-note" role="status">正在确认发送结果…</p>}
      {privateChat?.cancelling && <p className="chat-stream-note" role="status">正在请求停止，等待服务器确认…</p>}
      {!!privateChat && [...input].length > 4000 && <p className="chat-stream-note" role="alert">消息最多 4000 个 Unicode 字符。</p>}
      <p id="composer-disclosure" className="composer-disclosure"><LockKeyhole size={11} />{privateChat ? composerDisclosure(privateChat.runtime, !!petId) : 'Mock 固定回复 · 不分析输入 · 不计费 · 本页记录刷新即清空'}</p>
      {privateChat?.runtimeLoading && <p className="chat-stream-note" role="status">正在确认聊天模型配置…</p>}
      {privateChat?.runtimeError && <div className="chat-stream-note" role="status">模型配置尚未确认。{privateChat.runtimeError}<Button variant="ghost" onClick={privateChat.reloadRuntime}>重新确认模型配置</Button></div>}
      {privateChat && <Link className="recent-topic-settings-link" to={memoryLink(petId)}>长期记忆 · {memory.unavailable ? '当前环境暂不可用' : memory.preferences?.long_term_memory_enabled ? petId ? '当前宠物已允许' : '当前账户已允许' : '默认关闭'}</Link>}
      <p className="chat-small-note"><MessageCircle size={11} />每一种心情，都值得被认真听见。</p>
    </div>
  </div>
}

export function CompanionPage() {
  const { sessionId } = useParams()
  return <ChatWorkspace key={sessionId ?? 'new-chat'} sessionId={sessionId} />
}
