import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createDemoHistory } from '../../data/chat-demo'
import { errorMessage } from '../../lib/api'
import { streamMock } from '../../lib/sse'
import { ChatContext } from './context'
import type { ChatMessage, ChatSession, PreviewIdentityId, RecentConversationSummary } from './types'
import { buildRecentTopic, selectRecentTopic } from './recent-topics'
import { useAuth } from '../auth/context'
import { PrivateChatProvider } from './PrivateChatProvider'
import { Loading } from '../../components/ui'
import { DesktopChatActivity } from '../desktop/DesktopChatActivity'

interface Generation {
  ownerScopeId: PreviewIdentityId
  sessionId: string
  assistantId: string
  controller: AbortController
}

interface PreviewState {
  ownerScopeId: PreviewIdentityId
  conversations: ChatSession[]
  seeds: RecentConversationSummary[]
  dismissedIds: Set<string>
  deletedIds: Set<string>
  topicEnabled: boolean
  demoLoaded: boolean
}

function emptyPreview(ownerScopeId: PreviewIdentityId): PreviewState {
  return { ownerScopeId, conversations: [], seeds: [], dismissedIds: new Set(),
    deletedIds: new Set(), topicEnabled: false, demoLoaded: false }
}

export function ChatProvider({ children, petId }: { children: ReactNode; petId?: string }) {
  const { user, scopeVersion, loading } = useAuth()
  if (loading) return <Loading message="正在确认登录状态…" />
  return user ? <PrivateChatProvider key={`${user.id}:${scopeVersion}:${petId ?? 'legacy'}`} petId={petId} owner={user.id} scopeVersion={scopeVersion}><DesktopChatActivity />{children}</PrivateChatProvider>
    : <PreviewChatProvider>{children}</PreviewChatProvider>
}

function PreviewChatProvider({ children }: { children: ReactNode }) {
  // No storage or automatic seed history. Consent starts off after every refresh.
  const [preview, setPreview] = useState(() => emptyPreview('preview-a'))
  const [generatingSessionId, setGeneratingSessionId] = useState<string | null>(null)
  const active = useRef<Generation | null>(null)
  const activeOwner = useRef<PreviewIdentityId>('preview-a')
  useEffect(() => () => active.current?.controller.abort(), [])

  const sessions = useMemo(() => preview.conversations.filter((item) => item.ownerScopeId === preview.ownerScopeId
    && !preview.deletedIds.has(item.id)), [preview.conversations, preview.ownerScopeId, preview.deletedIds])

  const updateMessage = useCallback((ownerScopeId: PreviewIdentityId, sessionId: string, messageId: string,
    update: (message: ChatMessage) => ChatMessage, completedAt?: string) => {
    setPreview((previous) => previous.ownerScopeId !== ownerScopeId ? previous : {
      ...previous, conversations: previous.conversations.map((session) => session.id === sessionId && session.ownerScopeId === ownerScopeId
        ? { ...session, lastMessageAt: completedAt ?? session.lastMessageAt,
          messages: session.messages.map((message) => message.id === messageId ? update(message) : message) }
        : session),
    })
  }, [])

  const stopGeneration = useCallback(() => {
    const request = active.current
    if (!request) return
    active.current = null
    request.controller.abort()
    setGeneratingSessionId(null)
    updateMessage(request.ownerScopeId, request.sessionId, request.assistantId, (message) => ({
      ...message, status: 'interrupted', error: '已停止生成，当前回复可能不完整。',
    }))
  }, [updateMessage])

  const switchPreviewIdentity = useCallback((identity: PreviewIdentityId) => {
    if (identity !== 'preview-a' && identity !== 'preview-b') return
    if (identity === activeOwner.current) return
    stopGeneration()
    activeOwner.current = identity
    // Deliberately discard the previous visitor's cache, consent and summaries.
    setPreview(emptyPreview(identity))
  }, [stopGeneration])

  const loadDemoHistory = useCallback(() => {
    const owner = activeOwner.current
    const sample = createDemoHistory(owner)
    setPreview((previous) => previous.ownerScopeId !== owner || previous.demoLoaded ? previous : {
      ...previous, demoLoaded: true,
      conversations: [...previous.conversations, ...sample.sessions.filter((session) => !previous.deletedIds.has(session.id))],
      seeds: sample.summaries.filter((summary) => !previous.deletedIds.has(summary.conversationId)),
    })
  }, [])

  const deleteSession = useCallback((sessionId: string) => {
    const owner = activeOwner.current
    if (active.current?.sessionId === sessionId) stopGeneration()
    setPreview((previous) => previous.ownerScopeId !== owner ? previous : {
      ...previous, conversations: previous.conversations.filter((item) => item.id !== sessionId || item.ownerScopeId !== owner),
      seeds: previous.seeds.filter((item) => item.conversationId !== sessionId),
      deletedIds: new Set([...previous.deletedIds, sessionId]),
    })
  }, [stopGeneration])

  const setRecentTopicEnabled = useCallback((enabled: boolean) => {
    setPreview((previous) => ({ ...previous, topicEnabled: enabled }))
  }, [])

  const dismissRecentTopic = useCallback((conversationId: string) => {
    setPreview((previous) => ({ ...previous, dismissedIds: new Set([...previous.dismissedIds, conversationId]) }))
  }, [])

  const recentTopic = useMemo(() => {
    if (!preview.topicEnabled) return null
    const summaries = sessions.map((session) => buildRecentTopic(session,
      preview.dismissedIds.has(session.id), preview.seeds)).filter((item) => item !== null)
    return selectRecentTopic(summaries, sessions, preview.ownerScopeId)
  }, [preview.topicEnabled, preview.dismissedIds, preview.seeds, preview.ownerScopeId, sessions])

  const sendMessage = useCallback((raw: string, existingId?: string) => {
    const content = raw.trim()
    if (!content || content.length > 2000) throw new Error('请输入 1–2000 字的演示消息。')
    const ownerScopeId = preview.ownerScopeId
    if (activeOwner.current !== ownerScopeId || (existingId && !sessions.some((session) => session.id === existingId))) {
      throw new Error('这段会话当前不可读取，请重新打开聊天。')
    }
    stopGeneration()
    const sessionId = existingId ?? crypto.randomUUID()
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content, status: 'complete' }
    const assistantId = crypto.randomUUID()
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', status: 'streaming' }
    const lastMessageAt = new Date().toISOString()
    setPreview((previous) => previous.ownerScopeId !== ownerScopeId ? previous : {
      ...previous, conversations: existingId
        ? previous.conversations.map((session) => session.id === sessionId && session.ownerScopeId === ownerScopeId
          ? { ...session, lastMessageAt, messages: [...session.messages, userMessage, assistantMessage] } : session)
        : [{ id: sessionId, ownerScopeId, title: content.slice(0, 26), source: 'local', lastMessageAt,
          messages: [userMessage, assistantMessage] }, ...previous.conversations],
    })

    const request: Generation = { ownerScopeId, sessionId, assistantId, controller: new AbortController() }
    active.current = request
    setGeneratingSessionId(sessionId)
    async function consume() {
      try {
        // The existing API is single-turn Mock. History is presentation-only context.
        await streamMock(content, (delta) => {
          if (active.current !== request || activeOwner.current !== ownerScopeId) return
          updateMessage(ownerScopeId, sessionId, assistantId, (message) => ({ ...message, content: message.content + delta }))
        }, request.controller.signal)
        if (active.current === request) {
          updateMessage(ownerScopeId, sessionId, assistantId, (message) => ({ ...message, status: 'complete' }), new Date().toISOString())
        }
      } catch (cause) {
        if (!request.controller.signal.aborted) {
          updateMessage(ownerScopeId, sessionId, assistantId, (message) => ({
            ...message, status: 'error', error: errorMessage(cause),
          }))
        }
      } finally {
        if (active.current === request) {
          active.current = null
          setGeneratingSessionId(null)
        }
      }
    }
    void consume()
    return sessionId
  }, [stopGeneration, updateMessage, preview.ownerScopeId, sessions])

  const value = useMemo(() => ({ sessions, generatingSessionId, sendMessage, stopGeneration,
    previewIdentityId: preview.ownerScopeId, switchPreviewIdentity, demoHistoryLoaded: preview.demoLoaded,
    loadDemoHistory, deleteSession, recentTopicEnabled: preview.topicEnabled, setRecentTopicEnabled,
    recentTopic, dismissRecentTopic }),
  [sessions, generatingSessionId, sendMessage, stopGeneration, preview.ownerScopeId,
    switchPreviewIdentity, preview.demoLoaded, loadDemoHistory, deleteSession, preview.topicEnabled,
    setRecentTopicEnabled, recentTopic, dismissRecentTopic])
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}
